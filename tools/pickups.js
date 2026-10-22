'use strict';
// "Picked up" marks for the Cab Suggestions page, shared by every coordinator: one tracker_state row per
// flight row (key PICKUP_DONE:<id>), written by the server with the service-role key. One row per person
// means two coordinators marking different people never overwrite each other. The mark remembers the
// flight and scheduled time it was made for, so editing a guest's flight or time clears it by itself.

const PREFIX = 'PICKUP_DONE:';
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ITEMS = 12;

/** Pure: request body -> {items, done} | {error}. items: [{id, flight, schedAt}] */
function validate(body) {
  const b = body || {};
  if (typeof b.done !== 'boolean') return { error: 'done must be true or false' };
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > MAX_ITEMS) return { error: 'send 1-' + MAX_ITEMS + ' people' };
  const items = [];
  for (const it of b.items) {
    if (!it || !ID_RE.test(String(it.id || ''))) return { error: 'invalid flight row id' };
    items.push({ id: String(it.id), flight: String(it.flight == null ? '' : it.flight).slice(0, 12),
      schedAt: typeof it.schedAt === 'number' && isFinite(it.schedAt) ? it.schedAt : null });
  }
  return { items, done: b.done };
}

/** Pure: tracker_state map -> {rowId: {at, flight, schedAt}} */
function readMarks(stateMap) {
  const out = {};
  stateMap.forEach((v, k) => {
    if (k.indexOf(PREFIX) !== 0) return;
    try { const m = JSON.parse(v); if (m && typeof m.at === 'number') out[k.slice(PREFIX.length)] = m; } catch (e) { /* ignore a bad row */ }
  });
  return out;
}

/** client: supabase-js with the service-role key. -> async set(body) -> {ok, count} | {ok: false, error} */
function createPickupStore(client, now) {
  const clock = now || Date.now;
  return async function set(body) {
    const v = validate(body);
    if (v.error) return { ok: false, error: v.error };
    const keys = v.items.map((it) => PREFIX + it.id);
    if (v.done) {
      const at = clock();
      const rows = v.items.map((it) => ({ key: PREFIX + it.id, value: JSON.stringify({ at, flight: it.flight, schedAt: it.schedAt }), updated_at: new Date(at).toISOString() }));
      const { error } = await client.from('tracker_state').upsert(rows, { onConflict: 'key' });
      if (error) return { ok: false, error: 'Could not save: ' + error.message };
    } else {
      const { error } = await client.from('tracker_state').delete().in('key', keys);
      if (error) return { ok: false, error: 'Could not undo: ' + error.message };
    }
    return { ok: true, count: v.items.length };
  };
}

module.exports = { createPickupStore, readMarks, validate, PREFIX };
