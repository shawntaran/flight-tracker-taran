/**
 * Configuration has exactly three homes:
 *   1. Secrets          -> Script Properties (Apps Script: Project Settings -> Script properties).
 *                          Names are listed in SECRETS below; secret() refuses any other name.
 *   2. Tunable settings -> the "Config" sheet (Key | Value | Notes), defaults in DEFAULTS below.
 *                          A blank cell means "use the default".
 *   3. Plan hard limits -> constants in AdbClient.js (ADB_PLAN); Config values can only be lower.
 * Script state (usage counters, suspension) also lives in Script Properties but is managed by code.
 */

/** Every secret the code reads. Values are never logged, shown, or written to the sheet. */
var SECRETS = [
  { name: 'ADB_KEY', required: true, integration: 'AeroDataBox',
    purpose: 'RapidAPI key for AeroDataBox flight status',
    howTo: 'rapidapi.com -> AeroDataBox -> subscribe to Basic (free) -> copy the X-RapidAPI-Key' },
  { name: 'TG_BOT_TOKEN', required: true, integration: 'Telegram',
    purpose: 'Telegram bot token for coordinator / driver alerts',
    howTo: 'Telegram -> @BotFather -> /newbot -> copy the token' },
  { name: 'OPENSKY_CLIENT_ID', required: false, integration: 'OpenSky', pair: 'OPENSKY_CLIENT_SECRET',
    purpose: 'OpenSky API client id (without it OpenSky is used anonymously: 400 credits/day)',
    howTo: 'opensky-network.org -> Account -> API client' },
  { name: 'OPENSKY_CLIENT_SECRET', required: false, integration: 'OpenSky', pair: 'OPENSKY_CLIENT_ID',
    purpose: 'OpenSky API client secret', howTo: 'created together with the client id' },
  { name: 'FA_KEY', required: false, integration: 'FlightAware',
    purpose: 'FlightAware AeroAPI key, used only as a backup when AeroDataBox fails or is out of budget',
    howTo: 'flightaware.com/aeroapi -> Personal plan -> API key' }
];
var SECRET_NAMES = {};
SECRETS.forEach(function (s) { SECRET_NAMES[s.name] = s; });

/** Settings from earlier versions that are no longer read. */
var OBSOLETE_SETTINGS = {
  ADB_UNITS_PER_CALL: 'unit costs now come from the verified endpoint tier (AdbClient.js)'
};
var DEFAULTS = {
  HOME_AIRPORT: ['BLR', 'Default airport when the Airport column is blank'],
  GROUP_WINDOW_MIN: [45, 'Max gap between first and last person in a shared cab'],
  MAX_SEATS: [4, 'Passenger seats per cab'],
  ARRIVAL_BUFFER_MIN: [40, 'Immigration + baggage after landing, before pickup'],
  CHECKIN_BEFORE_DEP_MIN: [180, 'Be at the airport this long before an international departure'],
  TRAVEL_TO_AIRPORT_MIN: [90, 'Campus -> airport drive time'],
  ETA_ALERT_THRESHOLD_MIN: [15, 'Alert when ETA / pickup moves by at least this much'],
  APPROACH_MIN: [20, 'Added to distance/speed for descent and approach'],
  T_MINUS_CHECK_H: [6, 'First status check this many hours before departure'],
  FIRST_CHECK_BEFORE_ARR_H: [24, 'If Sched Dep is blank, first check this long before arrival'],
  MIN_CONNECTION_MIN: [60, 'Warn if first leg lands later than this before the onward flight'],
  MAX_ADB_CALLS_PER_FLIGHT: [4, 'Hard cap on provider calls (AeroDataBox + FlightAware) per flight row'],
  ADB_MONTHLY_UNITS: [400, 'AeroDataBox unit limit per billing period (cannot exceed the plan: 400)'],
  ADB_MONTHLY_REQUESTS: [1600, 'AeroDataBox request limit per billing period (cannot exceed the plan: 1600)'],
  ADB_WARN_PCT: ['70,85,95', 'Alert coordinators when units or requests reach these % of the limit'],
  ADB_BILLING_CYCLE_DAY: ['', 'Blank = safe rolling 33-day window. Set 1-31 only after confirming the quota reset day on the RapidAPI dashboard'],
  ADB_MIN_INTERVAL_MS: [1100, 'Minimum gap between AeroDataBox requests (plan: 1 request/second)'],
  ADB_MAX_REQUESTS_PER_HOUR: [1000, 'AeroDataBox requests per clock hour (cannot exceed the plan: 1000)'],
  ADB_CACHE_MIN: [20, 'Reuse an identical AeroDataBox result for this long (max 360; always under the 7-day limit)'],
  ADB_RETENTION_HOURS: [156, 'Purge provider-derived data after this long (max 168 = 7 days)'],
  LIVE_WINDOW_NO_DEP_H: [18, 'Without a departure time, look for the aircraft on OpenSky from this long before arrival'],
  OPENSKY_STALE_MIN: [20, 'Ignore OpenSky positions older than this'],
  LANDED_RADIUS_KM: [15, 'On-ground within this distance of the airport counts as landed'],
  NO_CONFIRM_AFTER_MIN: [60, 'Alert if no landing confirmation this long after ETA'],
  NOTIFY_FACULTY: [false, 'Also message faculty (needs their Telegram chat id / email)'],
  COORD_TG_CHAT_IDS: ['', 'Comma-separated Telegram chat ids for coordinators'],
  COORD_EMAILS: ['', 'Comma-separated coordinator emails'],
  EMAIL_ALERTS: [true, 'Send coordinator alerts by email as well as Telegram']
};

var AIRPORTS = {
  BLR: { lat: 13.1986, lon: 77.7066, name: 'Bengaluru' },
  MAA: { lat: 12.9941, lon: 80.1709, name: 'Chennai' },
  BOM: { lat: 19.0887, lon: 72.8679, name: 'Mumbai' },
  DEL: { lat: 28.5562, lon: 77.1000, name: 'Delhi' },
  HYD: { lat: 17.2403, lon: 78.4294, name: 'Hyderabad' },
  COK: { lat: 10.1520, lon: 76.4019, name: 'Kochi' }
};

/** Plain defaults object (used directly by tests). */
function defaultConfig() {
  var c = {};
  Object.keys(DEFAULTS).forEach(function (k) { c[k] = DEFAULTS[k][0]; });
  return c;
}

var cfgCache_ = null;
var cfgIssues_ = [];

/**
 * Pure: Config sheet rows [[key, value], ...] -> {config, issues}. A blank value keeps the default;
 * a value that cannot be read as the default's type keeps the default and is reported.
 */
function mergeConfig_(rows) {
  var c = defaultConfig(), issues = [];
  (rows || []).forEach(function (row) {
    var k = String(row[0] == null ? '' : row[0]).trim(), v = row[1];
    if (!k || k === 'Key') return;
    if (OBSOLETE_SETTINGS[k]) { issues.push({ level: 'warn', key: k, message: 'obsolete setting ignored: ' + OBSOLETE_SETTINGS[k] }); return; }
    if (!(k in c)) { issues.push({ level: 'warn', key: k, message: 'unknown setting ignored' }); return; }
    if (v === '' || v == null) return;
    var d = c[k];
    if (typeof d === 'number') {
      var n = Number(v);
      if (typeof v === 'boolean' || String(v).trim() === '' || !isFinite(n)) {
        issues.push({ level: 'error', key: k, message: 'not a number; using default ' + d });
        return;
      }
      v = n;
    } else if (typeof d === 'boolean') {
      v = v === true || /^(true|yes|1)$/i.test(String(v));
    } else {
      v = String(v).trim();
    }
    c[k] = v;
  });
  if (c.ADB_MONTHLY_UNITS > 400) issues.push({ level: 'warn', key: 'ADB_MONTHLY_UNITS', message: 'above the plan limit; 400 is used' });
  if (c.ADB_MONTHLY_REQUESTS > 1600) issues.push({ level: 'warn', key: 'ADB_MONTHLY_REQUESTS', message: 'above the plan limit; 1600 is used' });
  if (c.ADB_MAX_REQUESTS_PER_HOUR > 1000) issues.push({ level: 'warn', key: 'ADB_MAX_REQUESTS_PER_HOUR', message: 'above the plan limit; 1000 is used' });
  var day = String(c.ADB_BILLING_CYCLE_DAY).trim();
  if (day !== '' && !/^([1-9]|[12]\d|3[01])$/.test(day)) {
    issues.push({ level: 'error', key: 'ADB_BILLING_CYCLE_DAY', message: 'must be blank or 1-31; AeroDataBox lookups stay off until fixed' });
  } else if (day === '1') {
    issues.push({ level: 'warn', key: 'ADB_BILLING_CYCLE_DAY', message: '1 was the default in an earlier version. Keep it only if the RapidAPI dashboard confirms the quota resets on the 1st; otherwise clear it (safe rolling window)' });
  }
  return { config: c, issues: issues };
}

/**
 * Pure: existing Config rows [[key, value, note], ...] -> what "Set up sheets" should write.
 * Missing keys are appended with their defaults; notes are refreshed; values are never touched.
 */
function planConfigSheet_(rows) {
  var seen = {}, notes = [];
  (rows || []).forEach(function (row, i) {
    var k = String(row[0] == null ? '' : row[0]).trim();
    if (!k) return;
    seen[k] = true;
    var note = DEFAULTS[k] ? DEFAULTS[k][1] : OBSOLETE_SETTINGS[k] ? 'NOT USED by this version (' + OBSOLETE_SETTINGS[k] + ')' : 'NOT USED: unknown setting';
    if (String(row[2] == null ? '' : row[2]) !== note) notes.push({ row: i, note: note });
  });
  var append = Object.keys(DEFAULTS).filter(function (k) { return !seen[k]; })
    .map(function (k) { return [k, DEFAULTS[k][0], DEFAULTS[k][1]]; });
  return { append: append, notes: notes };
}

/** Defaults merged with the Config sheet. Problems are kept in cfgIssues_ for the setup check. */
function cfg() {
  if (cfgCache_) return cfgCache_;
  var sh = SpreadsheetApp.getActive().getSheetByName('Config');
  var rows = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  var merged = mergeConfig_(rows);
  cfgIssues_ = merged.issues;
  cfgCache_ = merged.config;
  return cfgCache_;
}

/** Reads a Script Property by its registered name. Unknown names are a programming error. */
function secret(key) {
  if (!SECRET_NAMES[key]) throw new Error('Unknown secret name: ' + key);
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return v == null ? null : String(v).trim() || null;
}

/**
 * Pure: secret getter -> per-secret status. Never includes values.
 * status: 'ok' | 'missing' | 'incomplete' (one half of a pair) | 'suspicious' (shape looks wrong)
 */
function secretStatus_(getRaw) {
  return SECRETS.map(function (s) {
    var raw = getRaw(s.name), v = raw == null ? '' : String(raw);
    var r = { name: s.name, integration: s.integration, required: s.required, status: 'ok', message: 'set' };
    if (!v.trim()) {
      r.status = 'missing';
      r.message = (s.required ? 'REQUIRED and missing. ' : 'not set (optional). ') + s.howTo;
    } else if (v !== v.trim()) {
      r.status = 'suspicious'; r.message = 'set, but has leading/trailing spaces (they are ignored; re-paste to be safe)';
    } else if (s.name === 'TG_BOT_TOKEN' && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(v)) {
      r.status = 'suspicious'; r.message = 'set, but does not look like a BotFather token (digits:letters)';
    } else if (s.name === 'ADB_KEY' && v.length < 20) {
      r.status = 'suspicious'; r.message = 'set, but shorter than a RapidAPI key';
    }
    if (s.pair && r.status !== 'missing') {
      var other = getRaw(s.pair);
      if (other == null || !String(other).trim()) { r.status = 'incomplete'; r.message = 'set, but ' + s.pair + ' is missing; OpenSky will be used anonymously'; }
    }
    return r;
  });
}

// ---------------------------------------------------------------- redaction
var redactValues_ = null; // per-execution cache of secret values to mask; tests may set it

function redactionValues_() {
  if (redactValues_) return redactValues_;
  try {
    var p = PropertiesService.getScriptProperties();
    redactValues_ = SECRETS.map(function (s) { return p.getProperty(s.name); })
      .filter(function (v) { return v && String(v).trim().length >= 8; })
      .map(function (v) { return String(v).trim(); });
  } catch (e) {
    redactValues_ = [];
  }
  return redactValues_;
}

/**
 * Masks secret values and anything shaped like a Telegram bot token. Applied to every log line,
 * alert and rethrown error, because UrlFetchApp error messages can contain the request URL
 * (and the Telegram API puts the token in the URL).
 */
function redactSecrets(text) {
  var s = String(text == null ? '' : text);
  redactionValues_().forEach(function (v) { s = s.split(v).join('[REDACTED]'); });
  return s.replace(/bot\d{5,}:[A-Za-z0-9_-]+/g, 'bot[REDACTED]').replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]');
}

function listSetting(s) {
  return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(String);
}
