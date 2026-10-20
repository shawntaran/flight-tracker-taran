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
  '/flight-position.js': path.join(__dirname, 'flight-position.js'),
  '/cab-suggestions.js': path.join(__dirname, 'cab-suggestions.js')
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
