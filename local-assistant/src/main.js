#!/usr/bin/env node
'use strict';
// Faculty Flight Tracker: local Telegram assistant.
//   node local-assistant/src/main.js           start polling (npm run assistant)
//   node local-assistant/src/main.js health    check config, Telegram, Google and the model; sends no message
//   node local-assistant/src/main.js auth      one-time read-only Google authorisation

const path = require('path');
const { loadConfig, describe } = require('./config');
const { makeRedactor, makeLogger } = require('./redact');
const { createTelegram } = require('./telegram');
const { createOffsetStore, readJson } = require('./state');
const { createGoogle } = require('./google');
const { createLlm } = require('./llm');
const { createWorker, createSnapshotSource } = require('./worker');

let redactAll = makeRedactor([]);

async function main() {
  const cmd = process.argv[2] || 'start';
  const { config, problems, file, fileFound } = loadConfig();
  const redact = redactAll = makeRedactor([config.tgToken, config.llm.apiKey, config.google.clientSecret]);
  const log = makeLogger(redact);
  const print = (s) => console.log(redact(s));
  if (!fileFound) print('No config file at ' + file + '. Copy .env.local-assistant.example to .env.local-assistant and fill it in.');
  problems.forEach((p) => log(p.level === 'error' ? 'ERROR' : 'WARN', p.key + ': ' + p.message));

  const tokenFile = path.join(config.stateDir, 'google-token.json');
  const google = createGoogle({ clientId: config.google.clientId, clientSecret: config.google.clientSecret, tokenFile, fetch, redact });
  const llm = createLlm(Object.assign({}, config.llm, { fetch, redact }));

  if (cmd === 'auth') {
    if (!config.google.clientId || !config.google.clientSecret) { print('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.'); process.exitCode = 1; return; }
    await google.authorize({ print });
    print('Saved a read-only Google token to ' + tokenFile + ' (git-ignored). Run "npm run assistant:health" next.');
    return;
  }

  const telegram = createTelegram({ token: config.tgToken, fetch, redact, timeoutMs: 15000 });

  if (cmd === 'health') {
    print('Configuration: ' + JSON.stringify(describe(config)));
    const me = await telegram.getMe();
    print('Telegram: ' + (me.ok ? 'token accepted, bot @' + me.result.username : 'FAILED ' + me.error));
    let sheet;
    try {
      const r = await google.readRange(config.spreadsheetId, 'Flights');
      sheet = r.missing ? 'FAILED: no "Flights" sheet in that spreadsheet' : 'read-only access works (' + Math.max(0, r.rows.length - 1) + ' Flights rows)';
    } catch (e) { sheet = 'FAILED ' + ((e && e.message) || e); }
    print('Google Sheets: ' + sheet + (readJson(tokenFile) ? '' : ' (no token yet: run npm run assistant:auth)'));
    const h = await llm.health();
    print('Model: endpoint ' + h.host + ', model ' + h.model + ', ' + (h.reachable ? 'reachable' : 'UNREACHABLE') + (h.detail ? ' (' + h.detail + ')' : ''));
    if (problems.some((p) => p.level === 'error') || !me.ok || /FAILED/.test(sheet)) process.exitCode = 1;
    return;
  }

  if (cmd !== 'start') { print('Unknown command "' + cmd + '". Use: start | health | auth'); process.exitCode = 1; return; }
  if (problems.some((p) => p.level === 'error')) { print('Fix the configuration errors above, then start again.'); process.exitCode = 1; return; }

  const offsetStore = createOffsetStore(path.join(config.stateDir, 'telegram-offset.json'));
  const getSnapshot = createSnapshotSource({ readRange: google.readRange, spreadsheetId: config.spreadsheetId, now: Date.now, ttlMs: config.snapshotTtlMs, log });
  const worker = createWorker({ config, telegram, offsetStore, getSnapshot, llm, log, now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

  const h = await llm.health();
  log('INFO', 'model endpoint ' + h.host + ', model ' + h.model + ': ' + (h.reachable ? 'reachable' : 'unreachable') + (h.detail ? ' (' + h.detail + ')' : '') +
    (h.reachable ? '' : '. Commands and deterministic answers still work'));
  log('INFO', 'assistant started for ' + config.allowedChatIds.size + ' allowed chat(s); read-only; press Ctrl+C to stop');
  // Never die on a stray error: log it and keep polling.
  process.on('unhandledRejection', (e) => log('ERROR', 'unhandled: ' + ((e && e.message) || e)));
  process.on('uncaughtException', (e) => log('ERROR', 'uncaught: ' + ((e && e.message) || e)));
  const stop = () => { log('INFO', 'stopping'); worker.stop(); setTimeout(() => process.exit(0), 500).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await worker.run();
}

main().catch((e) => { console.error('Fatal: ' + redactAll(e)); process.exitCode = 1; });
