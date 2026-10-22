// Local preview write actions (tools/tracker-control.js and their routes in tools/preview-server.js):
// Add guest (INSERT with the anon key) and Run Tracker Now. No network, no real process: Supabase and
// child_process.spawn are faked. Run: node test/tracker-control-tests.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'tools', 'tracker-control.js'));

let passed = 0, failed = 0;
const pending = [];
const test = (name, fn) => pending.push(() => Promise.resolve().then(fn).then(() => { passed++; console.log('  ok   ' + name); },
  (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }));

const OK = { name: 'Dr Asha Sharma', flight: 'ek 568', direction: 'Arrival', date: '2026-10-25', time: '4:50' };

console.log('Add guest');
test('valid input -> only the coordinator columns, in the Flights table\'s own format', () => {
  assert.deepStrictEqual(T.validateGuest(OK).row, { Name: 'Dr Asha Sharma', Direction: 'Arrival', Flight: 'EK 568', 'Sched Arr (IST)': '2026-10-25 04:50',
    'Sched Dep (IST)': null, Active: true });
  assert.deepStrictEqual(T.validateGuest(Object.assign({}, OK, { direction: 'Departure', flight: '6E123' })).row['Sched Dep (IST)'], '2026-10-25 04:50');
});
test('bad input is refused with a message a coordinator can act on', () => {
  [[{ name: '' }, /name/], [{ flight: 'tbd' }, /flight number/], [{ date: '25/10/2026' }, /YYYY-MM-DD/], [{ date: '2026-13-01' }, /YYYY-MM-DD/],
    [{ time: '' }, /arrival time \(IST\)/], [{ time: '25:00' }, /HH:MM/], [{ name: 'x'.repeat(81) }, /80/]].forEach(([over, re]) => {
    const r = T.validateGuest(Object.assign({}, OK, over));
    assert.ok(r.error && re.test(r.error), JSON.stringify(over) + ' -> ' + JSON.stringify(r));
  });
});
test('the new row gets the next free F-number id (the engine skips rows without one)', () => {
  assert.strictEqual(T.nextId(['F1001', 'F1041', 'f1009', 'X7', null]), 'F1042');
  assert.strictEqual(T.nextId([]), 'F1001');
});
function fakeClient(over) {
  const calls = [];
  return { calls, from: (t) => ({
    select: (c) => { calls.push(['select', t, c]); return Promise.resolve({ data: [{ ID: 'F1001' }, { ID: 'F1041' }], error: null }); },
    insert: (row) => { calls.push(['insert', t, row]); return Promise.resolve(over || { data: null, error: null }); }
  }) };
}
test('INSERT goes to the Flights table through supabase-js; no tracker column is written', async () => {
  const c = fakeClient();
  const r = await T.createGuestInserter(c)(OK);
  assert.ok(r.ok && r.id === 'F1042');
  const ins = c.calls.find((x) => x[0] === 'insert');
  assert.strictEqual(ins[1], 'Flights');
  assert.deepStrictEqual(Object.keys(ins[2]).sort(), ['Active', 'Direction', 'Flight', 'ID', 'Name', 'Sched Arr (IST)', 'Sched Dep (IST)'].sort());
});
test('an RLS refusal says what policy is missing; invalid input never reaches Supabase', async () => {
  const c = fakeClient({ data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "Flights"' } });
  assert.ok(/needs an INSERT policy/.test((await T.createGuestInserter(c)(OK)).error));
  const c2 = fakeClient();
  assert.ok(!(await T.createGuestInserter(c2)(Object.assign({}, OK, { flight: '' }))).ok);
  assert.strictEqual(c2.calls.length, 0);
});

console.log('Run Tracker Now');
function fakeSpawn(script) {
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
    spawned.push({ cmd, args, opts, child });
    if (script) setImmediate(() => script(child));
    return child;
  };
  return { spawn, spawned };
}
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out'); };
const REPORT = JSON.stringify({ ok: true, summary: { lookupsMade: 2, rowsUpdated: 3 }, writes: {} }, null, 2);
test('starts node engine/run.js once; a second click while it runs does not start another', async () => {
  const f = fakeSpawn();
  const r = T.createTrackerRunner(f.spawn);
  assert.ok(r.start().started && r.status().running);
  assert.strictEqual(r.start().started, false);
  assert.strictEqual(f.spawned.length, 1);
  assert.ok(/engine[\\/]run\.js$/.test(f.spawned[0].args[0]) && f.spawned[0].cmd === process.execPath);
});
test('a finished run reports the engine\'s summary (log lines before the JSON report are ignored)', async () => {
  const f = fakeSpawn((c) => { c.stdout.emit('data', 'INFO EK568 AeroDataBox: Expected\nUSAGE {"a":1}\n' + REPORT + '\n'); c.emit('close', 0); });
  const r = T.createTrackerRunner(f.spawn);
  r.start();
  await until(() => !r.status().running);
  assert.deepStrictEqual([r.status().ok, r.status().summary], [true, { lookupsMade: 2, rowsUpdated: 3 }]);
});
test('a failed run carries the engine\'s own error (e.g. no service-role key)', async () => {
  const f = fakeSpawn((c) => { c.stderr.emit('data', 'Fatal: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set\n'); c.emit('close', 1); });
  const r = T.createTrackerRunner(f.spawn);
  r.start();
  await until(() => !r.status().running);
  assert.ok(!r.status().ok && /SERVICE_ROLE_KEY must be set/.test(r.status().error));
});
test('a run skipped because a scheduled run holds the lock is not a failure', async () => {
  const f = fakeSpawn((c) => { c.stdout.emit('data', JSON.stringify({ ok: true, locked: true })); c.emit('close', 0); });
  const r = T.createTrackerRunner(f.spawn);
  r.start();
  await until(() => !r.status().running);
  assert.deepStrictEqual([r.status().ok, r.status().summary], [true, { locked: true }]);
});
test('a run that hangs is stopped and reported', async () => {
  const f = fakeSpawn();
  const r = T.createTrackerRunner(f.spawn, { timeoutMs: 20 });
  r.start();
  await until(() => !r.status().running);
  assert.ok(f.spawned[0].child.killed && /longer than 3 minutes/.test(r.status().error));
});

console.log('preview server routes');
function request(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, method, path: p, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
test('POST endpoints accept JSON from this page only; GET /api/tracker/run reports idle without starting anything', async () => {
  const { startServer } = require(path.join(ROOT, 'tools', 'preview-server.js'));
  const log = console.log; console.log = () => {};
  const server = startServer(0, 1);
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  console.log = log;
  const port = server.address().port;
  try {
    assert.strictEqual((await request(port, 'POST', '/api/guests', { 'Content-Type': 'text/plain' }, '{}')).code, 415);
    assert.strictEqual((await request(port, 'POST', '/api/guests', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, '{}')).code, 403);
    assert.strictEqual((await request(port, 'GET', '/api/guests')).code, 405);
    assert.strictEqual((await request(port, 'POST', '/api/tracker/run', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, '{}')).code, 403);
    const viaProxy = await request(port, 'POST', '/api/guests', { 'Content-Type': 'application/json', Origin: 'https://localhost:' + port }, '{"name":""}');
    assert.notStrictEqual(viaProxy.code, 403, 'the same host over https (behind the HTTPS proxy) is accepted');
    const s = await request(port, 'GET', '/api/tracker/run');
    assert.deepStrictEqual([s.code, s.body.running, s.body.startedAt], [200, false, null]);
  } finally { server.close(); }
});
test('the page has both controls and never sends a key: it only calls the preview server', () => {
  const page = fs.readFileSync(path.join(ROOT, 'tools', 'preview-app.html'), 'utf8');
  ['id="add-guest-btn"', 'id="guest-dialog"', 'id="run-tracker-btn"', "postJson('/api/guests'", "postJson('/api/tracker/run')"].forEach((s) => assert.ok(page.includes(s), s));
  assert.ok(!/supabase\.co|SUPABASE_|CRON_SECRET|createClient/.test(page));
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
