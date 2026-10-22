#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DASHBOARD_HTML_PATH = path.join(ROOT, 'src', 'DashboardPage.html');
const PREVIEW_APP_PATH = path.join(__dirname, 'preview-app.html');
const MOCK_BRIDGE_PATH = path.join(__dirname, 'mock-bridge.js');
// Preview-only browser modules served as-is (fixed list: no path from the URL reaches the file system).
const PREVIEW_MODULES = {
  '/flight-sort.js': path.join(__dirname, 'flight-sort.js'),
  '/guest-view.js': path.join(__dirname, 'guest-view.js'),
  '/flight-position.js': path.join(__dirname, 'flight-position.js'),
  '/cab-suggestions.js': path.join(__dirname, 'cab-suggestions.js'),
  '/smart-dispatch.js': path.join(__dirname, 'smart-dispatch.js')
};
// The production grouping rules, read (never written) from src/ and wrapped in one function scope so their
// Apps Script globals stay out of the page: window.FTGrouping = {planGroups, defaultConfig}.
const GROUPING_SOURCES = ['Util.js', 'Config.js', 'Grouping.js'].map((f) => path.join(ROOT, 'src', f));
function getGroupingBundle() {
  const body = GROUPING_SOURCES.map((p) => '// ---- src/' + path.basename(p) + '\n' + fs.readFileSync(p, 'utf8')).join('\n');
  return '/* Preview bundle of src/Util.js, src/Config.js, src/Grouping.js (read-only copy) */\n' +
    'window.FTGrouping = (function () {\n' + body + '\nreturn { planGroups: planGroups, defaultConfig: defaultConfig };\n})();\n';
}

const defaultPort = parseInt(process.env.PORT || '3000', 10);

// Live data for the preview: the tracker's data in Supabase (PREVIEW_SOURCE=import: the Import columns),
// read server-side (see tools/sheet-source.js). Built lazily so the server still starts, and ?mock=1 still
// works, without the local assistant's Supabase setup. fresh: a click on Refresh skips the 60 s cache.
let sheetSource = null;
function getSheetData(fresh) {
  try {
    sheetSource = sheetSource || require('./sheet-source').createSheetSource();
  } catch (err) {
    return Promise.reject(err);
  }
  return sheetSource({ fresh });
}

// Operations Assistant: the model from local-assistant/.env.local-assistant (see tools/ops-assistant.js). Lazy for the same reason.
const ASSISTANT_MAX_BODY = 256 * 1024;
let opsAssistant = null;
function getOpsAssistant() {
  opsAssistant = opsAssistant || require('./ops-assistant').createOpsAssistant();
  return opsAssistant;
}

// Write actions (tools/tracker-control.js): add a guest with the anon key; start a tracking-engine run now.
let guestInserter = null, trackerRunner = null;
function getGuestInserter() {
  if (!guestInserter) {
    const { loadConfig } = require('../local-assistant/src/config');
    const { createClient } = require('@supabase/supabase-js');
    const { config } = loadConfig();
    if (!config.supabase.url || !config.supabase.anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in local-assistant/.env.local-assistant');
    const client = createClient(config.supabase.url, config.supabase.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    guestInserter = require('./tracker-control').createGuestInserter(client);
  }
  return guestInserter;
}
function getTrackerRunner() {
  trackerRunner = trackerRunner || require('./tracker-control').createTrackerRunner(require('child_process').spawn);
  return trackerRunner;
}
function invalidateSheetData() { if (sheetSource && sheetSource.invalidate) sheetSource.invalidate(); }
// "Picked up" marks (tools/pickups.js): written with the engine's service-role key from .env.engine.
let pickupStore = null;
function getPickupStore() {
  if (!pickupStore) {
    const { readEnv, makeClient } = require('../engine/run');
    const env = readEnv(process.env, path.join(ROOT, '.env.engine'));
    if (!env.supabaseUrl || !env.serviceKey) throw new Error('Saving "picked up" needs .env.engine with the service-role key on this server');
    pickupStore = require('./pickups').createPickupStore(makeClient(env));
  }
  return pickupStore;
}

/** POST with a JSON body from this page only (a cross-site page cannot send application/json without a preflight we never answer). */
function readJsonPost(req, res, limit, cb) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'JSON only' });
  const origin = req.headers.origin;
  // http locally; https behind the HTTPS proxy on a server (deploy/), which forwards the original Host.
  if (origin && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host) return sendJson(res, 403, { error: 'cross-origin request refused' });
  let body = '', tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => { if (tooBig) return; body += chunk; if (body.length > limit) { tooBig = true; sendJson(res, 413, { error: 'request too large' }); } });
  req.on('end', () => {
    if (tooBig) return;
    let parsed;
    try { parsed = body ? JSON.parse(body) : {}; } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
    cb(parsed);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/**
 * POST /api/assistant {messages, context} and POST /api/dispatch {input} -> {text} | {error}.
 * JSON only, so other sites cannot post here without a CORS preflight (never answered).
 */
function handleModelPost(req, res, method) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'JSON only' });
  let body = '', tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (tooBig) return;
    body += chunk;
    if (body.length > ASSISTANT_MAX_BODY) { tooBig = true; sendJson(res, 413, { error: 'request too large' }); }
  });
  req.on('end', () => {
    if (tooBig) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON' }); }
    Promise.resolve().then(() => getOpsAssistant()[method](parsed)).then((r) => {
      if (r.ok) sendJson(res, 200, { text: r.text });
      else sendJson(res, 502, { error: r.error });
    }).catch((err) => sendJson(res, 500, { error: String(err && err.message || err) }));
  });
}

function getMockBridgeContent() {
  return fs.readFileSync(MOCK_BRIDGE_PATH, 'utf8');
}

function getPreviewAppHtmlWithBridge() {
  const html = fs.readFileSync(PREVIEW_APP_PATH, 'utf8');
  if (html.includes('/mock-bridge.js')) {
    return html;
  }
  const injection = '  <script src="/mock-bridge.js"></script>\n';
  if (html.includes('</head>')) {
    return html.replace('</head>', injection + '</head>');
  }
  return injection + html;
}

function getOriginalDashboardHtmlWithBridge() {
  const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
  // Inject mock bridge script before </head>
  const injection = '  <script src="/mock-bridge.js"></script>\n';
  if (html.includes('</head>')) {
    return html.replace('</head>', injection + '</head>');
  }
  return injection + html;
}

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html' || pathname === '/preview-app.html') {
    try {
      const content = getPreviewAppHtmlWithBridge();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading dashboard page: ' + err.message);
    }
    return;
  }

  if (pathname === '/original' || pathname === '/original.html') {
    try {
      const content = getOriginalDashboardHtmlWithBridge();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading original dashboard page: ' + err.message);
    }
    return;
  }

  if (pathname === '/mock-bridge.js') {
    try {
      const js = getMockBridgeContent();
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(js);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading mock bridge: ' + err.message);
    }
    return;
  }

  if (pathname === '/api/dashboard-data') {
    getSheetData(url.searchParams.get('fresh') === '1').then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    }).catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    });
    return;
  }

  if (pathname === '/api/guests') {
    readJsonPost(req, res, 4096, (body) => {
      Promise.resolve().then(() => getGuestInserter()(body)).then((r) => {
        if (r.ok) invalidateSheetData();
        sendJson(res, r.ok ? 201 : 400, r);
      }).catch((err) => sendJson(res, 500, { ok: false, error: String(err && err.message || err) }));
    });
    return;
  }

  if (pathname === '/api/pickups') {
    readJsonPost(req, res, 4096, (body) => {
      Promise.resolve().then(() => getPickupStore()(body)).then((r) => {
        if (r.ok) invalidateSheetData();
        sendJson(res, r.ok ? 200 : 400, r);
      }).catch((err) => sendJson(res, 503, { ok: false, error: String(err && err.message || err) }));
    });
    return;
  }

  if (pathname === '/api/tracker/run') {
    if (req.method === 'GET') {
      const s = getTrackerRunner().status();
      if (!s.running && s.finishedAt) invalidateSheetData();
      return sendJson(res, 200, s);
    }
    readJsonPost(req, res, 1024, () => sendJson(res, 202, getTrackerRunner().start()));
    return;
  }

  if (pathname === '/api/assistant') {
    handleModelPost(req, res, 'ask');
    return;
  }

  if (pathname === '/api/dispatch') {
    handleModelPost(req, res, 'dispatch');
    return;
  }

  if (pathname === '/api/assistant/status') {
    Promise.resolve().then(() => getOpsAssistant().status())
      .then((s) => sendJson(res, 200, s))
      .catch((err) => sendJson(res, 200, { online: false, model: '', detail: String(err && err.message || err) }));
    return;
  }

  if (pathname === '/grouping-bundle.js') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(getGroupingBundle());
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error building grouping bundle: ' + err.message);
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(PREVIEW_MODULES, pathname)) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(PREVIEW_MODULES[pathname], 'utf8'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Error loading preview module: ' + err.message);
    }
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function startServer(port, maxAttempts = 10) {
  const server = http.createServer(handleRequest);

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxAttempts > 1) {
      console.log(`Port ${port} in use, trying port ${port + 1}...`);
      startServer(port + 1, maxAttempts - 1);
    } else {
      console.error('Failed to start server:', err.message);
      process.exit(1);
    }
  });

  server.listen(port, 'localhost', () => {
    const address = server.address();
    const serverPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://localhost:${serverPort}/`;

    console.log('====================================================');
    console.log(' Flight Tracker Dashboard - Local Preview Server');
    console.log('====================================================');
    console.log(` Local URL: ${url}`);
    console.log(' Environment: Development Preview (Offline)');
    console.log(' Mock Bridge: google.script.run active');
    console.log(' Press Ctrl+C to stop the server.');
    console.log('====================================================');
  });

  process.on('SIGINT', () => {
    console.log('\nStopping preview server...');
    server.close(() => {
      console.log('Preview server stopped.');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });

  return server;
}

if (require.main === module) {
  startServer(defaultPort);
}

module.exports = { startServer, handleRequest };
