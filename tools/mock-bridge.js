/**
 * Development-only mock bridge for google.script.run.
 * Provides realistic synthetic data for all dashboard pages.
 * No real personal data, no real API calls, no Google Sheets.
 */
(function () {
  'use strict';

  function fmtIST(date) {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date);
    var p = {};
    parts.forEach(function (x) { p[x.type] = x.value; });
    return p.weekday + ' ' + p.day + ' ' + p.month + ' ' + p.hour + ':' + p.minute;
  }

  // Preview-only ETA overrides so the page can be shown reordering after a refresh. id -> ms | null | any value.
  var previewState = { eta: {} };

  function getMockDashboardData() {
    var now = Date.now();
    var min = 60 * 1000;

    // All synthetic. Fields beyond the production contract (origin, aircraft, depSchedAt, telemetry,
    // group status, ...) exist only in this preview; the page hides any that are missing.
    var t = function (m) { return now + m * min; };
    var IST = 330 * min, DAY = 24 * 60 * min;
    var nextIstMidnight = Math.floor((now + IST) / DAY) * DAY + DAY - IST;
    var ov = previewState.eta;
    var eta = function (id, ms) { return Object.prototype.hasOwnProperty.call(ov, id) ? ov[id] : ms; };
    var tele = function (o) { return Object.assign({ onGround: false, fixAt: now - 2 * min }, o); };

    var flights = [
      {
        id: 'F101', name: 'Dr. Sarah Chen', dir: 'ARR', active: true, final: false,
        flight: 'AI506', invalid: false, airport: 'BLR', terminal: 'T2', gate: '24B',
        status: 'DELAYED', schedAt: t(15), etaAt: eta('F101', t(40)), etaSource: 'OpenSky ADS-B',
        origin: 'DEL', originName: 'Delhi Indira Gandhi', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A320neo', depTerminal: 'T3', depGate: '42', depSchedAt: t(-150), depActualAt: t(-125), distanceKm: 1740,
        telemetry: tele({ altFt: 31000, gsKts: 448, vsFpm: -400, headingDeg: 168, squawk: '2214', lat: 14.912, lon: 77.804,
          altHistory: [0, 18000, 33000, 35000, 35000, 35000, 33000, 31000] })
      },
      {
        id: 'F102', name: 'Prof. Marcus Vance', dir: 'ARR', active: true, final: false,
        flight: '6E2134', invalid: false, airport: 'BLR', terminal: 'T1', gate: '12',
        status: 'DELAYED', schedAt: t(45), etaAt: eta('F102', t(125)), etaSource: 'AeroDataBox',
        origin: 'BOM', originName: 'Mumbai Chhatrapati Shivaji', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A321neo', depTerminal: 'T2', depSchedAt: t(-50), distanceKm: 842,
        telemetry: { onGround: true, lat: 19.0921, lon: 72.8655, gsKts: 0, headingDeg: 270, fixAt: now - 6 * min }
      },
      {
        id: 'F103', name: 'Dr. Aditi Sharma', dir: 'ARR', active: true, final: true,
        flight: 'QP1302', invalid: false, airport: 'BLR', terminal: 'T2', gate: '08',
        status: 'LANDED', schedAt: t(-35), etaAt: eta('F103', t(-28)), etaSource: 'OpenSky ADS-B',
        origin: 'HYD', originName: 'Hyderabad Rajiv Gandhi', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Boeing 737 MAX 8', depSchedAt: t(-110), depActualAt: t(-104), distanceKm: 500,
        telemetry: { onGround: true, lat: 13.2047, lon: 77.7031, gsKts: 0, headingDeg: 92, fixAt: now - 27 * min }
      },
      {
        id: 'F104', name: 'Prof. Rajesh Nair', dir: 'ARR', active: true, final: false,
        flight: 'UK817', invalid: false, airport: 'BLR', terminal: 'T2', gate: '19',
        status: 'DEPARTED', schedAt: t(120), etaAt: eta('F104', t(112)), etaSource: 'OpenSky ADS-B',
        origin: 'CCU', originName: 'Kolkata Netaji Subhas', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A320neo', depTerminal: 'T2', depGate: '6', depSchedAt: t(-35), depActualAt: t(-40), distanceKm: 1560,
        telemetry: tele({ altFt: 36000, gsKts: 471, vsFpm: 0, headingDeg: 214, squawk: '5531', lat: 21.204, lon: 86.021,
          altHistory: [0, 22000, 34000, 36000] })
      },
      {
        id: 'F105', name: 'Dr. Elena Rostova', dir: 'ARR', active: true, final: false,
        flight: 'EK568', invalid: false, airport: 'BLR', terminal: 'T2', gate: '31A',
        status: 'DEPARTED', schedAt: t(195), etaAt: eta('F105', t(195)), etaSource: 'last live fix (no coverage now)',
        origin: 'DXB', originName: 'Dubai International', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Boeing 777-300ER', depTerminal: 'T3', depGate: 'B22', depSchedAt: t(-40), depActualAt: t(-38), distanceKm: 2704,
        telemetry: { onGround: false, lat: 23.418, lon: 60.112, altFt: 34000, gsKts: 486, headingDeg: 121, squawk: '3341', fixAt: now - 35 * min }
      },
      {
        id: 'F115', name: 'Dr. Meera Iyer', dir: 'ARR', active: true, final: false,
        flight: '6E6107', invalid: false, airport: 'BLR', terminal: 'T1', gate: '',
        status: 'SCHEDULED', schedAt: t(140), etaAt: eta('F115', t(140)), etaSource: 'AeroDataBox',
        origin: 'HYD', originName: 'Hyderabad Rajiv Gandhi', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A320neo', depSchedAt: t(75), distanceKm: 500
      },
      {
        id: 'F116', name: 'Prof. Tomás Rivera', dir: 'ARR', active: true, final: false,
        flight: 'AI803', invalid: false, airport: 'BLR', terminal: 'T2', gate: '',
        status: 'SCHEDULED', schedAt: t(55), etaAt: eta('F116', t(55)), etaSource: 'AeroDataBox',
        origin: 'DEL', originName: 'Delhi Indira Gandhi', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A321neo', depSchedAt: t(-110), depActualAt: t(-108), distanceKm: 1740
      },
      {
        id: 'F109', name: 'Dr. Priya Swaminathan', dir: 'ARR', active: true, final: false,
        flight: 'IX712', invalid: false, airport: 'BLR', terminal: 'T1', gate: '',
        status: 'SCHEDULED', schedAt: t(280), etaAt: eta('F109', null), etaSource: '',
        origin: 'MAA', originName: 'Chennai International', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        depSchedAt: t(225), distanceKm: 290
      },
      {
        id: 'F111', name: 'Prof. Kenji Watanabe', dir: 'ARR', active: true, final: false,
        flight: 'SQ508', invalid: false, airport: 'BLR', terminal: 'T2', gate: '',
        status: 'SCHEDULED', schedAt: nextIstMidnight + 25 * min, etaAt: eta('F111', nextIstMidnight + 35 * min), etaSource: 'AeroDataBox',
        origin: 'SIN', originName: 'Singapore Changi', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A350-900', depTerminal: 'T3', depSchedAt: nextIstMidnight - 230 * min, distanceKm: 3170
      },
      {
        id: 'F112', name: 'Dr. Hannah Weiss', dir: 'ARR', active: true, final: true,
        flight: 'LH754', invalid: false, airport: 'BLR', terminal: 'T2', gate: '',
        status: 'CANCELLED', schedAt: t(150), etaAt: eta('F112', null), etaSource: 'AeroDataBox',
        origin: 'FRA', originName: 'Frankfurt Main', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        aircraft: 'Airbus A350-900', depSchedAt: t(-370), distanceKm: 7388
      },
      {
        // ETA arrives as a display string (as a broken source might send): must be ignored, not parsed.
        id: 'F113', name: 'Dr. Omar Haddad', dir: 'ARR', active: true, final: false,
        flight: 'QR572', invalid: false, airport: 'BLR', terminal: 'T2', gate: '',
        status: 'SCHEDULED', schedAt: t(230), etaAt: eta('F113', 'Tue 20 Oct 18:05'), etaSource: 'AeroDataBox',
        origin: 'DOH', originName: 'Doha Hamad', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        depSchedAt: t(-20), distanceKm: 3080
      },
      {
        id: 'F114', name: 'Dr. Lucia Ferreira', dir: 'ARR', active: true, final: false,
        flight: 'TBD', invalid: true, airport: 'BLR', terminal: '', gate: '',
        status: 'UNKNOWN', schedAt: null, etaAt: eta('F114', null), etaSource: '',
        lastError: 'Flight number not entered yet.'
      },
      {
        id: 'F110', name: 'Dr. Alex Mercer', dir: 'ARR', active: false, final: false,
        flight: '6E982', invalid: false, airport: 'BLR', terminal: 'T1', gate: '07',
        status: 'UNKNOWN', schedAt: t(360), etaAt: eta('F110', null), etaSource: '',
        origin: 'BOM', originName: 'Mumbai Chhatrapati Shivaji', destination: 'BLR', destName: 'Bengaluru Kempegowda',
        lastError: 'AeroDataBox lookup failed: HTTP 429 (rate limit). Will retry next tick.'
      },
      {
        id: 'F106', name: 'Prof. David Kim', dir: 'DEP', active: true, final: false,
        flight: 'BA118', invalid: false, airport: 'BLR', terminal: 'T2', gate: '40',
        status: 'SCHEDULED', schedAt: t(240), etaAt: eta('F106', t(240)), etaSource: 'AeroDataBox',
        origin: 'BLR', originName: 'Bengaluru Kempegowda', destination: 'LHR', destName: 'London Heathrow',
        aircraft: 'Boeing 777-200ER', depTerminal: 'T2', depGate: '40', depSchedAt: t(240), destEtaAt: t(240 + 640), distanceKm: 8024
      },
      {
        id: 'F108', name: "Prof. Liam O'Connor", dir: 'DEP', active: true, final: false,
        flight: 'SG3012', invalid: false, airport: 'BLR', terminal: 'T1', gate: '14',
        status: 'DELAYED', schedAt: t(110), etaAt: eta('F108', t(135)), etaSource: 'AeroDataBox',
        origin: 'BLR', originName: 'Bengaluru Kempegowda', destination: 'BOM', destName: 'Mumbai Chhatrapati Shivaji',
        aircraft: 'Boeing 737-800', depTerminal: 'T1', depGate: '14', depSchedAt: t(110), destEtaAt: t(135 + 105), distanceKm: 842
      },
      {
        id: 'F107', name: 'Dr. Amina Yusuf', dir: 'DEP', active: true, final: true,
        flight: '6E521', invalid: false, airport: 'BLR', terminal: 'T1', gate: '05',
        status: 'DEPARTED', schedAt: t(-60), etaAt: eta('F107', t(-52)), etaSource: 'OpenSky ADS-B',
        origin: 'BLR', originName: 'Bengaluru Kempegowda', destination: 'DEL', destName: 'Delhi Indira Gandhi',
        aircraft: 'Airbus A321neo', depTerminal: 'T1', depGate: '05', depSchedAt: t(-60), depActualAt: t(-52), distanceKm: 1740
      }
    ];
    flights.forEach(function (f) {
      f.lastError = f.lastError || '';
      f.lastCheckDisp = fmtIST(new Date(now - (f.final ? 20 : 4) * min));
    });

    // No cab groups, vehicles or drivers in preview data. The Cab Suggestions page computes suggestions in the
    // browser from the real planGroups() rules; nothing is assigned or stored. groupId/pickupDisp stay empty.
    flights.forEach(function (f) { f.groupId = ''; f.pickupDisp = ''; });
    var groups = [];

    var log = [
      { at: now - 55 * min, level: 'INFO',  flight: '6E521',  message: 'OpenSky ADS-B confirmed takeoff from BLR. Tracking ended for this departure.' },
      { at: now - 48 * min, level: 'INFO',  flight: 'EK568',  message: 'AeroDataBox: status SCHEDULED, on time from DXB.' },
      { at: now - 42 * min, level: 'INFO',  flight: 'UK817',  message: 'OpenSky ADS-B: airborne from CCU, ETA recalculated.' },
      { at: now - 40 * min, level: 'WARN',  flight: 'LH754',  message: 'AeroDataBox: flight CANCELLED. Coordinator alerted.' },
      { at: now - 35 * min, level: 'ERROR', flight: '6E982',  message: 'AeroDataBox lookup failed: HTTP 429 (rate limit). Will retry next tick.' },
      { at: now - 30 * min, level: 'INFO',  flight: 'QP1302', message: 'OpenSky ADS-B: landed at BLR.' },
      { at: now - 28 * min, level: 'INFO',  flight: 'QP1302', message: 'Telegram: "QP1302 LANDED at BLR T2" sent to coordinator.' },
      { at: now - 22 * min, level: 'WARN',  flight: 'QR572',  message: 'AeroDataBox returned an unreadable ETA; using the scheduled arrival.' },
      { at: now - 18 * min, level: 'WARN',  flight: 'AI506',  message: 'AeroDataBox: departure delay out of DEL (+25m). New BLR ETA calculated.' },
      { at: now - 16 * min, level: 'INFO',  flight: 'AI506',  message: 'Telegram: "AI506 DELAYED +25m" sent to coordinator.' },
      { at: now - 12 * min, level: 'INFO',  flight: 'AI506',  message: 'Cab suggestions recalculated after the revised arrival.' },
      { at: now - 8 * min,  level: 'WARN',  flight: '6E2134', message: 'AeroDataBox: inbound aircraft late at BOM (+80m).' },
      { at: now - 6 * min,  level: 'INFO',  flight: 'SG3012', message: 'AeroDataBox: departure from BLR revised to +25m.' },
      { at: now - 4 * min,  level: 'INFO',  flight: '6E2134', message: 'Cab suggestions recalculated for the new arrival time.' },
      { at: now - 1 * min,  level: 'INFO',  flight: 'UK817',  message: 'OpenSky ADS-B position update at FL360.' }
    ];

    // Extended data for Notifications page
    var notifications = [
      { id: 'N01', at: now - 55 * min, type: 'SYSTEM',  level: 'INFO',  flight: '6E521',  message: 'Takeoff confirmed via OpenSky ADS-B from BLR runway 09R.',             channel: 'system',   recipient: '', status: '' },
      { id: 'N02', at: now - 48 * min, type: 'SYSTEM',  level: 'INFO',  flight: 'EK568',  message: 'AeroDataBox status check: SCHEDULED, on-time departure from DXB.',      channel: 'system',   recipient: '', status: '' },
      { id: 'N03', at: now - 42 * min, type: 'SYSTEM',  level: 'INFO',  flight: 'UK817',  message: 'AeroDataBox status check: SCHEDULED, en-route from CCU.',               channel: 'system',   recipient: '', status: '' },
      { id: 'N04', at: now - 35 * min, type: 'ALERT',   level: 'ERROR', flight: '6E982',  message: 'AeroDataBox lookup failed: HTTP 429 rate limit exceeded.',               channel: 'email',    recipient: 'Coordinator', status: 'SENT' },
      { id: 'N05', at: now - 32 * min, type: 'ALERT',   level: 'INFO',  flight: 'QP1302', message: 'Flight QP1302 from HYD landed at BLR Terminal 1.',                       channel: 'telegram', recipient: 'Coordinator', status: 'SENT' },
      { id: 'N06', at: now - 28 * min, type: 'ALERT',   level: 'INFO',  flight: 'QP1302', message: 'Coordinators alerted: QP1302 landed at BLR T2.', channel: 'telegram', recipient: 'Coordinator', status: 'SENT' },
      { id: 'N07', at: now - 18 * min, type: 'ALERT',   level: 'WARN',  flight: 'AI506',  message: 'Flight AI506 delayed +25m at DEL. Revised BLR ETA calculated.',          channel: 'telegram', recipient: 'Coordinator', status: 'SENT' },
      { id: 'N08', at: now - 16 * min, type: 'ALERT',   level: 'INFO',  flight: 'AI506',  message: 'Delay notification sent to coordinator with updated ETA.',               channel: 'telegram', recipient: 'Coordinator', status: 'SENT' },
      { id: 'N09', at: now - 12 * min, type: 'SYSTEM',  level: 'INFO',  flight: 'AI506',  message: 'Suggested pickup for Dr. Sarah Chen moved after the delay.', channel: 'system',   recipient: '', status: '' },
      { id: 'N10', at: now - 8 * min,  type: 'ALERT',   level: 'WARN',  flight: '6E2134', message: 'Flight 6E2134 delayed +40m due to aircraft rotation at BOM.',            channel: 'telegram', recipient: 'Coordinator', status: 'SENT' },
      { id: 'N11', at: now - 6 * min,  type: 'ALERT',   level: 'INFO',  flight: '6E2134', message: 'Delay notification sent for Prof. Marcus Vance arrival change.',         channel: 'telegram', recipient: 'Coordinator', status: 'SENT' },
      { id: 'N12', at: now - 4 * min,  type: 'SYSTEM',  level: 'INFO',  flight: '6E2134', message: 'Cab suggestions recalculated for the new 6E2134 arrival time.', channel: 'system',   recipient: '', status: '' },
      { id: 'N13', at: now - 1 * min,  type: 'SYSTEM',  level: 'INFO',  flight: 'UK817',  message: 'OpenSky position update: on-schedule at FL340, ~120 min to BLR.',        channel: 'system',   recipient: '', status: '' }
    ];

    // Extended data for API Usage page
    var apiRequests = [
      { at: now - 58 * min, provider: 'AeroDataBox', endpoint: '/flights/number/6E521',  flight: '6E521',  units: 1, responseMs: 285, status: 'OK' },
      { at: now - 55 * min, provider: 'OpenSky',     endpoint: '/states/all?icao24=…',   flight: '6E521',  units: 0, responseMs: 720, status: 'OK' },
      { at: now - 48 * min, provider: 'AeroDataBox', endpoint: '/flights/number/EK568',  flight: 'EK568',  units: 1, responseMs: 310, status: 'OK' },
      { at: now - 45 * min, provider: 'OpenSky',     endpoint: '/states/all?icao24=…',   flight: 'QP1302', units: 0, responseMs: 680, status: 'OK' },
      { at: now - 42 * min, provider: 'AeroDataBox', endpoint: '/flights/number/UK817',  flight: 'UK817',  units: 1, responseMs: 298, status: 'OK' },
      { at: now - 38 * min, provider: 'AeroDataBox', endpoint: '/flights/number/6E982',  flight: '6E982',  units: 0, responseMs: 150, status: '429 Rate Limit' },
      { at: now - 35 * min, provider: 'OpenSky',     endpoint: '/states/all?icao24=…',   flight: 'QP1302', units: 0, responseMs: 510, status: 'OK' },
      { at: now - 28 * min, provider: 'AeroDataBox', endpoint: '/flights/number/AI506',  flight: 'AI506',  units: 1, responseMs: 340, status: 'OK' },
      { at: now - 20 * min, provider: 'OpenSky',     endpoint: '/states/all?icao24=…',   flight: 'AI506',  units: 0, responseMs: 890, status: 'OK' },
      { at: now - 15 * min, provider: 'AeroDataBox', endpoint: '/flights/number/6E2134', flight: '6E2134', units: 2, responseMs: 265, status: 'OK' },
      { at: now - 10 * min, provider: 'OpenSky',     endpoint: '/states/all?icao24=…',   flight: 'UK817',  units: 0, responseMs: 430, status: 'OK' },
      { at: now - 5 * min,  provider: 'AeroDataBox', endpoint: '/flights/number/IX712',  flight: 'IX712',  units: 1, responseMs: 320, status: 'OK' },
      { at: now - 3 * min,  provider: 'OpenSky',     endpoint: '/states/all?icao24=…',   flight: 'EK568',  units: 0, responseMs: 610, status: 'OK' },
      { at: now - 1 * min,  provider: 'AeroDataBox', endpoint: '/flights/number/SG3012', flight: 'SG3012', units: 1, responseMs: 290, status: 'OK' }
    ];

    // Extended data for Settings page
    var config = {
      HOME_AIRPORT: 'BLR',
      MAX_SEATS: 4,
      CHECK_INTERVAL_MIN: 5,
      NOTIFY_LEAD_MIN: 40,
      ADB_CYCLE_DAY: 15,
      EMAIL_ALERTS: true,
      TELEGRAM_ALERTS: true,
      TIMEZONE: 'Asia/Kolkata',
      OPENSKY_ENABLED: true,
      ADB_ENABLED: true,
      FA_ENABLED: false,
      GROUPING_ALGORITHM: 'greedy-time-window',
      GROUPING_WINDOW_MIN: 45,
      LOG_RETENTION_DAYS: 14
    };

    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var nowDate = new Date(now);
    var currentWindow = monthNames[nowDate.getUTCMonth()] + ' ' + nowDate.getUTCFullYear();

    return {
      generatedAt: now,
      preview: true,
      airports: {
        BLR: { lat: 13.1986, lon: 77.7066, name: 'Bengaluru Kempegowda' }, DEL: { lat: 28.5562, lon: 77.1000, name: 'Delhi' },
        BOM: { lat: 19.0887, lon: 72.8679, name: 'Mumbai' }, HYD: { lat: 17.2403, lon: 78.4294, name: 'Hyderabad' },
        MAA: { lat: 12.9941, lon: 80.1709, name: 'Chennai' }, CCU: { lat: 22.6547, lon: 88.4467, name: 'Kolkata' },
        DXB: { lat: 25.2532, lon: 55.3657, name: 'Dubai' }, DOH: { lat: 25.2731, lon: 51.6081, name: 'Doha' },
        SIN: { lat: 1.3644, lon: 103.9915, name: 'Singapore' }, FRA: { lat: 50.0379, lon: 8.5622, name: 'Frankfurt' },
        LHR: { lat: 51.4700, lon: -0.4543, name: 'London Heathrow' }
      }, // local preview only: the page labels telemetry and cab details as synthetic
      homeAirport: 'BLR',
      maxSeats: 4,
      attribution: 'Flight status data: AeroDataBox (https://aerodatabox.com)',
      flights: flights,
      groups: groups,
      log: log,
      tickTriggers: 1,
      usage: {
        window: currentWindow,
        units: 142,
        unitLimit: 400,
        requests: 88,
        requestLimit: 300,
        suspended: ''
      },
      usageError: '',
      errors: [],
      assistant: { enabled: true },
      // Extended data for additional pages
      notifications: notifications,
      apiRequests: apiRequests,
      config: config
    };
  }

  function mockAskAssistant(query) {
    var q = String(query || '').toLowerCase().trim();
    if (q.indexOf('delay') >= 0) {
      return { text: 'Currently 2 flights are experiencing delays today: AI506 from DEL (delayed +25m, revised ETA approx. 25m from now) and 6E2134 from BOM (delayed +40m). Cab suggestions were recalculated; arrange transport manually.' };
    }
    if (q.indexOf('arrival') >= 0 || q.indexOf('summar') >= 0) {
      return { text: "Today's BLR Arrival Overview: 7 arrivals scheduled in total. 1 has landed (QP1302 at T1), 2 are currently delayed (AI506 at T2 and 6E2134 at T1), and 3 are on-schedule (UK817, EK568, IX712). Active arrivals are distributed between Terminal 1 and Terminal 2." };
    }
    if (q.indexOf('cab') >= 0 || q.indexOf('group') >= 0 || q.indexOf('adjust') >= 0) {
      return { text: 'Cab suggestions for AI506 and 6E2134 changed after their delays. Suggestions only: arrange transport manually outside the app.' };
    }
    if (q.indexOf('unknown') >= 0 || q.indexOf('status') >= 0) {
      return { text: 'All active flights currently have verified telemetry via OpenSky Network ADS-B and AeroDataBox. F110 (6E982) has UNKNOWN status due to a rate-limit error — will retry next tick.' };
    }
    return { text: 'Operations Assistant (Local Preview): Received "' + query + '". 9 flights actively monitored, cab suggestions recalculated each tick, and sync engine is running with 5-minute ticks.' };
  }

  function createRunner(successHandler, failureHandler) {
    return {
      withSuccessHandler: function (cb) { return createRunner(cb, failureHandler); },
      withFailureHandler: function (cb) { return createRunner(successHandler, cb); },
      getDashboardData: function () {
        setTimeout(function () {
          try {
            if (typeof successHandler === 'function') successHandler(getMockDashboardData());
          } catch (err) {
            if (typeof failureHandler === 'function') failureHandler(err);
          }
        }, 80);
      },
      askAssistant: function (q) {
        setTimeout(function () {
          try {
            if (typeof successHandler === 'function') successHandler(mockAskAssistant(q));
          } catch (err) {
            if (typeof failureHandler === 'function') failureHandler(err);
          }
        }, 120);
      }
    };
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = {
    withSuccessHandler: function (cb) { return createRunner(cb, null); },
    withFailureHandler: function (cb) { return createRunner(null, cb); },
    getDashboardData: function () { createRunner(null, null).getDashboardData(); },
    askAssistant: function (q) { createRunner(null, null).askAssistant(q); }
  };

  window.__FT_PREVIEW__ = {
    getData: getMockDashboardData, ask: mockAskAssistant,
    // setEta('F104', Date.now() + 20 * 60000) | setEta('F104', null) | setEta('F104', 'garbage'); then refresh.
    setEta: function (id, value) { previewState.eta[id] = value; },
    shiftEta: function (id, minutes) {
      var f = getMockDashboardData().flights.filter(function (x) { return x.id === id; })[0];
      var base = f && (typeof f.etaAt === 'number' ? f.etaAt : f.schedAt);
      if (typeof base === 'number') previewState.eta[id] = base + minutes * 60000;
    },
    resetEta: function () { previewState.eta = {}; }
  };
  console.info('[Flight Tracker Preview] Local development mock bridge active (google.script.run)');
})();
