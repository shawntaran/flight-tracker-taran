// Node tracking engine (engine/): the unchanged src/ decision code on Supabase. No network: an in-memory
// fake of the supabase-js query builder and a fake synchronous fetch. Run: node test/engine-tests.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { runTracker, readEnv } = require(path.join(ROOT, 'engine', 'run.js'));
const { createCore, toRequest, GOOGLE_SERVICES } = require(path.join(ROOT, 'engine', 'core.js'));
const cron = require(path.join(ROOT, 'api', 'cron.js'));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(() => Promise.resolve().then(fn).then(() => { passed++; console.log('  ok   ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }));
}

const NOW = Date.parse('2026-10-24T20:00:00Z');   // 01:30 IST on 25 Oct
const TG = '123456789:' + 'AAFakeTokenForEngineTests_abcdefghijk';
const ADB = 'adbKeyForEngineTests_0123456789';
const SECRETS = { ADB_KEY: ADB, TG_BOT_TOKEN: TG };

// ---------------------------------------------------------------- fake supabase-js (only what the engine uses)
function fakeSupabase(tables, fail) {
  const calls = [];
  const db = JSON.parse(JSON.stringify(tables));
  const err = (code, message, hint) => ({ data: null, error: { code, message, hint } });
  function q(name) {
    const st = { name, op: 'select', filters: [], range: null, payload: null, opts: null, returning: false };
    const run = () => {
      const lower = Object.keys(db).find((k) => k.toLowerCase() === name.toLowerCase());
      if (!(name in db)) return err('PGRST205', "Could not find the table 'public." + name + "' in the schema cache", lower ? "Perhaps you meant the table 'public." + lower + "'" : null);
      const t = db[name];
      const match = (r) => st.filters.every(([op, c, v]) => (op === 'eq' ? r[c] === v : v.indexOf(r[c]) >= 0));
      calls.push({ table: name, op: st.op, filters: st.filters, payload: st.payload });
      if (fail && fail[name] === st.op) return err('XX000', 'simulated ' + st.op + ' failure on ' + name);
      if (st.op === 'select') { const rows = t.filter(match); return { data: st.range ? rows.slice(st.range[0], st.range[1] + 1) : rows, error: null }; }
      if (st.op === 'update') { const rows = t.filter(match); rows.forEach((r) => Object.assign(r, st.payload)); return { data: st.returning ? rows.map((r) => Object.assign({}, r)) : null, error: null }; }
      if (st.op === 'delete') { db[name] = t.filter((r) => !match(r)); return { data: null, error: null }; }
      const list = Array.isArray(st.payload) ? st.payload : [st.payload];
      if (st.op === 'insert') {
        if (name === 'tracker_state' && list.some((x) => t.some((r) => r.key === x.key))) return err('23505', 'duplicate key value violates unique constraint');
        t.push(...list.map((x) => Object.assign({}, x))); return { data: null, error: null };
      }
      if (st.op === 'upsert') { list.forEach((x) => { const i = t.findIndex((r) => r.key === x.key); if (i >= 0) t[i] = Object.assign({}, x); else t.push(Object.assign({}, x)); }); return { data: null, error: null }; }
      return err('X', 'unsupported');
    };
    const b = {
      select(cols) { if (st.op === 'select') st.cols = cols; else st.returning = true; return b; },
      range(a, z) { st.range = [a, z]; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return b; },
      delete() { st.op = 'delete'; return b; },
      eq(c, v) { st.filters.push(['eq', c, v]); return b; },
      in(c, v) { st.filters.push(['in', c, v]); return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); }
    };
    return b;
  }
  return { client: { from: q }, db, calls };
}

// ---------------------------------------------------------------- fixtures: rows exactly as the import stored them
const core0 = createCore({ get: () => null, set() {}, del() {} }, {}, { log: () => {} });
const COLS = core0.ctx.COLS, GROUP_HEADERS = core0.ctx.GROUP_HEADERS;
function flightRow(o) {
  const r = {};
  COLS.forEach((c) => { r[c.h] = null; });
  r['m:adbCalls'] = 0; r['m:failCount'] = 0; r.Active = true;
  return Object.assign(r, o);
}
const F1 = flightRow({ ID: 'F1', Name: 'Dr Delayed', Phone: '+91 90000 00001', Direction: 'Arrival', Flight: 'EK 568', 'Sched Arr (IST)': '2026-10-25 02:50',
  Terminal: 'T2', 'Flight (normalised)': 'EK568', Status: 'SCHEDULED', 'm:schedArr': '2026-10-24T21:20:00.000Z', 'm:callsign': 'UAE568',
  'm:alertedStatus': 'SCHEDULED', 'm:stateKey': 'EK568|ARR||1792876800000', 'm:alertedEta': '2026-10-24T21:20:00.000Z' });
const F2 = flightRow({ ID: 'F2', Name: 'Dr Later', Direction: 'Departure', Flight: 'BA130', 'Sched Dep (IST)': '2026-10-31 02:40',
  'Flight (normalised)': 'BA130', Status: 'SCHEDULED', 'm:alertedStatus': 'SCHEDULED', 'm:stateKey': 'BA130|DEP|1793394600000|', 'm:callsign': 'BAW130' });
const STATUS = [['LAST_TICK_AT', ''], ['LAST_TICK_RESULT', ''], ['LAST_TICK_ERROR', ''], ['LAST_TICK_LOOKUPS', ''], ['TRIGGER_INSTALLED', 'yes'], ['TRACKER_VERSION', 'x']]
  .map(([Key, Value]) => ({ Key, Value, Notes: 'n' }));
const CONFIG = [['HOME_AIRPORT', 'BLR'], ['COORD_TG_CHAT_IDS', '111'], ['ADB_BILLING_CYCLE_DAY', null], ['EMAIL_ALERTS', 'FALSE']]
  .map(([Key, Value]) => ({ Key, Value, Notes: null }));
const tables = (o) => Object.assign({ Flights: [F1, F2], status: STATUS, config: CONFIG, groups: [], tracker_state: [] }, o || {});

const ADB_LEG = { number: 'EK 568', status: 'Expected', departure: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-24 17:30Z' } },
  arrival: { airport: { iata: 'BLR' }, scheduledTime: { utc: '2026-10-24 21:20Z' }, predictedTime: { utc: '2026-10-24 21:55Z' }, terminal: '2', gate: 'B4' } };
function fakeHttp(over) {
  const calls = [];
  const fn = (req) => {
    calls.push(req);
    if (over) { const r = over(req); if (r) return r; }
    if (/aerodatabox/.test(req.url)) return { code: 200, body: JSON.stringify([ADB_LEG]) };
    if (/api\.telegram\.org/.test(req.url)) return { code: 200, body: JSON.stringify({ ok: true, result: { message_id: calls.length } }) };
    if (/opensky/.test(req.url)) return { code: 200, body: JSON.stringify({ states: [] }) };
    return { error: 'unexpected request' };
  };
  return { fn, calls };
}
const run = (sb, http, o) => runTracker(Object.assign({ client: sb.client, secrets: SECRETS, now: () => NOW, fetchSync: http.fn, sleep: () => {}, log: () => {} }, o || {}));

// ---------------------------------------------------------------- tests
console.log('engine: a run against Supabase');
test('a due flight is looked up; only the changed engine columns are UPDATEd, by ID; inputs are never written', async () => {
  const sb = fakeSupabase(tables()), http = fakeHttp();
  const r = await run(sb, http);
  assert.ok(r.ok, r.error);
  const ups = sb.calls.filter((c) => c.table === 'Flights' && c.op === 'update');
  assert.deepStrictEqual(ups.map((u) => u.filters), [[['eq', 'ID', 'F1']], [['eq', 'ID', 'F2']]]);
  const p = ups[0].payload;
  assert.deepStrictEqual([p['m:eta'], p.Gate, p['Terminal (live)'], p['ETA Source'], p['m:adbCalls']], ['2026-10-24T21:55:00.000Z', 'B4', 'T2', 'AeroDataBox (estimated)', 1]);
  const inputs = COLS.filter((c) => c.kind === 'in').map((c) => c.h);
  ups.forEach((u) => assert.deepStrictEqual(Object.keys(u.payload).filter((k) => inputs.includes(k)), [], 'no coordinator input column written'));
  assert.ok(!('m:stateKey' in p) && !('Flight (normalised)' in p), 'unchanged columns are not sent');
  assert.strictEqual(sb.db.Flights[0].Phone, '+91 90000 00001');
});
test('heartbeat: LAST_TICK_AT / LAST_TICK_RESULT updated in the status table; a cron run reports the trigger installed', async () => {
  const sb = fakeSupabase(tables()), r = await run(sb, fakeHttp(), { scheduled: true });
  assert.ok(r.ok && r.writes.heartbeat);
  const kv = Object.fromEntries(sb.db.status.map((x) => [x.Key, x.Value]));
  assert.deepStrictEqual([kv.LAST_TICK_AT, kv.LAST_TICK_RESULT, kv.LAST_TICK_ERROR, kv.LAST_TICK_LOOKUPS, kv.TRIGGER_INSTALLED], [new Date(NOW).toISOString(), 'ok', null, '1', 'yes']);
  assert.ok(/^node-engine/.test(kv.TRACKER_VERSION));
  assert.ok(sb.db.status.every((x) => x.Notes === 'n'), 'notes untouched');
});
test('a manual run keeps the TRIGGER_INSTALLED value the scheduler wrote', async () => {
  const sb = fakeSupabase(tables({ status: STATUS.map((x) => Object.assign({}, x, x.Key === 'TRIGGER_INSTALLED' ? { Value: 'no' } : {})) }));
  await run(sb, fakeHttp());
  assert.strictEqual(sb.db.status.find((x) => x.Key === 'TRIGGER_INSTALLED').Value, 'no');
});
test('coordinators get the alert by Telegram, with the attribution line; nothing touches a Google service', async () => {
  const sb = fakeSupabase(tables()), http = fakeHttp(), r = await run(sb, http);
  const tg = http.calls.filter((c) => /telegram/.test(c.url));
  assert.strictEqual(tg.length, 1);
  const body = JSON.parse(tg[0].body);
  assert.ok(body.chat_id === '111' && /EK568/.test(body.text) && /AeroDataBox/.test(body.text), body.text);
  assert.deepStrictEqual(r.googleTouches, []);
});
test('AeroDataBox usage accounting, caches and Telegram tracking persist in tracker_state; the lock is released', async () => {
  const sb = fakeSupabase(tables());
  await run(sb, fakeHttp());
  const keys = sb.db.tracker_state.map((x) => x.key);
  ['prop:ADB_USAGE_V1', 'prop:ADB_USAGE_V1_INIT', 'TG_DELIVERIES'].forEach((k) => assert.ok(keys.includes(k), k + ' saved'));
  assert.ok(!keys.includes('LOCK_TICK'), 'lock released');
  const u = JSON.parse(sb.db.tracker_state.find((x) => x.key === 'prop:ADB_USAGE_V1').value);
  assert.strictEqual(Object.values(u.days).reduce((a, d) => a + d[1], 0), 1, 'one request counted');
  assert.ok(!JSON.stringify(sb.db.tracker_state).includes(ADB) && !JSON.stringify(sb.db.tracker_state).includes(TG), 'no secret stored');
});
test('the next run reuses the stored state: nothing is looked up twice, the budget carries over', async () => {
  const sb = fakeSupabase(tables());
  await run(sb, fakeHttp());
  const http2 = fakeHttp();
  const r2 = await runTracker({ client: sb.client, secrets: SECRETS, now: () => NOW + 5 * 60000, fetchSync: http2.fn, sleep: () => {}, log: () => {} });
  assert.ok(r2.ok, r2.error);
  assert.strictEqual(http2.calls.filter((c) => /aerodatabox/.test(c.url)).length, 0, 'next check is scheduled later');
  assert.strictEqual(http2.calls.filter((c) => /telegram/.test(c.url)).length, 0, 'no repeated alert');
});
test('a budget already used up (set from the RapidAPI dashboard) blocks lookups: status UNKNOWN and one coordinator alert', async () => {
  const sb = fakeSupabase(tables());
  const set = await run(sb, fakeHttp(), { action: 'set-usage', usageArgs: [400, 400, false] });
  assert.ok(set.ok && set.usage.units === 400);
  const http = fakeHttp(), r = await run(sb, http);
  assert.ok(r.ok, r.error);
  assert.strictEqual(http.calls.filter((c) => /aerodatabox/.test(c.url)).length, 0, 'nothing sent over budget');
  assert.strictEqual(sb.db.Flights[0].Status, 'UNKNOWN');
  assert.ok(http.calls.some((c) => /telegram/.test(c.url) && /UNKNOWN/.test(JSON.parse(c.body).text)));
});
test('a run that finds the lock held by another run does nothing', async () => {
  const sb = fakeSupabase(tables({ tracker_state: [{ key: 'LOCK_TICK', value: 'other', expires_at: new Date(NOW + 60000).toISOString() }] }));
  const http = fakeHttp(), r = await run(sb, http);
  assert.ok(r.ok && r.locked);
  assert.strictEqual(http.calls.length, 0);
  assert.strictEqual(sb.calls.filter((c) => c.op === 'update').length, 0);
});
test('an expired lock (a run that died) is taken over', async () => {
  const sb = fakeSupabase(tables({ tracker_state: [{ key: 'LOCK_TICK', value: 'dead', expires_at: new Date(NOW - 1000).toISOString() }] }));
  const r = await run(sb, fakeHttp());
  assert.ok(r.ok && !r.locked, r.error);
});
test('--dry-run reads and decides but writes nothing to Supabase', async () => {
  const sb = fakeSupabase(tables()), r = await run(sb, fakeHttp(), { dryRun: true });
  assert.ok(r.ok && r.dryRun);
  assert.deepStrictEqual(sb.calls.filter((c) => c.op !== 'select'), []);
});
test('a provider failure is recorded on the row; a bad period setting blocks lookups (fail closed) without crashing', async () => {
  const sb = fakeSupabase(tables()), r = await run(sb, fakeHttp((req) => (/aerodatabox/.test(req.url) ? { code: 500, body: 'oops' } : null)));
  assert.ok(r.ok);
  assert.ok(/AeroDataBox HTTP 500/.test(sb.db.Flights[0]['Last Error']));
  const sb2 = fakeSupabase(tables({ config: CONFIG.concat([{ Key: 'ADB_BILLING_CYCLE_DAY', Value: '45', Notes: null }]) }));
  sb2.db.Flights[0]['m:nextCheck'] = '2026-10-24T19:00:00.000Z';
  const r2 = await run(sb2, fakeHttp());
  const kv = Object.fromEntries(sb2.db.status.map((x) => [x.Key, x.Value]));
  assert.ok(r2.ok && kv.LAST_TICK_RESULT === 'ok', 'a bad period setting blocks lookups (fail closed) without crashing');
  assert.strictEqual(sb2.db.Flights[0].Status, 'UNKNOWN');
});
test('a failed save to Supabase becomes an error heartbeat, never a silent "ok"; usage accounting is saved first', async () => {
  const sb = fakeSupabase(tables({ groups: [{ Group: 'OLD', Direction: 'Arrival' }] }), { groups: 'insert' });
  const r = await run(sb, fakeHttp());
  assert.ok(!r.ok && /Writing the groups table failed: XX000 simulated insert failure/.test(r.error), r.error);
  const kv = Object.fromEntries(sb.db.status.map((x) => [x.Key, x.Value]));
  assert.ok(kv.LAST_TICK_RESULT === 'error' && /saving to Supabase failed/.test(kv.LAST_TICK_ERROR), JSON.stringify(kv));
  assert.ok(sb.db.tracker_state.some((x) => x.key === 'prop:ADB_USAGE_V1'), 'the request that was made is still counted');
});
test('a Flights table missing engine columns is refused with the column names, before anything is sent', async () => {
  const rows = [F1, F2].map((r) => { const c = Object.assign({}, r); delete c['m:flags']; delete c['m:groupSig']; return c; });
  const http = fakeHttp(), r = await run(fakeSupabase(tables({ Flights: rows })), http).catch((e) => ({ thrown: e.message }));
  assert.ok(/lacks columns the engine writes: m:flags, m:groupSig/.test(r.thrown), JSON.stringify(r));
  assert.strictEqual(http.calls.length, 0);
});
test('no tracker_state table: a clear instruction to run engine/schema.sql', async () => {
  const t = tables(); delete t.tracker_state;
  const r = await run(fakeSupabase(t), fakeHttp()).catch((e) => ({ thrown: e.message }));
  assert.ok(/run engine\/schema\.sql/.test(r.thrown));
});
test('table names are found in either case ("flights" or "Flights"); snake_case groups columns still map', async () => {
  const sb = fakeSupabase(tables({ groups: [{ group: 'OLD', direction: 'Arrival', vehicle: 'Innova', driver: 'Ravi', driver_telegram_chat_id: '77', member_ids: 'F9' }] }));
  const r = await run(sb, fakeHttp());
  assert.ok(r.ok, r.error);
  assert.ok(!sb.db.groups.some((g) => g.group === 'OLD'), 'the stale plan row was replaced');
});
test('config: an imported text "null" is read as blank (the default), and reported', async () => {
  const sb = fakeSupabase(tables({ config: CONFIG.filter((x) => x.Key !== 'ADB_BILLING_CYCLE_DAY').concat([{ Key: 'ADB_BILLING_CYCLE_DAY', Value: 'null', Notes: null }]) }));
  const http = fakeHttp(), r = await run(sb, http);
  assert.ok(r.ok && r.notes.some((n) => /ADB_BILLING_CYCLE_DAY holds the text "null"/.test(n)));
  assert.strictEqual(http.calls.filter((c) => /aerodatabox/.test(c.url)).length, 1, 'lookups still allowed');
});

console.log('engine: API usage page data (request log, activity, provider health)');
const { describeRequest } = require(path.join(ROOT, 'engine', 'core.js'));
const { summarize } = require(path.join(ROOT, 'tools', 'engine-status.js'));
test('every outgoing request is logged with provider, endpoint, flight, units and result; no token or query string', async () => {
  const sb = fakeSupabase(tables());
  await run(sb, fakeHttp());
  const log = JSON.parse(sb.db.tracker_state.find((x) => x.key === 'REQUEST_LOG').value);
  const pick = (p) => log.find((r) => r.provider === p);
  assert.deepStrictEqual([pick('AeroDataBox').endpoint, pick('AeroDataBox').flight, pick('AeroDataBox').status], ['/flights/number', 'EK568', 'OK']);
  assert.ok(pick('AeroDataBox').units >= 1, 'units charged on the AeroDataBox request');
  assert.deepStrictEqual([pick('Telegram').endpoint, pick('Telegram').units], ['/sendMessage', 0]);
  assert.ok(log.every((r) => typeof r.at === 'number' && typeof r.responseMs === 'number'));
  const all = JSON.stringify(sb.db.tracker_state);
  assert.ok(!all.includes(TG) && !all.includes(ADB) && !all.includes('withAircraftImage'), 'no token, key or query string stored');
  assert.ok(JSON.parse(sb.db.tracker_state.find((x) => x.key === 'EVENT_LOG').value).some((e) => /AeroDataBox/.test(e.msg)), 'activity feed saved');
});
test('a failed call is logged as such; the logs keep only the newest entries', () => {
  assert.deepStrictEqual(describeRequest('https://api.telegram.org/bot' + TG + '/getMe'), { provider: 'Telegram', endpoint: '/getMe', flight: '' });
  const { appendLog } = require(path.join(ROOT, 'engine', 'run.js'));
  const m = new Map(), st = { get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v) };
  appendLog(st, 'L', Array.from({ length: 250 }, (_, i) => ({ at: NOW, i })), 200, 1000, NOW);
  appendLog(st, 'L', [{ at: NOW - 5000, old: true }], 200, 1000, NOW);
  const l = JSON.parse(m.get('L'));
  assert.deepStrictEqual([l.length, l[0].i, l.some((x) => x.old)], [200, 50, false]);
});
test('the dashboard reads the same budget the engine enforces, plus OpenSky and Telegram health', async () => {
  const sb = fakeSupabase(tables());
  await run(sb, fakeHttp((req) => (/opensky/.test(req.url) ? { code: 403, body: '' } : null)), { now: () => Date.parse('2026-10-24T21:00:00Z') });
  const map = new Map(sb.db.tracker_state.map((x) => [x.key, x.value]));
  map.set('prop:OPENSKY_FAILS', '3');
  const s = summarize(map, CONFIG.map((x) => [x.Key, x.Value]), Date.now(), {}); // deliveries and usage are stamped with the real clock
  assert.deepStrictEqual([s.usage.units >= 1, s.usage.unitLimit, s.usage.requests, s.usageError], [true, 400, 1, '']);
  assert.deepStrictEqual([s.providers.opensky.fails, s.providers.opensky.account, s.providers.opensky.lastStatus], [3, false, 'HTTP 403']);
  assert.ok(s.providers.telegram.sent24h >= 1 && s.apiRequests.length >= 2 && s.log.length >= 1, JSON.stringify(s.providers.telegram));
});

console.log('engine: live positions (adsb.lol, OpenSky as fallback)');
const POS = require(path.join(ROOT, 'engine', 'positions.js'));
// UAE568 (F1's callsign), about 300 km north of BLR, cruising south.
const ADSB_AC = { hex: '896123', flight: 'UAE568  ', lat: 15.9, lon: 77.7, alt_baro: 35000, gs: 450, track: 181, baro_rate: -64, squawk: '2214', seen_pos: 2, seen: 1 };
const adsbHttp = (ac, code) => fakeHttp((req) => (/adsb\.lol/.test(req.url) ? (code ? { code, body: 'busy' } : { code: 200, body: JSON.stringify({ now: NOW, ac: ac || [] }) }) : null));
test('an adsb.lol aircraft becomes an OpenSky-style state vector (metres, m/s, seconds) and dashboard telemetry', () => {
  const s = POS.toStateVector(ADSB_AC, NOW);
  assert.deepStrictEqual([s[0], s[1].trim(), s[3], s[5], s[6], Math.round(s[7]), s[8], Math.round(s[9]), s[10]], ['896123', 'UAE568', (NOW - 2000) / 1000, 77.7, 15.9, 10668, false, 231, 181]);
  assert.strictEqual(POS.toStateVector(Object.assign({}, ADSB_AC, { alt_baro: 'ground' }), NOW)[8], true);
  assert.strictEqual(POS.toStateVector({ hex: 'x', flight: 'NOPOS' }, NOW), null, 'no position, no state');
  assert.deepStrictEqual(POS.toTelemetry(s, 'adsb.lol'), { lat: 15.9, lon: 77.7, onGround: false, altFt: 35000, gsKts: 450, headingDeg: 181, vsFpm: -60, squawk: '2214', fixAt: NOW - 2000, callsign: 'UAE568', source: 'adsb.lol' });
});
test('lookups: one request by transponder id, one by callsign only for flights without one; nothing when nothing is airborne', () => {
  const urls = [];
  const lookup = POS.createAdsbLol((u) => { urls.push(u); return { ok: true, json: { now: NOW, ac: [] } }; });
  lookup(['3c6712', '', 'BAD!'], ['DLH764', 'UAE568', 'QTR572']);
  assert.deepStrictEqual(urls, ['https://api.adsb.lol/v2/icao/3c6712', 'https://api.adsb.lol/v2/callsign/UAE568,QTR572']);
  urls.length = 0;
  assert.deepStrictEqual(lookup([], []), { ok: true, states: [], source: 'adsb.lol' });
  assert.strictEqual(urls.length, 0);
  assert.ok(!POS.createAdsbLol(() => ({ ok: false, error: 'HTTP 503' }))(['3c6712'], ['']).ok);
});
test('a run: the airborne guest gets a live ETA from adsb.lol, and the position is saved for the map', async () => {
  const sb = fakeSupabase(tables()), http = adsbHttp([ADSB_AC]);
  const r = await run(sb, http);
  assert.ok(r.ok, r.error);
  assert.ok(http.calls.some((c) => c.url === 'https://api.adsb.lol/v2/callsign/UAE568'), http.calls.map((c) => c.url).join('\n'));
  // adsb.lol refuses Node's default User-Agent ("node") with 403: every call names the project.
  assert.ok(http.calls.filter((c) => /adsb\.lol/.test(c.url)).every((c) => /^flight-tracker\/.+github\.com/.test((c.headers || {})['User-Agent'])));
  const f1 = sb.db.Flights.find((x) => x.ID === 'F1');
  assert.deepStrictEqual([f1.Status, /^live \(ADS-B, \d+ km out\)$/.test(f1['ETA Source'])], ['DEPARTED', true], f1['ETA Source']);
  const pos = JSON.parse(sb.db.tracker_state.find((x) => x.key === 'POSITIONS').value);
  assert.deepStrictEqual([Object.keys(pos), pos.F1.lat, pos.F1.source, pos.F1.callsign], [['F1'], 15.9, 'adsb.lol', 'UAE568']);
  assert.ok(JSON.parse(sb.db.tracker_state.find((x) => x.key === 'REQUEST_LOG').value).some((x) => x.provider === 'adsb.lol' && x.status === 'OK'));
});
test('guests on one flight share it: a VJ flight number has a callsign, and a landing seen for one guest lands the other', async () => {
  const vj = (o) => flightRow(Object.assign({ Direction: 'Arrival', Flight: 'VJ1801', 'Sched Arr (IST)': '2026-10-25 01:15', Terminal: 'T2',
    'Flight (normalised)': 'VJ1801', 'm:schedArr': '2026-10-24T19:45:00.000Z', 'm:schedDep': '2026-10-24T15:40:00.000Z' }, o));
  const seen = vj({ ID: 'V1', Name: 'Seen', Status: 'LANDED', 'm:alertedStatus': 'LANDED', 'm:callsign': 'VJC1801', 'm:icao24': '8881da',
    'm:eta': '2026-10-24T19:29:00.000Z', 'm:lastFix': '2026-10-24T19:29:00.000Z', 'ETA Source': 'live (ADS-B, on ground)' });
  const other = vj({ ID: 'V2', Name: 'Other', Status: 'SCHEDULED', 'm:alertedStatus': 'SCHEDULED', 'm:adbCalls': 4 }); // provider cap used up
  const sb = fakeSupabase(tables({ Flights: [seen, other] })), http = adsbHttp([]); // the aircraft is no longer transmitting
  const r = await run(sb, http);
  assert.ok(r.ok, r.error);
  const v2 = sb.db.Flights.find((x) => x.ID === 'V2');
  assert.deepStrictEqual([v2.Status, v2['ETA Source'], v2['m:callsign'], v2['m:icao24'], v2['m:eta']],
    ['LANDED', 'live (ADS-B, on ground)', 'VJC1801', '8881da', '2026-10-24T19:29:00.000Z']);
  const sent = JSON.parse(sb.db.tracker_state.find((x) => x.key === 'EVENT_LOG').value).map((e) => e.msg || e.message || JSON.stringify(e)).join('\n');
  assert.ok(/VJ1801 \(Other\) LANDED/.test(sent), 'the second guest gets the landing alert too:\n' + sent);
});
test('an arrival still "in the air" 6 h after its ETA with no live position is marked landed, not confirmed', async () => {
  const lh = (id, etaIso, o) => flightRow(Object.assign({ ID: id, Name: 'Guest ' + id, Direction: 'Arrival', Flight: 'LH764', 'Flight (normalised)': 'LH764',
    'Sched Arr (IST)': '2026-10-24 18:30', 'm:schedArr': '2026-10-24T13:00:00.000Z', Status: 'DEPARTED', 'm:alertedStatus': 'DEPARTED',
    'm:eta': etaIso, 'm:adbEta': etaIso, 'm:alertedEta': etaIso, 'm:adbCalls': 4, 'm:callsign': 'DLH764', 'm:icao24': '3c6712',
    'ETA Source': 'airline/scheduled — no live position' }, o));
  const stuck = lh('S1', '2026-10-24T13:00:00.000Z');                                    // 7 h past its ETA
  const recent = lh('S2', '2026-10-24T15:00:00.000Z', { 'Sched Arr (IST)': '2026-10-24 20:30', 'm:schedArr': '2026-10-24T15:00:00.000Z' }); // 5 h
  const seen = lh('S3', '2026-10-24T13:00:00.000Z', { 'm:lastFix': '2026-10-24T18:00:00.000Z', Flight: 'LH766', 'Flight (normalised)': 'LH766' }); // fix 2 h ago
  const neverSeen = lh('S4', null, { Status: 'SCHEDULED', 'm:alertedStatus': 'SCHEDULED', Flight: 'LH768', 'Flight (normalised)': 'LH768', 'ETA Source': null });
  const dep = flightRow({ ID: 'D9', Name: 'Guest D9', Direction: 'Departure', Flight: 'LH765', 'Flight (normalised)': 'LH765', 'Sched Dep (IST)': '2026-10-24 18:30',
    'm:schedDep': '2026-10-24T13:00:00.000Z', Status: 'SCHEDULED', 'm:alertedStatus': 'SCHEDULED', 'm:adbCalls': 4, 'm:callsign': 'DLH765' });
  const cancelled = lh('S5', '2026-10-24T13:00:00.000Z', { Status: 'CANCELLED', 'm:alertedStatus': 'CANCELLED', Flight: 'LH770', 'Flight (normalised)': 'LH770' });
  const sb = fakeSupabase(tables({ Flights: [stuck, recent, seen, neverSeen, dep, cancelled] })), http = adsbHttp([]);
  const r = await run(sb, http);
  assert.ok(r.ok, r.error);
  const row = (id) => sb.db.Flights.find((x) => x.ID === id);
  assert.deepStrictEqual([row('S1').Status, row('S1')['ETA Source'], row('S1')['m:eta']],
    ['LANDED', 'assumed landed — not confirmed (no update 6 h after ETA)', '2026-10-24T13:00:00.000Z']);
  assert.deepStrictEqual([row('S2').Status, row('S3').Status, row('S5').Status], ['DEPARTED', 'DEPARTED', 'CANCELLED'],
    'under 6 h, a live position since, or cancelled: left alone');
  assert.deepStrictEqual([row('S4').Status, /^assumed landed/.test(row('S4')['ETA Source'])], ['LANDED', true], 'never confirmed as departed either');
  assert.deepStrictEqual([row('D9').Status, row('D9')['ETA Source']], ['DEPARTED', 'assumed departed — not confirmed (no update 6 h after departure time)']);
  const sent = JSON.parse(sb.db.tracker_state.find((x) => x.key === 'EVENT_LOG').value).map((e) => e.msg || e.message || JSON.stringify(e)).join('\n');
  assert.ok(/LH764 \(Guest S1\) marked LANDED, not confirmed/.test(sent) && !/LH764 \(Guest S1\) LANDED at/.test(sent), sent);
  assert.ok(/LH765 \(Guest D9\) marked DEPARTED from BLR, not confirmed/.test(sent), sent);
});
test('adsb.lol down: OpenSky is tried; both down: counted as a failed position check, the run itself still succeeds', async () => {
  const sb = fakeSupabase(tables()), http = adsbHttp(null, 503);
  assert.ok((await run(sb, http)).ok);
  assert.ok(http.calls.some((c) => /opensky-network\.org\/api\/states/.test(c.url)), 'fell back to OpenSky');
  const sb2 = fakeSupabase(tables());
  await run(sb2, fakeHttp((req) => (/adsb\.lol|opensky/.test(req.url) ? { code: 503, body: '' } : null)));
  assert.strictEqual(sb2.db.tracker_state.find((x) => x.key === 'prop:OPENSKY_FAILS').value, '1');
});
test('saved positions: newer ones replace older, a deleted guest\'s and anything over 6 h old are dropped', () => {
  const { savePositions } = require(path.join(ROOT, 'engine', 'run.js'));
  const m = new Map([['POSITIONS', JSON.stringify({ F1: { fixAt: NOW - 7 * 3600e3 }, F2: { fixAt: NOW - 60e3 }, GONE: { fixAt: NOW } })]]);
  const st = { get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v) };
  savePositions(st, { F3: { fixAt: NOW, lat: 1 } }, ['F1', 'F2', 'F3'], NOW);
  assert.deepStrictEqual(Object.keys(JSON.parse(m.get('POSITIONS'))).sort(), ['F2', 'F3']);
});
test('the dashboard puts each saved position on its flight (the map plots flight.telemetry)', async () => {
  const S = require(path.join(ROOT, 'tools', 'sheet-source.js'));
  const { toRows } = require(path.join(ROOT, 'local-assistant', 'src', 'supabase.js'));
  const tel = POS.toTelemetry(POS.toStateVector(ADSB_AC, NOW), 'adsb.lol');
  const get = S.createSheetSource({ previewSource: 'flights', now: () => NOW, readRange: async (tab) => (tab === 'Flights' ? { rows: toRows([F1, F2], 'Flights') } : { missing: true }),
    engineStatus: async () => ({ positions: { F1: tel }, providers: {} }) });
  const d = await get();
  assert.deepStrictEqual([d.flights.find((f) => f.id === 'F1').telemetry, d.flights.find((f) => f.id === 'F2').telemetry], [tel, undefined]);
});

console.log('engine: the sandbox');
test('every Google service is absent from the sandbox; touching one throws and is recorded', () => {
  const core = createCore({ get: () => null, set() {}, del() {} }, {}, { log: () => {} });
  GOOGLE_SERVICES.forEach((name) => assert.throws(() => core.ctx[name], /not available in the Node tracking engine/));
  assert.deepStrictEqual(core.googleTouches, GOOGLE_SERVICES);
});
test('secrets come from the environment only: the engine refuses to write one', () => {
  const core = createCore({ get: () => null, set() {}, del() {} }, {}, { secrets: SECRETS, log: () => {} });
  assert.strictEqual(core.ctx.secret('ADB_KEY'), ADB);
  assert.throws(() => core.ctx.PropertiesService.getScriptProperties().setProperty('ADB_KEY', 'x'), /never written/);
  assert.ok(!/AAFake/.test(core.ctx.redactSecrets('url https://api.telegram.org/bot' + TG + '/x')));
});
test('UrlFetchApp options map to fetch: form payloads, JSON payloads, method and headers', () => {
  assert.deepStrictEqual(toRequest('u', { method: 'post', payload: { a: '1 2' } }), { url: 'u', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1+2' });
  assert.deepStrictEqual(toRequest('u', { method: 'post', contentType: 'application/json', payload: '{"x":1}', headers: { H: 'v' } }),
    { url: 'u', method: 'POST', headers: { H: 'v', 'Content-Type': 'application/json' }, body: '{"x":1}' });
  assert.strictEqual(toRequest('u', { muteHttpExceptions: true }).method, 'GET');
});
test('the engine loads the same decision files the Apps Script deployment runs (no forked copy)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'engine', 'core.js'), 'utf8');
  assert.ok(/path\.join\(__dirname, '\.\.', 'src'\)/.test(src));
  assert.ok(!fs.existsSync(path.join(ROOT, 'engine', 'Tracker.js')));
});

console.log('Vercel cron endpoint');
const fakeRes = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
test('refuses callers without the CRON_SECRET bearer token, and refuses to run with no CRON_SECRET at all', async () => {
  const saved = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    let res = fakeRes(); await cron({ headers: {} }, res); assert.strictEqual(res.code, 500);
    process.env.CRON_SECRET = 'cron-secret-for-tests-123';
    res = fakeRes(); await cron({ headers: { authorization: 'Bearer wrong' } }, res); assert.strictEqual(res.code, 401);
    res = fakeRes(); await cron({ headers: {} }, res); assert.strictEqual(res.code, 401);
  } finally { if (saved == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
});
test('vercel.json has no Vercel cron (Hobby plan) and ships the src/ logic files with the function', () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.ok(!('crons' in v));
  assert.ok(/src/.test(v.functions['api/cron.js'].includeFiles) && /engine/.test(v.functions['api/cron.js'].includeFiles));
});
test('no GitHub Actions schedule: the VM runs the tracker (deploy/README.md), so nothing fails and emails every 5 minutes', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'tracker-cron.yml')));
  assert.ok(/node engine\/run\.js --scheduled/.test(fs.readFileSync(path.join(ROOT, 'deploy', 'README.md'), 'utf8')));
});
test('environment: process.env wins over .env.engine; only known secrets are passed to the logic', () => {
  const e = readEnv({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', ADB_KEY: 'a', OTHER: 'z' }, null);
  assert.deepStrictEqual(e, { supabaseUrl: 'https://x.supabase.co', serviceKey: 'svc', secrets: { ADB_KEY: 'a' } });
});

(async () => {
  for (const t of pending) await t(); // sequential: runs share the fake fetch worker
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
