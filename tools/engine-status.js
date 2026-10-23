'use strict';
// What the tracking engine knows about its providers, for the dashboard's API Usage page, budget card and
// activity feed. Read from Supabase's tracker_state table, which only the SERVICE ROLE key can read (RLS on,
// no policies), so this runs on the server only: it needs .env.engine (or the same environment variables).
// The AeroDataBox budget is computed by the engine's own code (src/AdbClient.js via engine/core.js), so the
// page shows exactly what the engine enforces.

const path = require('path');
const { createCore } = require('../engine/core');
const { createStore } = require('../engine/supabase-store');
const { readEnv, makeClient, REQUEST_LOG, EVENT_LOG, POSITIONS } = require('../engine/run');
const { readMarks } = require('./pickups');

const ENV_FILE = path.join(__dirname, '..', '.env.engine');
const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

/**
 * Pure (given a state map): -> {usage, usageError, apiRequests, log, providers}.
 * configRows: the config table as [[Key, Value], ...] (what mergeConfig_ reads); secretsSet: {OPENSKY_CLIENT_ID: bool, ...}.
 */
function summarize(stateMap, configRows, nowMs, secretsSet) {
  const view = { get: (k) => (stateMap.has(k) ? stateMap.get(k) : null), set: () => {}, del: () => {} }; // read-only
  const core = createCore(view, { config: configRows || [] }, { now: () => nowMs, log: () => {} });
  let positions = {};
  try { positions = JSON.parse(stateMap.get(POSITIONS) || '{}') || {}; } catch (e) { positions = {}; }
  const out = { usage: null, usageError: '', apiRequests: [], log: [], providers: {}, pickupsDone: readMarks(stateMap), positions };
  try {
    const u = core.usageSummary();
    out.usage = { window: u.window, units: u.units, unitLimit: u.unitLimit, requests: u.requests, requestLimit: u.requestLimit,
      suspended: u.suspended ? String(u.suspended.reason || 'suspended') : '' };
  } catch (e) {
    out.usageError = 'AeroDataBox usage could not be read: ' + ((e && e.message) || e);
  }
  if (!stateMap.has('prop:ADB_USAGE_V1') && !out.usageError) out.usage.note = 'no AeroDataBox request counted yet';
  out.apiRequests = parseList(stateMap.get(REQUEST_LOG));
  out.log = parseList(stateMap.get(EVENT_LOG)).map((e) => ({ at: e.at, level: e.level, flight: e.flight || '', message: e.msg || e.message || '' }));
  const last = (p) => out.apiRequests.slice().reverse().find((r) => r.provider === p);
  const lastOk = (p) => out.apiRequests.slice().reverse().find((r) => r.provider === p && r.status === 'OK');
  const fails = Number(stateMap.get('prop:OPENSKY_FAILS')) || 0;
  const os = last('OpenSky');
  out.providers.opensky = { fails, account: !!(secretsSet && secretsSet.OPENSKY_CLIENT_ID && secretsSet.OPENSKY_CLIENT_SECRET),
    lastAt: os ? os.at : null, lastStatus: os ? os.status : '', lastOkAt: (lastOk('OpenSky') || {}).at || null };
  // Live positions: adsb.lol first, OpenSky as the fallback (engine/positions.js). fails counts runs where both failed.
  const ad = last('adsb.lol');
  out.providers.positions = { fails, lastAt: ad ? ad.at : null, lastStatus: ad ? ad.status : '', lastOkAt: (lastOk('adsb.lol') || {}).at || null,
    tracked: Object.keys(positions).length };
  let tg = null;
  try { tg = core.ctx.tgDeliverySummary_(parseList(stateMap.get('TG_DELIVERIES')), nowMs); } catch (e) { tg = null; }
  const t = last('Telegram');
  out.providers.telegram = Object.assign({ lastAt: t ? t.at : null, lastStatus: t ? t.status : '' }, tg ? {
    sent24h: tg.sent, failed24h: tg.failed, unconfirmed24h: tg.unconfirmed, pending: tg.pending, lastProblem: tg.lastProblem ? String(tg.lastProblem.error || tg.lastProblem.state || '') : '' } : {});
  return out;
}

/**
 * -> async read(configRows) -> summarize(...) | {usageError} when this server has no service-role key.
 * opts.client / opts.env for tests.
 */
function createEngineStatus(opts) {
  const o = opts || {};
  const env = o.env || readEnv(process.env, o.envFile || ENV_FILE);
  if (!o.client && (!env.supabaseUrl || !env.serviceKey)) {
    return async () => ({ usage: null, apiRequests: [], log: [], providers: {},
      usageError: 'Usage is read with the engine\'s service-role key: add .env.engine on this server (see engine/README.md).' });
  }
  const client = o.client || makeClient(env);
  const secretsSet = {};
  Object.keys(env.secrets || {}).forEach((k) => { secretsSet[k] = !!env.secrets[k]; });
  return async function read(configRows) {
    let map;
    try { map = await createStore(client).loadState(); } catch (e) {
      return { usage: null, apiRequests: [], log: [], providers: {}, usageError: String((e && e.message) || e) };
    }
    return summarize(map, configRows, (o.now || Date.now)(), secretsSet);
  };
}

module.exports = { createEngineStatus, summarize };
