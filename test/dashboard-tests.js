// Overview dashboard (web app) tests: data contract, read-only behaviour, personal-data minimisation and
// layout regressions in the page. Google services are faked. Run: node test/dashboard-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const srcDir = path.join(ROOT, 'src');
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);
const PAGE = fs.readFileSync(path.join(srcDir, 'DashboardPage.html'), 'utf8');

// Built from parts so the doctor's secret scan never sees a token-shaped literal in the repository.
const FAKE_TG = '123456789' + ':AAFakeTokenForTestsOnly_abcdefghijklmnop';
const NOW = Date.parse('2026-10-20T08:00:00Z'); // 13:30 IST

function load(extra) {
  const G = vm.createContext(Object.assign({ console: { log() {}, error() {} } }, extra || {}));
  for (const [f, src] of sources) vm.runInContext(src, G, { filename: f });
  return G;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

// ---- fake spreadsheet: records every write so tests can prove the dashboard never makes one
function fakeSpreadsheet(sheets) {
  const writes = [];
  const sheet = (name, values) => ({
    getLastRow: () => values.length,
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => values.slice(r - 1, r - 1 + nr).map((row) => Array.from({ length: nc }, (_, j) => (row[c - 1 + j] == null ? '' : row[c - 1 + j]))),
      setValues: () => writes.push(name + ' setValues'), setValue: () => writes.push(name + ' setValue'),
      clearContent: () => writes.push(name + ' clearContent')
    }),
    appendRow: () => writes.push(name + ' appendRow'), deleteRows: () => writes.push(name + ' deleteRows')
  });
  const byName = {};
  Object.keys(sheets).forEach((n) => { byName[n] = sheet(n, sheets[n]); });
  return { writes, ss: { getSheetByName: (n) => byName[n] || null, insertSheet: (n) => { writes.push('insertSheet ' + n); return sheet(n, []); } } };
}

function flightsSheet(G, rows) {
  return [G.COLS.map((c) => c.h)].concat(rows.map((o) => G.COLS.map((c) => (o[c.k] == null ? '' : o[c.k]))));
}

const iso = (s) => new Date(Date.parse(s)).toISOString();
const SAMPLE = [
  { id: 'F2', name: 'Prof. A', phone: '+91 98450 00000', email: 'a@example.edu', tg: '5550001', direction: 'Arrival', flightRaw: 'EK 568',
    schedArrIn: '2026-10-20 14:15', terminal: 'T2', active: true, flightNorm: 'EK568', status: 'DELAYED',
    schedArrAt: iso('2026-10-20T08:45:00Z'), etaAt: iso('2026-10-20T09:18:00Z'), etaSource: 'AeroDataBox', groupId: 'A1',
    pickupDisp: 'Tue 20 Oct 15:58', lastCheckDisp: 'Tue 20 Oct 13:20', stateKey: 'EK568|ARR||' + Date.parse('2026-10-20T08:45:00Z') },
  { id: 'F3', name: 'Dr. B', direction: 'Departure', flightRaw: 'BA119', schedDepIn: '2026-10-21 03:00', active: '',
    status: 'SCHEDULED', revDepAt: iso('2026-10-20T22:00:00Z'), lastError: 'Telegram error bot' + FAKE_TG + '/sendMessage' },
  { id: 'F4', name: 'Dr. C', direction: 'Arrival', flightRaw: 'tbd', schedArrIn: '2026-10-20 19:10', active: 'FALSE' },
  { id: '', flightRaw: '' } // blank row: skipped by readFlights
];

function sampleEnv(opts = {}) {
  const G0 = load();
  const sheets = {
    Flights: flightsSheet(G0, SAMPLE),
    Groups: [G0.GROUP_HEADERS, ['A1', 'Arrival', 'BLR', 'T2', 'Tue 20 Oct 15:58', 'Prof. A', 'EK568 14:48', 1, 'Innova', 'Ramesh K.', '5550002', 'F2']],
    Log: [['Time (IST)', 'Level', 'Flight', 'Message'], [new Date(NOW - 60000), 'INFO', 'EK568', 'Delayed; token bot' + FAKE_TG + ' seen']],
    Config: [['Key', 'Value', 'Notes']]
  };
  if (opts.dropFlights) delete sheets.Flights;
  const fake = fakeSpreadsheet(sheets);
  const store = {}, calls = [];
  const G = load({
    SpreadsheetApp: { getActive: () => fake.ss },
    ScriptApp: { getProjectTriggers: () => [{ getHandlerFunction: () => 'tick' }] },
    UrlFetchApp: { fetch: () => { calls.push('fetch'); throw new Error('network call from the dashboard'); } },
    MailApp: { sendEmail: () => calls.push('mail') },
    Date: Object.assign(function (...a) { return a.length ? new Date(...a) : new Date(NOW); }, { now: () => NOW, parse: Date.parse, UTC: Date.UTC })
  });
  G.ADB_ENV = { props: { getProperty: (k) => (k in store ? store[k] : null), setProperty: () => { throw new Error('dashboard wrote a property'); } },
    lock: { tryLock: () => true, releaseLock() {} }, now: () => NOW, logUsage: () => { throw new Error('dashboard logged usage'); } };
  if (opts.assistant) G.askAssistant = () => ({ text: 'x' });
  return { G, fake, calls };
}

console.log('data contract');
test('rows are interpreted exactly as the tracker does (direction, Active, invalid flight, departure time)', () => {
  const { G } = sampleEnv();
  const d = G.getDashboardData();
  assert.strictEqual(d.errors.length, 0, d.errors.join('; '));
  assert.strictEqual(d.flights.length, 3, 'blank row skipped');
  const [a, b, c] = d.flights;
  assert.strictEqual(a.dir, 'ARR'); assert.strictEqual(a.flight, 'EK568'); assert.strictEqual(a.status, 'DELAYED');
  assert.strictEqual(a.etaAt - a.schedAt, 33 * 60000);
  assert.strictEqual(b.dir, 'DEP'); assert.strictEqual(b.active, true, 'blank Active means active (Tracker.prepareRow)');
  assert.strictEqual(b.etaAt, Date.parse('2026-10-20T22:00:00Z'), 'departure estimate is revDepAt, as Tracker shows it');
  assert.strictEqual(c.active, false); assert.strictEqual(c.invalid, true); assert.strictEqual(c.flight, 'tbd');
});
test('times always reach the page as ms numbers or null, whatever the sheet cell held', () => {
  const G = load();
  const d = G.buildDashboardData_({ now: NOW, config: G.defaultConfig(), groups: [], log: [], rows: [
    { _row: 2, id: 'X', direction: 'Arrival', flightRaw: 'EK568', schedArrAt: '2026-10-20T08:45:00.000Z', etaAt: new Date(NOW) },
    { _row: 3, id: 'Y', direction: 'Arrival', flightRaw: 'EK569', schedArrAt: 'not a time', etaAt: '' }] });
  assert.strictEqual(d.flights[0].schedAt, Date.parse('2026-10-20T08:45:00Z'));
  assert.strictEqual(d.flights[0].etaAt, NOW);
  assert.strictEqual(d.flights[1].schedAt, null);
  assert.strictEqual(d.flights[1].etaAt, null);
});
test('groups are joined with their members, pickup and driver', () => {
  const { G } = sampleEnv();
  const g = G.getDashboardData().groups[0];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g)), { id: 'A1', count: 1, vehicle: 'Innova', driver: 'Ramesh K.', pickupDisp: 'Tue 20 Oct 15:58' });
});
test('engine, usage, log and attribution are reported; every value is JSON-safe (no Date objects)', () => {
  const { G } = sampleEnv();
  const d = G.getDashboardData();
  assert.strictEqual(d.tickTriggers, 1);
  assert.strictEqual(d.usage.units, 0); assert.strictEqual(d.usage.unitLimit, 400);
  assert.strictEqual(d.log.length, 1); assert.strictEqual(d.log[0].at, NOW - 60000);
  assert.ok(/AeroDataBox/.test(d.attribution));
  assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(d))), JSON.stringify(d), 'google.script.run needs plain values');
});
test('assistant is off unless a backend function exists (hook for task T6)', () => {
  assert.strictEqual(sampleEnv().G.getDashboardData().assistant.enabled, false);
  assert.strictEqual(sampleEnv({ assistant: true }).G.getDashboardData().assistant.enabled, true);
});

console.log('read-only and failure isolation');
test('loading the dashboard writes nothing, sends nothing and spends no AeroDataBox units', () => {
  const { G, fake, calls } = sampleEnv();
  G.getDashboardData();
  assert.deepStrictEqual(fake.writes, []);
  assert.deepStrictEqual(calls, []);
});
test('a missing sheet is reported but the rest of the page still loads', () => {
  const { G, fake } = sampleEnv({ dropFlights: true });
  const d = G.getDashboardData();
  assert.ok(d.errors.some((e) => /^Flights:/.test(e)), d.errors.join('; '));
  assert.strictEqual(d.flights.length, 0);
  assert.strictEqual(d.groups.length, 1);
  assert.deepStrictEqual(fake.writes, []);
});
test('a broken usage store shows as an error, not as zero usage', () => {
  const { G } = sampleEnv();
  G.ADB_ENV.props.getProperty = (k) => (k === 'ADB_USAGE_V1' ? '{not json' : null);
  const d = G.getDashboardData();
  assert.strictEqual(d.usage, null);
  assert.ok(/not valid JSON/.test(d.usageError));
});

console.log('personal data and secrets');
test('no phone, email or Telegram chat id leaves the server; tokens are redacted', () => {
  const { G } = sampleEnv();
  const text = JSON.stringify(G.getDashboardData());
  ['+91 98450 00000', 'a@example.edu', '5550001', '5550002', FAKE_TG, 'AAFake'].forEach((v) => assert.ok(!text.includes(v), 'leaked ' + v));
});

console.log('page and deployment');
test('doGet serves a page that exists, under a name no script file uses', () => {
  const G = load();
  assert.ok(fs.existsSync(path.join(srcDir, G.DASHBOARD_PAGE + '.html')));
  assert.ok(!fs.existsSync(path.join(srcDir, G.DASHBOARD_PAGE + '.js')), 'Apps Script file names must be unique');
});
test('the page only calls server functions that exist, plus the gated assistant hook', () => {
  const G = load();
  const called = [...PAGE.matchAll(/\.(\w+)\((?:q)?\);?\s*$/gm)].map((m) => m[1]).filter((n) => /^(getDashboardData|askAssistant)$/.test(n));
  assert.ok(called.includes('getDashboardData'));
  assert.strictEqual(typeof G.getDashboardData, 'function');
  assert.ok(/assistant\.enabled[\s\S]*askAssistant\(q\)/.test(PAGE), 'askAssistant is only called when the server reports it');
});
test('layout: fixed sidebar and header start at the top; main clears the header once (no pt-4/top-4 offsets)', () => {
  const tag = (name) => (PAGE.match(new RegExp('<' + name + '\\b[^>]*>')) || [''])[0];
  assert.ok(!/\bpt-4\b/.test(tag('body')), 'body has no top padding');
  ['aside', 'header'].forEach((t) => {
    assert.ok(/\bfixed\b/.test(tag(t)) && /\btop-0\b/.test(tag(t)) && !/\btop-4\b/.test(tag(t)), t + ' must be fixed at top-0');
  });
  assert.ok(/\bh-16\b/.test(tag('header')));
  assert.ok(/\bmt-16\b/.test(tag('main')) && !/\bpt-16\b/.test(tag('main')), 'main offset equals header height, once');
});
test('light theme is the default and every colour token has a dark value', () => {
  const block = (sel) => (PAGE.match(new RegExp(sel.replace(/[[\]"]/g, '\\$&') + '\\s*{([^}]*)}')) || ['', ''])[1];
  const names = (b) => [...b.matchAll(/--([\w-]+):/g)].map((m) => m[1]).sort();
  const light = names(block(':root')), dark = names(block(':root[data-theme="dark"]'));
  assert.ok(light.length > 20);
  assert.deepStrictEqual(dark, light);
  assert.ok(!/<html[^>]*data-theme/.test(PAGE), 'no theme forced in markup');
  assert.ok(/localStorage\.getItem\('ft-theme'\) === 'dark'/.test(PAGE), 'dark only when chosen');
});
test('the page escapes sheet text before inserting it as HTML', () => {
  assert.ok(/var esc = function/.test(PAGE));
  for (const field of ['f.name', 'f.flight', 'f.groupId', 'e.message', 'f.lastError']) {
    const raw = new RegExp("'\\s*\\+\\s*" + field.replace('.', '\\.') + "\\s*\\+\\s*'").test(PAGE);
    assert.ok(!raw, field + ' is concatenated into HTML without esc()');
  }
});
test('manifest: web app defaults to owner-only access', () => {
  const m = JSON.parse(fs.readFileSync(path.join(srcDir, 'appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
