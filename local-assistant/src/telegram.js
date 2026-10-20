'use strict';
// Minimal Telegram Bot API client for the worker. Only the methods in ALLOWED can be called:
// the worker polls (getUpdates) and replies (sendMessage). It never sets or deletes a webhook,
// changes bot settings, or touches chats it was not asked from.

const ALLOWED = new Set(['getMe', 'getUpdates', 'sendMessage']);
const MAX_TEXT = 4000; // Telegram's limit is 4096 characters

function createTelegram({ token, fetch, redact, timeoutMs }) {
  async function call(method, payload, callTimeoutMs) {
    if (!ALLOWED.has(method)) throw new Error('Telegram method not allowed in the read-only assistant: ' + method);
    if (!token) return { ok: false, kind: 'config', error: 'TG_BOT_TOKEN is not set' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), callTimeoutMs || timeoutMs || 15000);
    try {
      const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}), signal: ctl.signal
      });
      let j = null;
      try { j = JSON.parse(await res.text()); } catch (e) { j = null; }
      if (res.status === 200 && j && j.ok === true) return { ok: true, result: j.result };
      const desc = j && j.description ? redact(String(j.description)).slice(0, 200) : '';
      const kind = res.status === 401 || res.status === 404 ? 'auth' : res.status === 409 ? 'conflict'
        : res.status === 429 ? 'rate' : res.status >= 500 ? 'server' : 'rejected';
      return { ok: false, kind, code: res.status, error: 'HTTP ' + res.status + (desc ? ' ' + desc : ''),
        retryAfterS: j && j.parameters && Number(j.parameters.retry_after) || 0 };
    } catch (e) {
      // A fetch error can carry the URL, and the URL carries the token.
      return { ok: false, kind: 'network', error: redact(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getMe: () => call('getMe', {}),
    /** Long poll. offset confirms (consumes) every update below it, so each update is handed out once. */
    getUpdates: (offset, timeoutS) => call('getUpdates', { offset, timeout: timeoutS }, (timeoutS + 15) * 1000),
    /** Plain text only: no parse_mode, so sheet text can never be interpreted as markup. */
    sendMessage: (chatId, text) => {
      let t = String(text || '');
      if (t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT - 20) + '\n…(shortened)';
      return call('sendMessage', { chat_id: chatId, text: t, disable_web_page_preview: true });
    }
  };
}

module.exports = { createTelegram, ALLOWED, MAX_TEXT };
