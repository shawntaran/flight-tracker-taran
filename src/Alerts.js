/**
 * Alerts go out through Telegram (bot from @BotFather) and Gmail (MailApp). Both are free.
 *
 *   Tracker.js -> Outbox.coord() / direct() / person()     plain text only: no Telegram details
 *     -> flush(): repeat filter (a text identical to one in the recipient's previous alert,
 *                 less than ALERT_REPEAT_MIN ago, is dropped)
 *        coordinators: one combined message per tick -> every COORD_TG_CHAT_IDS chat + one email
 *        drivers / faculty: their own message -> Telegram, or email when they have no chat id
 *     -> tgDeliver_(): each Telegram message x recipient is a row on the "Telegram Deliveries" sheet,
 *        written QUEUED before sending, then SENT (Telegram confirmed; message id kept), RETRY
 *        (transient failure; retried in a later tick), FAILED (permanent, or attempts used up),
 *        UNCONFIRMED (outcome unknown; not retried again, to avoid a duplicate) or EXPIRED.
 * Callers hold the script lock (tick, "Send current cab plan", "Send test alert"), so one execution
 * at a time writes the Deliveries sheet. Email has no delivery receipt; failures are logged.
 * Messages are plain text (no parse_mode), so names and flight data never need escaping.
 */

var TG_API = 'https://api.telegram.org/bot';
var TG_DELIVERIES = 'Telegram Deliveries';
var TG_HEADERS = ['Queued (IST)', 'Delivery ID', 'Role', 'Chat ID', 'State', 'Attempts', 'Last attempt (IST)',
  'Delivered (IST)', 'Next attempt (IST)', 'Telegram message id', 'Error', 'Message'];
var TG_FORMATS = ['yyyy-mm-dd hh:mm', '@', '@', '@', '@', '0', 'yyyy-mm-dd hh:mm:ss', 'yyyy-mm-dd hh:mm:ss',
  'yyyy-mm-dd hh:mm', '@', '@', '@'];
var TG_POLICY = {
  maxLen: 4096,             // Telegram's limit for one message
  reserve: 120,             // room for the "(1/2)" marker and the delayed-delivery line
  maxAttempts: 4,           // per message x recipient, across ticks
  backoffMin: [5, 10, 20],  // wait before attempts 2, 3 and 4 (a tick is 5 min)
  maxUncertainAttempts: 2,  // after a network error the message may have arrived: one more try at most
  expireMin: 120,           // undelivered alerts older than this are dropped: flight news goes stale
  inlineWaitMaxS: 3,        // a 429 retry_after up to this is waited once inside the run; longer ones wait for a later tick
  runBudgetMs: 20000,       // Telegram time per execution; anything left waits for the next tick
  chatGapMs: 1100,          // Telegram allows about one message per second to the same chat
  readTail: 300             // only recent rows can still be pending
};
var TG_FINAL = { SENT: 1, FAILED: 1, UNCONFIRMED: 1, EXPIRED: 1 };
var ALERT_REPEAT_MIN = 120;
var ALERT_REPEAT_KEY = 'ALERT_REPEAT_V1';

var TG_ENV = null;                // tests inject a fake environment here
var alertRepeatBypass_ = false;   // set while a person explicitly asks for a message (cab plan, test alert)

function tgEnv_() {
  if (TG_ENV) return TG_ENV;
  return {
    fetch: function (url, opts) { return UrlFetchApp.fetch(url, opts); },
    sleep: function (ms) { Utilities.sleep(ms); },
    now: function () { return Date.now(); },
    secret: secret,
    cache: scriptCacheOrNull_(),
    store: tgSheetStore_
  };
}

function scriptCacheOrNull_() {
  try { return CacheService.getScriptCache(); } catch (e) { return null; }
}

// ---------------------------------------------------------------- Outbox (the tracker's interface)
function Outbox() { this.coordMsgs = []; this.directMsgs = []; }

Outbox.prototype.coord = function (text) { this.coordMsgs.push(text); };

/** role labels the Deliveries row; the tracker calls direct() only for drivers. */
Outbox.prototype.direct = function (tgChatId, text, email, role) {
  this.directMsgs.push({ tg: String(tgChatId || '').trim(), email: String(email || '').trim(), text: text, role: role || 'driver' });
};

Outbox.prototype.person = function (r, text) {
  if (r.tg || r.email) this.direct(r.tg, text, r.email, 'faculty');
};

function attributionLine_() { return '\n\n— ' + ADB_ATTRIBUTION; }

/** Every outgoing message may carry AeroDataBox-derived data, so each carries the attribution line. */
function withAttribution_(text) { return text + attributionLine_(); }

Outbox.prototype.flush = function (C) {
  C = C || cfg();
  var env = tgEnv_(), repeats = new RepeatFilter_(env.cache, env.now()), batch = [];
  if (this.coordMsgs.length) notifyCoordinators_(this.coordMsgs, C, { batch: batch, repeats: repeats });
  this.directMsgs.forEach(function (m) {
    if (!repeats.fresh(m.tg ? 'tg:' + m.tg : 'em:' + m.email, [m.text]).length) return;
    var chat = m.tg ? tgCheckChatId_(m.tg, m.role) : null;
    if (chat && chat.ok) { batch.push({ chatId: chat.id, role: m.role, text: m.text }); return; }
    if (chat) logEvent('WARN', '', 'Telegram chat id "' + m.tg + '" of a ' + m.role + ' skipped: ' + chat.why + (m.email ? '; sent by email instead.' : '.'));
    if (m.email) sendEmail_(m.email, 'Travel update', withAttribution_(m.text));
  });
  repeats.save();
  tgDeliverSafe_(batch, C); // also retries earlier transient failures that are now due
};

/**
 * Coordinator alert: msgs (one text or a list) -> one combined message to every coordinator chat
 * and one email. ctx.batch: queue the Telegram messages there instead of sending (flush sends them
 * with the direct ones); ctx.repeats: the flush's repeat filter. Returns what happened.
 */
function notifyCoordinators_(msgs, C, ctx) {
  C = C || cfg(); ctx = ctx || {};
  var env = tgEnv_(), out = { telegram: null, invalid: [], chats: 0, emails: 0, emailOk: null, suppressed: 0 };
  var list = (Array.isArray(msgs) ? msgs : [msgs]).map(function (t) { return redactSecrets(t); });
  var repeats = ctx.repeats || new RepeatFilter_(env.cache, env.now());
  var fresh = repeats.fresh('coord', list);
  if (!ctx.repeats) repeats.save();
  out.suppressed = list.length - fresh.length;
  if (out.suppressed) {
    logEvent('INFO', '', out.suppressed + ' coordinator alert(s) not repeated: identical to the previous alert, sent less than ' +
      ALERT_REPEAT_MIN + ' min ago.');
  }
  if (!fresh.length) return out;

  var body = fresh.join('\n\n'), text = withAttribution_(body);
  var R = tgRecipients_(C.COORD_TG_CHAT_IDS, 'coordinator'), emails = listSetting(C.COORD_EMAILS);
  out.invalid = R.invalid; out.chats = R.valid.length;
  logEvent('ALERT', '', text);
  R.invalid.forEach(function (x) { logEvent('WARN', '', 'COORD_TG_CHAT_IDS entry "' + x.raw + '" skipped: ' + x.why + '.'); });
  var items = R.valid.map(function (id) { return { chatId: id, role: ctx.role || 'coordinator', text: body }; });
  if (ctx.batch) Array.prototype.push.apply(ctx.batch, items);
  else if (items.length) out.telegram = tgDeliverSafe_(items, C);
  if (C.EMAIL_ALERTS && emails.length) {
    out.emails = emails.length;
    out.emailOk = sendEmail_(emails.join(','), 'Flight tracker: ' + body.split('\n')[0].slice(0, 80), text);
  }
  if (!R.valid.length && !emails.length) logEvent('WARN', '', 'No coordinator channel configured (COORD_TG_CHAT_IDS / COORD_EMAILS).');
  return out;
}

function sendEmail_(to, subject, body) {
  try {
    MailApp.sendEmail(to, subject, body);
    return true;
  } catch (e) {
    logEvent('WARN', '', 'Email to ' + to + ' failed: ' + redactSecrets(e && e.message || e));
    return false;
  }
}

// ---------------------------------------------------------------- repeat filter
/**
 * Drops a message identical to one in the same recipient's previous alert, if that alert is less
 * than ALERT_REPEAT_MIN old. This stops a persistent error from alerting every 5 minutes, and a
 * re-detected event from being sent twice, while a real change back (A -> B -> A) is still sent.
 * Best effort: kept in CacheService, so an evicted cache can let one repeat through.
 */
function RepeatFilter_(cache, nowMs) {
  this.cache = cache; this.now = nowMs; this.dirty = false; this.memo = {};
  try {
    var m = cache ? JSON.parse(cache.get(ALERT_REPEAT_KEY) || '{}') : {};
    if (m && typeof m === 'object') this.memo = m;
  } catch (e) { /* unreadable: start empty */ }
}

RepeatFilter_.prototype.fresh = function (key, msgs) {
  var prev = this.memo[key], recent = [];
  if (prev && !alertRepeatBypass_ && this.now - prev.at < ALERT_REPEAT_MIN * MIN) recent = prev.h || [];
  var hashes = msgs.map(function (m) { return hash32_(m); });
  var keep = msgs.filter(function (m, i) { return recent.indexOf(hashes[i]) < 0; });
  if (keep.length) { this.memo[key] = { at: this.now, h: hashes }; this.dirty = true; }
  return keep;
};

RepeatFilter_.prototype.save = function () {
  if (!this.cache || !this.dirty) return;
  var memo = this.memo, now = this.now;
  Object.keys(memo).forEach(function (k) { if (!memo[k] || now - memo[k].at >= ALERT_REPEAT_MIN * MIN) delete memo[k]; });
  try { this.cache.put(ALERT_REPEAT_KEY, JSON.stringify(memo), 21600); } catch (e) { /* best effort */ }
};

/** FNV-1a, 32 bit, as 8 hex digits: identifies a text without storing it. */
function hash32_(s) {
  var h = 0x811c9dc5;
  s = String(s);
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

// ---------------------------------------------------------------- recipients
/**
 * Pure: a configured chat id -> {ok, id, kind} or {ok: false, why}. Only numeric ids are accepted:
 * an @username can only address a public channel or group. Group ids (negative) are accepted for
 * coordinators only; a driver or faculty message is personal and goes to a private chat.
 */
function tgCheckChatId_(raw, role) {
  var s = String(raw == null ? '' : raw).trim();
  if (/^@/.test(s)) return { ok: false, why: 'an @username addresses a public channel or group; use the numeric chat id from "Show Telegram chat ids"' };
  if (!/^-?\d{1,16}$/.test(s)) return { ok: false, why: 'not a numeric Telegram chat id' };
  var group = s.charAt(0) === '-';
  if (group && role !== 'coordinator') return { ok: false, why: 'is a group chat; personal messages go only to a private chat' };
  return { ok: true, id: s, kind: group ? 'group' : 'private' };
}

/** Pure: a comma-separated setting -> {valid: [ids, deduplicated], invalid: [{raw, why}]}. */
function tgRecipients_(setting, role) {
  var valid = [], invalid = [], seen = {};
  listSetting(setting).forEach(function (raw) {
    var c = tgCheckChatId_(raw, role);
    if (!c.ok) invalid.push({ raw: raw, why: c.why });
    else if (!seen[c.id]) { seen[c.id] = true; valid.push(c.id); }
  });
  return { valid: valid, invalid: invalid };
}

// ---------------------------------------------------------------- Telegram API
/** One Bot API call. The URL contains the token, so it is never logged, returned or thrown. */
function tgCall_(env, token, method, payload) {
  var opts = { muteHttpExceptions: true };
  if (payload) { opts.method = 'post'; opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  try {
    var res = env.fetch(TG_API + token + '/' + method, opts);
    return { code: res.getResponseCode(), body: String(res.getContentText() || '') };
  } catch (e) {
    // UrlFetchApp's message can contain the request URL, and with it the token.
    return { networkError: redactSecrets(e && e.message || e).slice(0, 200) };
  }
}

/**
 * Pure: an HTTP outcome -> {kind, error, retryAfterS, messageId, migrateTo}. kinds:
 *   sent         Telegram confirmed (ok: true)
 *   retry        transient: 429 (with retry_after), 5xx
 *   uncertain    network error or timeout: the message may have been delivered
 *   unconfirmed  HTTP 200 without a readable answer: probably delivered, not confirmed
 *   fail         permanent for this chat: 400 (bad chat id, rejected payload), 403 (blocked / not started)
 *   auth         401/404: the token is wrong or revoked; every other send would fail the same way
 */
function tgClassify_(res) {
  if (res.networkError != null) return { kind: 'uncertain', error: 'network error or timeout, the message may have arrived: ' + res.networkError };
  var code = res.code, j = null;
  try { j = JSON.parse(res.body); } catch (e) { j = null; }
  var desc = j && j.description ? redactSecrets(String(j.description)).slice(0, 200) : '';
  var params = (j && j.parameters) || {};
  if (code === 200) {
    if (j && j.ok === true) return { kind: 'sent', messageId: j.result && j.result.message_id != null ? String(j.result.message_id) : '' };
    if (j && j.ok === false) return { kind: 'fail', error: 'Telegram refused: ' + (desc || 'ok=false') };
    return { kind: 'unconfirmed', error: 'HTTP 200 without a readable answer: delivery not confirmed' };
  }
  var tag = 'HTTP ' + code + (desc ? ' ' + desc : '');
  if (code === 401 || code === 404) return { kind: 'auth', error: tag + ': TG_BOT_TOKEN rejected (wrong or revoked)' };
  if (code === 429) {
    var ra = Number(params.retry_after);
    return { kind: 'retry', retryAfterS: ra > 0 ? ra : 30, error: tag + ': rate limited' };
  }
  if (code === 403) return { kind: 'fail', error: tag + ': the recipient blocked the bot or never sent it /start, or the bot was removed from the group' };
  if (code === 400) {
    if (params.migrate_to_chat_id) {
      return { kind: 'fail', migrateTo: String(params.migrate_to_chat_id),
        error: tag + ': the group became a supergroup; its new chat id is ' + params.migrate_to_chat_id };
    }
    if (/chat not found/i.test(desc)) return { kind: 'fail', error: tag + ': wrong chat id, or that person never sent /start' };
    return { kind: 'fail', error: tag + ': Telegram rejected the message' };
  }
  if (code >= 500 || code === 408) return { kind: 'retry', error: tag + ': Telegram server error' };
  return { kind: 'fail', error: tag };
}

/** Pure: row + classified outcome -> the row's next state. The attempt is already counted. */
function tgApplyOutcome_(row, o, nowMs) {
  row.error = o.error ? redactSecrets(o.error) : '';
  row.nextAt = null;
  if (o.kind === 'sent') { row.state = 'SENT'; row.sentAt = nowMs; row.messageId = o.messageId || ''; return row; }
  if (o.kind === 'unconfirmed') { row.state = 'UNCONFIRMED'; return row; }
  if (o.kind === 'uncertain' && row.attempts >= TG_POLICY.maxUncertainAttempts) {
    row.state = 'UNCONFIRMED'; row.error += ' (not retried again, to avoid a duplicate)';
    return row;
  }
  if (o.kind === 'retry' || o.kind === 'uncertain') {
    if (row.attempts >= TG_POLICY.maxAttempts) {
      row.state = 'FAILED'; row.error = 'gave up after ' + row.attempts + ' attempts: ' + row.error;
      return row;
    }
    var b = TG_POLICY.backoffMin[Math.min(Math.max(row.attempts, 1), TG_POLICY.backoffMin.length) - 1];
    row.state = 'RETRY';
    row.nextAt = nowMs + Math.max(b * MIN, (o.retryAfterS || 0) * 1000);
    return row;
  }
  row.state = 'FAILED'; // fail, auth, config
  return row;
}

/**
 * Pure: text -> Telegram messages that each fit Telegram's limit, split at blank lines, then at
 * line ends, then hard (never inside an emoji). Each part carries the attribution; parts are
 * numbered "(1/2)". Nothing is cut off.
 */
function tgSplit_(text, suffix, maxLen) {
  var room = (maxLen || TG_POLICY.maxLen) - suffix.length - TG_POLICY.reserve, tokens = [];
  String(text).split('\n\n').forEach(function (block, bi) {
    block.split('\n').forEach(function (line, li) {
      var sep = li ? '\n' : bi ? '\n\n' : '';
      while (line.length > room) {
        var cut = room, c = line.charCodeAt(cut - 1);
        if (c >= 0xD800 && c <= 0xDBFF) cut--;
        tokens.push({ t: line.slice(0, cut), sep: sep });
        line = line.slice(cut); sep = '';
      }
      tokens.push({ t: line, sep: sep });
    });
  });
  var parts = [], cur = null;
  tokens.forEach(function (tk) {
    if (cur !== null && cur.length + tk.sep.length + tk.t.length <= room) cur += tk.sep + tk.t;
    else { if (cur !== null) parts.push(cur); cur = tk.t; }
  });
  if (cur !== null) parts.push(cur);
  return parts.map(function (p, i) { return (parts.length > 1 ? '(' + (i + 1) + '/' + parts.length + ') ' : '') + p + suffix; });
}

/** Pure: items [{chatId, role, text}] -> new QUEUED rows, one per Telegram message. */
function tgNewRows_(items, nowMs) {
  var rows = [];
  items.forEach(function (it) {
    var parts = tgSplit_(redactSecrets(it.text), attributionLine_());
    // Same text at the same time = the same event for every recipient.
    var ev = 'T' + istDateKey(nowMs).replace(/-/g, '') + '-' + fmtTimeIST(nowMs).replace(':', '') + '-' + hash32_(it.text).slice(0, 6);
    parts.forEach(function (p, i) {
      rows.push({ queuedAt: nowMs, id: ev + (parts.length > 1 ? '.' + (i + 1) : ''), role: it.role, chatId: String(it.chatId),
        state: 'QUEUED', attempts: 0, lastAt: null, sentAt: null, nextAt: null, messageId: '', error: '', text: p });
    });
  });
  return rows;
}

/** A retried message says when it was first queued, so nobody mistakes old news for new. */
function tgOutgoingText_(row, nowMs) {
  return nowMs - row.queuedAt >= 10 * MIN
    ? '⏱ Delayed delivery, first queued ' + fmtIST(row.queuedAt) + ' IST\n' + row.text : row.text;
}

function tgDeliverSafe_(items, C) {
  try { return tgDeliver_(items, C); } catch (e) {
    logEvent('ERROR', '', 'Telegram delivery failed: ' + redactSecrets(e && e.message || e));
    return null;
  }
}

/**
 * Queues, sends and records Telegram messages, and retries earlier transient failures that are due.
 * items: [{chatId, role, text}] with validated chat ids. If the Deliveries sheet cannot be used,
 * messages are still sent once, without tracking or retries, and an ERROR is logged.
 * Returns {sent, retry, failed, unconfirmed, expired, results: [one per new row]}.
 */
function tgDeliver_(items, C) {
  var env = tgEnv_(), now = env.now(), started = now;
  var summary = { sent: 0, retry: 0, failed: 0, unconfirmed: 0, expired: 0, results: [] };
  items = items || [];
  if (!items.length && env.cache && env.cache.get('TG_PENDING') === '0') return summary;
  C = C || cfg();

  var store = null, rows = [], dirty = [];
  try {
    store = env.store();
    if (!env.cache || !env.cache.get('TG_PURGED')) {
      store.purge(now - Math.min(Number(C.ADB_RETENTION_HOURS) || 0, 168) * HOUR); // rows carry provider data
      if (env.cache) env.cache.put('TG_PURGED', '1', 3600);
    }
    rows = store.read();
  } catch (e) {
    logEvent('ERROR', '', TG_DELIVERIES + ' sheet unavailable (' + redactSecrets(e && e.message || e) +
      '); sending without delivery tracking or retries.');
    store = null; rows = [];
  }

  var due = [];
  rows.forEach(function (r) {
    if (TG_FINAL[r.state]) return;
    if (now - r.queuedAt >= TG_POLICY.expireMin * MIN) {
      r.state = 'EXPIRED'; r.nextAt = null;
      r.error = 'not delivered within ' + TG_POLICY.expireMin + ' min' + (r.error ? ': ' + r.error : '');
      dirty.push(r); summary.expired++;
      logEvent('WARN', '', 'Telegram ' + r.role + ' ' + r.chatId + ' ' + r.id + ': EXPIRED, ' + r.error);
    } else if (r.state === 'QUEUED') {
      // Left by an execution that stopped mid-send: it may have been delivered.
      r.attempts++;
      tgApplyOutcome_(r, { kind: 'uncertain', error: 'an earlier run stopped before recording the outcome' }, now);
      dirty.push(r);
    } else if (r.state === 'RETRY' && (r.nextAt || 0) <= now) {
      due.push(r);
    }
  });

  var fresh = tgNewRows_(items, now);
  if (store && fresh.length) {
    try { store.append(fresh); } catch (e) {
      logEvent('ERROR', '', TG_DELIVERIES + ' sheet not writable (' + redactSecrets(e && e.message || e) +
        '); sending without delivery tracking or retries.');
      store = null;
    }
  }

  var token = env.secret('TG_BOT_TOKEN'), stop = null, lastTo = {}, waited = false;
  if (!token) stop = { kind: 'config', error: 'TG_BOT_TOKEN is not set (Project Settings -> Script properties)' };
  var send = function (r) {
    var gap = lastTo[r.chatId] ? TG_POLICY.chatGapMs - (env.now() - lastTo[r.chatId]) : 0;
    if (gap > 0) env.sleep(gap);
    r.attempts++; r.lastAt = env.now();
    var o = tgClassify_(tgCall_(env, token, 'sendMessage',
      { chat_id: r.chatId, text: tgOutgoingText_(r, env.now()), disable_web_page_preview: true }));
    lastTo[r.chatId] = env.now();
    return o;
  };
  due.concat(fresh).forEach(function (r) {
    if (stop) {
      // New messages are closed with the reason; due retries keep waiting (and expire) in case it is fixed.
      if (r.state === 'QUEUED') { tgApplyOutcome_(r, { kind: 'fail', error: 'not sent: ' + stop.error }, now); dirty.push(r); }
      return;
    }
    if (env.now() - started > TG_POLICY.runBudgetMs) {
      if (r.state === 'QUEUED') { r.state = 'RETRY'; r.nextAt = now; r.error = 'deferred: Telegram time for this run used up'; dirty.push(r); }
      return;
    }
    var o = send(r);
    if (o.kind === 'retry' && o.retryAfterS && o.retryAfterS <= TG_POLICY.inlineWaitMaxS && !waited && r.attempts < TG_POLICY.maxAttempts) {
      waited = true;
      env.sleep(o.retryAfterS * 1000);
      o = send(r);
    }
    tgApplyOutcome_(r, o, env.now());
    dirty.push(r);
    if (o.kind === 'auth') stop = o;
    if (r.state !== 'SENT') logEvent(o.kind === 'auth' ? 'ERROR' : 'WARN', '', 'Telegram to ' + r.role + ' ' + r.chatId + ' (' + r.id + '): ' + r.state + ', ' + r.error);
  });

  if (store) {
    var written = {};
    dirty.forEach(function (r) {
      if (!r._i || written[r._i]) return;
      written[r._i] = true;
      try { store.update(r); } catch (e) { logEvent('ERROR', '', 'Could not record Telegram delivery ' + r.id + ': ' + redactSecrets(e && e.message || e)); }
    });
    if (env.cache) {
      var pending = rows.concat(fresh).some(function (r) { return r.state === 'RETRY' || r.state === 'QUEUED'; });
      env.cache.put('TG_PENDING', pending ? '1' : '0', 21600);
    }
  }
  due.concat(fresh).forEach(function (r) {
    var k = { SENT: 'sent', RETRY: 'retry', FAILED: 'failed', UNCONFIRMED: 'unconfirmed' }[r.state];
    if (k) summary[k]++;
  });
  summary.results = fresh.map(function (r) { return { id: r.id, chatId: r.chatId, role: r.role, state: r.state, error: r.error }; });
  return summary;
}

// ---------------------------------------------------------------- Deliveries sheet
function tgRowToCells_(r) {
  var d = function (ms) { return ms ? new Date(ms) : ''; };
  return [d(r.queuedAt), r.id, r.role, String(r.chatId), r.state, r.attempts, d(r.lastAt), d(r.sentAt), d(r.nextAt),
    r.messageId || '', r.error || '', r.text];
}

function tgRowFromCells_(v, sheetRow) {
  return { _i: sheetRow, queuedAt: toMs(v[0]), id: String(v[1]), role: String(v[2]), chatId: String(v[3]).trim(),
    state: String(v[4]), attempts: Number(v[5]) || 0, lastAt: toMs(v[6]), sentAt: toMs(v[7]), nextAt: toMs(v[8]),
    messageId: String(v[9] == null ? '' : v[9]), error: String(v[10] == null ? '' : v[10]), text: String(v[11] == null ? '' : v[11]) };
}

/** The "Telegram Deliveries" sheet: rows in queue order, created on first use. */
function tgSheetStore_() {
  var ss = SpreadsheetApp.getActive(), sh = ss.getSheetByName(TG_DELIVERIES);
  var ensure = function () {
    if (!sh) sh = ss.insertSheet(TG_DELIVERIES);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, TG_HEADERS.length).setValues([TG_HEADERS]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    return sh;
  };
  return {
    read: function () {
      if (!sh || sh.getLastRow() < 2) return [];
      var last = sh.getLastRow(), first = Math.max(2, last - TG_POLICY.readTail + 1);
      return sh.getRange(first, 1, last - first + 1, TG_HEADERS.length).getValues()
        .map(function (v, i) { return tgRowFromCells_(v, first + i); });
    },
    append: function (rows) {
      ensure();
      var start = sh.getLastRow() + 1, end = start + rows.length - 1;
      if (sh.getMaxRows() < end) sh.insertRowsAfter(sh.getMaxRows(), end - sh.getMaxRows() + 50);
      var rng = sh.getRange(start, 1, rows.length, TG_HEADERS.length);
      rng.setNumberFormats(rows.map(function () { return TG_FORMATS; })); // text format keeps chat ids exact
      rng.setValues(rows.map(tgRowToCells_));
      rows.forEach(function (r, i) { r._i = start + i; });
    },
    update: function (r) { sh.getRange(r._i, 1, 1, TG_HEADERS.length).setValues([tgRowToCells_(r)]); },
    /** Deletes the oldest finished rows queued before cutoffMs (the Message column holds provider data). */
    purge: function (cutoffMs) {
      if (!sh || sh.getLastRow() < 2) return;
      var v = sh.getRange(2, 1, Math.min(sh.getLastRow() - 1, 2000), 5).getValues(), n = 0;
      while (n < v.length && (toMs(v[n][0]) || 0) < cutoffMs && TG_FINAL[v[n][4]]) n++;
      if (n) sh.deleteRows(2, n);
    }
  };
}

/** Pure: delivery rows -> last-24-hour counts, rows waiting for a retry, and the latest problem. */
function tgDeliverySummary_(rows, nowMs) {
  var s = { sent: 0, failed: 0, unconfirmed: 0, expired: 0, pending: 0, lastProblem: null };
  rows.forEach(function (r) {
    if (r.state === 'RETRY' || r.state === 'QUEUED') s.pending++;
    if (!(nowMs - r.queuedAt < 24 * HOUR)) return;
    var k = { SENT: 'sent', FAILED: 'failed', UNCONFIRMED: 'unconfirmed', EXPIRED: 'expired' }[r.state];
    if (k) s[k]++;
    if (k && k !== 'sent') s.lastProblem = { chatId: r.chatId, role: r.role, state: r.state, error: r.error };
  });
  return s;
}

/** Pure: summary -> {level, message} for the setup checks. */
function tgDeliveryLine_(d) {
  var bad = d.failed + d.unconfirmed + d.expired;
  return {
    level: bad ? 'warn' : 'ok',
    message: 'last 24 h: ' + d.sent + ' sent, ' + d.failed + ' failed, ' + d.unconfirmed + ' unconfirmed, ' + d.expired + ' expired; ' +
      d.pending + ' waiting for a retry' +
      (d.lastProblem ? '. Latest problem: ' + d.lastProblem.role + ' ' + d.lastProblem.chatId + ' ' + d.lastProblem.state + ', ' + d.lastProblem.error : '') +
      '. Details on the "' + TG_DELIVERIES + '" sheet'
  };
}

// ---------------------------------------------------------------- menu tools
/**
 * Menu: chat ids of chats that messaged the bot recently (ask people to send /start first).
 * getUpdates is called without an offset, so reading confirms (consumes) nothing; and without
 * allowed_updates, which would change the bot's settings. It fails with 409 while a webhook is set.
 */
function listTelegramChats() {
  var env = tgEnv_(), token = env.secret('TG_BOT_TOKEN');
  if (!token) throw new Error('Set the TG_BOT_TOKEN script property first (Project Settings -> Script properties).');
  var res = tgCall_(env, token, 'getUpdates', null);
  if (res.networkError != null) throw new Error('Could not reach Telegram: ' + res.networkError);
  if (res.code === 401 || res.code === 404) throw new Error('Telegram rejected TG_BOT_TOKEN (HTTP ' + res.code + '). Check the Script Property.');
  if (res.code === 409) {
    throw new Error('This bot has a webhook, so another program receives its messages and this list cannot be read (HTTP 409). ' +
      'Alerts are not affected. Ask whoever runs that webhook for the chat ids; do not remove it unless it is yours.');
  }
  if (res.code !== 200) throw new Error('Telegram returned HTTP ' + res.code + '.');
  var chats = tgChatsFromUpdates_(res.body);
  if (!chats) throw new Error('Telegram returned an unreadable answer.');
  var configured = tgRecipients_(cfg().COORD_TG_CHAT_IDS, 'coordinator').valid;
  var lines = chats.map(function (c) {
    return c.id + '  ' + c.type + '  ' + c.name + (configured.indexOf(c.id) >= 0 ? '  (already a coordinator)' : '');
  });
  SpreadsheetApp.getUi().alert(lines.length
    ? 'Chats that messaged the bot recently:\n' + lines.join('\n') +
      '\n\nCopy a coordinator\'s PRIVATE chat id into COORD_TG_CHAT_IDS. A group id starts with "-": every group member sees faculty names. ' +
      'Telegram keeps these messages for 24 hours only.'
    : 'No messages in the last 24 hours. Ask each person to open the bot in Telegram and send /start, then try again.');
}

/** Pure: getUpdates body -> [{id, type, name}] in first-seen order, or null if unreadable. */
function tgChatsFromUpdates_(body) {
  var j;
  try { j = JSON.parse(body); } catch (e) { return null; }
  var seen = {}, order = [];
  ((j && j.result) || []).forEach(function (u) {
    var m = u.message || u.edited_message || u.channel_post || u.my_chat_member || u.chat_member, c = m && m.chat;
    if (!c || c.id == null) return;
    var id = String(c.id);
    if (!seen[id]) order.push(id);
    seen[id] = { id: id, type: c.type || '?', name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' };
  });
  return order.map(function (id) { return seen[id]; });
}

function tgApiResult_(env, token, method, payload) {
  var res = tgCall_(env, token, method, payload), o = tgClassify_(res), j = null;
  try { j = JSON.parse(res.body); } catch (e) { j = null; }
  return { ok: o.kind === 'sent', kind: o.kind, error: o.error || '', result: j && j.result };
}

/** Menu: checks token, webhook, each coordinator chat and recent deliveries. Sends no message. */
function checkTelegramBot() {
  var text = tgRenderReport_(tgBotReport_(tgBotFacts_(cfg())));
  logEvent('INFO', '', 'Telegram check: ' + text.split('\n')[0]);
  try { SpreadsheetApp.getUi().alert('Telegram check', text, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { console.log(text); }
  return text;
}

/** Read-only calls only: getMe, getWebhookInfo, getChat. */
function tgBotFacts_(C) {
  var env = tgEnv_(), f = { token: 'set', chats: tgRecipients_(C.COORD_TG_CHAT_IDS, 'coordinator') };
  try { f.deliveries = tgDeliverySummary_(env.store().read(), env.now()); } catch (e) { f.deliveries = null; }
  var token = env.secret('TG_BOT_TOKEN');
  if (!token) { f.token = 'missing'; return f; }
  f.me = tgApiResult_(env, token, 'getMe');
  if (!f.me.ok) return f;
  f.webhook = tgApiResult_(env, token, 'getWebhookInfo');
  f.chatInfo = f.chats.valid.map(function (id) { return { id: id, res: tgApiResult_(env, token, 'getChat', { chat_id: id }) }; });
  return f;
}

/** Pure: facts -> [{level, area, message}]. Never includes the token. */
function tgBotReport_(f) {
  var out = [], add = function (level, area, message) { out.push({ level: level, area: area, message: message }); };
  if (f.token === 'missing') {
    add('error', 'TG_BOT_TOKEN', 'not set. Telegram -> @BotFather -> /newbot, then Apps Script -> Project Settings -> Script properties');
  } else if (!f.me.ok) {
    add('error', 'Bot', f.me.kind === 'auth' ? 'Telegram rejected TG_BOT_TOKEN (wrong or revoked). Get the current token from @BotFather and replace the property'
      : f.me.kind === 'uncertain' ? 'could not reach Telegram (' + f.me.error + '). The token was not checked; try again later'
        : 'unexpected answer: ' + f.me.error);
  } else {
    add('ok', 'Bot', '@' + ((f.me.result && f.me.result.username) || '?') + ' accepts the token');
    var w = f.webhook && f.webhook.ok ? f.webhook.result || {} : null;
    if (!w) add('warn', 'Updates', 'webhook state unknown: ' + (f.webhook ? f.webhook.error : ''));
    else if (w.url) add('warn', 'Updates', 'a webhook is set: another program receives this bot\'s messages, so "Show Telegram chat ids" cannot read them. Alerts are not affected. Do not remove it unless it is yours');
    else add('ok', 'Updates', 'no webhook: "Show Telegram chat ids" can read messages sent to the bot in the last 24 h');
  }
  if (!f.chats.valid.length && !f.chats.invalid.length) add('error', 'COORD_TG_CHAT_IDS', 'empty: no coordinator receives Telegram alerts');
  f.chats.invalid.forEach(function (x) { add('error', 'Chat "' + x.raw + '"', 'skipped: ' + x.why); });
  if (f.chatInfo) {
    f.chatInfo.forEach(function (c) {
      if (!c.res.ok) { add('error', 'Chat ' + c.id, c.res.error); return; }
      var ch = c.res.result || {};
      if (ch.type === 'private') add('ok', 'Chat ' + c.id, 'private chat with ' + (ch.first_name || '?'));
      else add('warn', 'Chat ' + c.id, ch.type + ' "' + (ch.title || '') + '": every member receives faculty names and cab plans' +
        (ch.username ? '. It is PUBLIC (@' + ch.username + '): use a private chat or group instead' : ''));
    });
  } else if (f.chats.valid.length) {
    add('info', 'Chats', f.chats.valid.length + ' chat id(s) not checked, because the bot could not be reached');
  }
  if (f.deliveries) { var d = tgDeliveryLine_(f.deliveries); add(d.level, 'Deliveries', d.message); }
  return out;
}

function tgRenderReport_(lines) {
  var icon = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' };
  var errors = lines.filter(function (l) { return l.level === 'error'; }).length;
  return (errors ? errors + ' problem(s) to fix' : 'No blocking problems') + '. No message was sent.\n\n' +
    lines.map(function (l) { return icon[l.level] + ' ' + l.area + ': ' + l.message; }).join('\n');
}

function sendTestAlert() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) throw new Error('A check is running; try again in a minute.');
  var r;
  try {
    alertRepeatBypass_ = true;
    r = notifyCoordinators_('✅ Flight tracker test alert — ' + fmtIST(Date.now()) + ' IST', cfg(), { role: 'test' });
  } finally {
    alertRepeatBypass_ = false;
    lock.releaseLock();
  }
  var text = tgTestSummary_(r);
  try { SpreadsheetApp.getUi().alert('Test alert', text, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { console.log(text); }
  return text;
}

/** Pure: notifyCoordinators_ result -> what each recipient got. */
function tgTestSummary_(r) {
  var lines = [];
  (r.telegram ? r.telegram.results : []).forEach(function (x) {
    lines.push((x.state === 'SENT' ? '✅ ' : x.state === 'RETRY' ? '⏳ ' : '❌ ') + 'Telegram ' + x.chatId + ': ' +
      (x.state === 'SENT' ? 'delivered' : x.state === 'RETRY' ? 'not yet delivered, will retry (' + x.error + ')' : x.state + ', ' + x.error));
  });
  if (r.chats && !r.telegram) lines.push('❌ Telegram: not sent (see the Log sheet)');
  r.invalid.forEach(function (x) { lines.push('❌ COORD_TG_CHAT_IDS "' + x.raw + '": ' + x.why); });
  if (r.emails) lines.push((r.emailOk ? '✅ Email accepted by Gmail for ' : '❌ Email failed for ') + r.emails + ' address(es)');
  if (!lines.length) lines.push('❌ Nobody to send to: fill COORD_TG_CHAT_IDS and/or COORD_EMAILS on the Config sheet.');
  return lines.join('\n') + '\n\nEvery Telegram attempt is on the "' + TG_DELIVERIES + '" sheet.';
}
