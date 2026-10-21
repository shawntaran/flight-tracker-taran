'use strict';
// Local preview data source: the spreadsheet's "Import" tab, read server-side with the local assistant's
// read-only OAuth token (spreadsheets.readonly). The sheet stays private and no credential reaches the browser.
// One Import row (one person) becomes up to two dashboard flights: an arrival and a departure.

const path = require('path');

const IMPORT_TAB = 'Import';
const CACHE_MS = 60 * 1000;
const IST_OFFSET = '+05:30';
const PAST_FINAL_MS = 3 * 60 * 60 * 1000; // no live status here: a flight this far in the past is treated as done

const HEADERS = {
  name: /^name$/,
  arrFlight: /^arrival flight/, arrDate: /^arrival date/, arrTime: /^arrival time/, arrTerm: /^arrival termin/,
  depFlight: /^departure flight/, depDate: /^departure date/, depTime: /^departure time/, depTerm: /^departure termin/
};

const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** "BA0130" / "EK 569" / "EK-566" -> "BA130" / "EK569" / "EK566"; null when it does not look like a flight number. */
function normFlight(s) {
  const t = text(s).toUpperCase().replace(/[\s-]/g, '');
  const m = t.match(/^([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])0*([0-9]{1,4}[A-Z]?)$/);
  return m ? m[1] + m[2] : null;
}

/** "2026-10-25" + "04:50" (IST) -> epoch ms, or null. Also accepts a Sheets serial date/fraction. */
function istMs(date, time) {
  let d = text(date), t = text(time);
  if (/^\d+(\.\d+)?$/.test(d)) d = new Date(Math.round((Number(d) - 25569) * 86400000)).toISOString().slice(0, 10);
  if (/^0?\.\d+$/.test(t)) { const m = Math.round(Number(t) * 1440); t = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  const dm = d.match(/^(\d{4})-(\d{2})-(\d{2})$/), tm = t.match(/^(\d{1,2}):(\d{2})/);
  if (!dm || !tm) return null;
  const ms = Date.parse(dm[0] + 'T' + tm[1].padStart(2, '0') + ':' + tm[2] + ':00' + IST_OFFSET);
  return Number.isFinite(ms) ? ms : null;
}

/** Pure: Import tab values (header row first) -> {flights, errors} in the dashboard's flight shape. */
function mapImportRows(rows, nowMs, homeAirport) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) return { flights: [], errors: ['Import tab is empty'] };
  const hdr = rows[0].map((h) => text(h).toLowerCase());
  const col = {};
  Object.keys(HEADERS).forEach((k) => { col[k] = hdr.findIndex((h) => HEADERS[k].test(h)); });
  const missing = Object.keys(col).filter((k) => col[k] < 0);
  if (missing.length) errors.push('Import tab is missing columns: ' + missing.join(', '));
  if (col.name < 0) return { flights: [], errors };

  const get = (row, i) => (i >= 0 ? row[i] : '');
  const flights = [];
  rows.slice(1).forEach((row, n) => {
    const name = text(get(row, col.name));
    if (!name) return;
    [['ARR', 'arr'], ['DEP', 'dep']].forEach(([dir, p]) => {
      const raw = text(get(row, col[p + 'Flight']));
      if (!raw) return;
      const flight = normFlight(raw), schedAt = istMs(get(row, col[p + 'Date']), get(row, col[p + 'Time']));
      if (schedAt == null) errors.push('Row ' + (n + 2) + ' (' + name + '): ' + dir.toLowerCase() + ' date/time unreadable');
      flights.push({
        id: 'R' + (n + 2) + '-' + dir, name, dir, active: true,
        final: schedAt != null && nowMs - schedAt > PAST_FINAL_MS,
        flight: flight || raw, invalid: !flight, airport: homeAirport,
        terminal: text(get(row, col[p + 'Term'])).toUpperCase(), gate: '',
        status: 'SCHEDULED', schedAt, etaAt: null, etaSource: 'Import tab (schedule only)',
        groupId: '', pickupDisp: '', lastCheckDisp: '', lastError: ''
      });
    });
  });
  return { flights, errors };
}

/** Reads the Import tab through local-assistant's config and token; caches for a minute. */
function createImportSource(opts) {
  const o = opts || {};
  const { loadConfig } = require('../local-assistant/src/config');
  const { createGoogle } = require('../local-assistant/src/google');
  const { makeRedactor } = require('../local-assistant/src/redact');
  const { config } = loadConfig(o.envFile);
  const redact = makeRedactor([config.google.clientSecret, config.tgToken, config.llm.apiKey]);
  const google = createGoogle({ clientId: config.google.clientId, clientSecret: config.google.clientSecret,
    tokenFile: path.join(config.stateDir, 'google-token.json'), fetch: o.fetch || fetch, redact });
  const home = o.homeAirport || 'BLR';
  let cache = null;

  return async function getDashboardData() {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) return cache.data;
    if (!config.spreadsheetId) throw new Error('GOOGLE_SPREADSHEET_ID is not set in local-assistant/.env.local-assistant');
    const r = await google.readRange(config.spreadsheetId, IMPORT_TAB);
    if (r.missing) throw new Error('The spreadsheet has no tab named "' + IMPORT_TAB + '"');
    const m = mapImportRows(r.rows, now, home);
    const data = {
      generatedAt: now, preview: false, source: 'Google Sheets · ' + IMPORT_TAB + ' tab', homeAirport: home, maxSeats: 4,
      attribution: 'Schedules from the "' + IMPORT_TAB + '" tab. No live flight status in the local preview.',
      flights: m.flights, groups: [], log: [], tickTriggers: null, usage: null,
      usageError: 'Not available in the local preview (Apps Script only).', errors: m.errors, assistant: { enabled: false }
    };
    cache = { at: now, data };
    return data;
  };
}

module.exports = { mapImportRows, createImportSource, normFlight, istMs };
