// Operations Assistant without a model (tools/assistant-fallback.js) and the fallbacks in tools/ops-assistant.js.
// Run: node test/assistant-fallback-tests.js
'use strict';
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const F = require(path.join(ROOT, 'tools', 'assistant-fallback.js'));
const OA = require(path.join(ROOT, 'tools', 'ops-assistant.js'));

let passed = 0, failed = 0;
const pending = [];
const test = (name, fn) => pending.push(() => Promise.resolve().then(fn).then(() => { passed++; console.log('  ok   ' + name); },
  (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }));

// The shape assistantContext() in tools/preview-app.html sends.
const CTX = {
  overview: {
    liveStatusAvailable: true,
    arrivalsToday: [], departuresToday: ['BA130 Dr Leaving 23:40'],
    arrivalsTomorrow: ['EK568 Dr Asha Sharma Sat 25 Oct 00:47'],
    nextArrivals: ['EK568 Dr Asha Sharma Sat 25 Oct 00:47', 'QR572 Prof Ben Okafor Sat 25 Oct 01:10'],
    nextDepartures: ['BA130 Dr Leaving Fri 24 Oct 23:40'],
    arrivalsPerDay: { 'Sat 25 Oct': 2 },
    delayed: ['EK568 Dr Asha Sharma: DELAYED, 17 min late'], unknownStatus: [],
    totals: { guests: 3, arrivals: 2, departures: 1 }
  },
  guests: [
    { name: 'Dr Asha Sharma', arrival: { flight: 'EK568', status: 'DELAYED', scheduled: 'Sat 25 Oct 00:30', estimated: 'Sat 25 Oct 00:47', terminal: 'T2', gate: 'C2', delayMinutes: 17,
      cabSuggestion: { suggestion: 'Suggested Cab 1', suggestedPickup: 'Sat 25 Oct 01:50', sharingWith: ['Prof Ben Okafor (QR572)'] } } },
    { name: 'Prof Ben Okafor', arrival: { flight: 'QR572', status: 'SCHEDULED', scheduled: 'Sat 25 Oct 01:10', terminal: 'T2' } },
    { name: 'Dr Leaving', departure: { flight: 'BA130', status: 'SCHEDULED', scheduled: 'Fri 24 Oct 23:40' } }
  ],
  cabSuggestions: [{ suggestion: 'Suggested Cab 1', terminal: 'T2', suggestedPickup: 'Sat 25 Oct 01:50', reason: 'x', members: ['Dr Asha Sharma (EK568, 00:47)', 'Prof Ben Okafor (QR572, 01:10)'] }],
  individualPickups: ['Someone (AI1): alone']
};

console.log('answers without a model');
test('a flight number (any spelling) gives that guest\'s status, times, terminal, gate and cab', () => {
  for (const q of ['where is EK568?', 'status of ek 568', 'EK-0568 update']) {
    const t = F.answer(q, CTX);
    assert.ok(t.startsWith(F.HEADER), t);
    assert.ok(/Dr Asha Sharma/.test(t) && /Arrives on EK568 · DELAYED · est\. Sat 25 Oct 00:47 \(sched\. Sat 25 Oct 00:30\) · Terminal 2 · Gate C2 · 17 min late/.test(t), t);
    assert.ok(/Cab: Suggested Cab 1, pickup about Sat 25 Oct 01:50 with Prof Ben Okafor \(QR572\)/.test(t), t);
  }
  assert.ok(/No guest on LH764 is in the tracker/.test(F.answer('LH764?', CTX)));
});
test('a guest\'s name works too', () => {
  const t = F.answer('when does Okafor land?', CTX);
  assert.ok(/Prof Ben Okafor/.test(t) && /QR572/.test(t) && !/Asha/.test(t), t);
});
test('topics: delays, cabs, tomorrow, departures, counts, next arrivals', () => {
  assert.ok(/Delayed:\n- EK568 Dr Asha Sharma: DELAYED, 17 min late/.test(F.answer('who is delayed?', CTX)));
  assert.ok(/nothing is booked/.test(F.answer('which cabs can share?', CTX)) && /1 other arrival/.test(F.answer('cabs?', CTX)));
  assert.ok(/Arriving tomorrow:\n- EK568/.test(F.answer('who arrives tomorrow', CTX)));
  assert.ok(/Next departures:\n- BA130/.test(F.answer('who is leaving next', CTX)));
  assert.ok(/3 guests · 2 arrivals · 1 departures/.test(F.answer('how many guests are there', CTX)));
  assert.ok(/Next arrivals:\n- EK568/.test(F.answer('who arrives next?', CTX)));
});
test('schedules only: delays are not guessed', () => {
  const ctx = Object.assign({}, CTX, { overview: Object.assign({}, CTX.overview, { liveStatusAvailable: false, liveStatusNote: 'SCHEDULES ONLY' }) });
  assert.ok(/SCHEDULES ONLY/.test(F.answer('anything delayed?', ctx)));
});
test('anything else: a short summary and what can be asked; never an invented answer', () => {
  const t = F.answer('what is the weather in Bangalore', CTX);
  assert.ok(/Next arrivals:/.test(t) && /Without the AI I can answer/.test(t), t);
  assert.ok(!/weather/i.test(t.split('\n').slice(1).join('\n')));
});

console.log('the assistant falls back instead of failing');
const failingLlm = { chat: async () => ({ ok: false, error: 'HTTP 503 (busy)' }), health: async () => ({}) };
test('chat: a failed model call still answers, marked as fallback with the model\'s error', async () => {
  const ops = OA.createOpsAssistant({ llm: failingLlm });
  const r = await ops.ask({ messages: [{ role: 'user', content: 'where is EK568?' }], context: CTX });
  assert.deepStrictEqual([r.ok, r.fallback, r.modelError], [true, true, 'HTTP 503 (busy)']);
  assert.ok(/Dr Asha Sharma/.test(r.text));
});
test('Smart Cab Plan: a failed model call returns the rule-based review in the model\'s JSON format', async () => {
  const ops = OA.createOpsAssistant({ llm: failingLlm });
  const input = { cabs: [{ cab: 'A', airport: 'BLR', terminal: 'T2', guests: ['a'] }, { cab: 'B', airport: 'BLR', terminal: 'T2', guests: ['b'] }],
    guests: [{ id: 'a', name: 'Guest A', flight: 'X1', arrives: 'Sat 01:00', arrives_in_min: 60, cab: 'A' }, { id: 'b', name: 'Guest B', flight: 'X2', arrives: 'Sat 01:50', arrives_in_min: 110, cab: 'B' }],
    rules: { window_min: 45, max_seats: 4 }, hints: { near_merges: [{ cabs: ['A', 'B'], spread_min: 50, over_window_min: 5, terminals: ['T2'], seats_after: 2 }], delayed_guests: [] } };
  const r = await ops.dispatch({ input });
  assert.deepStrictEqual([r.ok, r.fallback], [true, true]);
  const j = JSON.parse(r.text);
  assert.deepStrictEqual([j.suggestions.length, j.suggestions[0].action, j.suggestions[0].new_groups], [1, 'MERGE_CABS', [['a', 'b']]]);
});
test('a working model is used as before (no fallback flag)', async () => {
  const ops = OA.createOpsAssistant({ llm: { chat: async () => ({ ok: true, text: 'from the model' }), health: async () => ({}) } });
  assert.deepStrictEqual(await ops.ask({ messages: [{ role: 'user', content: 'hi' }], context: CTX }), { ok: true, text: 'from the model' });
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
