'use strict';
// The local preview's two write actions, server side (tools/preview-server.js), so no key reaches the browser:
//   addGuest   INSERT one person into the Supabase Flights table with supabase-js and the ANON key, which the
//              project's anon RLS insert policy allows. Only the coordinator columns are written (ID, Name,
//              Direction, Flight, Sched Arr/Dep (IST), Active); the tracking engine fills in everything else.
//   runner     starts one tracking-engine run now (node engine/run.js, a separate process: the engine blocks
//              its thread while it calls the flight APIs) and reports when it has finished. The engine's own
//              lease lock stops it from overlapping a scheduled run.

const path = require('path');

const ROOT = path.join(__dirname, '..');
const FLIGHT_RE = /^([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])\s?-?0*([0-9]{1,4}[A-Z]?)$/;
const RUN_TIMEOUT_MS = 3 * 60 * 1000;

const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/**
 * Pure: form fields -> {row} (column name -> value, as the Flights table stores it) | {error}.
 * A time is required: the tracker cannot follow a flight without one (it would show "Need Sched Arr (IST)").
 */
function validateGuest(input) {
  const i = input || {};
  const name = text(i.name), flight = text(i.flight).toUpperCase(), date = text(i.date), time = text(i.time);
  const dir = text(i.direction).toLowerCase() === 'departure' ? 'Departure' : 'Arrival';
  if (!name || name.length > 80) return { error: 'Enter the guest\'s name (up to 80 characters).' };
  if (!FLIGHT_RE.test(flight)) return { error: 'Enter a flight number such as EK 568 or 6E123.' };
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d || +d[2] < 1 || +d[2] > 12 || +d[3] < 1 || +d[3] > 31) return { error: 'Enter the date as YYYY-MM-DD.' };
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!t || +t[1] > 23 || +t[2] > 59) return { error: 'Enter the scheduled ' + (dir === 'Arrival' ? 'arrival' : 'departure') + ' time (IST) as HH:MM.' };
  const when = date + ' ' + t[1].padStart(2, '0') + ':' + t[2];
  return { row: { Name: name, Direction: dir, Flight: flight, 'Sched Arr (IST)': dir === 'Arrival' ? when : null,
    'Sched Dep (IST)': dir === 'Departure' ? when : null, Active: true } };
}

/** Next free "F<number>" id after the largest one in the table (the engine skips rows without an ID). */
function nextId(ids) {
  const max = ids.reduce((m, id) => { const x = String(id || '').match(/^F(\d+)$/i); return x ? Math.max(m, +x[1]) : m; }, 1000);
  return 'F' + (max + 1);
}

/** client: a supabase-js client with the anon key. -> async addGuest(input) -> {ok, id, row} | {ok: false, error} */
function createGuestInserter(client, table) {
  const t = table || 'Flights';
  return async function addGuest(input) {
    const v = validateGuest(input);
    if (v.error) return { ok: false, error: v.error };
    const ids = await client.from(t).select('ID');
    if (ids.error) return { ok: false, error: 'Could not read the Flights table: ' + ids.error.message };
    const row = Object.assign({ ID: nextId(ids.data.map((r) => r.ID)) }, v.row);
    const ins = await client.from(t).insert(row);
    if (ins.error) {
      const denied = /row-level security|permission denied/i.test(ins.error.message || '');
      return { ok: false, error: denied ? 'Supabase refused the insert: the anon role needs an INSERT policy on the Flights table.'
        : 'Supabase refused the insert: ' + ins.error.message };
    }
    return { ok: true, id: row.ID, row };
  };
}

/**
 * spawn: child_process.spawn (injected for tests). -> {start(), status()}
 * status: {running, startedAt, finishedAt, ok, error, summary}. Output is parsed from run.js's JSON report.
 */
function createTrackerRunner(spawn, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  let cur = { running: false, startedAt: null, finishedAt: null, ok: null, error: null, summary: null };

  function start() {
    if (cur.running) return Object.assign({ started: false }, cur);
    cur = { running: true, startedAt: now(), finishedAt: null, ok: null, error: null, summary: null };
    let out = '', err = '', child;
    const done = (ok, error, summary) => { if (!cur.running) return; cur = Object.assign({}, cur, { running: false, finishedAt: now(), ok, error, summary }); };
    try {
      child = spawn(process.execPath, [path.join(ROOT, 'engine', 'run.js')], { cwd: ROOT, env: process.env, windowsHide: true });
    } catch (e) {
      done(false, 'Could not start the tracker: ' + ((e && e.message) || e), null);
      return Object.assign({ started: false }, cur);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } done(false, 'The tracker run took longer than 3 minutes and was stopped.', null); }, o.timeoutMs || RUN_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (b) => { out += b; if (out.length > 200000) out = out.slice(-200000); });
    child.stderr.on('data', (b) => { err += b; if (err.length > 20000) err = err.slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); done(false, 'Could not start the tracker: ' + e.message, null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let report = null;
      const j = out.lastIndexOf('\n{');
      try { report = JSON.parse(j >= 0 ? out.slice(j + 1) : out); } catch (e) { report = null; }
      const fatal = (err.match(/Fatal: (.*)/) || [])[1];
      if (report && report.locked) return done(true, null, { locked: true });
      if (code === 0 && report) return done(true, null, report.summary || null);
      done(false, (report && report.error) || fatal || 'The tracker exited with code ' + code, report && report.summary);
    });
    return Object.assign({ started: true }, cur);
  }

  return { start, status: () => Object.assign({}, cur) };
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Edit and remove one Flights row, with the SERVICE-ROLE key (server side only; the anon key can read and add,
 * never change or delete). Only coordinator columns are written; changing the flight or a time makes the tracker
 * reset that leg's tracking on its next run (src/Tracker.js prepareRow).
 * client: supabase-js with the service-role key. -> {update(body), remove(body)} -> {ok, ...} | {ok: false, error}
 */
function createGuestEditor(client, table) {
  const t = table || 'Flights';
  async function exists(id) {
    const r = await client.from(t).select('ID').eq('ID', id);
    if (r.error) return { error: 'Could not read the Flights table: ' + r.error.message };
    return { found: !!(r.data && r.data.length) };
  }

  /** body: {id, name, flight, direction, date, time, terminal?, active?} -> the row's new coordinator values. */
  async function update(body) {
    const b = body || {};
    if (!ID_RE.test(String(b.id || ''))) return { ok: false, error: 'Unknown guest row.' };
    const v = validateGuest(b);
    if (v.error) return { ok: false, error: v.error };
    const term = text(b.terminal).toUpperCase().replace(/^(\d)$/, 'T$1');
    if (term && !/^T\d$/.test(term)) return { ok: false, error: 'Terminal must be like T2 (or empty).' };
    const patch = Object.assign({}, v.row, { Terminal: term || null });
    if (typeof b.active === 'boolean') patch.Active = b.active; else delete patch.Active;
    const e = await exists(b.id);
    if (e.error) return { ok: false, error: e.error };
    if (!e.found) return { ok: false, error: 'This guest row no longer exists (deleted elsewhere?). Refresh the page.' };
    const r = await client.from(t).update(patch).eq('ID', b.id);
    if (r.error) return { ok: false, error: 'Supabase refused the change: ' + r.error.message };
    return { ok: true, id: b.id, row: patch };
  }

  /** body: {id, mode: 'stop' | 'delete'}. stop = Active false (kept, reversible); delete = row removed for good. */
  async function remove(body) {
    const b = body || {};
    if (!ID_RE.test(String(b.id || ''))) return { ok: false, error: 'Unknown guest row.' };
    if (b.mode !== 'stop' && b.mode !== 'delete') return { ok: false, error: 'Choose "stop tracking" or "delete".' };
    const e = await exists(b.id);
    if (e.error) return { ok: false, error: e.error };
    if (!e.found) return { ok: false, error: 'This guest row no longer exists. Refresh the page.' };
    if (b.mode === 'stop') {
      const r = await client.from(t).update({ Active: false }).eq('ID', b.id);
      return r.error ? { ok: false, error: 'Supabase refused the change: ' + r.error.message } : { ok: true, id: b.id, mode: 'stop' };
    }
    const r = await client.from(t).delete().eq('ID', b.id);
    if (r.error) return { ok: false, error: 'Supabase refused the delete: ' + r.error.message };
    await client.from('tracker_state').delete().eq('key', 'PICKUP_DONE:' + b.id); // its "picked up" mark goes too (best effort)
    return { ok: true, id: b.id, mode: 'delete' };
  }

  return { update, remove };
}

module.exports = { validateGuest, nextId, createGuestInserter, createGuestEditor, createTrackerRunner };
