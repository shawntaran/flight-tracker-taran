/**
 * Sheet layer. "Flights" has three column blocks, in this order:
 *   in  - typed by coordinators (never written by the script, except a blank ID)
 *   out - written by the script, visible
 *   m   - machine state, hidden, plain text; `time` columns hold UTC ISO strings
 * Rows are read into plain objects keyed by `k`; `time` columns become ms numbers.
 */
var FLIGHTS = 'Flights', GROUPS = 'Groups', LOG = 'Log', AIRLINES_SHEET = 'Airlines', IMPORT = 'Import';

var COLS = [
  { k: 'id', h: 'ID', kind: 'in' },
  { k: 'name', h: 'Name', kind: 'in' },
  { k: 'phone', h: 'Phone', kind: 'in' },
  { k: 'email', h: 'Email', kind: 'in' },
  { k: 'tg', h: 'Telegram Chat ID', kind: 'in' },
  { k: 'direction', h: 'Direction', kind: 'in' },
  { k: 'flightRaw', h: 'Flight', kind: 'in' },
  { k: 'schedDepIn', h: 'Sched Dep (IST)', kind: 'in' },
  { k: 'schedArrIn', h: 'Sched Arr (IST)', kind: 'in' },
  { k: 'airport', h: 'Airport', kind: 'in' },
  { k: 'terminal', h: 'Terminal', kind: 'in' },
  { k: 'firstLeg', h: 'First Leg Flight', kind: 'in' },
  { k: 'active', h: 'Active', kind: 'in' },
  { k: 'notes', h: 'Notes', kind: 'in' },

  { k: 'flightNorm', h: 'Flight (normalised)', kind: 'out' },
  { k: 'status', h: 'Status', kind: 'out' },
  { k: 'etaDisp', h: 'ETA / Dep (IST)', kind: 'out' },
  { k: 'etaSource', h: 'ETA Source', kind: 'out' },
  { k: 'liveTerminal', h: 'Terminal (live)', kind: 'out' },
  { k: 'gate', h: 'Gate', kind: 'out' },
  { k: 'groupId', h: 'Cab Group', kind: 'out' },
  { k: 'pickupDisp', h: 'Pickup (IST)', kind: 'out' },
  { k: 'lastCheckDisp', h: 'Last Check (IST)', kind: 'out' },
  { k: 'lastError', h: 'Last Error', kind: 'out' },

  { k: 'schedDepAt', h: 'm:schedDep', kind: 'm', time: true },
  { k: 'schedArrAt', h: 'm:schedArr', kind: 'm', time: true },
  { k: 'revDepAt', h: 'm:revDep', kind: 'm', time: true },
  { k: 'adbEtaAt', h: 'm:adbEta', kind: 'm', time: true },
  { k: 'etaAt', h: 'm:eta', kind: 'm', time: true },
  { k: 'lastFixAt', h: 'm:lastFix', kind: 'm', time: true },
  { k: 'nextCheckAt', h: 'm:nextCheck', kind: 'm', time: true },
  { k: 'alertedEtaAt', h: 'm:alertedEta', kind: 'm', time: true },
  { k: 'notifiedPickupAt', h: 'm:notifiedPickup', kind: 'm', time: true },
  { k: 'callsign', h: 'm:callsign', kind: 'm' },
  { k: 'icao24', h: 'm:icao24', kind: 'm' },
  { k: 'depLocalDate', h: 'm:depLocalDate', kind: 'm' },
  { k: 'adbCalls', h: 'm:adbCalls', kind: 'm' },
  { k: 'failCount', h: 'm:failCount', kind: 'm' },
  { k: 'alertedStatus', h: 'm:alertedStatus', kind: 'm' },
  { k: 'flags', h: 'm:flags', kind: 'm' },
  { k: 'groupSig', h: 'm:groupSig', kind: 'm' },
  { k: 'stateKey', h: 'm:stateKey', kind: 'm' },
  { k: 'providerFetchedAt', h: 'm:providerFetchedAt', kind: 'm', time: true }
];

var USAGE = 'API Usage';
var USAGE_HEADERS = ['Time (IST)', 'Accounting window', 'Endpoint', 'Flight / date / role', 'HTTP', 'Units', 'Requests',
  'Outcome', 'Units used', 'Requests used'];

var FIRST_WRITE_COL = COLS.findIndex(function (c) { return c.kind !== 'in'; }); // 0-based

var GROUP_HEADERS = ['Group', 'Direction', 'Airport', 'Terminal', 'Pickup (IST)', 'Members', 'Flights / times',
  'Count', 'Vehicle', 'Driver', 'Driver Telegram Chat ID', 'Member IDs'];

function ss_() { return SpreadsheetApp.getActive(); }

function getOrCreateSheet_(name) { return ss_().getSheetByName(name) || ss_().insertSheet(name); }

function setupSheets() {
  var ss = ss_();
  ss.setSpreadsheetTimeZone('Asia/Kolkata');

  var sh = getOrCreateSheet_(FLIGHTS);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS.map(function (c) { return c.h; })]);
  } else {
    // Add machine columns introduced by later versions (always appended at the end).
    var hdr = sh.getRange(1, 1, 1, COLS.length).getValues()[0];
    COLS.forEach(function (c, i) { if (hdr[i] === '' && c.kind === 'm') sh.getRange(1, i + 1).setValue(c.h); });
    checkHeaders_(sh);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
  COLS.forEach(function (c, i) {
    var col = i + 1, range = sh.getRange(2, col, sh.getMaxRows() - 1, 1);
    if (c.kind === 'in') sh.getRange(1, col).setBackground('#d9ead3');
    if (c.kind === 'out') { sh.getRange(1, col).setBackground('#cfe2f3'); range.setBackground('#f3f6fb'); }
    if (c.kind === 'm') { range.setNumberFormat('@'); sh.hideColumns(col); }
  });
  var dirCol = colIndex_('direction') + 1, actCol = colIndex_('active') + 1;
  sh.getRange(2, dirCol, sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Arrival', 'Departure'], true).build());
  sh.getRange(2, actCol, sh.getMaxRows() - 1, 1).insertCheckboxes();
  sh.getRange(2, colIndex_('schedDepIn') + 1, sh.getMaxRows() - 1, 2).setNumberFormat('yyyy-mm-dd hh:mm');

  // Config: add settings this version knows but the sheet lacks; never change an existing value.
  var cfgSh = getOrCreateSheet_('Config');
  if (cfgSh.getLastRow() === 0) cfgSh.getRange(1, 1, 1, 3).setValues([['Key', 'Value', 'Notes']]);
  var existing = cfgSh.getLastRow() > 1 ? cfgSh.getRange(2, 1, cfgSh.getLastRow() - 1, 3).getValues() : [];
  var plan = planConfigSheet_(existing);
  plan.notes.forEach(function (n) { cfgSh.getRange(n.row + 2, 3).setValue(n.note); });
  if (plan.append.length) cfgSh.getRange(cfgSh.getLastRow() + 1, 1, plan.append.length, 3).setValues(plan.append);
  cfgSh.getRange(1, 1, 1, 3).setFontWeight('bold');
  cfgSh.setFrozenRows(1);
  cfgCache_ = null;

  var g = getOrCreateSheet_(GROUPS);
  if (g.getLastRow() === 0) {
    g.getRange(1, 1, 1, GROUP_HEADERS.length).setValues([GROUP_HEADERS]).setFontWeight('bold');
    g.setFrozenRows(1);
  }
  var log = getOrCreateSheet_(LOG);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 4).setValues([['Time (IST)', 'Level', 'Flight', 'Message']]).setFontWeight('bold');
    log.setFrozenRows(1);
  }
  var al = getOrCreateSheet_(AIRLINES_SHEET);
  if (al.getLastRow() === 0) al.getRange(1, 1, 1, 3).setValues([['IATA', 'ICAO', 'Name']]).setFontWeight('bold');
  var us = getOrCreateSheet_(USAGE);
  if (us.getLastRow() === 0) {
    us.getRange(1, 1, 1, USAGE_HEADERS.length).setValues([USAGE_HEADERS]).setFontWeight('bold');
    us.setFrozenRows(1);
  }

  // Status: the tracker's heartbeat. Created once with its keys; never cleared (runs overwrite the values).
  if (!ss.getSheetByName(STATUS_SHEET)) prepareStatusSheet_(getOrCreateSheet_(STATUS_SHEET));

  var about = getOrCreateSheet_('About');
  about.clearContents();
  about.getRange(1, 1, 6, 1).setValues([
    [ADB_ATTRIBUTION],
    ['Live positions: The OpenSky Network (https://opensky-network.org). Backup: FlightAware AeroAPI, if configured.'],
    ['AeroDataBox Basic (free) plan: non-commercial use only; no B2B sublicensing; no unlimited calls; no provider support.'],
    ['Limits enforced by this script: ' + ADB_PLAN.unitsPerMonth + ' API units and ' + ADB_PLAN.requestsPerMonth +
      ' requests per accounting window (rolling 33 days unless ADB_BILLING_CYCLE_DAY is set), max ' +
      ADB_PLAN.requestsPerHour + '/hour. See the "API Usage" sheet and menu "Show API usage".'],
    ['Provider-derived flight data is purged after ADB_RETENTION_HOURS (default 156 h; 7-day maximum).'],
    ['Attribution wording is not published by AeroDataBox; confirm it with them before wider use.']
  ]);
  about.getRange(1, 1).setFontWeight('bold');
}

// ---------------------------------------------------------------- heartbeat (Status tab)
/*
 * "Is the tracker actually running?" Every run writes these rows in ONE setValues call, fixed at rows 1-7,
 * so the dashboard, the local preview and the Telegram assistant can tell fresh data from stale data.
 * Values are plain text (column B is formatted as text so the ISO time is never turned into a date).
 */
var STATUS_SHEET = 'Status';
var TRACKER_VERSION = '2026-10-22 heartbeat-1';
var HEARTBEAT_STALE_MIN = 15;
var HEARTBEAT_NOTES = [
  ['LAST_TICK_AT', 'When the tracker last finished or failed a run (UTC, ISO 8601). Written by the script; do not edit.'],
  ['LAST_TICK_RESULT', 'ok or error'],
  ['LAST_TICK_ERROR', 'The last run\'s error (secrets removed, at most 200 characters); blank after a good run'],
  ['LAST_TICK_LOOKUPS', 'Provider requests made in that run (AeroDataBox, FlightAware backup, first-leg checks)'],
  ['TRIGGER_INSTALLED', 'yes if the 5-minute "tick" trigger exists (menu "4. Start tracking"), otherwise no'],
  ['TRACKER_VERSION', 'Version of the tracker code that wrote these rows']
];

function prepareStatusSheet_(sh) {
  sh.getRange(1, 2, 7, 1).setNumberFormat('@');
  sh.getRange(1, 1, 7, 3).setValues([['Key', 'Value', 'Notes']].concat(HEARTBEAT_NOTES.map(function (n) { return [n[0], '', n[1]]; })));
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/** Pure: the 7 Status rows for one run. res = runTick_'s summary (null on error); error = message or ''. */
function heartbeatRows_(nowMs, res, error, triggerInstalled) {
  var values = {
    LAST_TICK_AT: new Date(nowMs).toISOString(), LAST_TICK_RESULT: error ? 'error' : 'ok',
    LAST_TICK_ERROR: error ? redactSecrets(error).slice(0, 200) : '',
    LAST_TICK_LOOKUPS: res ? String(res.lookupsMade) : '',
    TRIGGER_INSTALLED: triggerInstalled == null ? '' : triggerInstalled ? 'yes' : 'no', TRACKER_VERSION: TRACKER_VERSION
  };
  return [['Key', 'Value', 'Notes']].concat(HEARTBEAT_NOTES.map(function (n) { return [n[0], values[n[0]], n[1]]; }));
}

/** Writes the heartbeat. Never throws: a Status write problem is logged and must not break a run. */
function recordHeartbeat_(nowMs, res, error) {
  try {
    var trigger = null;
    try { trigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tick'; }); } catch (e) { trigger = null; }
    var sh = ss_().getSheetByName(STATUS_SHEET);
    if (!sh) { sh = ss_().insertSheet(STATUS_SHEET); prepareStatusSheet_(sh); }
    sh.getRange(1, 1, 7, 3).setValues(heartbeatRows_(nowMs, res, error, trigger));
  } catch (e) {
    try { logEvent('WARN', '', 'Status tab (heartbeat) not updated: ' + redactSecrets(e && e.message || e)); } catch (e2) { /* never break a run */ }
  }
}

/** Pure: Status tab values -> {at, result, error, triggerInstalled} or null when there is no heartbeat yet. */
function parseHeartbeat_(values) {
  var kv = {};
  (values || []).slice(1).forEach(function (r) { if (r && String(r[0]).trim()) kv[String(r[0]).trim()] = r[1]; });
  var at = toMs(kv.LAST_TICK_AT);
  if (!('LAST_TICK_AT' in kv) || (kv.LAST_TICK_AT === '' && !kv.LAST_TICK_RESULT)) return null;
  var trig = String(kv.TRIGGER_INSTALLED || '').toLowerCase();
  return { at: at, result: String(kv.LAST_TICK_RESULT || '').toLowerCase(), error: redactSecrets(String(kv.LAST_TICK_ERROR || '')).slice(0, 200),
    triggerInstalled: trig === 'yes' ? true : trig === 'no' ? false : null };
}

function readHeartbeat_() {
  var sh = ss_().getSheetByName(STATUS_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  return parseHeartbeat_(sh.getRange(1, 1, sh.getLastRow(), 2).getValues());
}

function appendUsageRow_(e) {
  var sh = getOrCreateSheet_(USAGE);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, USAGE_HEADERS.length).setValues([USAGE_HEADERS]);
  sh.appendRow([fmtIST(e.at), e.usage ? e.usage.window.label : '', e.label, e.params, e.code, e.units, e.requests, e.outcome,
    e.usage ? e.usage.totals.units : '?', e.usage ? e.usage.totals.requests : '?']);
}

/** Log rows carry provider-derived status text, so they follow the same retention limit (checked hourly). */
function purgeOldLogs_(nowMs, C) {
  var cache = CacheService.getScriptCache();
  if (cache.get('LOG_PURGED')) return;
  cache.put('LOG_PURGED', '1', 3600);
  var sh = ss_().getSheetByName(LOG);
  if (!sh || sh.getLastRow() < 2) return;
  var cutoff = nowMs - Math.min(Number(C.ADB_RETENTION_HOURS) || 0, 168) * HOUR;
  var times = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  var n = 0;
  while (n < times.length && !(times[n][0] instanceof Date && times[n][0].getTime() >= cutoff)) n++;
  if (n > 0) sh.deleteRows(2, n);
}

function colIndex_(k) { return COLS.findIndex(function (c) { return c.k === k; }); }

function checkHeaders_(sh) {
  var hdr = sh.getRange(1, 1, 1, COLS.length).getValues()[0];
  COLS.forEach(function (c, i) {
    if (String(hdr[i]).trim() !== c.h) {
      throw new Error('Flights sheet column ' + (i + 1) + ' should be "' + c.h + '" but is "' + hdr[i] +
        '". Do not reorder/insert columns; add notes in the Notes column.');
    }
  });
}

/** -> array of row objects (with _row = 1-based sheet row). Blank rows are skipped. */
function readFlights() {
  var sh = ss_().getSheetByName(FLIGHTS);
  if (!sh) throw new Error('Run "Setup sheets" first.');
  checkHeaders_(sh);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, COLS.length).getValues();
  var rows = [];
  values.forEach(function (v, i) {
    var r = { _row: i + 2 };
    COLS.forEach(function (c, j) {
      var x = v[j];
      if (c.time) x = toMs(x);
      else if (typeof x === 'string') x = x.trim();
      r[c.k] = x;
    });
    if (!r.flightRaw && !r.id) return;
    rows.push(r);
  });
  return rows;
}

/** Writes the out+machine block for every row; IDs only where we generated one. */
function writeFlights(rows) {
  if (!rows.length) return;
  var sh = ss_().getSheetByName(FLIGHTS);
  // Guard against rows inserted/deleted while this run was in progress.
  var idCol = colIndex_('id') + 1;
  var currentIds = sh.getRange(1, idCol, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], cur = String(currentIds[r._row - 1][0]).trim();
    if (cur && cur !== String(r.id)) {
      logEvent('WARN', '', 'Sheet changed during run (row ' + r._row + '); skipping write this cycle.');
      return;
    }
  }
  var width = COLS.length - FIRST_WRITE_COL, byRow = {}, lastRow = 2;
  rows.forEach(function (r) {
    byRow[r._row] = r;
    lastRow = Math.max(lastRow, r._row);
    if (r._newId) sh.getRange(r._row, idCol).setValue(r.id);
  });
  var block = [];
  for (var row = 2; row <= lastRow; row++) {
    var rr = byRow[row], out = [];
    for (var j = FIRST_WRITE_COL; j < COLS.length; j++) {
      var c = COLS[j], x = rr ? rr[c.k] : '';
      out.push(c.time ? isoOrBlank(x) : (x == null ? '' : x));
    }
    block.push(out);
  }
  sh.getRange(2, FIRST_WRITE_COL + 1, block.length, width).setValues(block);
}

function readGroupsSheet() {
  var sh = ss_().getSheetByName(GROUPS);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, GROUP_HEADERS.length).getValues().map(function (v) {
    return { id: v[0], vehicle: v[8], driver: v[9], driverTg: String(v[10]).trim(),
      memberIds: String(v[11]).split(',').filter(String) };
  });
}

function writeGroupsSheet(groups) {
  var sh = getOrCreateSheet_(GROUPS);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, GROUP_HEADERS.length).clearContent();
  if (!groups.length) return;
  var rows = groups.map(function (g) {
    return [g.id, g.dir === 'ARR' ? 'Arrival' : 'Departure', g.airport, g.terminal, fmtIST(g.pickupMs),
      g.items.map(function (it) { return it.r.name || it.r.id; }).join(', '),
      g.items.map(function (it) { return it.r.flightNorm + ' ' + fmtTimeIST(it.t); }).join(', '),
      g.items.length, g.vehicle || '', g.driver || '', g.driverTg || '',
      g.items.map(function (it) { return it.r.id; }).join(',')];
  });
  sh.getRange(2, 1, rows.length, GROUP_HEADERS.length).setValues(rows);
}

function logEvent(level, flight, msg) {
  msg = redactSecrets(msg);
  console.log(level + ' ' + (flight || '') + ' ' + msg);
  try {
    var sh = getOrCreateSheet_(LOG);
    sh.appendRow([new Date(), level, flight || '', msg]); // a Date (shown in IST) so retention purge can read it
    if (sh.getLastRow() > 3000) sh.deleteRows(2, 1000);
  } catch (e) { console.error(e); }
}

function loadExtraAirlines() {
  var sh = ss_().getSheetByName(AIRLINES_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  var list = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .map(function (v) { return [String(v[0]).trim().toUpperCase(), String(v[1]).trim().toUpperCase(), String(v[2]).trim()]; })
    .filter(function (a) { return /^[A-Z0-9]{2}$/.test(a[0]); });
  setExtraAirlines(list);
}

/** Fills the Airlines sheet from the OpenFlights airlines table (active airlines with IATA+ICAO). */
function importOpenFlightsAirlines() {
  var url = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
  var text = UrlFetchApp.fetch(url).getContentText();
  var rows = Utilities.parseCsv(text).filter(function (f) {
    return f[7] === 'Y' && /^[A-Z0-9]{2}$/.test(f[3]) && /^[A-Z]{3}$/.test(f[4]);
  }).map(function (f) { return [f[3], f[4], f[1]]; });
  var sh = getOrCreateSheet_(AIRLINES_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, 1, 3).setValues([['IATA', 'ICAO', 'Name']]).setFontWeight('bold');
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  SpreadsheetApp.getActive().toast('Imported ' + rows.length + ' airlines.');
}
