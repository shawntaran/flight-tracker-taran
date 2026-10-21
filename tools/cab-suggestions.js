/**
 * Local preview only: turns the backend's grouping rules into coordinator suggestions.
 * "Which arriving people could reasonably share a cab?" The answer is a recommendation, never an assignment.
 *
 * - Groups come from the real planGroups() in src/Grouping.js (terminal bucket, GROUP_WINDOW_MIN from the
 *   first person, MAX_SEATS, pickup = last arrival + ARRIVAL_BUFFER_MIN). This module only adapts inputs and
 *   explains the result. It stores nothing and has no driver, vehicle or dispatch fields.
 * - Arrivals only. Times go through FlightSort so an unreadable ETA falls back to the schedule instead of
 *   reaching planGroups as a string.
 * - applyOverride() layers a coordinator-approved Smart Cab Plan change (tools/smart-dispatch.js) on top of the model,
 *   in memory only, re-checking seats and the stretch limit against the current times.
 * Loaded by tools/preview-app.html as window.CabSuggestions and by test/cab-suggestions-tests.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CabSuggestions = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN = 60 * 1000;

  function dur(m) { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ' min'; }
  function termLabel(t) { return t && t !== '?' ? t : ''; }

  function excludedReason(f, fs, nowMs) {
    var s = String(f.status || '').toUpperCase();
    if (f.active === false) return 'Tracking is off for this row';
    if (s === 'CANCELLED') return 'Cancelled: no pickup needed';
    if (s === 'DIVERTED') return 'Diverted: confirm the new plan with the guest';
    if (f.invalid || !f.flight) return 'No valid flight number yet';
    var t = fs.bestTime(f).ms;
    if (t == null) return 'No arrival time known yet';
    if (t < nowMs - 6 * 60 * MIN) return 'Arrived more than 6 h ago';
    return 'Not grouped';
  }

  /**
   * flights: dashboard flights. opts: {planGroups, config, nowMs, home, fs (FlightSort)}.
   * -> {shared: [suggestion], individual: [suggestion], excluded: [{f, reason}], byFlight: {id: info}, config, plan, overrides}
   */
  function build(flights, opts) {
    var fs = opts.fs, C = opts.config, now = opts.nowMs, home = opts.home || 'BLR';
    var arrivals = (flights || []).filter(function (f) { return f && f.dir === 'ARR'; });
    var byId = {};
    var rows = arrivals.map(function (f) {
      byId[f.id] = f;
      return {
        id: f.id, name: f.name, dir: 'ARR', active: f.active !== false,
        flightNorm: f.invalid ? 'INVALID' : String(f.flight || ''), status: String(f.status || ''),
        etaAt: fs.validEtaMs(f), schedArrAt: fs.toMs(f.schedAt),
        airport: f.airport || home, terminal: f.terminal || '', liveTerminal: ''
      };
    });
    var plan = opts.planGroups(rows, C, now);

    // All grouped arrival times per terminal bucket, to explain why someone rides alone.
    var bucketTimes = {};
    plan.groups.forEach(function (g) {
      var k = g.airport + '|' + g.terminal;
      g.items.forEach(function (it) { (bucketTimes[k] = bucketTimes[k] || []).push({ id: it.r.id, t: it.t }); });
    });

    var all = plan.groups.map(function (g) {
      var members = g.items.map(function (it) {
        var f = byId[it.r.id];
        return { f: f, t: it.t, basis: fs.bestTime(f).basis };
      });
      var times = g.items.map(function (it) { return it.t; });
      var first = Math.min.apply(null, times), last = Math.max.apply(null, times);
      var terminal = termLabel(g.terminal), reason;
      if (members.length > 1) {
        var spread = Math.round((last - first) / MIN);
        reason = (spread <= 1 ? 'Arrivals at about the same time' : 'Arrivals are within ' + spread + ' minutes') +
          ' · ' + (terminal ? 'Same terminal (' + terminal + ')' : 'Same arrival area (terminal not confirmed)');
      } else {
        var others = (bucketTimes[g.airport + '|' + g.terminal] || []).filter(function (x) { return x.id !== g.items[0].r.id; });
        var gap = others.length ? Math.min.apply(null, others.map(function (x) { return Math.abs(x.t - first) / MIN; })) : null;
        if (!terminal) reason = 'Terminal not known yet; confirm it before sharing';
        else if (gap == null) reason = 'No other arrival at ' + terminal + ' in this period';
        else if (gap > C.GROUP_WINDOW_MIN) reason = 'Nearest other ' + terminal + ' arrival is ' + dur(gap) + ' away (window ' + C.GROUP_WINDOW_MIN + ' min)';
        else reason = 'Nearby suggestion is full (' + C.MAX_SEATS + ' seats) or outside the ' + C.GROUP_WINDOW_MIN + '-minute window';
      }
      return {
        key: g.id, kind: members.length > 1 ? 'shared' : 'individual', terminal: terminal, airport: g.airport,
        pickupMs: g.pickupMs, firstMs: first, lastMs: last, members: members, reason: reason, pickupPassed: g.pickupMs < now
      };
    });

    var model = finalize(all, { windowMin: C.GROUP_WINDOW_MIN, maxSeats: C.MAX_SEATS, bufferMin: C.ARRIVAL_BUFFER_MIN });
    model.excluded = arrivals.filter(function (f) { return !model.byFlight[f.id]; })
      .map(function (f) { return { f: f, reason: excludedReason(f, fs, now) }; });
    model.plan = plan; // the raw planGroups() result, for the Smart Cab Plan
    return model;
  }

  /** Suggestions -> numbered model with the per-flight index. Shared by build() and applyOverride(). */
  function finalize(all, config) {
    all = all.slice().sort(function (a, b) { return a.pickupMs - b.pickupMs || a.key.localeCompare(b.key); });
    var shared = all.filter(function (s) { return s.kind === 'shared'; });
    var individual = all.filter(function (s) { return s.kind === 'individual'; });
    shared.forEach(function (s, i) { s.number = i + 1; s.label = 'Suggested Cab ' + s.number; });
    individual.forEach(function (s) { s.label = 'Individual pickup suggested'; });

    var byFlight = {};
    all.forEach(function (s) {
      s.members.forEach(function (m) {
        byFlight[m.f.id] = { kind: s.kind, number: s.number || null, key: s.key, label: s.label, pickupMs: s.pickupMs,
          terminal: s.terminal, size: s.members.length, reason: s.reason, override: !!s.override,
          with: s.members.filter(function (o) { return o.f.id !== m.f.id; }).map(function (o) { return o.f; }) };
      });
    });
    return { shared: shared, individual: individual, excluded: [], byFlight: byFlight, config: config, overrides: [] };
  }

  /**
   * Applies one checked Smart Cab Plan suggestion ({affected, groups: [[flight id]], reasoning, action}) to a model.
   * The listed guests ride together as given; whoever is left in the cabs they leave keeps a cab of their own.
   * opts: {nowMs, maxStretchMin}. -> {ok, model} | {ok: false, error}. The input model is not changed.
   */
  function applyOverride(model, sg, opts) {
    var now = opts.nowMs, maxStretch = opts.maxStretchMin, cfg = model.config;
    var all = model.shared.concat(model.individual), member = {}, cabOf = {};
    all.forEach(function (s) { s.members.forEach(function (m) { member[m.f.id] = m; cabOf[m.f.id] = s; }); });
    var affected = [].concat.apply([], sg.groups);
    var missing = affected.filter(function (id) { return !member[id]; });
    if (missing.length) return { ok: false, error: 'no longer in the cab plan: ' + missing.join(', ') };

    var seq = (model.overrides || []).length + 1, made = [];
    function entry(members, reason, override) {
      members = members.slice().sort(function (a, b) { return a.t - b.t; });
      var first = members[0].t, last = members[members.length - 1].t;
      var terms = members.map(function (m) { return termLabel(cabOf[m.f.id].terminal); })
        .filter(function (t, i, a) { return t && a.indexOf(t) === i; });
      return { key: 'AI-' + seq + '-' + (made.length + 1), kind: members.length > 1 ? 'shared' : 'individual',
        terminal: terms[0] || '', terminals: terms, crossTerminal: terms.length > 1, airport: cabOf[members[0].f.id].airport,
        pickupMs: last + cfg.bufferMin * MIN, firstMs: first, lastMs: last, members: members, reason: reason,
        pickupPassed: last + cfg.bufferMin * MIN < now, override: override };
    }
    for (var i = 0; i < sg.groups.length; i++) {
      var ms = sg.groups[i].map(function (id) { return member[id]; });
      var e = entry(ms, 'AI override: ' + sg.reasoning, { action: sg.action });
      var spread = Math.round((e.lastMs - e.firstMs) / MIN);
      if (ms.length > cfg.maxSeats) return { ok: false, error: ms.length + ' guests exceed ' + cfg.maxSeats + ' seats' };
      if (maxStretch != null && spread > maxStretch) return { ok: false, error: 'arrivals are now ' + spread + ' min apart (limit ' + maxStretch + ')' };
      made.push(e);
    }
    var kept = [];
    all.forEach(function (s) {
      var rest = s.members.filter(function (m) { return affected.indexOf(m.f.id) < 0; });
      if (rest.length === s.members.length) kept.push(s);
      else if (rest.length) made.push(entry(rest, 'Left in this cab after an AI override moved ' + (s.members.length - rest.length) + ' guest(s) out.', s.override || null));
    });
    var next = finalize(kept.concat(made), cfg);
    next.excluded = model.excluded; next.plan = model.plan;
    next.overrides = (model.overrides || []).concat([sg]);
    return { ok: true, model: next };
  }

  return { build: build, applyOverride: applyOverride };
});
