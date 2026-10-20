/**
 * Setup diagnostics, run from the spreadsheet menu.
 *   runSetupCheck()    configuration check only: makes NO external API calls and spends no quota.
 *   testFlightLookup() live connectivity test: one AeroDataBox request through the budgeted
 *                      gateway (2 units), only after the person confirms.
 * Neither ever shows a secret value.
 */

var EXPECTED_SHEETS = ['Flights', 'Config', 'Groups', 'Log', 'API Usage', 'About'];

/** Gathers facts from Apps Script. Each probe is isolated so one failure doesn't hide the rest. */
function collectSetupFacts_() {
  var ss = SpreadsheetApp.getActive(), f = { sheets: {} };
  f.secrets = secretStatus_(function (n) {
    try { return PropertiesService.getScriptProperties().getProperty(n); } catch (e) { return null; }
  });
  cfgCache_ = null;
  f.config = cfg();
  f.configIssues = cfgIssues_;
  f.timeZone = ss.getSpreadsheetTimeZone();
  EXPECTED_SHEETS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    f.sheets[name] = !sh ? null : sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
  });
  try { f.documentLock = !!LockService.getDocumentLock(); } catch (e) { f.documentLock = false; }
  try {
    f.tickTriggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'tick'; }).length;
  } catch (e) { f.tickTriggers = -1; }
  try {
    var p = PropertiesService.getScriptProperties(), probe = 'probe-' + Date.now();
    p.setProperty('SETUP_CHECK_PROBE', probe);
    f.propsRoundTrip = p.getProperty('SETUP_CHECK_PROBE') === probe;
    p.deleteProperty('SETUP_CHECK_PROBE');
  } catch (e) { f.propsRoundTrip = false; }
  try { f.usage = adbUsageSummary(); } catch (e) { f.usageError = redactSecrets(e && e.message || e); }
  try { f.telegram = tgDeliverySummary_(tgSheetStore_().read(), Date.now()); } catch (e) { f.telegram = null; }
  return f;
}

/** Pure: facts -> [{level: 'ok'|'info'|'warn'|'error', area, message}]. */
function setupReport_(f) {
  var out = [], add = function (level, area, message) { out.push({ level: level, area: area, message: message }); };

  (f.secrets || []).forEach(function (s) {
    var level = s.status === 'ok' ? 'ok' : s.status === 'missing' ? (s.required ? 'error' : 'info') : 'warn';
    add(level, 'Script property ' + s.name, s.message);
  });
  (f.configIssues || []).forEach(function (i) { add(i.level, 'Config ' + i.key, i.message); });

  var C = f.config || {}, tgr = tgRecipients_(C.COORD_TG_CHAT_IDS, 'coordinator'), chats = tgr.valid, emails = listSetting(C.COORD_EMAILS);
  var tg = (f.secrets || []).filter(function (s) { return s.name === 'TG_BOT_TOKEN'; })[0];
  if (!chats.length && !(C.EMAIL_ALERTS && emails.length)) add('error', 'Coordinators', 'no COORD_TG_CHAT_IDS or COORD_EMAILS on the Config sheet: nobody will receive alerts');
  else add('ok', 'Coordinators', chats.length + ' Telegram chat(s), ' + (C.EMAIL_ALERTS ? emails.length : 0) + ' email address(es)');
  tgr.invalid.forEach(function (x) { add('error', 'Coordinators', 'COORD_TG_CHAT_IDS entry "' + x.raw + '" is skipped: ' + x.why); });
  var groups = chats.filter(function (id) { return id.charAt(0) === '-'; });
  if (groups.length) add('warn', 'Coordinators', groups.length + ' group chat(s) in COORD_TG_CHAT_IDS: every member receives faculty names and cab plans. Run "Check Telegram bot" to see which');
  if (chats.length && tg && tg.status === 'missing') add('error', 'Coordinators', 'Telegram chat ids are set but TG_BOT_TOKEN is missing');
  if (!chats.length && tg && tg.status !== 'missing') add('warn', 'Coordinators', 'bot token set but no chat ids: use menu "Show Telegram chat ids"');
  if (f.telegram) { var d = tgDeliveryLine_(f.telegram); add(d.level, 'Telegram deliveries', d.message); }

  if (f.timeZone !== 'Asia/Kolkata') add('error', 'Spreadsheet', 'timezone is ' + f.timeZone + '; run "Set up sheets" (times are read as IST)');
  else add('ok', 'Spreadsheet', 'timezone Asia/Kolkata');

  EXPECTED_SHEETS.forEach(function (name) {
    var hdr = f.sheets ? f.sheets[name] : null;
    if (!hdr) { add('error', 'Sheet ' + name, 'missing: run menu "1. Set up sheets"'); return; }
    if (name === 'Flights') {
      var bad = COLS.filter(function (c, i) { return String(hdr[i] || '').trim() !== c.h; });
      if (bad.length) add('error', 'Sheet Flights', bad.length + ' column header(s) wrong or missing (first: "' + bad[0].h + '"); run "Set up sheets", do not reorder columns');
      else add('ok', 'Sheet Flights', 'all ' + COLS.length + ' headers present');
    } else {
      add('ok', 'Sheet ' + name, 'present');
    }
  });

  add(f.documentLock ? 'ok' : 'error', 'Document lock', f.documentLock
    ? 'available (usage counter can be locked)' : 'NOT available: the script must be bound to this spreadsheet, otherwise AeroDataBox lookups stay off');
  add(f.propsRoundTrip ? 'ok' : 'error', 'Script Properties', f.propsRoundTrip ? 'write/read round trip works' : 'write/read round trip FAILED');

  if (f.tickTriggers === 1) add('ok', 'Tracking', 'one 5-minute trigger installed');
  else if (f.tickTriggers === 0) add('info', 'Tracking', 'not started: menu "4. Start tracking" when ready');
  else if (f.tickTriggers > 1) add('warn', 'Tracking', f.tickTriggers + ' tick triggers: run "Stop tracking" then "Start tracking"');
  else add('warn', 'Tracking', 'could not list triggers');

  if (f.usageError) add('error', 'AeroDataBox usage', 'store unreadable (lookups off, fail closed): ' + f.usageError + '. Use "Sync usage from RapidAPI dashboard".');
  else if (f.usage) {
    add('ok', 'AeroDataBox usage', f.usage.units + '/' + f.usage.unitLimit + ' units, ' + f.usage.requests + '/' + f.usage.requestLimit + ' requests (' + f.usage.window + ')');
    if (f.usage.suspended) add('warn', 'AeroDataBox usage', 'SUSPENDED: ' + f.usage.suspended.reason);
  }
  return out;
}

function renderSetupReport_(lines) {
  var icon = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' };
  var errors = lines.filter(function (l) { return l.level === 'error'; }).length;
  var warns = lines.filter(function (l) { return l.level === 'warn'; }).length;
  return (errors ? errors + ' problem(s) to fix' : 'No blocking problems') + (warns ? ', ' + warns + ' warning(s)' : '') +
    '. No external API was called.\n\n' +
    lines.map(function (l) { return icon[l.level] + ' ' + l.area + ': ' + l.message; }).join('\n');
}

function runSetupCheck() {
  var text = renderSetupReport_(setupReport_(collectSetupFacts_()));
  logEvent('INFO', '', 'Setup check: ' + text.split('\n')[0]);
  try { SpreadsheetApp.getUi().alert('Setup check', text, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { console.log(text); } // run from the editor: read it in the execution log
  return text;
}

/** Pure: gateway result -> human summary (no secrets; the key is never part of a result). */
function describeLookup_(res, spec) {
  if (!res.ok) {
    return (res.attempted ? 'Request sent and counted. ' : 'No request was sent. ') + res.error;
  }
  var i = parseAdbLegs(res.legs, '', 'ARR');
  if (!i) return 'AeroDataBox answered, but returned no flight legs.';
  var leg = res.legs[0], from = leg.departure && leg.departure.airport ? leg.departure.airport.iata : '?',
    to = leg.arrival && leg.arrival.airport ? leg.arrival.airport.iata : '?';
  return [
    spec.flight + ' on ' + spec.date + ': ' + from + ' → ' + to + ', status ' + i.rawStatus + (res.cached ? ' (from cache: no units used)' : ''),
    'Scheduled departure: ' + (fmtIST(i.schedDep) || '?') + ' IST' + (i.revDep ? ', revised ' + fmtIST(i.revDep) + ' IST' : ''),
    'Scheduled arrival: ' + (fmtIST(i.schedArr) || '?') + ' IST' + (i.estArr ? ', estimated ' + fmtIST(i.estArr) + ' IST' : '') +
      (i.arrTerminal ? ', terminal ' + i.arrTerminal : ''),
    (res.legs.length > 1 ? res.legs.length + ' legs returned; showing the first.' : ''),
    ADB_ATTRIBUTION
  ].filter(String).join('\n');
}

/** Live test: one AeroDataBox request through the gateway, after confirmation. */
function testFlightLookup() {
  var ui = SpreadsheetApp.getUi();
  var a = ui.prompt('Test a flight lookup', 'Flight number and date (local), e.g.  EK568 2026-10-21', ui.ButtonSet.OK_CANCEL);
  if (a.getSelectedButton() !== ui.Button.OK) return;
  var m = String(a.getResponseText()).trim().match(/^(.+?)\s+(\d{4}-\d{2}-\d{2})$/), f = m && normalizeFlight(m[1]);
  if (!f) { ui.alert('Not sent: enter a flight number and a date like "EK568 2026-10-21".'); return; }
  var spec = { endpoint: 'flightStatus', flight: f.flight, date: m[2], role: 'Both' };
  var u = null;
  try { u = adbUsageSummary(); } catch (e) { ui.alert('Not sent: usage store unavailable (' + redactSecrets(e.message) + ').'); return; }
  var ok = ui.alert('Confirm live request', 'This sends one AeroDataBox request for ' + spec.flight + ' on ' + spec.date +
    ' and uses 2 units (used so far: ' + u.units + '/' + u.unitLimit + ', ' + u.window + ').\nA cached answer from the last ' +
    cfg().ADB_CACHE_MIN + ' min uses none. Continue?', ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  adbResetExecution_();
  var res = adbRequest(spec);
  var notices = adbDrainNotices();
  ui.alert('Lookup result', describeLookup_(res, spec) + (notices.length ? '\n\n' + notices.join('\n') : ''), ui.ButtonSet.OK);
}
