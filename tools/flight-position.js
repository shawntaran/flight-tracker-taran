/**
 * Local preview only: rules for plotting aircraft positions on the Flights map.
 * Pure functions, no DOM, no network. Loaded by tools/preview-app.html as window.FlightPosition and by
 * test/flight-position-tests.js through module.exports.
 *
 * Integrity rules:
 *  - Only coordinates the tracker reported (flight.telemetry.lat/lon with a fixAt timestamp) are plotted.
 *    Nothing is interpolated from the schedule; a flight without a reported position is "unavailable".
 *  - A position without a valid timestamp, with a future timestamp or older than maxAgeMin is not plotted.
 *  - fresh: fix no older than freshMin (default 20 = the tracker's OPENSKY_STALE_MIN);
 *    stale: older than that but within maxAgeMin; grounded: the provider says on ground.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FlightPosition = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60 * 1000;
  var DEFAULTS = { freshMin: 20, maxAgeMin: 6 * 60, futureSkewMin: 5 };
  var LABEL = { fresh: 'Fresh', stale: 'Stale', grounded: 'On ground', unavailable: 'No position' };

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function toMs(v) {
    var ms = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : null;
    return ms != null && isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
  }
  function validLatLon(lat, lon) {
    lat = num(lat); lon = num(lon);
    return lat != null && lon != null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
  }

  function unavailable(reason) { return { state: 'unavailable', label: LABEL.unavailable, reason: reason, lat: null, lon: null }; }

  /** -> {state, label, reason, lat, lon, fixAt, ageMin, onGround, altFt, gsKts, headingDeg} */
  function positionState(f, nowMs, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var s = String(f && f.status || 'SCHEDULED').toUpperCase(), t = f && f.telemetry;
    if (s === 'CANCELLED') return unavailable('Cancelled');
    if (!t || !validLatLon(t.lat, t.lon)) {
      if (f && f.dir === 'DEP' && s === 'DEPARTED') return unavailable('Not tracked after departure');
      if (s === 'UNKNOWN') return unavailable('Status unverified, no position reported');
      return unavailable(s === 'DEPARTED' || s === 'DELAYED' ? 'No position reported by the tracker' : 'Scheduled data only, no position reported');
    }
    var fixAt = toMs(t.fixAt);
    if (fixAt == null) return unavailable('Position has no timestamp');
    if (fixAt - nowMs > o.futureSkewMin * MIN) return unavailable('Position timestamp is in the future');
    var ageMin = Math.max(0, Math.round((nowMs - fixAt) / MIN));
    if (ageMin > o.maxAgeMin) return unavailable('Last position is ' + Math.round(ageMin / 60) + 'h old');
    var state = t.onGround ? 'grounded' : ageMin <= o.freshMin ? 'fresh' : 'stale';
    return {
      state: state, label: LABEL[state], reason: state === 'stale' ? 'No new position for ' + ageMin + ' min (coverage gap)' : '',
      lat: t.lat, lon: t.lon, fixAt: fixAt, ageMin: ageMin, onGround: !!t.onGround,
      altFt: num(t.altFt), gsKts: num(t.gsKts), headingDeg: num(t.headingDeg)
    };
  }

  function airportPoint(code, airports) {
    var a = code && airports && airports[String(code).toUpperCase()];
    return a && validLatLon(a.lat, a.lon) ? { code: String(code).toUpperCase(), lat: a.lat, lon: a.lon, name: a.name || '' } : null;
  }

  /** Origin and destination points when their coordinates are known (either may be null). */
  function routeEnds(f, airports, home) {
    var arr = f.dir === 'ARR';
    var o = f.origin || (arr ? '' : f.airport || home), d = f.destination || (arr ? f.airport || home : '');
    return { origin: airportPoint(o, airports), dest: airportPoint(d, airports) };
  }

  /** Great-circle points between two {lat, lon}; [] if either is missing. Longitudes are unwrapped for maps. */
  function greatCircle(a, b, n) {
    if (!a || !b) return [];
    n = n || 32;
    var r = Math.PI / 180;
    var p1 = [a.lat * r, a.lon * r], p2 = [b.lat * r, b.lon * r];
    var d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((p2[0] - p1[0]) / 2), 2) +
      Math.cos(p1[0]) * Math.cos(p2[0]) * Math.pow(Math.sin((p2[1] - p1[1]) / 2), 2)));
    if (d === 0) return [[a.lat, a.lon], [b.lat, b.lon]];
    var pts = [], prevLon = null;
    for (var i = 0; i <= n; i++) {
      var f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
      var x = A * Math.cos(p1[0]) * Math.cos(p1[1]) + B * Math.cos(p2[0]) * Math.cos(p2[1]);
      var y = A * Math.cos(p1[0]) * Math.sin(p1[1]) + B * Math.cos(p2[0]) * Math.sin(p2[1]);
      var z = A * Math.sin(p1[0]) + B * Math.sin(p2[0]);
      var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / r, lon = Math.atan2(y, x) / r;
      if (prevLon != null) while (lon - prevLon > 180) lon -= 360;
      if (prevLon != null) while (prevLon - lon > 180) lon += 360;
      prevLon = lon;
      pts.push([lat, lon]);
    }
    return pts;
  }

  /** Splits flights into plotted ({f, pos}) and not plotted ({f, pos}) for the overview map. */
  function mapItems(flights, nowMs, opts) {
    var plotted = [], unplotted = [];
    (flights || []).filter(Boolean).forEach(function (f) {
      var pos = positionState(f, nowMs, opts);
      (pos.state === 'unavailable' ? unplotted : plotted).push({ f: f, pos: pos });
    });
    return { plotted: plotted, unplotted: unplotted };
  }

  return { DEFAULTS: DEFAULTS, LABEL: LABEL, validLatLon: validLatLon, positionState: positionState,
    airportPoint: airportPoint, routeEnds: routeEnds, greatCircle: greatCircle, mapItems: mapItems };
});
