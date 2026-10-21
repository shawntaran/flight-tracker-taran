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
   * opts.maxTokens (default 600); opts.reasoningEffort, e.g. 'none' to turn off a reasoning model's thinking (Ollama, vLLM).
   */
  async function chat(messages, opts) {
    if (!enabled) return { ok: false, error: 'model not configured' };
    const o = opts || {};
    const body = { model, messages, temperature: 0, max_tokens: o.maxTokens || 600, stream: false };
    if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort;
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

module.exports = { createLlm };
