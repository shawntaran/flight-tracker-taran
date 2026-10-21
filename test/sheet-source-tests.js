// Local preview data source (tools/sheet-source.js): the tracker's Flights/Groups/Config/Status tabs mapped to
// the dashboard contract. No network: the Google reader is faked. Run: node test/sheet-source-tests.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'tools', 'sheet-source.js'));
const FS = require(path.join(ROOT, 'tools', 'flight-sort.js'));

// The real Flights schema and attribution, read from the Apps Script source (no copy to drift).
const G = vm.createContext({});
['Sheet.js', 'AdbClient.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), G, { filename: f }));
const HEADERS = G.COLS.map((c) => c.h);
const KEY_TO_HEADER = Object.fromEntries(G.COLS.map((c) => [c.k, c.h]));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log('  ok   ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }));
}

const NOW = Date.parse('2026-10-22T08:00:00Z'); // 13:30 IST
const PHONE = '+91 98450 77777', EMAIL = 'secret.person@example.edu', CHAT = '5550001', DRIVER_CHAT = '5550002';
const redact = (s) => String(s).replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]');

/** Flights tab values from {key: value} rows, in the given header order. */
function flightsTab(rows, headers) {
  const hdr = headers || HEADERS;
  const byHeader = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [KEY_TO_HEADER[k] || k, v]));
  return [hdr].concat(rows.map((o) => { const h = byHeader(o); return hdr.map((x) => (x in h ? h[x] : '')); }));
}

const DELAYED_ROW = { id: 'F2', name: 'Prof. Delayed', phone: PHONE, email: EMAIL, tg: CHAT, notes: 'private note',
  direction: 'Arrival', flightRaw: 'EK 568', schedArrIn: '2026-10-22 14:15', terminal: 'T2', active: true,
  flightNorm: 'EK568', status: 'DELAYED', liveTerminal: 'T2', gate: 'B4', etaSource: 'AeroDataBox (estimated)', groupId: 'A1',
  pickupDisp: 'Thu 22 Oct 15:28', lastCheckDisp: 'Thu 22 Oct 13:20', lastError: 'Telegram error bot123456789:AAFakeTokenForTestsOnly_abcdefghij',
  schedArrAt: '2026-10-22T08:45:00.000Z', etaAt: '2026-10-22T09:18:00.000Z' };
const DEP_ROW = { id: 'F3', name: 'Dr. Leaving', direction: 'Departure', flightRaw: 'BA119', schedDepIn: '2026-10-23 03:00',
  active: '', flightNorm: 'BA119', status: 'DEPARTED', schedDepAt: '', revDepAt: '2026-10-22T22:10:00.000Z' };
const GROUPS = [['Group', 'Direction', 'Airport', 'Terminal', 'Pickup (IST)', 'Members', 'Flights / times', 'Count', 'Vehicle', 'Driver', 'Driver Telegram Chat ID', 'Member IDs'],
  ['A1', 'Arrival', 'BLR', 'T2', 'Thu 22 Oct 15:28', 'Prof. Delayed', 'EK568 14:48', 1, 'Innova', 'Ramesh K.', DRIVER_CHAT, 'F2']];
const STATUS = [['Key', 'Value', 'Notes'], ['LAST_TICK_AT', '2026-10-22T07:55:00.000Z', ''], ['LAST_TICK_RESULT', 'ok', ''],
  ['LAST_TICK_ERROR', '', ''], ['LAST_TICK_LOOKUPS', 1, ''], ['TRIGGER_INSTALLED', 'yes', ''], ['TRACKER_VERSION', 'x', '']];
const CONFIG = [['Key', 'Value', 'Notes'], ['HOME_AIRPORT', 'BLR', ''], ['MAX_SEATS', 6, '']];
const IMPORT = [['Name', 'Arrival Flight', 'Arrival Date', 'Arrival Time', 'Arrival Terminal', 'Departure Flight', 'Departure Date', 'Departure Time', 'Departure Terminal'],
  ['Dr. Import', 'EK 569', '2026-10-25', '04:50', 'T2', '', '', '', '']];

function source(tabs, opts) {
  const reads = [];
  const readRange = async (tab) => { reads.push(tab); return tab in tabs ? (tabs[tab] && tabs[tab].error ? Promise.reject(new Error(tabs[tab].error)) : { rows: tabs[tab] }) : { missing: true }; };
  let t = NOW;
  const get = S.createSheetSource(Object.assign({ readRange, redact, now: () => t, previewSource: 'flights' }, opts || {}));
  return { get, reads, at: (ms) => { t = ms; } };
}
const fullTabs = (flights) => ({ Flights: flights || flightsTab([DELAYED_ROW, DEP_ROW]), Groups: GROUPS, Config: CONFIG, Status: STATUS, Import: IMPORT });

console.log('mapping (Flights tab -> dashboard contract)');
test('the payload has exactly the dashboard contract keys plus source and lastTick', async () => {
  const d = await source(fullTabs()).get();
  assert.deepStrictEqual(Object.keys(d).sort(), ['assistant', 'attribution', 'errors', 'flights', 'generatedAt', 'groups', 'homeAirport', 'lastTick',
    'log', 'maxSeats', 'preview', 'source', 'tickTriggers', 'usage', 'usageError'].sort());
  assert.deepStrictEqual(Object.keys(d.flights[0]).sort(), ['active', 'airport', 'dir', 'etaAt', 'etaSource', 'final', 'flight', 'gate', 'groupId', 'id',
    'invalid', 'lastCheckDisp', 'lastError', 'name', 'pickupDisp', 'schedAt', 'status', 'terminal'].sort());
  assert.strictEqual(d.source, S.SOURCE_FLIGHTS);
  assert.strictEqual(d.attribution, G.ADB_ATTRIBUTION, 'same attribution as the Apps Script dashboard');
  assert.strictEqual(d.maxSeats, 6);
  assert.strictEqual(d.errors.length, 0, d.errors.join('; '));
});
test('columns are found by header name, also when the tab\'s columns are reordered', async () => {
  const reordered = HEADERS.slice().reverse();
  const a = await source(fullTabs()).get(), b = await source(fullTabs(flightsTab([DELAYED_ROW, DEP_ROW], reordered))).get();
  assert.deepStrictEqual(b.flights, a.flights);
  assert.strictEqual(a.flights[0].flight, 'EK568');
  assert.strictEqual(a.flights[0].terminal, 'T2');
  assert.strictEqual(a.flights[0].groupId, 'A1');
});
test('times come from the machine columns (UTC ISO); a blank one falls back to the IST input column', async () => {
  const d = await source(fullTabs()).get();
  const [arr, dep] = d.flights;
  assert.strictEqual(arr.schedAt, Date.parse('2026-10-22T08:45:00Z'));
  assert.strictEqual(arr.etaAt, Date.parse('2026-10-22T09:18:00Z'), 'arrival ETA = m:eta');
  assert.strictEqual(dep.schedAt, Date.parse('2026-10-22T21:30:00Z'), 'm:schedDep blank -> Sched Dep (IST) 2026-10-23 03:00 IST');
  assert.strictEqual(dep.etaAt, Date.parse('2026-10-22T22:10:00Z'), 'departure estimate = m:revDep');
});
test('final follows Tracker.isFinal per direction; blank Active means active', async () => {
  const rows = [Object.assign({}, DELAYED_ROW, { id: 'a', status: 'DEPARTED' }), Object.assign({}, DELAYED_ROW, { id: 'b', status: 'LANDED' }),
    Object.assign({}, DEP_ROW, { id: 'c', status: 'DEPARTED' }), Object.assign({}, DEP_ROW, { id: 'd', status: 'LANDED' }),
    Object.assign({}, DEP_ROW, { id: 'e', status: 'CANCELLED', active: 'FALSE' })];
  const d = await source(fullTabs(flightsTab(rows))).get();
  assert.deepStrictEqual(d.flights.map((f) => [f.id, f.final]), [['a', false], ['b', true], ['c', true], ['d', false], ['e', true]]);
  assert.deepStrictEqual(d.flights.map((f) => f.active), [true, true, true, true, false]);
});
test('a delayed row reads as delayed with live status for the preview\'s assistant (FlightSort rules)', async () => {
  const f = (await source(fullTabs()).get()).flights[0];
  assert.strictEqual(f.status, 'DELAYED');
  assert.ok(FS.isDelayed(f));
  assert.strictEqual(FS.delayMin(f), 33);
  assert.ok(FS.validEtaMs(f) != null, 'assistantOverview() reports liveStatusAvailable when an ETA is valid');
});
test('the preview and the Telegram bot name the same delayed flights from the same Flights tab', async () => {
  const { buildSnapshot } = require(path.join(ROOT, 'local-assistant', 'src', 'snapshot.js'));
  const { delayedText } = require(path.join(ROOT, 'local-assistant', 'src', 'answers.js'));
  const tabs = fullTabs();
  const preview = (await source(tabs).get()).flights.filter((f) => f.active && FS.isDelayed(f)).map((f) => f.flight);
  const bot = delayedText(buildSnapshot({ flights: { rows: tabs.Flights }, groups: { rows: tabs.Groups }, config: { rows: tabs.Config } }, NOW));
  assert.deepStrictEqual(preview, ['EK568']);
  assert.ok(/Delayed \(1\):\n• EK568 /.test(bot), bot);
});
test('groups and the heartbeat are mapped', async () => {
  const d = await source(fullTabs()).get();
  assert.deepStrictEqual(d.groups, [{ id: 'A1', count: 1, vehicle: 'Innova', driver: 'Ramesh K.', pickupDisp: 'Thu 22 Oct 15:28' }]);
  assert.deepStrictEqual(d.lastTick, { at: Date.parse('2026-10-22T07:55:00Z'), result: 'ok', error: '', triggerInstalled: true });
});

console.log('personal data');
test('phone, email, chat ids, notes and member ids never appear in the output; tokens are redacted', async () => {
  const json = JSON.stringify(await source(fullTabs()).get());
  [PHONE, EMAIL, CHAT, DRIVER_CHAT, 'private note', 'AAFakeToken'].forEach((v) => assert.ok(!json.includes(v), 'leaked ' + v));
  assert.ok(!/"F2"\]|memberIds/.test(json), 'Member IDs column not copied');
});

console.log('fallback to the Import tab (never silent)');
for (const [why, flights] of [['missing', undefined], ['no header row', [['x', 'y']]], ['no data rows', [HEADERS]]]) {
  test('Flights tab ' + why + ' -> Import schedules, with an error entry and the source saying so', async () => {
    const tabs = fullTabs();
    if (flights) tabs.Flights = flights; else delete tabs.Flights;
    const d = await source(tabs).get();
    assert.strictEqual(d.source, S.SOURCE_IMPORT);
    assert.strictEqual(d.errors[0], S.FALLBACK_NOTE);
    assert.strictEqual(d.flights[0].name, 'Dr. Import');
    assert.strictEqual(d.flights[0].status, 'SCHEDULED');
  });
}
test('PREVIEW_SOURCE=import reads the Import tab directly (no fallback note)', async () => {
  const s = source(fullTabs(), { previewSource: 'import' });
  const d = await s.get();
  assert.strictEqual(d.source, S.SOURCE_IMPORT);
  assert.ok(!d.errors.includes(S.FALLBACK_NOTE));
  assert.deepStrictEqual(s.reads, ['Import']);
});
test('a Flights read error is reported, not replaced by Import data', async () => {
  const tabs = fullTabs(); tabs.Flights = { error: 'Sheets read of "Flights" failed: HTTP 500' };
  await assert.rejects(source(tabs).get(), /HTTP 500/);
});
test('a missing Status tab is reported as "no heartbeat", not hidden', async () => {
  const tabs = fullTabs(); delete tabs.Status;
  const d = await source(tabs).get();
  assert.strictEqual(d.lastTick, null);
  assert.ok(d.errors.some((e) => /no tracker heartbeat/.test(e)));
});

console.log('cache and the Refresh button');
test('auto-refresh reads at most once a minute; fresh=1 skips the cache, one real read per 5 s', async () => {
  const s = source(fullTabs());
  const flightReads = () => s.reads.filter((t) => t === 'Flights').length;
  await s.get(); assert.strictEqual(flightReads(), 1);
  s.at(NOW + 30000); await s.get(); assert.strictEqual(flightReads(), 1, '60 s cache');
  s.at(NOW + 31000); await s.get({ fresh: true }); assert.strictEqual(flightReads(), 2, 'Refresh click reads now');
  s.at(NOW + 33000); await s.get({ fresh: true }); assert.strictEqual(flightReads(), 2, 'rate limit: < 5 s since the last real read');
  s.at(NOW + 36500); await s.get({ fresh: true }); assert.strictEqual(flightReads(), 3);
  s.at(NOW + 60000); await s.get(); assert.strictEqual(flightReads(), 3, 'the fresh read restarted the 60 s cache');
  s.at(NOW + 97000); await s.get(); assert.strictEqual(flightReads(), 4);
});
test('the preview server passes ?fresh=1 through and the bridge sends it only for Refresh clicks', () => {
  const server = fs.readFileSync(path.join(ROOT, 'tools', 'preview-server.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(ROOT, 'tools', 'mock-bridge.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'tools', 'preview-app.html'), 'utf8');
  assert.ok(/getSheetData\(url\.searchParams\.get\('fresh'\) === '1'\)/.test(server));
  assert.ok(/opts && opts\.fresh \? '\?fresh=1' : ''/.test(bridge));
  assert.ok(/\[data-refresh\]'\)\.forEach\(function \(b\) \{ b\.addEventListener\('click', function \(\) \{ load\(true\); \}\); \}\)/.test(page));
  assert.ok(/setInterval\(function \(\) \{ if \(!document\.hidden\) load\(\); \}, REFRESH_MS\)/.test(page), 'auto-refresh keeps the cache');
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
