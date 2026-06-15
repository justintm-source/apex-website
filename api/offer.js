// /api/offer.js — Vercel serverless function
// Receives form submission, fetches Zillow data via RealtyAPI,
// calculates wholesale offer range, posts everything to GHL webhook.
//
// Formula (asymmetric range — captures both ends of assignment-fee margin):
//   ARV cap:           zestimate × 0.88
//   Flipper profit:    zestimate × 0.15  (fixed)
//   Assignment fee:    15% at low end of range, 5% at high end
//   rehab            = REHAB_PER_SQFT[score] × sqft
//   offer_low        = zestimate × 0.58 − rehab   (= 0.88 − 0.15 − 0.15)
//   offer_high       = zestimate × 0.68 − rehab   (= 0.88 − 0.15 − 0.05)
//   range_low        = offer_low  × 0.95          (rounded to nearest $1k)
//   range_high       = offer_high × 1.05          (rounded to nearest $1k)
//
// Routing rules:
//   - if zestimate is null/0           → route to call (no_valuation)
//   - if offer_high < 30% of zestimate → route to call (below_threshold)
//   - if offer_high < $25,000          → route to call (below_threshold)
//   - else                              → return range to frontend

const REHAB_PER_SQFT = {
    1: 120,
    2: 60,
    3: 40,
    4: 35,
    5: 30,
    6: 25,
    7: 20,
    8: 15,
    9: 12,
    10: 8,
  };

// Target states (all major cities covered). disclosure:true -> instant offer.
// disclosure:false (non-disclosure state) -> route to a call. Outside these -> out of market.
const STATE_ABBR = { CALIFORNIA: 'CA', 'NORTH CAROLINA': 'NC', FLORIDA: 'FL', TEXAS: 'TX' };
function normState(s) { const u = String(s || '').trim().toUpperCase(); return STATE_ABBR[u] || u; }
const STATE_RULES = {
  CA: { disclosure: true },   // -> instant offer
  NC: { disclosure: true },
  FL: { disclosure: true },
  TX: { disclosure: false },  // non-disclosure -> book a call (no instant offer)
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = req.body || {};
  const {
    first_name, last_name, email, phone,
    property_address, city, state, zip,
    property_type, reason_for_selling,
    bedrooms, bathrooms, sqft, condition_score,
  } = data;

  if (!property_address || !city || !state || !zip || !sqft || !condition_score) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const fullAddress = `${property_address}, ${city}, ${state} ${zip}`.trim();

  // 1. Fetch Zillow data via RealtyAPI
  let zestimate = null;
  let zillowURL = null;
  let realtyData = null;
  let propLat = null;
  let propLng = null;
  try {
    const url = `https://zillow.realtyapi.io/pro/byaddress?propertyaddress=${encodeURIComponent(fullAddress)}`;
    const resp = await fetch(url, {
      headers: { 'x-realtyapi-key': process.env.REALTYAPI_KEY },
    });
    if (resp.ok) {
      realtyData = await resp.json();
      zillowURL = realtyData?.zillowURL || null;
      const pd = realtyData?.propertyDetails || {};
      zestimate = pd.zestimate || pd.price || pd?.resoFacts?.taxAssessedValue || null;
      propLat = Number(pd.latitude) || null;
      propLng = Number(pd.longitude) || null;
    }
  } catch (e) {
    console.error('RealtyAPI error:', e?.message || e);
  }

  // 1b. Market filter by state. CA/NC/FL -> instant offer. TX (non-disclosure) -> call.
  // Anything else -> out of market.
  const propState = normState(state);
  const stateRule = STATE_RULES[propState];
  let outOfMarket = false;
  let forceCall = false;
  let forceCallReason = null;
  if (!stateRule) {
    outOfMarket = true;
  } else if (!stateRule.disclosure) {
    forceCall = true;
    forceCallReason = 'non_disclosure';
  }

  // 2. Calculate offer
  const sqftNum = Number(sqft) || 0;
  const score = parseInt(condition_score, 10) || 5;
  const rehabPerSqft = REHAB_PER_SQFT[score] || REHAB_PER_SQFT[5];
  const rehabCost = rehabPerSqft * sqftNum;

  let offerLow = null;
  let offerHigh = null;
  let rangeLow = null;
  let rangeHigh = null;
  let routeToCall = forceCall;
  let reason = forceCallReason;

  if (outOfMarket || routeToCall) {
    // out of market -> rejection message; non-disclosure / no-coords -> book a call. No instant offer.
  } else if (!zestimate || zestimate <= 0) {
    routeToCall = true;
    reason = 'no_valuation';
  } else {
    // Low end: 15% assignment fee. High end: 5% assignment fee.
    offerLow = Math.round(zestimate * 0.58 - rehabCost);
    offerHigh = Math.round(zestimate * 0.68 - rehabCost);
    if (offerHigh < zestimate * 0.30 || offerHigh < 25000) {
      routeToCall = true;
      reason = 'below_threshold';
    } else {
      // Round range to nearest $1k for clean display
      rangeLow = Math.round((offerLow * 0.95) / 1000) * 1000;
      rangeHigh = Math.round((offerHigh * 1.05) / 1000) * 1000;
    }
  }

  // 3. Send enriched payload to GHL
  const ghlPayload = {
    // user-submitted form data
    first_name, last_name, email, phone,
    property_address, city, state, zip,
    property_type, reason_for_selling,
    bedrooms, bathrooms, sqft, condition_score,
    // enrichment from RealtyAPI
    zestimate,
    zillow_url: zillowURL,
    // calculated offer
    rehab_per_sqft: rehabPerSqft,
    rehab_cost_estimate: rehabCost,
    calculated_offer_low: offerLow,
    calculated_offer_high: offerHigh,
    offer_range_low: rangeLow,
    offer_range_high: rangeHigh,
    // routing decision
    routed_to_call: routeToCall,
    routed_reason: reason,
    out_of_market: outOfMarket,
    // metadata
    utm_source: data.utm_source || null,
    utm_medium: data.utm_medium || null,
    utm_campaign: data.utm_campaign || null,
    utm_content: data.utm_content || null,
    utm_term: data.utm_term || null,
    fbclid: data.fbclid || null,
    landing_page: data.page || null,
    source: 'apex-website',
    submitted_at: new Date().toISOString(),
  };

  try {
    await fetch(process.env.GHL_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ghlPayload),
    });
  } catch (e) {
    console.error('GHL error:', e?.message || e);
  }

  // 4. Respond to frontend
  return res.status(200).json({
    ok: true,
    out_of_market: outOfMarket,
    route_to_call: routeToCall,
    reason,
    range_low: rangeLow,
    range_high: rangeHigh,
  });
};
