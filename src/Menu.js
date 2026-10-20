/** Spreadsheet menu, trigger management and the Excel import. */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Flight Tracker')
    .addItem('1. Set up sheets', 'setupSheets')
    .addItem('2. Check setup (no API calls)', 'runSetupCheck')
    .addItem('3. Import from "Import" tab', 'importTravelDetails')
    .addItem('4. Start tracking (every 5 min)', 'installTrigger')
    .addSeparator()
    .addItem('Open dashboard', 'openDashboard')
    .addItem('Test a flight lookup (uses 2 AeroDataBox units)', 'testFlightLookup')
    .addItem('Run a check now', 'tick')
    .addItem('Send current cab plan to coordinators', 'sendCabPlan')
    .addItem('Send test alert', 'sendTestAlert')
    .addItem('Show Telegram chat ids', 'listTelegramChats')
    .addItem('Check Telegram bot (sends nothing)', 'checkTelegramBot')
    .addItem('Show API usage', 'showUsage')
    .addItem('Sync usage from RapidAPI dashboard', 'syncUsageFromDashboard')
    .addItem('Resume AeroDataBox (after fixing the key)', 'resumeAdb')
    .addItem('Import OpenFlights airlines table', 'importOpenFlightsAirlines')
    .addSeparator()
    .addItem('Stop tracking', 'removeTriggers')
    .addToUi();
}

function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  SpreadsheetApp.getActive().toast('Tracking every 5 minutes.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  });
}

function sendCabPlan() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('A check is running; try again in a minute.');
  try {
    alertRepeatBypass_ = true; // asked for explicitly: send even if identical to the last plan
    runTick_(Date.now(), { sendPlan: true });
  } finally { alertRepeatBypass_ = false; lock.releaseLock(); }
}

function showUsage() {
  var ui = SpreadsheetApp.getUi(), u;
  try { u = adbUsageSummary(); } catch (e) {
    ui.alert('AeroDataBox usage store unavailable: ' + e.message +
      '\nLookups are suspended until it is repaired with "Sync usage from RapidAPI dashboard".');
    return;
  }
  ui.alert('AeroDataBox, ' + u.window + ' (as counted by this script):\n' +
    'Units: ' + u.units + ' / ' + u.unitLimit + '\nRequests: ' + u.requests + ' / ' + u.requestLimit +
    (u.pending ? '\nIn-flight reservations: ' + u.pending : '') +
    (u.suspended ? '\nSUSPENDED: ' + u.suspended.reason : '') +
    '\n\nThe RapidAPI dashboard is authoritative; local counts are deliberately conservative.');
}

function syncUsageFromDashboard() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('Units used in the current billing cycle (from the RapidAPI dashboard):', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var units = parseDashboardCount(a.getResponseText());
  if (units === null) { ui.alert('Not changed: enter the units as a whole number (blank is not zero).'); return; }
  var b = ui.prompt('Requests used in the current billing cycle:', ui.ButtonSet.OK_CANCEL);
  if (b.getSelectedButton() !== ui.Button.OK) return;
  var requests = parseDashboardCount(b.getResponseText());
  if (requests === null) { ui.alert('Not changed: enter the requests as a whole number (blank is not zero).'); return; }
  try {
    adbSetUsage(units, requests, false);
  } catch (e) {
    if (!e.lowerBlocked) throw e;
    var ok = ui.alert('Lower the local count?', e.message + '\nThe dashboard can lag behind, and lowering allows more requests. ' +
      'Lower it to ' + units + ' units / ' + requests + ' requests anyway?', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    adbSetUsage(units, requests, true);
  }
  showUsage();
}

function resumeAdb() {
  var ui = SpreadsheetApp.getUi(), cleared;
  try {
    cleared = adbResume(false);
  } catch (e) {
    if (!e.quotaConfirm) throw e;
    var ok = ui.alert('Override the provider quota stop?', e.message +
      '\nOnly do this after checking the RapidAPI dashboard shows the quota has reset. Resume anyway?', ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return;
    cleared = adbResume(true);
  }
  ui.alert(cleared ? 'AeroDataBox lookups resumed (was: ' + cleared.reason + '). Budget limits still apply.'
    : 'AeroDataBox was not suspended. Nothing changed.');
}

/**
 * Paste the "ITW Faculty Travel Details.xlsx" sheet (headers in row 1) into a tab named "Import",
 * then run this. Headers are matched loosely; each person can produce an Arrival and a Departure row.
 * Rows already in Flights (same name + flight + direction) are skipped. Passport-like columns are ignored.
 */
function importTravelDetails() {
  var src = SpreadsheetApp.getActive().getSheetByName(IMPORT);
  if (!src || src.getLastRow() < 2) throw new Error('Create a tab named "Import" and paste the Excel data (with headers) into it.');
  var data = src.getDataRange().getValues();
  var hdr = data[0].map(function (h) { return String(h).toLowerCase().replace(/\s+/g, ' ').trim(); });
  var find = function (re, not) {
    for (var i = 0; i < hdr.length; i++) if (re.test(hdr[i]) && !(not && not.test(hdr[i]))) return i;
    return -1;
  };
  var col = {
    name: find(/name|faculty/, /airline|flight/),
    phone: find(/phone|mobile|contact|whatsapp/),
    email: find(/e-?mail/),
    arrFlight: find(/(arr|inbound|onward).*(flight|flt)|(flight|flt).*(arr|inbound)/),
    depFlight: find(/(dep|return|outbound).*(flight|flt)|(flight|flt).*(dep|return|outbound)/),
    arrDate: find(/arr.*date|date.*arr/), arrTime: find(/arr.*time|time.*arr|^arrival$/, /date/),
    depDate: find(/dep.*date|date.*dep|return.*date/), depTime: find(/dep.*time|time.*dep|return.*time|^departure$/, /date/),
    arrTerm: find(/arr.*term|term.*arr/), depTerm: find(/dep.*term|term.*dep/), term: find(/term/)
  };
  if (col.arrFlight < 0 && col.depFlight < 0) col.arrFlight = find(/flight|flt/);
  if (col.name < 0 || (col.arrFlight < 0 && col.depFlight < 0)) {
    throw new Error('Could not find Name and Flight columns. Headers seen: ' + data[0].join(' | '));
  }

  var existing = readFlights().map(function (r) {
    return [String(r.name).toLowerCase(), String(normalizeFlight(r.flightRaw) && normalizeFlight(r.flightRaw).flight), /^d/i.test(r.direction) ? 'D' : 'A'].join('|');
  });
  var sh = SpreadsheetApp.getActive().getSheetByName(FLIGHTS), nextRow = sh.getLastRow() + 1, added = [], skipped = 0;
  var get = function (row, i) { return i >= 0 ? row[i] : ''; };

  data.slice(1).forEach(function (row, n) {
    var name = String(get(row, col.name)).trim();
    if (!name) return;
    [['Arrival', col.arrFlight, col.arrDate, col.arrTime, col.arrTerm >= 0 ? col.arrTerm : col.term],
     ['Departure', col.depFlight, col.depDate, col.depTime, col.depTerm >= 0 ? col.depTerm : col.term]].forEach(function (d) {
      var flight = String(get(row, d[1])).trim();
      if (!flight) return;
      var f = normalizeFlight(flight);
      var key = [name.toLowerCase(), String(f && f.flight), d[0][0]].join('|');
      if (existing.indexOf(key) >= 0) { skipped++; return; }
      var when = combineDateTime_(get(row, d[2]), get(row, d[3]));
      var rec = COLS.filter(function (c) { return c.kind === 'in'; }).map(function (c) {
        switch (c.k) {
          case 'id': return 'F' + (nextRow + added.length); // unique: sheet row it lands on
          case 'name': return name;
          case 'phone': return String(get(row, col.phone));
          case 'email': return String(get(row, col.email));
          case 'direction': return d[0];
          case 'flightRaw': return flight;
          case 'schedArrIn': return d[0] === 'Arrival' ? when : '';
          case 'schedDepIn': return d[0] === 'Departure' ? when : '';
          case 'terminal': return String(get(row, d[4]));
          case 'active': return true;
          case 'notes': return when ? '' : 'CHECK: time not parsed from import';
          default: return '';
        }
      });
      added.push(rec);
    });
  });
  if (added.length) sh.getRange(nextRow, 1, added.length, added[0].length).setValues(added);
  SpreadsheetApp.getUi().alert('Imported ' + added.length + ' flight rows (' + skipped + ' already present).\n' +
    'Check the Sched Arr / Sched Dep columns are IST and rows marked CHECK in Notes.');
}

/** Date cell + time cell (or a single datetime cell, or text) -> Date in IST, or '' if unparseable. */
function combineDateTime_(dateV, timeV) {
  if (dateV instanceof Date && !(timeV instanceof Date) && !timeV) return dateV;
  var y, mo, d, h = 0, mi = 0;
  if (dateV instanceof Date) {
    y = Number(Utilities.formatDate(dateV, 'Asia/Kolkata', 'yyyy'));
    mo = Number(Utilities.formatDate(dateV, 'Asia/Kolkata', 'M')) - 1;
    d = Number(Utilities.formatDate(dateV, 'Asia/Kolkata', 'd'));
  } else {
    var ms = parseIstInput(String(dateV) + (timeV && !(timeV instanceof Date) ? ' ' + timeV : ''));
    if (ms) return new Date(ms);
    var m = String(dateV).match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
    if (!m) return '';
    y = +m[3]; mo = +m[2] - 1; d = +m[1];
  }
  if (timeV instanceof Date) {
    h = Number(Utilities.formatDate(timeV, 'Asia/Kolkata', 'H'));
    mi = Number(Utilities.formatDate(timeV, 'Asia/Kolkata', 'm'));
  } else if (timeV) {
    var t = String(timeV).match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
    if (!t) return '';
    h = to24_(+t[1], t[3]); mi = +t[2];
  }
  return new Date(istToMs(y, mo, d, h, mi));
}
