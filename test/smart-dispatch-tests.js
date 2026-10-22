// Local preview Smart Cab Plan (tools/smart-dispatch.js + CabSuggestions.applyOverride) on top of the real planGroups().
// Synthetic data only; no model is called. Run: node test/smart-dispatch-tests.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SD = require(path.join(ROOT, 'tools', 'smart-dispatch.js'));
const CS = require(path.join(ROOT, 'tools', 'cab-suggestions.js'));
const FS = require(path.join(ROOT, 'tools', 'flight-sort.js'));
const OA = require(path.join(ROOT, 'tools', 'ops-assistant.js'));

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
const plain = (v) => JSON.parse(JSON.stringify(v));
function setup(flights) {
  const cm = CS.build(flights, { planGroups: G.planGroups, config: C, nowMs: NOW, home: 'BLR', fs: FS });
  const ctx = SD.buildInput(cm.plan.groups, flights, { config: C, nowMs: NOW, fs: FS });
  return { cm, ctx, cabOf: (id) => ctx.index.guests[id].cab };
}
const answer = (suggestions) => JSON.stringify({ suggestions });

console.log('smart-dispatch');

// A at +0 and B at +48 (T2) are 3 min past the window; C at T1 lands with A.
const flights = [arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(108) }), arr('C', { schedAt: at(62), terminal: 'T1' })];

test('input carries planGroups cabs, guest times as minutes from now, and near-miss hints', () => {
  const { ctx } = setup(flights);
  const inp = plain(ctx.input);
  assert.strictEqual(inp.cabs.length, 3);
  assert.deepStrictEqual(inp.rules, { window_min: 45, max_seats: 4, arrival_buffer_min: 40, max_stretch_min: 60 });
  const b = inp.guests.find((g) => g.id === 'B');
  assert.strictEqual(b.arrives_in_min, 108);
  assert.strictEqual(b.terminal, 'T2');
  const pairs = inp.hints.near_merges.map((h) => h.spread_min + ':' + h.terminals.join('/'));
  assert.deepStrictEqual(pairs, ['2:T1/T2', '48:T2']); // C+B (T1/T2, 46 min apart) is not synced enough to hint
});

test('hints only list cross-terminal pairs that are closely synced', () => {
  const { ctx } = setup(flights);
  const cross = ctx.input.hints.near_merges.filter((h) => h.terminals.length > 1);
  assert.ok(cross.every((h) => h.spread_min <= 15), JSON.stringify(cross));
});

test('delayed guests are hinted only when they hold their cab-mates', () => {
  const { ctx } = setup([arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(50), etaAt: at(80), status: 'DELAYED' })]);
  assert.deepStrictEqual(plain(ctx.input.hints.delayed_guests.map((d) => [d.guest, d.delay_min, d.cab_mates, d.holds_cab_mates_min])), [['B', 30, ['A'], 20]]);
  // Delayed but still landing before the cab-mate: nobody waits for them, so no hint.
  const early = setup([arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(20), etaAt: at(50), status: 'DELAYED' })]);
  assert.strictEqual(early.ctx.input.hints.delayed_guests.length, 0);
});

test('the prompt is fixed server-side, carries the limits and demands JSON only', () => {
  const { ctx } = setup(flights);
  const m = OA.buildDispatchMessages({ input: ctx.input });
  assert.ok(m.ok);
  assert.strictEqual(m.messages[0].role, 'system');
  assert.match(m.messages[0].content, /at most 60 minutes apart/);
  assert.match(m.messages[0].content, /Reply with ONLY one JSON object/);
  assert.match(m.messages[0].content, /"affected_guests"/);
  assert.ok(!OA.buildDispatchMessages({}).ok);
  assert.ok(!SD.buildMessages(Object.assign({}, ctx.input, { cabs: [] })).ok);
});

test('a near-miss merge is accepted with locally computed spread and pickup', () => {
  const { ctx } = setup(flights);
  const r = SD.parse('```json\n' + answer([{ action: 'MERGE_CABS', affected_guests: ['A', 'B'], new_groups: [['B', 'A']], reasoning: 'Only 48 min apart.' }]) + '\n```', ctx.index);
  assert.strictEqual(r.rejected.length, 0);
  const s = r.suggestions[0];
  assert.strictEqual(s.cabDelta, -1);
  assert.deepStrictEqual(plain(s.after[0].guests), ['A', 'B']);
  assert.strictEqual(s.after[0].spreadMin, 48);
  assert.strictEqual(s.after[0].overWindowMin, 3);
  assert.strictEqual(s.after[0].pickupMs, at(108 + 40));
});

test('cross-terminal merge is flagged with the starting terminal', () => {
  const { ctx } = setup(flights);
  const s = SD.parse(answer([{ action: 'CROSS_TERMINAL', affected_guests: ['A', 'C'], new_groups: [['A', 'C']], reasoning: 'synced' }]), ctx.index).suggestions[0];
  assert.ok(s.after[0].crossTerminal);
  assert.strictEqual(s.after[0].startTerminal, 'T2'); // A lands first
  // B stays behind in the cab A left; C's old cab is gone.
  assert.deepStrictEqual(plain(s.after.map((g) => [g.guests, !!g.leftover])), [[['A', 'C'], false]]);
  assert.strictEqual(s.cabDelta, -1);
});

test('limits are enforced whatever the model says', () => {
  const big = [0, 5, 10, 15, 20].map((m, i) => arr('P' + i, { schedAt: at(60 + m * 20) }));
  const { ctx } = setup(big.concat([arr('M', { schedAt: at(70), airport: 'MAA' })]));
  const reasons = SD.parse(answer([
    { action: 'MERGE_CABS', new_groups: [['P0', 'P1', 'P2', 'P3', 'P4']], reasoning: '' },
    { action: 'MERGE_CABS', new_groups: [['P0', 'P4']], reasoning: '' },
    { action: 'MERGE_CABS', new_groups: [['P0', 'M']], reasoning: '' },
    { action: 'MOVE_GUEST', new_groups: [['P0', 'ZZ']], reasoning: '' },
    { action: 'MOVE_GUEST', new_groups: [['P0'], ['P0']], reasoning: '' },
    { action: 'MOVE_GUEST', affected_guests: ['P1'], new_groups: [['P0']], reasoning: '' }
  ]), ctx.index).rejected.map((x) => x.reason);
  assert.match(reasons[0], /5 guests in one cab/);
  assert.match(reasons[1], /arrivals 400 min apart/);
  assert.match(reasons[2], /mixes airports/);
  assert.match(reasons[3], /unknown guest id ZZ/);
  assert.match(reasons[4], /two new cabs/);
  assert.match(reasons[5], /P1 has no new cab/);
});

test('a suggestion that repeats the current plan is dropped; garbage is an error', () => {
  const { ctx } = setup([arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(70) })]);
  const r = SD.parse(answer([{ action: 'MERGE_CABS', new_groups: [['A', 'B']], reasoning: 'x' }]), ctx.index);
  assert.strictEqual(r.suggestions.length, 0);
  assert.match(r.rejected[0].reason, /no change/);
  assert.ok(SD.parse('I think you should merge them', ctx.index).error);
  assert.deepStrictEqual(plain(SD.parse('{"suggestions":[]}', ctx.index)), { suggestions: [], rejected: [] });
});

test('leave-behind for a delay: the delayed guest gets their own cab, the rest go ahead', () => {
  const list = [arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(65) }), arr('D', { schedAt: at(62), etaAt: at(100), status: 'DELAYED' })];
  const { ctx } = setup(list);
  assert.strictEqual(ctx.index.guests.D.cab, ctx.index.guests.A.cab); // 40 min after A: rules keep them together
  const s = SD.parse(answer([{ action: 'LEAVE_BEHIND', affected_guests: ['D'], new_groups: [['D']], reasoning: 'D is 38 min late.' }]), ctx.index).suggestions[0];
  assert.strictEqual(s.cabDelta, 1);
  assert.deepStrictEqual(plain(s.after.map((g) => [g.guests, !!g.leftover, g.pickupMs])), [[['D'], false, at(140)], [['A', 'B'], true, at(105)]]);
});

test('applyOverride merges cabs in memory, numbers them, and leaves the input model alone', () => {
  const { cm, ctx } = setup(flights);
  const s = SD.parse(answer([{ action: 'MERGE_CABS', affected_guests: ['A', 'B'], new_groups: [['A', 'B']], reasoning: '48 min apart.' }]), ctx.index).suggestions[0];
  const r = CS.applyOverride(cm, s, { nowMs: NOW, maxStretchMin: SD.MAX_STRETCH_MIN });
  assert.ok(r.ok, r.error);
  const m = r.model;
  assert.strictEqual(m.shared.length, 1);
  assert.deepStrictEqual(m.shared[0].members.map((x) => x.f.id), ['A', 'B']);
  assert.strictEqual(m.shared[0].label, 'Suggested Cab 1');
  assert.strictEqual(m.shared[0].pickupMs, at(148));
  assert.match(m.shared[0].reason, /^AI override: 48 min apart\./);
  assert.strictEqual(m.byFlight.B.with[0].id, 'A');
  assert.ok(m.byFlight.A.override);
  assert.strictEqual(m.overrides.length, 1);
  assert.strictEqual(m.plan, cm.plan);
  assert.strictEqual(cm.shared.length, 0); // input untouched
  assert.strictEqual(cm.individual.length, 3);
});

test('applyOverride re-checks against current times and missing guests', () => {
  const { cm, ctx } = setup(flights);
  const s = SD.parse(answer([{ action: 'MERGE_CABS', new_groups: [['A', 'B']], reasoning: '' }]), ctx.index).suggestions[0];
  // B is now later: 70 min after A.
  const later = CS.build([flights[0], arr('B', { schedAt: at(130) }), flights[2]], { planGroups: G.planGroups, config: C, nowMs: NOW, home: 'BLR', fs: FS });
  assert.match(CS.applyOverride(later, s, { nowMs: NOW, maxStretchMin: 60 }).error, /70 min apart/);
  const gone = CS.build([flights[0], flights[2]], { planGroups: G.planGroups, config: C, nowMs: NOW, home: 'BLR', fs: FS });
  assert.match(CS.applyOverride(gone, s, { nowMs: NOW, maxStretchMin: 60 }).error, /no longer in the cab plan: B/);
  assert.ok(CS.applyOverride(cm, s, { nowMs: NOW, maxStretchMin: 60 }).ok);
});

test('cross-terminal override shows both terminals and leaves a remainder cab', () => {
  const list = [arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(70) }), arr('C', { schedAt: at(62), terminal: 'T1' })];
  const { cm, ctx } = setup(list);
  const s = SD.parse(answer([{ action: 'CROSS_TERMINAL', new_groups: [['C', 'A']], reasoning: 'synced' }]), ctx.index).suggestions[0];
  const m = CS.applyOverride(cm, s, { nowMs: NOW, maxStretchMin: 60 }).model;
  const cross = m.shared[0];
  assert.deepStrictEqual(cross.terminals, ['T2', 'T1']);
  assert.ok(cross.crossTerminal);
  assert.strictEqual(m.individual.length, 1);
  assert.strictEqual(m.individual[0].members[0].f.id, 'B');
  assert.match(m.individual[0].reason, /Left in this cab/);
});

console.log('smart-dispatch without a model (rule-based fallback)');
test('near misses become merge suggestions that pass the same checks as the model\'s; a cab is used once', () => {
  const { ctx } = setup(flights);
  const res = SD.parse(JSON.stringify(SD.ruleSuggestions(plain(ctx.input))), ctx.index);
  assert.deepStrictEqual(res.rejected, []);
  // C (T1) + A (T2) land 2 min apart -> one cross-terminal cab. A's cab is then taken, so A+B is not offered as well.
  assert.deepStrictEqual(res.suggestions.map((s) => s.action), ['CROSS_TERMINAL']);
  assert.match(res.suggestions[0].reasoning, /start at T2/);
  assert.match(res.suggestions[0].reasoning, /Guest A \(XX\d*, [A-Za-z]{3} \d\d:\d\d\).*one cab can take both instead of two/);
});
test('a delayed guest who holds cab-mates gets an own pickup; the others leave on time', () => {
  const { ctx } = setup([arr('A', { schedAt: at(60) }), arr('B', { schedAt: at(50), etaAt: at(80), status: 'DELAYED' })]);
  const res = SD.parse(JSON.stringify(SD.ruleSuggestions(plain(ctx.input))), ctx.index);
  assert.deepStrictEqual([res.suggestions.length, res.suggestions[0].action, res.rejected.length], [1, 'LEAVE_BEHIND', 0]);
  assert.match(res.suggestions[0].reasoning, /delayed by 30 min and now lands 20 min after Guest A/);
});
test('nothing worth changing -> no suggestions (the plan stands)', () => {
  const { ctx } = setup([arr('A', { schedAt: at(60) })]);
  assert.deepStrictEqual(SD.ruleSuggestions(plain(ctx.input)), { suggestions: [] });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
