#!/usr/bin/env node
'use strict';
// One tracker run against Supabase: take the lease lock, load Flights / groups / config / tracker_state, run
// the unchanged decision code (core.js), then persist: changed Flights columns, the cab plan, the engine
// state, and the heartbeat in the status table. Used by api/cron.js (Vercel) and from the command line:
//   node engine/run.js                 one real run (needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADB_KEY, ...)
//   node engine/run.js --dry-run       reads and calls the APIs, writes NOTHING to Supabase; prints what it would write
//   node engine/run.js --scheduled     a run started by a scheduler (the VM's cron): the heartbeat reports the trigger installed
//   node engine/run.js --usage         prints the AeroDataBox usage the engine has counted
//   node engine/run.js --set-usage <units> <requests> [--allow-lower]
//                                      copies the RapidAPI dashboard figures in (do this once when moving off Apps Script)
// Environment: process.env, plus .env.engine at the repository root if present (git-ignored).

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createCore } = require('./core');
const { createStore } = require('./supabase-store');
const { parseEnv } = require('../local-assistant/src/config');

const SECRET_KEYS = ['ADB_KEY', 'TG_BOT_TOKEN', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'FA_KEY'];
const REQUEST_LOG = 'REQUEST_LOG', EVENT_LOG = 'EVENT_LOG';
const REQUEST_LOG_MAX = 200, EVENT_LOG_MAX = 200;

const POSITIONS = 'POSITIONS';
const POSITION_MAX_AGE_MS = 6 * 3600 * 1000; // = tools/flight-position.js maxAgeMin: older positions are not plotted

/** Latest live position per Flights row, for the dashboard map. Kept 6 h; rows that no longer exist are dropped. */
function savePositions(state, fresh, ids, nowMs) {
  let all;
  try { all = JSON.parse(state.get(POSITIONS) || '{}'); } catch (e) { all = {}; }
  if (!all || typeof all !== 'object') all = {};
  const before = JSON.stringify(all), keep = new Set(ids);
  Object.assign(all, fresh || {});
  Object.keys(all).forEach((id) => { if (!keep.has(id) || !(nowMs - (all[id] && all[id].fixAt || 0) <= POSITION_MAX_AGE_MS)) delete all[id]; });
  if (JSON.stringify(all) !== before) state.set(POSITIONS, JSON.stringify(all));
}

/** Adds this run's entries to a JSON list in tracker_state, keeping the newest max and nothing older than maxAgeMs. */
function appendLog(state, key, entries, max, maxAgeMs, nowMs) {
  if (!entries || !entries.length) return;
  let list;
  try { list = JSON.parse(state.get(key) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  state.set(key, JSON.stringify(list.concat(entries).filter((x) => x && nowMs - (x.at || 0) <= maxAgeMs).slice(-max)));
}
const ENV_FILE = path.join(__dirname, '..', '.env.engine');

/** process.env wins over .env.engine. -> {supabaseUrl, serviceKey, secrets} */
function readEnv(env, file) {
  const fromFile = file && fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  const get = (k) => String((env[k] != null && env[k] !== '' ? env[k] : fromFile[k]) || '').trim();
  const secrets = {};
  SECRET_KEYS.forEach((k) => { if (get(k)) secrets[k] = get(k); });
  return { supabaseUrl: get('SUPABASE_URL'), serviceKey: get('SUPABASE_SERVICE_ROLE_KEY'), secrets };
}

function makeClient(e) {
  if (!e.supabaseUrl || !e.serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (Vercel project env vars, or .env.engine locally)');
  return createClient(e.supabaseUrl, e.serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

/**
 * opts: {client, secrets, extraRedact, now, scheduled, dryRun, fetchSync, sleep, log, action: 'tick'|'usage'|'set-usage', usageArgs}
 * -> {ok, locked?, summary?, error?, writes, notes, log}
 */
async function runTracker(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const t0 = now();
  const log = o.log || ((l) => console.log(l));
  const store = createStore(o.client);
  const action = o.action || 'tick';
  const writes = { flights: null, groups: null, state: null, heartbeat: false };
  const notes = [];

  const runId = o.dryRun ? 'dry-run' : await store.acquireLock(t0);
  if (!runId) return { ok: true, locked: true, writes, notes: ['another run holds the lock; skipped'] };
  try {
    const stateMap = await store.loadState();
    const state = store.stateView(stateMap);
    const data = { flights: [], groups: [], config: [] };
    const trigger = o.scheduled ? true : null;
    const core = createCore(state, data, { secrets: o.secrets || {}, extraRedact: o.extraRedact, fetchSync: o.fetchSync, sleep: o.sleep,
      now, triggerInstalled: trigger, log });
    const [flights, groups, config] = await Promise.all([store.loadFlights(core), store.loadGroups(core), store.loadConfig()]);
    data.flights = flights.rows; data.groups = groups.rows; data.config = config.rows;
    notes.push(...config.notes);
    if (!groups.exists) notes.push('no groups table: the cab plan is computed but not stored');
    if (flights.skipped.length) notes.push(flights.skipped.length + ' Flights row(s) without an ID were skipped (rows ' + flights.skipped.join(', ') + ')');

    if (action === 'usage') return { ok: true, usage: core.usageSummary(), writes, notes };
    if (action === 'set-usage') {
      const [units, requests, allowLower] = o.usageArgs || [];
      core.setUsage(units, requests, allowLower);
      if (!o.dryRun) writes.state = await store.saveState(state);
      return { ok: true, usage: core.usageSummary(), writes, notes };
    }

    const res = core.tick(t0, {});
    if (core.output.configIssues.length) notes.push(...core.output.configIssues.map((i) => 'config ' + i.key + ': ' + i.message));
    if (o.dryRun) {
      writes.flights = { wouldUpdate: (core.output.flights || []).length };
      return Object.assign({ ok: !res.error, dryRun: true, writes, notes, log: core.output.log, googleTouches: core.googleTouches }, res);
    }
    // The dashboard's API Usage page and activity feed read these back (tools/engine-status.js).
    const retentionMs = Math.min(Number(core.ctx.cfg().ADB_RETENTION_HOURS) || 0, 168) * 3600 * 1000;
    appendLog(state, REQUEST_LOG, core.output.requests, REQUEST_LOG_MAX, 7 * 24 * 3600 * 1000, t0);
    appendLog(state, EVENT_LOG, core.output.log, EVENT_LOG_MAX, retentionMs, t0); // lines can carry provider status text
    savePositions(state, core.output.positions, flights.rows.map((r) => r.id), t0);
    // Persist in the order that matters most: usage accounting first (money), then data, then heartbeat.
    writes.state = await store.saveState(state);
    let persistError = null;
    try {
      if (core.output.flights) writes.flights = await store.saveFlights(core, flights, core.output.flights);
      writes.groups = await store.saveGroups(core, groups, core.output.groups);
    } catch (e) { persistError = (e && e.message) || String(e); }
    let hb = core.output.heartbeat;
    if (persistError) hb = core.ctx.heartbeatRows_(t0, null, 'saving to Supabase failed: ' + persistError, trigger);
    if (hb && trigger == null) { // a manual run keeps whatever the scheduler last reported
      const prev = await store.readStatusValue('TRIGGER_INSTALLED');
      hb = hb.map((r) => (r[0] === 'TRIGGER_INSTALLED' ? [r[0], prev == null ? '' : prev, r[2]] : r));
    }
    if (hb) { await store.saveHeartbeat(hb); writes.heartbeat = true; }
    const error = res.error || persistError;
    return Object.assign({ ok: !error, writes, notes, log: core.output.log, googleTouches: core.googleTouches, ms: now() - t0 }, res, error ? { error } : {});
  } finally {
    if (!o.dryRun) await store.releaseLock(runId).catch(() => {});
  }
}

async function main(argv) {
  const e = readEnv(process.env, ENV_FILE);
  const client = makeClient(e);
  const has = (f) => argv.includes(f);
  const action = has('--usage') ? 'usage' : has('--set-usage') ? 'set-usage' : 'tick';
  let usageArgs;
  if (action === 'set-usage') {
    const i = argv.indexOf('--set-usage'), units = Number(argv[i + 1]), requests = Number(argv[i + 2]);
    if (!Number.isInteger(units) || !Number.isInteger(requests)) throw new Error('usage: --set-usage <units> <requests> [--allow-lower]');
    usageArgs = [units, requests, has('--allow-lower')];
  }
  const r = await runTracker({ client, secrets: e.secrets, extraRedact: [e.serviceKey], dryRun: has('--dry-run'), scheduled: has('--scheduled'), action, usageArgs });
  const shown = Object.assign({}, r);
  delete shown.log;
  console.log(JSON.stringify(shown, null, 2));
  if (!r.ok) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => { console.error('Fatal: ' + ((err && err.message) || err)); process.exitCode = 1; });
}

module.exports = { runTracker, readEnv, makeClient, appendLog, savePositions, SECRET_KEYS, REQUEST_LOG, EVENT_LOG, POSITIONS };
