// Offline tests for the pure parts of the Apps Script code. Run: node test/run-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = vm.createContext({ console });
const srcDir = path.join(__dirname, '..', 'src');
for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()) {
  vm.runInContext(fs.readFileSync(path.join(srcDir, f), 'utf8'), ctx, { filename: f });
}
const G = ctx;
const C = G.defaultConfig();
const MIN = 60000, HOUR = 60 * MIN;
const ist = (s) => G.parseIstInput(s);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const plain = (x) => JSON.parse(JSON.stringify(x));

function row(over) {
  return G.prepareRow(Object.assign({
    _row: 2, id: 'X', name: 'Dr X', direction: 'Arrival', flightRaw: 'EK 568', schedDepIn: '', schedArrIn: '',
    airport: '', terminal: 'T2', active: true, flags: '', groupSig: '', alertedStatus: '', adbCalls: '', failCount: ''
  }, over), C);
}

console.log('normalizeFlight');
test('IATA with space / dash / leading zero', () => {
  assert.strictEqual(G.normalizeFlight('EK 568').flight, 'EK568');
  assert.strictEqual(G.normalizeFlight('ek-0568').flight, 'EK568');
  assert.strictEqual(G.normalizeFlight('BA 0256').flight, 'BA256');
  assert.strictEqual(G.normalizeFlight('6E 123').flight, '6E123');
});
test('ICAO prefix and airline names', () => {
  assert.strictEqual(G.normalizeFlight('UAE568').flight, 'EK568');
  assert.strictEqual(G.normalizeFlight('Emirates 568').flight, 'EK568');
  assert.strictEqual(G.normalizeFlight('Air India Express 1234').flight, 'IX1234');
  assert.strictEqual(G.normalizeFlight('Qatar Airways 572').flight, 'QR572');
});
test('callsign guess', () => assert.strictEqual(G.normalizeFlight('EK568').callsign, 'UAE568'));
test('garbage -> null', () => {
  assert.strictEqual(G.normalizeFlight('tbd'), null);
  assert.strictEqual(G.normalizeFlight(''), null);
  assert.strictEqual(G.normalizeFlight('Unknown Air 12'), null);
});

console.log('time');
test('IST input -> UTC', () => {
  assert.strictEqual(new Date(ist('2026-10-20 14:35')).toISOString(), '2026-10-20T09:05:00.000Z');
  assert.strictEqual(new Date(ist('20/10/2026 2:35 PM')).toISOString(), '2026-10-20T09:05:00.000Z');
  assert.strictEqual(new Date(ist('21-10-2026 12:10 am')).toISOString(), '2026-10-20T18:40:00.000Z');
});
test('display in IST', () => {
  assert.strictEqual(G.fmtIST(Date.parse('2026-10-20T09:05:00Z')), 'Tue 20 Oct 14:35');
  assert.strictEqual(G.istDateKey(Date.parse('2026-10-20T19:00:00Z')), '2026-10-21');
  assert.strictEqual(G.isoOrBlank(''), '');
});

console.log('AeroDataBox parsing');
const adbLegs = [
  { status: 'Delayed', callSign: 'UAE568', aircraft: { modeS: '896ABC' },
    departure: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 22:15Z', local: '2026-10-21 02:15+04:00' },
      revisedTime: { utc: '2026-10-20 23:00Z' } },
    arrival: { airport: { iata: 'BLR' }, scheduledTime: { utc: '2026-10-21 02:30Z' }, revisedTime: { utc: '2026-10-21 03:10Z' },
      terminal: '2', gate: 'B4' } },
  { status: 'Expected', departure: { airport: { iata: 'BLR' } }, arrival: { airport: { iata: 'MAA' } } }
];
test('picks the leg arriving at BLR and maps fields', () => {
  const i = G.parseAdbLegs(adbLegs, 'BLR', 'ARR');
  assert.strictEqual(i.status, 'DELAYED');
  assert.strictEqual(new Date(i.estArr).toISOString(), '2026-10-21T03:10:00.000Z');
  assert.strictEqual(i.icao24, '896abc');
  assert.strictEqual(i.callsign, 'UAE568');
  assert.strictEqual(i.depLocalDate, '2026-10-21');
  assert.strictEqual(i.arrTerminal, '2');
});
test('runway time means departed', () => {
  const legs = plain(adbLegs);
  legs[0].status = 'Expected';
  legs[0].departure.runwayTime = { utc: '2026-10-20 23:05Z' };
  assert.strictEqual(G.parseAdbLegs(legs, 'BLR', 'ARR').status, 'DEPARTED');
});
test('no leg for this airport -> null', () => assert.strictEqual(G.parseAdbLegs(adbLegs, 'HYD', 'ARR'), null));

console.log('OpenSky ETA');
const BLR = G.AIRPORTS.BLR;
const now = Date.parse('2026-10-21T02:00:00Z');
test('500 km out at 250 m/s -> ~33 min + approach', () => {
  // ~500 km due north of BLR (1 deg lat ~ 111.2 km)
  const st = ['896abc', 'UAE568 ', 'UAE', now / 1000, now / 1000, BLR.lon, BLR.lat + 4.497, 11000, false, 250];
  const e = G.liveEta(st, BLR, now, C);
  const mins = (e.etaMs - now) / MIN;
  assert.ok(Math.abs(e.distKm - 500) < 2, 'dist ' + e.distKm);
  assert.ok(Math.abs(mins - (500 / 0.25 / 60 + 20)) < 1, 'mins ' + mins);
});
test('on ground near airport -> landed; stale -> stale', () => {
  const st = ['896abc', 'UAE568', 'UAE', now / 1000, now / 1000, BLR.lon + 0.01, BLR.lat, 0, true, 5];
  assert.ok(G.liveEta(st, BLR, now, C).landed);
  const old = st.slice(); old[3] = old[4] = (now - 40 * MIN) / 1000;
  assert.ok(G.liveEta(old, BLR, now, C).stale);
});
test('findState by icao24 then callsign', () => {
  const states = [['aaa111', 'QTR572  '], ['896abc', 'XXX']];
  assert.strictEqual(G.findState(states, '896abc', 'UAE568')[0], '896abc');
  assert.strictEqual(G.findState(states, '', 'QTR572')[0], 'aaa111');
  assert.strictEqual(G.findState(states, 'zzz', 'NOPE'), null);
});

console.log('grouping');
function arr(id, t, over) {
  const r = row(Object.assign({ id, name: id, schedArrIn: t }, over));
  r.etaAt = r.schedArrAt;
  return r;
}
const t0 = ist('2026-10-21 08:00');
test('45-min window from the first person', () => {
  const rows = [arr('A', '2026-10-21 10:00'), arr('B', '2026-10-21 10:30'), arr('C', '2026-10-21 10:50')];
  const p = G.planGroups(rows, C, t0);
  assert.strictEqual(p.groups.length, 2);
  assert.deepStrictEqual(plain(p.groups[0].items.map((i) => i.r.id)), ['A', 'B']);
  assert.strictEqual(G.fmtTimeIST(p.groups[0].pickupMs), '11:10'); // 10:30 + 40
  assert.strictEqual(p.groups[0].id, 'A-BLR-T2-1021-1');
});
test('seat cap, terminals and cancellations', () => {
  const rows = ['A', 'B', 'C', 'D', 'E'].map((id, i) => arr(id, '2026-10-21 10:0' + i));
  rows.push(arr('T1x', '2026-10-21 10:00', { terminal: 'T1' }));
  const cx = arr('CX', '2026-10-21 10:00'); cx.status = 'CANCELLED'; rows.push(cx);
  const p = G.planGroups(rows, C, t0);
  const sizes = p.groups.map((g) => g.terminal + ':' + g.items.length).sort();
  assert.deepStrictEqual(plain(sizes), ['T1:1', 'T2:1', 'T2:4']);
  assert.ok(!p.byRow.CX);
});
test('departures group on check-in time, pickup before earliest', () => {
  const d1 = row({ id: 'D1', direction: 'Departure', flightRaw: 'EK569', schedDepIn: '2026-10-22 03:00' });
  const d2 = row({ id: 'D2', direction: 'Departure', flightRaw: 'QR573', schedDepIn: '2026-10-22 03:40' });
  const p = G.planGroups([d1, d2], C, t0);
  assert.strictEqual(p.groups.length, 1);
  assert.strictEqual(G.fmtIST(p.groups[0].pickupMs), 'Wed 21 Oct 22:30'); // 00:00 check-in - 90 min
});
test('notifications only on real change', () => {
  const rows = [arr('A', '2026-10-21 10:00'), arr('B', '2026-10-21 10:30')];
  let gc = G.applyGroups(rows, G.planGroups(rows, C, t0), C);
  assert.strictEqual(gc.fresh.length, 1); assert.strictEqual(gc.changed.length, 0);
  rows[1].etaAt += 5 * MIN;                                   // small drift: silent
  gc = G.applyGroups(rows, G.planGroups(rows, C, t0), C);
  assert.strictEqual(gc.changed.length + gc.fresh.length, 0);
  assert.strictEqual(rows[0].pickupDisp, 'Wed 21 Oct 11:15');  // display still moves
  rows[1].etaAt += 30 * MIN;                                  // B now 11:05 -> own cab
  gc = G.applyGroups(rows, G.planGroups(rows, C, t0), C);
  assert.strictEqual(gc.changed.length, 2);
});
test('drivers follow the group with most shared members', () => {
  const rows = [arr('A', '2026-10-21 10:00'), arr('B', '2026-10-21 10:20')];
  const p = G.planGroups(rows, C, t0);
  G.carryDrivers(p.groups, [{ memberIds: ['A', 'Z'], driver: 'Ravi', driverTg: '42', vehicle: 'Innova' }]);
  assert.strictEqual(p.groups[0].driver, 'Ravi');
});

console.log('lifecycle (arrival, no Sched Dep given)');
test('T-24h enrich -> T-6h -> takeoff -> live ETA -> landed', () => {
  const r = row({ schedArrIn: '2026-10-21 08:00' });            // 02:30Z
  assert.strictEqual(new Date(G.initialCheckTime(r, C)).toISOString(), '2026-10-20T02:30:00.000Z');
  assert.strictEqual(G.detectChange(r, C), null);              // silent baseline

  let tNow = Date.parse('2026-10-20T02:31:00Z');
  const info = G.parseAdbLegs(plain(adbLegs), 'BLR', 'ARR');
  info.status = 'SCHEDULED'; info.revDep = null; info.estArr = null;
  G.applyInfo(r, info, tNow);
  assert.strictEqual(new Date(r.schedDepAt).toISOString(), '2026-10-20T22:15:00.000Z');
  assert.strictEqual(new Date(G.nextCheckTime(r, tNow, C)).toISOString(), '2026-10-20T16:15:00.000Z'); // dep - 6h
  assert.strictEqual(G.detectChange(r, C), null);

  tNow = Date.parse('2026-10-20T16:16:00Z');                    // T-6h: delayed 45 min
  G.applyInfo(r, G.parseAdbLegs(plain(adbLegs), 'BLR', 'ARR'), tNow);
  let msg = G.detectChange(r, C);
  assert.ok(/DELAYED/.test(msg) && /\+40 min/.test(msg), msg);
  assert.strictEqual(new Date(G.nextCheckTime(r, tNow, C)).toISOString(), '2026-10-20T23:10:00.000Z'); // revDep + 10

  tNow = Date.parse('2026-10-21T01:00:00Z');                    // airborne, seen live, ETA 20 min later than airline
  G.applyLive(r, { etaMs: Date.parse('2026-10-21T03:30:00Z'), distKm: 900, fixMs: tNow }, tNow);
  msg = G.detectChange(r, C);
  assert.ok(/airborne/.test(msg) && /\+20 min/.test(msg) && /live/.test(msg), msg);

  tNow += 10 * MIN;                                             // lost coverage: keep last live ETA, no alert
  G.applyLive(r, null, tNow);
  assert.ok(/last live fix/.test(r.etaSource));
  assert.strictEqual(G.detectChange(r, C), null);

  tNow = Date.parse('2026-10-21T03:28:00Z');
  G.applyLive(r, { landed: true, fixMs: tNow }, tNow);
  msg = G.detectChange(r, C);
  assert.ok(/LANDED/.test(msg), msg);
  assert.strictEqual(G.nextCheckTime(r, tNow, C), null);
  assert.ok(!G.isTrackable(r));
});
test('ADB "Delayed" does not undo an OpenSky "airborne"', () => {
  const r = row({ schedArrIn: '2026-10-21 08:00' });
  r.status = 'DEPARTED'; r.etaSource = 'live (OpenSky, 900 km out)'; r.etaAt = 123;
  G.applyInfo(r, G.parseAdbLegs(plain(adbLegs), 'BLR', 'ARR'), now);
  assert.strictEqual(r.status, 'DEPARTED');
  assert.strictEqual(r.etaAt, 123);
});
test('editing the flight resets machine state', () => {
  const r = row({ schedArrIn: '2026-10-21 08:00' });
  r.status = 'DELAYED'; r.adbCalls = 3; r.alertedStatus = 'DELAYED';
  r.flightRaw = 'QR 572';
  G.prepareRow(r, C);
  assert.strictEqual(r.flightNorm, 'QR572');
  assert.strictEqual(r.status, 'SCHEDULED');
  assert.strictEqual(r.adbCalls, 0);
  assert.strictEqual(r.callsign, 'QTR572');
});
test('departure rows: one T-6h check, delay alert names new time', () => {
  const r = row({ direction: 'Departure', flightRaw: 'EK569', schedDepIn: '2026-10-22 04:00' });
  assert.strictEqual(G.detectChange(r, C), null);
  const tNow = r.schedDepAt - 6 * HOUR + MIN;
  r.revDepAt = r.schedDepAt + HOUR; r.status = 'DELAYED';
  assert.strictEqual(G.nextCheckTime(r, tNow, C), null);
  assert.ok(/now Thu 22 Oct 05:00 IST \(\+60 min\)/.test(G.detectChange(r, C)));
});
test('bad input is flagged', () => {
  assert.strictEqual(row({ flightRaw: 'tbd' }).lastError, 'Cannot parse flight number "tbd"');
  assert.strictEqual(row({}).lastError, 'Need Sched Arr (IST)');
});

console.log('first-leg connection check');
function freshCtx() {
  const c = vm.createContext({ console });
  for (const f of fs.readdirSync(srcDir).filter((x) => x.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(srcDir, f), 'utf8'), c, { filename: f });
  }
  return c;
}
// First-leg flight number XY1 operates two legs that day; AeroDataBox lists the unrelated one first.
// legs[0]: MCT -> DOH, lands 19:00Z (3 h before the onward flight: looks "fine").
// legs[1]: LHR -> DXB (the connection), predicted 21:50Z (25 min before the onward flight: a real risk).
const legFixture = () => [
  { status: 'Expected', departure: { airport: { iata: 'MCT' } },
    arrival: { airport: { iata: 'DOH' }, scheduledTime: { utc: '2026-10-20 19:00Z' } } },
  { status: 'Delayed', departure: { airport: { iata: 'LHR' } },
    arrival: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 20:00Z' }, predictedTime: { utc: '2026-10-20 21:50Z' } } }
];
const onwardDep = Date.parse('2026-10-20T22:15:00Z'); // EK568 DXB -> BLR
test('selector picks the leg arriving at the connection airport, not legs[0]', () => {
  const p = G.selectFirstLeg_(legFixture(), 'DXB', onwardDep);
  assert.strictEqual(p.leg.arrival.airport.iata, 'DXB');
  assert.strictEqual(new Date(p.arr).toISOString(), '2026-10-20T21:50:00.000Z'); // predicted time preferred
});
test('selector never falls back to an unrelated leg', () => {
  const p = G.selectFirstLeg_(legFixture(), 'MCT', onwardDep);
  assert.strictEqual(p.leg, null);
  assert.ok(/no leg of it arrives at MCT/.test(p.reason), p.reason);
  assert.strictEqual(G.selectFirstLeg_([], 'DXB', onwardDep).leg, null);
});
test('selector without a known connection airport uses arrival time', () => {
  const legs = legFixture();
  // Both land before the onward departure (19:00Z, 21:50Z) -> the latest one, DXB
  assert.strictEqual(G.selectFirstLeg_(legs, '', onwardDep).leg.arrival.airport.iata, 'DXB');
  // Both land after an 18:00Z onward departure -> the earliest (the tightest miss), DOH
  assert.strictEqual(G.selectFirstLeg_(legs, '', Date.parse('2026-10-20T18:00:00Z')).leg.arrival.airport.iata, 'DOH');
  // Single leg -> that leg, even without times
  assert.ok(G.selectFirstLeg_([{ arrival: { airport: { iata: 'DXB' } } }], '', onwardDep).leg);
  // Several legs and no times -> refuse to guess
  const r = G.selectFirstLeg_([{ arrival: {} }, { arrival: {} }], '', onwardDep);
  assert.ok(r.leg === null && /no times/.test(r.reason));
});
test('several legs into the connection airport: latest arrival before the onward departure', () => {
  const legs = [
    { arrival: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 12:00Z' } } },
    { arrival: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 21:00Z' } } },
    { arrival: { airport: { iata: 'DXB' }, scheduledTime: { utc: '2026-10-20 23:00Z' } } }
  ];
  assert.strictEqual(new Date(G.selectFirstLeg_(legs, 'DXB', onwardDep).arr).toISOString(), '2026-10-20T21:00:00.000Z');
});
test('AeroDataBox and FlightAware parsers report the departure airport (in memory only)', () => {
  assert.strictEqual(G.parseAdbLegs(plain(adbLegs), 'BLR', 'ARR').depAirport, 'DXB');
  const fa = G.parseFaFlights([{ origin: { code_iata: 'DXB' }, destination: { code_iata: 'BLR' }, scheduled_in: '2026-10-21T02:30:00Z' }],
    'BLR', 'ARR', Date.parse('2026-10-21T02:30:00Z'));
  assert.strictEqual(fa.depAirport, 'DXB');
  assert.ok(!G.COLS.some((c) => /depAirport|connection/i.test(c.k)), 'no schema change');
});
/** responder: legs array | gateway result | (spec, callNo) => either. at(ms) runs the check again (a later tick). */
function firstLegRun(responder, info, opts) {
  opts = opts || {};
  const c = freshCtx();
  const coord = [], calls = [];
  c.logEvent = () => {};
  c.adbRequest = (spec) => {
    calls.push(spec);
    const x = typeof responder === 'function' ? responder(spec, calls.length) : responder;
    return Array.isArray(x) ? { ok: true, legs: x, attempted: true } : x;
  };
  const r = c.prepareRow({ _row: 2, id: 'A', name: 'Dr A', direction: 'Arrival', flightRaw: 'EK568', firstLeg: 'XY 1',
    schedArrIn: '2026-10-21 08:00', active: true, flags: '', adbCalls: '', failCount: '' }, c.defaultConfig());
  r.schedDepAt = onwardDep; r.depLocalDate = '2026-10-21';
  if (opts.adbCalls) r.adbCalls = opts.adbCalls;
  if (opts.status) r.status = opts.status;
  const C = c.defaultConfig(), out = { coord: (t) => coord.push(t) };
  const at = (ms) => c.checkFirstLeg_(r, C, out, info, ms);
  at(opts.now || onwardDep - 6 * HOUR); // fixed clock: never the real time
  return { coord, calls, r, c, at };
}
test('connection risk is judged on the right leg (legs[0] alone would have said "fine")', () => {
  const { coord, calls } = firstLegRun(legFixture(), { depAirport: 'DXB' });
  assert.deepStrictEqual(plain(calls), [{ endpoint: 'flightStatus', flight: 'XY1', date: '2026-10-21', role: 'Arrival' }]);
  assert.strictEqual(coord.length, 1);
  assert.ok(/Connection risk for Dr A: first leg XY1 lands at DXB/.test(coord[0]), coord[0]); // 21:50Z vs 22:15Z = 25 min < 60
});
test('a cancelled unrelated leg does not raise a false alarm; a cancelled feeding leg does', () => {
  const legs = legFixture();
  legs[0].status = 'Canceled';                                         // DXB->DOH: irrelevant
  legs[1].predictedTime = undefined; legs[1].arrival.predictedTime = undefined; // DXB arrival 20:00Z: 135 min margin
  assert.strictEqual(firstLegRun(legs, { depAirport: 'DXB' }).coord.length, 0);
  legs[1].status = 'CanceledUncertain';
  const out = firstLegRun(legs, { depAirport: 'DXB' }).coord;
  assert.ok(out.length === 1 && /is CANCELLED/.test(out[0]), out.join('|'));
});
test('no matching leg: previous date tried once (overnight), then coordinators are told it was not checked', () => {
  // Behaviour changed deliberately: before giving up, one previous-local-date lookup covers overnight layovers.
  const run = firstLegRun(legFixture(), { depAirport: 'MCT' });
  assert.strictEqual(run.coord.length, 0, 'no verdict yet');
  assert.ok(!run.c.hasFlag(run.r, 'FIRSTLEG'));
  run.at(onwardDep - 6 * HOUR + 5 * MIN);                              // next tick
  assert.deepStrictEqual(plain(run.calls.map((s) => s.date)), ['2026-10-21', '2026-10-20']);
  assert.ok(run.coord.length === 1 && /Connection not checked/.test(run.coord[0]) && /First Leg Flight/.test(run.coord[0]) &&
    /previous date 2026-10-20 was checked too/.test(run.coord[0]), run.coord[0]);
  assert.ok(run.c.hasFlag(run.r, 'FIRSTLEG'));
  run.at(onwardDep - 5 * HOUR);
  assert.strictEqual(run.calls.length, 2, 'no retry loop');
});
test('a blocked first-leg lookup stays unflagged so it is retried after the next main check', () => {
  const { coord, r, c } = firstLegRun({ ok: false, blocked: true, kind: 'budget', error: 'budget', attempted: false }, { depAirport: 'DXB' });
  assert.strictEqual(coord.length, 0);
  assert.ok(!c.hasFlag(r, 'FIRSTLEG'));
});

// ---------------------------------------------------------------------------------------------
const mkLeg = (from, to, depZ, arrZ, status, extra) => Object.assign({ status: status || 'Expected',
  departure: { airport: { iata: from }, scheduledTime: depZ ? { utc: depZ } : undefined },
  arrival: { airport: { iata: to }, scheduledTime: arrZ ? { utc: arrZ } : undefined } }, extra || {});
const faFlight = (extra) => Object.assign({ origin: { code_iata: 'DXB' }, destination: { code_iata: 'BLR' },
  scheduled_out: '2026-10-20T22:15:00Z', scheduled_in: '2026-10-21T02:30:00Z', estimated_in: '2026-10-21T03:00:00Z', status: 'Scheduled' }, extra || {});
const ADB_500 = { ok: false, kind: 'http', error: 'AeroDataBox HTTP 500: boom', attempted: true };

/** fetchFlightInfo with stubbed gateway and FlightAware. */
function providerCtx(adb, fa, secrets) {
  const c = freshCtx();
  const calls = { adb: 0, fa: 0 };
  c.secret = (k) => (secrets || { FA_KEY: 'fake' })[k] || null;
  c.adbRequest = () => { calls.adb++; return typeof adb === 'function' ? adb(calls.adb) : adb; };
  c.faFetch = () => { calls.fa++; return typeof fa === 'function' ? fa(calls.fa) : fa; };
  const r = c.prepareRow({ _row: 2, id: 'A', name: 'Dr A', direction: 'Arrival', flightRaw: 'EK568',
    schedDepIn: '2026-10-21 03:45', schedArrIn: '2026-10-21 08:00', active: true, flags: '', adbCalls: '', failCount: '' }, c.defaultConfig());
  return { c, calls, r };
}

console.log('provider attempt accounting');
test('AeroDataBox failure + FlightAware success = 2 attempts, fallback keeps the AeroDataBox failure', () => {
  const { c, calls, r } = providerCtx(ADB_500, () => ({ ok: true, attempted: true, info: freshCtx().faFlightInfo_(faFlight(), 'ARR') }));
  const res = c.fetchFlightInfo(r, 4);
  assert.ok(res.ok && res.fallback);
  assert.strictEqual(res.attempts, 2);
  assert.strictEqual(res.adbKind, 'http');
  assert.ok(/HTTP 500/.test(res.adbError));
  assert.deepStrictEqual(plain(calls), { adb: 1, fa: 1 });
});
test('AeroDataBox failure + FlightAware failure = 2 attempts, both errors reported', () => {
  const { c, r } = providerCtx(ADB_500, { ok: false, attempted: true, kind: 'http', error: 'FlightAware HTTP 503' });
  const res = c.fetchFlightInfo(r, 4);
  assert.ok(!res.ok && res.attempts === 2 && !res.blocked);
  assert.ok(/HTTP 500/.test(res.error) && /FlightAware HTTP 503/.test(res.error), res.error);
});
test('cache hits, dedupes, rejected and blocked requests count 0 attempts', () => {
  const legs = [mkLeg('DXB', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z')];
  for (const adb of [{ ok: true, legs, cached: true, attempted: false }, { ok: true, legs, deduped: true, attempted: false }]) {
    assert.strictEqual(providerCtx(adb, null, {}).c.fetchFlightInfo(providerCtx(adb, null, {}).r, 4).attempts, 0);
  }
  const rejected = { ok: false, kind: 'invalid', error: 'rejected', attempted: false };
  const blocked = { ok: false, blocked: true, kind: 'budget', error: 'budget', attempted: false };
  assert.strictEqual(providerCtx(rejected, null, {}).c.fetchFlightInfo(providerCtx(rejected, null, {}).r, 4).attempts, 0);
  const b = providerCtx(blocked, null, {});
  const res = b.c.fetchFlightInfo(b.r, 4);
  assert.ok(res.blocked && res.attempts === 0);
  // FlightAware answer reused from this execution's memo: also 0
  const m = providerCtx(blocked, () => { throw new Error('must not be called'); });
  m.c.faMemo_[m.r.flightNorm + '|2026-10-21|ARR|BLR'] = { ok: false, attempted: true, kind: 'http', error: 'FlightAware HTTP 503' };
  const res2 = m.c.fetchFlightInfo(m.r, 4);
  assert.ok(res2.blocked && res2.attempts === 0, JSON.stringify(res2));
});
test('FlightAware is skipped when AeroDataBox used the last allowed attempt', () => {
  const { c, calls, r } = providerCtx(ADB_500, () => { throw new Error('must not be called'); });
  const res = c.fetchFlightInfo(r, 1);
  assert.ok(!res.ok && res.attempts === 1 && /FlightAware skipped: per-flight request cap/.test(res.error));
  assert.strictEqual(calls.fa, 0);
  assert.strictEqual(c.fetchFlightInfo(r, 0).attempts, 0);
  assert.strictEqual(calls.adb, 1, 'no request at all with nothing left');
});

/** runTick_ in a fresh sandbox with stubbed sheet, gateway and FlightAware. */
function tickHarness(rows, opts) {
  const c = freshCtx();
  const sheet = rows, sent = [], adbCalls = [], faCalls = [];
  const C = Object.assign(c.defaultConfig(), { COORD_TG_CHAT_IDS: '1' }, opts.config || {});
  Object.assign(c, {
    cfg: () => C, secret: (k) => (opts.secrets || {})[k] || null, loadExtraAirlines() {}, purgeOldLogs_() {},
    readFlights: () => JSON.parse(JSON.stringify(sheet)).map((r) => { for (const k of Object.keys(r)) if (k.endsWith('At')) r[k] = c.toMs(r[k]); return r; }),
    writeFlights: (out) => out.forEach((r) => Object.assign(sheet.find((s) => s._row === r._row), r)),
    readGroupsSheet: () => [], writeGroupsSheet() {}, logEvent() {},
    notifyCoordinators_: (t) => sent.push(t), sendTelegram_() {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    openskyStates: () => ({ ok: true, states: [] }),
    adbRequest: (spec) => { adbCalls.push(spec); return opts.adb(spec, adbCalls.length); },
    faFetch: () => { faCalls.push(1); return opts.fa(faCalls.length); }
  });
  return { c, sheet, sent, adbCalls, faCalls, run: (iso) => c.runTick_(c.parseIstInput(iso)) };
}
const tickRow = (over) => Object.assign({ _row: 2, id: 'A', name: 'Dr A', direction: 'Arrival', flightRaw: 'EK 568',
  schedDepIn: '2026-10-21 03:45', schedArrIn: '2026-10-21 08:00', airport: '', terminal: 'T1', active: true }, over || {});

test('a row stops exactly at the cap: 3 used + AeroDataBox fails -> FlightAware not sent, 4 used, then silence', () => {
  const h = tickHarness([tickRow({ adbCalls: 3 })], { secrets: { FA_KEY: 'fake' }, adb: () => ADB_500, fa: () => { throw new Error('over cap'); } });
  h.run('2026-10-20 22:00');
  assert.strictEqual(h.sheet[0].adbCalls, 4);
  assert.strictEqual(h.faCalls.length, 0);
  h.run('2026-10-20 22:20'); h.run('2026-10-21 01:00');
  assert.strictEqual(h.adbCalls.length, 1, 'no further requests once the cap is reached');
});
test('2 used + AeroDataBox and FlightAware both fail -> exactly 4, nothing more', () => {
  const h = tickHarness([tickRow({ adbCalls: 2 })], { secrets: { FA_KEY: 'fake' }, adb: () => ADB_500,
    fa: () => ({ ok: false, attempted: true, kind: 'http', error: 'FlightAware HTTP 503' }) });
  h.run('2026-10-20 22:00');
  assert.strictEqual(h.sheet[0].adbCalls, 4);
  h.run('2026-10-20 22:20');
  assert.deepStrictEqual([h.adbCalls.length, h.faCalls.length], [1, 1]);
});
test('fallback success is usable but not "healthy": AeroDataBox context kept, flagged, cleared on recovery', () => {
  let adbOk = false;
  const legs = [mkLeg('DXB', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z', 'EnRoute')];
  const h = tickHarness([tickRow()], { secrets: { FA_KEY: 'fake' },
    adb: () => (adbOk ? { ok: true, legs, attempted: true } : ADB_500),
    fa: () => ({ ok: true, attempted: true, info: freshCtx().faFlightInfo_(faFlight(), 'ARR') }) });
  h.run('2026-10-20 22:00');
  const row = h.sheet[0];
  assert.strictEqual(row.adbCalls, 2);
  assert.ok(/AeroDataBox failed \(http\); used FlightAware backup/.test(row.lastError), row.lastError);
  assert.ok(/FALLBACK/.test(row.flags) && /\[backup\]/.test(row.etaSource), row.etaSource);
  assert.ok(h.sent.some((t) => /status taken from the FlightAware backup/.test(t)));
  adbOk = true;
  h.run('2026-10-21 04:00');                                            // takeoff check, AeroDataBox back
  assert.strictEqual(h.sheet[0].lastError, '');
  assert.ok(!/FALLBACK/.test(h.sheet[0].flags));
});

console.log('main-flight identity');
const twoBlr = (a1, a2) => [mkLeg('DXB', 'BLR', null, a1), mkLeg('DXB', 'BLR', null, a2)];
test('same flight number twice on one date: the instance closest to the row\'s time is used', () => {
  const legs = twoBlr('2026-10-21 02:30Z', '2026-10-21 14:30Z');
  assert.strictEqual(new Date(G.parseAdbLegs(legs, 'BLR', 'ARR', { arr: ist('2026-10-21 08:00') }).schedArr).toISOString(), '2026-10-21T02:30:00.000Z');
  assert.strictEqual(new Date(G.parseAdbLegs(legs, 'BLR', 'ARR', { arr: ist('2026-10-21 20:30') }).schedArr).toISOString(), '2026-10-21T14:30:00.000Z');
});
test('no reliable match is an identity mismatch, never a guess', () => {
  const far = G.pickAdbLeg_([mkLeg('DXB', 'BLR', null, '2026-10-21 12:00Z')], 'BLR', 'ARR', { arr: ist('2026-10-21 08:00') });
  assert.ok(far.leg === null && far.kind === 'identity' && /more than 4 h/.test(far.reason), far.reason);
  const tie = G.pickAdbLeg_(twoBlr('2026-10-21 01:30Z', '2026-10-21 03:30Z'), 'BLR', 'ARR', { arr: ist('2026-10-21 08:00') });
  assert.ok(tie.leg === null && tie.kind === 'identity' && /about equally close/.test(tie.reason), tie.reason);
  const noTime = G.pickAdbLeg_(twoBlr('2026-10-21 02:30Z', '2026-10-21 14:30Z'), 'BLR', 'ARR', {});
  assert.ok(noTime.leg === null && /no scheduled time on the row/.test(noTime.reason));
  assert.strictEqual(G.pickAdbLeg_(legFixture(), 'BLR', 'ARR', {}).kind, 'nomatch');
  assert.ok(G.parseAdbLegs(legFixture(), '', 'ARR'), 'diagnostics display (no airport) still shows the first leg');
});
test('FlightAware results across the ±18 h window: same rule, other days are not taken', () => {
  const flights = [faFlight({ scheduled_in: '2026-10-20T02:30:00Z' }), faFlight(), faFlight({ scheduled_in: '2026-10-22T02:30:00Z' })];
  assert.strictEqual(new Date(G.parseFaFlights(flights, 'BLR', 'ARR', ist('2026-10-21 08:00')).schedArr).toISOString(), '2026-10-21T02:30:00.000Z');
  const p = G.pickFaFlight_([faFlight({ scheduled_in: '2026-10-21T20:00:00Z' })], 'BLR', 'ARR', { arr: ist('2026-10-21 08:00') });
  assert.ok(p.flight === null && p.kind === 'identity');
});
test('identity mismatch in a tick: UNKNOWN, actionable message once, nothing applied, no paid FlightAware guess', () => {
  const h = tickHarness([tickRow()], { secrets: { FA_KEY: 'fake' },
    adb: () => ({ ok: true, attempted: true, legs: twoBlr('2026-10-21 09:00Z', '2026-10-21 10:00Z') }),
    fa: () => { throw new Error('must not be called'); } });
  h.run('2026-10-20 22:00');
  const row = h.sheet[0];
  assert.strictEqual(row.status, 'UNKNOWN');
  assert.ok(/^IDENTITY MISMATCH: /.test(row.lastError) && /none within 4 h/.test(row.lastError), row.lastError);
  assert.ok(!row.liveTerminal && !row.providerFetchedAt, 'no provider data applied');
  assert.strictEqual(row.nextCheckAt, ist('2026-10-20 22:00') + 180 * MIN);
  const msgs = h.sent.filter((t) => /could not tell which flight is meant/.test(t) && /Sched Arr \(IST\)/.test(t));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(h.faCalls.length, 0);
  h.run('2026-10-21 01:01');
  assert.strictEqual(h.sent.filter((t) => /could not tell which flight is meant/.test(t)).length, 1, 'not repeated');
});

console.log('first-leg reliability');
const okLegs = () => legFixture();
const T = (k, err, extra) => Object.assign({ ok: false, kind: k, error: err || k, attempted: true }, extra || {});
test('timeout, then success on the retry 30 min later (2 requests, counted)', () => {
  const run = firstLegRun((s, n) => (n === 1 ? T('unknown', 'AeroDataBox outcome unknown (Timeout)', { uncertain: true }) : okLegs()), { depAirport: 'DXB' });
  assert.strictEqual(run.coord.length, 0);
  assert.strictEqual(run.r.adbCalls, 1);
  run.at(onwardDep - 6 * HOUR + 10 * MIN);
  assert.strictEqual(run.calls.length, 1, 'waits for the retry time');
  run.at(onwardDep - 6 * HOUR + 31 * MIN);
  assert.strictEqual(run.calls.length, 2);
  assert.strictEqual(run.r.adbCalls, 2);
  assert.ok(run.c.hasFlag(run.r, 'FIRSTLEG'));
  assert.ok(run.coord.length === 1 && /Connection risk/.test(run.coord[0]), run.coord.join('|'));
});
test('5xx twice: retried once, then "not checked" (never silent)', () => {
  const run = firstLegRun(() => T('http', 'AeroDataBox HTTP 503: down'), { depAirport: 'DXB' });
  run.at(onwardDep - 6 * HOUR + 31 * MIN);
  assert.strictEqual(run.calls.length, 2);
  assert.ok(run.coord.length === 1 && /Connection not checked/.test(run.coord[0]) && /after 2 requests/.test(run.coord[0]), run.coord[0]);
  run.at(onwardDep - 4 * HOUR);
  assert.strictEqual(run.calls.length, 2);
});
test('not found (204): overnight lookup on the previous date finds the feeding leg', () => {
  const prevDayLeg = [mkLeg('LHR', 'DXB', null, '2026-10-20 21:40Z')];
  const run = firstLegRun((s) => (s.date === '2026-10-21' ? T('notfound', 'AeroDataBox: no flight XY1 on 2026-10-21') : prevDayLeg), { depAirport: 'DXB' });
  run.at(onwardDep - 6 * HOUR + 5 * MIN);
  assert.deepStrictEqual(plain(run.calls.map((s) => s.date)), ['2026-10-21', '2026-10-20']);
  assert.ok(run.coord.length === 1 && /Connection risk.*lands at DXB/.test(run.coord[0]), run.coord.join('|')); // 35 min margin
});
test('not found with no known connection airport: no guessing on another date, immediate "not checked"', () => {
  const run = firstLegRun(T('notfound', 'AeroDataBox: no flight XY1 on 2026-10-21'), {});
  assert.strictEqual(run.calls.length, 1);
  assert.ok(run.coord.length === 1 && /Connection not checked/.test(run.coord[0]));
});
test('terminal failures (auth, rejected) are reported at once', () => {
  for (const res of [T('auth', 'AeroDataBox HTTP 401: check ADB_KEY'), { ok: false, kind: 'invalid', error: 'rejected', attempted: false }]) {
    const run = firstLegRun(res, { depAirport: 'DXB' });
    assert.ok(run.coord.length === 1 && /Connection not checked/.test(run.coord[0]), JSON.stringify(res));
    assert.ok(run.c.hasFlag(run.r, 'FIRSTLEG'));
  }
});
test('first-leg requests never use the row\'s last call; that is reported, not silent', () => {
  const run = firstLegRun(() => { throw new Error('must not be called'); }, { depAirport: 'DXB' }, { adbCalls: 3 });
  assert.strictEqual(run.calls.length, 0);
  assert.ok(run.coord.length === 1 && /request cap \(4\) is needed for the main flight/.test(run.coord[0]), run.coord[0]);
});
test('blocked until shortly before the onward departure -> "not checked" before it leaves', () => {
  const run = firstLegRun({ ok: false, blocked: true, kind: 'budget', error: 'budget', attempted: false }, { depAirport: 'DXB' });
  assert.strictEqual(run.coord.length, 0);
  assert.strictEqual(run.r.adbCalls, 0);
  run.at(onwardDep - 30 * MIN);
  assert.ok(run.coord.length === 1 && /could not be completed before the onward flight/.test(run.coord[0]), run.coord.join('|'));
});
test('cancelled main flight or a deduped first-leg answer: no charge, no noise', () => {
  const cx = firstLegRun(() => { throw new Error('must not be called'); }, { depAirport: 'DXB' }, { status: 'CANCELLED' });
  assert.ok(cx.calls.length === 0 && cx.coord.length === 0 && cx.c.hasFlag(cx.r, 'FIRSTLEG'));
  const dd = firstLegRun({ ok: true, legs: legFixture(), deduped: true, attempted: false }, { depAirport: 'DXB' });
  assert.strictEqual(dd.r.adbCalls, 0);
});

console.log('terminal/gate freshness');
test('a successful response without terminal/gate clears stale provider values; coordinator terminal kept', () => {
  const c = freshCtx();
  const r = c.prepareRow({ _row: 2, id: 'A', direction: 'Arrival', flightRaw: 'EK568', schedArrIn: '2026-10-21 08:00',
    terminal: 'T1', active: true, flags: '' }, c.defaultConfig());
  c.applyInfo(r, c.adbLegInfo_(mkLeg('DXB', 'BLR', null, '2026-10-21 02:30Z', 'Expected', { arrival: { airport: { iata: 'BLR' }, terminal: '2', gate: 'B4' } }), 'ARR'), 1);
  assert.deepStrictEqual([r.liveTerminal, r.gate], ['T2', 'B4']);
  c.applyInfo(r, c.adbLegInfo_(mkLeg('DXB', 'BLR', null, '2026-10-21 02:30Z'), 'ARR'), 2);
  assert.deepStrictEqual([r.liveTerminal, r.gate, r.terminal], ['', '', 'T1']);
  c.applyInfo(r, c.faFlightInfo_(faFlight({ terminal_destination: null, gate_destination: '' }), 'ARR'), 3);
  assert.deepStrictEqual([r.liveTerminal, r.gate], ['', '']);
  r.liveTerminal = '';
  const plan = c.planGroups([Object.assign(r, { etaAt: ist('2026-10-21 08:00') })], c.defaultConfig(), ist('2026-10-21 05:00'));
  assert.strictEqual(plan.groups[0].terminal, 'T1', 'grouping falls back to the coordinator terminal');
});

console.log('provider parsing resilience');
function faCtx(body, code) {
  const c = freshCtx();
  c.secret = (k) => (k === 'FA_KEY' ? 'fake' : null);
  c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => code || 200, getContentText: () => body }) };
  return c;
}
test('malformed or partial FlightAware JSON is a counted provider failure, not a crash', () => {
  for (const body of ['not json{', 'null', '[]', '{"flights":"x"}', '{}']) {
    const res = faCtx(body).faFetch('EK568', 'UAE568', ist('2026-10-21 08:00'), 'BLR', 'ARR');
    assert.ok(!res.ok && res.attempted && res.kind === 'parse', body + ' -> ' + JSON.stringify(res));
  }
  const partial = JSON.stringify({ flights: [null, 7, { destination: null }, faFlight({ scheduled_in: 'garbage', estimated_in: 'also garbage' })] });
  const res = faCtx(partial).faFetch('EK568', '', ist('2026-10-21 08:00'), 'BLR', 'ARR');
  assert.ok(res.ok && res.info.schedArr === null && res.info.estArr === null, JSON.stringify(res));
  const net = freshCtx(); net.secret = () => 'fake'; net.UrlFetchApp = { fetch: () => { throw new Error('Timeout'); } };
  const n = net.faFetch('EK568', '', ist('2026-10-21 08:00'), 'BLR', 'ARR');
  assert.ok(!n.ok && n.attempted && n.uncertain);
});
test('a tick survives malformed FlightAware JSON and moves on to the next row', () => {
  const h = tickHarness([tickRow(), tickRow({ _row: 3, id: 'B', name: 'Dr B', flightRaw: 'QR 572' })], { secrets: { FA_KEY: 'fake' },
    adb: (spec) => (spec.flight === 'EK568' ? ADB_500 : { ok: true, attempted: true, legs: [mkLeg('DOH', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z')] }),
    fa: () => faCtx('<html>gateway error</html>').faFetch('EK568', '', ist('2026-10-21 08:00'), 'BLR', 'ARR') });
  h.run('2026-10-20 22:00');
  assert.ok(/malformed JSON/.test(h.sheet[0].lastError), h.sheet[0].lastError);
  assert.strictEqual(h.sheet[0].adbCalls, 2);
  assert.strictEqual(h.sheet[1].lastError, '');
  assert.ok(h.sheet[1].providerFetchedAt);
});
test('AeroDataBox legs: null entries and status spellings are handled', () => {
  assert.strictEqual(G.parseAdbLegs([null, 5, 'x'], 'BLR', 'ARR'), null);
  const leg = (s) => [mkLeg('DXB', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z', s)];
  assert.strictEqual(G.parseAdbLegs([null].concat(leg('Cancelled')), 'BLR', 'ARR').status, 'CANCELLED');
  assert.strictEqual(G.parseAdbLegs(leg('En Route'), 'BLR', 'ARR').status, 'DEPARTED');
  assert.strictEqual(G.parseAdbLegs(leg('arrived'), 'BLR', 'ARR').status, 'LANDED');
  assert.strictEqual(G.parseAdbLegs(leg('canceled uncertain'), 'BLR', 'ARR').status, 'CANCELLED');
  const bad = leg('Expected'); bad[0].arrival.scheduledTime = { utc: 'not a time' };
  assert.strictEqual(G.parseAdbLegs(bad, 'BLR', 'ARR').schedArr, null);
});
test('OpenSky: malformed vectors are skipped or read as stale, never as "landed"', () => {
  const c = freshCtx();
  c.secret = () => null;
  c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ states: [null, 'x', ['abc123', 'UAE568 ']] }) }) };
  const os = c.openskyStates([]);
  assert.ok(os.ok && os.states.length === 1);
  assert.ok(c.findState([null, 7, ['abc123', 'UAE568']], '', 'UAE568'));
  c.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => 'null' }) };
  assert.strictEqual(c.openskyStates([]).ok, false);
  const now = Date.parse('2026-10-21T02:00:00Z'), BLR = G.AIRPORTS.BLR;
  const v = (over) => Object.assign(['abc123', 'UAE568', 'UAE', now / 1000, now / 1000, BLR.lon, BLR.lat, 0, false, 5], over);
  assert.ok(G.liveEta(v({ 8: 'false' }), BLR, now, C).stale, 'string on_ground is not trusted');
  assert.ok(G.liveEta(v({ 5: String(BLR.lon) }), BLR, now, C).stale, 'string coordinates are not trusted');
  assert.ok(G.liveEta(v({ 3: null, 4: null }), BLR, now, C).stale, 'no timestamp');
  assert.ok(G.liveEta(v({ 8: true }), BLR, now, C).landed, 'a well-formed vector still works');
});
test('an uncertain cancellation never overrides a live airborne fix', () => {
  const c = freshCtx();
  const r = c.prepareRow({ _row: 2, id: 'A', direction: 'Arrival', flightRaw: 'EK568', schedArrIn: '2026-10-21 08:00', active: true, flags: '' }, c.defaultConfig());
  const now = Date.parse('2026-10-21T01:00:00Z');
  r.status = 'DEPARTED'; r.etaSource = 'live (OpenSky, 900 km out)'; r.lastFixAt = now - 5 * MIN;
  const notes = c.applyInfo(r, c.adbLegInfo_(mkLeg('DXB', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z', 'CanceledUncertain'), 'ARR'), now);
  assert.strictEqual(r.status, 'DEPARTED');
  assert.ok(notes.length === 1 && /status kept as airborne/.test(notes[0]));
  r.lastFixAt = now - 2 * HOUR;                                         // old fix: the provider wins
  c.applyInfo(r, c.adbLegInfo_(mkLeg('DXB', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z', 'Canceled'), 'ARR'), now);
  assert.strictEqual(r.status, 'CANCELLED');
});

console.log('runTick_ with stubbed Google services');
test('two arrivals: delay alert, failures alert, cab plan, landed', () => {
  const sheet = [
    { _row: 2, id: 'A', name: 'Dr A', phone: '+91 9', direction: 'Arrival', flightRaw: 'EK 568', schedDepIn: '',
      schedArrIn: '2026-10-21 08:00', airport: '', terminal: 'T2', active: true },
    { _row: 3, id: 'B', name: 'Dr B', direction: 'Arrival', flightRaw: 'QR572', schedDepIn: '2026-10-21 03:30',
      schedArrIn: '2026-10-21 08:20', airport: '', terminal: 'T2', active: true }
  ];
  const sent = [], props = {};
  let groupsSheet = [], adbCalls = [];
  let osStates = [];
  Object.assign(G, {
    cfg: () => Object.assign(G.defaultConfig(), { COORD_TG_CHAT_IDS: '1' }),
    secret: () => null,
    loadExtraAirlines: () => {},
    readFlights: () => plain(sheet).map((r) => { for (const k of Object.keys(r)) if (k.endsWith('At')) r[k] = G.toMs(r[k]); return r; }),
    writeFlights: (rows) => rows.forEach((r) => Object.assign(sheet.find((s) => s._row === r._row), r)),
    readGroupsSheet: () => groupsSheet,
    writeGroupsSheet: (g) => { groupsSheet = g.map((x) => ({ memberIds: x.items.map((i) => i.r.id), driver: 'Ravi', driverTg: '99' })); },
    logEvent: () => {},
    purgeOldLogs_: () => {},
    notifyCoordinators_: (t) => sent.push(['coord', t]),
    tgDeliver_: (items) => items.forEach((i) => sent.push(['tg:' + i.chatId, i.text])),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    openskyStates: () => ({ ok: true, states: osStates }),
    fetchFlightInfo: (r) => {
      adbCalls.push(r.flightNorm);
      if (r.flightNorm === 'QR572') return { ok: false, error: 'HTTP 500' };
      return { ok: true, info: G.parseAdbLegs(plain(adbLegs), 'BLR', 'ARR') };
    }
  });

  // 20 Oct 22:00 IST: QR572 is past T-6h (03:30 - 6h = 21:30), EK568 enrich due (08:00 - 24h)
  G.runTick_(ist('2026-10-20 22:00'));
  assert.deepStrictEqual(adbCalls.sort(), ['EK568', 'QR572']);
  assert.ok(sent.some(([to, t]) => to === 'coord' && /EK568 \(Dr A\) DELAYED/.test(t)), JSON.stringify(sent));
  assert.ok(sent.some(([, t]) => /New cab groups/.test(t)));
  assert.strictEqual(sheet[0].liveTerminal, 'T2');

  sent.length = 0; adbCalls = [];
  G.runTick_(ist('2026-10-20 22:16'));                      // QR572 retry fails again -> coordinator warned
  assert.deepStrictEqual(adbCalls, ['QR572']);
  assert.ok(sent.some(([, t]) => /No status for QR572/.test(t)), JSON.stringify(sent));

  sent.length = 0; adbCalls = [];
  G.runTick_(ist('2026-10-20 22:21'));                      // nothing due -> no calls, no messages
  assert.deepStrictEqual(adbCalls, []);
  assert.strictEqual(sent.length, 0);

  // EK568 lands; driver of its cab gets the landed message
  const t = ist('2026-10-21 08:35');
  osStates = [['896abc', 'UAE568', 'UAE', t / 1000, t / 1000, BLR.lon, BLR.lat, 0, true, 3]];
  sent.length = 0;
  G.runTick_(t);
  assert.strictEqual(sheet[0].status, 'LANDED');
  assert.ok(sent.some(([to, m]) => to === 'tg:99' && /LANDED/.test(m) && /pickup/.test(m)), JSON.stringify(sent));
});

console.log('force check and "Run a check now"');
const OK_LEGS = () => ({ ok: true, attempted: true, legs: [mkLeg('DXB', 'BLR', '2026-10-20 22:15Z', '2026-10-21 02:30Z', 'Expected')] });
test('normal runs are unchanged: same calls, rows and alerts with or without an (unrelated) force list', () => {
  const scenario = (opts) => {
    const h = tickHarness([tickRow(), tickRow({ _row: 3, id: 'B', flightRaw: 'QR572', adbCalls: 1 })], { adb: () => OK_LEGS() });
    const times = ['2026-10-20 12:00', '2026-10-20 22:00', '2026-10-21 04:00', '2026-10-21 09:00'];
    const results = times.map((t) => h.c.runTick_(h.c.parseIstInput(t), opts));
    return plain({ sheet: h.sheet, calls: h.adbCalls.length, sent: h.sent, due: results.map((r) => [r.lookupsDue, r.lookupsMade]) });
  };
  const plainRun = scenario(undefined), withForceList = scenario({ forceIds: [] }), sendPlan = scenario({});
  assert.deepStrictEqual(withForceList, plainRun);
  assert.deepStrictEqual(sendPlan, plainRun);
  assert.ok(plainRun.calls > 0, 'the scenario does make lookups');
});
test('a forced row that is not due makes exactly one gateway call and reports "checked"', () => {
  const h = tickHarness([tickRow()], { adb: () => OK_LEGS() });
  const notDue = h.c.parseIstInput('2026-10-20 12:00');           // T-6h check is at 21:45
  assert.strictEqual(h.c.runTick_(notDue).lookupsMade, 0, 'not due: nothing without force');
  const r = h.c.runTick_(notDue, { forceIds: ['a'] });            // IDs are case-insensitive
  assert.strictEqual(h.adbCalls.length, 1);
  assert.strictEqual(r.forced.length, 1);
  assert.deepStrictEqual([r.forced[0].outcome, r.forced[0].callsUsed, r.forced[0].callsLeft], ['checked', 1, 3]);
  assert.strictEqual(r.lookupsDue, 1);
  assert.strictEqual(h.sheet[0].adbCalls, 1, 'counts toward the per-flight cap');
});
test('a forced row skips the "OpenSky already confirms it airborne" shortcut', () => {
  const t = '2026-10-21 05:00';
  const h = tickHarness([tickRow({ status: 'DEPARTED', schedDepAt: '2026-10-20T22:15:00Z', lastFixAt: new Date(Date.parse('2026-10-20T23:25:00Z')).toISOString(),
    etaAt: '2026-10-21T02:30:00Z', etaSource: 'live (OpenSky, 900 km out)', nextCheckAt: '2026-10-20T23:00:00Z', stateKey: '' })], { adb: () => OK_LEGS() });
  h.c.openskyStates = () => ({ ok: false, error: 'skip' });
  h.c.runTick_(h.c.parseIstInput(t));
  const unforced = h.adbCalls.length;
  assert.strictEqual(unforced, 0, 'without force the shortcut applies (fix 5 min old)');
  h.c.runTick_(h.c.parseIstInput(t), { forceIds: ['A'] });
  assert.strictEqual(h.adbCalls.length - unforced, 1);
});
test('a forced row at the per-flight cap makes zero calls and reports "cap"', () => {
  const h = tickHarness([tickRow({ adbCalls: 4 })], { adb: () => { throw new Error('must not be called'); } });
  const r = h.c.runTick_(h.c.parseIstInput('2026-10-20 22:00'), { forceIds: ['A'] });
  assert.strictEqual(h.adbCalls.length, 0);
  assert.strictEqual(r.forced[0].outcome, 'cap');
  assert.ok(/per-flight cap of 4/.test(r.forced[0].error));
});
test('forced final, inactive, invalid and unknown rows are refused without a call', () => {
  const h = tickHarness([tickRow({ status: 'LANDED' }), tickRow({ _row: 3, id: 'B', active: false }), tickRow({ _row: 4, id: 'C', flightRaw: 'tbd' })],
    { adb: () => { throw new Error('must not be called'); } });
  const r = h.c.runTick_(h.c.parseIstInput('2026-10-20 22:00'), { forceIds: ['A', 'B', 'C', 'Z9'] });
  assert.deepStrictEqual(r.forced.map((f) => f.outcome), ['final', 'inactive', 'invalid', 'invalid']);
  assert.ok(/already LANDED/.test(r.forced[0].error) && /no such row/.test(r.forced[3].error));
  assert.strictEqual(h.adbCalls.length, 0);
});
test('the force-check confirmation lists rows, Tier-2 units and calls left; unknown IDs stop it', () => {
  const c = freshCtx(), C = c.defaultConfig();
  const rows = [c.prepareRow(tickRow({ adbCalls: 1 }), C), c.prepareRow(tickRow({ _row: 3, id: 'B', status: 'LANDED' }), C)];
  const p = c.planForceCheck_('a, b, a', rows, C);
  assert.deepStrictEqual([...p.ids], ['A', 'B']);
  assert.ok(/2 rows, estimated up to 2 AeroDataBox units \(2 per lookup/.test(p.text), p.text);
  assert.ok(/A EK568 Dr A: 3 of 4 per-flight calls left/.test(p.text) && /already LANDED: will be refused/.test(p.text), p.text);
  assert.ok(/Not found on the Flights tab: X1/.test(c.planForceCheck_('A, X1', rows, C).error));
  assert.ok(c.planForceCheck_('  ', rows, C).error);
});
function menuCtx(lockFree, prompt) {
  const c = freshCtx(), shown = [];
  const ui = { alert: (...a) => { shown.push(a.filter((x) => typeof x === 'string').join(' | ')); return 'YES'; },
    prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => prompt || 'A' }),
    Button: { OK: 'OK', YES: 'YES' }, ButtonSet: { OK_CANCEL: 1, YES_NO: 2, OK: 3 } };
  let ran = 0;
  Object.assign(c, {
    SpreadsheetApp: { getUi: () => ui },
    LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    cfg: () => c.defaultConfig(), readFlights: () => [tickRow()], logEvent() {},
    runTick_: (now, o) => { ran++; return { at: now, lookupsDue: 2, lookupsMade: 3, rowsUpdated: 1, alertsQueued: 1,
      forced: (o && o.forceIds || []).map((id) => ({ id, flight: 'EK568', name: 'Dr A', outcome: 'checked', status: 'DELAYED', eta: 'Wed 21 Oct 08:33', source: 'AeroDataBox', error: '', callsUsed: 1, callsLeft: 2 })) }; }
  });
  return { c, shown, ran: () => ran };
}
test('a busy lock gives a visible message from "Run a check now" and "Force check" (never silent)', () => {
  for (const fn of ['runCheckNow', 'forceCheckFlight']) {
    const m = menuCtx(false);
    m.c[fn]();
    assert.strictEqual(m.ran(), 0, fn + ' must not run without the lock');
    assert.ok(m.shown.some((t) => /already running; try again in a minute/.test(t)), fn + ': ' + m.shown.join(' / '));
  }
});
test('"Run a check now" reports lookups due and made, rows updated and alerts', () => {
  const m = menuCtx(true);
  m.c.runCheckNow();
  assert.ok(/^Check finished at \d\d:\d\d IST: 2 provider lookups due, 3 requests made, 1 row updated, 1 alert sent\./.test(m.shown[0]), m.shown[0]);
  const f = menuCtx(true);
  f.c.forceCheckFlight();
  assert.strictEqual(f.ran(), 1);
  assert.ok(f.shown.some((t) => /A EK568 Dr A: checked\. Status DELAYED/.test(t)), f.shown.join(' / '));
});
test('the menu points "Run a check now" at runCheckNow; the trigger handler stays tick()', () => {
  const src = fs.readFileSync(path.join(srcDir, 'Menu.js'), 'utf8');
  assert.ok(/addItem\('Run a check now', 'runCheckNow'\)/.test(src));
  assert.ok(/addItem\('Force check a flight now \(uses AeroDataBox units\)', 'forceCheckFlight'\)/.test(src));
  assert.ok(/newTrigger\('tick'\)/.test(src));
});

console.log('heartbeat (Status tab)');
function statusSheetFake(c, opts) {
  const writes = [], logs = [];
  const sheet = { getRange: (r, col, nr, nc) => ({ setValues: (v) => writes.push({ r, col, nr, nc, v: plain(v) }), setNumberFormat() {}, setFontWeight() {} }),
    setFrozenRows() {}, getLastRow: () => 7 };
  c.SpreadsheetApp = { getActive: () => { if (opts && opts.broken) throw new Error('Service Spreadsheets failed'); return { getSheetByName: () => sheet, insertSheet: () => sheet }; } };
  c.ScriptApp = { getProjectTriggers: () => (opts && opts.noTrigger ? [] : [{ getHandlerFunction: () => 'tick' }]) };
  c.logEvent = (lvl, f, m) => logs.push(lvl + ' ' + m);
  return { writes, logs, value: (k) => (writes[writes.length - 1].v.find((x) => x[0] === k) || [])[1] };
}
test('every run writes the heartbeat once (one setValues): time, ok, lookups, trigger, version', () => {
  const h = tickHarness([tickRow()], { adb: () => OK_LEGS() });
  const st = statusSheetFake(h.c);
  h.run('2026-10-20 22:00');
  assert.strictEqual(st.writes.length, 1);
  assert.deepStrictEqual([st.writes[0].r, st.writes[0].col, st.writes[0].nr, st.writes[0].nc], [1, 1, 7, 3]);
  assert.strictEqual(st.value('LAST_TICK_AT'), new Date(h.c.parseIstInput('2026-10-20 22:00')).toISOString());
  assert.deepStrictEqual(['LAST_TICK_RESULT', 'LAST_TICK_ERROR', 'LAST_TICK_LOOKUPS', 'TRIGGER_INSTALLED'].map(st.value), ['ok', '', '1', 'yes']);
  assert.strictEqual(st.value('TRACKER_VERSION'), h.c.TRACKER_VERSION);
});
test('a failed tick writes an error heartbeat without secrets (max 200 chars) and still rethrows', () => {
  const token = '123456789' + ':AAFakeTokenForTestsOnly_abcdefghijklmnop';
  const c = freshCtx();
  const st = statusSheetFake(c, { noTrigger: true });
  Object.assign(c, { LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }, notifyCoordinators_() {},
    runTick_: () => { throw new Error('Request failed for https://api.telegram.org/bot' + token + '/sendMessage ' + 'x'.repeat(400)); } });
  assert.throws(() => c.tick(), (e) => !e.message.includes(token));
  assert.strictEqual(st.value('LAST_TICK_RESULT'), 'error');
  const err = st.value('LAST_TICK_ERROR');
  assert.ok(err.length <= 200 && /Request failed/.test(err) && !err.includes('AAFake'), err);
  assert.strictEqual(st.value('TRIGGER_INSTALLED'), 'no');
});
test('a Status write failure is logged and never breaks the run', () => {
  const h = tickHarness([tickRow()], { adb: () => OK_LEGS() });
  const st = statusSheetFake(h.c, { broken: true });
  const res = h.c.runTick_(h.c.parseIstInput('2026-10-20 22:00'));
  assert.strictEqual(res.lookupsMade, 1);
  assert.ok(st.logs.some((l) => /Status tab \(heartbeat\) not updated: Service Spreadsheets failed/.test(l)), st.logs.join('\n'));
});
test('the dashboard reads back what the tracker wrote; set up but never run = no heartbeat', () => {
  const c = freshCtx(), now = Date.parse('2026-10-22T08:00:00Z');
  const rows = c.heartbeatRows_(now, { lookupsMade: 2 }, '', true);
  assert.deepStrictEqual(plain(c.parseHeartbeat_(rows)), { at: now, result: 'ok', error: '', triggerInstalled: true });
  assert.strictEqual(c.parseHeartbeat_([['Key', 'Value'], ['LAST_TICK_AT', ''], ['LAST_TICK_RESULT', '']]), null);
  assert.strictEqual(c.parseHeartbeat_([]), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
