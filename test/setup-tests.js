// Secrets, redaction, configuration and setup-diagnostic tests. External services are faked.
// Run: node test/setup-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const srcDir = path.join(ROOT, 'src');
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);

// Built from parts so the doctor's secret scan never sees a token-shaped literal in the repository.
const FAKE_TG = '123456789' + ':AAFakeTokenForTestsOnly_abcdefghijklmnop';
const plain = (x) => JSON.parse(JSON.stringify(x)); // compare values across the VM boundary
const FAKE_ADB = 'fakeRapidApiKeyForTests0123456789abcdef';

function load(extra) {
  const logs = [];
  const G = vm.createContext(Object.assign({ console: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) } }, extra || {}));
  for (const [f, src] of sources) vm.runInContext(src, G, { filename: f });
  return { G, logs };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

console.log('secrets');
test('registry holds exactly the five documented names; two are required', () => {
  const { G } = load();
  assert.deepStrictEqual(plain(G.SECRETS.map((s) => s.name)), ['ADB_KEY', 'TG_BOT_TOKEN', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'FA_KEY']);
  assert.deepStrictEqual(plain(G.SECRETS.filter((s) => s.required).map((s) => s.name)), ['ADB_KEY', 'TG_BOT_TOKEN']);
});
test('every secret the code reads is registered (no aliases)', () => {
  const { G } = load();
  const names = new Set(G.SECRETS.map((s) => s.name));
  for (const [f, src] of sources) {
    for (const m of src.matchAll(/(?:secret|secret_safe_|env\.secret)\('([A-Z0-9_]+)'\)/g)) assert.ok(names.has(m[1]), f + ' reads unregistered ' + m[1]);
    assert.ok(!/getProperty\('(TG_BOT_TOKEN|ADB_KEY|FA_KEY|OPENSKY_CLIENT_ID|OPENSKY_CLIENT_SECRET)'\)/.test(src), f + ' reads a secret without secret()');
  }
});
test('secret() refuses unknown names and trims pasted whitespace', () => {
  const props = { ADB_KEY: '  ' + FAKE_ADB + '\n', TG_BOT_TOKEN: '   ' };
  const { G } = load({ PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) } });
  assert.throws(() => G.secret('RAPIDAPI_KEY'), /Unknown secret name/);
  assert.strictEqual(G.secret('ADB_KEY'), FAKE_ADB);
  assert.strictEqual(G.secret('TG_BOT_TOKEN'), null);
});
test('secret status reports missing / incomplete / suspicious without ever including values', () => {
  const { G } = load();
  const props = { ADB_KEY: FAKE_ADB + ' ', TG_BOT_TOKEN: 'not-a-token-xyz', OPENSKY_CLIENT_ID: 'client-id-1234567' };
  const st = G.secretStatus_((n) => props[n]);
  const by = Object.fromEntries(st.map((s) => [s.name, s]));
  assert.strictEqual(by.ADB_KEY.status, 'suspicious');           // trailing space
  assert.strictEqual(by.TG_BOT_TOKEN.status, 'suspicious');      // wrong shape
  assert.strictEqual(by.OPENSKY_CLIENT_ID.status, 'incomplete'); // pair missing
  assert.strictEqual(by.OPENSKY_CLIENT_SECRET.status, 'missing');
  assert.strictEqual(by.FA_KEY.status, 'missing');
  const text = JSON.stringify(st);
  for (const v of Object.values(props)) assert.ok(!text.includes(v.trim()), 'value leaked');
  const healthy = G.secretStatus_((n) => ({ ADB_KEY: FAKE_ADB, TG_BOT_TOKEN: FAKE_TG })[n]);
  assert.deepStrictEqual(plain(healthy.filter((s) => s.required).map((s) => s.status)), ['ok', 'ok']);
});

console.log('redaction');
test('configured secret values and token-shaped strings are masked', () => {
  const { G } = load();
  G.redactValues_ = [FAKE_ADB, FAKE_TG];
  const out = G.redactSecrets('Address unavailable: https://api.telegram.org/bot' + FAKE_TG + '/sendMessage key=' + FAKE_ADB);
  assert.ok(!out.includes(FAKE_TG) && !out.includes(FAKE_ADB) && !out.includes('AAFake'), out);
  G.redactValues_ = [];
  assert.ok(!G.redactSecrets('url https://api.telegram.org/bot987654321:ZZsomeOtherTokenValue_1234567890abcd/getUpdates').includes('ZZsome'));
});
test('a Telegram network error never reaches the Log sheet or console with the token', () => {
  const rows = [];
  const { G, logs } = load({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'TG_BOT_TOKEN' ? FAKE_TG : null) }) },
    UrlFetchApp: { fetch: (url) => { throw new Error('Exception: Address unavailable: ' + url); } }
  });
  G.getOrCreateSheet_ = () => ({ appendRow: (r) => rows.push(r.join(' | ')), getLastRow: () => 1 });
  const res = G.tgDeliver_([{ chatId: '42', role: 'coordinator', text: 'hello' }], G.defaultConfig());
  assert.strictEqual(res.results[0].state, 'RETRY', 'not delivered, retried later');
  const all = rows.join('\n') + logs.join('\n') + JSON.stringify(res);
  assert.ok(/network error/.test(all), all);
  assert.ok(!all.includes(FAKE_TG) && !all.includes('AAFake'), all);
});
test('"Show Telegram chat ids" with a rejected token throws a message without the token', () => {
  const { G } = load({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'TG_BOT_TOKEN' ? FAKE_TG : null) }) },
    UrlFetchApp: { fetch: (url, opts) => { assert.ok(opts && opts.muteHttpExceptions, 'must not throw with the URL'); return { getResponseCode: () => 401, getContentText: () => '' }; } }
  });
  assert.throws(() => G.listTelegramChats(), (e) => /rejected TG_BOT_TOKEN/.test(e.message) && !e.message.includes(FAKE_TG));
});
test('tick() error handling redacts the log, the alert and the rethrown error', () => {
  const rows = [], alerts = [];
  const { G } = load({
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'TG_BOT_TOKEN' ? FAKE_TG : null) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  });
  G.getOrCreateSheet_ = () => ({ appendRow: (r) => rows.push(r.join(' | ')), getLastRow: () => 1 });
  G.notifyCoordinators_ = (t) => alerts.push(t);
  G.runTick_ = () => { throw new Error('Request failed for https://api.telegram.org/bot' + FAKE_TG + '/sendMessage'); };
  assert.throws(() => G.tick(), (e) => !e.message.includes(FAKE_TG));
  assert.ok(rows.length && !rows.join('').includes(FAKE_TG));
  assert.ok(alerts.length && !alerts.join('').includes(FAKE_TG));
});

console.log('configuration');
test('Config sheet values: blank keeps default, bad number keeps default and is reported', () => {
  const { G } = load();
  const m = G.mergeConfig_([['GROUP_WINDOW_MIN', 'abc'], ['MAX_SEATS', 6], ['HOME_AIRPORT', ''], ['NOTIFY_FACULTY', 'yes']]);
  assert.strictEqual(m.config.GROUP_WINDOW_MIN, 45);
  assert.strictEqual(m.config.MAX_SEATS, 6);
  assert.strictEqual(m.config.HOME_AIRPORT, 'BLR');
  assert.strictEqual(m.config.NOTIFY_FACULTY, true);
  assert.ok(m.issues.some((i) => i.key === 'GROUP_WINDOW_MIN' && i.level === 'error'));
});
test('old values are reported, never silently trusted: obsolete keys, over-plan limits, cycle day 1', () => {
  const { G } = load();
  const m = G.mergeConfig_([['ADB_UNITS_PER_CALL', 2], ['ADB_MONTHLY_UNITS', 600], ['ADB_BILLING_CYCLE_DAY', 1], ['MYSTERY', 3]]);
  const keys = m.issues.map((i) => i.key);
  assert.ok(keys.includes('ADB_UNITS_PER_CALL') && keys.includes('ADB_MONTHLY_UNITS') && keys.includes('ADB_BILLING_CYCLE_DAY') && keys.includes('MYSTERY'));
  assert.strictEqual(G.adbLimits(m.config).units, 400, 'over-plan value is clamped');
  assert.ok(G.mergeConfig_([['ADB_BILLING_CYCLE_DAY', '45']]).issues.some((i) => i.level === 'error'));
  assert.strictEqual(G.mergeConfig_([]).issues.length, 0, 'defaults are clean');
});
test('"Set up sheets" adds missing settings and refreshes notes but never changes a value', () => {
  const { G } = load();
  const existing = [['MAX_SEATS', 6, 'old note'], ['ADB_UNITS_PER_CALL', 2, ''], ['ADB_MONTHLY_UNITS', 600, 'RapidAPI Basic monthly allowance']];
  const plan = G.planConfigSheet_(existing);
  const appended = plan.append.map((r) => r[0]);
  assert.ok(!appended.includes('MAX_SEATS') && appended.includes('ADB_BILLING_CYCLE_DAY') && appended.includes('ADB_MONTHLY_REQUESTS'));
  assert.strictEqual(plan.append.find((r) => r[0] === 'ADB_BILLING_CYCLE_DAY')[1], '', 'new sheets get the safe rolling default');
  assert.ok(plan.notes.some((n) => n.row === 1 && /NOT USED/.test(n.note)));
  assert.ok(plan.notes.every((n) => typeof n.note === 'string'), 'only notes change');
  assert.strictEqual(G.planConfigSheet_(Object.keys(G.DEFAULTS).map((k) => [k, G.DEFAULTS[k][0], G.DEFAULTS[k][1]])).append.length, 0);
});

console.log('setup check (configuration only, no API calls)');
function healthyFacts(G) {
  const sheets = { Flights: G.COLS.map((c) => c.h), Config: ['Key', 'Value', 'Notes'], Groups: G.GROUP_HEADERS, Log: ['Time (IST)'], 'API Usage': G.USAGE_HEADERS, About: ['x'] };
  return {
    secrets: G.secretStatus_((n) => ({ ADB_KEY: FAKE_ADB, TG_BOT_TOKEN: FAKE_TG })[n]),
    config: Object.assign(G.defaultConfig(), { COORD_TG_CHAT_IDS: '111' }), configIssues: [],
    timeZone: 'Asia/Kolkata', sheets, documentLock: true, propsRoundTrip: true, tickTriggers: 1,
    usage: { units: 10, unitLimit: 400, requests: 5, requestLimit: 1600, window: 'rolling 33-day window', suspended: null }
  };
}
test('a healthy project reports no errors and says no API was called', () => {
  const { G } = load();
  const lines = G.setupReport_(healthyFacts(G));
  assert.deepStrictEqual(plain(lines.filter((l) => l.level === 'error')), []);
  assert.ok(/No blocking problems.*No external API was called/.test(G.renderSetupReport_(lines)));
});
test('each broken piece is reported as an error, with no secret values in the text', () => {
  const { G } = load();
  const f = healthyFacts(G);
  f.secrets = G.secretStatus_((n) => ({ TG_BOT_TOKEN: FAKE_TG })[n]);   // ADB_KEY missing
  f.config.COORD_TG_CHAT_IDS = ''; f.timeZone = 'Etc/GMT'; f.documentLock = false; f.propsRoundTrip = false;
  f.sheets.Flights = f.sheets.Flights.slice(0, 10); delete f.sheets['API Usage'];
  f.usage = null; f.usageError = 'usage store failed validation';
  const text = G.renderSetupReport_(G.setupReport_(f));
  ['ADB_KEY', 'Coordinators', 'timezone', 'Document lock', 'Script Properties', 'Sheet Flights', 'Sheet API Usage', 'usage']
    .forEach((w) => assert.ok(new RegExp('❌[^\\n]*' + w).test(text), 'expected an error mentioning ' + w + '\n' + text));
  assert.ok(!text.includes(FAKE_TG));
});
test('trigger states: none = info, duplicates = warning', () => {
  const { G } = load();
  const f = healthyFacts(G);
  f.tickTriggers = 0;
  assert.ok(G.setupReport_(f).some((l) => l.area === 'Tracking' && l.level === 'info'));
  f.tickTriggers = 2;
  assert.ok(G.setupReport_(f).some((l) => l.area === 'Tracking' && l.level === 'warn'));
});
test('lookup summary shows provider data with attribution and never a key', () => {
  const { G } = load();
  const legs = [{ status: 'Expected', departure: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 22:15Z' } },
    arrival: { airport: { iata: 'BLR' }, scheduledTime: { utc: '2026-10-21 02:30Z' }, terminal: '2' } }];
  const s = G.describeLookup_({ ok: true, legs, attempted: true }, { flight: 'EK568', date: '2026-10-21' });
  assert.ok(/DXB → BLR/.test(s) && /AeroDataBox/.test(s) && /terminal 2/.test(s), s);
  assert.ok(/No request was sent/.test(G.describeLookup_({ ok: false, attempted: false, error: 'budget' }, {})));
});

console.log('quota-safety guard on resume');
test('resume needs explicit confirmation to clear a provider-reported quota stop; other stops resume directly', () => {
  const store = {}, usageLog = [];
  const { G } = load();
  const mkStore = (suspended) => {
    store.ADB_USAGE_V1 = JSON.stringify({ v: 2, days: {}, hour: { k: '', n: 0 }, pending: {}, warned: {}, lastReqAt: 0, suspended });
    store.ADB_USAGE_V1_INIT = '1';
  };
  G.ADB_ENV = { props: { getProperty: (k) => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = String(v); } },
    lock: { tryLock: () => true, releaseLock() {} }, now: () => Date.parse('2026-10-20T06:00:00Z'), logUsage: (e) => usageLog.push(e) };
  G.cfg = () => G.defaultConfig();
  mkStore({ kind: 'quota', reason: 'provider reports the quota is used up (HTTP 429)', until: null });
  assert.throws(() => G.adbResume(false), (e) => e.quotaConfirm === true);
  assert.ok(JSON.parse(store.ADB_USAGE_V1).suspended, 'still suspended without confirmation');
  assert.strictEqual(G.adbResume(true).kind, 'quota');
  assert.strictEqual(JSON.parse(store.ADB_USAGE_V1).suspended, null);
  assert.ok(/cleared by a person: quota/.test(usageLog[0].outcome), 'override is recorded');
  mkStore({ kind: 'auth', reason: 'HTTP 401' });
  assert.strictEqual(G.adbResume(false).kind, 'auth');
});

console.log('repository hygiene and test isolation');
test('.env.example lists every secret with an empty value', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
  const { G } = load();
  G.SECRETS.forEach((s) => assert.ok(lines.includes(s.name + '='), s.name + ' missing or has a value'));
  assert.deepStrictEqual(lines.filter((l) => /^[A-Z0-9_]+=\S/.test(l)), []);
});
test('.gitignore covers secrets and real data; examples are not ignored by a broad rule', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
  ['.env', '.env.*', '!.env.example', '.clasprc.json', '.clasp.json', 'node_modules/', '*.xlsx', '*.csv'].forEach((p) => assert.ok(gi.includes(p), 'missing ' + p));
  assert.ok(!gi.includes('*.json') && !gi.includes('*.example') && !gi.includes('src/'), 'too broad');
  const clasp = JSON.parse(fs.readFileSync(path.join(ROOT, '.clasp.json.example'), 'utf8'));
  assert.strictEqual(clasp.rootDir, 'src');
});
test('doctor .gitignore check is immune to the caller\'s git environment and global config', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  if (spawnSync('git', ['--version']).status !== 0) { console.log('       (git not installed: skipped)'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-doctor-test-'));
  try {
    const notARepo = path.join(tmp, 'not-a-repo');          // an inherited GIT_DIR that makes every git command fail
    fs.writeFileSync(notARepo, '');
    const excludes = path.join(tmp, 'excludes');             // a global excludes file that ignores *.json
    fs.writeFileSync(excludes, '*.json\n');
    const gcfg = path.join(tmp, 'gitconfig');
    fs.writeFileSync(gcfg, '[core]\n\texcludesFile = ' + excludes.split(path.sep).join('/') + '\n');
    const base = Object.assign({}, process.env, { DOCTOR_SKIP_TESTS: '1' });
    ['TG_BOT_TOKEN', 'ADB_KEY', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET', 'FA_KEY'].forEach((n) => delete base[n]);
    for (const extra of [{}, { GIT_DIR: notARepo }, { GIT_CONFIG_GLOBAL: gcfg }]) {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'doctor.js')], { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, base, extra) });
      const line = String(r.stdout).split(/\r?\n/).filter((l) => /\.gitignore:/.test(l)).join(' | ');
      assert.ok(/^✔ \.gitignore: 10 sensitive paths ignored, 9 project files kept$/.test(line), JSON.stringify(extra) + ' -> ' + line);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('application code runs sandboxed: it cannot read local environment variables', () => {
  const { G } = load();
  assert.strictEqual(typeof G.process, 'undefined');
  assert.strictEqual(typeof G.require, 'undefined');
  assert.throws(() => vm.runInContext('process.env.ADB_KEY', G), /process is not defined/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
