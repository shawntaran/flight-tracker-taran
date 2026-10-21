// Local preview guest grouping (tools/guest-view.js): one entry per guest, active leg by time.
// Synthetic data only. Run: node test/guest-view-tests.js
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const GV = require(path.join(ROOT, 'tools', 'guest-view.js'));
const FS = require(path.join(ROOT, 'tools', 'flight-sort.js'));
const { mapImportRows } = require(path.join(ROOT, 'tools', 'import-source.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

const HDR = ['Name', 'Arrival Flight', 'Arrival Date', 'Arrival Time', 'Arrival Terminal', 'Departure Flight', 'Departure Date', 'Departure Time', 'Departure Terminal'];
const ROWS = [HDR,
  ['Guest Both', 'BA0119', '2026-10-25', '04:50', 'T2', 'BA0130', '2026-10-31', '02:40', 'T2'],
  ['Guest ArrOnly', '6E 1038', '2026-10-24', '23:50', 'T2', '', '', '', ''],
  ['Guest DepOnly', '', '', '', '', 'EK 569', '2026-11-03', '04:30', 'T2']];
const ms = (iso) => Date.parse(iso + '+05:30');
const guestsAt = (iso) => {
  const now = ms(iso);
  const by = {};
  GV.groupGuests(mapImportRows(ROWS, now, 'BLR').flights, now, FS).forEach((g) => { by[g.name] = g; });
  return by;
};

test('groups 4 legs from 3 rows into exactly 3 guests', () => {
  const now = ms('2026-10-21T12:00:00');
  const flights = mapImportRows(ROWS, now, 'BLR').flights;
  assert.strictEqual(flights.length, 4);
  assert.strictEqual(GV.groupGuests(flights, now, FS).length, 3);
});

test('before landing: arrival is active, departure is later', () => {
  const g = guestsAt('2026-10-21T12:00:00')['Guest Both'];
  assert.strictEqual(g.phase, 'inbound');
  assert.strictEqual(g.active, 'arrival');
  assert.deepStrictEqual(g.legs, { arrival: 'active', departure: 'upcoming' });
  assert.strictEqual(g.activeFlight.flight, 'BA119');
});

test('after the arrival time: departure becomes active, arrival is done', () => {
  const g = guestsAt('2026-10-25T05:00:00')['Guest Both'];
  assert.strictEqual(g.phase, 'outbound');
  assert.deepStrictEqual(g.legs, { arrival: 'done', departure: 'active' });
  assert.strictEqual(g.activeFlight.flight, 'BA130');
});

test('after both legs: completed, last leg kept, nothing active', () => {
  const g = guestsAt('2026-11-01T00:00:00')['Guest Both'];
  assert.strictEqual(g.phase, 'completed');
  assert.strictEqual(g.active, 'departure');
  assert.deepStrictEqual(g.legs, { arrival: 'done', departure: 'done' });
});

test('missing legs are reported as missing; the existing leg is highlighted', () => {
  const by = guestsAt('2026-10-21T12:00:00');
  assert.deepStrictEqual(by['Guest ArrOnly'].legs, { arrival: 'active', departure: 'missing' });
  assert.deepStrictEqual(by['Guest DepOnly'].legs, { arrival: 'missing', departure: 'active' });
  assert.strictEqual(by['Guest DepOnly'].phase, 'outbound');
});

test('one-way arrival in the past: completed, not switched to a missing departure', () => {
  const g = guestsAt('2026-10-26T00:00:00')['Guest ArrOnly'];
  assert.strictEqual(g.phase, 'completed');
  assert.strictEqual(g.active, 'arrival');
});

test('a delayed ETA keeps the arrival active past its scheduled time', () => {
  const now = ms('2026-10-25T05:00:00');
  const f = { id: 'A', name: 'X', dir: 'ARR', schedAt: ms('2026-10-25T04:50:00'), etaAt: ms('2026-10-25T05:40:00'), status: 'DELAYED' };
  assert.strictEqual(GV.groupGuests([f], now, FS)[0].phase, 'inbound');
});

test('names match ignoring case and extra spaces; sort puts inbound before outbound before completed', () => {
  const now = ms('2026-10-25T05:00:00');
  const fl = [
    { id: '1', name: 'Dr.  A', dir: 'ARR', schedAt: ms('2026-10-20T10:00:00') },
    { id: '2', name: 'dr. a', dir: 'DEP', schedAt: ms('2026-10-22T10:00:00') },
    { id: '3', name: 'B', dir: 'DEP', schedAt: ms('2026-10-30T10:00:00') },
    { id: '4', name: 'C', dir: 'ARR', schedAt: ms('2026-10-26T10:00:00') }];
  const gs = GV.groupGuests(fl, now, FS);
  assert.strictEqual(gs.length, 3);
  assert.deepStrictEqual(GV.sortGuests(gs, FS).map((g) => g.phase), ['inbound', 'outbound', 'completed']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
