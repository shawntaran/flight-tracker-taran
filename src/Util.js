/**
 * Pure helpers: time (UTC storage, IST display), flight-number normalisation, geo.
 * No Apps Script services are used here so the file can be unit-tested in Node.
 */

var MIN = 60 * 1000;
var HOUR = 60 * MIN;
var IST_OFFSET_MIN = 330; // India has no DST, so a fixed offset is exact.

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function istDate_(ms) { return new Date(ms + IST_OFFSET_MIN * MIN); }

/** 'YYYY-MM-DD' of an instant, in IST. */
function istDateKey(ms) { return istDate_(ms).toISOString().slice(0, 10); }

/** 'Tue 20 Oct 14:05' in IST. */
function fmtIST(ms) {
  if (ms == null || ms === '' || isNaN(ms)) return '';
  var d = istDate_(ms);
  return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

/** '14:05' in IST. */
function fmtTimeIST(ms) {
  if (ms == null || ms === '' || isNaN(ms)) return '';
  var d = istDate_(ms);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function istToMs(y, mo, d, h, mi) { return Date.UTC(y, mo, d, h || 0, mi || 0) - IST_OFFSET_MIN * MIN; }

/** Stored machine value (ISO string / Date / number / '') -> ms or null. */
function toMs(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return v;
  var t = Date.parse(String(v));
  return isNaN(t) ? null : t;
}

function isoOrBlank(ms) { return ms == null || ms === '' || isNaN(ms) ? '' : new Date(ms).toISOString(); }

/**
 * A coordinator-entered time (interpreted as IST) -> ms.
 * Accepts Date cells (sheet timezone must be Asia/Kolkata), '2026-10-20 14:35',
 * '20/10/2026 14:35', '20-10-2026 2:35 PM'.
 */
function parseIstInput(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
  var s = String(v).trim(), m;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (m) return istToMs(+m[1], +m[2] - 1, +m[3], to24_(+m[4], m[6]), +m[5]);
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (m) return istToMs(+m[3], +m[2] - 1, +m[1], to24_(+m[4], m[6]), +m[5]); // dd/mm/yyyy
  return null;
}

function to24_(h, ampm) {
  if (!ampm) return h;
  ampm = ampm.toLowerCase();
  if (ampm === 'pm' && h < 12) return h + 12;
  if (ampm === 'am' && h === 12) return 0;
  return h;
}

/** AeroDataBox time object {utc: '2026-10-20 03:15Z', local: ...} -> ms or null. */
function parseApiTime(t) {
  if (!t) return null;
  var s = typeof t === 'string' ? t : t.utc;
  if (!s) return null;
  var ms = Date.parse(String(s).replace(' ', 'T'));
  return isNaN(ms) ? null : ms;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  var R = 6371, toRad = Math.PI / 180;
  var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Airlines: [IATA, ICAO, name, aliases...]. Extend via the "Airlines" sheet
// (menu: Import OpenFlights airlines) without touching code.
// ---------------------------------------------------------------------------
var AIRLINES = [
  ['EK', 'UAE', 'Emirates'], ['QR', 'QTR', 'Qatar Airways', 'Qatar'], ['EY', 'ETD', 'Etihad Airways', 'Etihad'],
  ['SQ', 'SIA', 'Singapore Airlines', 'Singapore'], ['LH', 'DLH', 'Lufthansa'], ['BA', 'BAW', 'British Airways'],
  ['AF', 'AFR', 'Air France'], ['KL', 'KLM', 'KLM', 'KLM Royal Dutch Airlines'], ['AI', 'AIC', 'Air India'],
  ['IX', 'AXB', 'Air India Express'], ['6E', 'IGO', 'IndiGo'], ['UK', 'VTI', 'Vistara'], ['SG', 'SEJ', 'SpiceJet'],
  ['QP', 'AKJ', 'Akasa Air', 'Akasa'], ['LX', 'SWR', 'Swiss', 'Swiss International Air Lines'],
  ['TK', 'THY', 'Turkish Airlines', 'Turkish'], ['CX', 'CPA', 'Cathay Pacific', 'Cathay'],
  ['MH', 'MAS', 'Malaysia Airlines'], ['TG', 'THA', 'Thai Airways', 'Thai'], ['QF', 'QFA', 'Qantas'],
  ['VJ', 'VJC', 'VietJet Air', 'Vietjet'], ['VN', 'HVN', 'Vietnam Airlines'],
  ['AA', 'AAL', 'American Airlines', 'American'], ['UA', 'UAL', 'United Airlines', 'United'],
  ['DL', 'DAL', 'Delta Air Lines', 'Delta'], ['AC', 'ACA', 'Air Canada'], ['NH', 'ANA', 'All Nippon Airways', 'ANA'],
  ['JL', 'JAL', 'Japan Airlines'], ['KE', 'KAL', 'Korean Air'], ['VS', 'VIR', 'Virgin Atlantic'],
  ['SV', 'SVA', 'Saudia', 'Saudi Arabian Airlines'], ['GF', 'GFA', 'Gulf Air'], ['WY', 'OMA', 'Oman Air'],
  ['FZ', 'FDB', 'flydubai'], ['G9', 'ABY', 'Air Arabia'], ['J9', 'JZR', 'Jazeera Airways'],
  ['KU', 'KAC', 'Kuwait Airways'], ['UL', 'ALK', 'SriLankan Airlines', 'SriLankan'],
  ['BG', 'BBC', 'Biman Bangladesh Airlines', 'Biman'], ['AK', 'AXM', 'AirAsia'], ['FD', 'AIQ', 'Thai AirAsia'],
  ['TR', 'TGW', 'Scoot'], ['MU', 'CES', 'China Eastern'], ['CA', 'CCA', 'Air China'], ['CZ', 'CSN', 'China Southern'],
  ['ET', 'ETH', 'Ethiopian Airlines', 'Ethiopian'], ['KQ', 'KQA', 'Kenya Airways'], ['MS', 'MSR', 'EgyptAir'],
  ['VN', 'HVN', 'Vietnam Airlines'], ['OD', 'MXD', 'Batik Air Malaysia', 'Malindo Air'], ['AY', 'FIN', 'Finnair'],
  ['IB', 'IBE', 'Iberia'], ['AZ', 'ITY', 'ITA Airways'], ['LO', 'LOT', 'LOT Polish Airlines'],
  ['OS', 'AUA', 'Austrian Airlines', 'Austrian'], ['SN', 'BEL', 'Brussels Airlines'],
  ['SK', 'SAS', 'Scandinavian Airlines', 'SAS'], ['NZ', 'ANZ', 'Air New Zealand'], ['GA', 'GIA', 'Garuda Indonesia'],
  ['PR', 'PAL', 'Philippine Airlines'], ['BR', 'EVA', 'EVA Air'], ['CI', 'CAL', 'China Airlines'],
  ['PG', 'BKP', 'Bangkok Airways'], ['8M', 'MMA', 'Myanmar Airways International']
];

var AIRLINE_EXTRA = []; // filled from the "Airlines" sheet at runtime
var airlineIndex_ = null;

function setExtraAirlines(list) { AIRLINE_EXTRA = list || []; airlineIndex_ = null; }

function airlineIndex_get_() {
  if (airlineIndex_) return airlineIndex_;
  var idx = { byIata: {}, byIcao: {}, byName: {} };
  // Built-ins last so they win over imported rows for the same key.
  AIRLINE_EXTRA.concat(AIRLINES).forEach(function (a) {
    var iata = a[0], icao = a[1];
    if (iata) idx.byIata[iata] = a;
    if (icao) idx.byIcao[icao] = a;
    for (var i = 2; i < a.length; i++) if (a[i]) idx.byName[normName_(a[i])] = a;
  });
  airlineIndex_ = idx;
  return idx;
}

function normName_(s) { return String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/**
 * 'EK 568' / 'ek-0568' / 'UAE568' / 'Emirates 568' -> {flight:'EK568', iata:'EK', number:'568', callsign:'UAE568'}.
 * Returns null if it cannot be parsed. callsign is a best guess (IATA->ICAO prefix);
 * the AeroDataBox callSign, when available, overrides it.
 */
function normalizeFlight(raw) {
  if (raw == null) return null;
  var s = String(raw).toUpperCase().replace(/[. ]/g, ' ').trim();
  if (!s) return null;
  var idx = airlineIndex_get_();
  var m = s.match(/^(.*?)[\s-]*0*(\d{1,4}[A-Z]?)$/);
  if (!m) return null;
  var prefix = m[1].replace(/[\s-]+$/, '').trim(), num = m[2], air = null;
  var compact = prefix.replace(/[\s-]/g, '');

  if (/^[A-Z0-9]{2}$/.test(compact) && !/^\d\d$/.test(compact)) {
    air = idx.byIata[compact] || [compact, ''];
  } else if (/^[A-Z]{3}$/.test(compact) && idx.byIcao[compact]) {
    air = idx.byIcao[compact];
  } else if (idx.byName[normName_(prefix)]) {
    air = idx.byName[normName_(prefix)];
  }
  if (!air || !air[0]) return null;
  return { flight: air[0] + num, iata: air[0], number: num, callsign: air[1] ? air[1] + num : '' };
}
