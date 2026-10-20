'use strict';
// Secret redaction for every log line and every error text the worker produces.

const PATTERNS = [
  [/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]'],          // Telegram URL form
  [/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]'],             // bare Telegram bot token
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],     // Authorization headers
  [/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED]'],                   // Google access token
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED]'],                // Google refresh token
  [/\bGOCSPX-[A-Za-z0-9_-]+/g, '[REDACTED]'],                   // Google OAuth client secret
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],                   // OpenAI-style API key
  [/([?&](?:key|token|access_token|api_key)=)[^&\s]+/gi, '$1[REDACTED]']
];

/** -> redact(text): masks the given secret values (length >= 6) and anything shaped like a credential. */
function makeRedactor(secrets) {
  const values = (secrets || []).filter((v) => typeof v === 'string' && v.trim().length >= 6).map((v) => v.trim());
  return function redact(text) {
    let s = String(text == null ? '' : (text && text.message) || text);
    values.forEach((v) => { s = s.split(v).join('[REDACTED]'); });
    PATTERNS.forEach(([re, rep]) => { s = s.replace(re, rep); });
    return s;
  };
}

/** Logger that never prints a secret. Message text from users is never passed here. */
function makeLogger(redact, sink) {
  const out = sink || ((line) => console.log(line));
  return (level, msg) => out(new Date().toISOString() + ' ' + level + ' ' + redact(msg));
}

module.exports = { makeRedactor, makeLogger };
