'use strict';
// Configuration: local-assistant/.env.local-assistant (git-ignored), overridable by real environment
// variables of the same names. Nothing here is ever printed except through describe(), which hides secrets.

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env.local-assistant');
const KEYS = ['TG_BOT_TOKEN', 'ALLOWED_CHAT_IDS', 'GOOGLE_SPREADSHEET_ID', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_TIMEOUT_MS', 'STATE_DIR', 'RATE_LIMIT_PER_MIN', 'MAX_QUESTION_CHARS'];
const PLACEHOLDER_MODEL = 'your-model-name';

/** Pure: KEY=VALUE text -> object. '#' comments, optional quotes, no interpolation. */
function parseEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) return;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  });
  return out;
}

function intIn(v, def, min, max) {
  const n = Number(v);
  return v === '' || v == null || !isFinite(n) ? def : Math.min(max, Math.max(min, Math.round(n)));
}

/** Pure: raw key/values -> {config, problems: [{level: 'error'|'warn', key, message}]}. */
function buildConfig(raw) {
  const problems = [];
  const get = (k) => String(raw[k] == null ? '' : raw[k]).trim();
  const need = (k, why) => { if (!get(k)) problems.push({ level: 'error', key: k, message: 'missing: ' + why }); };
  need('TG_BOT_TOKEN', 'the bot token from @BotFather');
  need('ALLOWED_CHAT_IDS', 'comma-separated coordinator chat ids; nobody else is answered');
  need('GOOGLE_SPREADSHEET_ID', 'the id in the tracker spreadsheet URL');
  need('GOOGLE_OAUTH_CLIENT_ID', 'Google Cloud OAuth client (Desktop app)');
  need('GOOGLE_OAUTH_CLIENT_SECRET', 'Google Cloud OAuth client (Desktop app)');

  const allowed = new Set();
  get('ALLOWED_CHAT_IDS').split(',').map((s) => s.trim()).filter(Boolean).forEach((id) => {
    if (/^-?\d{1,16}$/.test(id)) allowed.add(id);
    else problems.push({ level: 'warn', key: 'ALLOWED_CHAT_IDS', message: 'entry "' + id.slice(0, 20) + '" is not a numeric chat id; ignored' });
  });

  let baseUrl = get('LLM_BASE_URL') || 'http://127.0.0.1:11434/v1';
  let url = null;
  try {
    url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error('protocol');
    if (url.username || url.password) {
      problems.push({ level: 'error', key: 'LLM_BASE_URL', message: 'must not contain credentials; put the key in LLM_API_KEY' });
      url.username = ''; url.password = '';
    }
    baseUrl = url.toString().replace(/\/+$/, '');
  } catch (e) {
    problems.push({ level: 'error', key: 'LLM_BASE_URL', message: 'not a valid http(s) URL; the language model is disabled' });
    url = null;
  }
  const model = get('LLM_MODEL');
  if (!model || model === PLACEHOLDER_MODEL) {
    problems.push({ level: 'warn', key: 'LLM_MODEL', message: 'not set; only commands and deterministic answers will work' });
  }
  const llm = { baseUrl, model: model === PLACEHOLDER_MODEL ? '' : model, apiKey: get('LLM_API_KEY'),
    timeoutMs: intIn(get('LLM_TIMEOUT_MS'), 30000, 1000, 120000) };
  llm.enabled = !!(url && llm.model);
  if (url) endpointSafety(url, !!llm.apiKey).forEach((p) => problems.push(p));

  const config = {
    tgToken: get('TG_BOT_TOKEN'), allowedChatIds: allowed, spreadsheetId: get('GOOGLE_SPREADSHEET_ID'),
    google: { clientId: get('GOOGLE_OAUTH_CLIENT_ID'), clientSecret: get('GOOGLE_OAUTH_CLIENT_SECRET') },
    llm,
    stateDir: get('STATE_DIR') || path.join(__dirname, '..', '.state'),
    rateLimitPerMin: intIn(get('RATE_LIMIT_PER_MIN'), 6, 1, 60),
    maxQuestionChars: intIn(get('MAX_QUESTION_CHARS'), 500, 50, 2000),
    pollTimeoutS: 25, snapshotTtlMs: 60 * 1000, maxMessageAgeMin: 30
  };
  return { config, problems };
}

const isLoopback = (h) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
function isPrivateIp(h) {
  return /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /^\[?f[cd][0-9a-f]{2}:/i.test(h); // 100.64/10 covers many VPNs
}

/** Pure: warnings for model endpoints that may be exposed. Never blocks: the operator decides. */
function endpointSafety(url, hasKey) {
  const h = url.hostname, out = [];
  if (isLoopback(h)) return out;
  if (!hasKey && !isPrivateIp(h)) {
    out.push({ level: 'warn', key: 'LLM_BASE_URL', message: 'remote model endpoint without LLM_API_KEY. If ' + h +
      ' is reachable beyond the university network or VPN, require authentication on it' });
  }
  if (hasKey && url.protocol === 'http:') {
    out.push({ level: 'warn', key: 'LLM_BASE_URL', message: 'API key would travel unencrypted over http to ' + h + '; use https or a VPN' });
  }
  return out;
}

/** Secret-free description for health output. */
function describe(config) {
  let host = '(invalid URL)';
  try { const u = new URL(config.llm.baseUrl); host = u.protocol + '//' + u.host; } catch (e) { /* invalid */ }
  return { modelEndpoint: host, model: config.llm.model || '(not set)', apiKey: config.llm.apiKey ? 'set' : 'not set',
    allowedChats: config.allowedChatIds.size, spreadsheet: config.spreadsheetId ? 'set' : 'not set',
    telegramToken: config.tgToken ? 'set' : 'not set', stateDir: config.stateDir };
}

/** Reads the env file, then real environment variables (only the known keys) override it. */
function loadConfig(file) {
  const f = file || process.env.LOCAL_ASSISTANT_ENV || ENV_FILE;
  const raw = fs.existsSync(f) ? parseEnv(fs.readFileSync(f, 'utf8')) : {};
  KEYS.forEach((k) => { if (process.env[k] != null && process.env[k] !== '') raw[k] = process.env[k]; });
  return Object.assign(buildConfig(raw), { file: f, fileFound: fs.existsSync(f) });
}

module.exports = { parseEnv, buildConfig, endpointSafety, describe, loadConfig, ENV_FILE };
