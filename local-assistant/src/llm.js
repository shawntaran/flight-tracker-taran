'use strict';
// OpenAI-compatible chat-completions client. Works with any server that implements
// POST {LLM_BASE_URL}/chat/completions: Ollama (/v1), vLLM, llama.cpp server, TGI, NVIDIA NIM on a DGX, or
// a private hosted endpoint. Nothing here assumes a host, GPU, vendor or model name.
// The request has no tools/functions: the model can only return text, which the worker checks.

function createLlm({ baseUrl, model, apiKey, timeoutMs, enabled, fetch, redact }) {
  const headers = () => Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { Authorization: 'Bearer ' + apiKey } : {});
  const host = (() => { try { const u = new URL(baseUrl); return u.protocol + '//' + u.host; } catch (e) { return '(invalid URL)'; } })();
  const safe = (e) => redact(e && e.name === 'AbortError' ? 'timed out after ' + timeoutMs + ' ms' : (e && e.message) || e).slice(0, 160);

  async function request(path, init, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(baseUrl + path, Object.assign({}, init, { headers: headers(), signal: ctl.signal }));
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * messages -> {ok: true, text} | {ok: false, error}. Never throws.
   * opts.maxTokens (default 600); opts.reasoningEffort, e.g. 'none' to turn off a reasoning model's thinking (Ollama, vLLM);
   * opts.responseFormat, e.g. {type: 'json_object'} for a JSON-only answer.
   */
  async function chat(messages, opts) {
    if (!enabled) return { ok: false, error: 'model not configured' };
    const o = opts || {};
    const body = { model, messages, temperature: 0, max_tokens: o.maxTokens || 600, stream: false };
    if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort;
    if (o.responseFormat) body.response_format = o.responseFormat;
    let r;
    try {
      r = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body) }, timeoutMs);
    } catch (e) {
      return { ok: false, error: safe(e) };
    }
    if (r.status < 200 || r.status >= 300) return { ok: false, error: 'HTTP ' + r.status + (r.status === 401 || r.status === 403 ? ' (check LLM_API_KEY)' : r.status === 404 ? ' (check LLM_BASE_URL and LLM_MODEL)' : '') };
    let j;
    try { j = JSON.parse(r.body); } catch (e) { return { ok: false, error: 'invalid JSON from the model server' }; }
    const text = j && Array.isArray(j.choices) && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string') return { ok: false, error: 'malformed answer (no choices[0].message.content)' };
    const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); // some reasoning models emit their scratchpad
    return clean ? { ok: true, text: clean } : { ok: false, error: 'empty answer' };
  }

  /** {host, model, reachable, modelListed, detail}. Never includes the key. */
  async function health() {
    const out = { host, model: model || '(not set)', reachable: false, modelListed: null, detail: '' };
    if (!enabled) { out.detail = 'model not configured'; return out; }
    try {
      const r = await request('/models', { method: 'GET' }, Math.min(timeoutMs, 10000));
      if (r.status === 401 || r.status === 403) { out.reachable = true; out.detail = 'endpoint rejected the API key (HTTP ' + r.status + ')'; return out; }
      if (r.status < 200 || r.status >= 300) { out.detail = 'HTTP ' + r.status; return out; }
      out.reachable = true;
      try {
        const ids = (JSON.parse(r.body).data || []).map((m) => m && m.id);
        out.modelListed = ids.indexOf(model) >= 0;
        out.detail = out.modelListed ? 'model available' : 'model "' + model + '" not in the server\'s model list';
      } catch (e) { out.detail = 'reachable; model list unreadable'; }
    } catch (e) {
      out.detail = safe(e);
    }
    return out;
  }

  return { chat, health, host, model, enabled: !!enabled };
}

// ---------------------------------------------------------------- Google Gemini (Google AI Studio API key)
// LLM_PROVIDER=gemini: the same chat()/health() contract through Google's @google/genai SDK. System messages
// become systemInstruction; assistant turns become role "model". No tools: the model can only return text.
const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
const THINKING_HEADROOM = 2048; // thinking models spend output tokens before answering; the prompts keep answers short
const RETRY_PAUSE_MS = 1500;

/** genai: (apiKey) -> GoogleGenAI-like client; injected by tests, the real SDK otherwise. */
function createGeminiLlm({ model, apiKey, timeoutMs, enabled, redact, genai }) {
  const make = genai || ((key) => new (require('@google/genai').GoogleGenAI)({ apiKey: key }));
  let client = null;
  const ai = () => (client = client || make(apiKey));
  const safe = (e) => {
    const s = String((e && e.message) || e || '');
    const status = (e && (e.status || e.code)) || (s.match(/"code":\s*(\d{3})/) || s.match(/\b(4\d\d|5\d\d)\b/) || [])[1];
    const hint = /denied access|project has been/i.test(s) ? ' (Google has blocked this key\'s project from Gemini, e.g. a university account: create a key with a personal Google account at aistudio.google.com)'
      : /^(401|403)$/.test(String(status)) || /API key not valid|PERMISSION_DENIED/i.test(s) ? ' (check GEMINI_API_KEY)'
      : String(status) === '404' || /not found/i.test(s) ? ' (check LLM_MODEL: the model name was not found)'
        : String(status) === '503' || /high demand|UNAVAILABLE/i.test(s) ? ' (Google\'s servers for this model are busy; a -lite model such as gemini-3.5-flash-lite is usually much faster)'
        : String(status) === '429' || /RESOURCE_EXHAUSTED|quota/i.test(s) ? ' (free-tier rate limit or quota reached; try again shortly)' : '';
    return redact((status ? 'HTTP ' + status + hint + ': ' : '') + s).slice(0, 200);
  };
  const withTimeout = (p, ms) => {
    let timer;
    return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after ' + ms + ' ms')), ms); })])
      .finally(() => clearTimeout(timer));
  };

  /** OpenAI-style messages -> {systemInstruction, contents}. */
  function toGemini(messages) {
    const system = [], contents = [];
    (messages || []).forEach((m) => {
      const text = String((m && m.content) == null ? '' : m.content);
      if (m.role === 'system') system.push(text);
      else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    });
    return { systemInstruction: system.join('\n\n') || undefined, contents };
  }

  /** Same contract as the OpenAI-compatible client. opts.responseFormat {type: 'json_object'} -> JSON-only answer. */
  async function chat(messages, opts) {
    if (!enabled) return { ok: false, error: 'model not configured' };
    const o = opts || {};
    const g = toGemini(messages);
    if (!g.contents.length) return { ok: false, error: 'nothing to send' };
    const ctl = new AbortController();
    const config = { temperature: 0, maxOutputTokens: (o.maxTokens || 600) + THINKING_HEADROOM, abortSignal: ctl.signal };
    if (g.systemInstruction) config.systemInstruction = g.systemInstruction;
    if (o.responseFormat && o.responseFormat.type === 'json_object') config.responseMimeType = 'application/json';
    const started = Date.now();
    const call = () => withTimeout(ai().models.generateContent({ model, contents: g.contents, config }), timeoutMs - (Date.now() - started));
    let res;
    try {
      try {
        res = await call();
      } catch (e) {
        // "This model is currently experiencing high demand" (503): one retry after a short pause, if time allows.
        const busy = String((e && (e.status || e.code)) || '') === '503' || /UNAVAILABLE|high demand|overloaded/i.test(String((e && e.message) || ''));
        if (!busy || timeoutMs - (Date.now() - started) < RETRY_PAUSE_MS + 2000) throw e;
        await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
        res = await call();
      }
    } catch (e) {
      ctl.abort();
      return { ok: false, error: safe(e) };
    }
    const cand = res && Array.isArray(res.candidates) ? res.candidates[0] : null;
    const reason = cand && cand.finishReason;
    let text = '';
    try { text = String((res && res.text) || ''); } catch (e) { text = ''; }
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (text) return { ok: true, text };
    const blocked = res && res.promptFeedback && res.promptFeedback.blockReason;
    return { ok: false, error: blocked ? 'blocked by Gemini (' + blocked + ')' : reason ? 'empty answer (finish reason ' + reason + ')' : 'empty answer' };
  }

  /** {host, model, reachable, modelListed, detail}: asks Gemini for the model by name. Never includes the key. */
  async function health() {
    const out = { host: GEMINI_HOST, model: model || '(not set)', reachable: false, modelListed: null, detail: '' };
    if (!enabled) { out.detail = 'model not configured (set GEMINI_API_KEY and LLM_MODEL)'; return out; }
    try {
      const m = await withTimeout(ai().models.get({ model }), Math.min(timeoutMs, 10000));
      out.reachable = true;
      out.modelListed = !!m;
      out.detail = m ? 'model available' + (m.displayName ? ' (' + m.displayName + ')' : '') : 'model not found';
    } catch (e) {
      const d = safe(e);
      out.reachable = !/timed out|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(d);
      if (/check LLM_MODEL/.test(d)) out.modelListed = false;
      out.detail = d;
    }
    return out;
  }

  return { chat, health, host: GEMINI_HOST, model, enabled: !!enabled };
}

/** provider 'gemini' -> Google's SDK; anything else -> the OpenAI-compatible client above. */
function createModel(opts) {
  return opts && opts.provider === 'gemini' ? createGeminiLlm(opts) : createLlm(opts);
}

module.exports = { createLlm, createGeminiLlm, createModel };
