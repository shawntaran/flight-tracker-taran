'use strict';
// The polling loop. Read-only: it reads the tracker data (Supabase) and replies to allowed chats; it never writes
// anywhere except its own offset file. Every failure is logged (redacted) and the loop keeps going.

const { answer } = require('./answers');
const { buildSnapshot } = require('./snapshot');
const { fmtIST } = require('./time');

const UNAUTHORISED_REPLY_EVERY_MS = 24 * 60 * 60 * 1000;

/** Tracker snapshot with a short cache. If a refresh fails, the last good snapshot is reused and labelled. */
function createSnapshotSource({ readRange, now, ttlMs, log }) {
  let cache = null;
  return async function getSnapshot() {
    const t = now();
    if (cache && t - cache.readAt < ttlMs) return cache;
    const read = async (name) => {
      try { return await readRange(name); } catch (e) { return { error: (e && e.message) || String(e) }; }
    };
    const raw = { flights: await read('Flights'), groups: await read('Groups'), config: await read('Config'), status: await read('Status') };
    if (raw.flights.error && cache) {
      log('WARN', 'Supabase refresh failed, using data read at ' + fmtIST(cache.readAt) + ': ' + raw.flights.error);
      return Object.assign({}, cache, { problems: ['tracker data could not be refreshed; it was read at ' + fmtIST(cache.readAt)].concat(cache.problems) });
    }
    const snap = buildSnapshot(raw, t);
    if (snap.problems.length) log('WARN', 'Data: ' + snap.problems.join('; '));
    if (!raw.flights.error) cache = snap;
    return snap;
  };
}

function createRateLimiter(perMin) {
  const hits = new Map();
  return (chatId, t) => {
    const recent = (hits.get(chatId) || []).filter((x) => t - x < 60 * 1000);
    const ok = recent.length < perMin;
    if (ok) recent.push(t);
    hits.set(chatId, recent);
    return { ok, first: !ok && recent.length === perMin }; // `first`: the first refusal in this window
  };
}

function createWorker({ config, telegram, offsetStore, getSnapshot, llm, log, now, sleep }) {
  const allow = createRateLimiter(config.rateLimitPerMin);
  const told = new Map();       // unauthorised chat -> last reply time
  const warned = new Map();     // chat -> last rate-limit notice
  const seen = new Set();       // update ids handled by this process
  let offset = offsetStore.load();
  let botUsername = '';
  let failures = 0;
  let stopped = false;

  const reply = async (chatId, text) => {
    const r = await telegram.sendMessage(chatId, text);
    if (!r.ok) log('WARN', 'reply to chat ' + chatId + ' failed: ' + r.error);
  };

  async function statusText() {
    let snapLine;
    try {
      const s = await getSnapshot();
      const lt = s.lastTick;
      snapLine = (lt && lt.at != null ? 'Tracker last ran ' + fmtIST(lt.at) + (lt.ageMin != null ? ' (' + lt.ageMin + ' min ago)' : '') +
          (lt.result === 'error' ? ', and that run FAILED' : '') + (lt.triggerInstalled === false ? '. Its 5-minute trigger is NOT installed' : '')
        : 'Tracker last ran: unknown (no heartbeat on the Status tab)') + '\n' +
        'Tracker data: ' + s.flights.length + ' active flight row(s), read ' + fmtIST(s.readAt) + (s.problems.length ? '. Problem: ' + s.problems[0] : '');
    } catch (e) { snapLine = 'Tracker data: unavailable'; }
    const h = await llm.health();
    return snapLine + '\nLanguage model: ' + (h.reachable && h.modelListed !== false ? 'available' : 'unavailable (' + (h.detail || 'not reachable') + ')') +
      '\nAutomatic flight alerts run in the tracker and do not depend on this assistant.';
  }

  async function handleMessage(msg) {
    if (!msg || !msg.chat || typeof msg.text !== 'string') return;
    const chatId = String(msg.chat.id), t = now();
    if (!config.allowedChatIds.has(chatId)) {
      log('INFO', 'ignored a message from chat ' + chatId + ' (not in ALLOWED_CHAT_IDS)');
      if (msg.chat.type === 'private' && !(told.get(chatId) > t - UNAUTHORISED_REPLY_EVERY_MS)) {
        told.set(chatId, t);
        await reply(chatId, 'This is a private assistant. Your chat id is ' + chatId + '. Ask the tracker administrator to add it if you should have access.');
      }
      return;
    }
    let text = msg.text.trim();
    if (msg.chat.type !== 'private') {
      // In groups, only commands and messages that mention the bot are for us.
      const mention = botUsername && new RegExp('@' + botUsername + '\\b', 'i');
      if (!(text.startsWith('/') || (mention && mention.test(text)))) return;
      if (mention) text = text.replace(mention, '').trim();
    }
    const lim = allow(chatId, t);
    if (!lim.ok) {
      if (lim.first && !(warned.get(chatId) > t - 60 * 1000)) { warned.set(chatId, t); await reply(chatId, 'Too many questions at once; please wait a minute.'); }
      return;
    }
    if (msg.date && t - msg.date * 1000 > config.maxMessageAgeMin * 60 * 1000) {
      await reply(chatId, 'Sorry, the assistant was offline when you sent this. Please ask again if you still need it.');
      return;
    }
    if (text.length > config.maxQuestionChars) {
      await reply(chatId, 'Please keep questions under ' + config.maxQuestionChars + ' characters.');
      return;
    }
    const started = now();
    let out;
    try {
      out = await answer(text, { getSnapshot, llm, now, statusText });
    } catch (e) {
      log('ERROR', 'answer failed for chat ' + chatId + ': ' + ((e && e.message) || e));
      out = { text: 'Sorry, something went wrong while answering. Please try again later.', via: 'error' };
    }
    await reply(chatId, out.text);
    // Metadata only: the question and the answer are never logged or stored.
    log('INFO', 'answered chat ' + chatId + ' via ' + out.via + ' in ' + (now() - started) + ' ms' + (out.error ? ' (' + out.error + ')' : ''));
  }

  let meTried = false;
  async function ensureMe() {
    if (meTried) return;
    meTried = true;
    const me = await telegram.getMe();
    if (me.ok && me.result) botUsername = String(me.result.username || '');
    else { meTried = false; log('WARN', 'getMe failed (' + me.error + '); group mentions are not recognised until it works'); }
  }

  /** One getUpdates round. Returns the ms to wait before the next one. */
  async function pollOnce() {
    await ensureMe();
    if (offset == null) {
      // First start (or lost offset file): skip the backlog instead of answering old questions.
      const r = await telegram.getUpdates(-1, 0);
      if (!r.ok) return backoff(r);
      const last = r.result.reduce((m, u) => Math.max(m, u.update_id || 0), -1);
      offset = last >= 0 ? last + 1 : 0;
      offsetStore.save(offset);
      log('INFO', 'first start: skipped ' + r.result.length + ' earlier update(s); polling from offset ' + offset);
      return 0;
    }
    const r = await telegram.getUpdates(offset, config.pollTimeoutS);
    if (!r.ok) return backoff(r);
    failures = 0;
    for (const u of r.result) {
      if (!Number.isInteger(u.update_id) || u.update_id < offset || seen.has(u.update_id)) continue;
      seen.add(u.update_id);
      if (seen.size > 2000) seen.delete(seen.values().next().value);
      // Saved BEFORE handling: after a crash or restart this update is never handled again.
      offset = u.update_id + 1;
      try { offsetStore.save(offset); } catch (e) { log('ERROR', 'could not save the Telegram offset: ' + ((e && e.message) || e)); }
      try { await handleMessage(u.message); } catch (e) { log('ERROR', 'update ' + u.update_id + ' failed: ' + ((e && e.message) || e)); }
    }
    return 0;
  }

  function backoff(r) {
    failures++;
    const base = r.kind === 'auth' ? 5 * 60 * 1000 : r.kind === 'conflict' ? 60 * 1000 : r.kind === 'rate' ? (r.retryAfterS || 5) * 1000 : 0;
    const wait = Math.max(base, Math.min(60 * 1000, 1000 * Math.pow(2, Math.min(failures, 6))));
    log('WARN', 'Telegram getUpdates failed (' + r.error + ')' +
      (r.kind === 'auth' ? ': TG_BOT_TOKEN rejected' : r.kind === 'conflict' ? ': another program is polling this bot or a webhook is set. Only one consumer may read updates' : '') +
      '; retrying in ' + Math.round(wait / 1000) + ' s');
    return wait;
  }

  async function run() {
    while (!stopped) {
      let wait;
      try { wait = await pollOnce(); } catch (e) { log('ERROR', 'poll failed: ' + ((e && e.message) || e)); wait = 5000; }
      if (wait && !stopped) await sleep(wait);
    }
  }

  return { run, pollOnce, handleMessage, statusText, stop: () => { stopped = true; }, get offset() { return offset; } };
}

module.exports = { createWorker, createSnapshotSource, createRateLimiter };
