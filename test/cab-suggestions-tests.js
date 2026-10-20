// Local preview Cab Suggestions (tools/cab-suggestions.js) driven by the real planGroups() from src/Grouping.js.
// Synthetic data only; nothing is written or sent. Run: node test/cab-suggestions-tests.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const CS = require(path.join(ROOT, 'tools', 'cab-suggestions.js'));
const FS = require(path.join(ROOT, 'tools', 'flight-sort.js'));

// Load the production grouping rules exactly as Apps Script would (shared global scope), without changing them.
const G = vm.createContext({ console });
for (const f of ['Util.js', 'Config.js', 'Grouping.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), G, { filename: f });
const C = G.defaultConfig();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

const MIN = 60000;
const NOW = Date.parse('2026-10-20T08:00:00Z');
const at = (m) => NOW + m * MIN;
const arr = (id, o) => Object.assign({ id, flight: 'XX' + id.replace(/\D/g, ''), name: 'Guest ' + id, dir: 'ARR', active: true, final: false,
  status: 'SCHEDULED', airport: 'BLR', terminal: 'T2' }, o);
const build = (flights) => CS.build(flights, { planGroups: G.planGroups, config: C, nowMs: NOW, home: 'BLR', fs: FS });
const ids = (s) => Array.from(s.members, (m) => m.f.id); // planGroups runs in a vm context: normalise its arrays to this realm
const plain = (v) => JSON.parse(JSON.stringify(v));

console.log('cab-suggestions');

test('uses the backend rules: same terminal within the window share; numbering follows pickup time', () => {
  const r = build([arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(80) }), arr('C', { schedAt: at(20), terminal: 'T1' }), arr('D', { schedAt: at(25), terminal: 'T1' })]);
  assert.strictEqual(C.GROUP_WINDOW_MIN, 45);
  assert.deepStrictEqual(plain(r.shared.map(ids)), [['C', 'D'], ['A', 'B']]);
  assert.deepStrictEqual(plain(r.shared.map((s) => s.label)), ['Suggested Cab 1', 'Suggested Cab 2']);
  assert.strictEqual(r.shared[1].pickupMs, at(80 + C.ARRIVAL_BUFFER_MIN)); // last arrival + buffer
  assert.match(r.shared[1].reason, /Arrivals are within 20 minutes · Same terminal \(T2\)/);
});

test('different terminals or a gap beyond the window give individual pickups with a reason', () => {
  const r = build([arr('A', { schedAt: at(30) }), arr('B', { schedAt: at(120) }), arr('C', { schedAt: at(40), terminal: 'T1' })]);
  assert.strictEqual(r.shared.length, 0);
  assert.strictEqual(r.individual.length, 3);
  const byId = Object.fromEntries(r.individual.map((s) => [s.members[0].f.id, s]));
  assert.strictEqual(byId.A.label, 'Individual pickup suggested');
  assert.match(byId.A.reason, /Nearest other T2 arrival is 1h 30m away \(window 45 min\)/);
  assert.match(byId.C.reason, /No other arrival at T1/);
});

test('seat limit splits a busy window and says why', () => {
  const list = ['A', 'B', 'C', 'D', 'E'].map((id, i) => arr(id, { schedAt: at(10 + i * 5) }));
  const r = build(list);
  assert.deepStrictEqual(plain(r.shared.map(ids)), [['A', 'B', 'C', 'D']]);
  assert.strictEqual(r.individual.length, 1);
  assert.match(r.individual[0].reason, /full \(4 seats\)/);
});

test('ETA wins over schedule; an unreadable ETA falls back to the schedule', () => {
  const r = build([arr('LATE', { status: 'DELAYED', schedAt: at(10), etaAt: at(100) }), arr('X', { schedAt: at(90), etaAt: 'Tue 20 Oct 15:00' })]);
  assert.deepStrictEqual(plain(r.shared.map(ids)), [['X', 'LATE']]);
  assert.strictEqual(r.byFlight.X.label, 'Suggested Cab 1');
  assert.strictEqual(r.shared[0].members.find((m) => m.f.id === 'X').basis, 'scheduled');
});

test('cancelled, diverted, inactive, invalid and untimed arrivals are listed as not suggested, departures ignored', () => {
  const r = build([
    arr('CXL', { status: 'CANCELLED', schedAt: at(30) }), arr('DIV', { status: 'DIVERTED', schedAt: at(30) }),
    arr('OFF', { active: false, schedAt: at(30) }), arr('BAD', { invalid: true, flight: 'TBD', schedAt: at(30) }),
    arr('NOTIME', { schedAt: null }), arr('OK', { schedAt: at(30) }),
    Object.assign(arr('DEP', { schedAt: at(30) }), { dir: 'DEP' })
  ]);
  const reasons = Object.fromEntries(r.excluded.map((x) => [x.f.id, x.reason]));
  assert.deepStrictEqual(Object.keys(reasons).sort(), ['BAD', 'CXL', 'DIV', 'NOTIME', 'OFF']);
  assert.match(reasons.CXL, /no pickup needed/);
  assert.match(reasons.NOTIME, /No arrival time/);
  assert.strictEqual(r.individual.length, 1);
  assert.ok(!r.byFlight.DEP);
});

test('landed arrivals still waiting are suggested; pickup in the past is flagged', () => {
  const r = build([arr('L', { status: 'LANDED', final: true, schedAt: at(-60), etaAt: at(-55) })]);
  assert.strictEqual(r.individual.length, 1);
  assert.strictEqual(r.individual[0].pickupPassed, true);
});

test('output carries no driver, vehicle or assignment fields and leaves the input untouched', () => {
  const input = [arr('A', { schedAt: at(30), groupId: 'OLD', pickupDisp: 'x' }), arr('B', { schedAt: at(40) })];
  const copy = JSON.parse(JSON.stringify(input));
  const r = build(input);
  assert.deepStrictEqual(input, copy);
  const text = JSON.stringify({ shared: r.shared.map((s) => Object.keys(s)), info: Object.keys(r.byFlight.A) });
  assert.ok(!/driver|vehicle|assign|dispatch|booked/i.test(text), text);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
