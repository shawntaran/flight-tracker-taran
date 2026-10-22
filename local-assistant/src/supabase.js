'use strict';
// Read-only Supabase access with the project's anon (publishable) key. The only query is
// from(<table>).select('*'). Supabase returns row objects; toRows() turns them into exactly what the old
// Google Sheets reader returned (header row first, then one value array per row), so snapshot.js,
// tools/sheet-source.js and tools/import-source.js read them unchanged, by header name.

const { createClient } = require('@supabase/supabase-js');

// Old sheet tab -> Supabase table. Only `flights` exists so far; the Import tab's columns were imported
// into it too, so both read it and the column names decide which mapper finds its data. A table that
// does not exist yet reads as {missing: true}, exactly like a missing tab did.
const TABLES = { Flights: 'flights', Import: 'flights', Groups: 'groups', Config: 'config', Status: 'status' };
const KV_TABS = { Config: 1, Status: 1 }; // read positionally (Key, Value, Notes) by the mappers
const TIMEOUT_MS = 20000;

// Every sheet header (src/Sheet.js COLS and GROUP_HEADERS, the Status/Config tabs). A column whose name
// matches one after squashing (flight_normalised, "Flight (normalised)", m_sched_arr, "m:schedArr") is
// renamed to the sheet header, so a snake_cased import still reads. Private columns (Phone, Email, ...)
// are named too, for the same shape; the mappers' allowlists still never read them.
const KNOWN_HEADERS = ['ID', 'Name', 'Phone', 'Email', 'Telegram Chat ID', 'Direction', 'Flight', 'Sched Dep (IST)', 'Sched Arr (IST)',
  'Airport', 'Terminal', 'First Leg Flight', 'Active', 'Notes', 'Flight (normalised)', 'Status', 'ETA / Dep (IST)', 'ETA Source',
  'Terminal (live)', 'Gate', 'Cab Group', 'Pickup (IST)', 'Last Check (IST)', 'Last Error', 'm:schedDep', 'm:schedArr', 'm:revDep',
  'm:adbEta', 'm:eta', 'm:lastFix', 'm:nextCheck', 'm:alertedEta', 'm:notifiedPickup', 'm:callsign', 'm:icao24', 'm:depLocalDate',
  'm:adbCalls', 'm:failCount', 'm:alertedStatus', 'm:flags', 'm:groupSig', 'm:stateKey', 'm:providerFetchedAt', 'Group', 'Members', 'Flights / times', 'Count', 'Vehicle', 'Driver', 'Driver Telegram Chat ID',
  'Member IDs', 'Key', 'Value'];
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const BY_SQUASHED = {};
KNOWN_HEADERS.forEach((h) => { BY_SQUASHED[squash(h)] = h; });

/** Column name -> the sheet header readers expect. Unknown snake_case keeps its words ("arrival_date" -> "arrival date"). */
function headerFor(col) {
  const s = String(col);
  return BY_SQUASHED[squash(s)] || (/_/.test(s) && !/\s/.test(s) ? s.replace(/_+/g, ' ') : s);
}

/**
 * One cell, as Sheets would have handed it over. null -> ''. A timestamp WITHOUT a zone (Postgres
 * "timestamp") is UTC for machine columns (m:*, written as UTC ISO strings) and IST wall time for the
 * coordinator columns, which parseTime reads from "YYYY-MM-DD HH:MM".
 */
function cell(header, v) {
  if (v == null) return '';
  if (typeof v !== 'string') return v;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/);
  if (!m) return v;
  return /^m:/.test(header) ? m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z' : m[1] + ' ' + m[2];
}

/** Pure: Supabase row objects -> [header row, ...value rows], the Sheets values.get shape. */
function toRows(objects, tab) {
  if (!Array.isArray(objects) || !objects.length) return [];
  const cols = [];
  objects.forEach((o) => Object.keys(o || {}).forEach((k) => { if (cols.indexOf(k) < 0) cols.push(k); }));
  let headers = cols.map(headerFor);
  let pick = cols;
  if (KV_TABS[tab]) { // Key/Value/Notes must be columns 0/1/2 whatever the table's column order
    pick = ['Key', 'Value', 'Notes'].map((h) => cols[headers.indexOf(h)]);
    headers = ['Key', 'Value', 'Notes'];
  }
  return [headers].concat(objects.map((o) => pick.map((k, i) => (k == null ? '' : cell(headers[i], o[k])))));
}

/** PostgREST error -> what to do. Supabase error bodies hold no credentials. */
function supabaseReason(e) {
  const t = [e && e.code, e && e.message, e && e.hint].filter(Boolean).join(' ');
  if (/invalid api key|jwt|401|No API key/i.test(t)) return '(check SUPABASE_ANON_KEY: it must be the project\'s anon / publishable key)';
  if (/permission denied/i.test(t)) return '(the anon role may not read this table: grant SELECT, or add a row-level-security SELECT policy for anon)';
  return t ? '(' + t.slice(0, 160) + ')' : '';
}
const isMissingTable = (e) => !!e && (e.code === 'PGRST205' || e.code === '42P01' || /Could not find the table|does not exist/i.test(e.message || ''));

/**
 * A table imported from a sheet tab keeps the tab's case ("Flights"), and Postgres names are
 * case-sensitive. PostgREST's hint "Perhaps you meant the table 'public.Flights'" names it; only a
 * name that differs from ours in letter case alone is taken.
 */
function sameNameOtherCase(e, table) {
  const m = String((e && e.hint) || '').match(/Perhaps you meant the table '(?:[^'.]+\.)?([^'.]+)'/);
  return m && m[1] !== table && m[1].toLowerCase() === table.toLowerCase() ? m[1] : null;
}

/**
 * opts: {url, anonKey, redact, client} (client: a ready Supabase client, for tests).
 * -> {readRange(tab)}: {rows} | {missing: true} | throws, the contract the Sheets reader had.
 */
function createSupabase({ url, anonKey, redact, client }) {
  const r = redact || ((s) => String(s));
  const actualName = {}; // our table name -> the case the project really uses, once a hint has told us
  let sb = client || null;
  const db = () => {
    if (sb) return sb;
    if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in local-assistant/.env.local-assistant');
    sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    return sb;
  };

  async function readRange(tab) {
    const wanted = TABLES[tab] || String(tab).toLowerCase();
    let table = actualName[wanted] || wanted;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      let { data, error } = await db().from(table).select('*').abortSignal(ctl.signal);
      const other = isMissingTable(error) && sameNameOtherCase(error, table);
      if (other) {
        table = actualName[wanted] = other;
        ({ data, error } = await db().from(table).select('*').abortSignal(ctl.signal));
      }
      if (error) {
        if (isMissingTable(error)) return { missing: true };
        if (ctl.signal.aborted || /abort/i.test(error.message || '')) throw new Error('Supabase read of "' + table + '" timed out');
        throw new Error('Supabase read of "' + table + '" failed ' + supabaseReason(error));
      }
      return { rows: toRows(data, tab) };
    } catch (e) {
      throw new Error(r(e && e.name === 'AbortError' ? 'Supabase read of "' + table + '" timed out' : (e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  }

  return { readRange };
}

module.exports = { createSupabase, toRows, headerFor, TABLES };
