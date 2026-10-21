'use strict';
// Local preview data source: the tracker's data in Supabase (the `flights` table, plus `groups`, `config` and
// `status` tables if they exist), the same data the Telegram assistant reads (local-assistant/src/snapshot.js).
// Read server-side with the anon key (local-assistant/src/supabase.js, select only); no key reaches the browser.
// supabase.js hands the rows over in the old sheet-tab shape (header row + value rows), so the mappers below
// are unchanged and "tab" still names the sheet each table was imported from.
//
// The payload has the shape of buildDashboardData_ in src/Dashboard.js, plus `source` and `lastTick`.
// Columns are found by HEADER NAME (COLS in src/Sheet.js). Only an allowlist is copied: Phone, Email,
// Telegram Chat ID, Notes, Driver Telegram Chat ID and Member IDs are never read into the payload.
//
// PREVIEW_SOURCE=import (local-assistant/.env.local-assistant) reads the Import tab's columns instead. With the
// default (flights), a table without the tracker's columns falls back to the Import columns, with an entry in errors[].

const { parseTime } = require('../local-assistant/src/time');
const { mapImportRows, normFlight } = require('./import-source');

const CACHE_MS = 60 * 1000;        // the 5-minute auto-refresh is served from this
const FRESH_MIN_MS = 5 * 1000;     // ?fresh=1 (a click on Refresh): at most one real read per 5 s
const ATTRIBUTION = 'Flight status data: AeroDataBox (https://aerodatabox.com)'; // = ADB_ATTRIBUTION (tested)
const SOURCE_FLIGHTS = 'Supabase · flights table (tracked)';
const SOURCE_IMPORT = 'Supabase · flights table, Import columns (schedule only)';
const FALLBACK_NOTE = 'flights table empty or without the tracker\'s columns: showing Import-column schedules only, no live status';
const USAGE_NOTE = 'Not available in the local preview (Apps Script only).';
const FINAL = { ARR: { LANDED: 1, CANCELLED: 1, DIVERTED: 1 }, DEP: { DEPARTED: 1, CANCELLED: 1, DIVERTED: 1 } }; // = Tracker.FINAL

const text = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 120);

/** Header row -> {has(h), get(row, h)}. Unknown headers are simply never asked for (allowlist). */
function table(rows) {
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) return null;
  const idx = {};
  rows[0].forEach((h, i) => { const k = text(h, 80); if (k && !(k in idx)) idx[k] = i; });
  return { has: (h) => h in idx, body: rows.slice(1), get: (r, h) => (h in idx && Array.isArray(r) ? r[idx[h]] : undefined) };
}

function readConfig(rows) {
  const out = { homeAirport: 'BLR', maxSeats: 4 };
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    if (!Array.isArray(r)) return;
    const k = text(r[0], 40), v = text(r[1], 10);
    if (k === 'HOME_AIRPORT' && /^[A-Za-z]{3}$/.test(v)) out.homeAirport = v.toUpperCase();
    if (k === 'MAX_SEATS' && /^\d{1,2}$/.test(v) && +v > 0) out.maxSeats = +v;
  });
  return out;
}

const isActive = (v) => !(v === false || /^(false|no|0)$/i.test(text(v, 10)));

/**
 * Pure: Flights tab values -> {flights, usable}. usable is false when the tab has no recognisable header
 * row or no data rows, which triggers the Import fallback.
 */
function mapFlightsRows(rows, conf, redact) {
  const F = table(rows);
  if (!F || !F.has('Status') || !(F.has('Flight') || F.has('Flight (normalised)'))) return { flights: [], usable: false };
  const flights = [];
  F.body.forEach((r, n) => {
    const g = (h) => F.get(r, h);
    const raw = text(g('Flight'), 20), id = text(g('ID'), 20);
    if (!raw && !id) return;                                                      // blank row (as readFlights)
    const dir = /^d/i.test(text(g('Direction'), 12)) ? 'DEP' : 'ARR', arr = dir === 'ARR';
    const normCell = text(g('Flight (normalised)'), 12).toUpperCase();
    const norm = normCell && normCell !== 'INVALID' ? normCell : normCell === 'INVALID' ? null : normFlight(raw);
    const status = text(g('Status'), 20).toUpperCase() || 'SCHEDULED';          // as prepareRow
    const airport = (text(g('Airport'), 3).toUpperCase().match(/^[A-Z]{3}$/) || [conf.homeAirport])[0];
    flights.push({
      id: id || 'F' + (n + 2), name: text(g('Name'), 80), dir, active: isActive(g('Active')),
      final: !!FINAL[dir][status], flight: norm || raw, invalid: !norm, airport,
      terminal: text(g('Terminal (live)'), 8) || text(g('Terminal'), 8), gate: text(g('Gate'), 8), status,
      schedAt: arr ? parseTime(g('m:schedArr')) || parseTime(g('Sched Arr (IST)')) : parseTime(g('m:schedDep')) || parseTime(g('Sched Dep (IST)')),
      etaAt: arr ? parseTime(g('m:eta')) : parseTime(g('m:revDep')),
      etaSource: text(g('ETA Source'), 80), groupId: text(g('Cab Group'), 40), pickupDisp: text(g('Pickup (IST)'), 30),
      lastCheckDisp: text(g('Last Check (IST)'), 30), lastError: redact(text(g('Last Error'), 300))
    });
  });
  return { flights, usable: flights.length > 0 };
}

/** Pure: Groups tab values -> dashboard groups. Driver Telegram Chat ID and Member IDs are never read. */
function mapGroupsRows(rows, flights) {
  const G = table(rows);
  if (!G || !G.has('Group')) return [];
  return G.body.map((r) => {
    const id = text(G.get(r, 'Group'), 40);
    if (!id) return null;
    const n = Number(G.get(r, 'Count'));
    return { id, count: Number.isFinite(n) && n > 0 ? n : flights.filter((f) => f.groupId === id).length,
      vehicle: text(G.get(r, 'Vehicle'), 40), driver: text(G.get(r, 'Driver'), 60), pickupDisp: text(G.get(r, 'Pickup (IST)'), 30) };
  }).filter(Boolean);
}

/** Pure: Status tab (Key / Value / Notes) -> lastTick or null when there is no heartbeat at all. */
function readStatusRows(rows, redact) {
  const kv = {};
  (Array.isArray(rows) ? rows.slice(1) : []).forEach((r) => { if (Array.isArray(r) && text(r[0], 40)) kv[text(r[0], 40)] = r[1]; });
  if (!('LAST_TICK_AT' in kv) || (!text(kv.LAST_TICK_AT) && !text(kv.LAST_TICK_RESULT))) return null; // set up, never run
  const inst = text(kv.TRIGGER_INSTALLED, 5).toLowerCase();
  return { at: parseTime(kv.LAST_TICK_AT), result: text(kv.LAST_TICK_RESULT, 10).toLowerCase() || '',
    error: redact(text(kv.LAST_TICK_ERROR, 200)), triggerInstalled: inst === 'yes' ? true : inst === 'no' ? false : null };
}

function payload(now, conf, source, flights, groups, errors, lastTick) {
  return {
    generatedAt: now, preview: false, source, homeAirport: conf.homeAirport, maxSeats: conf.maxSeats, attribution: ATTRIBUTION,
    flights, groups, log: [], tickTriggers: null, usage: null, usageError: USAGE_NOTE, errors, assistant: { enabled: false }, lastTick
  };
}

/**
 * opts: {readRange: async (tab) => {rows}|{missing:true}, previewSource, now, redact} for tests; with no
 * readRange the local assistant's config and read-only Supabase client are used.
 * -> async getDashboardData({fresh}) . fresh skips the 60 s cache (one real read per 5 s at most).
 */
function createSheetSource(opts) {
  const o = opts || {};
  let readRange = o.readRange, previewSource = o.previewSource, redact = o.redact || ((s) => String(s));
  if (!readRange) {
    const { loadConfig } = require('../local-assistant/src/config');
    const { createSupabase } = require('../local-assistant/src/supabase');
    const { makeRedactor } = require('../local-assistant/src/redact');
    const { config } = loadConfig(o.envFile);
    redact = makeRedactor([config.supabase.anonKey, config.tgToken, config.llm.apiKey]);
    previewSource = config.previewSource;
    readRange = createSupabase({ url: config.supabase.url, anonKey: config.supabase.anonKey, redact }).readRange;
  }
  const now = o.now || (() => Date.now());
  let cache = null, lastRead = -Infinity;

  async function readImport(t, conf, errors) {
    const r = await readRange('Import');
    if (r.missing) throw new Error('Supabase has no "flights" table' + (errors.length ? ' (' + errors[0] + ')' : ''));
    const m = mapImportRows(r.rows, t, conf.homeAirport);
    return payload(t, conf, SOURCE_IMPORT, m.flights, [], errors.concat(m.errors), null);
  }

  async function build(t) {
    if (previewSource === 'import') return readImport(t, readConfig(null), []);
    const [fl, gr, cf, st] = await Promise.all(['Flights', 'Groups', 'Config', 'Status'].map((tab) =>
      Promise.resolve().then(() => readRange(tab)).catch((e) => ({ error: redact((e && e.message) || e) }))));
    if (fl.error) throw new Error(fl.error);
    const conf = readConfig(cf.rows);
    const errors = [];
    const m = fl.rows ? mapFlightsRows(fl.rows, conf, redact) : { flights: [], usable: false };
    if (!m.usable) return readImport(t, conf, [FALLBACK_NOTE]);                   // never silently
    if (gr.error) errors.push('Groups: ' + gr.error);
    if (st.error) errors.push('Status: ' + st.error);
    const lastTick = st.rows ? readStatusRows(st.rows, redact) : null; // null: the page warns "no heartbeat"
    return payload(t, conf, SOURCE_FLIGHTS, m.flights, gr.rows ? mapGroupsRows(gr.rows, m.flights) : [], errors, lastTick);
  }

  return async function getDashboardData(req) {
    const t = now(), fresh = !!(req && req.fresh);
    if (cache && (fresh ? t - lastRead < FRESH_MIN_MS : t - cache.at < CACHE_MS)) return cache.data;
    lastRead = t;
    const data = await build(t);
    cache = { at: t, data };
    return data;
  };
}

module.exports = { createSheetSource, mapFlightsRows, mapGroupsRows, readStatusRows, readConfig,
  SOURCE_FLIGHTS, SOURCE_IMPORT, FALLBACK_NOTE, ATTRIBUTION, CACHE_MS, FRESH_MIN_MS };
