/**
 * Overview dashboard, served as a web app (Deploy → New deployment → Web app; see README).
 * Read-only: it shows what the tracker already wrote to the sheets. It never calls a flight provider,
 * sends a message, spends AeroDataBox units or writes to the spreadsheet.
 * Personal data is minimised: names only; no phone, email or Telegram chat id leaves the server.
 */

var DASHBOARD_PAGE = 'DashboardPage'; // src/DashboardPage.html (must not share a name with a script file)
var DASHBOARD_LOG_ROWS = 8;

function doGet() {
  return HtmlService.createHtmlOutputFromFile(DASHBOARD_PAGE)
    .setTitle('Flight Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Menu item: a link to the deployed web app, or how to deploy it. */
function openDashboard() {
  var url = ScriptApp.getService().getUrl();
  var body = url
    ? 'Open the <a href="' + dashboardEscape_(url) + '" target="_blank" rel="noopener">Flight Tracker dashboard</a> in a new tab.'
    : 'The dashboard is not deployed yet. In Apps Script choose Deploy → New deployment → Web app (see README).';
  SpreadsheetApp.getUi().showModelessDialog(
    HtmlService.createHtmlOutput('<p style="font:14px sans-serif">' + body + '</p>').setWidth(380).setHeight(110), 'Dashboard');
}

/** Called by the page through google.script.run. Each source fails on its own, so one bad sheet never blanks the page. */
function getDashboardData() {
  var f = { now: Date.now(), errors: [] };
  var attempt = function (label, fn) {
    try { return fn(); } catch (e) { f.errors.push(label + ': ' + redactSecrets(e && e.message || e)); return null; }
  };
  f.config = attempt('Config', cfg) || defaultConfig();
  f.rows = attempt('Flights', readFlights) || [];
  f.groups = attempt('Groups', readGroupsSheet) || [];
  f.log = attempt('Log', function () { return readRecentLog_(DASHBOARD_LOG_ROWS); }) || [];
  f.lastTick = attempt('Status', readHeartbeat_);
  f.tickTriggers = attempt('Triggers', function () {
    return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'tick'; }).length;
  });
  try { f.usage = adbUsageSummary(); } catch (e) { f.usageError = redactSecrets(e && e.message || e); }
  f.assistantEnabled = typeof askAssistant === 'function'; // hook for the optional chat layer (task T6); absent today
  return buildDashboardData_(f);
}

/**
 * Dashboard "Force check" button, step 1: the same confirmation text as the menu item (rows, estimated
 * units, per-flight calls left). Sends nothing. The web app is owner-only (appsscript.json).
 */
function forceCheckPlanFromDashboard(id) {
  var C = cfg();
  var plan = planForceCheck_(String(id || ''), readFlights().map(function (r) { return prepareRow(r, C); }), C);
  return plan.error ? { ok: false, error: plan.error } : { ok: true, text: plan.text, willCall: plan.willCall };
}

/** Step 2, after the person confirms: the menu's code path and lock. Never waits silently on a busy lock. */
function forceCheckFromDashboard(id) {
  var plan = forceCheckPlanFromDashboard(id);
  if (!plan.ok) return plan;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return { ok: false, error: CHECK_BUSY_MSG };
  try {
    var res = runTick_(Date.now(), { forceIds: [String(id).trim().toUpperCase()] });
    return { ok: true, text: describeForceResults_(res), outcome: res.forced[0] ? res.forced[0].outcome : '' };
  } catch (e) {
    var msg = redactSecrets(e && e.message || e);
    logEvent('ERROR', '', 'Force check from the dashboard failed: ' + msg);
    recordHeartbeat_(Date.now(), null, msg);
    return { ok: false, error: 'The force check failed: ' + msg };
  } finally { lock.releaseLock(); }
}

/** Pure: sheet facts -> plain JSON for the page (google.script.run cannot return Date objects). */
function buildDashboardData_(f) {
  var C = f.config;
  var byGroup = {};
  var flights = f.rows.map(function (src) {
    var r = prepareRow(Object.assign({}, src), C); // same interpretation as the tracker; this copy is never written
    var arr = r.dir === 'ARR';
    var out = {
      id: String(r.id), name: String(r.name || ''), dir: r.dir, active: r.active, final: isFinal(r),
      flight: r.flightNorm === 'INVALID' ? String(r.flightRaw || '') : r.flightNorm, invalid: r.flightNorm === 'INVALID',
      airport: r.airport, terminal: String(r.liveTerminal || r.terminal || ''), gate: String(r.gate || ''),
      status: String(r.status || ''), schedAt: toMs(arr ? r.schedArrAt : r.schedDepAt),
      etaAt: toMs(arr ? r.etaAt : r.revDepAt), etaSource: String(r.etaSource || ''), // as Tracker's etaDisp
      groupId: String(r.groupId || ''), pickupDisp: String(r.pickupDisp || ''),
      lastCheckDisp: String(r.lastCheckDisp || ''), lastError: redactSecrets(String(r.lastError || ''))
    };
    if (out.groupId) (byGroup[out.groupId] = byGroup[out.groupId] || []).push(out);
    return out;
  });
  var groups = f.groups.map(function (g) {
    var members = byGroup[g.id] || [];
    return {
      id: String(g.id), count: g.memberIds.length || members.length, vehicle: String(g.vehicle || ''),
      driver: String(g.driver || ''), pickupDisp: members.length ? members[0].pickupDisp : ''
    };
  });
  return {
    generatedAt: f.now, homeAirport: C.HOME_AIRPORT, maxSeats: Number(C.MAX_SEATS) || 0,
    attribution: ADB_ATTRIBUTION, flights: flights, groups: groups, log: f.log,
    tickTriggers: f.tickTriggers == null ? null : f.tickTriggers,
    usage: f.usage ? {
      window: f.usage.window, units: f.usage.units, unitLimit: f.usage.unitLimit, requests: f.usage.requests,
      requestLimit: f.usage.requestLimit, suspended: f.usage.suspended ? String(f.usage.suspended.reason || 'suspended') : ''
    } : null,
    usageError: f.usageError || '', errors: f.errors || [], assistant: { enabled: !!f.assistantEnabled },
    lastTick: f.lastTick || null // {at, result, error, triggerInstalled} from the Status tab, or null (no heartbeat yet)
  };
}

/** Newest-last rows from the Log sheet as plain values. Messages were redacted when written; redacted again here. */
function readRecentLog_(n) {
  var sh = SpreadsheetApp.getActive().getSheetByName(LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  var count = Math.min(n, sh.getLastRow() - 1);
  return sh.getRange(sh.getLastRow() - count + 1, 1, count, 4).getValues().map(function (v) {
    return { at: toMs(v[0]), level: String(v[1]), flight: String(v[2]), message: redactSecrets(String(v[3])) };
  });
}

function dashboardEscape_(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
