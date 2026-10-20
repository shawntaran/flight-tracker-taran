// AeroDataBox budget, validation, retention and failure-handling tests. All external APIs are faked;
// nothing here can touch real quota. Run: node test/adb-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const MIN = 60000, HOUR = 60 * MIN;
const srcDir = path.join(__dirname, '..', 'src');
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);

const LEGS = [{ status: 'Delayed', callSign: 'UAE568', aircraft: { modeS: '896ABC' },
  departure: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 22:15Z', local: '2026-10-21 02:15+04:00' },
    revisedTime: { utc: '2026-10-20 23:00Z' } },
  arrival: { airport: { iata: 'BLR' }, scheduledTime: { utc: '2026-10-21 02:30Z' }, revisedTime: { utc: '2026-10-21 03:10Z' }, terminal: '2' } }];
const OK = () => ({ code: 200, body: JSON.stringify(LEGS) });

/** Fresh copy of the app with a fake environment. */
function setup(opts = {}) {
  const G = vm.createContext({ console });
  for (const [f, src] of sources) vm.runInContext(src, G, { filename: f });
  const C = Object.assign(G.defaultConfig(), { COORD_TG_CHAT_IDS: '1' }, opts.config || {});
  const secrets = Object.assign({ ADB_KEY: 'test-key' }, opts.secrets || {});
  const store = opts.store || {};
  const env = {
    t: opts.now || Date.parse('2026-10-20T06:00:00Z'),
    fetches: [], usageLog: [], slept: 0, propsFail: false,
    responder: opts.responder || OK,
    props: {
      getProperty: (k) => { if (env.propsFail) throw new Error('Properties service unavailable'); return k in store ? store[k] : null; },
      setProperty: (k, v) => { if (env.propsFail) throw new Error('Properties service unavailable'); store[k] = String(v); }
    },
    lock: { held: false, tryLock() { if (this.held) return false; this.held = true; return true; }, releaseLock() { this.held = false; } },
    cache: { m: {}, ttl: {}, get(k) { return this.m[k] || null; }, put(k, v, ttl) { this.m[k] = v; this.ttl[k] = ttl; } },
    fetch: (url) => {
      env.fetches.push(url);
      const r = env.responder(url, env.fetches.length);
      if (r instanceof Error) throw r;
      return { getResponseCode: () => r.code, getContentText: () => r.body || '' };
    },
    sleep: (ms) => { env.slept += ms; env.t += ms; },
    now: () => env.t,
    secret: (k) => secrets[k] || null,
    logUsage: (e) => env.usageLog.push(e)
  };
  G.ADB_ENV = env;
  G.cfg = () => C;
  G.secret = (k) => secrets[k] || null;
  G.logEvent = () => {};
  // Totals counted against the current accounting window, as the gateway sees them.
  const usage = () => { const u = JSON.parse(store.ADB_USAGE_V1); const t = G.adbTotals_(u, G.adbWindow_(env.t, C)); return { units: t.units, requests: t.requests, pending: u.pending, raw: u }; };
  return { G, C, env, store, usage };
}

/** Usage already recorded on one IST day. */
function preset(store, day, units, requests, extra) {
  store.ADB_USAGE_V1 = JSON.stringify(Object.assign({ v: 2, days: { [day]: [units, requests] }, hour: { k: "", n: 0 }, pending: {}, warned: {}, lastReqAt: 0, suspended: null }, extra || {}));
  store.ADB_USAGE_V1_INIT = '1';
}

const SPEC = { endpoint: 'flightStatus', flight: 'EK568', date: '2026-10-21', role: 'Arrival' };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

console.log('budget enforcement');
test('1. request that fits both budgets is sent and charged once', () => {
  const { G, env, usage } = setup();
  const r = G.adbRequest(SPEC);
  assert.ok(r.ok && r.attempted);
  assert.strictEqual(env.fetches.length, 1);
  assert.ok(/withFlightPlan=false/.test(env.fetches[0]));
  const u = usage();
  assert.deepStrictEqual([u.units, u.requests, Object.keys(u.pending).length], [2, 1, 0]);
  assert.strictEqual(env.usageLog.length, 1);
  assert.ok(/^ok/.test(env.usageLog[0].outcome) && env.usageLog[0].code === 200);
});
test('2/17. exceeding the remaining unit budget sends nothing', () => {
  const { G, env, store, usage } = setup();
  preset(store, '2026-10-20', 399, 10);
  const r = G.adbRequest(SPEC);
  assert.ok(!r.ok && r.blocked && r.kind === 'budget' && !r.attempted);
  assert.strictEqual(env.fetches.length, 0);
  assert.strictEqual(usage().units, 399);
  assert.ok(G.adbDrainNotices().some((n) => /suspended/.test(n)));
});
test('2b. a request that exactly fills the unit budget is allowed', () => {
  const { G, env, store, usage } = setup();
  preset(store, '2026-10-20', 398, 10);
  assert.ok(G.adbRequest(SPEC).ok);
  assert.strictEqual(usage().units, 400);
  assert.strictEqual(env.fetches.length, 1);
});
test('3/17. exceeding the request budget sends nothing, independent of units', () => {
  const { G, env, store } = setup({ config: { ADB_MONTHLY_REQUESTS: 99999 } }); // clamped to the plan's 1600
  preset(store, '2026-10-20', 0, 1600);
  const r = G.adbRequest(SPEC);
  assert.ok(r.blocked && /request budget/.test(r.error));
  assert.strictEqual(env.fetches.length, 0);
});
test('configured limits can be lower than the plan but never higher', () => {
  const { G } = setup();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G.adbLimits({ ADB_MONTHLY_UNITS: 1000, ADB_MONTHLY_REQUESTS: 5000 }))), { units: 400, requests: 1600, perHour: 0 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(G.adbLimits({ ADB_MONTHLY_UNITS: 300, ADB_MONTHLY_REQUESTS: 'x' }))), { units: 300, requests: 0, perHour: 0 });
  assert.strictEqual(G.adbLimits({ ADB_MAX_REQUESTS_PER_HOUR: 5000 }).perHour, 1000);
});
test('4. tier costs: Tier 1 = 1, Tier 2 = 2, Tier 3 = 6, Free = 0; flight plan doubles', () => {
  const { G } = setup();
  G.ADB_ENDPOINTS.t1 = { tier: 'TIER1' };
  G.ADB_ENDPOINTS.free = { tier: 'FREE' };
  assert.strictEqual(G.adbCost({ endpoint: 't1' }).units, 1);
  assert.strictEqual(G.adbCost({ endpoint: 'flightStatus' }).units, 2); // verified: "Flight Status (single day) / TIER 2"
  assert.strictEqual(G.adbCost({ endpoint: 'flightHistory' }).units, 6);
  assert.strictEqual(G.adbCost({ endpoint: 'free' }).units, 0);
  assert.strictEqual(G.adbCost({ endpoint: 'flightStatus', withFlightPlan: true }).units, 4);
  assert.strictEqual(G.adbCost({ endpoint: 'flightStatus' }).requests, 1);
});
test('4b. an unexpected flight plan in the response is charged x2', () => {
  const legs = JSON.parse(JSON.stringify(LEGS)); legs[0].flightPlan = { route: 'X' };
  const { G, usage } = setup({ responder: () => ({ code: 200, body: JSON.stringify(legs) }) });
  G.adbRequest(SPEC);
  assert.deepStrictEqual([usage().units, usage().requests], [4, 1]);
});
test('threshold warnings fire once at 70/85/95%', () => {
  const { G, store } = setup();
  preset(store, '2026-10-20', 278, 0);
  G.adbRequest(SPEC);
  let n = G.adbDrainNotices();
  assert.ok(n.length === 1 && /units at 70%/.test(n[0]), JSON.stringify(n));
  G.adbResetExecution_();
  G.adbRequest(Object.assign({}, SPEC, { flight: 'QR572' }));
  assert.strictEqual(G.adbDrainNotices().length, 0);
});
test('requests are spaced at least ADB_MIN_INTERVAL_MS apart (plan: 1 req/s)', () => {
  const { G, env } = setup();
  G.adbRequest(SPEC);
  G.adbRequest(Object.assign({}, SPEC, { flight: 'QR572' }));
  assert.ok(env.slept >= 1100, 'slept ' + env.slept);
});

console.log('retries and failures');
test('5. a retry in a later execution consumes another request', () => {
  const { G, env, usage } = setup({ responder: (u, n) => (n === 1 ? { code: 500, body: 'boom' } : OK()) });
  assert.strictEqual(G.adbRequest(SPEC).kind, 'http');
  G.adbResetExecution_();
  env.t += 15 * MIN;
  assert.ok(G.adbRequest(SPEC).ok);
  assert.deepStrictEqual([usage().units, usage().requests, env.fetches.length], [4, 2, 2]);
});
test('6. failed responses stay charged (billing of errors is undocumented)', () => {
  for (const code of [500, 503, 400, 204]) {
    const { G, usage, env } = setup({ responder: () => ({ code, body: '' }) });
    const r = G.adbRequest(SPEC);
    assert.ok(!r.ok && r.attempted, String(code));
    assert.deepStrictEqual([usage().units, usage().requests], [2, 1], String(code));
    assert.ok(/counted/.test(env.usageLog[0].outcome));
  }
});
test('6b. 401/403 suspend all lookups until resumed; nothing else is sent', () => {
  const { G, env, usage } = setup({ responder: () => ({ code: 401, body: 'Invalid API key' }) });
  assert.strictEqual(G.adbRequest(SPEC).kind, 'auth');
  G.adbResetExecution_();
  const r = G.adbRequest(Object.assign({}, SPEC, { flight: 'QR572' }));
  assert.ok(r.blocked && r.kind === 'suspended');
  assert.strictEqual(env.fetches.length, 1);
  assert.strictEqual(usage().units, 2);
  G.adbResume();
  G.adbResetExecution_(); // next execution
  env.responder = OK;
  assert.ok(G.adbRequest(Object.assign({}, SPEC, { flight: 'QR572' })).ok);
});
test('6c. 429 rate limit pauses 1 h; 429 quota suspends lookups (rolling mode: until resumed)', () => {
  let s = setup({ responder: () => ({ code: 429, body: 'Too many requests per second' }) });
  s.G.adbRequest(SPEC); s.G.adbResetExecution_();
  assert.strictEqual(s.G.adbRequest(SPEC).kind, 'suspended');
  s.env.t += HOUR + MIN; s.env.responder = OK; s.G.adbResetExecution_();
  assert.ok(s.G.adbRequest(SPEC).ok);

  s = setup({ responder: () => ({ code: 429, body: 'You have exceeded the MONTHLY quota for Units' }) });
  s.G.adbRequest(SPEC); s.G.adbResetExecution_();
  const sus = s.G.adbRequest(SPEC);
  assert.ok(sus.kind === 'suspended' && /quota/.test(sus.error), JSON.stringify(sus));
  s.env.t += 40 * 24 * HOUR; s.G.adbResetExecution_();
  assert.strictEqual(s.G.adbRequest(SPEC).kind, 'suspended', 'reset date unknown: stays off until resumed');
  assert.strictEqual(s.env.fetches.length, 1);
});
test('7. a timeout has an unknown outcome: charged, logged as UNKNOWN, not retried in the run', () => {
  const { G, env, usage } = setup({ responder: () => new Error('Timeout: https://aerodatabox.p.rapidapi.com') });
  const r = G.adbRequest(SPEC);
  assert.ok(!r.ok && r.uncertain && r.kind === 'unknown' && r.attempted);
  assert.deepStrictEqual([usage().units, usage().requests, Object.keys(usage().pending).length], [2, 1, 0]);
  assert.ok(/UNKNOWN/.test(env.usageLog[0].outcome));
  assert.ok(G.adbRequest(SPEC).deduped);
  assert.strictEqual(env.fetches.length, 1);
});
test('a reservation left by a killed execution stays charged', () => {
  const { G, C, env, store, usage } = setup();
  const rsv = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'x'); // no finalise: execution died
  assert.ok(rsv.ok);
  env.t += 2 * HOUR;
  G.adbRequest(SPEC);
  assert.deepStrictEqual([usage().units, usage().requests, Object.keys(usage().pending).length], [4, 2, 0]);
});

console.log('dedupe, cache, retention');
test('8. identical lookups in one execution send one request', () => {
  const { G, env, usage } = setup();
  assert.ok(G.adbRequest(SPEC).ok);
  const again = G.adbRequest(Object.assign({}, SPEC));
  assert.ok(again.ok && again.deduped && !again.attempted);
  assert.strictEqual(env.fetches.length, 1);
  assert.strictEqual(usage().requests, 1);
});
test('9. cached results are reused free; cache TTL never exceeds 6 h or the retention limit', () => {
  const { G, C, env } = setup();
  G.adbRequest(SPEC); G.adbResetExecution_();
  const r = G.adbRequest(SPEC);
  assert.ok(r.ok && r.cached && !r.attempted);
  assert.strictEqual(env.fetches.length, 1);
  assert.strictEqual(env.cache.ttl[G.adbMemoKey_(SPEC)], 20 * 60);
  assert.strictEqual(G.adbCacheTtlSec_({ ADB_CACHE_MIN: 100000, ADB_RETENTION_HOURS: 156 }), 21600);
  assert.strictEqual(G.adbCacheTtlSec_({ ADB_CACHE_MIN: 120, ADB_RETENTION_HOURS: 1 }), 3600);
});
test('9b. provider data is purged exactly at the retention boundary (max 7 days)', () => {
  const { G, C } = setup();
  const fetched = Date.parse('2026-10-01T00:00:00Z');
  const mk = () => G.prepareRow({ _row: 2, id: 'X', direction: 'Arrival', flightRaw: 'EK568', schedArrIn: '2026-10-01 08:00',
    active: true, providerFetchedAt: fetched, revDepAt: fetched, adbEtaAt: fetched, etaAt: fetched, etaSource: 'AeroDataBox (estimated)',
    icao24: '896abc', gate: 'B4', liveTerminal: 'T2', callsign: 'UAE568', status: 'LANDED' }, C);
  let r = mk();
  assert.strictEqual(G.purgeExpiredProviderData(r, fetched + 156 * HOUR - MIN, C), false);
  assert.strictEqual(r.icao24, '896abc');
  assert.strictEqual(G.purgeExpiredProviderData(r, fetched + 156 * HOUR, C), true);
  assert.deepStrictEqual([r.icao24, r.gate, r.revDepAt, r.etaAt, r.providerFetchedAt, r.status], ['', '', null, null, null, 'LANDED']);
  assert.ok(r.schedArrAt, 'coordinator input kept');
  r = mk(); // a misconfigured 30-day retention is capped at 7 days
  assert.strictEqual(G.purgeExpiredProviderData(r, fetched + 168 * HOUR, Object.assign({}, C, { ADB_RETENTION_HOURS: 720 })), true);
});

console.log('usage store, periods, concurrency');
test('10. cycle mode (ADB_BILLING_CYCLE_DAY=1): rollover at IST midnight resets both counters', () => {
  const { G, env, store, usage } = setup({ now: Date.parse('2026-10-31T18:29:00Z'), config: { ADB_BILLING_CYCLE_DAY: '1' } }); // 31 Oct 23:59 IST
  preset(store, '2026-10-05', 400, 200);
  assert.strictEqual(G.adbRequest(SPEC).kind, 'budget');
  env.t = Date.parse('2026-10-31T18:30:00Z'); G.adbResetExecution_(); // 1 Nov 00:00 IST
  assert.ok(G.adbRequest(Object.assign({}, SPEC, { date: '2026-11-01' })).ok);
  assert.deepStrictEqual([usage().units, usage().requests], [2, 1]);
});
test('10b. cycle mode: mid-month and end-of-month reset days', () => {
  const { G } = setup();
  const w = (iso, day) => G.adbWindow_(Date.parse(iso), { ADB_BILLING_CYCLE_DAY: day });
  assert.strictEqual(w('2026-11-10T06:00:00Z', 15).startKey, '2026-10-15');
  assert.strictEqual(w('2026-11-15T06:00:00Z', '15').startKey, '2026-11-15');
  assert.strictEqual(w('2026-01-05T06:00:00Z', 15).startKey, '2025-12-15');
  assert.strictEqual(w('2027-02-28T06:00:00Z', 31).startKey, '2027-02-28'); // 31st -> last day of Feb
  assert.strictEqual(w('2027-03-30T06:00:00Z', 31).startKey, '2027-02-28');
  assert.strictEqual(new Date(w('2026-11-10T06:00:00Z', 15).nextStartMs).toISOString(), '2026-11-14T18:30:00.000Z');
});
test('10c. an auth suspension survives month rollover', () => {
  const { G, env, store } = setup({ now: Date.parse('2026-11-01T06:00:00Z') });
  preset(store, '2026-10-05', 10, 5, { suspended: { kind: 'auth', reason: 'HTTP 401' } });
  assert.strictEqual(G.adbRequest(SPEC).kind, 'suspended');
  assert.strictEqual(env.fetches.length, 0);
});
test('11. interleaved reservations from two executions never exceed the limit or double count', () => {
  const { G, C, env, store, usage } = setup();
  preset(store, '2026-10-20', 396, 0);
  const a = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'A');
  const b = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'B');
  const c = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'C');
  assert.ok(a.ok && b.ok && !c.ok);
  G.adbFinalize_(env, C, a.id, {});
  G.adbFinalize_(env, C, a.id, { extraUnits: 2 }); // second finalise of the same reservation is ignored
  G.adbFinalize_(env, C, b.id, {});
  assert.deepStrictEqual([usage().units, usage().requests, Object.keys(usage().pending).length], [400, 2, 0]);
});
test('11b. if another execution holds the usage lock, nothing is sent (fail closed)', () => {
  const { G, env } = setup();
  env.lock.held = true;
  const r = G.adbRequest(SPEC);
  assert.ok(r.blocked && r.kind === 'store' && /lock busy/.test(r.error));
  assert.strictEqual(env.fetches.length, 0);
});
test('11c. a reservation refunded only when nothing was sent', () => {
  const { G, C, env, usage } = setup();
  const a = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'A');
  G.adbFinalize_(env, C, a.id, { notSent: true });
  assert.deepStrictEqual([usage().units, usage().requests], [0, 0]);
});
test('12. usage-store failures fail closed', () => {
  const cases = [
    (s) => { s.env.propsFail = true; },
    (s) => { s.store.ADB_USAGE_V1 = '{not json'; },
    (s) => { s.store.ADB_USAGE_V1_INIT = '1'; },                                // store deleted after use
    (s) => { preset(s.store, '2026-10-20', 0, 0); const u = JSON.parse(s.store.ADB_USAGE_V1); u.days['2026-10-20'][0] = 'NaN'; s.store.ADB_USAGE_V1 = JSON.stringify(u); },
    (s) => { s.C.ADB_BILLING_CYCLE_DAY = '45'; },                             // invalid period setting
    (s) => { preset(s.store, '2027-01-01', 0, 0); }                             // usage dated in the future
  ];
  cases.forEach((breakIt, i) => {
    const s = setup();
    breakIt(s);
    const r = s.G.adbRequest(SPEC);
    assert.ok(r.blocked && r.kind === 'store', 'case ' + i + ': ' + JSON.stringify(r));
    assert.strictEqual(s.env.fetches.length, 0, 'case ' + i);
    assert.ok(s.G.adbDrainNotices().some((n) => /fail closed/.test(n)), 'case ' + i);
  });
});
test('12b. syncing from the dashboard repairs a corrupted store', () => {
  const s = setup();
  s.store.ADB_USAGE_V1 = 'garbage';
  s.G.adbSetUsage(120, 60);
  assert.deepStrictEqual([s.usage().units, s.usage().requests], [120, 60]);
  assert.ok(s.G.adbRequest(SPEC).ok);
});

console.log('accounting window (billing cycle not assumed)');
test('default is the rolling 33-day window, not a calendar month', () => {
  const { G, C } = setup();
  assert.strictEqual(C.ADB_BILLING_CYCLE_DAY, '');
  const w = G.adbWindow_(Date.parse('2026-11-02T06:00:00Z'), C);
  assert.deepStrictEqual([w.mode, w.startKey], ['rolling', '2026-10-01']);
});
test('rolling: a burst is released only after it leaves the 33-day window', () => {
  const { G, env, store } = setup({ now: Date.parse('2026-10-20T06:00:00Z') });
  preset(store, '2026-10-01', 400, 200);
  const at = (iso) => { env.t = Date.parse(iso); G.adbResetExecution_(); return G.adbRequest(Object.assign({}, SPEC, { date: iso.slice(0, 10) })); };
  assert.strictEqual(at('2026-10-20T06:00:00Z').kind, 'budget');
  assert.strictEqual(at('2026-11-01T06:00:00Z').kind, 'budget', 'calendar month changed, but window still holds 1 Oct');
  assert.strictEqual(at('2026-11-02T06:00:00Z').kind, 'budget', '1 Oct is still inside the 33-day window');
  assert.ok(at('2026-11-03T06:00:00Z').ok, '1 Oct has left the window');
  assert.strictEqual(env.fetches.length, 1);
});
test('rolling: no billing cycle of any reset day or provider timezone ever exceeds 400 units', () => {
  const { G, C, env } = setup({ now: Date.parse('2026-01-01T00:00:00Z') });
  const sent = [];
  const end = Date.parse('2026-07-01T00:00:00Z');
  // Try a request every 3 hours for 6 months: saturates the budget repeatedly.
  for (let t = env.t; t < end; t += 3 * HOUR) {
    env.t = t;
    const r = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'x');
    if (r.ok) { G.adbFinalize_(env, C, r.id, {}); sent.push(env.t); }
  }
  assert.ok(sent.length > 400, 'budget was saturated repeatedly: ' + sent.length);
  let worst = 0;
  for (let day = 1; day <= 31; day++) {
    for (let tz = -12; tz <= 14; tz++) {                 // provider resets at local midnight in any timezone
      for (let y = 2026, m = 0; m < 7; m++) {
        const dim = (mm) => new Date(Date.UTC(y, mm + 1, 0)).getUTCDate();
        const s0 = Date.UTC(y, m, Math.min(day, dim(m))) - tz * HOUR;
        const s1 = Date.UTC(y, m + 1, Math.min(day, dim(m + 1))) - tz * HOUR;
        const units = sent.filter((t) => t >= s0 && t < s1).length * 2;
        worst = Math.max(worst, units);
      }
    }
  }
  assert.ok(worst <= 400, 'worst cycle used ' + worst + ' units');
  assert.ok(worst >= 380, 'window is not needlessly strict: ' + worst);
});
test('cycle mode: provider 429 quota suspends until the next reset, then resumes', () => {
  const { G, env } = setup({ config: { ADB_BILLING_CYCLE_DAY: '15' }, now: Date.parse('2026-11-10T06:00:00Z'),
    responder: () => ({ code: 429, body: 'You have exceeded the MONTHLY quota' }) });
  G.adbRequest(SPEC); G.adbResetExecution_();
  assert.strictEqual(G.adbRequest(SPEC).kind, 'suspended');
  env.t = Date.parse('2026-11-14T18:31:00Z'); env.responder = OK; G.adbResetExecution_(); // 15 Nov 00:01 IST
  assert.ok(G.adbRequest(Object.assign({}, SPEC, { date: '2026-11-15' })).ok);
});
test('old single-total store is migrated conservatively (counted today)', () => {
  const { G, store, usage } = setup();
  store.ADB_USAGE_V1 = JSON.stringify({ v: 1, period: '2026-10', units: 300, requests: 150, pending: {}, warned: {}, suspended: null });
  store.ADB_USAGE_V1_INIT = '1';
  assert.ok(G.adbRequest(SPEC).ok);
  assert.deepStrictEqual([usage().units, usage().requests, usage().raw.v], [302, 151, 2]);
});
test('hourly request cap blocks without sending; resets next hour', () => {
  const { G, env } = setup({ config: { ADB_MAX_REQUESTS_PER_HOUR: 2 }, now: Date.parse('2026-10-20T06:00:00Z') });
  assert.ok(G.adbRequest(SPEC).ok);
  assert.ok(G.adbRequest(Object.assign({}, SPEC, { flight: 'QR572' })).ok);
  const r = G.adbRequest(Object.assign({}, SPEC, { flight: 'AI101' }));
  assert.ok(r.blocked && r.kind === 'ratelimit' && /hourly/.test(r.error), JSON.stringify(r));
  assert.strictEqual(env.fetches.length, 2);
  env.t = Date.parse('2026-10-20T07:00:00Z'); G.adbResetExecution_();
  assert.ok(G.adbRequest(Object.assign({}, SPEC, { flight: 'AI101' })).ok);
});
test('warnings re-arm after usage falls (sync from dashboard)', () => {
  const { G, store } = setup();
  preset(store, '2026-10-20', 278, 0);
  G.adbRequest(SPEC);
  assert.strictEqual(G.adbDrainNotices().length, 1);
  G.adbSetUsage(0, 0, true); // confirmed lowering
  preset(store, '2026-10-20', 278, 0, { warned: JSON.parse(store.ADB_USAGE_V1).warned });
  G.adbResetExecution_();
  G.adbRequest(Object.assign({}, SPEC, { flight: 'QR572' })); // different flight: not served from cache
  assert.strictEqual(G.adbDrainNotices().length, 1);
});

console.log('review regressions (D1-D5)');
test('D1. blank or non-numeric dashboard input is rejected, never read as 0', () => {
  const { G } = setup();
  ['', ' ', 'abc', '-5', '1.5', '12 units'].forEach((t) => assert.strictEqual(G.parseDashboardCount(t), null, JSON.stringify(t)));
  assert.strictEqual(G.parseDashboardCount(' 120 '), 120);
  assert.strictEqual(G.parseDashboardCount('0'), 0);
});
test('D2. sync cannot lower a higher local count without confirmation', () => {
  const { G, env, store, usage } = setup();
  preset(store, '2026-10-20', 400, 200);
  assert.throws(() => G.adbSetUsage(10, 5), (e) => e.lowerBlocked && e.lowerBlocked.units === 400);
  assert.strictEqual(usage().units, 400);
  assert.strictEqual(G.adbRequest(SPEC).kind, 'budget');
  assert.strictEqual(env.fetches.length, 0);
  G.adbSetUsage(10, 5, true);
  assert.strictEqual(usage().units, 10);
  G.adbSetUsage(390, 195); // raising needs no confirmation
  assert.strictEqual(usage().units, 390);
});
test('D2b. sync keeps in-flight reservations (charged on top) and the hourly counter', () => {
  const { G, C, env, usage } = setup();
  const rsv = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'in-flight');
  G.adbSetUsage(100, 50);
  assert.deepStrictEqual([usage().units, usage().requests], [102, 51]);
  assert.strictEqual(usage().raw.hour.n, 1);
  G.adbFinalize_(env, C, rsv.id, {});
  assert.deepStrictEqual([usage().units, usage().requests, Object.keys(usage().pending).length], [102, 51, 0]);
});
test('D3. first-version counter (ADB_UNITS_<month>) is imported, not reset to zero', () => {
  const s = setup();
  s.store['ADB_UNITS_2026-10'] = '399'; // 399 + 2 > 400
  assert.strictEqual(s.G.adbRequest(SPEC).kind, 'budget');
  assert.strictEqual(s.env.fetches.length, 0);
  const s2 = setup({ now: Date.parse('2026-11-02T06:00:00Z') });
  s2.store['ADB_UNITS_2026-10'] = '300';               // last month's counter still counts in rolling mode
  assert.ok(s2.G.adbRequest(Object.assign({}, SPEC, { date: '2026-11-03' })).ok);
  assert.strictEqual(s2.usage().units, 302);
  const s3 = setup();
  s3.store['ADB_UNITS_2026-10'] = 'NaN';
  assert.strictEqual(s3.G.adbRequest(SPEC).kind, 'store');
});
test('D4. rolling window survives request latency at a provider reset instant', () => {
  const { G, C, env } = setup();
  const ist = (y, mo, d, h, mi, sec) => Date.UTC(y, mo - 1, d, h, mi, sec || 0) - 330 * MIN;
  const sent = [];
  const tryAt = (t) => { env.t = t; const r = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'x'); if (r.ok) { G.adbFinalize_(env, C, r.id, {}); sent.push(t); } return r.ok; };
  tryAt(ist(2026, 10, 31, 23, 59, 55));                 // reaches the provider ~15 s later, after a reset at 00:00:05
  for (let i = 0; i < 199; i++) tryAt(ist(2026, 11, 2, 0, 0, 0) + i * 3 * HOUR);
  assert.strictEqual(tryAt(ist(2026, 12, 2, 0, 0, 1)), false, 'B would make the provider cycle 402 units');
  const cStart = ist(2026, 11, 1, 0, 0, 5), cEnd = ist(2026, 12, 2, 0, 0, 5);
  const inCycle = sent.filter((t, i) => (i === 0 ? t + 15000 : t) >= cStart && t < cEnd).length * 2;
  assert.ok(inCycle <= 400, 'provider cycle total ' + inCycle);
});
test('D4b. brute force with request latency up to 12 h: no cycle of any reset day/timezone exceeds 400', () => {
  const { G, C, env } = setup({ now: Date.parse('2026-01-01T00:00:00Z') });
  const sent = [];
  let seed = 7; const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let t = env.t; t < Date.parse('2026-07-01T00:00:00Z'); t += Math.floor(rnd() * 5 * HOUR) + 1000) {
    env.t = t;
    const r = G.adbReserve_(env, C, { units: 2, requests: 1 }, 'x');
    if (r.ok) { G.adbFinalize_(env, C, r.id, {}); sent.push(env.t + Math.floor(rnd() * 12 * HOUR)); } // provider-side time
  }
  let worst = 0;
  for (let day = 1; day <= 31; day++) for (let tz = -12; tz <= 14; tz++) for (let m = 0; m < 7; m++) {
    const dim = (mm) => new Date(Date.UTC(2026, mm + 1, 0)).getUTCDate();
    const s0 = Date.UTC(2026, m, Math.min(day, dim(m))) - tz * HOUR, s1 = Date.UTC(2026, m + 1, Math.min(day, dim(m + 1))) - tz * HOUR;
    worst = Math.max(worst, sent.filter((t) => t >= s0 && t < s1).length * 2);
  }
  assert.ok(worst <= 400, 'worst cycle ' + worst);
});
test('D5. structurally wrong stores fail closed (array days, bad pending, bad suspension)', () => {
  const variants = [
    (u) => { u.days = []; },
    (u) => { u.pending = { x: { u: 2, r: 1, t: 1 } }; },             // no day
    (u) => { u.suspended = { kind: 'quota', until: 'later' }; },
    (u) => { u.hour = []; }
  ];
  variants.forEach((mut, i) => {
    const s = setup();
    preset(s.store, '2026-10-20', 0, 0);
    const u = JSON.parse(s.store.ADB_USAGE_V1); mut(u); s.store.ADB_USAGE_V1 = JSON.stringify(u);
    const r = s.G.adbRequest(SPEC);
    assert.ok(r.blocked && r.kind === 'store', 'variant ' + i + ': ' + JSON.stringify(r));
    assert.strictEqual(s.env.fetches.length, 0);
  });
});

console.log('validation');
test('16. endpoint-specific page-size, range and date validation', () => {
  const { G } = setup();
  const now = Date.parse('2026-10-20T06:00:00Z');
  const v = (spec) => G.validateAdbRequest(spec, now);
  assert.strictEqual(v(SPEC), null);
  assert.ok(/±365/.test(v(Object.assign({}, SPEC, { date: '2027-10-21' }))));
  assert.strictEqual(v(Object.assign({}, SPEC, { date: '2027-10-20' })), null);
  assert.ok(/flight plans/.test(v(Object.assign({}, SPEC, { withFlightPlan: true }))));
  assert.ok(/YYYY-MM-DD/.test(v(Object.assign({}, SPEC, { date: '21/10/2026' }))));
  assert.ok(/normalised/.test(v(Object.assign({}, SPEC, { flight: 'EK 568' }))));
  assert.ok(/dateLocalRole/.test(v(Object.assign({}, SPEC, { role: 'Any' }))));
  assert.ok(/unknown endpoint/.test(v({ endpoint: 'nope' })));
  assert.strictEqual(v({ endpoint: 'flightHistory', from: '2026-10-01', to: '2026-10-08' }), null);
  assert.ok(/7-day/.test(v({ endpoint: 'flightHistory', from: '2026-10-01', to: '2026-10-09' })));
  assert.strictEqual(v({ endpoint: 'fids', from: '2026-10-20T00:00', to: '2026-10-20T12:00' }), null);
  assert.ok(/12-hour/.test(v({ endpoint: 'fids', from: '2026-10-20T00:00', to: '2026-10-20T12:01' })));
  assert.strictEqual(v({ endpoint: 'fleet', pageSize: 10 }), null);
  assert.ok(/1\.\.10/.test(v({ endpoint: 'fleet', pageSize: 11 })));
});
test('16b. invalid or non-enabled requests are never sent or charged', () => {
  const { G, env, store } = setup();
  assert.strictEqual(G.adbRequest(Object.assign({}, SPEC, { date: '2028-01-01' })).kind, 'invalid');
  assert.strictEqual(G.adbRequest({ endpoint: 'fleet', pageSize: 5 }).kind, 'invalid');
  assert.strictEqual(env.fetches.length, 0);
  assert.ok(!store.ADB_USAGE_V1);
});

console.log('tracker behaviour (runTick_ with stubs)');
function harness(s, rows, extra = {}) {
  const sheet = rows;
  const sent = [];
  let os = extra.states || [];
  const props = {};
  Object.assign(s.G, {
    loadExtraAirlines: () => {}, purgeOldLogs_: () => {},
    readFlights: () => JSON.parse(JSON.stringify(sheet)).map((r) => { for (const k of Object.keys(r)) if (k.endsWith('At')) r[k] = s.G.toMs(r[k]); return r; }),
    writeFlights: (out) => out.forEach((r) => Object.assign(sheet.find((x) => x._row === r._row), r)),
    readGroupsSheet: () => [], writeGroupsSheet: () => {},
    // Captures the texts actually handed to the Telegram API (coordinator chat '1'), attribution included.
    TG_ENV: { fetch: (url, o) => { sent.push(JSON.parse(o.payload).text); return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"result":{"message_id":1}}' }; },
      sleep() {}, now: () => s.env.t, secret: () => 'tg-token-for-tests', cache: null, store: () => { throw new Error('no sheet in tests'); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    openskyStates: () => ({ ok: true, states: os })
  });
  return { sheet, sent, setStates: (x) => { os = x; } };
}
const ARR = (over) => Object.assign({ _row: 2, id: 'A', name: 'Dr A', direction: 'Arrival', flightRaw: 'EK 568',
  schedDepIn: '2026-10-21 03:45', schedArrIn: '2026-10-21 08:00', airport: '', terminal: 'T2', active: true }, over);

test('8b. two faculty on the same flight: one AeroDataBox request per tick', () => {
  const s = setup();
  const h = harness(s, [ARR(), ARR({ _row: 3, id: 'B', name: 'Dr B' })]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00'); // past T-6h for both
  s.G.runTick_(s.env.t);
  assert.strictEqual(s.env.fetches.length, 1);
  assert.strictEqual(h.sheet[0].status, 'DELAYED');
  assert.strictEqual(h.sheet[1].status, 'DELAYED');
});
test('13/15. budget exhausted: due lookup -> UNKNOWN + alert; OpenSky keeps tracking', () => {
  const s = setup();
  preset(s.store, '2026-10-20', 400, 200);
  const h = harness(s, [ARR()]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00');
  s.G.runTick_(s.env.t);
  assert.strictEqual(s.env.fetches.length, 0);
  assert.strictEqual(h.sheet[0].status, 'UNKNOWN');
  assert.ok(h.sent.some((t) => /UNKNOWN — lookup not performed/.test(t)), JSON.stringify(h.sent));
  assert.ok(h.sent.some((t) => /lookups suspended \(rolling 33-day window/.test(t)));
  assert.ok(h.sent.every((t) => /AeroDataBox \(https:\/\/aerodatabox\.com\)/.test(t)), 'attribution on every message');

  const t = s.G.parseIstInput('2026-10-21 05:00');
  const BLR = s.G.AIRPORTS.BLR;
  h.setStates([['896abc', 'UAE568', 'UAE', t / 1000, t / 1000, BLR.lon, BLR.lat + 4.5, 11000, false, 250]]);
  h.sent.length = 0;
  s.env.t = t;
  s.G.runTick_(t);
  assert.strictEqual(s.env.fetches.length, 0);
  assert.strictEqual(h.sheet[0].status, 'DEPARTED');
  assert.ok(/^live/.test(h.sheet[0].etaSource));
  assert.ok(h.sent.some((m) => /airborne/.test(m)), JSON.stringify(h.sent));
});
test('14. budget exhausted with FA_KEY: FlightAware used once per flight, no AeroDataBox request', () => {
  const s = setup({ secrets: { FA_KEY: 'fa' } });
  preset(s.store, '2026-10-20', 400, 200);
  let faCalls = 0;
  s.G.faFetch = () => { faCalls++; return { ok: true, info: { status: 'DELAYED', rawStatus: 'Delayed', schedDep: null, revDep: null,
    actualDep: null, depLocalDate: '', schedArr: Date.parse('2026-10-21T02:30:00Z'), estArr: Date.parse('2026-10-21T03:20:00Z'),
    actualArr: null, arrTerminal: '2', arrGate: '', callsign: 'UAE568', icao24: '', source: 'FlightAware' } }; };
  const h = harness(s, [ARR(), ARR({ _row: 3, id: 'B', name: 'Dr B' })]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00');
  s.G.runTick_(s.env.t);
  assert.strictEqual(s.env.fetches.length, 0);
  assert.strictEqual(faCalls, 1);
  assert.strictEqual(h.sheet[0].status, 'DELAYED');
  assert.ok(/FlightAware/.test(h.sheet[0].etaSource));
  assert.ok(/used FlightAware/.test(h.sheet[0].lastError));
});
test('15b. two failed lookups -> UNKNOWN; timeout retry waits 30 min', () => {
  const s = setup({ responder: () => new Error('Timeout') });
  const h = harness(s, [ARR()]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00');
  s.G.runTick_(s.env.t);
  assert.strictEqual(h.sheet[0].nextCheckAt, s.env.t + 30 * MIN);
  assert.strictEqual(s.env.fetches.length, 1);
  s.env.t += 31 * MIN;
  s.G.runTick_(s.env.t);
  assert.strictEqual(s.env.fetches.length, 2);
  assert.strictEqual(h.sheet[0].status, 'UNKNOWN');
  assert.ok(h.sent.some((t) => /No status for EK568.*UNKNOWN/.test(t)), JSON.stringify(h.sent));
});
test('"flight not found" is not retried for 3 h; coordinator alerted once; UNKNOWN', () => {
  const s = setup({ responder: () => ({ code: 204, body: '' }) });
  const h = harness(s, [ARR()]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00');
  s.G.runTick_(s.env.t);
  assert.strictEqual(h.sheet[0].nextCheckAt, s.env.t + 180 * MIN);
  assert.strictEqual(h.sheet[0].status, 'UNKNOWN');
  assert.ok(h.sent.some((t) => /Check the flight number/.test(t)));
  for (let i = 0; i < 30; i++) { s.env.t += 5 * MIN; s.G.runTick_(s.env.t); } // 2.5 h of ticks
  assert.strictEqual(s.env.fetches.length, 1);
});
test('menu "Send cab plan" path uses the same gateway (dedupe + budget)', () => {
  const s = setup();
  preset(s.store, '2026-10-20', 400, 200);
  const h = harness(s, [ARR()]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00');
  s.G.runTick_(s.env.t, { sendPlan: true });
  assert.strictEqual(s.env.fetches.length, 0);
  assert.ok(h.sent.some((t) => /Current cab plan/.test(t)));
});
test('takeoff check skipped when OpenSky already has a live fix', () => {
  const s = setup();
  const h = harness(s, [ARR()]);
  s.env.t = s.G.parseIstInput('2026-10-20 22:00');
  s.G.runTick_(s.env.t);                                   // T-6h check: 1 request
  const t = s.G.parseIstInput('2026-10-21 04:40');          // after revised departure + 10 min
  const BLR = s.G.AIRPORTS.BLR;
  h.setStates([['896abc', 'UAE568', 'UAE', t / 1000, t / 1000, BLR.lon, BLR.lat + 9, 11000, false, 250]]);
  s.env.t = t;
  s.G.runTick_(t);
  assert.strictEqual(s.env.fetches.length, 1, 'no takeoff call');
  assert.strictEqual(h.sheet[0].status, 'DEPARTED');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
