#!/usr/bin/env node
'use strict';
// Loads a guest list (the Google Forms "Form Responses" export, .xlsx) into the Supabase Flights table.
//   npm run import:guests -- "C:\path\list.xlsx"            dry run: prints what would change, writes nothing
//   npm run import:guests -- "C:\path\list.xlsx" --apply    writes it (service-role key from .env.engine)
// Rules:
//  - People are matched by name (titles, case, punctuation and word order ignored); arrival and departure are
//    separate Flights rows, as everywhere else.
//  - New person/leg -> inserted with the next free F-number ID. Changed flight, date, time or terminal -> updated
//    (the tracker restarts that leg's tracking by itself). Unchanged -> left alone (its tracking history is kept).
//  - Never deletes. People in Supabase but not in the file are only listed; their tracking continues.
//  - A blank cell never erases a stored value (the newer form has no terminal columns).
//  - "AB123 & CD456" or a route with several flight numbers: the flight into (arrival) or out of (departure)
//    Bengaluru is used; an arrival's earlier flight goes to "First Leg Flight" (the tracker's connection check).
//  - A cell that cannot be read is reported with its row and never guessed. Ticket upload links are ignored.

const fs = require('fs');
const path = require('path');
const { readXlsx } = require('./xlsx');
const { nextId } = require('./tracker-control');

const COLUMNS = {
  name: /^(full )?name$/,
  arrDate: /^(date of arrival|arrival date)/, arrFlight: /^arrival flight/, arrTime: /^arrival time/, arrTerm: /^arrival termin/,
  depDate: /^(date of departure|departure date)/, depFlight: /^departure flight/, depTime: /^departure time/, depTerm: /^departure termin/,
  timestamp: /^timestamp$/
};
const FLIGHT_TOKEN = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?-?0*(\d{1,4}[A-Z]?)\b/gi;
const pad = (n) => String(n).padStart(2, '0');
const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** Name -> words in order: lower case, titles and "ep"/"n\u00e9e" dropped, hyphenated names split. */
function nameWords(n) {
  return (text(n).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(dr|prof|professor|mr|mrs|ms|miss|mx|ep|nee|n\u00e9e)\b\.?/g, ' ').match(/[a-z]+/g) || []);
}
/** Name -> exact matching key: words sorted ("Dr. Asha  Sharma" = "sharma asha"). */
function nameKey(n) { return nameWords(n).sort().join(' '); }

/**
 * The same person written two ways? Every word of one name must appear in the other, where two adjacent words
 * also count as one ("Arunkumar" = "Arun Kumar"). So "Kai Andreas Rommel" = "Prof. Dr. Kai Rommel", but a single
 * word ("Kai") never matches anyone: at least two words have to agree.
 */
function sameName(a, b) {
  const A = nameWords(a), B = nameWords(b);
  if (A.slice().sort().join(' ') === B.slice().sort().join(' ')) return A.length > 0;
  const covered = (X, Y) => {
    const pool = Y.concat(Y.slice(1).map((w, i) => Y[i] + w));
    return X.length >= 2 && X.every((w) => pool.indexOf(w) >= 0);
  };
  return covered(A, B) || covered(B, A);
}

const DAY_MS = 86400000;
const WINDOW_DAYS = 21;   // a date further than this from the event's typical arrival day is treated as a typo
const dayMs = (when) => Date.parse(when.slice(0, 10) + 'T00:00:00Z');

/** Cell -> 'YYYY-MM-DD' | null. Excel serial day (a number cell), ISO, or dd/mm/yyyy (India). */
function toDate(v) {
  const s = text(v);
  if ((typeof v === 'number' && v > 20000) || /^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Math.round((Math.floor(+s) - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  return m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31 ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : null;
}

/**
 * Cell -> 'HH:MM' | null. A number cell is Excel's day fraction (also with a date part: 46320.75 = 18:00).
 * Text: '4:50', '4:50 PM', '16.50' (h.mm), or a fraction written out as text ('6.9444E-4', '0.2013888').
 */
function toTime(v) {
  const s = text(v);
  const fraction = typeof v === 'number' || (/^\d*\.\d{3,}(e-?\d+)?$|e-\d+$/i.test(s) && isFinite(+s));
  if (fraction) {
    const frac = +s - Math.floor(+s), mins = Math.round(frac * 1440) % 1440;
    return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
  }
  const m = s.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i);
  if (!m || +m[2] > 59) return null;
  let h = +m[1];
  if (m[3]) { if (h > 12 || h === 0) return null; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  return h <= 23 ? pad(h) + ':' + m[2] : null;
}

/** 'Terminal 2' / 'T2' / '2' -> 'T2'; anything else -> '' */
function toTerminal(v) { const m = text(v).match(/(?:^|terminal\s*|\bt)\s*(\d)\b/i); return m ? 'T' + m[1] : ''; }

// The tracker's own flight-number reader (src/Util.js normalizeFlight): it also knows airline names, so
// "Emirates 0568" -> EK568, exactly as the tracker will read it.
let utilCtx = null;
function trackerNormalize(s) {
  if (!utilCtx) {
    const vm = require('vm');
    utilCtx = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Util.js'), 'utf8'), utilCtx, { filename: 'src/Util.js' });
  }
  const f = utilCtx.normalizeFlight(s);
  return f ? f.flight : null;
}

/**
 * Flight cell -> {flight, firstLeg, note} | {error}. dir 'ARR': the last number is the BLR flight; 'DEP': the first.
 * A route spelled out in airport codes that never touches the home airport ("COK-DMK-SGN by FD171") is refused:
 * that flight does not land at or leave from Bengaluru.
 */
function toFlights(v, dir, home) {
  const s = text(v);
  const route = s.match(/\b[A-Z]{3}(?:\s*[-–>]+\s*[A-Z]{3})+\b/);
  if (route && route[0].match(/[A-Z]{3}/g).indexOf(home || 'BLR') < 0) return { error: 'route ' + route[0] + ' does not include ' + (home || 'BLR') };
  let all = [...s.matchAll(FLIGHT_TOKEN)].map((m) => (m[1] + m[2]).toUpperCase()).filter((f, i, a) => a.indexOf(f) === i);
  if (!all.length && s) { const named = trackerNormalize(s); if (named) all = [named]; }   // "Emirates 568"
  if (!all.length) return { error: s ? 'no flight number in "' + s.slice(0, 40) + '"' : 'empty' };
  const flight = dir === 'ARR' ? all[all.length - 1] : all[0];
  return { flight, firstLeg: dir === 'ARR' && all.length > 1 ? all[all.length - 2] : '', note: all.length > 1 ? 'several flights in "' + s.slice(0, 40) + '": using ' + flight : '' };
}

/**
 * Pure: sheet rows -> {legs: [{key, name, dir, flight, firstLeg, when, terminal, row}], people: [{key, name, row}],
 * problems, columns}. people is everyone on the list, also those whose flights could not be read.
 */
function readForm(rows) {
  const hdrRow = rows.findIndex((r) => r.some((h) => COLUMNS.name.test(text(h).toLowerCase())));
  if (hdrRow < 0) return { legs: [], people: [], problems: ['no "Full Name" column found'], columns: {} };
  const col = {};
  rows[hdrRow].forEach((h, i) => { const t = text(h).toLowerCase(); Object.keys(COLUMNS).forEach((k) => { if (col[k] == null && COLUMNS[k].test(t)) col[k] = i; }); });
  const problems = [], byPerson = new Map();
  rows.slice(hdrRow + 1).forEach((r, i) => {
    const name = text(r[col.name]);
    if (!name) return;
    const rowNo = hdrRow + i + 2, key = nameKey(name);
    const ts = col.timestamp != null ? +text(r[col.timestamp]) || 0 : rowNo;
    const prev = byPerson.get(key);
    if (prev && prev.ts > ts) { problems.push('row ' + rowNo + ' (' + name + '): an earlier response than row ' + prev.rowNo + '; the later one is used'); return; }
    if (prev) problems.push('row ' + rowNo + ' (' + name + '): replaces row ' + prev.rowNo + ' (the same person answered again)');
    byPerson.set(key, { ts, rowNo, name, r });
  });
  const legs = [];
  byPerson.forEach(({ rowNo, name, r }, key) => {
    [['ARR', 'arr'], ['DEP', 'dep']].forEach(([dir, p]) => {
      const rawFlight = text(r[col[p + 'Flight']]), rawDate = text(r[col[p + 'Date']]), rawTime = text(r[col[p + 'Time']]);
      if (!rawFlight && !rawDate && !rawTime) return;                        // leg not given
      const label = 'row ' + rowNo + ' (' + name + ') ' + (dir === 'ARR' ? 'arrival' : 'departure');
      const f = toFlights(rawFlight, dir), date = toDate(r[col[p + 'Date']]), time = toTime(r[col[p + 'Time']]); // raw: a number cell is an Excel date/time
      const bad = [f.error ? 'flight: ' + f.error : '', date ? '' : 'date "' + rawDate.slice(0, 20) + '" unreadable', time ? '' : 'time "' + rawTime.slice(0, 20) + '" unreadable'].filter(Boolean);
      if (bad.length) { problems.push(label + ': ' + bad.join('; ') + ' -> not imported, fix it by hand'); return; }
      if (f.note) problems.push(label + ': ' + f.note + (f.firstLeg ? ' (' + f.firstLeg + ' saved as the first leg)' : ''));
      legs.push({ key, name, dir, flight: f.flight, firstLeg: f.firstLeg, when: date + ' ' + time, label,
        terminal: col[p + 'Term'] != null ? toTerminal(r[col[p + 'Term']]) : '', row: rowNo });
    });
  });
  // Typos in dates (a birth date, a wrong year, day and month swapped): never imported, so they cannot overwrite
  // a correct date already in Supabase. The yardstick is the list's own typical (median) arrival day.
  const arrDays = legs.filter((l) => l.dir === 'ARR').map((l) => dayMs(l.when)).sort((a, b) => a - b);
  const anchor = arrDays.length ? arrDays[Math.floor(arrDays.length / 2)] : null;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const kept = legs.filter((l) => {
    if (anchor == null || Math.abs(dayMs(l.when) - anchor) <= WINDOW_DAYS * DAY_MS) return true;
    const [y, m, d] = l.when.slice(0, 10).split('-');
    const swapped = +d <= 12 ? Date.parse(y + '-' + d + '-' + m + 'T00:00:00Z') : NaN;
    problems.push(l.label + ': date ' + l.when.slice(0, 10) + ' is more than ' + WINDOW_DAYS + ' days from the other arrivals (around ' + iso(anchor) + ')' +
      (Math.abs(swapped - anchor) <= WINDOW_DAYS * DAY_MS ? '; maybe ' + iso(swapped) + ' (day and month swapped?)' : '') + ' -> not imported, fix it by hand');
    return false;
  }).filter((l) => {
    const a = l.dir === 'DEP' && legs.find((x) => x.key === l.key && x.dir === 'ARR');
    if (!a || l.when >= a.when) return true;
    problems.push(l.label + ': departs ' + l.when + ', before arriving ' + a.when + ' -> not imported, fix it by hand');
    return false;
  });
  const people = [...byPerson].map(([key, p]) => ({ key, name: p.name, row: p.rowNo }));
  return { legs: kept, people, problems, columns: col };
}

const flightKey = (f) => text(f).toUpperCase().replace(/[\s-]/g, '').replace(/^([A-Z0-9]{2})0+/, '$1');
const whenKey = (s) => { const m = text(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/); return m ? m[1] + pad(m[2]) + pad(m[3]) + pad(m[4]) + m[5] : text(s); };

/**
 * Pure: form (readForm) + current Flights rows -> {inserts, updates, unchanged, notInFile, ambiguous, matchedByName}.
 * existing: rows as Supabase returns them (sheet headers as column names). People are matched exactly first, then
 * with sameName(); a leg added for someone already in Supabase keeps their stored name, so the dashboard shows
 * one guest, not two.
 */
function plan(form, existing) {
  const legs = form.legs || [], people = form.people || [];
  const dbPeople = new Map();                                       // nameKey -> {name, rows}
  existing.forEach((row) => {
    if (!row.Name) return;
    const k = nameKey(row.Name);
    if (!dbPeople.has(k)) dbPeople.set(k, { key: k, name: row.Name, rows: [] });
    dbPeople.get(k).rows.push(row);
  });
  const out = { inserts: [], updates: [], unchanged: [], notInFile: [], ambiguous: [], matchedByName: [] };
  const match = new Map(), usedDb = new Set();                      // file key -> db person
  people.forEach((p) => {
    let hits = dbPeople.has(p.key) ? [dbPeople.get(p.key)] : [...dbPeople.values()].filter((d) => sameName(p.name, d.name));
    if (hits.length > 1) { out.ambiguous.push({ who: p.name, why: 'matches ' + hits.map((d) => d.name).join(' and ') }); match.set(p.key, null); return; }
    if (hits.length) {
      match.set(p.key, hits[0]); usedDb.add(hits[0].key);
      if (hits[0].key !== p.key) out.matchedByName.push({ file: p.name, db: hits[0].name });
    }
  });
  const ids = existing.map((r) => r.ID);
  legs.forEach((l) => {
    if (match.get(l.key) === null) return;                          // ambiguous person: skipped, reported
    const person = match.get(l.key);
    const rows = person ? person.rows.filter((r) => (/^d/i.test(text(r.Direction)) ? 'DEP' : 'ARR') === l.dir) : [];
    const schedCol = l.dir === 'ARR' ? 'Sched Arr (IST)' : 'Sched Dep (IST)';
    if (rows.length > 1) { out.ambiguous.push({ who: l.name, why: 'several ' + (l.dir === 'ARR' ? 'arrival' : 'departure') + ' rows: ' + rows.map((r) => r.ID).join(', ') }); return; }
    if (!rows.length) {
      const id = nextId(ids); ids.push(id);
      out.inserts.push({ leg: l, row: Object.assign({ ID: id, Name: person ? person.name : l.name, Direction: l.dir === 'ARR' ? 'Arrival' : 'Departure', Flight: l.flight, Active: true,
        'Sched Arr (IST)': l.dir === 'ARR' ? l.when : null, 'Sched Dep (IST)': l.dir === 'DEP' ? l.when : null },
        l.terminal ? { Terminal: l.terminal } : {}, l.firstLeg ? { 'First Leg Flight': l.firstLeg } : {}) });
      return;
    }
    const cur = rows[0], patch = {}, changes = [];
    if (flightKey(cur.Flight) !== flightKey(l.flight)) { patch.Flight = l.flight; changes.push('flight ' + (cur.Flight || '—') + ' → ' + l.flight); }
    if (whenKey(cur[schedCol]) !== whenKey(l.when)) { patch[schedCol] = l.when; changes.push((l.dir === 'ARR' ? 'arrival' : 'departure') + ' ' + (cur[schedCol] || '—') + ' → ' + l.when); }
    if (l.terminal && text(cur.Terminal).toUpperCase() !== l.terminal) { patch.Terminal = l.terminal; changes.push('terminal ' + (cur.Terminal || '—') + ' → ' + l.terminal); }
    if (l.firstLeg && flightKey(cur['First Leg Flight']) !== flightKey(l.firstLeg)) { patch['First Leg Flight'] = l.firstLeg; changes.push('first leg → ' + l.firstLeg); }
    if (cur.Active === false || /^(false|no|0)$/i.test(text(cur.Active))) { patch.Active = true; changes.push('tracking switched back on (on the new list)'); }
    if (changes.length) out.updates.push({ leg: l, id: cur.ID, patch, changes, name: cur.Name });
    else out.unchanged.push({ leg: l, id: cur.ID });
  });
  dbPeople.forEach((d) => { if (!usedDb.has(d.key)) out.notInFile.push({ name: d.name, ids: d.rows.map((r) => r.ID) }); });
  return out;
}

function report(file, form, p, applied) {
  const L = [];
  const leg = (l) => l.name + ' · ' + (l.dir === 'ARR' ? 'arrival' : 'departure') + ' ' + l.flight + ' ' + l.when + (l.terminal ? ' ' + l.terminal : '');
  L.push((applied ? 'IMPORTED ' : 'DRY RUN (nothing written) ') + path.basename(file) + ': ' + (form.people || []).length + ' people, ' + form.legs.length + ' readable flights');
  if (p.matchedByName.length) { L.push('', 'Matched by name (check these are the same person):'); p.matchedByName.forEach((x) => L.push('  = "' + x.file + '" is "' + x.db + '"')); }
  L.push('', 'New (' + p.inserts.length + '):'); p.inserts.forEach((x) => L.push('  + ' + x.row.ID + ' ' + leg(x.leg)));
  L.push('', 'Changed (' + p.updates.length + '):'); p.updates.forEach((x) => L.push('  ~ ' + x.id + ' ' + (x.name || x.leg.name) + ': ' + x.changes.join('; ')));
  L.push('', 'Unchanged: ' + p.unchanged.length);
  L.push('', 'In Supabase but not in this file (' + p.notInFile.length + ', still tracked):'); p.notInFile.forEach((x) => L.push('  · ' + x.name + ' (' + x.ids.join(', ') + ')'));
  if (p.ambiguous.length) { L.push('', 'Skipped, not sure who this is (' + p.ambiguous.length + '):'); p.ambiguous.forEach((x) => L.push('  ! ' + x.who + ': ' + x.why)); }
  L.push('', 'Needs a look (' + form.problems.length + '):'); form.problems.forEach((x) => L.push('  ? ' + x));
  if (!applied) L.push('', 'To write this: add --apply');
  return L.join('\n');
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: npm run import:guests -- "path\\to\\list.xlsx" [--apply] [--sheet "Form Responses 1"]');
  const sheetArg = argv.indexOf('--sheet') >= 0 ? argv[argv.indexOf('--sheet') + 1] : undefined;
  const apply = argv.includes('--apply');
  const { readEnv, makeClient } = require('../engine/run');
  const client = makeClient(readEnv(process.env, path.join(__dirname, '..', '.env.engine')));
  const sheet = readXlsx(fs.readFileSync(file), sheetArg);
  const form = readForm(sheet.rows);
  const { data: existing, error } = await client.from('Flights').select('*');
  if (error) throw new Error('reading Flights: ' + error.message);
  const p = plan(form, existing);
  if (apply) {
    for (const u of p.updates) {
      const r = await client.from('Flights').update(u.patch).eq('ID', u.id);
      if (r.error) throw new Error('updating ' + u.id + ': ' + r.error.message);
    }
    if (p.inserts.length) {
      const r = await client.from('Flights').insert(p.inserts.map((x) => x.row));
      if (r.error) throw new Error('adding new guests: ' + r.error.message);
    }
  }
  console.log(report(file, form, p, apply));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => { console.error('Import failed: ' + ((e && e.message) || e)); process.exitCode = 1; });
}

module.exports = { readForm, plan, report, nameKey, sameName, toDate, toTime, toTerminal, toFlights };
