// Local preview Flights page: arrival sorting, filtering and search (tools/flight-sort.js).
// Pure functions, synthetic data only. Run: node test/flight-sort-tests.js
const assert = require('assert');
const path = require('path');
const FS = require(path.join(__dirname, '..', 'tools', 'flight-sort.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

const MIN = 60000;
const NOW = Date.parse('2026-10-20T16:00:00Z'); // 21:30 IST
const at = (m) => NOW + m * MIN;
const arr = (id, o) => Object.assign({ id, flight: id, name: 'Guest ' + id, dir: 'ARR', active: true, final: false, status: 'SCHEDULED' }, o);
const dep = (id, o) => Object.assign(arr(id, o), { dir: 'DEP' }, o);
const ids = (list) => list.map((f) => f.id);
const inbound = (flights, sort) => (FS.buildView(flights, { sort }).sections.find((s) => s.key === 'inbound') || { flights: [] }).flights;

console.log('flight-sort');

test('soonest arrival first, by estimate', () => {
  const list = [arr('A', { schedAt: at(60), etaAt: at(60) }), arr('B', { schedAt: at(30), etaAt: at(30) }), arr('C', { schedAt: at(90), etaAt: at(90) })];
  assert.deepStrictEqual(ids(inbound(list)), ['B', 'A', 'C']);
});

test('delayed flight orders by its new ETA, not its schedule', () => {
  const list = [arr('LATE', { status: 'DELAYED', schedAt: at(20), etaAt: at(120) }), arr('OK', { schedAt: at(60), etaAt: at(60) })];
  assert.deepStrictEqual(ids(inbound(list)), ['OK', 'LATE']);
});

test('updating an ETA reorders the list', () => {
  const a = arr('A', { schedAt: at(30), etaAt: at(30) }), b = arr('B', { schedAt: at(60), etaAt: at(60) });
  assert.deepStrictEqual(ids(inbound([a, b])), ['A', 'B']);
  const a2 = Object.assign({}, a, { etaAt: at(95), status: 'DELAYED' });
  assert.deepStrictEqual(ids(inbound([a2, b])), ['B', 'A']);
});

test('missing ETA falls back to schedule; no time at all goes last', () => {
  const list = [arr('NONE', { schedAt: null, etaAt: null }), arr('SCHED', { schedAt: at(45), etaAt: null }), arr('ETA', { schedAt: at(10), etaAt: at(50) })];
  assert.deepStrictEqual(ids(inbound(list)), ['SCHED', 'ETA', 'NONE']);
  assert.strictEqual(FS.bestTime(list[1]).basis, 'scheduled');
  assert.strictEqual(FS.bestTime(list[0]).ms, null);
});

test('invalid ETAs are never read as zero, now or a parsed display string', () => {
  for (const bad of [0, NaN, Infinity, '', 'TBD', 'Tue 20 Oct 18:05', '18:05', {}, [], true, -5]) {
    const f = arr('X', { schedAt: at(200), etaAt: bad });
    assert.strictEqual(FS.validEtaMs(f), null, 'accepted ' + String(bad));
    assert.strictEqual(FS.arrivalTimeMs(f), at(200), 'no schedule fallback for ' + String(bad));
  }
  // an invalid ETA must not jump the queue ahead of real arrivals
  const list = [arr('BAD', { schedAt: at(200), etaAt: 'Tue 20 Oct 18:05' }), arr('GOOD', { schedAt: at(100), etaAt: at(100) })];
  assert.deepStrictEqual(ids(inbound(list)), ['GOOD', 'BAD']);
});

test('ISO strings are accepted; an ETA far from its schedule is rejected', () => {
  assert.strictEqual(FS.toMs('2026-10-20T16:30:00Z'), at(30));
  const stale = arr('S', { schedAt: at(60), etaAt: at(60 - 3 * 24 * 60) });
  assert.strictEqual(FS.validEtaMs(stale), null);
  assert.strictEqual(FS.arrivalTimeMs(stale), at(60));
});

test('times compare numerically, not as strings', () => {
  // 09:xx sorts after 10:xx lexicographically only if compared as text without padding; ms must win.
  const list = [arr('TEN', { schedAt: Date.parse('2026-10-21T04:30:00Z') }), arr('NINE', { schedAt: Date.parse('2026-10-21T03:45:00Z') })];
  assert.deepStrictEqual(ids(inbound(list)), ['NINE', 'TEN']);
});

test('flights crossing IST midnight order correctly and report +1 day', () => {
  const beforeMidnight = arr('PM', { schedAt: Date.parse('2026-10-20T18:00:00Z') }); // 23:30 IST
  const afterMidnight = arr('AM', { schedAt: Date.parse('2026-10-20T19:10:00Z') });  // 00:40 IST next day
  assert.deepStrictEqual(ids(inbound([afterMidnight, beforeMidnight])), ['PM', 'AM']);
  assert.strictEqual(FS.istDayOffset(beforeMidnight.schedAt, NOW), 0);
  assert.strictEqual(FS.istDayOffset(afterMidnight.schedAt, NOW), 1);
  assert.strictEqual(FS.istDayOffset(null, NOW), null);
});

test('departures are never BLR arrivals and sit in their own section', () => {
  const d = dep('D', { schedAt: at(5), etaAt: at(5) });
  assert.strictEqual(FS.arrivalTimeMs(d), null);
  const v = FS.buildView([d, arr('A', { schedAt: at(50), etaAt: at(50) })], {});
  assert.deepStrictEqual(v.sections.map((s) => s.key), ['inbound', 'outbound']);
  assert.deepStrictEqual(ids(v.sections[0].flights), ['A']);
  assert.deepStrictEqual(FS.upcomingInbounds([d], NOW).length, 0);
});

test('landed, cancelled, diverted, inactive and departed-outbound flights go below active arrivals', () => {
  const list = [
    arr('LANDED', { status: 'LANDED', final: true, schedAt: at(-40), etaAt: at(-35) }),
    arr('CXL', { status: 'CANCELLED', final: true, schedAt: at(-300), etaAt: null }),
    arr('DIV', { status: 'DIVERTED', schedAt: at(10) }),
    arr('OFF', { active: false, status: 'UNKNOWN', schedAt: at(15) }),
    dep('GONE', { status: 'DEPARTED', final: true, schedAt: at(-60) }),
    arr('LIVE', { status: 'DEPARTED', schedAt: at(80), etaAt: at(80) })
  ];
  const v = FS.buildView(list, {});
  assert.deepStrictEqual(v.sections.map((s) => s.key), ['inbound', 'completed']);
  assert.deepStrictEqual(ids(v.sections[0].flights), ['LIVE']);
  assert.deepStrictEqual(ids(v.sections[1].flights), ['OFF', 'DIV', 'LANDED', 'GONE', 'CXL']); // most recent first
});

test('UNKNOWN active arrivals stay inbound, sorted by their schedule', () => {
  const list = [arr('U', { status: 'UNKNOWN', schedAt: at(20), etaAt: null }), arr('K', { schedAt: at(40), etaAt: at(40) })];
  assert.deepStrictEqual(ids(inbound(list)), ['U', 'K']);
});

test('latest and flight-number sorts; unknown times stay last when reversed', () => {
  const list = [arr('BA119', { schedAt: at(30) }), arr('AI506', { schedAt: at(90) }), arr('6E21', { schedAt: null }), arr('AI82', { schedAt: at(60) })];
  assert.deepStrictEqual(ids(inbound(list, 'latest')), ['AI506', 'AI82', 'BA119', '6E21']);
  assert.deepStrictEqual(ids(inbound(list, 'flight')), ['6E21', 'AI82', 'AI506', 'BA119']);
  assert.strictEqual(FS.buildView(list, { sort: 'nonsense' }).sort, 'soonest');
});

test('filters: airborne, delayed, landed, cancelled, unknown, direction', () => {
  const list = [
    arr('AIR', { status: 'DEPARTED', schedAt: at(60), etaAt: at(60) }),
    arr('AIRDLY', { status: 'DELAYED', schedAt: at(30), etaAt: at(70), telemetry: { onGround: false } }),
    arr('SLOW', { status: 'SCHEDULED', schedAt: at(30), etaAt: at(50) }), // +20m without DELAYED status
    arr('LND', { status: 'LANDED', final: true, schedAt: at(-30), etaAt: at(-10) }), // late but completed
    arr('CXL', { status: 'CANCELLED', final: true, schedAt: at(100) }),
    arr('UNK', { status: 'UNKNOWN', schedAt: at(100) }),
    dep('OUT', { status: 'DEPARTED', final: true, schedAt: at(-60) })
  ];
  const pick = (k) => ids(list.filter((f) => FS.matchesFilter(f, k)));
  assert.deepStrictEqual(pick('AIRBORNE'), ['AIR', 'AIRDLY']);
  assert.deepStrictEqual(pick('DELAYED'), ['AIRDLY', 'SLOW']);
  assert.deepStrictEqual(pick('LANDED'), ['LND']);
  assert.deepStrictEqual(pick('CANCELLED'), ['CXL']);
  assert.deepStrictEqual(pick('UNKNOWN'), ['UNK']);
  assert.deepStrictEqual(pick('DEP'), ['OUT']);
  assert.strictEqual(pick('ARR').length, 6);
});

test('search matches flight number with or without spaces, name, origin and destination', () => {
  const f = arr('F1', { flight: 'BA119', name: 'Dr. Sarah Chen', origin: 'LHR', originName: 'London Heathrow', destination: 'BLR' });
  for (const q of ['ba 119', 'BA119', 'sarah', 'lhr', 'heathrow', 'blr', '']) assert.ok(FS.matchesQuery(f, q), q);
  assert.ok(!FS.matchesQuery(f, 'dxb'));
});

test('filter, search and sort combine; counts reflect the searched set', () => {
  const list = [
    arr('EK568', { flight: 'EK568', origin: 'DXB', status: 'DELAYED', schedAt: at(30), etaAt: at(90) }),
    arr('EK564', { flight: 'EK564', origin: 'DXB', schedAt: at(60), etaAt: at(60) }),
    arr('BA119', { flight: 'BA119', origin: 'LHR', schedAt: at(10), etaAt: at(10) }),
    dep('EK565', { flight: 'EK565', origin: 'BLR', destination: 'DXB', schedAt: at(120) })
  ];
  const v = FS.buildView(list, { filter: 'ARR', query: 'dxb', sort: 'soonest' });
  assert.deepStrictEqual(ids(v.ordered), ['EK564', 'EK568']);
  assert.strictEqual(v.counts.ALL, 3);
  assert.strictEqual(v.counts.ARR, 2);
  assert.strictEqual(v.counts.DEP, 1);
  assert.strictEqual(v.counts.DELAYED, 1);
  assert.strictEqual(v.shown, 2);
  assert.strictEqual(v.total, 4);
  // same options after an ETA refresh: filter and query are kept, order follows the new ETA
  list[0] = Object.assign({}, list[0], { etaAt: at(40) });
  assert.deepStrictEqual(ids(FS.buildView(list, { filter: 'ARR', query: 'dxb' }).ordered), ['EK568', 'EK564']);
});

test('upcoming inbounds: window, overdue allowance, order and limit', () => {
  const list = [
    arr('SOON', { schedAt: at(20), etaAt: at(20) }),
    arr('OVERDUE', { status: 'DEPARTED', schedAt: at(-20), etaAt: at(-10) }),
    arr('FAR', { schedAt: at(600) }),
    arr('NOTIME', { schedAt: null }),
    arr('DONE', { status: 'LANDED', final: true, schedAt: at(-5), etaAt: at(-5) }),
    arr('LATER', { schedAt: at(200), etaAt: 'garbage' })
  ];
  assert.deepStrictEqual(ids(FS.upcomingInbounds(list, NOW)), ['OVERDUE', 'SOON', 'LATER']);
  assert.deepStrictEqual(ids(FS.upcomingInbounds(list, NOW, null, 2)), ['OVERDUE', 'SOON']);
});

test('journey progress: landed 1, not departed 0, airborne by elapsed share, unknown null', () => {
  assert.strictEqual(FS.progress(arr('L', { status: 'LANDED' }), NOW), 1);
  assert.strictEqual(FS.progress(arr('S', { schedAt: at(60) }), NOW), 0);
  assert.strictEqual(FS.progress(arr('U', { status: 'UNKNOWN' }), NOW), null);
  const air = arr('A', { status: 'DEPARTED', depActualAt: at(-60), schedAt: at(60), etaAt: at(60) });
  assert.strictEqual(FS.progress(air, NOW), 0.5);
  assert.strictEqual(FS.progress(arr('N', { status: 'DEPARTED', schedAt: at(60) }), NOW), null); // no departure time
});

test('input list is not mutated and blanks are ignored', () => {
  const list = [arr('B', { schedAt: at(60) }), null, arr('A', { schedAt: at(30) })];
  const copy = list.slice();
  FS.buildView(list, {});
  assert.deepStrictEqual(list, copy);
  assert.strictEqual(FS.buildView(list, {}).total, 2);
});

test('flightsFor: a guest whose arrival landed (current leg: the return flight) is still counted and shown under Landed', () => {
  const arr = { id: 'A1', dir: 'ARR', flight: 'LH764', status: 'LANDED', final: true, etaAt: 1000 };
  const dep = { id: 'D1', dir: 'DEP', flight: 'LH765', status: 'SCHEDULED', schedAt: 9000 };
  const other = { id: 'A2', dir: 'ARR', flight: 'EK568', status: 'SCHEDULED', schedAt: 5000 };
  const guests = [{ activeFlight: dep, arrival: arr, departure: dep }, { activeFlight: other, arrival: other }];
  const flightsFor = (k) => guests.map((g) => (k === 'ALL' || FS.matchesFilter(g.activeFlight, k) ? g.activeFlight
    : [g.arrival, g.departure].filter((o) => o && FS.matchesFilter(o, k))[0] || g.activeFlight));
  const landed = FS.buildView([dep, other], { filter: 'LANDED', flightsFor });
  assert.deepStrictEqual([landed.shown, landed.ordered.map((f) => f.id), landed.counts.LANDED, landed.counts.ALL], [1, ['A1'], 1, 2]);
  assert.deepStrictEqual(FS.buildView([dep, other], { filter: 'ALL', flightsFor }).ordered.map((f) => f.id).sort(), ['A2', 'D1'], 'All: the current leg');
  assert.strictEqual(FS.buildView([dep, other], { filter: 'LANDED' }).shown, 0, 'without flightsFor: unchanged behaviour');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
