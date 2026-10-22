// Guest list import (tools/xlsx.js, tools/import-guests.js). No network: workbooks are built in memory and the
// Flights table is a plain array. Run: node test/import-guests-tests.js
'use strict';
const assert = require('assert');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const { readXlsx } = require(path.join(ROOT, 'tools', 'xlsx.js'));
const I = require(path.join(ROOT, 'tools', 'import-guests.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n       ')); }
}

/** files {name: string} -> .xlsx-shaped zip (deflated, like Excel writes it). */
function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  Object.keys(files).forEach((name) => {
    const raw = Buffer.from(files[name], 'utf8'), data = zlib.deflateRawSync(raw), n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); central.push(ch, n); offset += 30 + n.length + data.length;
  });
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}
/** rows of values -> workbook; strings go to shared strings (as Google Sheets exports do), numbers stay numbers. */
function workbook(rows) {
  const shared = [];
  const cell = (v, r, c) => {
    const ref = String.fromCharCode(65 + c) + (r + 1);
    if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
    shared.push(v); return '<c r="' + ref + '" t="s"><v>' + (shared.length - 1) + '</v></c>';
  };
  const sheet = '<worksheet><sheetData>' + rows.map((row, r) => '<row r="' + (r + 1) + '">' + row.map((v, c) => (v === '' ? '' : cell(v, r, c))).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Form Responses 1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst>' + shared.map((s) => '<si><t>' + esc(s) + '</t></si>').join('') + '</sst>',
    'xl/worksheets/sheet1.xml': sheet
  });
}

// The newer form's layout: Timestamp, names with trailing spaces in the headers, no terminals, an upload link.
const HDR = ['Timestamp', 'Full Name ', 'Date of Arrival in Bengaluru ', 'Arrival Flight Number ', 'Arrival Time', 'Date of Departure from Bengaluru', 'Departure Flight Number ', 'Departure Time', 'Upload Flight Ticket'];
const DAY = 46320; // 2026-10-25 as an Excel serial day
const ROWS = [HDR,
  [46300.5, 'Dr. Asha Sharma', DAY, 'EK 568', 0.2013888889, DAY + 7, 'EK 569', 0.375, 'https://drive.example/x'],
  [46300.6, 'Prof Ben Okafor', DAY, 'Doha-Bengaluru via QR 572 & QR 573', 0.25, DAY + 3, '9', 0.5, ''],
  [46300.7, 'New Person', DAY + 1, 'Lufthansa 764', '4:50 PM', '', '', '', ''],
  [46301.9, 'asha  SHARMA', DAY, 'EK 568', 0.2083333333, DAY + 7, 'EK 569', 0.375, '']];   // answered again later: wins

console.log('reading the workbook');
test('the reader returns the sheet name, text cells as text and number cells as numbers', () => {
  const r = readXlsx(workbook(ROWS));
  assert.strictEqual(r.sheet, 'Form Responses 1');
  assert.deepStrictEqual(r.rows[0], HDR);
  assert.deepStrictEqual(r.rows[1].slice(1, 5), ['Dr. Asha Sharma', 46320, 'EK 568', 0.2013888889]);
});
test('cells: Excel days and day fractions, AM/PM, tiny fractions, India dates, terminals', () => {
  assert.deepStrictEqual([I.toDate('46320'), I.toDate('25/10/2026'), I.toDate('2026-10-25'), I.toDate('soon')], ['2026-10-25', '2026-10-25', '2026-10-25', null]);
  assert.deepStrictEqual([I.toTime(0.2013888889), I.toTime(46320.75), I.toTime(0.25), I.toTime('6.9444444444444E-4'), I.toTime('0.2013888889'), I.toTime('4:50 PM'), I.toTime('12:05 am'), I.toTime('16.50'), I.toTime('25:00')],
    ['04:50', '18:00', '06:00', '00:01', '04:50', '16:50', '00:05', '16:50', null]);
  assert.strictEqual(I.toTime('0.25'), '00:25', '"0.25" typed as text is read as h.mm; only a number cell is a day fraction');
  assert.deepStrictEqual([I.toTerminal('Terminal 2'), I.toTerminal('T1'), I.toTerminal('?')], ['T2', 'T1', '']);
});

console.log('form -> flights');
const form = I.readForm(readXlsx(workbook(ROWS)).rows);
test('one leg per arrival and departure; a later answer from the same person replaces the earlier one', () => {
  const asha = form.legs.filter((l) => l.key === 'asha sharma');
  assert.deepStrictEqual(asha.map((l) => [l.dir, l.flight, l.when]), [['ARR', 'EK568', '2026-10-25 05:00'], ['DEP', 'EK569', '2026-11-01 09:00']]);
  assert.ok(form.problems.some((p) => /replaces row 2/.test(p)));
});
test('several flights in a cell: the one into Bengaluru is used, the one before it becomes the first leg', () => {
  const ben = form.legs.find((l) => l.key === 'ben okafor' && l.dir === 'ARR');
  assert.deepStrictEqual([ben.flight, ben.firstLeg], ['QR573', 'QR572']);
});
test('airline names are read like the tracker reads them; an unreadable cell is reported, never guessed', () => {
  assert.strictEqual(form.legs.find((l) => l.key === 'new person').flight, 'LH764');
  assert.ok(!form.legs.some((l) => l.key === 'ben okafor' && l.dir === 'DEP'));
  assert.ok(form.problems.some((p) => /\(Prof Ben Okafor\) departure: flight: no flight number in "9" -> not imported/.test(p)), form.problems.join('\n'));
  assert.ok(!JSON.stringify(form.legs).includes('drive.example'), 'upload links are never imported');
});

console.log('form -> what changes in Supabase');
const EXISTING = [
  { ID: 'F1001', Name: 'Dr Asha Sharma', Direction: 'Arrival', Flight: 'EK 568', 'Sched Arr (IST)': '2026-10-25 04:50', Terminal: 'T3', Active: true },
  { ID: 'F1002', Name: 'Dr Asha Sharma', Direction: 'Departure', Flight: 'EK569', 'Sched Dep (IST)': '2026-11-01 09:00', Active: false },
  { ID: 'F1003', Name: 'Prof Ben Okafor', Direction: 'Arrival', Flight: 'QR573', 'Sched Arr (IST)': '2026-10-25 06:00', Active: true },
  { ID: 'F1004', Name: 'Someone Not On The List', Direction: 'Arrival', Flight: 'AI176', 'Sched Arr (IST)': '2026-10-24 01:00', Active: true }
];
const p = I.plan(form, EXISTING);
test('changed time -> update of only that column; a blank terminal in the file never erases the stored one', () => {
  const u = p.updates.find((x) => x.id === 'F1001');
  assert.deepStrictEqual(u.patch, { 'Sched Arr (IST)': '2026-10-25 05:00' });
});
test('someone back on the list has tracking switched on again', () => {
  assert.deepStrictEqual(p.updates.find((x) => x.id === 'F1002').patch, { Active: true });
});
test('a first leg found in the file is stored; matching is by name whatever the title or word order', () => {
  assert.deepStrictEqual(p.updates.find((x) => x.id === 'F1003').patch, { 'First Leg Flight': 'QR572' });
});
test('new people get the next free F-number IDs; nobody is deleted; people missing from the file are only listed', () => {
  assert.deepStrictEqual(p.inserts.map((x) => [x.row.ID, x.row.Name, x.row.Direction, x.row.Flight, x.row['Sched Arr (IST)']]), [['F1005', 'New Person', 'Arrival', 'LH764', '2026-10-26 16:50']]);
  assert.deepStrictEqual(p.notInFile, [{ name: 'Someone Not On The List', ids: ['F1004'] }]);
  const rep = I.report('list.xlsx', form, p, false);
  assert.ok(/DRY RUN \(nothing written\)/.test(rep) && /still tracked/.test(rep) && /To write this: add --apply/.test(rep));
});
test('two Supabase rows for the same person and direction: skipped and reported, not guessed', () => {
  const dup = I.plan(form, EXISTING.concat([{ ID: 'F1009', Name: 'Asha Sharma', Direction: 'Arrival', Flight: 'X1', 'Sched Arr (IST)': '2026-10-25 04:50' }]));
  assert.deepStrictEqual(dup.ambiguous.map((x) => x.why), ['several arrival rows: F1001, F1009']);
});

console.log('names written differently, and date typos');
test('the same person written differently is matched (and listed for checking), never duplicated', () => {
  const rows = [HDR.slice(0, 8),
    [46300.1, 'Kai Andreas Rommel', DAY, 'EY 1012', 0.3645833333, DAY + 7, 'EY 239', 0.9166666667],
    [46300.2, 'ARUNKUMAR SANGAIAH', DAY, '6E 2464', 0.6979166667, '', '', '']];
  const f = I.readForm(readXlsx(workbook(rows)).rows);
  const db = [{ ID: 'F1016', Name: 'Prof. Dr. Kai Rommel', Direction: 'Arrival', Flight: 'EY1012', 'Sched Arr (IST)': '2026-10-25 08:45', Active: true },
    { ID: 'F1019', Name: 'Dr. Arun Kumar Sangaiah', Direction: 'Arrival', Flight: '6E2464', 'Sched Arr (IST)': '2026-10-25 16:45', Active: true }];
  const q = I.plan(f, db);
  assert.deepStrictEqual(q.unchanged.map((x) => x.id), ['F1016', 'F1019']);
  assert.deepStrictEqual(q.notInFile, []);
  assert.deepStrictEqual(q.inserts.map((x) => [x.row.Name, x.row.Direction]), [['Prof. Dr. Kai Rommel', 'Departure']], 'a new leg keeps the stored name');
  assert.deepStrictEqual(q.matchedByName.map((x) => x.file), ['Kai Andreas Rommel', 'ARUNKUMAR SANGAIAH']);
  assert.ok(!I.sameName('Kai', 'Kai Rommel') && !I.sameName('Asha Sharma', 'Asha Verma') && I.sameName('José Núñez', 'Jose Nunez'));
});
test('a date far from the list\'s arrivals, or a departure before the arrival, is not imported; a day/month swap is suggested', () => {
  const rows = [HDR.slice(0, 8),
    [1, 'A One', DAY, 'AI 1', 0.25, DAY + 5, 'AI 2', 0.25],
    [2, 'C Three', 23838, 'AI 5', 0.25, DAY + 6, 'AI 6', 0.25],      // 1965-04-06: a birth date
    [3, 'E Five', DAY, 'AI 9', 0.25, DAY - 10, 'AI 10', 0.25],       // departs 2026-10-15, before arriving
    [4, 'F Six', DAY + 1, 'AI 11', 0.25, 46153, 'AI 12', 0.25]];     // 2026-05-11: day and month swapped (5 Nov)
  const f = I.readForm(readXlsx(workbook(rows)).rows);
  assert.deepStrictEqual(f.legs.map((l) => l.flight).sort(), ['AI1', 'AI11', 'AI2', 'AI6', 'AI9'].sort());
  assert.ok(f.problems.some((x) => /C Three\) arrival: date 1965-04-06 is more than 21 days/.test(x)), f.problems.join('\n'));
  assert.ok(f.problems.some((x) => /E Five\) departure: departs 2026-10-15 06:00, before arriving 2026-10-25 06:00/.test(x)), f.problems.join('\n'));
  assert.ok(f.problems.some((x) => /F Six\) departure: date 2026-05-11 .*maybe 2026-11-05 \(day and month swapped\?\)/.test(x)), f.problems.join('\n'));
  assert.strictEqual(f.people.length, 4, 'everyone is on the list, also with unreadable dates');
});
test('a route of airport codes that never touches Bengaluru is refused (that flight does not leave or land here)', () => {
  assert.deepStrictEqual(I.toFlights('COK-DMK-SGN by FD171 & FD656', 'DEP'), { error: 'route COK-DMK-SGN does not include BLR' });
  assert.strictEqual(I.toFlights('DOH-BLR QR 572', 'ARR').flight, 'QR572');
});
test('someone whose flights could not be read is still on the list (not reported as missing)', () => {
  const rows = [HDR.slice(0, 8), [1, 'Christopher Hogg', DAY, 'YBQC6C', 0.25, DAY + 5, 'YBQC6C', 0.25], [2, 'A One', DAY, 'AI 1', 0.25, '', '', '']];
  const f = I.readForm(readXlsx(workbook(rows)).rows);
  const q = I.plan(f, [{ ID: 'F1001', Name: 'Christopher Hogg', Direction: 'Arrival', Flight: 'QF67', 'Sched Arr (IST)': '2026-10-25 06:00' }]);
  assert.deepStrictEqual(q.notInFile, []);
  assert.ok(f.problems.some((x) => /no flight number in "YBQC6C"/.test(x)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
