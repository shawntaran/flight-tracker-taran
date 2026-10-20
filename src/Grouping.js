/**
 * Greedy cab clubbing (pure; tested in Node).
 * Bucket by (direction, airport, terminal); sort by key time; a person joins the current cab if
 * they are within GROUP_WINDOW_MIN of the cab's first person and a seat is free, else a new cab.
 *   Arrivals:   key = ETA (or scheduled arrival); pickup = latest key + ARRIVAL_BUFFER_MIN.
 *   Departures: key = check-in time (dep - CHECKIN_BEFORE_DEP_MIN); pickup = earliest key - TRAVEL_TO_AIRPORT_MIN.
 * Buckets are not split by calendar date: the time window already separates days, and splitting
 * at midnight would stop a 23:50 and a 00:10 arrival sharing a cab.
 */

function groupKeyTime(r, C) {
  if (r.dir === 'ARR') return r.etaAt || r.schedArrAt || null;
  var dep = r.revDepAt || r.schedDepAt;
  return dep ? dep - C.CHECKIN_BEFORE_DEP_MIN * MIN : null;
}

function isGroupable(r) {
  return r.active && r.flightNorm && r.flightNorm !== 'INVALID' && r.status !== 'CANCELLED' && r.status !== 'DIVERTED';
}

function planGroups(rows, C, nowMs) {
  var buckets = {};
  rows.forEach(function (r) {
    if (!isGroupable(r)) return;
    var t = groupKeyTime(r, C);
    if (!t || t < nowMs - 6 * HOUR) return; // long done
    var term = String((r.dir === 'ARR' && r.liveTerminal) || r.terminal || '?').toUpperCase().replace(/^(\d)$/, 'T$1');
    var k = r.dir + '|' + r.airport + '|' + term;
    (buckets[k] = buckets[k] || []).push({ r: r, t: t });
  });

  var groups = [], seq = {};
  Object.keys(buckets).sort().forEach(function (k) {
    var parts = k.split('|'), items = buckets[k], cur = null;
    items.sort(function (a, b) { return a.t - b.t || String(a.r.id).localeCompare(String(b.r.id)); });
    items.forEach(function (it) {
      if (!cur || it.t - cur.first > C.GROUP_WINDOW_MIN * MIN || cur.items.length >= C.MAX_SEATS) {
        cur = { dir: parts[0], airport: parts[1], terminal: parts[2], first: it.t, items: [] };
        groups.push(cur);
      }
      cur.items.push(it);
    });
  });

  var byRow = {};
  groups.forEach(function (g) {
    var times = g.items.map(function (it) { return it.t; });
    g.pickupMs = g.dir === 'ARR'
      ? Math.max.apply(null, times) + C.ARRIVAL_BUFFER_MIN * MIN
      : Math.min.apply(null, times) - C.TRAVEL_TO_AIRPORT_MIN * MIN;
    var day = istDateKey(g.first).slice(5).replace('-', '');
    var base = (g.dir === 'ARR' ? 'A' : 'D') + '-' + g.airport + '-' + g.terminal + '-' + day;
    seq[base] = (seq[base] || 0) + 1;
    g.id = base + '-' + seq[base];
    g.memberSig = g.dir + ':' + g.items.map(function (it) { return it.r.id; }).sort().join(',');
    g.items.forEach(function (it) { byRow[it.r.id] = { group: g, pickupMs: g.pickupMs, sig: g.memberSig }; });
  });
  return { groups: groups, byRow: byRow };
}

/** Carries vehicle/driver from the previous Groups sheet to the new group sharing the most members. */
function carryDrivers(groups, oldGroups) {
  var used = {};
  groups.forEach(function (g) {
    var ids = g.items.map(function (it) { return String(it.r.id); }), best = null, bestN = 0;
    oldGroups.forEach(function (o, i) {
      if (used[i] || !(o.driver || o.vehicle || o.driverTg)) return;
      var n = o.memberIds.filter(function (m) { return ids.indexOf(String(m)) >= 0; }).length;
      if (n > bestN) { bestN = n; best = i; }
    });
    if (best != null) {
      used[best] = true;
      g.vehicle = oldGroups[best].vehicle; g.driver = oldGroups[best].driver; g.driverTg = oldGroups[best].driverTg;
    }
  });
}

/**
 * Updates each row's group fields. Returns {changed: [group], fresh: [group]}:
 * changed = membership differs from what was last notified, or pickup moved >= threshold.
 * Small ETA drift moves the displayed pickup silently, so live updates don't spam.
 */
function applyGroups(rows, plan, C) {
  var changed = {}, fresh = {};
  rows.forEach(function (r) {
    var a = plan.byRow[r.id];
    if (!a) {
      r.groupId = ''; r.pickupDisp = '';
      if (r.groupSig) { r.groupSig = ''; r.notifiedPickupAt = null; }
      return;
    }
    r.groupId = a.group.id;
    r.pickupDisp = fmtIST(a.pickupMs);
    if (!r.groupSig) {
      fresh[a.group.id] = a.group;
    } else if (r.groupSig !== a.sig ||
      Math.abs(a.pickupMs - (r.notifiedPickupAt || 0)) >= C.ETA_ALERT_THRESHOLD_MIN * MIN) {
      changed[a.group.id] = a.group;
    } else {
      return;
    }
    r.groupSig = a.sig;
    r.notifiedPickupAt = a.pickupMs;
  });
  // Any member of a changed group re-baselines, so the whole group is notified once, together.
  var ch = Object.keys(changed).map(function (k) { return changed[k]; });
  ch.forEach(function (g) { g.items.forEach(function (it) { it.r.groupSig = g.memberSig; it.r.notifiedPickupAt = g.pickupMs; }); });
  return {
    changed: ch,
    fresh: Object.keys(fresh).filter(function (k) { return !changed[k]; }).map(function (k) { return fresh[k]; })
  };
}

function describeGroup(g) {
  var where = g.dir === 'ARR' ? g.airport + ' ' + g.terminal + ' arrivals' : 'campus -> ' + g.airport + ' ' + g.terminal;
  var lines = ['🚕 ' + g.id + ' — pickup ' + fmtIST(g.pickupMs) + ' IST (' + where + ')' +
    (g.driver ? ' · driver ' + g.driver : '') + (g.vehicle ? ' · ' + g.vehicle : '')];
  g.items.forEach(function (it) {
    var r = it.r;
    lines.push('  • ' + (r.name || r.id) + ' — ' + r.flightNorm + (g.dir === 'ARR' ? ' ETA ' : ' check-in ') +
      fmtTimeIST(it.t) + (r.phone ? ' · ' + r.phone : ''));
  });
  return lines.join('\n');
}
