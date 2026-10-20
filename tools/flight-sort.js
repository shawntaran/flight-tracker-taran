/**
 * Local preview only: the Flights page's data layer (classification, filtering, search, arrival sorting).
 * Pure functions, no DOM. Loaded by tools/preview-app.html as window.FlightSort and by
 * test/flight-sort-tests.js through module.exports.
 *
 * Time rules:
 *  - Times are absolute UTC ms numbers (the dashboard contract). Sorting always compares parsed ms,
 *    never formatted strings, so flights crossing IST midnight order correctly.
 *  - A value that is not a usable timestamp (null, '', 0, NaN, a display string such as "Tue 20 Oct 14:05")
 *    is "unknown", never zero or "now". Strings are accepted only in ISO 8601 form.
 *  - An ETA more than ETA_MAX_DRIFT_MS away from its schedule is treated as invalid (stale or another day).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlightSort = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60 * 1000;
  var IST_OFFSET_MS = 330 * MIN;          // Asia/Kolkata, no DST
  var DAY_MS = 24 * 60 * MIN;
  var MIN_VALID_MS = Date.UTC(2000, 0, 1);
  var MAX_VALID_MS = Date.UTC(2100, 0, 1);
  var ETA_MAX_DRIFT_MS = 36 * 60 * MIN;
  var DELAY_THRESHOLD_MIN = 15;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  var ENDED = { LANDED: 1, CANCELLED: 1, DIVERTED: 1 };

  var FILTERS = ['ALL', 'ARR', 'DEP', 'AIRBORNE', 'DELAYED', 'LANDED', 'CANCELLED', 'UNKNOWN'];
  var SORTS = ['soonest', 'latest', 'flight'];
  var SECTIONS = [
    { key: 'inbound', title: 'Inbound arrivals' },
    { key: 'outbound', title: 'Departures' },
    { key: 'completed', title: 'Completed, cancelled & inactive' }
  ];

  /** Any input -> finite ms in a plausible range, or null. */
  function toMs(v) {
    var ms = null;
    if (typeof v === 'number') ms = v;
    else if (v instanceof Date) ms = v.getTime();
    else if (typeof v === 'string' && ISO_RE.test(v.trim())) ms = Date.parse(v.trim());
    return typeof ms === 'number' && isFinite(ms) && ms >= MIN_VALID_MS && ms < MAX_VALID_MS ? ms : null;
  }

  function status(f) { return String(f && f.status || 'SCHEDULED').toUpperCase(); }

  /** The estimate (ETA for arrivals, revised departure for departures) if it is usable. */
  function validEtaMs(f) {
    var eta = toMs(f.etaAt), sched = toMs(f.schedAt);
    if (eta == null) return null;
    if (sched != null && Math.abs(eta - sched) > ETA_MAX_DRIFT_MS) return null;
    return eta;
  }

  /** Best known time for the flight's BLR event: {ms, basis: 'estimated'|'scheduled'|null}. */
  function bestTime(f) {
    var eta = validEtaMs(f);
    if (eta != null) return { ms: eta, basis: 'estimated' };
    var sched = toMs(f.schedAt);
    if (sched != null) return { ms: sched, basis: 'scheduled' };
    return { ms: null, basis: null };
  }

  /** Arrival time at BLR for arrivals; null for departures (they never count as BLR arrivals). */
  function arrivalTimeMs(f) { return f && f.dir === 'ARR' ? bestTime(f).ms : null; }

  function delayMin(f) {
    var eta = validEtaMs(f), sched = toMs(f.schedAt);
    return eta != null && sched != null ? Math.round((eta - sched) / MIN) : null;
  }

  function isCompleted(f) {
    var s = status(f);
    if (f.active === false) return true;
    if (ENDED[s]) return true;
    if (f.dir === 'DEP' && s === 'DEPARTED') return true;
    return !!f.final;
  }

  function section(f) {
    if (isCompleted(f)) return 'completed';
    return f.dir === 'ARR' ? 'inbound' : 'outbound';
  }

  function isAirborne(f) {
    var s = status(f), t = f.telemetry || null;
    if (f.active === false || ENDED[s]) return false;
    if (f.dir === 'DEP' && f.final) return false;
    return s === 'DEPARTED' || !!(t && t.onGround === false);
  }

  function isDelayed(f) {
    if (status(f) === 'DELAYED') return true;
    if (isCompleted(f)) return false;
    var d = delayMin(f);
    return d != null && d >= DELAY_THRESHOLD_MIN;
  }

  function matchesFilter(f, filter) {
    switch (filter) {
      case 'ARR': return f.dir === 'ARR';
      case 'DEP': return f.dir === 'DEP';
      case 'AIRBORNE': return isAirborne(f);
      case 'DELAYED': return isDelayed(f);
      case 'LANDED': return status(f) === 'LANDED';
      case 'CANCELLED': return status(f) === 'CANCELLED' || status(f) === 'DIVERTED';
      case 'UNKNOWN': return status(f) === 'UNKNOWN';
      default: return true;
    }
  }

  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ''); }

  /** Search: flight number (spaces ignored, "BA 119" = "BA119"), faculty name, origin, destination. */
  function matchesQuery(f, query) {
    var q = norm(query);
    if (!q) return true;
    var fields = [f.flight, f.name, f.origin, f.originName, f.destination, f.destName];
    for (var i = 0; i < fields.length; i++) if (norm(fields[i]).indexOf(q) >= 0) return true;
    return false;
  }

  function cmpFlight(a, b) {
    return String(a.flight || '').localeCompare(String(b.flight || ''), 'en', { numeric: true, sensitivity: 'base' }) ||
      String(a.id || '').localeCompare(String(b.id || ''), 'en', { numeric: true });
  }

  /** Comparator on known times: unknown always last, ties broken by flight number then id. */
  function byTime(desc) {
    return function (a, b) {
      var ta = bestTime(a).ms, tb = bestTime(b).ms;
      if (ta == null && tb == null) return cmpFlight(a, b);
      if (ta == null) return 1;
      if (tb == null) return -1;
      return (desc ? tb - ta : ta - tb) || cmpFlight(a, b);
    };
  }

  /**
   * Sort one section. 'soonest' (default) and 'latest' order active flights by best known time;
   * the completed section is always most recent first, since its times are in the past.
   */
  function sortFlights(list, mode, sectionKey) {
    var cmp = mode === 'flight' ? cmpFlight
      : sectionKey === 'completed' ? byTime(true)
      : byTime(mode === 'latest');
    return list.slice().sort(cmp);
  }

  /**
   * The whole page model: search applies first, counts are per filter over the searched set,
   * then the selected filter, sections and per-section sort.
   */
  function buildView(flights, opts) {
    opts = opts || {};
    var filter = FILTERS.indexOf(opts.filter) >= 0 ? opts.filter : 'ALL';
    var sort = SORTS.indexOf(opts.sort) >= 0 ? opts.sort : 'soonest';
    var all = (flights || []).filter(Boolean);
    var searched = all.filter(function (f) { return matchesQuery(f, opts.query); });
    var counts = {};
    FILTERS.forEach(function (k) { counts[k] = searched.filter(function (f) { return matchesFilter(f, k); }).length; });
    var shown = searched.filter(function (f) { return matchesFilter(f, filter); });
    var sections = SECTIONS.map(function (s) {
      return { key: s.key, title: s.title, flights: sortFlights(shown.filter(function (f) { return section(f) === s.key; }), sort, s.key) };
    }).filter(function (s) { return s.flights.length; });
    return { filter: filter, sort: sort, total: all.length, shown: shown.length, counts: counts, sections: sections,
      ordered: sections.reduce(function (acc, s) { return acc.concat(s.flights); }, []) };
  }

  /** Active arrivals expected within [now - overdueMs, now + horizonMs], soonest first. */
  function upcomingInbounds(flights, nowMs, horizonMs, limit, overdueMs) {
    var hi = nowMs + (horizonMs == null ? 4 * 60 * MIN : horizonMs);
    var lo = nowMs - (overdueMs == null ? 2 * 60 * MIN : overdueMs);
    var list = (flights || []).filter(function (f) {
      if (section(f) !== 'inbound') return false;
      var t = arrivalTimeMs(f);
      return t != null && t >= lo && t <= hi;
    });
    list = sortFlights(list, 'soonest', 'inbound');
    return limit ? list.slice(0, limit) : list;
  }

  /** IST calendar-day difference of ms from refMs (+1 = tomorrow in IST). null if unknown. */
  function istDayOffset(ms, refMs) {
    var a = toMs(ms), b = toMs(refMs);
    if (a == null || b == null) return null;
    return Math.floor((a + IST_OFFSET_MS) / DAY_MS) - Math.floor((b + IST_OFFSET_MS) / DAY_MS);
  }

  /**
   * Journey progress 0..1 for the route graphic, or null when it cannot be known.
   * Departed + both times known: elapsed share. Landed: 1. Not yet departed: 0.
   */
  function progress(f, nowMs) {
    var s = status(f);
    if (s === 'LANDED') return 1;
    if (s === 'CANCELLED' || s === 'UNKNOWN') return null;
    if (!isAirborne(f)) return f.dir === 'DEP' && s === 'DEPARTED' ? null : 0;
    var t = f.telemetry || {};
    if (typeof t.progress === 'number' && isFinite(t.progress)) return Math.max(0, Math.min(1, t.progress));
    var dep = toMs(f.depActualAt) != null ? toMs(f.depActualAt) : toMs(f.depSchedAt);
    var arr = f.dir === 'ARR' ? bestTime(f).ms : toMs(f.destEtaAt);
    if (dep == null || arr == null || arr <= dep) return null;
    return Math.max(0.02, Math.min(0.98, (nowMs - dep) / (arr - dep)));
  }

  return {
    FILTERS: FILTERS, SORTS: SORTS, ETA_MAX_DRIFT_MS: ETA_MAX_DRIFT_MS, DELAY_THRESHOLD_MIN: DELAY_THRESHOLD_MIN,
    toMs: toMs, validEtaMs: validEtaMs, bestTime: bestTime, arrivalTimeMs: arrivalTimeMs, delayMin: delayMin,
    isCompleted: isCompleted, section: section, isAirborne: isAirborne, isDelayed: isDelayed,
    matchesFilter: matchesFilter, matchesQuery: matchesQuery, sortFlights: sortFlights, buildView: buildView,
    upcomingInbounds: upcomingInbounds, istDayOffset: istDayOffset, progress: progress
  };
});
