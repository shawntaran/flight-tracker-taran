'use strict';
// Sheet rows -> sanitized tracker snapshot. Columns are found by HEADER NAME (PROJECT_STATUS §14,
// contract 1), and only an allowlist of fields is copied: no phone, email, Telegram id, notes,
// errors, drivers or vehicles ever enter the snapshot.

const { MIN, parseTime } = require('./time');

const KNOWN_STATUS = ['SCHEDULED', 'DELAYED', 'DEPARTED', 'LANDED', 'CANCELLED', 'DIVERTED', 'UNKNOWN'];
const FINAL = { arrival: ['LANDED', 'CANCELLED', 'DIVERTED'], departure: ['DEPARTED', 'CANCELLED', 'DIVERTED'] };

/** Plain, single-line, length-capped text: sheet cells are untrusted. */
function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f  ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 60);
}

function table(rows) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) return null;
  const idx = {};
  rows[0].forEach((h, i) => { const k = clean(h, 80); if (k && !(k in idx)) idx[k] = i; });
  return { has: (h) => h in idx, body: rows.slice(1).filter(Array.isArray), get: (r, h) => (h in idx ? r[idx[h]] : undefined) };
}

function normFlight(s) {
  const t = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  const m = t.match(/^([A-Z]{2,3}|[A-Z]\d|\d[A-Z])0*(\d{1,4})$/);
  return m ? m[1] + m[2] : t;
}

function latestKind(dir, etaSource, hasLatest) {
  if (!hasLatest) return 'unknown';
  if (dir === 'departure') return 'revised by the airline';
  if (/on ground/i.test(etaSource)) return 'actual (seen on the ground)';
  if (/^live/i.test(etaSource)) return 'live estimate';
  if (/actual/i.test(etaSource)) return 'actual';
  if (/estimated/i.test(etaSource)) return 'airline estimate';
  if (/scheduled/i.test(etaSource)) return 'scheduled';
  return 'tracker estimate';
}

/**
 * Live position as the tracker reported it. "fresh" only if the tracker's ETA source is a live
 * OpenSky fix no older than staleMin (the tracker's OPENSKY_STALE_MIN). Nothing is interpolated.
 */
function liveState(etaSource, lastFix, nowMs, staleMin, airport) {
  if (/^live \(OpenSky, on ground\)/i.test(etaSource) && lastFix != null) {
    return { state: 'on ground', summary: 'on the ground at ' + airport, asOf: lastFix, ageMin: Math.max(0, Math.round((nowMs - lastFix) / MIN)) };
  }
  if (lastFix == null) return { state: 'unavailable' };
  const age = (nowMs - lastFix) / MIN;
  if (age < -5) return { state: 'unavailable', note: 'the recorded position time is in the future' };
  if (age <= staleMin && /^live/i.test(etaSource)) {
    const km = etaSource.match(/(\d+)\s*km out/i);
    return { state: 'fresh', summary: km ? 'about ' + km[1] + ' km from ' + airport : 'airborne, seen by OpenSky', asOf: lastFix, ageMin: Math.max(0, Math.round(age)) };
  }
  return { state: 'stale', asOf: lastFix, ageMin: Math.round(age) };
}

function readConfig(rows) {
  const out = { homeAirport: 'BLR', staleMin: 20 };
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (!Array.isArray(r)) return;
    const k = clean(r[0], 40), v = r[1];
    if (k === 'HOME_AIRPORT' && /^[A-Za-z]{3}$/.test(clean(v, 3))) out.homeAirport = clean(v, 3).toUpperCase();
    if (k === 'OPENSKY_STALE_MIN' && isFinite(Number(v)) && Number(v) > 0) out.staleMin = Math.min(120, Number(v));
  });
  return out;
}

/**
 * raw: {flights, groups, config}: each {rows} | {missing: true} | {error: 'text'} | undefined.
 * Never throws: every problem becomes a line in snapshot.problems.
 */
function buildSnapshot(raw, nowMs) {
  raw = raw || {};
  const problems = [];
  const conf = readConfig(raw.config && raw.config.rows);
  const snap = { readAt: nowMs, homeAirport: conf.homeAirport, staleMin: conf.staleMin, flights: [], cabSuggestions: [], problems };

  const src = raw.flights || {};
  const F = src.rows ? table(src.rows) : null;
  if (src.error) problems.push('Flights sheet could not be read: ' + clean(src.error, 160));
  else if (src.missing) problems.push('Flights sheet is missing');
  else if (!F || !F.has('Status') || !(F.has('Flight (normalised)') || F.has('Flight'))) problems.push('Flights sheet has no recognisable header row');
  if (F && F.has('Status')) {
    F.body.forEach((r) => {
      const g = (h) => F.get(r, h);
      const name = clean(g('Name'), 60);
      const norm = clean(g('Flight (normalised)'), 12).toUpperCase();
      const flight = norm && norm !== 'INVALID' ? norm : clean(g('Flight'), 12).toUpperCase();
      if (!flight && !name) return;
      const act = g('Active');
      if (act === false || /^(false|no|0)$/i.test(String(act == null ? '' : act).trim())) return;
      const dir = /^d/i.test(clean(g('Direction'), 12)) ? 'departure' : 'arrival';
      const statusRaw = clean(g('Status'), 20).toUpperCase();
      const known = KNOWN_STATUS.indexOf(statusRaw) >= 0;
      const status = known ? statusRaw : 'UNKNOWN';
      const statusNote = !statusRaw ? 'not checked by the tracker yet' : known ? '' : 'unrecognised status on the sheet';
      const airport = (clean(g('Airport'), 3).toUpperCase().match(/^[A-Z]{3}$/) || [conf.homeAirport])[0];
      const arr = dir === 'arrival';
      const sched = arr ? parseTime(g('m:schedArr')) || parseTime(g('Sched Arr (IST)'))
        : parseTime(g('m:schedDep')) || parseTime(g('Sched Dep (IST)'));
      const latest = arr ? parseTime(g('m:eta')) || parseTime(g('m:adbEta')) : parseTime(g('m:revDep'));
      const etaSource = clean(g('ETA Source'), 80);
      snap.flights.push({
        name, flight: flight || '(no flight number)', key: normFlight(flight), dir, airport, status, statusNote,
        final: FINAL[dir].indexOf(status) >= 0,
        terminal: clean(g('Terminal (live)'), 6) || clean(g('Terminal'), 6), gate: clean(g('Gate'), 8),
        schedMs: sched, latestMs: latest, latestKind: latestKind(dir, etaSource, latest != null),
        delayMin: sched != null && latest != null ? Math.round((latest - sched) / MIN) : null,
        etaSource, lastChecked: clean(g('Last Check (IST)'), 24),
        live: arr ? liveState(etaSource, parseTime(g('m:lastFix')), nowMs, conf.staleMin, airport) : null,
        cab: clean(g('Cab Group'), 40) ? { group: clean(g('Cab Group'), 40), pickup: clean(g('Pickup (IST)'), 24) } : null
      });
    });
    snap.flights.sort((a, b) => ((a.latestMs || a.schedMs || Infinity) - (b.latestMs || b.schedMs || Infinity)));
  }

  const gs = raw.groups || {};
  const G = gs.rows ? table(gs.rows) : null;
  if (gs.error) problems.push('Groups sheet could not be read: ' + clean(gs.error, 160));
  if (G && G.has('Group')) {
    G.body.forEach((r) => {
      const id = clean(G.get(r, 'Group'), 40);
      if (!id) return;
      snap.cabSuggestions.push({
        group: id, direction: /^d/i.test(clean(G.get(r, 'Direction'), 12)) ? 'departure' : 'arrival',
        airport: clean(G.get(r, 'Airport'), 3), terminal: clean(G.get(r, 'Terminal'), 6),
        suggestedPickup: clean(G.get(r, 'Pickup (IST)'), 24),
        people: clean(G.get(r, 'Members'), 240), flights: clean(G.get(r, 'Flights / times'), 240)
      });
    });
  }
  return snap;
}

module.exports = { buildSnapshot, normFlight, clean, KNOWN_STATUS };
