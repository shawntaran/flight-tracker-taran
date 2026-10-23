/**
 * Flight-status providers. Both return the same normalised `info` shape:
 *   { status, rawStatus, depAirport, schedDep, revDep, actualDep, depLocalDate, schedArr, estArr, actualArr,
 *     arrTerminal, arrGate, callsign, icao24, source }   (times are UTC ms or null)
 * depAirport (IATA) is used in memory only, e.g. as the connection airport for the first-leg check;
 * applyInfo() does not store it. arrTerminal/arrGate are '' when the provider gives none.
 * status is one of SCHEDULED | DELAYED | DEPARTED | LANDED | CANCELLED | DIVERTED.
 *
 * Flight identity: a flight number can have several instances on one date (or, for FlightAware, in the
 * ±18 h query window). The instance used is the one whose scheduled time on the matching side is
 * closest to the row's own scheduled time, within IDENTITY_TOLERANCE_MIN and clearly closer than the
 * runner-up. Otherwise the lookup is an identity mismatch: nothing is guessed.
 */

var IDENTITY_TOLERANCE_MIN = 240; // a provider schedule further than this from the row's time is not "the" flight
var IDENTITY_AMBIGUITY_MIN = 60;  // the runner-up must be at least this much further away, or the match is ambiguous

function isObj_(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

/**
 * Pure: picks the one instance a row refers to.
 * cands: [{item, t}] with t = scheduled time (ms or null) on the matching side; expectedMs = the row's time.
 * -> {item} | {item: null, kind: 'identity', reason}
 */
function pickInstance_(cands, expectedMs, what) {
  var tol = IDENTITY_TOLERANCE_MIN * MIN, fmt = function (t) { return fmtIST(t) + ' IST'; };
  if (cands.length === 1) {
    var only = cands[0];
    if (!expectedMs || only.t == null || Math.abs(only.t - expectedMs) <= tol) return { item: only.item };
    return { item: null, kind: 'identity',
      reason: what + ' is scheduled ' + fmt(only.t) + ', more than ' + (IDENTITY_TOLERANCE_MIN / 60) + ' h from the ' + fmt(expectedMs) + ' on the Flights sheet' };
  }
  if (!expectedMs) return { item: null, kind: 'identity', reason: cands.length + ' instances of ' + what + ' and no scheduled time on the row to choose between them' };
  var timed = cands.filter(function (c) { return c.t != null; })
    .map(function (c) { return { item: c.item, t: c.t, d: Math.abs(c.t - expectedMs) }; })
    .sort(function (a, b) { return a.d - b.d; });
  var list = timed.map(function (c) { return fmtTimeIST(c.t); }).join(', ');
  if (!timed.length) return { item: null, kind: 'identity', reason: cands.length + ' instances of ' + what + ' without scheduled times' };
  if (timed[0].d > tol) {
    return { item: null, kind: 'identity', reason: cands.length + ' instances of ' + what + ' (' + list + ' IST), none within ' +
      (IDENTITY_TOLERANCE_MIN / 60) + ' h of the ' + fmt(expectedMs) + ' on the Flights sheet' };
  }
  if (timed[1] && timed[1].d <= tol && timed[1].d - timed[0].d < IDENTITY_AMBIGUITY_MIN * MIN) {
    return { item: null, kind: 'identity', reason: cands.length + ' instances of ' + what + ' (' + list + ' IST) are about equally close to the ' +
      fmt(expectedMs) + ' on the Flights sheet' };
  }
  return { item: timed[0].item };
}

/** The row's own scheduled times, used to recognise the right instance. */
function rowExpected_(r) { return { arr: r.schedArrAt || null, dep: r.schedDepAt || null }; }

// ---------------------------------------------------------------- AeroDataBox
// Requests are sent only by adbRequest() in AdbClient.js (budget, validation, dedupe, usage log).

/** Status spellings vary ("Canceled", "Cancelled", "EnRoute", "En Route"): compare letters only. */
function statusKey_(raw) { return String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z]/g, ''); }

var DEPARTED_KEYS = { departed: 1, enroute: 1, approaching: 1, airborne: 1, arrived: 1, landed: 1 };

/**
 * Pure: the leg of the row's flight. expected = {arr, dep} (ms); airport '' means "any" (diagnostics only).
 * -> {leg} | {leg: null, kind: 'nomatch' | 'identity', reason}
 */
function pickAdbLeg_(legs, airport, dir, expected) {
  var objs = (Array.isArray(legs) ? legs : []).filter(isObj_);
  if (!airport) return objs.length ? { leg: objs[0] } : { leg: null, kind: 'nomatch', reason: 'no flight legs returned' };
  var matches = objs.filter(function (l) {
    var side = dir === 'ARR' ? l.arrival : l.departure;
    return isObj_(side) && isObj_(side.airport) && side.airport.iata === airport;
  });
  if (!matches.length) return { leg: null, kind: 'nomatch', reason: 'no leg ' + (dir === 'ARR' ? 'arrives at ' : 'departs from ') + airport };
  expected = expected || {};
  var useArr = dir === 'ARR' ? !!expected.arr || !expected.dep : !expected.dep && !!expected.arr;
  var exp = useArr ? expected.arr : expected.dep;
  var cands = matches.map(function (l) {
    var side = useArr ? l.arrival : l.departure;
    return { item: l, t: isObj_(side) ? parseApiTime(side.scheduledTime) : null };
  });
  var p = pickInstance_(cands, exp, 'this flight number ' + (dir === 'ARR' ? 'arriving at ' : 'departing ') + airport);
  return p.item ? { leg: p.item } : { leg: null, kind: p.kind, reason: p.reason };
}

/** Pure: normalises one AeroDataBox leg. */
function adbLegInfo_(leg, dir) {
  var a = isObj_(leg.arrival) ? leg.arrival : {}, d = isObj_(leg.departure) ? leg.departure : {};
  var raw = leg.status == null || leg.status === '' ? 'Unknown' : String(leg.status), key = statusKey_(raw);
  var departed = !!DEPARTED_KEYS[key] || !!parseApiTime(d.runwayTime);
  var landed = key === 'arrived' || key === 'landed';
  var info = {
    rawStatus: raw,
    depAirport: (isObj_(d.airport) && d.airport.iata) || '',
    schedDep: parseApiTime(d.scheduledTime),
    revDep: parseApiTime(d.revisedTime),
    actualDep: parseApiTime(d.runwayTime) || (departed ? parseApiTime(d.revisedTime) : null),
    depLocalDate: isObj_(d.scheduledTime) && /^\d{4}-\d{2}-\d{2}/.test(String(d.scheduledTime.local || '')) ? String(d.scheduledTime.local).slice(0, 10) : '',
    schedArr: parseApiTime(a.scheduledTime),
    estArr: parseApiTime(a.predictedTime) || parseApiTime(a.revisedTime),
    actualArr: landed ? (parseApiTime(a.runwayTime) || parseApiTime(a.revisedTime) || parseApiTime(a.scheduledTime)) : null,
    arrTerminal: a.terminal == null ? '' : String(a.terminal).trim(),
    arrGate: a.gate == null ? '' : String(a.gate).trim(),
    callsign: String(leg.callSign || '').replace(/\s+/g, '').toUpperCase(),
    icao24: String((isObj_(leg.aircraft) && leg.aircraft.modeS) || '').toLowerCase(),
    source: 'AeroDataBox'
  };
  info.status = statusFromInfo_(raw, info, dir);
  return info;
}

/** Picks the leg touching `airport` (arriving for ARR, departing for DEP) and normalises it; null if none fits. */
function parseAdbLegs(legs, airport, dir, expected) {
  var p = pickAdbLeg_(legs, airport, dir, expected);
  return p.leg ? adbLegInfo_(p.leg, dir) : null;
}

function statusFromInfo_(raw, info, dir) {
  switch (statusKey_(raw)) {
    case 'arrived': case 'landed': return dir === 'DEP' ? 'DEPARTED' : 'LANDED';
    case 'departed': case 'enroute': case 'approaching': case 'airborne': return 'DEPARTED';
    case 'canceled': case 'cancelled': case 'canceleduncertain': case 'cancelleduncertain': return 'CANCELLED';
    case 'diverted': return 'DIVERTED';
  }
  if (info.actualDep) return 'DEPARTED';
  if (statusKey_(raw) === 'delayed') return 'DELAYED';
  if (info.revDep && info.schedDep && info.revDep - info.schedDep >= 15 * MIN) return 'DELAYED';
  return 'SCHEDULED';
}

// ---------------------------------------------------------- FlightAware (backup)
/**
 * One AeroAPI request. -> {ok, info, attempted} | {ok: false, attempted, kind, error, uncertain?}
 * attempted = a request was actually sent. Malformed or partial JSON is a provider failure, never a crash.
 */
function faFetch(flight, callsign, aroundMs, airport, dir, expected) {
  var key = secret('FA_KEY');
  if (!key) return { ok: false, attempted: false, kind: 'config', error: 'FA_KEY not set' };
  var ident = callsign || flight;
  var start = new Date(aroundMs - 18 * HOUR).toISOString().slice(0, 19) + 'Z';
  var end = new Date(aroundMs + 18 * HOUR).toISOString().slice(0, 19) + 'Z';
  var url = 'https://aeroapi.flightaware.com/aeroapi/flights/' + encodeURIComponent(ident) +
    '?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
  var res, code, body;
  try {
    res = UrlFetchApp.fetch(url, { headers: { 'x-apikey': key }, muteHttpExceptions: true });
    code = res.getResponseCode();
    body = code === 200 ? res.getContentText() : '';
  } catch (e) {
    return { ok: false, attempted: true, kind: 'unknown', uncertain: true, error: 'FlightAware network: ' + redactSecrets(e && e.message || e) };
  }
  if (code !== 200) return { ok: false, attempted: true, kind: 'http', error: 'FlightAware HTTP ' + code };
  var data;
  try { data = JSON.parse(body); } catch (e) {
    return { ok: false, attempted: true, kind: 'parse', error: 'FlightAware: malformed JSON response' };
  }
  if (!isObj_(data) || !Array.isArray(data.flights)) return { ok: false, attempted: true, kind: 'parse', error: 'FlightAware: response has no flights list' };
  var p = pickFaFlight_(data.flights, airport, dir, expected || (dir === 'ARR' ? { arr: aroundMs } : { dep: aroundMs }));
  if (!p.flight) return { ok: false, attempted: true, kind: p.kind, error: 'FlightAware: ' + p.reason };
  return { ok: true, attempted: true, info: faFlightInfo_(p.flight, dir) };
}

function faTime_(s) { var t = s ? Date.parse(s) : NaN; return isNaN(t) ? null : t; }

/** Pure: the AeroAPI flight object for the row. -> {flight} | {flight: null, kind, reason} */
function pickFaFlight_(flights, airport, dir, expected) {
  var matches = (Array.isArray(flights) ? flights : []).filter(function (f) {
    var ap = isObj_(f) ? (dir === 'ARR' ? f.destination : f.origin) : null;
    return isObj_(ap) && ap.code_iata === airport;
  });
  if (!matches.length) return { flight: null, kind: 'nomatch', reason: 'no flight ' + (dir === 'ARR' ? 'arriving at ' : 'departing ') + airport };
  expected = expected || {};
  var useArr = dir === 'ARR' ? !!expected.arr || !expected.dep : !expected.dep && !!expected.arr;
  var cands = matches.map(function (f) { return { item: f, t: faTime_(useArr ? f.scheduled_in : f.scheduled_out) }; });
  var p = pickInstance_(cands, useArr ? expected.arr : expected.dep, 'this flight ' + (dir === 'ARR' ? 'arriving at ' : 'departing ') + airport);
  return p.item ? { flight: p.item } : { flight: null, kind: p.kind, reason: p.reason };
}

/** Pure: normalises one AeroAPI flight object. */
function faFlightInfo_(f, dir) {
  var t = faTime_, text = statusKey_(f.status);
  var info = {
    rawStatus: f.status == null ? '' : String(f.status),
    depAirport: (isObj_(f.origin) && f.origin.code_iata) || '',
    schedDep: t(f.scheduled_out), revDep: t(f.estimated_out), actualDep: t(f.actual_off) || t(f.actual_out),
    depLocalDate: '',
    schedArr: t(f.scheduled_in), estArr: t(f.estimated_on) || t(f.estimated_in),
    actualArr: t(f.actual_on) || t(f.actual_in),
    arrTerminal: f.terminal_destination == null ? '' : String(f.terminal_destination).trim(),
    arrGate: f.gate_destination == null ? '' : String(f.gate_destination).trim(),
    callsign: f.ident_icao ? String(f.ident_icao) : '', icao24: '', source: 'FlightAware'
  };
  if (f.cancelled === true || /cancel/.test(text)) info.status = 'CANCELLED';
  else if (f.diverted === true || /divert/.test(text)) info.status = 'DIVERTED';
  else if (info.actualArr && dir === 'ARR') info.status = 'LANDED';
  else if (info.actualDep) info.status = 'DEPARTED';
  else if (info.revDep && info.schedDep && info.revDep - info.schedDep >= 15 * MIN) info.status = 'DELAYED';
  else info.status = 'SCHEDULED';
  return info;
}

/** Compatibility wrapper (tests, older callers): info or null. */
function parseFaFlights(flights, airport, dir, aroundMs, expected) {
  var p = pickFaFlight_(flights, airport, dir, expected || (dir === 'ARR' ? { arr: aroundMs } : { dep: aroundMs }));
  return p.flight ? faFlightInfo_(p.flight, dir) : null;
}

function adbStatusSpec_(r) {
  var arr = r.dir === 'ARR' && r.schedArrAt;
  return { endpoint: 'flightStatus', flight: r.flightNorm, date: istDateKey(arr ? r.schedArrAt : r.schedDepAt), role: arr ? 'Arrival' : 'Departure' };
}

var faMemo_ = {}; // one FlightAware call per flight/date per execution, however many rows share it

/**
 * AeroDataBox first (through the budgeted gateway); FlightAware once if that fails or is blocked and
 * FA_KEY is configured, unless the failure is an identity mismatch (a paid backup would only guess).
 *
 * maxAttempts: provider requests this row may still send (its per-flight cap minus what it used).
 * -> {ok, info, attempts, fallback?, adbKind?, adbError?} | {ok: false, kind, error, attempts, blocked?, uncertain?}
 *   attempts = external requests actually sent by THIS call (AeroDataBox + FlightAware). Cache hits,
 *   in-execution dedupes, rejected and blocked requests count 0. Never exceeds maxAttempts.
 */
function fetchFlightInfo(r, maxAttempts) {
  var limit = maxAttempts == null ? Infinity : maxAttempts, attempts = 0;
  if (limit <= 0) return { ok: false, blocked: true, kind: 'cap', attempts: 0, error: 'per-flight request cap reached' };
  var spec = adbStatusSpec_(r), expected = rowExpected_(r);
  var res = adbRequest(spec), adb;
  if (res.attempted) attempts++;
  if (res.ok) {
    var p = pickAdbLeg_(res.legs, r.airport, r.dir, expected);
    if (p.leg) return { ok: true, info: adbLegInfo_(p.leg, r.dir), attempts: attempts };
    adb = { ok: false, kind: p.kind, error: 'AeroDataBox: ' + r.flightNorm + ' on ' + spec.date + ': ' + p.reason };
    if (p.kind === 'identity') { adb.attempts = attempts; return adb; }
  } else {
    adb = res;
  }
  var fail = { ok: false, kind: adb.kind, blocked: adb.blocked, uncertain: adb.uncertain, attempts: attempts, error: adb.error };
  if (!secret('FA_KEY')) return fail;
  var fk = r.flightNorm + '|' + spec.date + '|' + r.dir + '|' + r.airport, fa = faMemo_[fk];
  if (!fa) {
    if (attempts >= limit) { fail.error += ' | FlightAware skipped: per-flight request cap'; return fail; }
    fa = faMemo_[fk] = faFetch(r.flightNorm, r.callsign, r.dir === 'ARR' ? r.schedArrAt : r.schedDepAt, r.airport, r.dir, expected);
    if (fa.attempted) attempts++;
  }
  if (fa.ok) return { ok: true, info: fa.info, attempts: attempts, fallback: true, adbKind: adb.kind, adbError: adb.error };
  return { ok: false, kind: fa.kind === 'identity' ? 'identity' : adb.kind, blocked: adb.blocked && attempts === 0,
    uncertain: adb.uncertain || fa.uncertain, attempts: attempts, error: adb.error + ' | ' + fa.error };
}

// -------------------------------------------------------------------- OpenSky
function openskyToken_() {
  var id = secret('OPENSKY_CLIENT_ID'), sec = secret('OPENSKY_CLIENT_SECRET');
  if (!id || !sec) return null;
  var cache = CacheService.getScriptCache(), tok = cache.get('OPENSKY_TOKEN');
  if (tok) return tok;
  var res = UrlFetchApp.fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'post', payload: { grant_type: 'client_credentials', client_id: id, client_secret: sec }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('OpenSky auth HTTP ' + res.getResponseCode());
  var j = JSON.parse(res.getContentText());
  if (!isObj_(j) || !j.access_token) throw new Error('OpenSky auth: no access token in response');
  cache.put('OPENSKY_TOKEN', j.access_token, Math.max(60, (Number(j.expires_in) || 1800) - 120));
  return j.access_token;
}

/** One call per tick for every tracked flight. Filters by icao24 when all are known (smaller payload). */
function openskyStates(icao24s) {
  var url = 'https://opensky-network.org/api/states/all';
  if (icao24s.length && icao24s.every(String)) url += '?' + icao24s.map(function (x) { return 'icao24=' + x; }).join('&');
  try {
    var headers = {}, tok = openskyToken_();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    var res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'OpenSky HTTP ' + res.getResponseCode() };
    var j = JSON.parse(res.getContentText());
    if (!isObj_(j)) return { ok: false, error: 'OpenSky: malformed response' };
    // Keep only well-formed state vectors; a bad entry must not abort the tick.
    return { ok: true, states: (Array.isArray(j.states) ? j.states : []).filter(Array.isArray) };
  } catch (e) {
    return { ok: false, error: 'OpenSky: ' + redactSecrets(e && e.message || e) };
  }
}

/** State vector index: 0 icao24, 1 callsign, 3 time_position, 4 last_contact, 5 lon, 6 lat, 8 on_ground, 9 velocity m/s */
function findState(states, icao24, callsign) {
  var i, s, byId = null, byCall = null;
  if (icao24) for (i = 0; i < states.length; i++) if (Array.isArray(states[i]) && states[i][0] === icao24) { byId = states[i]; break; }
  if (callsign) for (i = 0; i < states.length; i++) {
    s = states[i];
    if (Array.isArray(s) && s[1] && String(s[1]).trim().toUpperCase() === callsign) { byCall = s; break; }
  }
  // After an aircraft swap the planned aircraft (icao24) flies another flight under another callsign: the callsign wins.
  var idCall = byId && byId[1] ? String(byId[1]).trim().toUpperCase() : '';
  if (byId && byCall && byCall !== byId && idCall && idCall !== callsign) return byCall;
  return byId || byCall;
}

function isNum_(x) { return typeof x === 'number' && isFinite(x); }

/**
 * Own ETA from a live position: great-circle distance / ground speed + approach allowance
 * (scaled down inside 200 km, where the aircraft is already descending).
 * Fields of the wrong type (a malformed vector) make the position stale rather than misread.
 * -> {landed} | {etaMs, distKm, fixMs} | {stale}
 */
function liveEta(state, ap, nowMs, C) {
  if (!Array.isArray(state) || !isNum_(state[6]) || !isNum_(state[5])) return { stale: true };
  var fixSec = isNum_(state[3]) ? state[3] : isNum_(state[4]) ? state[4] : null;
  if (fixSec == null) return { stale: true };
  var fixMs = fixSec * 1000;
  if (nowMs - fixMs > C.OPENSKY_STALE_MIN * MIN) return { stale: true };
  var dist = haversineKm(state[6], state[5], ap.lat, ap.lon);
  if (state[8] === true) return dist <= C.LANDED_RADIUS_KM ? { landed: true, distKm: dist, fixMs: fixMs } : { stale: true, onGroundElsewhere: true };
  if (state[8] !== false) return { stale: true };
  var v = state[9];
  if (!isNum_(v) || v < 50) return { stale: true };
  var approach = C.APPROACH_MIN * Math.min(1, dist / 200);
  return { etaMs: fixMs + (dist * 1000 / v) * 1000 + approach * MIN, distKm: dist, fixMs: fixMs };
}
