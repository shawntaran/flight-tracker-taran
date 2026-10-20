/**
 * The only code that sends AeroDataBox requests. Every request goes through adbRequest():
 *   validate -> per-execution dedupe -> short cache -> reserve budget (locked) -> send -> finalise -> log.
 *
 * Plan: AeroDataBox Basic (free) via RapidAPI. Two independent monthly hard limits:
 *   400 API units and 1,600 HTTP requests. A request is sent only if BOTH still fit after reserving
 *   its maximum cost. Accounting is conservative: the full cost is charged before sending and is
 *   refunded only when it is certain nothing was sent. Responses of any kind (200, 204, 4xx, 5xx)
 *   and timeouts/network errors stay charged, because the provider does not document which
 *   outcomes are billed. If the usage store cannot be read, is corrupted, or its lock cannot be
 *   taken, no request is sent (fail closed).
 *
 * Tiers verified 2026-10-20 in the provider's OpenAPI spec (doc.aerodatabox.com, RapidAPI v1).
 */

// requestsPerHour: pricing page, Basic "1 request / second. Additional limit of 1000 requests / hour".
var ADB_PLAN = { name: 'Basic (free)', unitsPerMonth: 400, requestsPerMonth: 1600, requestsPerHour: 1000 };
var ADB_TIER_UNITS = { FREE: 0, TIER1: 1, TIER2: 2, TIER3: 6 };

/**
 * Only `callable` endpoints can be sent. The others are listed so their plan restrictions are
 * validated if anyone ever enables them; the app does not use them.
 */
var ADB_ENDPOINTS = {
  flightStatus: { tier: 'TIER2', callable: true, label: 'GET /flights/number/{flight}/{date}' },
  flightHistory: { tier: 'TIER3', callable: false, maxDays: 7, label: 'GET /flights/number/{flight}/{from}/{to}' },
  fids: { tier: 'TIER2', callable: false, maxHours: 12, label: 'GET /flights/airports/iata/{code}/{from}/{to}' },
  fleet: { tier: 'TIER3', callable: false, maxPageSize: 10, label: 'GET /airlines/{code}/aircrafts' }
};

var ADB_MAX_DATE_OFFSET_DAYS = 365;
var ADB_USAGE_PROP = 'ADB_USAGE_V1';
var ADB_USAGE_INIT_PROP = 'ADB_USAGE_V1_INIT';
var ADB_PENDING_STALE_MS = 60 * 60 * 1000;
// Provider publishes no exact wording; this meets "prominent, names AeroDataBox, live link". Confirm with AeroDataBox.
var ADB_ATTRIBUTION = 'Flight status data: AeroDataBox (https://aerodatabox.com)';

var ADB_ENV = null;      // tests inject a fake environment here
var adbMemo_ = {};       // per-execution dedupe of identical lookups
var adbNotices_ = [];    // coordinator notices raised by the client (budget, suspension, store failure)

function adbResetExecution_() { adbMemo_ = {}; adbNotices_ = []; faMemo_ = {}; }
function adbDrainNotices() { var n = adbNotices_; adbNotices_ = []; return n; }

function adbEnv_() {
  if (ADB_ENV) return ADB_ENV;
  return {
    props: PropertiesService.getScriptProperties(),
    lock: LockService.getDocumentLock(), // separate from the tick's script lock; container-bound script required
    cache: CacheService.getScriptCache(),
    fetch: function (url, opts) { return UrlFetchApp.fetch(url, opts); },
    sleep: function (ms) { Utilities.sleep(ms); },
    now: function () { return Date.now(); },
    secret: secret,
    logUsage: appendUsageRow_
  };
}

/** Configured limits, never above the plan's hard limits. */
function adbLimits(C) {
  return {
    units: Math.max(0, Math.min(Number(C.ADB_MONTHLY_UNITS) || 0, ADB_PLAN.unitsPerMonth)),
    requests: Math.max(0, Math.min(Number(C.ADB_MONTHLY_REQUESTS) || 0, ADB_PLAN.requestsPerMonth)),
    perHour: Math.max(0, Math.min(Number(C.ADB_MAX_REQUESTS_PER_HOUR) || 0, ADB_PLAN.requestsPerHour))
  };
}

/** Maximum cost of one request. Flight plans double the charge, so they are counted ×2 (and rejected by validation). */
function adbCost(spec) {
  var ep = ADB_ENDPOINTS[spec.endpoint];
  return { units: ADB_TIER_UNITS[ep.tier] * (spec.withFlightPlan ? 2 : 1), requests: 1 };
}

function daysBetween_(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / (24 * HOUR)); }

/** -> null if the request respects the plan's restrictions, else the reason. */
function validateAdbRequest(spec, nowMs) {
  var ep = spec && ADB_ENDPOINTS[spec.endpoint];
  if (!ep) return 'unknown endpoint "' + (spec && spec.endpoint) + '"';
  if (!(ep.tier in ADB_TIER_UNITS)) return 'endpoint tier not verified';
  if (spec.withFlightPlan) return 'flight plans are not requested by this app (billed x2)';
  var today = istDateKey(nowMs);
  var checkDate = function (d, what) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || isNaN(Date.parse(d + 'T00:00:00Z'))) return what + ' must be YYYY-MM-DD';
    if (Math.abs(daysBetween_(today, d)) > ADB_MAX_DATE_OFFSET_DAYS) return what + ' ' + d + ' is outside ±' + ADB_MAX_DATE_OFFSET_DAYS + ' days';
    return null;
  };
  var e;
  switch (spec.endpoint) {
    case 'flightStatus':
      if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(String(spec.flight || ''))) return 'flight must be a normalised IATA flight number';
      if ((e = checkDate(spec.date, 'date'))) return e;
      if (['Both', 'Departure', 'Arrival'].indexOf(spec.role) < 0) return 'dateLocalRole must be Both, Departure or Arrival';
      return null;
    case 'flightHistory':
      if ((e = checkDate(spec.from, 'from')) || (e = checkDate(spec.to, 'to'))) return e;
      var days = daysBetween_(spec.from, spec.to);
      if (days <= 0) return 'to must be after from';
      if (days > ep.maxDays) return 'range of ' + days + ' days exceeds the ' + ep.maxDays + '-day page limit';
      return null;
    case 'fids':
      var f = Date.parse(spec.from + 'Z'), t = Date.parse(spec.to + 'Z');
      if (isNaN(f) || isNaN(t)) return 'from/to must be YYYY-MM-DDTHH:mm';
      if ((e = checkDate(String(spec.from).slice(0, 10), 'from')) || (e = checkDate(String(spec.to).slice(0, 10), 'to'))) return e;
      if (t <= f) return 'to must be after from';
      if (t - f > ep.maxHours * HOUR) return 'window exceeds the ' + ep.maxHours + '-hour page limit';
      return null;
    case 'fleet':
      var n = Number(spec.pageSize);
      if (!(n >= 1 && n <= ep.maxPageSize && Math.floor(n) === n)) return 'pageSize must be 1..' + ep.maxPageSize;
      return null;
  }
  return 'no validation rule for endpoint';
}

function adbUrl_(spec) {
  return 'https://aerodatabox.p.rapidapi.com/flights/number/' + encodeURIComponent(spec.flight) + '/' + spec.date +
    '?withAircraftImage=false&withLocation=false&withFlightPlan=false&dateLocalRole=' + spec.role;
}

function adbMemoKey_(spec) { return 'ADB|' + spec.endpoint + '|' + spec.flight + '|' + spec.date + '|' + spec.role; }

// ------------------------------------------------------------------ usage store
/*
 * Usage is stored as per-day buckets (IST days) so the accounting window is configurable:
 *
 *   ADB_BILLING_CYCLE_DAY blank (default): ROLLING window = today and the previous 32 days (33 buckets).
 *     A provider billing cycle lasts at most 31 days. Even counting a request up to 24 h away from
 *     the time the provider counts it (latency, clock skew, a DST hour), every cycle still fits in one
 *     window, so keeping every window under the limit keeps every cycle under it, whatever the reset
 *     day or the provider's timezone. Cost: after a burst, capacity returns up to ~33 days later
 *     instead of at the real reset.
 *   ADB_BILLING_CYCLE_DAY = 1..31: CYCLE window from the most recent occurrence of that day (IST);
 *     29-31 fall back to the month's last day. Use only after confirming the reset date on the
 *     RapidAPI dashboard. The exact reset hour is not known, so usage near the boundary can mismatch.
 */
var ADB_ROLLING_LOOKBACK_DAYS = 32; // window = today + 32 previous IST days
var ADB_BUCKET_KEEP_DAYS = 40;
var ADB_LEGACY_PREFIX = 'ADB_UNITS_'; // first version: one unit total per IST calendar month

function adbDayKey_(ms) { return istDateKey(ms); }
function adbHourKey_(ms) { return istDate_(ms).toISOString().slice(0, 13); }
function daysInMonth_(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }

/** -> {mode:'rolling'|'cycle', startKey, nextStartMs, label}. Throws on an invalid setting (fail closed). */
function adbWindow_(nowMs, C) {
  var raw = String(C.ADB_BILLING_CYCLE_DAY == null ? '' : C.ADB_BILLING_CYCLE_DAY).trim();
  var today = adbDayKey_(nowMs);
  if (raw === '') {
    // 33 day buckets = any 31-day cycle plus a full day of margin for request latency, clock skew
    // between Google and the provider, and a DST hour in the provider's billing timezone.
    var start = adbDayKey_(nowMs - ADB_ROLLING_LOOKBACK_DAYS * 24 * HOUR);
    return { mode: 'rolling', startKey: start, nextStartMs: null,
      label: 'rolling ' + (ADB_ROLLING_LOOKBACK_DAYS + 1) + '-day window ' + start + ' to ' + today };
  }
  var day = Number(raw);
  if (!(day >= 1 && day <= 31 && Math.floor(day) === day)) throw new Error('ADB_BILLING_CYCLE_DAY must be blank or a whole number 1-31');
  var d = istDate_(nowMs), y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDate() < Math.min(day, daysInMonth_(y, m))) { m--; if (m < 0) { m = 11; y--; } }
  var startMs = Date.UTC(y, m, Math.min(day, daysInMonth_(y, m)));
  var ny = m === 11 ? y + 1 : y, nm = (m + 1) % 12;
  var nextMs = Date.UTC(ny, nm, Math.min(day, daysInMonth_(ny, nm))) - IST_OFFSET_MIN * MIN; // IST midnight
  var startKey = new Date(startMs).toISOString().slice(0, 10);
  return { mode: 'cycle', startKey: startKey, nextStartMs: nextMs, label: 'billing period from ' + startKey };
}

/** Units and requests counted against the current window. */
function adbTotals_(u, w) {
  var t = { units: 0, requests: 0 };
  Object.keys(u.days).forEach(function (k) {
    if (k >= w.startKey) { t.units += u.days[k][0]; t.requests += u.days[k][1]; }
  });
  return t;
}

function freshUsage_() {
  return { v: 2, days: {}, hour: { k: '', n: 0 }, pending: {}, warned: {}, lastReqAt: 0, suspended: null };
}

function isCount_(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n; }

function isPlainObject_(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function isDayKey_(k) { return /^\d{4}-\d{2}-\d{2}$/.test(String(k)); }

function validUsage_(u, nowMs) {
  if (!isPlainObject_(u) || u.v !== 2 || !isPlainObject_(u.days) || !isPlainObject_(u.pending) ||
      !isPlainObject_(u.warned) || !isPlainObject_(u.hour) || !isCount_(u.hour.n)) return false;
  var s = u.suspended;
  if (s != null && !(isPlainObject_(s) && (s.until == null || isCount_(s.until)))) return false;
  var maxKey = adbDayKey_(nowMs + 24 * HOUR); // allow small clock skew, nothing further ahead
  var daysOk = Object.keys(u.days).every(function (k) {
    var b = u.days[k];
    return isDayKey_(k) && k <= maxKey && Array.isArray(b) && b.length === 2 && isCount_(b[0]) && isCount_(b[1]);
  });
  var pendingOk = Object.keys(u.pending).every(function (id) {
    var p = u.pending[id];
    return isPlainObject_(p) && isCount_(p.u) && isCount_(p.r) && isCount_(p.t) && isDayKey_(p.day);
  });
  return daysOk && pendingOk;
}

/** First-version counter (units per IST month) for this and last month; null if none. */
function legacyUnits_(env, nowMs) {
  var d = istDate_(nowMs), y = d.getUTCFullYear(), m = d.getUTCMonth(), total = null;
  [[y, m], m === 0 ? [y - 1, 11] : [y, m - 1]].forEach(function (ym) {
    var raw = env.props.getProperty(ADB_LEGACY_PREFIX + ym[0] + '-' + pad2(ym[1] + 1));
    if (raw == null || raw === '') return;
    var n = Number(raw);
    if (!isCount_(n)) throw new Error('first-version usage counter is not a whole number');
    total = (total || 0) + n;
  });
  return total;
}

/** Throws on any doubt; callers treat a throw as "do not send". */
function loadUsage_(env, nowMs, C) {
  adbWindow_(nowMs, C); // validates the period setting
  var raw = env.props.getProperty(ADB_USAGE_PROP), u;
  if (raw == null || raw === '') {
    if (env.props.getProperty(ADB_USAGE_INIT_PROP)) throw new Error('usage store missing after initialisation');
    var fresh = freshUsage_(), legacy = legacyUnits_(env, nowMs);
    // Units per call were configurable then, so requests are taken as = units (an upper bound).
    if (legacy) fresh.days[adbDayKey_(nowMs)] = [legacy, legacy];
    return fresh;
  }
  try { u = JSON.parse(raw); } catch (e) { throw new Error('usage store is not valid JSON'); }
  if (u && u.v === 1 && isCount_(u.units) && isCount_(u.requests)) {
    // Earlier format had one total per period: keep it, dated today (it then counts for the whole window).
    var v1 = u;
    u = freshUsage_();
    u.days[adbDayKey_(nowMs)] = [v1.units, v1.requests];
    u.suspended = v1.suspended || null;
  }
  if (!validUsage_(u, nowMs)) throw new Error('usage store failed validation');
  var oldest = adbDayKey_(nowMs - ADB_BUCKET_KEEP_DAYS * 24 * HOUR);
  Object.keys(u.days).forEach(function (k) { if (k < oldest) delete u.days[k]; });
  // A reservation never finalised (execution killed mid-request): keep it charged, stop tracking it.
  Object.keys(u.pending).forEach(function (id) {
    if (nowMs - u.pending[id].t > ADB_PENDING_STALE_MS) delete u.pending[id];
  });
  return u;
}

function saveUsage_(env, u) {
  env.props.setProperty(ADB_USAGE_PROP, JSON.stringify(u));
  env.props.setProperty(ADB_USAGE_INIT_PROP, '1');
}

function withUsageLock_(env, fn) {
  if (!env.lock) throw new Error('no document lock (script must be bound to the spreadsheet)');
  if (!env.lock.tryLock(10 * 1000)) throw new Error('usage store lock busy');
  try { return fn(); } finally { env.lock.releaseLock(); }
}

function addToDay_(u, key, units, requests) {
  var b = u.days[key] || (u.days[key] = [0, 0]);
  b[0] = Math.max(0, b[0] + units);
  b[1] = Math.max(0, b[1] + requests);
}

/** Warns once per threshold; a threshold re-arms when usage falls back below it (window moved / sync). */
function thresholdNotices_(u, t, L, w, C) {
  var pcts = listSetting(C.ADB_WARN_PCT).map(Number).filter(function (p) { return p > 0 && p < 100; });
  [['units', L.units], ['requests', L.requests]].forEach(function (m) {
    var used = t[m[0]], pct = m[1] ? (used / m[1]) * 100 : 100;
    pcts.forEach(function (p) {
      var key = m[0] + p;
      if (pct < p) { delete u.warned[key]; return; }
      if (u.warned[key]) return;
      u.warned[key] = 1;
      adbNotices_.push('📊 AeroDataBox ' + m[0] + ' at ' + Math.floor(pct) + '% of the limit (' + used + '/' + m[1] + ', ' + w.label + ').');
    });
  });
}

function exhaustedNotice_(u, w, why) {
  if (u.warned.exhausted) return;
  u.warned.exhausted = 1;
  adbNotices_.push('⛔ AeroDataBox lookups suspended (' + w.label + '): ' + why +
    '. OpenSky live tracking continues' + (secret_safe_('FA_KEY') ? ' and FlightAware is used as backup' : '') +
    '. Flights due a check will show status UNKNOWN.' +
    (w.mode === 'rolling' ? ' Capacity returns as old usage leaves the rolling window; setting ADB_BILLING_CYCLE_DAY ' +
      '(from the RapidAPI dashboard) restores it at the real reset.' : ''));
}

function secret_safe_(k) { try { return adbEnv_().secret(k); } catch (e) { return null; } }

/**
 * Atomically checks both monthly limits and the hourly limit, then charges the full cost.
 * -> {ok, id} | {ok:false, kind, error}
 */
function adbReserve_(env, C, cost, label) {
  return withUsageLock_(env, function () {
    var now = env.now(), u = loadUsage_(env, now, C), L = adbLimits(C), w = adbWindow_(now, C), t = adbTotals_(u, w);
    if (u.suspended && (!u.suspended.until || u.suspended.until > now)) {
      return { ok: false, kind: 'suspended', error: 'AeroDataBox suspended: ' + u.suspended.reason };
    }
    u.suspended = null;
    var hourKey = adbHourKey_(now), hourN = u.hour.k === hourKey ? u.hour.n : 0;
    var deny = null, kind = 'budget';
    if (t.units + cost.units > L.units) deny = 'unit budget ' + t.units + '/' + L.units + ' used, request needs ' + cost.units;
    else if (t.requests + cost.requests > L.requests) deny = 'request budget ' + t.requests + '/' + L.requests + ' used';
    else if (hourN + cost.requests > L.perHour) { deny = 'hourly limit ' + hourN + '/' + L.perHour + ' reached'; kind = 'ratelimit'; }
    if (deny) {
      if (kind === 'budget') exhaustedNotice_(u, w, deny);
      saveUsage_(env, u);
      return { ok: false, kind: kind, error: 'AeroDataBox ' + deny + ' (' + w.label + ')' };
    }
    delete u.warned.exhausted;
    var wait = (u.lastReqAt || 0) + Number(C.ADB_MIN_INTERVAL_MS || 0) - now; // plan: 1 request/second
    if (wait > 0) { env.sleep(Math.min(wait, 2000)); now = env.now(); hourKey = adbHourKey_(now); if (u.hour.k !== hourKey) hourN = 0; }
    var day = adbDayKey_(now);
    addToDay_(u, day, cost.units, cost.requests);
    u.hour = { k: hourKey, n: hourN + cost.requests };
    var id = now + '-' + Math.floor(Math.random() * 1e9);
    u.pending[id] = { u: cost.units, r: cost.requests, t: now, day: day, ep: label };
    u.lastReqAt = now;
    thresholdNotices_(u, adbTotals_(u, w), L, w, C);
    saveUsage_(env, u);
    return { ok: true, id: id };
  });
}

/**
 * Closes a reservation exactly once. opts: notSent (refund), extraUnits, suspend, quotaExhausted.
 * A reservation that is no longer pending (already finalised or expired) is ignored.
 */
function adbFinalize_(env, C, id, opts) {
  return withUsageLock_(env, function () {
    var now = env.now(), u = loadUsage_(env, now, C), L = adbLimits(C), w = adbWindow_(now, C), p = u.pending[id];
    if (!p) return { u: u, totals: adbTotals_(u, w), window: w };
    delete u.pending[id];
    if (opts.notSent) addToDay_(u, p.day, -p.u, -p.r);
    if (opts.extraUnits) addToDay_(u, p.day, opts.extraUnits, 0);
    if (opts.quotaExhausted) {
      // The provider says the quota is used up. Its reset is only known in cycle mode.
      u.suspended = { kind: 'quota', reason: 'provider reports the quota is used up (HTTP 429)', until: w.nextStartMs };
      exhaustedNotice_(u, w, u.suspended.reason + (w.nextStartMs ? '; retrying after ' + fmtIST(w.nextStartMs) + ' IST'
        : '; check the reset date on the RapidAPI dashboard, then use "Resume AeroDataBox"'));
    }
    if (opts.suspend) {
      u.suspended = opts.suspend;
      adbNotices_.push('⛔ AeroDataBox suspended: ' + opts.suspend.reason +
        (opts.suspend.until ? ' until ' + fmtIST(opts.suspend.until) + ' IST.' : '. Fix the key, then use menu "Resume AeroDataBox".'));
    }
    var t = adbTotals_(u, w);
    thresholdNotices_(u, t, L, w, C);
    saveUsage_(env, u);
    return { u: u, totals: t, window: w };
  });
}

function adbFinalizeSafe_(env, C, id, opts) {
  try { return adbFinalize_(env, C, id, opts); }
  catch (e) { console.error('finalise failed; reservation stays charged: ' + e); return null; }
}

function storeFailure_(env, err) {
  var msg = '⛔ AeroDataBox usage store unavailable (' + (err && err.message || err) +
    '). Lookups are suspended (fail closed). Check the RapidAPI dashboard, then use menu "Sync usage from RapidAPI dashboard".';
  try {
    if (env && env.cache && env.cache.get('ADB_STORE_ALERT')) return;
    if (env && env.cache) env.cache.put('ADB_STORE_ALERT', '1', 6 * 3600);
  } catch (e) { /* alert anyway */ }
  adbNotices_.push(msg);
}

// ------------------------------------------------------------------ cache (well inside 7-day retention)
function adbCacheTtlSec_(C) {
  var retentionSec = Math.min(Number(C.ADB_RETENTION_HOURS) || 0, 168) * 3600;
  return Math.max(0, Math.min((Number(C.ADB_CACHE_MIN) || 0) * 60, 21600, retentionSec));
}

function adbCacheGet_(env, key) {
  try { var v = env.cache.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function adbCachePut_(env, key, legs, C) {
  var ttl = adbCacheTtlSec_(C);
  if (!ttl) return;
  try { env.cache.put(key, JSON.stringify(legs), ttl); } catch (e) { /* too large or unavailable: skip */ }
}

// ------------------------------------------------------------------ the gateway
/**
 * spec: {endpoint:'flightStatus', flight:'EK568', date:'YYYY-MM-DD', role:'Arrival'|'Departure'|'Both'}
 * -> {ok:true, legs, attempted} | {ok:false, kind, error, attempted, blocked?, uncertain?}
 *   attempted: an HTTP request was sent (and charged) for this call
 *   blocked:   nothing was sent because of budget, suspension or the usage store
 */
function adbRequest(spec) {
  var C = cfg(), env;
  try { env = adbEnv_(); } catch (e) {
    storeFailure_(null, e);
    return { ok: false, blocked: true, kind: 'store', error: 'AeroDataBox environment unavailable: ' + e, attempted: false };
  }
  var now = env.now();
  var bad = validateAdbRequest(spec, now);
  if (bad) return { ok: false, kind: 'invalid', error: 'AeroDataBox request rejected: ' + bad, attempted: false };
  if (!ADB_ENDPOINTS[spec.endpoint].callable) return { ok: false, kind: 'invalid', error: 'endpoint not enabled', attempted: false };

  var mk = adbMemoKey_(spec);
  if (adbMemo_[mk]) { var m = adbMemo_[mk]; return { ok: m.ok, legs: m.legs, kind: m.kind, error: m.error, blocked: m.blocked, uncertain: m.uncertain, deduped: true, attempted: false }; }
  var cached = adbCacheGet_(env, mk);
  if (cached) return (adbMemo_[mk] = { ok: true, legs: cached, cached: true, attempted: false });

  var key = env.secret('ADB_KEY');
  if (!key) return { ok: false, kind: 'config', error: 'ADB_KEY script property not set', attempted: false };

  var cost = adbCost(spec), label = ADB_ENDPOINTS[spec.endpoint].label, rsv;
  try { rsv = adbReserve_(env, C, cost, label); } catch (e) {
    storeFailure_(env, e);
    return (adbMemo_[mk] = { ok: false, blocked: true, kind: 'store', error: 'AeroDataBox usage store unavailable: ' + e.message, attempted: false });
  }
  if (!rsv.ok) return (adbMemo_[mk] = { ok: false, blocked: true, kind: rsv.kind, error: rsv.error, attempted: false });

  var params = spec.flight + ' ' + spec.date + ' ' + spec.role, code, body;
  try {
    var res = env.fetch(adbUrl_(spec), {
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' },
      muteHttpExceptions: true
    });
    code = res.getResponseCode();
    body = String(res.getContentText() || '');
  } catch (e) {
    // The request may have reached the provider: keep it charged and do not retry now.
    var u0 = adbFinalizeSafe_(env, C, rsv.id, {});
    logUsageSafe_(env, { at: now, label: label, params: params, code: '', units: cost.units, requests: cost.requests,
      outcome: 'UNKNOWN - no response (' + e + '); counted', usage: u0 });
    return (adbMemo_[mk] = { ok: false, kind: 'unknown', uncertain: true, attempted: true,
      error: 'AeroDataBox outcome unknown (' + e + '); counted against budget, not retried immediately' });
  }

  var fin = {}, result, outcome;
  if (code === 200) {
    var data = null;
    try { data = JSON.parse(body); } catch (e) { /* handled below */ }
    if (data) {
      var legs = Array.isArray(data) ? data : [data];
      if (legs.some(function (l) { return l && l.flightPlan; })) { fin.extraUnits = cost.units; outcome = 'ok (flight plan returned: charged x2)'; }
      result = { ok: true, legs: legs, attempted: true };
      outcome = outcome || 'ok';
      adbCachePut_(env, mk, legs, C);
    } else {
      result = { ok: false, kind: 'http', error: 'AeroDataBox returned an unreadable 200 response', attempted: true };
      outcome = 'unreadable 200';
    }
  } else if (code === 204) {
    result = { ok: false, kind: 'notfound', error: 'AeroDataBox: no flight ' + spec.flight + ' on ' + spec.date, attempted: true };
    outcome = 'no data (204)';
  } else if (code === 401 || code === 403) {
    fin.suspend = { kind: 'auth', reason: 'HTTP ' + code + ' (key invalid or not subscribed)', since: now };
    result = { ok: false, kind: 'auth', error: 'AeroDataBox HTTP ' + code + ': check ADB_KEY / subscription', attempted: true };
    outcome = 'auth error ' + code + '; lookups suspended';
  } else if (code === 429) {
    if (/month|quota/i.test(body)) fin.quotaExhausted = true;
    else fin.suspend = { kind: 'rate', reason: 'HTTP 429 rate limit', until: now + HOUR };
    result = { ok: false, kind: 'ratelimit', error: 'AeroDataBox HTTP 429: ' + body.slice(0, 120), attempted: true };
    outcome = fin.quotaExhausted ? 'quota exhausted (429); lookups suspended' : 'rate limited (429); paused 1 h';
  } else {
    result = { ok: false, kind: 'http', error: 'AeroDataBox HTTP ' + code + ': ' + body.slice(0, 150), attempted: true };
    outcome = 'HTTP ' + code;
  }
  var u = adbFinalizeSafe_(env, C, rsv.id, fin);
  logUsageSafe_(env, { at: now, label: label, params: params, code: code, units: cost.units + (fin.extraUnits || 0),
    requests: cost.requests, outcome: outcome + ' (counted)', usage: u });
  return (adbMemo_[mk] = result);
}

function logUsageSafe_(env, entry) {
  try { env.logUsage(entry); } catch (e) { console.log('usage log failed: ' + e + ' ' + JSON.stringify(entry)); }
}

// ------------------------------------------------------------------ admin (menu)
function adbUsageSummary() {
  var env = adbEnv_(), C = cfg(), L = adbLimits(C), now = env.now();
  var u = loadUsage_(env, now, C), w = adbWindow_(now, C), t = adbTotals_(u, w);
  return {
    mode: w.mode, window: w.label, units: t.units, unitLimit: L.units, requests: t.requests, requestLimit: L.requests,
    pending: Object.keys(u.pending).length, suspended: u.suspended
  };
}

/** Dashboard figure typed by a person -> whole number, or null. Blank/space is NOT zero. */
function parseDashboardCount(text) {
  var s = String(text == null ? '' : text).trim();
  return /^\d{1,7}$/.test(s) ? Number(s) : null;
}

/**
 * Replaces the local counters with the dashboard figures for the current billing cycle (also repairs
 * a corrupted store). The figures are dated today, so in rolling mode they keep counting for the whole window.
 * Lowering a readable local count needs allowLower (a separate confirmation): a lagging dashboard or a
 * typo would otherwise undo the conservative accounting. In-flight reservations and the hourly counter
 * are kept, and in-flight charges are added on top.
 */
function adbSetUsage(units, requests, allowLower) {
  var env = adbEnv_(), C = cfg();
  if (!isCount_(units) || !isCount_(requests)) throw new Error('Enter whole numbers ≥ 0.');
  withUsageLock_(env, function () {
    var now = env.now(), u = freshUsage_(), L = adbLimits(C), w = adbWindow_(now, C), cur = null, today = adbDayKey_(now);
    try { cur = loadUsage_(env, now, C); } catch (e) { cur = null; /* unreadable store: being repaired */ }
    if (cur) {
      var t = adbTotals_(cur, w);
      if (!allowLower && (units < t.units || requests < t.requests)) {
        var err = new Error('Local count (' + t.units + ' units, ' + t.requests + ' requests) is higher than the figures entered.');
        err.lowerBlocked = { units: t.units, requests: t.requests };
        throw err;
      }
      u.suspended = cur.suspended || null;
      u.hour = cur.hour;
      u.lastReqAt = cur.lastReqAt || 0;
      Object.keys(cur.pending).forEach(function (id) {
        var p = cur.pending[id];
        u.pending[id] = { u: p.u, r: p.r, t: p.t, day: today, ep: p.ep };
        units += p.u; requests += p.r;
      });
    } else {
      try { var old = JSON.parse(env.props.getProperty(ADB_USAGE_PROP) || 'null'); if (old && old.suspended) u.suspended = old.suspended; } catch (e) { /* replaced */ }
    }
    u.days[today] = [units, requests];
    var saved = adbNotices_; adbNotices_ = [];
    thresholdNotices_(u, adbTotals_(u, w), L, w, C); // marks thresholds already passed, without alerting
    adbNotices_ = saved;
    if (units >= L.units || requests >= L.requests) u.warned.exhausted = 1;
    saveUsage_(env, u);
  });
}

/**
 * Clears a suspension. A provider-reported quota exhaustion (HTTP 429 "quota") is only cleared with
 * confirmQuota = true, and that override is recorded in the API Usage log. Local budget limits still apply.
 * -> the suspension that was cleared (or null).
 */
function adbResume(confirmQuota) {
  var env = adbEnv_(), C = cfg(), cleared = null;
  withUsageLock_(env, function () {
    var u = loadUsage_(env, env.now(), C);
    if (u.suspended && u.suspended.kind === 'quota' && !confirmQuota) {
      var err = new Error('AeroDataBox itself reported the quota is used up. Resuming sends one more request, which will probably be refused.');
      err.quotaConfirm = true;
      throw err;
    }
    cleared = u.suspended || null;
    u.suspended = null;
    saveUsage_(env, u);
  });
  if (cleared) {
    logUsageSafe_(env, { at: env.now(), label: 'manual resume', params: '', code: '', units: 0, requests: 0,
      outcome: 'suspension cleared by a person: ' + cleared.kind + ' (' + cleared.reason + ')', usage: null });
  }
  return cleared;
}
