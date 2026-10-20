// Local preview Flights map: position integrity rules (tools/flight-position.js).
// Pure functions, synthetic data only. Run: node test/flight-position-tests.js
const assert = require('assert');
const path = require('path');
const FP = require(path.join(__dirname, '..', 'tools', 'flight-position.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

const MIN = 60000;
const NOW = Date.parse('2026-10-20T09:00:00Z');
const fl = (o) => Object.assign({ id: 'F1', flight: 'AI506', dir: 'ARR', status: 'DEPARTED', airport: 'BLR', origin: 'DEL' }, o);
const tel = (o) => Object.assign({ lat: 20.5, lon: 77.9, onGround: false, fixAt: NOW - 2 * MIN }, o);
const AIRPORTS = { BLR: { lat: 13.1986, lon: 77.7066, name: 'Bengaluru' }, DEL: { lat: 28.5562, lon: 77.1, name: 'Delhi' } };

console.log('flight-position');

test('fresh, stale and grounded follow the fix age and on-ground flag', () => {
  assert.strictEqual(FP.positionState(fl({ telemetry: tel() }), NOW).state, 'fresh');
  assert.strictEqual(FP.positionState(fl({ telemetry: tel({ fixAt: NOW - 20 * MIN }) }), NOW).state, 'fresh');
  const stale = FP.positionState(fl({ telemetry: tel({ fixAt: NOW - 35 * MIN }) }), NOW);
  assert.strictEqual(stale.state, 'stale');
  assert.strictEqual(stale.ageMin, 35);
  assert.strictEqual(FP.positionState(fl({ status: 'LANDED', telemetry: tel({ onGround: true }) }), NOW).state, 'grounded');
  assert.strictEqual(FP.positionState(fl({ telemetry: tel({ onGround: true, fixAt: NOW - 90 * MIN }) }), NOW).state, 'grounded');
});

test('scheduled-only flights are never plotted, even when the schedule says airborne', () => {
  for (const status of ['SCHEDULED', 'DELAYED', 'DEPARTED', 'UNKNOWN']) {
    const p = FP.positionState(fl({ status, telemetry: null, depActualAt: NOW - 60 * MIN, etaAt: NOW + 60 * MIN }), NOW);
    assert.strictEqual(p.state, 'unavailable', status);
    assert.strictEqual(p.lat, null);
  }
  assert.match(FP.positionState(fl({ status: 'SCHEDULED' }), NOW).reason, /Scheduled data only/);
  assert.match(FP.positionState(fl({ dir: 'DEP', status: 'DEPARTED' }), NOW).reason, /Not tracked after departure/);
});

test('invalid coordinates or timestamps are not plotted', () => {
  const bad = [
    tel({ lat: null }), tel({ lat: '20.5' }), tel({ lat: NaN }), tel({ lat: 95 }), tel({ lon: -181 }), tel({ lat: 0, lon: 0 }),
    tel({ fixAt: null }), tel({ fixAt: 'Tue 20 Oct 14:05' }), tel({ fixAt: 0 }),
    tel({ fixAt: NOW + 30 * MIN }), // future
    tel({ fixAt: NOW - 7 * 60 * MIN }) // too old
  ];
  bad.forEach((t, i) => assert.strictEqual(FP.positionState(fl({ telemetry: t }), NOW).state, 'unavailable', 'case ' + i));
});

test('cancelled flights are never plotted, even with an old position', () => {
  assert.strictEqual(FP.positionState(fl({ status: 'CANCELLED', telemetry: tel() }), NOW).state, 'unavailable');
});

test('thresholds can follow the tracker config', () => {
  const f = fl({ telemetry: tel({ fixAt: NOW - 12 * MIN }) });
  assert.strictEqual(FP.positionState(f, NOW, { freshMin: 10 }).state, 'stale');
  assert.strictEqual(FP.positionState(f, NOW, { maxAgeMin: 10 }).state, 'unavailable');
});

test('route ends use known airport coordinates only', () => {
  const r = FP.routeEnds(fl(), AIRPORTS, 'BLR');
  assert.strictEqual(r.origin.code, 'DEL');
  assert.strictEqual(r.dest.code, 'BLR');
  const u = FP.routeEnds(fl({ origin: 'XYZ' }), AIRPORTS, 'BLR');
  assert.strictEqual(u.origin, null);
  assert.deepStrictEqual(FP.greatCircle(u.origin, u.dest), []);
  const dep = FP.routeEnds({ dir: 'DEP', airport: 'BLR', destination: 'DEL' }, AIRPORTS, 'BLR');
  assert.deepStrictEqual([dep.origin.code, dep.dest.code], ['BLR', 'DEL']);
});

test('great circle starts and ends at the airports and stays continuous across the dateline', () => {
  const pts = FP.greatCircle(AIRPORTS.DEL, AIRPORTS.BLR, 10);
  assert.strictEqual(pts.length, 11);
  assert.ok(Math.abs(pts[0][0] - 28.5562) < 1e-6 && Math.abs(pts[10][1] - 77.7066) < 1e-6);
  const pac = FP.greatCircle({ lat: 35, lon: 170 }, { lat: 40, lon: -170 }, 8);
  for (let i = 1; i < pac.length; i++) assert.ok(Math.abs(pac[i][1] - pac[i - 1][1]) < 10, 'jump at ' + i);
});

test('mapItems splits plotted and unplotted flights without inventing positions', () => {
  const list = [fl({ id: 'A', telemetry: tel() }), fl({ id: 'B', status: 'SCHEDULED' }), null, fl({ id: 'C', status: 'CANCELLED', telemetry: tel() })];
  const m = FP.mapItems(list, NOW);
  assert.deepStrictEqual(m.plotted.map((x) => x.f.id), ['A']);
  assert.deepStrictEqual(m.unplotted.map((x) => x.f.id), ['B', 'C']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
