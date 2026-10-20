// Telegram subsystem tests. Every Telegram response is faked: nothing here contacts api.telegram.org.
// Run: node test/telegram-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const srcDir = path.join(__dirname, '..', 'src');
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort()
  .map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')]);

// Built from parts so the doctor's secret scan never sees a token-shaped literal in the repository.
const FAKE_TG = '123456789' + ':AAFakeTokenForTestsOnly_abcdefghijklmnop';
const MIN = 60 * 1000, HOUR = 60 * MIN;
const ATTRIBUTION = /— Flight status data: AeroDataBox \(https:\/\/aerodatabox\.com\)$/;
const plain = (x) => JSON.parse(JSON.stringify(x));

const ok = (id) => ({ code: 200, body: JSON.stringify({ ok: true, result: { message_id: id || 1 } }) });
const tgErr = (code, description, parameters) => ({ code, body: JSON.stringify({ ok: false, error_code: code, description, parameters }) });
const result = (r) => ({ code: 200, body: JSON.stringify({ ok: true, result: r }) });

/** In-memory stand-in for the Deliveries sheet, with the same read-copies / update-by-row semantics. */
function memStore(G) {
  const rows = [];
  return {
    rows,
    read: () => rows.map((r, i) => Object.assign({}, r, { _i: i + 2 })),
    append: (nr) => nr.forEach((r) => { r._i = rows.length + 2; rows.push(Object.assign({}, r)); }),
    update: (r) => { rows[r._i - 2] = Object.assign({}, r); },
    purge: (cutoff) => { while (rows.length && rows[0].queuedAt < cutoff && G.TG_FINAL[rows[0].state]) rows.shift(); }
  };
}

function setup(opts = {}) {
  const logs = [];
  const G = vm.createContext({ console: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) } });
  for (const [f, src] of sources) vm.runInContext(src, G, { filename: f });
  const logRows = [], calls = [], sleeps = [], mails = [], cacheData = {};
  const clock = { t: Date.parse('2026-10-21T03:00:00Z') };
  let responder = opts.responder || (() => ok());
  const store = memStore(G);
  const env = {
    fetch: (url, o) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      const payload = o && o.payload ? JSON.parse(o.payload) : null;
      calls.push({ url, method, payload, opts: o });
      const r = responder({ method, payload, n: calls.length, url });
      if (r instanceof Error) throw r;
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    },
    sleep: (ms) => { sleeps.push(ms); clock.t += ms; },
    now: () => clock.t,
    secret: (n) => (n === 'TG_BOT_TOKEN' ? ('token' in opts ? opts.token : FAKE_TG) : null),
    cache: { get: (k) => (k in cacheData ? cacheData[k] : null), put: (k, v) => { cacheData[k] = String(v); } },
    store: () => store
  };
  G.TG_ENV = env;
  G.redactValues_ = [FAKE_TG];
  G.getOrCreateSheet_ = () => ({ appendRow: (r) => logRows.push(r.slice(1).join(' | ')), getLastRow: () => 1 });
  G.MailApp = { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) };
  const C = Object.assign(G.defaultConfig(), { COORD_TG_CHAT_IDS: '111,222' }, opts.config || {});
  G.cfg = () => C;
  return {
    G, env, C, calls, sleeps, mails, logRows, logs, clock, store, cacheData,
    setResponder: (f) => { responder = f; },
    sends: () => calls.filter((c) => c.method === 'sendMessage'),
    tick: (min) => { clock.t += min * MIN; return G.tgDeliver_([], C); },
    everything: () => JSON.stringify(store.rows) + logRows.join('\n') + logs.join('\n') + JSON.stringify(calls.map((c) => c.payload))
  };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

console.log('delivery');
test('1. success: each coordinator chat gets the alert once, recorded SENT with Telegram\'s message id', () => {
  const s = setup({ responder: ({ payload }) => ok(payload.chat_id === '111' ? 7 : 8) });
  const r = s.G.notifyCoordinators_(['🛬 EK568 (Dr A) LANDED at BLR T2 08:35 IST.'], s.C);
  assert.deepStrictEqual(s.sends().map((c) => c.payload.chat_id), ['111', '222']);
  s.sends().forEach((c) => {
    assert.strictEqual(c.opts.muteHttpExceptions, true);
    assert.ok(/LANDED/.test(c.payload.text) && ATTRIBUTION.test(c.payload.text), c.payload.text);
  });
  assert.deepStrictEqual(plain(s.store.rows.map((x) => [x.role, x.chatId, x.state, x.attempts, x.messageId])),
    [['coordinator', '111', 'SENT', 1, '7'], ['coordinator', '222', 'SENT', 1, '8']]);
  assert.ok(s.store.rows.every((x) => x.sentAt && x.lastAt && x.error === ''));
  assert.strictEqual(s.store.rows[0].id, s.store.rows[1].id, 'one event id shared by every recipient');
  assert.strictEqual(r.telegram.sent, 2);
});
test('2. missing token: no request, rows FAILED with the reason, email still goes out', () => {
  const s = setup({ token: null, config: { COORD_EMAILS: 'coord@example.org' } });
  const r = s.G.notifyCoordinators_('⚠️ something', s.C);
  assert.strictEqual(s.calls.length, 0);
  assert.ok(s.store.rows.length === 2 && s.store.rows.every((x) => x.state === 'FAILED' && x.attempts === 0 && /TG_BOT_TOKEN is not set/.test(x.error)));
  assert.strictEqual(s.mails.length, 1);
  assert.strictEqual(r.emailOk, true);
});
test('3. rejected token (401): stops after one request, ERROR logged, other chat closed with the reason', () => {
  const s = setup({ responder: () => tgErr(401, 'Unauthorized') });
  s.G.notifyCoordinators_('x', s.C);
  assert.strictEqual(s.sends().length, 1, 'the second chat is not tried with a bad token');
  assert.ok(/TG_BOT_TOKEN rejected/.test(s.store.rows[0].error) && s.store.rows[0].state === 'FAILED');
  assert.ok(/^not sent: .*TG_BOT_TOKEN rejected/.test(s.store.rows[1].error) && s.store.rows[1].attempts === 0);
  assert.ok(s.logRows.some((l) => /^ERROR/.test(l) && /rejected/.test(l)), s.logRows.join('\n'));
  assert.ok(!s.everything().includes(FAKE_TG));
});
test('4. wrong chat id (400) and blocked bot (403) are permanent: FAILED and never retried', () => {
  const s = setup({ responder: ({ payload }) => payload.chat_id === '111' ? tgErr(400, 'Bad Request: chat not found') : tgErr(403, 'Forbidden: bot was blocked by the user') });
  s.G.notifyCoordinators_('x', s.C);
  assert.ok(/wrong chat id/.test(s.store.rows[0].error) && /blocked the bot/.test(s.store.rows[1].error), JSON.stringify(s.store.rows));
  assert.ok(s.store.rows.every((x) => x.state === 'FAILED'));
  for (let i = 0; i < 10; i++) s.tick(5);
  assert.strictEqual(s.sends().length, 2);
});
test('4b. chat ids are checked before any request: @usernames, text and personal group ids are refused', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111, @publicchannel, abc, -100123, 111' } });
  const v = (id, role) => s.G.tgCheckChatId_(id, role).ok;
  assert.ok(v('111', 'coordinator') && v(123456789, 'driver') && v('-100123', 'coordinator'));
  assert.ok(!v('@publicchannel', 'coordinator') && !v('abc', 'coordinator') && !v('', 'coordinator') && !v('12.5', 'coordinator'));
  assert.ok(!v('-100123', 'driver') && !v('-100123', 'faculty'), 'a group never receives a personal message');
  const r = s.G.notifyCoordinators_('x', s.C);
  assert.deepStrictEqual(s.sends().map((c) => c.payload.chat_id), ['111', '-100123'], 'duplicates and invalid entries skipped');
  assert.deepStrictEqual(plain(r.invalid.map((x) => x.raw)), ['@publicchannel', 'abc']);
  assert.strictEqual(s.logRows.filter((l) => /COORD_TG_CHAT_IDS entry/.test(l)).length, 2);
});
test('4c. classification of Telegram answers', () => {
  const { G } = setup();
  const k = (r) => G.tgClassify_(r);
  assert.strictEqual(k(ok(5)).kind, 'sent');
  assert.strictEqual(k(ok(5)).messageId, '5');
  assert.strictEqual(k({ code: 200, body: '<html>' }).kind, 'unconfirmed', '200 without a readable answer is not "delivered"');
  assert.strictEqual(k({ code: 200, body: '{"ok":false,"description":"x"}' }).kind, 'fail');
  assert.strictEqual(k(tgErr(404, 'Not Found')).kind, 'auth');
  assert.strictEqual(k(tgErr(429, 'Too Many Requests', { retry_after: 7 })).retryAfterS, 7);
  assert.strictEqual(k({ code: 429, body: '' }).retryAfterS, 30, 'no retry_after: a safe default');
  assert.strictEqual(k({ code: 503, body: '' }).kind, 'retry');
  assert.strictEqual(k(tgErr(400, 'Bad Request: message is too long')).kind, 'fail');
  const mig = k(tgErr(400, 'Bad Request: group chat was upgraded to a supergroup chat', { migrate_to_chat_id: -1001234 }));
  assert.ok(mig.kind === 'fail' && mig.migrateTo === '-1001234' && /new chat id is -1001234/.test(mig.error));
  assert.strictEqual(k({ networkError: 'Timeout' }).kind, 'uncertain');
});

console.log('retries and rate limits');
test('5. 429 with a short retry_after: waits once inside the run, then delivers', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: ({ n }) => n === 1 ? tgErr(429, 'Too Many Requests: retry after 2', { retry_after: 2 }) : ok() });
  s.G.notifyCoordinators_('x', s.C);
  assert.ok(s.sleeps.includes(2000), JSON.stringify(s.sleeps));
  assert.deepStrictEqual(plain([s.store.rows[0].state, s.store.rows[0].attempts]), ['SENT', 2]);
});
test('5b. 429 with a long retry_after: no long wait in the run; resent in a later tick, never before retry_after', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: ({ n }) => n === 1 ? tgErr(429, 'Too Many Requests', { retry_after: 600 }) : ok() });
  const t0 = s.clock.t;
  s.G.notifyCoordinators_('🕒 EK568 (Dr A) DELAYED', s.C);
  assert.ok(s.sleeps.every((ms) => ms <= 3000), 'never blocks the execution for long');
  assert.strictEqual(s.store.rows[0].state, 'RETRY');
  assert.strictEqual(s.store.rows[0].nextAt, t0 + 10 * MIN);
  s.tick(5);
  assert.strictEqual(s.sends().length, 1, 'retry_after respected');
  s.tick(6);
  assert.strictEqual(s.sends().length, 2);
  assert.strictEqual(s.store.rows[0].state, 'SENT');
  assert.ok(/^⏱ Delayed delivery, first queued .* IST\n🕒 EK568/.test(s.sends()[1].payload.text), 'a late message says it is late');
});
test('6. server error: RETRY (visible on the sheet and the Log), delivered by the next tick', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: ({ n }) => n === 1 ? { code: 502, body: 'Bad Gateway' } : ok() });
  s.G.notifyCoordinators_('x', s.C);
  assert.ok(s.store.rows[0].state === 'RETRY' && /HTTP 502/.test(s.store.rows[0].error));
  assert.ok(s.logRows.some((l) => /^WARN/.test(l) && /RETRY/.test(l)));
  s.tick(5);
  assert.deepStrictEqual(plain([s.store.rows[0].state, s.store.rows[0].attempts, s.store.rows[0].error]), ['SENT', 2, '']);
  assert.ok(!/Delayed delivery/.test(s.sends()[1].payload.text), 'no delay note for a 5-minute retry');
});
test('7. network timeout: outcome unknown, one more try at most, then UNCONFIRMED; token never logged', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: ({ url }) => new Error('Exception: Timeout: ' + url) });
  s.G.notifyCoordinators_('x', s.C);
  assert.ok(s.store.rows[0].state === 'RETRY' && /may have arrived/.test(s.store.rows[0].error));
  s.tick(5);
  assert.deepStrictEqual(plain([s.store.rows[0].state, s.store.rows[0].attempts]), ['UNCONFIRMED', 2]);
  assert.ok(/to avoid a duplicate/.test(s.store.rows[0].error));
  for (let i = 0; i < 10; i++) s.tick(5);
  assert.strictEqual(s.sends().length, 2, 'at most one possible duplicate');
  assert.ok(!s.everything().includes(FAKE_TG) && !s.everything().includes('AAFake'));
});
test('9. retry exhaustion: four attempts in all (backoff 5, 10, 20 min), then FAILED and left alone', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: () => ({ code: 500, body: '' }) });
  s.G.notifyCoordinators_('x', s.C);
  const at = [0];
  for (let i = 1; i <= 30; i++) { const before = s.sends().length; s.tick(5); if (s.sends().length > before) at.push(i * 5); }
  assert.deepStrictEqual(at, [0, 5, 15, 35]);
  assert.ok(s.store.rows[0].state === 'FAILED' && /gave up after 4 attempts/.test(s.store.rows[0].error));
  assert.strictEqual(s.store.rows.length, 1, 'retries reuse the row: the queue does not grow');
});
test('9b. an alert that cannot be delivered within 120 min expires instead of piling up', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: () => tgErr(429, 'Too Many Requests', { retry_after: 7200 }) });
  s.G.notifyCoordinators_('x', s.C);
  s.tick(119);
  assert.strictEqual(s.store.rows[0].state, 'RETRY');
  s.tick(1);
  assert.ok(s.store.rows[0].state === 'EXPIRED' && /not delivered within 120 min/.test(s.store.rows[0].error));
  assert.strictEqual(s.sends().length, 1);
  assert.strictEqual(s.cacheData.TG_PENDING, '0', 'nothing left to retry: later ticks skip the sheet');
});
test('9c. a long run is cut short: messages over the time budget wait for the next tick', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: () => { s.clock.t += 15000; return ok(); } });
  for (let i = 0; i < 3; i++) s.G.tgDeliver_([{ chatId: '111', role: 'driver', text: 'm' + i }], s.C);
  const big = [1, 2, 3].map((i) => ({ chatId: String(500 + i), role: 'driver', text: 'n' + i }));
  s.G.tgDeliver_(big, s.C);
  const states = s.store.rows.slice(3).map((x) => x.state);
  assert.deepStrictEqual(plain(states), ['SENT', 'SENT', 'RETRY'], 'stops after ~20 s of Telegram time');
  s.tick(1);
  assert.strictEqual(s.store.rows[5].state, 'SENT');
});

console.log('duplicates');
test('8. the same alert processed twice is sent once; a real change back (A -> B -> A) is still sent', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' } });
  const flush = (...msgs) => { const o = new s.G.Outbox(); msgs.forEach((m) => o.coord(m)); o.flush(s.C); s.clock.t += 5 * MIN; };
  flush('Cab plan changed: A');
  flush('Cab plan changed: A');   // re-detected (e.g. the Flights write was skipped)
  flush('Cab plan changed: B');
  flush('Cab plan changed: A');   // changed back: must be sent
  flush('Cab plan changed: A', 'New: X'); // the repeat is dropped, the new item goes out alone
  assert.deepStrictEqual(s.sends().map((c) => c.payload.text.split('\n\n')[0]), ['Cab plan changed: A', 'Cab plan changed: B', 'Cab plan changed: A', 'New: X']);
  assert.ok(s.logRows.some((l) => /not repeated/.test(l)));
});
test('8b. a persistent tick error alerts once, then at most every 2 h, not every 5 min (Telegram and email)', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111', COORD_EMAILS: 'coord@example.org' } });
  for (let i = 0; i < 30; i++) { s.G.notifyCoordinators_('⚠️ Flight tracker error: column 7 moved', s.C); s.clock.t += 5 * MIN; }
  assert.strictEqual(s.sends().length, 2, '150 min of failing ticks -> 2 messages, not 30');
  assert.strictEqual(s.mails.length, 2);
});
test('8c. an explicit request (cab plan, test alert) is sent even when identical', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' } });
  s.G.notifyCoordinators_('Current cab plan: (none)', s.C);
  s.G.alertRepeatBypass_ = true;
  s.G.notifyCoordinators_('Current cab plan: (none)', s.C);
  s.G.alertRepeatBypass_ = false;
  assert.strictEqual(s.sends().length, 2);
});
test('8d. personal messages are filtered per recipient', () => {
  const s = setup();
  for (let i = 0; i < 2; i++) { const o = new s.G.Outbox(); o.direct('555', 'Cab plan changed: A'); o.direct('556', 'Cab plan changed: A'); o.flush(s.C); }
  assert.deepStrictEqual(s.sends().map((c) => c.payload.chat_id), ['555', '556']);
  assert.deepStrictEqual(plain(s.store.rows.map((x) => x.role)), ['driver', 'driver']);
});

console.log('formatting');
test('10. long alerts are split at paragraph ends, never cut: every part fits, is numbered and attributed', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' } });
  const paras = Array.from({ length: 70 }, (_, i) => '🚕 A-BLR-T2-1021-' + i + ' — pickup Wed 21 Oct 09:15 IST (BLR T2 arrivals)\n  • Dr Faculty ' + i + ' — EK568 ETA 08:35');
  const text = paras.join('\n\n');
  const parts = s.G.tgSplit_(text, s.G.attributionLine_());
  assert.ok(parts.length >= 2, String(parts.length));
  parts.forEach((p, i) => {
    assert.ok(p.length + 60 <= 4096, 'room left for the delayed-delivery note: ' + p.length);
    assert.ok(p.startsWith('(' + (i + 1) + '/' + parts.length + ') ') && ATTRIBUTION.test(p));
  });
  const body = parts.map((p) => p.replace(/^\(\d+\/\d+\) /, '').replace(s.G.attributionLine_(), '')).join('\n\n');
  assert.strictEqual(body, text, 'nothing lost or reordered');
  s.G.notifyCoordinators_(paras, s.C);
  assert.strictEqual(s.sends().length, parts.length);
  assert.ok(s.store.rows.every((x) => x.state === 'SENT') && new Set(s.store.rows.map((x) => x.id)).size === parts.length);
});
test('10b. a single very long line is hard-split without breaking an emoji in half', () => {
  const { G } = setup();
  const text = '🛬'.repeat(2500); // 5000 UTF-16 units, no line breaks
  const parts = G.tgSplit_(text, G.attributionLine_());
  const bodies = parts.map((p) => p.replace(/^\(\d+\/\d+\) /, '').replace(G.attributionLine_(), ''));
  assert.strictEqual(bodies.join(''), text);
  bodies.forEach((b) => assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(b), 'no lone surrogate at a cut'));
});
test('10c. names and symbols go out verbatim: plain text, no parse_mode, nothing to escape', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' } });
  const msg = '🕒 AI176 (Dr. O\'Brien <b>_*[x]*_</b> & Co.) DELAYED — ETA BLR T2 Wed 21 Oct 09:40 IST (+25 min).';
  s.G.notifyCoordinators_(msg, s.C);
  const p = s.sends()[0].payload;
  assert.strictEqual(p.parse_mode, undefined);
  assert.strictEqual(p.disable_web_page_preview, true);
  assert.ok(p.text.startsWith(msg));
});

console.log('secrets');
test('11. the token never reaches Telegram text, the Deliveries sheet, the Log or the console', () => {
  // One chat fails with a token-echoing description, one succeeds: both paths are checked.
  const s = setup({ responder: ({ payload }) => payload.chat_id === '111' ? tgErr(400, 'Bad Request: echo bot' + FAKE_TG) : ok() });
  s.G.notifyCoordinators_('⚠️ Flight tracker error: Request failed for https://api.telegram.org/bot' + FAKE_TG + '/sendMessage', s.C);
  assert.ok(s.calls[0].url.includes(FAKE_TG), 'the token is used only in the request URL');
  assert.deepStrictEqual(plain(s.store.rows.map((x) => x.state)), ['FAILED', 'SENT']);
  assert.ok(!s.everything().includes(FAKE_TG) && !s.everything().includes('AAFake'), s.everything());
  assert.ok(s.store.rows.every((x) => /\[REDACTED\]/.test(x.text)));
});

console.log('concurrency and crash safety');
test('12. "Send test alert" does nothing while another execution holds the script lock', () => {
  const s = setup();
  s.G.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  assert.throws(() => s.G.sendTestAlert(), /A check is running/);
  assert.strictEqual(s.calls.length + s.store.rows.length, 0);
});
test('12b. a run that stopped mid-send leaves QUEUED rows: treated as maybe-delivered, retried once at most', () => {
  const s = setup();
  s.store.append(s.G.tgNewRows_([{ chatId: '111', role: 'coordinator', text: 'x' }], s.clock.t));
  s.tick(1);
  assert.deepStrictEqual(plain([s.store.rows[0].state, s.store.rows[0].attempts, s.sends().length]), ['RETRY', 1, 0]);
  s.setResponder(({ url }) => new Error('Timeout ' + url));
  s.tick(6);
  assert.deepStrictEqual(plain([s.store.rows[0].state, s.store.rows[0].attempts, s.sends().length]), ['UNCONFIRMED', 2, 1]);
});
test('12c. consecutive executions never resend a delivered row; each due retry goes out exactly once', () => {
  const s = setup({ responder: ({ payload, n }) => payload.chat_id === '222' && n === 2 ? { code: 500, body: '' } : ok() });
  s.G.notifyCoordinators_('x', s.C);
  s.tick(5); s.tick(5); s.tick(5);
  assert.deepStrictEqual(s.sends().map((c) => c.payload.chat_id), ['111', '222', '222']);
  assert.ok(s.store.rows.every((x) => x.state === 'SENT'));
});
test('12d. Deliveries sheet unavailable: alerts still go out once, and an ERROR says tracking is off', () => {
  const s = setup();
  s.env.store = () => { throw new Error('Service Spreadsheets failed'); };
  const r = s.G.notifyCoordinators_('x', s.C);
  assert.strictEqual(s.sends().length, 2);
  assert.deepStrictEqual(plain(r.telegram.results.map((x) => x.state)), ['SENT', 'SENT']);
  assert.ok(s.logRows.some((l) => /^ERROR/.test(l) && /without delivery tracking/.test(l)));
});
test('12e. sheet store: chat ids kept as text, rows appended then updated in place, old rows purged', () => {
  const s = setup();
  const sheets = {};
  const makeSheet = () => {
    const cells = [], formats = {}; let maxRows = 3;
    const sh = {
      cells, formats,
      getLastRow() { let n = cells.length; while (n > 0 && !(cells[n - 1] || []).some((v) => v !== '' && v != null)) n--; return n; },
      getMaxRows: () => maxRows, insertRowsAfter(after, n) { maxRows += n; }, setFrozenRows() {},
      deleteRows(start, n) { cells.splice(start - 1, n); },
      getRange(r, c, nr = 1, nc = 1) {
        if (r + nr - 1 > maxRows) throw new Error('Range outside the sheet');
        const rng = {
          setValues(v) { v.forEach((row, i) => { cells[r - 1 + i] = cells[r - 1 + i] || []; row.forEach((x, j) => { cells[r - 1 + i][c - 1 + j] = x; }); }); return rng; },
          getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const x = (cells[r - 1 + i] || [])[c - 1 + j]; return x == null ? '' : x; })); },
          setNumberFormats(f) { f.forEach((row, i) => { formats[r + i] = row; }); return rng; },
          setNumberFormat() { return rng; }, setFontWeight() { return rng; }
        };
        return rng;
      }
    };
    return sh;
  };
  s.G.SpreadsheetApp = { getActive: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet()) }) };
  s.env.store = () => s.G.tgSheetStore_();
  s.setResponder(({ payload }) => payload.chat_id === '222' ? { code: 500, body: '' } : ok(9));
  s.G.notifyCoordinators_('x', s.C);
  const sh = sheets['Telegram Deliveries'];
  assert.deepStrictEqual(plain(sh.cells[0]), plain(s.G.TG_HEADERS));
  assert.strictEqual(sh.getLastRow(), 3, 'one row per recipient, updated in place');
  assert.strictEqual(sh.formats[2][3], '@', 'Chat ID column is text, so -100… ids stay exact');
  assert.deepStrictEqual(plain(sh.cells.slice(1).map((r) => [r[3], r[4], r[5], r[9]])), [['111', 'SENT', 1, '9'], ['222', 'RETRY', 1, '']]);
  s.setResponder(() => ok(10));
  s.tick(5);
  assert.deepStrictEqual(plain(s.G.tgSheetStore_().read().map((r) => [r.chatId, r.state, r.attempts])), [['111', 'SENT', 1], ['222', 'SENT', 2]]);
  delete s.cacheData.TG_PURGED;
  s.clock.t += 157 * HOUR;
  s.G.notifyCoordinators_('later', s.C);
  assert.deepStrictEqual(plain(sh.cells.slice(1).filter((r) => r.length).map((r) => r[11].split('\n')[0])), ['later', 'later'], 'rows older than the retention limit are deleted');
});

console.log('diagnostics');
test('13. Check Telegram bot uses read-only calls, reports each chat and flags groups and public chats', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111,-100222,-100333' }, responder: ({ method, payload }) => {
    if (method === 'getMe') return result({ id: 1, is_bot: true, username: 'ft_alerts_bot' });
    if (method === 'getWebhookInfo') return result({ url: '', pending_update_count: 0 });
    if (payload.chat_id === '111') return result({ id: 111, type: 'private', first_name: 'Asha' });
    if (payload.chat_id === '-100222') return result({ id: -100222, type: 'supergroup', title: 'Travel desk' });
    return result({ id: -100333, type: 'channel', title: 'News', username: 'publicnews' });
  } });
  const text = s.G.checkTelegramBot();
  assert.deepStrictEqual([...new Set(s.calls.map((c) => c.method))].sort(), ['getChat', 'getMe', 'getWebhookInfo']);
  assert.strictEqual(s.store.rows.length, 0);
  assert.ok(/No message was sent/.test(text) && /@ft_alerts_bot accepts the token/.test(text) && /✅ Chat 111: private chat with Asha/.test(text), text);
  assert.ok(/⚠️ Chat -100222: supergroup "Travel desk": every member/.test(text) && /PUBLIC \(@publicnews\)/.test(text), text);
  assert.ok(!text.includes(FAKE_TG));
});
test('13b. Check Telegram bot tells a missing token, a rejected token, a network failure and a webhook apart', () => {
  const report = (opts) => { const s = setup(opts); return s.G.tgRenderReport_(s.G.tgBotReport_(s.G.tgBotFacts_(s.C))); };
  assert.ok(/❌ TG_BOT_TOKEN: not set/.test(report({ token: null })));
  assert.ok(/rejected TG_BOT_TOKEN \(wrong or revoked\)/.test(report({ responder: () => tgErr(401, 'Unauthorized') })));
  const net = report({ responder: ({ url }) => new Error('DNS error ' + url) });
  assert.ok(/could not reach Telegram/.test(net) && /not checked/.test(net) && !net.includes(FAKE_TG), net);
  const hook = report({ responder: ({ method }) => method === 'getMe' ? result({ username: 'b' }) : method === 'getWebhookInfo' ? result({ url: 'https://example.org/hook' }) : result({ type: 'private' }) });
  assert.ok(/a webhook is set/.test(hook) && !hook.includes('example.org'), 'webhook URL itself is not shown');
  assert.ok(/❌ Chat 111: .*wrong chat id/.test(report({ responder: ({ method }) => method === 'getChat' ? tgErr(400, 'Bad Request: chat not found') : result({ username: 'b' }) })));
});
test('13c. Check setup flags unusable and group chat ids, and recent delivery problems', () => {
  const { G } = setup();
  const sheets = {};
  G.EXPECTED_SHEETS.forEach((n) => { sheets[n] = n === 'Flights' ? G.COLS.map((c) => c.h) : ['x']; });
  const f = { secrets: G.secretStatus_((n) => ({ ADB_KEY: 'fakeRapidApiKeyForTests0123456789abcdef', TG_BOT_TOKEN: FAKE_TG })[n]),
    config: Object.assign(G.defaultConfig(), { COORD_TG_CHAT_IDS: '@chan, -100123, 111' }), configIssues: [], timeZone: 'Asia/Kolkata', sheets,
    documentLock: true, propsRoundTrip: true, tickTriggers: 1, usage: { units: 0, unitLimit: 400, requests: 0, requestLimit: 1600, window: 'w' },
    telegram: G.tgDeliverySummary_([{ queuedAt: 0, state: 'FAILED', chatId: '111', role: 'coordinator', error: 'HTTP 403' }, { queuedAt: 0, state: 'RETRY' }], 1000) };
  const text = G.renderSetupReport_(G.setupReport_(f));
  assert.ok(/❌ Coordinators: COORD_TG_CHAT_IDS entry "@chan" is skipped/.test(text), text);
  assert.ok(/✅ Coordinators: 2 Telegram chat/.test(text) && /⚠️ Coordinators: 1 group chat/.test(text), text);
  assert.ok(/⚠️ Telegram deliveries: last 24 h: 0 sent, 1 failed.*1 waiting for a retry.*HTTP 403/.test(text), text);
});
test('13d. Show Telegram chat ids reads without consuming updates and labels chat types; a webhook is explained', () => {
  const alerts = [];
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: () => result([
    { update_id: 1, message: { chat: { id: 111, type: 'private', first_name: 'Asha', last_name: 'R' } } },
    { update_id: 2, my_chat_member: { chat: { id: -100555, type: 'supergroup', title: 'Travel desk' } } },
    { update_id: 3, edited_message: { chat: { id: 777, type: 'private', first_name: 'Ravi' } } }]) });
  s.G.SpreadsheetApp = { getUi: () => ({ alert: (t) => alerts.push(t) }) };
  s.G.listTelegramChats();
  const c = s.calls[0];
  assert.ok(c.method === 'getUpdates' && c.payload === null && c.opts.method === undefined, 'plain GET: no offset, no allowed_updates');
  assert.ok(/111  private  Asha R  \(already a coordinator\)/.test(alerts[0]) && /-100555  supergroup  Travel desk/.test(alerts[0]) && /777  private  Ravi/.test(alerts[0]), alerts[0]);
  s.setResponder(() => tgErr(409, 'Conflict: can\'t use getUpdates method while webhook is active'));
  assert.throws(() => s.G.listTelegramChats(), (e) => /webhook/.test(e.message) && !e.message.includes(FAKE_TG));
});
test('13e. Send test alert reports what each recipient got and labels the rows "test"', () => {
  const alerts = [];
  const s = setup({ config: { COORD_EMAILS: 'coord@example.org' }, responder: ({ payload }) => payload.chat_id === '111' ? ok() : tgErr(403, 'Forbidden: bot was blocked by the user') });
  s.G.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  s.G.SpreadsheetApp = { getUi: () => ({ alert: (title, t) => alerts.push(t), ButtonSet: { OK: 1 } }) };
  s.G.sendTestAlert();
  assert.ok(/✅ Telegram 111: delivered/.test(alerts[0]) && /❌ Telegram 222: FAILED, .*blocked the bot/.test(alerts[0]) && /✅ Email accepted by Gmail for 1/.test(alerts[0]), alerts[0]);
  assert.deepStrictEqual(plain(s.store.rows.map((x) => x.role)), ['test', 'test']);
  assert.strictEqual(s.G.alertRepeatBypass_, false, 'bypass is reset');
});

console.log('regressions: email and the tracker hand-off');
test('14. coordinator email unchanged: one email per alert, first line as subject, attribution; off when EMAIL_ALERTS is false', () => {
  const s = setup({ config: { COORD_EMAILS: 'a@example.org, b@example.org' } });
  const o = new s.G.Outbox(); o.coord('🕒 EK568 (Dr A) DELAYED — ETA 09:40'); o.coord('New cab groups:\n🚕 x'); o.flush(s.C);
  assert.strictEqual(s.mails.length, 1);
  assert.strictEqual(s.mails[0].to, 'a@example.org,b@example.org');
  assert.strictEqual(s.mails[0].subject, 'Flight tracker: 🕒 EK568 (Dr A) DELAYED — ETA 09:40');
  assert.ok(/New cab groups/.test(s.mails[0].body) && ATTRIBUTION.test(s.mails[0].body));
  assert.strictEqual(s.sends().length, 2, 'one combined Telegram message per coordinator chat');
  const s2 = setup({ config: { COORD_EMAILS: 'a@example.org', EMAIL_ALERTS: false } });
  s2.G.notifyCoordinators_('x', s2.C);
  assert.strictEqual(s2.mails.length, 0);
});
test('14b. personal messages: Telegram with a chat id, email without one; a group id is never used for a person', () => {
  const s = setup();
  const o = new s.G.Outbox();
  o.direct('555', 'driver msg');
  o.person({ tg: '', email: 'f1@example.org' }, 'faculty one');
  o.person({ tg: '-100999', email: 'f2@example.org' }, 'faculty two');
  o.person({ tg: '777', email: 'f3@example.org' }, 'faculty three');
  o.flush(s.C);
  assert.deepStrictEqual(s.sends().map((c) => [c.payload.chat_id, c.payload.text.split('\n')[0]]), [['555', 'driver msg'], ['777', 'faculty three']]);
  assert.deepStrictEqual(s.mails.map((m) => [m.to, m.subject]), [['f1@example.org', 'Travel update'], ['f2@example.org', 'Travel update']]);
  assert.ok(s.mails.every((m) => ATTRIBUTION.test(m.body)));
  assert.deepStrictEqual(plain(s.store.rows.map((x) => x.role)), ['driver', 'faculty']);
  assert.ok(s.logRows.some((l) => /"-100999" of a faculty skipped: is a group chat; .*sent by email instead/.test(l)), s.logRows.join('\n'));
});
test('14c. a flush with nothing new still retries due deliveries, and skips the sheet when nothing is pending', () => {
  const s = setup({ config: { COORD_TG_CHAT_IDS: '111' }, responder: ({ n }) => n === 1 ? { code: 500, body: '' } : ok() });
  s.G.notifyCoordinators_('x', s.C);
  let reads = 0; const inner = s.env.store; s.env.store = () => { reads++; return inner(); };
  s.clock.t += 5 * MIN; new s.G.Outbox().flush(s.C);
  assert.strictEqual(s.store.rows[0].state, 'SENT');
  s.clock.t += 5 * MIN; new s.G.Outbox().flush(s.C);
  assert.strictEqual(reads, 1, 'no pending rows: the next empty flush does not read the sheet');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
