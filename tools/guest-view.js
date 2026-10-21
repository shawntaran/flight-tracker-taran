/**
 * Local preview only: one entry per guest instead of one per flight leg.
 * Pure functions, no DOM. Loaded by tools/preview-app.html as window.GuestView and by
 * test/guest-view-tests.js through module.exports. Leg times follow FlightSort.bestTime (valid ETA, else schedule).
 *
 * Active leg rules:
 *  - inbound:   the arrival exists and has not happened yet -> the arrival is shown prominently
 *  - outbound:  the arrival has happened (or there is none) and the departure has not -> the departure
 *  - completed: every leg the guest has is in the past -> the last leg, dimmed
 * A leg the guest does not have is "missing" and rendered as N/A.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GuestView = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function guestKey(f) {
    return String(f && (f.name || f.id) || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** A leg is past once the tracker calls it final/completed, or its best known time has gone by. */
  function legPassed(f, nowMs, fs) {
    if (!f) return false;
    if (f.final || fs.isCompleted(f)) return true;
    var t = fs.bestTime(f).ms;
    return t != null && t <= nowMs;
  }

  /** {phase, active: 'arrival'|'departure'|null, legs: {arrival, departure}} where each leg is active|done|upcoming|missing. */
  function activeLeg(guest, nowMs, fs) {
    var a = guest.arrival, d = guest.departure;
    var aPast = legPassed(a, nowMs, fs), dPast = legPassed(d, nowMs, fs);
    var phase = a && !aPast ? 'inbound' : d && !dPast ? 'outbound' : a || d ? 'completed' : 'none';
    var active = phase === 'inbound' ? 'arrival' : phase === 'outbound' ? 'departure' : d ? 'departure' : a ? 'arrival' : null;
    var state = function (leg, f, past) {
      if (!f) return 'missing';
      if (phase !== 'completed' && active === leg) return 'active';
      return past ? 'done' : 'upcoming';
    };
    return { phase: phase, active: active, legs: { arrival: state('arrival', a, aPast), departure: state('departure', d, dPast) } };
  }

  /** Flat flights -> one object per guest, in first-seen order. A repeated leg for the same guest keeps the first. */
  function groupGuests(flights, nowMs, fs) {
    var byKey = {}, out = [];
    (flights || []).forEach(function (f) {
      var k = guestKey(f);
      if (!k) return;
      var g = byKey[k];
      if (!g) { g = byKey[k] = { key: k, name: f.name || f.id, arrival: null, departure: null, extra: [] }; out.push(g); }
      var slot = f.dir === 'ARR' ? 'arrival' : f.dir === 'DEP' ? 'departure' : null;
      if (slot && !g[slot]) g[slot] = f; else g.extra.push(f);
    });
    out.forEach(function (g) {
      var s = activeLeg(g, nowMs, fs);
      g.phase = s.phase; g.active = s.active; g.legs = s.legs;
      g.activeFlight = s.active ? g[s.active] : null;
    });
    return out;
  }

  /** Inbound first (soonest arrival), then outbound (soonest departure), then completed (most recent first). */
  function sortGuests(guests, fs) {
    var rank = { inbound: 0, outbound: 1, completed: 2, none: 3 };
    var t = function (g) { var ms = g.activeFlight ? fs.bestTime(g.activeFlight).ms : null; return ms == null ? Infinity : ms; };
    return guests.slice().sort(function (x, y) {
      var r = rank[x.phase] - rank[y.phase];
      if (r) return r;
      var dt = x.phase === 'completed' ? t(y) - t(x) : t(x) - t(y);
      return (dt === dt && dt) || String(x.name).localeCompare(String(y.name)); // dt is NaN when both times are unknown
    });
  }

  return { guestKey: guestKey, legPassed: legPassed, activeLeg: activeLeg, groupGuests: groupGuests, sortGuests: sortGuests };
});
