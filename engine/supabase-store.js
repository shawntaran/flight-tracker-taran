'use strict';
// Supabase I/O for the tracking engine, with the SERVICE ROLE key (server side only: Vercel env vars, never
// the browser). Tables, all imported from the old sheet tabs with the sheet headers as column names:
//   Flights        one row per person and direction; the engine UPDATEs only its own columns (Sheet.js COLS
//                  kind 'out' and 'm'), only the ones that changed, matched by "ID"
//   groups         the cab plan (Sheet.js GROUP_HEADERS); replaced when it changes
//   config         Key / Value settings (blank = default)
//   status         Key / Value / Notes heartbeat rows (LAST_TICK_AT, LAST_TICK_RESULT, ...)
//   tracker_state  key / value / expires_at: AeroDataBox usage accounting, caches, Telegram delivery
//                  tracking, the run lock. Created by engine/schema.sql.
// A table name is matched like local-assistant/src/supabase.js: "flights" also finds "Flights".

const { sameNameOtherCase } = require('../local-assistant/src/supabase');

const TABLES = { flights: 'flights', groups: 'groups', config: 'config', status: 'status', state: 'tracker_state' };
const LOCK_KEY = 'LOCK_TICK';
const LOCK_MS = 4 * 60 * 1000; // a run that dies keeps the lock at most this long (the cron runs every 5 min)
const PAGE = 1000;             // PostgREST's default row limit

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = (v) => v == null || v === '';

function createStore(client) {
  const actual = {};

  /** Runs build(tableName); on "no such table" with a same-name-other-case hint, retries with that name. */
  async function onTable(t, build) {
    const name = actual[t] || TABLES[t];
    let r = await build(name);
    const other = r.error && (r.error.code === 'PGRST205' || r.error.code === '42P01') && sameNameOtherCase(r.error, name);
    if (other) { actual[t] = other; r = await build(other); }
    return r;
  }
  const fail = (what, e) => new Error(what + ' failed: ' + [e.code, e.message, e.hint].filter(Boolean).join(' ').slice(0, 240));
  const missing = (e) => !!e && (e.code === 'PGRST205' || e.code === '42P01');

  async function selectAll(t) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await onTable(t, (n) => client.from(n).select('*').range(from, from + PAGE - 1));
      if (error) return { error };
      out.push(...data);
      if (data.length < PAGE) return { data: out };
    }
  }

  /** Column for each wanted header: exact name first, then the same name squashed (snake_case imports). */
  function columnMap(rows, headers) {
    const cols = [];
    rows.forEach((r) => Object.keys(r).forEach((k) => { if (cols.indexOf(k) < 0) cols.push(k); }));
    const map = {};
    headers.forEach((h) => { map[h] = cols.indexOf(h) >= 0 ? h : cols.find((c) => squash(c) === squash(h)) || null; });
    return map;
  }

  // ------------------------------------------------------------------ flights
  /**
   * -> {rows, colMap, skipped}. rows are keyed by COLS k and parsed exactly as Sheet.js readFlights does
   * (time columns -> ms, text trimmed); each keeps _db (the stored values) to write only what changed.
   */
  async function loadFlights(core) {
    const { COLS, toMs } = core.ctx;
    const r = await selectAll('flights');
    if (r.error) throw fail('Reading the Flights table', r.error);
    const colMap = columnMap(r.data, COLS.map((c) => c.h));
    const lacking = COLS.filter((c) => c.kind !== 'in' && !colMap[c.h]).map((c) => c.h);
    if (!colMap.ID) lacking.unshift('ID');
    if (lacking.length) {
      throw new Error('The Flights table lacks columns the engine writes: ' + lacking.join(', ') + '. Add them as text columns ' +
        '(e.g. alter table public."Flights" add column "' + lacking[0] + '" text;)');
    }
    const rows = [], skipped = [];
    r.data.forEach((db, i) => {
      const row = {};
      COLS.forEach((c) => {
        let x = colMap[c.h] ? db[colMap[c.h]] : '';
        if (x == null) x = '';
        if (c.time) x = toMs(x);
        else if (typeof x === 'string') x = x.trim();
        row[c.k] = x;
      });
      if (!row.flightRaw && !row.id) return;                     // blank row, as readFlights
      if (!row.id) { skipped.push(i + 2); return; }              // without an ID a row cannot be updated
      Object.defineProperty(row, '_db', { value: db, enumerable: false });
      rows.push(row);
    });
    return { rows, colMap, skipped };
  }

  /** Same value as stored? Blank and null are equal; times compare as instants; numbers as numbers. */
  function same(c, stored, next, toMs) {
    if (blank(stored) && blank(next)) return true;
    if (blank(stored) || blank(next)) return false;
    if (c.time) return toMs(stored) === toMs(next);
    if (typeof stored === 'number' || typeof next === 'number') return Number(stored) === Number(next);
    return String(stored) === String(next);
  }

  /** The engine's columns that changed, per row -> UPDATE ... WHERE "ID" = id. -> {updated, unchanged, missing: [ids]} */
  async function saveFlights(core, loaded, outRows) {
    const { COLS, isoOrBlank, toMs } = core.ctx;
    const byId = {};
    loaded.rows.forEach((r) => { byId[r.id] = r; });
    const res = { updated: 0, unchanged: 0, missing: [] };
    for (const r of outRows || []) {
      const before = byId[r.id];
      if (!before) continue;
      const patch = {};
      COLS.forEach((c) => {
        if (c.kind === 'in' || !loaded.colMap[c.h]) return;
        let v = r[c.k];
        if (c.time) v = isoOrBlank(v);
        if (v === '' || v == null) v = null;
        if (!same(c, before._db[loaded.colMap[c.h]], v, toMs)) patch[loaded.colMap[c.h]] = v;
      });
      if (!Object.keys(patch).length) { res.unchanged++; continue; }
      const { data, error } = await onTable('flights', (n) => client.from(n).update(patch).eq(loaded.colMap.ID, r.id).select(loaded.colMap.ID));
      if (error) throw fail('Updating flight ' + r.id, error);
      if (!data || !data.length) res.missing.push(r.id); // deleted while the run was in progress
      else res.updated++;
    }
    return res;
  }

  // ------------------------------------------------------------------ groups, config, status
  async function loadGroups(core) {
    const H = core.ctx.GROUP_HEADERS;
    const r = await selectAll('groups');
    if (r.error) { if (missing(r.error)) return { rows: [], exists: false }; throw fail('Reading the groups table', r.error); }
    const map = columnMap(r.data, H);
    return { exists: true, map, rows: r.data.map((g) => H.map((h) => (map[h] && g[map[h]] != null ? g[map[h]] : ''))) };
  }

  /** Replaces the cab plan when it changed. Delete-then-insert: the table has no known unique key. */
  async function saveGroups(core, loaded, outRows) {
    if (!loaded.exists || !outRows) return { written: false };
    const norm = (rows) => JSON.stringify(rows.map((v) => v.map((x) => (x == null ? '' : String(x)))));
    if (norm(outRows) === norm(loaded.rows)) return { written: false };
    const H = core.ctx.GROUP_HEADERS, gcol = loaded.map.Group || 'Group';
    const old = loaded.rows.map((v) => v[0]).filter((x) => !blank(x));
    if (old.length) {
      const { error } = await onTable('groups', (n) => client.from(n).delete().in(gcol, old));
      if (error) throw fail('Clearing the groups table', error);
    }
    if (outRows.length) {
      const objs = outRows.map((v) => { const o = {}; H.forEach((h, i) => { if (loaded.map[h] || !loaded.rows.length) o[loaded.map[h] || h] = v[i] === '' ? null : v[i]; }); return o; });
      const { error } = await onTable('groups', (n) => client.from(n).insert(objs));
      if (error) throw fail('Writing the groups table', error);
    }
    return { written: true, count: outRows.length };
  }

  /** -> [[key, value]] for mergeConfig_. An imported blank cell can arrive as null or the text "null": both mean blank. */
  async function loadConfig() {
    const r = await selectAll('config');
    if (r.error) { if (missing(r.error)) return { rows: [], notes: ['no config table: defaults used'] }; throw fail('Reading the config table', r.error); }
    const notes = [];
    const rows = r.data.map((x) => {
      const k = x.Key != null ? x.Key : x.key, v = x.Value !== undefined ? x.Value : x.value;
      if (typeof v === 'string' && v.trim().toLowerCase() === 'null') { notes.push(k + ' holds the text "null"; read as blank (default)'); return [k, '']; }
      return [k, v == null ? '' : v];
    });
    return { rows, notes };
  }

  /** Heartbeat rows ([['Key','Value','Notes'], ...]) -> UPDATE by Key, INSERT the ones not there yet. */
  async function saveHeartbeat(rows) {
    for (const [k, v, note] of rows.slice(1)) {
      const { data, error } = await onTable('status', (n) => client.from(n).update({ Value: v === '' ? null : v }).eq('Key', k).select('Key'));
      if (error) throw fail('Writing the status table (' + k + ')', error);
      if (!data || !data.length) {
        const ins = await onTable('status', (n) => client.from(n).insert({ Key: k, Value: v === '' ? null : v, Notes: note || null }));
        if (ins.error) throw fail('Adding ' + k + ' to the status table', ins.error);
      }
    }
  }

  async function readStatusValue(key) {
    const { data, error } = await onTable('status', (n) => client.from(n).select('Value').eq('Key', key));
    return !error && data && data[0] ? data[0].Value : null;
  }

  // ------------------------------------------------------------------ tracker_state
  async function loadState() {
    const r = await selectAll('state');
    if (r.error) {
      if (missing(r.error)) throw new Error('The tracker_state table does not exist: run engine/schema.sql once in the Supabase SQL editor');
      throw fail('Reading tracker_state', r.error);
    }
    const map = new Map();
    r.data.forEach((x) => { if (x.key !== LOCK_KEY) map.set(x.key, x.value); });
    return map;
  }

  /** A key/value view that records what changed, for saveState. */
  function stateView(map) {
    const dirty = new Set(), removed = new Set();
    return {
      get: (k) => (map.has(k) ? map.get(k) : null),
      set: (k, v) => { map.set(k, String(v)); dirty.add(k); removed.delete(k); },
      del: (k) => { if (map.delete(k)) { removed.add(k); dirty.delete(k); } },
      changes: () => ({ upsert: [...dirty].map((k) => ({ key: k, value: map.get(k), updated_at: new Date().toISOString() })), remove: [...removed] }),
      saved: () => { dirty.clear(); removed.clear(); } // after a successful saveState: the next one writes only new changes
    };
  }

  async function saveState(view) {
    const ch = view.changes();
    if (ch.upsert.length) {
      const { error } = await onTable('state', (n) => client.from(n).upsert(ch.upsert, { onConflict: 'key' }));
      if (error) throw fail('Saving tracker_state', error);
    }
    if (ch.remove.length) {
      const { error } = await onTable('state', (n) => client.from(n).delete().in('key', ch.remove));
      if (error) throw fail('Cleaning tracker_state', error);
    }
    if (typeof view.saved === 'function') view.saved();
    return { saved: ch.upsert.length, removed: ch.remove.length };
  }

  /** Lease lock: INSERT fails while another run holds it; an expired lease is taken over. -> runId | null */
  async function acquireLock(nowMs) {
    const runId = nowMs + '-' + Math.random().toString(36).slice(2, 10);
    const row = { key: LOCK_KEY, value: runId, expires_at: new Date(nowMs + LOCK_MS).toISOString(), updated_at: new Date(nowMs).toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      const ins = await onTable('state', (n) => client.from(n).insert(row));
      if (!ins.error) return runId;
      if (missing(ins.error)) throw new Error('The tracker_state table does not exist: run engine/schema.sql once in the Supabase SQL editor');
      if (ins.error.code !== '23505') throw fail('Taking the run lock', ins.error);
      const cur = await onTable('state', (n) => client.from(n).select('value,expires_at').eq('key', LOCK_KEY));
      const held = cur.data && cur.data[0];
      if (held && Date.parse(held.expires_at) > nowMs) return null;              // another run is active
      await onTable('state', (n) => client.from(n).delete().eq('key', LOCK_KEY).eq('value', held ? held.value : ''));
    }
    return null;
  }

  async function releaseLock(runId) {
    if (!runId) return;
    await onTable('state', (n) => client.from(n).delete().eq('key', LOCK_KEY).eq('value', runId));
  }

  return { loadFlights, saveFlights, loadGroups, saveGroups, loadConfig, saveHeartbeat, readStatusValue,
    loadState, stateView, saveState, acquireLock, releaseLock };
}

module.exports = { createStore, TABLES, LOCK_KEY };
