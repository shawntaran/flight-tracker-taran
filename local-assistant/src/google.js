'use strict';
// Read-only Google Sheets access. OAuth scope: spreadsheets.readonly, so even a bug here cannot write.
// The only Sheets request is GET .../values/<range>. The refresh token stays in local-assistant/.state/.

const crypto = require('crypto');
const http = require('http');
const { readJson, writeJsonAtomic } = require('./state');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function scopeIsReadOnly(scope) {
  const s = String(scope || '').split(/\s+/).filter(Boolean);
  return s.length > 0 && s.every((x) => x === SCOPE);
}

function createGoogle({ clientId, clientSecret, tokenFile, fetch, now, redact }) {
  const clock = now || (() => Date.now());

  async function postForm(url, form) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString() });
    let j = null;
    try { j = JSON.parse(await res.text()); } catch (e) { j = null; }
    return { status: res.status, j };
  }

  async function accessToken() {
    const t = readJson(tokenFile);
    if (!t || !t.refresh_token) throw new Error('not authorised yet: run "npm run assistant:auth" once');
    if (!scopeIsReadOnly(t.scope)) throw new Error('stored Google token is not read-only; delete it and run "npm run assistant:auth" again');
    if (t.access_token && t.expiry_date && t.expiry_date - clock() > 60 * 1000) return t.access_token;
    const r = await postForm(TOKEN_URL, { client_id: clientId, client_secret: clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
    if (r.status !== 200 || !r.j || !r.j.access_token) {
      throw new Error('Google token refresh failed (HTTP ' + r.status + (r.j && r.j.error ? ' ' + r.j.error : '') +
        '). If access was revoked, run "npm run assistant:auth" again');
    }
    if (r.j.scope && !scopeIsReadOnly(r.j.scope)) throw new Error('Google returned a token wider than read-only; refusing to use it');
    writeJsonAtomic(tokenFile, Object.assign({}, t, { access_token: r.j.access_token, expiry_date: clock() + (Number(r.j.expires_in) || 3600) * 1000 }));
    return r.j.access_token;
  }

  /** One sheet tab -> {rows} | {missing: true} | throws. GET only. */
  async function readRange(spreadsheetId, sheetName) {
    const token = await accessToken();
    const url = SHEETS + encodeURIComponent(spreadsheetId) + '/values/' + encodeURIComponent("'" + sheetName + "'") +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
      const body = await res.text();
      if (res.status === 200) {
        let j = null;
        try { j = JSON.parse(body); } catch (e) { throw new Error('Sheets returned unreadable JSON for ' + sheetName); }
        return { rows: Array.isArray(j && j.values) ? j.values : [] };
      }
      if (res.status === 400 && /Unable to parse range/i.test(body)) return { missing: true };
      throw new Error('Sheets read of "' + sheetName + '" failed: HTTP ' + res.status +
        (res.status === 403 ? ' (no access: share the sheet with the authorised account)' : res.status === 404 ? ' (wrong GOOGLE_SPREADSHEET_ID?)' : ''));
    } catch (e) {
      throw new Error(redact(e && e.name === 'AbortError' ? 'Sheets read of "' + sheetName + '" timed out' : (e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Interactive one-time consent (installed-app flow, loopback redirect, PKCE). */
  async function authorize({ print, timeoutMs }) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const redirectUri = 'http://127.0.0.1:' + server.address().port;
    const url = AUTH_URL + '?' + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: SCOPE, access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
    print('Open this URL in a browser, sign in with an account that can VIEW the tracker sheet, and allow read-only access:\n\n' + url + '\n');
    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer within 5 minutes')), timeoutMs || 5 * 60 * 1000);
        server.on('request', (req, res) => {
          const q = new URL(req.url, redirectUri).searchParams;
          if (!q.get('code') && !q.get('error')) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(q.get('error') ? 'Authorisation was not granted. You can close this tab.' : 'Done. You can close this tab and return to the terminal.');
          clearTimeout(timer);
          if (q.get('state') !== state) reject(new Error('state mismatch; try again'));
          else if (q.get('error')) reject(new Error('Google answered: ' + q.get('error')));
          else resolve(q.get('code'));
        });
      });
      const r = await postForm(TOKEN_URL, { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: verifier });
      if (r.status !== 200 || !r.j || !r.j.refresh_token) throw new Error('token exchange failed (HTTP ' + r.status + (r.j && r.j.error ? ' ' + r.j.error : '') + ')');
      if (!scopeIsReadOnly(r.j.scope || SCOPE)) throw new Error('Google granted more than read-only access; not saved');
      writeJsonAtomic(tokenFile, { refresh_token: r.j.refresh_token, access_token: r.j.access_token,
        expiry_date: clock() + (Number(r.j.expires_in) || 3600) * 1000, scope: SCOPE });
    } finally {
      server.close();
    }
  }

  return { accessToken, readRange, authorize };
}

module.exports = { createGoogle, SCOPE, scopeIsReadOnly };
