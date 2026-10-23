'use strict';
// The tracker's decision code, unchanged: src/Util.js, Config.js, Sheet.js (column schema and heartbeat
// rows), Providers.js, AdbClient.js, Grouping.js, Alerts.js and Tracker.js, the same files the Apps Script
// deployment and the test suite use. They run in an isolated vm context where:
//   - every Google service (SpreadsheetApp, ScriptApp, MailApp, ...) is ABSENT: touching one throws;
//   - the five plain-utility calls the logic makes are Node implementations: UrlFetchApp.fetch (worker-thread
//     fetch, see sync-fetch.js), PropertiesService / CacheService (an in-memory key/value map that run.js
//     loads from and saves to Supabase's tracker_state table), LockService (no-op in-process; run.js holds
//     a lease in tracker_state) and Utilities.sleep;
//   - every function that read or wrote a sheet is replaced by one working on the in-memory data below.
// Nothing here does database I/O: run.js loads the data before the tick and persists it afterwards.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fetchSync: realFetchSync, sleepSync } = require('./sync-fetch');
const { createAdsbLol, toTelemetry } = require('./positions');

const SRC = path.join(__dirname, '..', 'src');
const LOGIC_FILES = ['Util.js', 'Config.js', 'Sheet.js', 'Providers.js', 'AdbClient.js', 'Grouping.js', 'Alerts.js', 'Tracker.js'];
const GOOGLE_SERVICES = ['SpreadsheetApp', 'ScriptApp', 'MailApp', 'GmailApp', 'DriveApp', 'DocumentApp', 'HtmlService',
  'ContentService', 'Session', 'Browser', 'CalendarApp', 'FormApp', 'SlidesApp'];
const ENGINE_VERSION = 'node-engine 1';

/** UrlFetchApp options -> fetch request. payload object = form post (Apps Script's rule); string = raw body. */
function toRequest(url, o) {
  o = o || {};
  const headers = Object.assign({}, o.headers || {});
  let body;
  if (o.payload != null) {
    if (typeof o.payload === 'object') {
      body = new URLSearchParams(o.payload).toString();
      headers['Content-Type'] = o.contentType || 'application/x-www-form-urlencoded';
    } else {
      body = String(o.payload);
      headers['Content-Type'] = o.contentType || 'application/x-www-form-urlencoded';
    }
  }
  return { url, method: String(o.method || (o.payload != null ? 'post' : 'get')).toUpperCase(), headers, body };
}

const PROVIDERS = [['aerodatabox', 'AeroDataBox'], ['adsb.lol', 'adsb.lol'], ['auth.opensky-network.org', 'OpenSky (login)'], ['opensky-network.org', 'OpenSky'],
  ['flightaware.com', 'FlightAware'], ['api.telegram.org', 'Telegram']];

/**
 * Pure: a request URL -> {provider, endpoint, flight} for the API usage log. Never keeps the query string or
 * the Telegram token (it is part of the path: /bot<token>/sendMessage).
 */
function describeRequest(url) {
  let u;
  try { u = new URL(url); } catch (e) { return { provider: 'unknown', endpoint: '', flight: '' }; }
  const hit = PROVIDERS.find(([h]) => u.hostname.includes(h));
  let path = u.pathname, flight = '';
  if (/telegram/.test(u.hostname)) path = path.replace(/^\/bot[^/]+/, '');
  const adb = path.match(/^(\/flights\/number)\/([A-Z0-9]{2,8})(\/|$)/i);
  if (adb) { flight = adb[2].toUpperCase(); path = adb[1]; }
  const fa = path.match(/^(\/aeroapi\/flights)\/([^/]+)/);
  if (fa) { flight = decodeURIComponent(fa[2]).toUpperCase().slice(0, 10); path = fa[1]; }
  return { provider: hit ? hit[1] : u.hostname, endpoint: path.slice(0, 60), flight };
}

/**
 * state: {get(k) -> string|null, set(k, v), del(k)} over tracker_state (run.js).
 * data: {flights: [row objects keyed by COLS k], groups: [[...GROUP_HEADERS values]], config: [[key, value]]}
 * opts: {secrets: {ADB_KEY, TG_BOT_TOKEN, ...}, extraRedact: [], fetchSync, sleep, now, triggerInstalled, log}
 * -> {ctx, tick(now, opts), setUsage(units, requests, allowLower), usageSummary(), output, googleTouches}
 */
function createCore(state, data, opts) {
  const o = opts || {};
  const secrets = o.secrets || {};
  const fetchSync = o.fetchSync || realFetchSync;
  const sleep = o.sleep || sleepSync;
  const output = { flights: null, groups: null, heartbeat: null, log: [], usage: [], requests: [], positions: {}, configIssues: [] };
  const googleTouches = [];
  const print = o.log || ((line) => console.log(line));

  const sandbox = { console: { log: (...a) => print(a.join(' ')), error: (...a) => print('ERROR ' + a.join(' ')), warn: (...a) => print('WARN ' + a.join(' ')) } };
  GOOGLE_SERVICES.forEach((name) => Object.defineProperty(sandbox, name, {
    configurable: false, enumerable: false,
    get() { googleTouches.push(name); throw new Error('Google service ' + name + ' is not available in the Node tracking engine'); }
  }));

  // ---- the five utility services, as Node implementations
  sandbox.UrlFetchApp = {
    fetch(url, options) {
      const started = Date.now();
      const res = fetchSync(toRequest(url, options));
      output.requests.push(Object.assign(describeRequest(url), { at: now(), responseMs: Date.now() - started, units: 0,
        status: res.error ? (/timed out/i.test(res.error) ? 'TIMEOUT' : 'ERROR') : res.code >= 200 && res.code < 300 ? 'OK' : 'HTTP ' + res.code }));
      if (res.error) throw new Error('Request failed: ' + res.error); // never includes the URL (it may carry a token)
      if (res.code >= 400 && !(options && options.muteHttpExceptions)) throw new Error('Request failed with code ' + res.code);
      return { getResponseCode: () => res.code, getContentText: () => res.body, getHeaders: () => res.headers || {} };
    }
  };
  const props = {
    getProperty(k) {
      if (ctx.SECRET_NAMES && ctx.SECRET_NAMES[k]) return secrets[k] == null ? null : String(secrets[k]);
      return state.get('prop:' + k);
    },
    setProperty(k, v) {
      if (ctx.SECRET_NAMES && ctx.SECRET_NAMES[k]) throw new Error('secrets come from environment variables and are never written');
      state.set('prop:' + k, String(v));
      return props;
    },
    deleteProperty(k) { state.del('prop:' + k); return props; }
  };
  const now = o.now || (() => Date.now());
  const cache = {
    get(k) {
      const raw = state.get('cache:' + k);
      if (raw == null) return null;
      try { const e = JSON.parse(raw); if (e.exp && e.exp <= now()) { state.del('cache:' + k); return null; } return e.v; } catch (x) { return null; }
    },
    put(k, v, ttlSec) { state.set('cache:' + k, JSON.stringify({ v: String(v), exp: now() + Math.min(Number(ttlSec) || 600, 21600) * 1000 })); },
    remove(k) { state.del('cache:' + k); }
  };
  const lock = { tryLock: () => true, waitLock: () => {}, releaseLock: () => {}, hasLock: () => true };
  sandbox.PropertiesService = { getScriptProperties: () => props };
  sandbox.CacheService = { getScriptCache: () => cache };
  sandbox.LockService = { getScriptLock: () => lock, getDocumentLock: () => lock };
  sandbox.Utilities = { sleep: (ms) => sleep(ms) };

  const ctx = vm.createContext(sandbox);
  LOGIC_FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: 'src/' + f }));

  // ---- replacements for every sheet-bound function the tick reaches
  ctx.TRACKER_VERSION = ENGINE_VERSION + ' (logic ' + ctx.TRACKER_VERSION + ')';
  ctx.redactValues_ = Object.keys(secrets).map((k) => secrets[k]).concat(o.extraRedact || [])
    .filter((v) => v && String(v).trim().length >= 8).map((v) => String(v).trim());
  ctx.secret = function (key) {
    if (!ctx.SECRET_NAMES[key]) throw new Error('Unknown secret name: ' + key);
    const v = secrets[key];
    return v == null ? null : String(v).trim() || null;
  };
  ctx.cfg = function () {
    if (ctx.cfgCache_) return ctx.cfgCache_;
    const merged = ctx.mergeConfig_(data.config || []);
    ctx.cfgIssues_ = merged.issues;
    output.configIssues = merged.issues;
    ctx.cfgCache_ = merged.config;
    return ctx.cfgCache_;
  };
  // Live positions: adsb.lol first (OpenSky refuses Google Cloud), OpenSky as the fallback (engine/positions.js).
  // The states found are kept so tick() can record each flight's latest position for the dashboard map.
  const openskyOriginal = ctx.openskyStates;
  let lastStates = [], lastSource = '';
  const fetchJson = (url) => {
    try {
      const res = sandbox.UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return { ok: false, error: 'HTTP ' + res.getResponseCode() };
      return { ok: true, json: JSON.parse(res.getContentText()) };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  };
  const adsbLol = createAdsbLol(fetchJson);
  ctx.openskyStates = function (icao24s, callsigns) {
    const a = adsbLol(icao24s, callsigns);
    if (a.ok) { lastStates = a.states; lastSource = 'adsb.lol'; return a; }
    const b = openskyOriginal(icao24s);
    if (b.ok) { lastStates = b.states; lastSource = 'OpenSky'; return b; }
    return { ok: false, error: a.error + ' | ' + b.error };
  };
  ctx.loadExtraAirlines = function () { /* the Airlines sheet has no table yet: built-in airline list only */ };
  ctx.readFlights = function () {
    return (data.flights || []).map((r, i) => Object.assign({}, r, { _row: i + 2 }));
  };
  ctx.writeFlights = function (rows) { output.flights = rows; };
  ctx.readGroupsSheet = function () {
    return (data.groups || []).map((v) => ({ id: v[0], vehicle: v[8], driver: v[9], driverTg: String(v[10] == null ? '' : v[10]).trim(),
      memberIds: String(v[11] == null ? '' : v[11]).split(',').filter(String) }));
  };
  ctx.writeGroupsSheet = function (groups) { // same cells as src/Sheet.js writeGroupsSheet
    output.groups = groups.map((g) => [g.id, g.dir === 'ARR' ? 'Arrival' : 'Departure', g.airport, g.terminal, ctx.fmtIST(g.pickupMs),
      g.items.map((it) => it.r.name || it.r.id).join(', '),
      g.items.map((it) => it.r.flightNorm + ' ' + ctx.fmtTimeIST(it.t)).join(', '),
      g.items.length, g.vehicle || '', g.driver || '', g.driverTg || '',
      g.items.map((it) => it.r.id).join(',')]);
  };
  ctx.logEvent = function (level, flight, msg) {
    const line = level + ' ' + (flight || '') + ' ' + ctx.redactSecrets(msg);
    output.log.push({ at: now(), level, flight: flight || '', msg: ctx.redactSecrets(msg) });
    print(line);
  };
  ctx.purgeOldLogs_ = function () { /* no Log table: log lines go to the platform log (Vercel) */ };
  ctx.appendUsageRow_ = function (e) {
    const row = { at: e.at, label: e.label, params: e.params, code: e.code, units: e.units, requests: e.requests, outcome: e.outcome };
    output.usage.push(row);
    // AeroDataBox logs its charge right after its request: put the units on that request's log entry.
    const last = output.requests.slice().reverse().find((r) => r.provider === 'AeroDataBox');
    if (last && !last.units && Number(e.units) > 0) last.units = Number(e.units);
    print('USAGE ' + JSON.stringify(row));
  };
  ctx.recordHeartbeat_ = function (nowMs, res, error) {
    try { output.heartbeat = ctx.heartbeatRows_(nowMs, res, error, o.triggerInstalled == null ? null : !!o.triggerInstalled); } catch (e) { /* never break a run */ }
  };
  ctx.sendEmail_ = function (to, subject) {
    ctx.logEvent('WARN', '', 'Email not sent (the Node engine has no email service yet): ' + subject);
    return false;
  };
  ctx.tgSheetStore_ = function () { // Telegram delivery tracking, kept in tracker_state (TG_DELIVERIES)
    let rows;
    try { rows = JSON.parse(state.get('TG_DELIVERIES') || '[]'); } catch (e) { rows = []; }
    const save = () => state.set('TG_DELIVERIES', JSON.stringify(rows.slice(-ctx.TG_POLICY.readTail).map((r) => { const c = Object.assign({}, r); delete c._i; return c; })));
    return {
      read: () => rows.slice(-ctx.TG_POLICY.readTail).map((r) => { r._i = rows.indexOf(r) + 1; return r; }),
      append: (list) => { list.forEach((r) => { rows.push(r); r._i = rows.length; }); save(); },
      update: (r) => { if (r._i && rows[r._i - 1]) rows[r._i - 1] = r; save(); },
      purge: (cutoffMs) => { let n = 0; while (n < rows.length && (rows[n].queuedAt || 0) < cutoffMs && ctx.TG_FINAL[rows[n].state]) n++; if (n) { rows.splice(0, n); save(); } }
    };
  };

  /** One tracker run, as Tracker.js tick() does it (without the Apps Script lock). -> {summary} | {error} */
  function tick(nowMs, tickOpts) {
    try {
      lastStates = []; lastSource = '';
      const summary = ctx.runTick_(nowMs, tickOpts || {});
      output.positions = {};
      if (lastStates.length) {
        (output.flights || []).forEach((r) => {
          const st = ctx.findState(lastStates, r.icao24, r.callsign);
          if (st) output.positions[r.id] = toTelemetry(st, lastSource);
        });
      }
      return { summary };
    } catch (e) {
      const msg = ctx.redactSecrets((e && e.message) || e) || 'unknown error';
      ctx.logEvent('ERROR', '', ctx.redactSecrets((e && e.stack) || e));
      ctx.recordHeartbeat_(nowMs, null, msg);
      try { ctx.notifyCoordinators_('⚠️ Flight tracker error: ' + msg + ' — alerts may be missing until fixed.'); } catch (e2) { /* best effort */ }
      return { error: msg };
    }
  }

  return {
    ctx, tick, output, googleTouches,
    setUsage: (units, requests, allowLower) => ctx.adbSetUsage(units, requests, !!allowLower),
    usageSummary: () => ctx.adbUsageSummary()
  };
}

module.exports = { createCore, toRequest, describeRequest, LOGIC_FILES, GOOGLE_SERVICES, ENGINE_VERSION };
