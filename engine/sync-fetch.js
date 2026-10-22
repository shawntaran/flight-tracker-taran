'use strict';
// Synchronous HTTP for the tracker's decision code (src/*.js), which was written for Apps Script's blocking
// UrlFetchApp: whether a flight needs another lookup depends on the answer to the previous one. A worker
// thread runs Node's own fetch(); the caller blocks on Atomics.wait until the answer is posted back.
// One worker per process, started on first use and unref'd so it never keeps a process alive.

const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

const TIMEOUT_MS = 20000;

const WORKER_SRC = `
const { workerData } = require('worker_threads');
const port = workerData.port;
port.on('message', async ({ req, flag }) => {
  let out;
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs) });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    out = { code: res.status, body: await res.text(), headers };
  } catch (e) {
    out = { error: (e && e.name === 'TimeoutError') ? 'request timed out' : String((e && e.cause && e.cause.code) || (e && e.message) || e) };
  }
  port.postMessage(out);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

let worker = null, port = null;

function start() {
  const ch = new MessageChannel();
  worker = new Worker(WORKER_SRC, { eval: true, workerData: { port: ch.port2 }, transferList: [ch.port2] });
  worker.unref();
  worker.on('error', () => { worker = null; });
  worker.on('exit', () => { worker = null; });
  port = ch.port1;
  port.unref();
}

/**
 * req: {url, method, headers, body, timeoutMs} -> {code, body, headers} | {error}. Never throws for HTTP
 * statuses; a network failure or timeout comes back as {error}.
 */
function fetchSync(req) {
  if (!worker) start();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const timeoutMs = req.timeoutMs || TIMEOUT_MS;
  port.postMessage({ req: Object.assign({}, req, { timeoutMs }), flag });
  const waited = Atomics.wait(flag, 0, 0, timeoutMs + 2000);
  const msg = receiveMessageOnPort(port);
  if (!msg) return { error: waited === 'timed-out' ? 'request timed out' : 'no answer from the fetch worker' };
  return msg.message;
}

/** Blocking sleep without a busy loop (Apps Script's Utilities.sleep). */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = { fetchSync, sleepSync };
