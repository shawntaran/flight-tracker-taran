/**
 * The 5-minute tick. Per flight:
 *   1. OpenSky (free, one shared call): live position -> own ETA; on ground near the airport -> landed.
 *   2. AeroDataBox through the budgeted gateway (AdbClient.js): T-6h before departure, then at
 *      departure to confirm takeoff (skipped if OpenSky already has a live fix), then ETA+30 min only
 *      if OpenSky never confirmed the landing. Hard cap per flight; FlightAware as backup.
 *   3. Status change or ETA shift >= threshold -> alert. Cab groups re-planned every tick;
 *      only changed groups are notified.
 *   4. Silence is never "on time": a lookup that cannot be performed, 2 consecutive failures, or no
 *      landing confirmation NO_CONFIRM_AFTER_MIN after ETA -> status UNKNOWN and a coordinator alert.
 * Everything that touches no Apps Script service is a plain function so it can be tested in Node.
 */

var FINAL = { ARR: { LANDED: 1, CANCELLED: 1, DIVERTED: 1 }, DEP: { DEPARTED: 1, CANCELLED: 1, DIVERTED: 1 } };
var NOTABLE = { DELAYED: 1, DEPARTED: 1, LANDED: 1, CANCELLED: 1, DIVERTED: 1 };
var MACHINE_RESET = ['revDepAt', 'adbEtaAt', 'etaAt', 'lastFixAt', 'nextCheckAt', 'alertedEtaAt', 'callsign',
  'icao24', 'depLocalDate', 'providerFetchedAt', 'alertedStatus', 'flags', 'status', 'etaSource', 'liveTerminal', 'gate', 'lastError'];

function hasFlag(r, f) { return (',' + (r.flags || '') + ',').indexOf(',' + f + ',') >= 0; }
function setFlag(r, f) { if (!hasFlag(r, f)) r.flags = (r.flags ? r.flags + ',' : '') + f; }
function clearFlag(r, f) { r.flags = String(r.flags || '').split(',').filter(function (x) { return x && x !== f; }).join(','); }

function isFinal(r) { return !!FINAL[r.dir][r.status]; }

/** Normalises inputs and resets machine state if the coordinator changed the flight or times. */
function prepareRow(r, C) {
  r.dir = /^d/i.test(String(r.direction || '')) ? 'DEP' : 'ARR';
  r.airport = String(r.airport || C.HOME_AIRPORT).toUpperCase().trim();
  r.active = !(r.active === false || /^(false|no|0)$/i.test(String(r.active)));
  r.adbCalls = Number(r.adbCalls) || 0;
  r.failCount = Number(r.failCount) || 0;
  if (!r.id) { r.id = 'F' + r._row; r._newId = true; }
  var f = normalizeFlight(r.flightRaw);
  r.flightNorm = f ? f.flight : 'INVALID';
  if (!r.callsign && f) r.callsign = f.callsign;

  var depIn = parseIstInput(r.schedDepIn), arrIn = parseIstInput(r.schedArrIn);
  var key = [r.flightNorm, r.dir, depIn || '', arrIn || ''].join('|');
  if (r.stateKey && r.stateKey !== key) {
    MACHINE_RESET.forEach(function (k) { r[k] = (k.slice(-2) === 'At') ? null : ''; });
    r.schedDepAt = null; r.schedArrAt = null; r.adbCalls = 0; r.failCount = 0;
    if (f) r.callsign = f.callsign;
  }
  r.stateKey = key;
  if (depIn) r.schedDepAt = depIn;
  if (arrIn) r.schedArrAt = arrIn;
  if (!r.status) r.status = 'SCHEDULED';

  r.lastError = !f ? 'Cannot parse flight number "' + r.flightRaw + '"'
    : (r.dir === 'ARR' && !r.schedArrAt && !r.schedDepAt) ? 'Need Sched Arr (IST)'
      : (r.dir === 'DEP' && !r.schedDepAt) ? 'Need Sched Dep (IST)'
        : (r.lastError || '');
  return r;
}

function isTrackable(r) {
  return r.active && r.flightNorm !== 'INVALID' && !isFinal(r) &&
    (r.dir === 'ARR' ? !!(r.schedArrAt || r.schedDepAt) : !!r.schedDepAt);
}

/** When the next AeroDataBox call is due (ms) or null if none planned. */
function nextCheckTime(r, nowMs, C) {
  if (isFinal(r)) return null;
  var t6 = C.T_MINUS_CHECK_H * HOUR, dep = r.revDepAt || r.schedDepAt;
  if (!dep) {
    // Arrival with unknown departure time: one early call learns it.
    return r.dir === 'ARR' && r.schedArrAt ? r.schedArrAt - C.FIRST_CHECK_BEFORE_ARR_H * HOUR : null;
  }
  if (r.status !== 'DEPARTED') {
    if (nowMs < r.schedDepAt - t6 - 30 * MIN) return r.schedDepAt - t6;   // T-6h check
    if (r.dir === 'DEP') return null;                                     // leaving BLR: T-6h is enough
    return Math.max(dep + 10 * MIN, nowMs + 15 * MIN);                    // confirm takeoff
  }
  if (r.dir === 'ARR') return (r.etaAt || r.adbEtaAt || r.schedArrAt) + 30 * MIN; // fallback landing check
  return null;
}

/** First check for a row that has never been checked. */
function initialCheckTime(r, C) {
  if (r.schedDepAt) return r.schedDepAt - C.T_MINUS_CHECK_H * HOUR;
  if (r.dir === 'ARR' && r.schedArrAt) return r.schedArrAt - C.FIRST_CHECK_BEFORE_ARR_H * HOUR;
  return null;
}

/**
 * Merges a successful provider result into the row. -> notes (strings) about data that was not applied.
 * Terminal/gate are the provider's *current* answer: a response without them clears old provider values.
 * The coordinator's own Terminal column (r.terminal) is separate and never touched here.
 */
function applyInfo(r, info, nowMs) {
  var notes = [];
  if (info.schedDep && !parseIstInput(r.schedDepIn)) r.schedDepAt = info.schedDep;
  if (info.schedArr && !parseIstInput(r.schedArrIn)) r.schedArrAt = info.schedArr;
  r.providerFetchedAt = nowMs;
  if (info.revDep) r.revDepAt = info.revDep;
  if (info.callsign) r.callsign = info.callsign;
  if (info.icao24) r.icao24 = info.icao24;
  if (info.depLocalDate) r.depLocalDate = info.depLocalDate;
  if (r.dir === 'ARR') {
    r.liveTerminal = info.arrTerminal ? String(info.arrTerminal).replace(/^(\d)$/, 'T$1') : '';
    r.gate = info.arrGate ? String(info.arrGate) : '';
  }
  // Never step back from a state OpenSky already established, and never cancel an aircraft that a
  // live position shows airborne in the last 30 minutes (an uncertain provider status loses to a fix).
  var liveAirborne = r.status === 'DEPARTED' && /^live/.test(r.etaSource || '') && r.lastFixAt && nowMs - r.lastFixAt < 30 * MIN;
  if (r.status === 'DEPARTED' && (info.status === 'SCHEDULED' || info.status === 'DELAYED')) {
    // keep DEPARTED
  } else if (liveAirborne && info.status === 'CANCELLED') {
    notes.push(info.source + ' says ' + info.rawStatus + ', but OpenSky saw the aircraft airborne at ' + fmtTimeIST(r.lastFixAt) +
      ' IST; status kept as airborne');
  } else {
    r.status = info.status;
  }
  if (r.dir === 'ARR') {
    r.adbEtaAt = info.actualArr || info.estArr || info.schedArr || r.adbEtaAt;
    if (!/^live/.test(r.etaSource || '') || r.status === 'LANDED') {
      r.etaAt = r.adbEtaAt;
      r.etaSource = info.source + (info.actualArr ? ' (actual)' : info.estArr ? ' (estimated)' : ' (scheduled)');
    }
  }
  return notes;
}

/**
 * Guests on the same flight (same flight number and direction, scheduled within 6 h of each other) are on one
 * aircraft: a row without the aircraft's id or callsign takes them from another, so the live position reaches every
 * guest; and an arrival another guest's row already has as LANDED is landed too (the aircraft may stop
 * transmitting at the gate before this row is looked at again).
 */
function shareSameFlight_(rows) {
  var when = function (r) { return r.dir === 'ARR' ? (r.schedArrAt || r.schedDepAt) : r.schedDepAt; };
  rows.forEach(function (r) {
    if (!r.active || r.flightNorm === 'INVALID' || !when(r)) return;
    rows.forEach(function (o) {
      if (o === r || !o.active || o.flightNorm !== r.flightNorm || o.dir !== r.dir || !when(o) || Math.abs(when(o) - when(r)) > 6 * HOUR) return;
      if (!r.icao24 && o.icao24) r.icao24 = o.icao24;
      if (!r.callsign && o.callsign) r.callsign = o.callsign;
      if (r.dir === 'ARR' && o.status === 'LANDED' && !isFinal(r)) {
        r.status = 'LANDED'; r.etaAt = o.etaAt; r.lastFixAt = o.lastFixAt; r.etaSource = o.etaSource;
        if (o.liveTerminal && !r.liveTerminal) r.liveTerminal = o.liveTerminal;
      }
    });
  });
}

/** Merges an OpenSky observation. live = liveEta(...) or null when not seen. */
function applyLive(r, live, nowMs) {
  if (live && live.landed) {
    r.status = 'LANDED'; r.etaAt = live.fixMs; r.lastFixAt = live.fixMs; r.etaSource = 'live (ADS-B, on ground)';
    return;
  }
  if (live && live.etaMs) {
    if (r.status !== 'LANDED') r.status = 'DEPARTED';
    r.etaAt = live.etaMs; r.lastFixAt = live.fixMs;
    r.etaSource = 'live (ADS-B, ' + Math.round(live.distKm) + ' km out)'; // OpenSky or, in the Node engine, adsb.lol
    return;
  }
  // Not visible (ADS-B coverage is patchy over the ocean / Middle East).
  if (r.lastFixAt && nowMs - r.lastFixAt < 45 * MIN) {
    r.etaSource = 'last live fix ' + fmtTimeIST(r.lastFixAt) + ' IST (no coverage now)';
  } else if (r.status === 'DEPARTED') {
    r.etaAt = r.adbEtaAt || r.schedArrAt;
    r.etaSource = 'airline/scheduled — no live position';
  }
}

/** -> alert text or null; updates the alert baseline on the row. */
function detectChange(r, C) {
  var key = r.dir === 'ARR' ? r.etaAt : (r.revDepAt || r.schedDepAt);
  var prev = r.alertedStatus || '';
  // UNKNOWN has its own alert at the point the lookup fails, so it is silent here.
  var statusChanged = r.status !== prev && !!(NOTABLE[r.status] || NOTABLE[prev]) && r.status !== 'UNKNOWN' &&
    !(prev === '' && r.status === 'SCHEDULED');
  var shift = key && r.alertedEtaAt ? Math.round((key - r.alertedEtaAt) / MIN) : 0;
  var etaChanged = Math.abs(shift) >= C.ETA_ALERT_THRESHOLD_MIN && !FINAL[r.dir][r.status];
  r.alertedStatus = r.status;
  if (!statusChanged && !etaChanged) {
    if (!r.alertedEtaAt && key) r.alertedEtaAt = key;
    return null;
  }
  if (key) r.alertedEtaAt = key;
  return describeChange(r, shift);
}

function describeChange(r, shift) {
  var who = r.flightNorm + ' (' + (r.name || r.id) + ')';
  var shiftTxt = shift ? ' (' + (shift > 0 ? '+' : '') + shift + ' min)' : '';
  var term = r.liveTerminal || r.terminal || '';
  if (r.dir === 'DEP') {
    var dep = r.revDepAt || r.schedDepAt;
    if (r.status === 'CANCELLED') return '❌ ' + who + ' departure CANCELLED — rebooking needed; cab cancelled.';
    if (r.status === 'DEPARTED') return '🛫 ' + who + ' has departed ' + r.airport + '.';
    return '🕒 ' + who + ' departure from ' + r.airport + ' now ' + fmtIST(dep) + ' IST' + shiftTxt + '.';
  }
  switch (r.status) {
    case 'CANCELLED': return '❌ ' + who + ' CANCELLED — contact faculty for rebooking.';
    case 'DIVERTED': return '⚠️ ' + who + ' DIVERTED — check with airline.';
    case 'LANDED': return '🛬 ' + who + ' LANDED at ' + r.airport + ' ' + term + ' ' + fmtTimeIST(r.etaAt) + ' IST.' +
      (r.groupId ? ' Cab ' + r.groupId + ' pickup ' + r.pickupDisp + '.' : '');
  }
  var verb = r.status === 'DEPARTED' ? '✈️ ' + who + ' airborne' : r.status === 'DELAYED' ? '🕒 ' + who + ' DELAYED' : '🕒 ' + who + ' update';
  return verb + ' — ETA ' + r.airport + ' ' + term + ' ' + fmtIST(r.etaAt) + ' IST' + shiftTxt + '. Source: ' + r.etaSource + '.';
}

function refreshDisplay(r) {
  r.etaDisp = fmtIST(r.dir === 'ARR' ? (r.etaAt || r.schedArrAt) : (r.revDepAt || r.schedDepAt));
}

// ---------------------------------------------------------------- Apps Script entry
function tick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    runTick_(Date.now());
  } catch (e) {
    var safe = redactSecrets(e && e.stack || e);
    logEvent('ERROR', '', safe);
    recordHeartbeat_(Date.now(), null, redactSecrets(e && e.message || e) || 'unknown error');
    try { notifyCoordinators_('⚠️ Flight tracker error: ' + redactSecrets(e && e.message || e) + ' — alerts may be missing until fixed.'); } catch (e2) {}
    throw new Error(redactSecrets(e && e.message || e)); // the original may carry a token-bearing URL
  } finally {
    lock.releaseLock();
  }
}

/**
 * One tracker run. opts.sendPlan: also send the full cab plan. opts.forceIds: row IDs to check with the
 * provider now (menu "Force check"), even if not due and even if OpenSky already confirms them airborne.
 * Forced rows still go through fetchFlightInfo (budget, dedupe, cache) and the per-flight cap; final,
 * inactive and invalid rows are refused. Without forceIds a run behaves exactly as before.
 * -> {at, lookupsDue, lookupsMade, rowsUpdated, alertsQueued, forced: [{id, flight, name, outcome, status,
 *     eta, source, error, callsUsed, callsLeft}]}
 *    outcome: checked | cap | final | inactive | invalid | blocked | failed
 */
function runTick_(now, opts) {
  opts = opts || {};
  var C = cfg();
  loadExtraAirlines();
  var rows = readFlights().map(function (r) { return prepareRow(r, C); });
  var out = new Outbox();
  var forced = {}, forcedOutcome = {};
  (opts.forceIds || []).forEach(function (id) { forced[String(id).trim().toUpperCase()] = true; });
  var isForced = function (r) { return !!forced[String(r.id).toUpperCase()]; };
  var before = {}, callsBefore = {}, lookupsDue = 0;
  rows.forEach(function (r) { before[r.id] = [r.status, r.etaAt, r.revDepAt].join('|'); callsBefore[r.id] = r.adbCalls; });
  adbResetExecution_();
  rows.forEach(function (r) { purgeExpiredProviderData(r, now, C); });
  purgeOldLogs_(now, C);

  shareSameFlight_(rows);

  // 1. OpenSky first (free): a live fix makes a pending AeroDataBox takeoff check unnecessary.
  var airborne = rows.filter(function (r) {
    return isTrackable(r) && r.dir === 'ARR' && AIRPORTS[r.airport] && r.status !== 'CANCELLED' &&
      (r.status === 'DEPARTED' ||
       (r.schedDepAt && now >= (r.revDepAt || r.schedDepAt)) ||
       (!r.schedDepAt && r.schedArrAt && now >= r.schedArrAt - C.LIVE_WINDOW_NO_DEP_H * HOUR));
  });
  if (airborne.length) {
    // Callsigns go along for position sources that look up by callsign (the Node engine's adsb.lol); OpenSky ignores them.
    var os = openskyStates(airborne.map(function (r) { return r.icao24 || ''; }), airborne.map(function (r) { return r.callsign || ''; }));
    var props = PropertiesService.getScriptProperties();
    if (os.ok) {
      props.setProperty('OPENSKY_FAILS', '0');
      airborne.forEach(function (r) {
        var st = findState(os.states, r.icao24, r.callsign);
        applyLive(r, st ? liveEta(st, AIRPORTS[r.airport], now, C) : null, now);
        r.lastCheckDisp = fmtIST(now);
      });
    } else {
      var fails = Number(props.getProperty('OPENSKY_FAILS') || 0) + 1;
      props.setProperty('OPENSKY_FAILS', String(fails));
      logEvent('WARN', '', os.error);
      if (fails === 2) out.coord('⚠️ OpenSky failed twice (' + os.error + '). Live ETAs paused; using airline/scheduled times.');
      airborne.forEach(function (r) { applyLive(r, null, now); });
    }
    shareSameFlight_(rows); // a landing seen for one guest reaches the others on that flight in the same run
  }

  // 2. Provider checks (AeroDataBox via the budgeted gateway, FlightAware as backup)
  var freshInfo = {}; // row id -> this tick's provider info (in memory only)
  rows.forEach(function (r) {
    var force = isForced(r);
    if (force) {
      var refused = !r.active ? 'inactive' : r.flightNorm === 'INVALID' ? 'invalid' : isFinal(r) ? 'final' : !isTrackable(r) ? 'invalid' : '';
      if (refused) { forcedOutcome[r.id] = refused; return; }
    }
    if (!isTrackable(r)) return;
    var due = force ? now : r.nextCheckAt || initialCheckTime(r, C);
    if (!due || now < due) return;
    if (!force && r.status === 'DEPARTED' && r.lastFixAt && now - r.lastFixAt < 15 * MIN && due < (r.etaAt || 0)) {
      r.nextCheckAt = nextCheckTime(r, now, C); // OpenSky already confirms it is airborne
      return;
    }
    // Per-flight cap covers every external provider request (AeroDataBox + FlightAware + first-leg).
    var left = C.MAX_ADB_CALLS_PER_FLIGHT - r.adbCalls;
    if (left <= 0) {
      if (force) forcedOutcome[r.id] = 'cap';
      return;
    }
    lookupsDue++;
    var res = fetchFlightInfo(r, left);
    r.adbCalls += res.attempts || 0;
    r.lastCheckDisp = fmtIST(now);
    if (force) forcedOutcome[r.id] = res.ok ? 'checked' : res.blocked && !res.attempts ? 'blocked' : 'failed';
    if (!res.ok && res.blocked && !res.attempts) {
      // Nothing was sent (budget / suspension / usage store). Never let that read as "on time".
      markUnknown_(r);
      r.lastError = res.error;
      r.nextCheckAt = now + 30 * MIN;
      if (!hasFlag(r, 'BLOCKED')) {
        setFlag(r, 'BLOCKED');
        out.coord('❓ ' + r.flightNorm + ' (' + (r.name || r.id) + ') status UNKNOWN — lookup not performed: ' + res.error +
          '. Live OpenSky tracking continues where available.');
      }
      return;
    }
    if (!res.ok) {
      r.failCount++;
      r.lastError = res.error;
      var identity = res.kind === 'identity';
      var definitive = identity || res.kind === 'notfound' || res.kind === 'nomatch';
      // No quick retry when the outcome is unknown, or when the provider answered "no such flight".
      r.nextCheckAt = now + (definitive ? 180 : res.uncertain ? 30 : 15) * MIN;
      logEvent('WARN', r.flightNorm, res.error);
      if (identity) {
        // Several (or wrongly timed) instances of this flight number: nothing was guessed or applied.
        r.lastError = 'IDENTITY MISMATCH: ' + res.error;
        markUnknown_(r);
        if (!hasFlag(r, 'IDENTITY')) {
          setFlag(r, 'IDENTITY');
          out.coord('❓ ' + r.flightNorm + ' (' + (r.name || r.id) + '): could not tell which flight is meant — ' + res.error +
            '. Correct the date or Sched ' + (r.dir === 'ARR' ? 'Arr' : 'Dep') + ' (IST) on the Flights sheet. Status UNKNOWN; nothing was guessed.');
        }
      } else if (definitive && !hasFlag(r, 'NOTFOUND')) {
        setFlag(r, 'NOTFOUND');
        markUnknown_(r);
        out.coord('⚠️ ' + r.flightNorm + ' (' + (r.name || r.id) + '): ' + res.error +
          '. Check the flight number and date on the Flights sheet. Status UNKNOWN; rechecked in 3 h (per-flight cap applies).');
      }
      if (r.failCount >= 2 && !hasFlag(r, 'FAIL2')) {
        setFlag(r, 'FAIL2');
        markUnknown_(r);
        out.coord('⚠️ No status for ' + r.flightNorm + ' (' + (r.name || r.id) + ') after ' + r.failCount +
          ' failed lookups: ' + res.error + '. Status UNKNOWN — please check manually.');
      }
      return;
    }
    r.failCount = 0;
    clearFlag(r, 'FAIL2'); clearFlag(r, 'BLOCKED'); clearFlag(r, 'NOTFOUND'); clearFlag(r, 'IDENTITY');
    var notes = applyInfo(r, res.info, now);
    if (res.fallback) {
      // Data came from the FlightAware backup: usable, but AeroDataBox is still failing for this row.
      r.lastError = 'AeroDataBox failed (' + (res.adbKind || 'error') + '); used FlightAware backup: ' + res.adbError;
      if (!/backup/.test(r.etaSource || '')) r.etaSource = (r.etaSource || 'FlightAware') + ' [backup]';
      if (!hasFlag(r, 'FALLBACK') && !/^(budget|suspended|store|ratelimit)$/.test(res.adbKind || '')) {
        out.coord('ℹ️ ' + r.flightNorm + ' (' + (r.name || r.id) + '): AeroDataBox failed (' + res.adbError +
          '); status taken from the FlightAware backup.');
      }
      setFlag(r, 'FALLBACK');
    } else {
      r.lastError = '';
      clearFlag(r, 'FALLBACK');
    }
    if (notes.length) {
      r.lastError = (r.lastError ? r.lastError + ' | ' : '') + notes.join(' | ');
      notes.forEach(function (n) { logEvent('WARN', r.flightNorm, n); });
    }
    r.nextCheckAt = nextCheckTime(r, now, C);
    logEvent('INFO', r.flightNorm, res.info.source + ': ' + res.info.rawStatus + ', ETA ' + fmtIST(r.etaAt));
    freshInfo[r.id] = res.info;
  });
  // First-leg connection checks: after the main checks, bounded and sharing the row's cap.
  rows.forEach(function (r) { checkFirstLeg_(r, C, out, freshInfo[r.id], now); });
  adbDrainNotices().forEach(function (n) { out.coord(n); });

  // 3. Cab groups (before change alerts so LANDED messages can name the cab)
  var plan = planGroups(rows, C, now);
  carryDrivers(plan.groups, readGroupsSheet());
  var gc = applyGroups(rows, plan, C);
  writeGroupsSheet(plan.groups);

  // 4. Status / ETA alerts
  rows.forEach(function (r) {
    if (!r.active || r.flightNorm === 'INVALID') return;
    var msg = detectChange(r, C);
    if (msg) {
      out.coord(msg);
      if (C.NOTIFY_FACULTY) out.person(r, msg);
      if (r.status === 'LANDED') {
        var a = plan.byRow[r.id];
        if (a && a.group.driverTg) out.direct(a.group.driverTg, msg + '\n' + describeGroup(a.group));
      }
    }
    var arrRef = r.etaAt || r.schedArrAt;
    if (r.dir === 'ARR' && !isFinal(r) && arrRef && now > arrRef + C.NO_CONFIRM_AFTER_MIN * MIN &&
        now - arrRef < 24 * HOUR && !hasFlag(r, 'NOCONFIRM')) {
      setFlag(r, 'NOCONFIRM');
      out.coord('⚠️ ' + r.flightNorm + ' (' + (r.name || r.id) + ') — no landing confirmation ' + C.NO_CONFIRM_AFTER_MIN +
        ' min after expected ' + fmtTimeIST(arrRef) + ' IST. Status unknown; please check.');
    }
    refreshDisplay(r);
  });

  // 5. Cab change notifications
  gc.changed.forEach(function (g) {
    var text = 'Cab plan changed:\n' + describeGroup(g);
    out.coord(text);
    if (g.driverTg) out.direct(g.driverTg, text);
    if (C.NOTIFY_FACULTY) g.items.forEach(function (it) { out.person(it.r, text); });
  });
  if (gc.fresh.length) out.coord('New cab groups:\n' + gc.fresh.map(describeGroup).join('\n'));
  if (opts.sendPlan) out.coord('Current cab plan:\n' + (plan.groups.map(describeGroup).join('\n') || '(none)'));

  writeFlights(rows);
  var alertsQueued = out.coordMsgs.length + out.directMsgs.length; // before the repeat filter in flush
  out.flush(C);
  var summary = tickSummary_(rows, opts.forceIds || [], forcedOutcome, before, callsBefore, lookupsDue, alertsQueued, now, C);
  recordHeartbeat_(now, summary, ''); // Status tab; never throws
  return summary;
}

/** Pure: what a run did, for the menu messages and the heartbeat. */
function tickSummary_(rows, forceIds, forcedOutcome, before, callsBefore, lookupsDue, alertsQueued, now, C) {
  var byId = {}, made = 0, updated = 0;
  rows.forEach(function (r) {
    byId[String(r.id).toUpperCase()] = r;
    made += Math.max(0, r.adbCalls - (callsBefore[r.id] || 0));
    if (before[r.id] !== [r.status, r.etaAt, r.revDepAt].join('|')) updated++;
  });
  var forced = forceIds.map(function (id) {
    var r = byId[String(id).trim().toUpperCase()];
    if (!r) return { id: String(id), flight: '', name: '', outcome: 'invalid', status: '', eta: '', source: '', error: 'no such row on the Flights tab', callsUsed: 0, callsLeft: 0 };
    var outcome = forcedOutcome[r.id] || 'failed';
    var reason = { cap: 'per-flight cap of ' + C.MAX_ADB_CALLS_PER_FLIGHT + ' provider calls reached; no request sent',
      final: 'already ' + r.status + '; nothing to check', inactive: 'Active is unticked', invalid: r.lastError || 'flight number or time not usable' }[outcome];
    return {
      id: r.id, flight: r.flightNorm, name: r.name || '', outcome: outcome, status: r.status,
      eta: fmtIST(r.dir === 'ARR' ? (r.etaAt || r.schedArrAt) : (r.revDepAt || r.schedDepAt)), source: r.etaSource || '',
      error: reason || (outcome === 'checked' ? '' : r.lastError || ''), callsUsed: Math.max(0, r.adbCalls - (callsBefore[r.id] || 0)),
      callsLeft: Math.max(0, C.MAX_ADB_CALLS_PER_FLIGHT - r.adbCalls)
    };
  });
  return { at: now, lookupsDue: lookupsDue, lookupsMade: made, rowsUpdated: updated, alertsQueued: alertsQueued, forced: forced };
}

/**
 * Pure: picks the leg of the first-leg flight that feeds the onward flight.
 * connAirport = the onward flight's departure airport (IATA), or '' if unknown.
 *   1. Only legs arriving at connAirport count (when it is known).
 *   2. One candidate: that one. Several: the latest arrival not after the onward departure;
 *      if every candidate arrives after it, the earliest (the tightest miss).
 * -> {leg, arr} or {leg: null, reason}. Never falls back to an unrelated leg.
 */
function selectFirstLeg_(legs, connAirport, onwardMs) {
  var arrOf = function (l) {
    var a = l.arrival || {};
    return parseApiTime(a.predictedTime) || parseApiTime(a.revisedTime) || parseApiTime(a.scheduledTime);
  };
  var cands = (legs || []).filter(function (l) { return l && l.arrival; });
  if (connAirport) {
    cands = cands.filter(function (l) { return l.arrival.airport && l.arrival.airport.iata === connAirport; });
    if (!cands.length) return { leg: null, reason: 'no leg of it arrives at ' + connAirport + ' (the onward flight\'s departure airport) on that date' };
  }
  if (!cands.length) return { leg: null, reason: 'no legs returned' };
  if (cands.length === 1) return { leg: cands[0], arr: arrOf(cands[0]) };
  var timed = cands.map(function (l) { return { leg: l, arr: arrOf(l) }; }).filter(function (x) { return x.arr; });
  if (!timed.length || !onwardMs) return { leg: null, reason: cands.length + ' legs and no times to choose between them' };
  var before = timed.filter(function (x) { return x.arr <= onwardMs; }).sort(function (a, b) { return b.arr - a.arr; });
  return before[0] || timed.sort(function (a, b) { return a.arr - b.arr; })[0];
}

/*
 * First-leg connection check policy. No schema change: progress lives in the machine `flags` text as
 * one token  FL<requests>@<nextTryEpochMinutes>@<connectionAirport>@<D|P>  (D = onward date, P = previous date).
 *  - At most FIRSTLEG_MAX_REQUESTS (2) requests per row: the first try, then ONE of
 *      a retry after FIRSTLEG_RETRY_MIN for a transient failure (HTTP error, timeout, 429), or
 *      a lookup on the previous local date when nothing lands at the connection airport (overnight layover;
 *      only when the connection airport is known, so it never guesses).
 *  - They count toward the row's MAX_ADB_CALLS_PER_FLIGHT and may not use its last call, which stays for
 *    the main flight. They go through adbRequest(), so quota, dedupe, cache and fail-closed rules apply.
 *  - Blocked lookups (budget, suspension, usage store) cost nothing and are retried on later ticks.
 *  - Every way of not finishing (terminal error, requests used up, cap reached, or the onward departure
 *    under FIRSTLEG_GIVE_UP_MIN away) ends with a "Connection not checked" note: silence never means "safe".
 */
var FIRSTLEG_MAX_REQUESTS = 2, FIRSTLEG_RETRY_MIN = 30, FIRSTLEG_GIVE_UP_MIN = 60;
var FIRSTLEG_TRANSIENT = { http: 1, unknown: 1, ratelimit: 1 };

function firstLegState_(r) {
  var m = String(r.flags || '').match(/(?:^|,)FL(\d+)@(\d+)@([A-Z]{0,3})@([DP])(?=,|$)/);
  return m ? { n: +m[1], next: +m[2] * MIN, conn: m[3], prev: m[4] === 'P' } : { n: 0, next: 0, conn: '', prev: false };
}

function setFirstLegState_(r, st) {
  r.flags = String(r.flags || '').split(',').filter(function (x) { return x && !/^FL\d+@/.test(x); })
    .concat(st ? ['FL' + st.n + '@' + Math.floor(st.next / MIN) + '@' + (st.conn || '') + '@' + (st.prev ? 'P' : 'D')] : []).join(',');
}

function prevDateKey_(key) { return new Date(Date.parse(key + 'T00:00:00Z') - 24 * HOUR).toISOString().slice(0, 10); }

/** Runs every tick for rows with a First Leg Flight; does nothing until it is due. */
function checkFirstLeg_(r, C, out, info, nowMs) {
  if (!r.firstLeg || hasFlag(r, 'FIRSTLEG') || r.dir !== 'ARR' || !r.active || r.flightNorm === 'INVALID' || !r.depLocalDate) return;
  nowMs = nowMs || Date.now();
  var who = r.name || r.id, st = firstLegState_(r);
  var conn = (info && info.depAirport) || st.conn || '', onward = r.revDepAt || r.schedDepAt;
  var finish = function (note) {
    setFirstLegState_(r, null);
    setFlag(r, 'FIRSTLEG');
    if (!note) return;
    logEvent('WARN', r.flightNorm, 'first leg: ' + note);
    out.coord('⚠️ Connection not checked for ' + who + ': first leg ' + String(r.firstLeg).trim() + ' — ' + note +
      '. Check the connection manually, or fix the First Leg Flight column.');
  };
  if (r.status === 'CANCELLED' || r.status === 'DIVERTED') return finish(null); // the connection no longer matters
  if (onward && nowMs >= onward + 6 * HOUR) return finish(null);               // long past: nothing useful to say
  var f = normalizeFlight(r.firstLeg);
  if (!f) return finish('"' + r.firstLeg + '" is not a recognisable flight number');
  if (onward && nowMs >= onward - FIRSTLEG_GIVE_UP_MIN * MIN) {
    return finish('it could not be completed before the onward flight (' + fmtIST(onward) + ' IST)');
  }
  if (st.next && nowMs < st.next) return;                                       // waiting to retry
  if (st.n >= FIRSTLEG_MAX_REQUESTS) return finish('no usable answer after ' + st.n + ' requests');
  if (r.adbCalls + 1 >= C.MAX_ADB_CALLS_PER_FLIGHT) {
    return finish('the per-flight request cap (' + C.MAX_ADB_CALLS_PER_FLIGHT + ') is needed for the main flight');
  }
  var date = st.prev ? prevDateKey_(r.depLocalDate) : r.depLocalDate;
  var res = adbRequest({ endpoint: 'flightStatus', flight: f.flight, date: date, role: 'Arrival' });
  if (res.attempted) r.adbCalls++;
  var used = st.n + (res.attempted ? 1 : 0);
  var save = function (next, prev) { setFirstLegState_(r, { n: used, next: next, conn: conn, prev: prev }); };
  if (!res.ok && res.blocked) return save(nowMs + FIRSTLEG_RETRY_MIN * MIN, st.prev); // nothing sent, nothing charged
  var retryOrFinish = function (reason) {
    if (used < FIRSTLEG_MAX_REQUESTS) {
      logEvent('WARN', f.flight, 'first leg: ' + reason + '; retrying in ' + FIRSTLEG_RETRY_MIN + ' min');
      return save(nowMs + FIRSTLEG_RETRY_MIN * MIN, st.prev);
    }
    finish(reason + ' (after ' + used + ' requests)');
  };
  var overnightOrFinish = function (reason) {
    if (!st.prev && conn && used < FIRSTLEG_MAX_REQUESTS) {
      logEvent('INFO', f.flight, 'first leg: ' + reason + '; trying the previous date (overnight connection)');
      return save(nowMs, true); // next tick
    }
    finish(reason + (st.prev ? ' (the previous date ' + date + ' was checked too)' : ''));
  };
  if (!res.ok) {
    if (res.kind === 'notfound') return overnightOrFinish(res.error);
    if (FIRSTLEG_TRANSIENT[res.kind]) return retryOrFinish(res.error);
    return finish(res.error);                                                    // auth, invalid, config: terminal
  }
  var pick = selectFirstLeg_(res.legs, conn, onward);
  if (!pick.leg) return /no leg of it arrives|no legs returned/.test(pick.reason) ? overnightOrFinish(pick.reason) : finish(pick.reason);
  finish(null);
  var land = pick.arr, cancelled = /^cancel/.test(statusKey_(pick.leg.status));
  if (cancelled || (land && onward && onward - land < C.MIN_CONNECTION_MIN * MIN)) {
    out.coord('⚠️ Connection risk for ' + (r.name || r.id) + ': first leg ' + f.flight +
      (cancelled ? ' is CANCELLED' : ' lands ' + (conn ? 'at ' + conn + ' ' : '') + fmtIST(land) + ' IST') +
      ', onward ' + r.flightNorm + ' departs ' + fmtIST(onward) + ' IST.');
  }
}

/** A lookup could not be done: show UNKNOWN unless a fresher signal (live / landed) exists. */
function markUnknown_(r) {
  if (r.status === 'SCHEDULED' || r.status === 'DELAYED' || r.status === 'UNKNOWN') r.status = 'UNKNOWN';
}

/**
 * Provider data may be kept at most 7 days (AeroDataBox terms §5.5). After ADB_RETENTION_HOURS
 * the provider-derived fields are cleared; coordinator inputs and the final status word are kept
 * (the status prevents a finished flight from being polled again).
 */
function purgeExpiredProviderData(r, nowMs, C) {
  var limitMs = Math.min(Number(C.ADB_RETENTION_HOURS) || 0, 168) * HOUR;
  if (!r.providerFetchedAt || nowMs - r.providerFetchedAt < limitMs) return false;
  ['revDepAt', 'adbEtaAt'].forEach(function (k) { r[k] = null; });
  ['depLocalDate', 'icao24', 'gate', 'liveTerminal'].forEach(function (k) { r[k] = ''; });
  if (!parseIstInput(r.schedDepIn)) r.schedDepAt = null;
  if (!parseIstInput(r.schedArrIn)) r.schedArrAt = null;
  if (!/^live/.test(r.etaSource || '')) r.etaAt = null;
  var f = normalizeFlight(r.flightRaw);
  r.callsign = f ? f.callsign : '';
  r.etaSource = 'provider data purged (7-day retention)';
  r.providerFetchedAt = null;
  return true;
}
