'use strict';
// Vercel Cron Job: one tracker run every 5 minutes (schedule in vercel.json). Vercel calls this path with
// "Authorization: Bearer <CRON_SECRET>"; any other caller is refused, so nobody else can spend the API budget.
// Environment (Vercel project settings -> Environment Variables):
//   CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADB_KEY, TG_BOT_TOKEN
//   optional: FA_KEY, OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET

const crypto = require('crypto');
const { runTracker, readEnv, makeClient } = require('../engine/run');

function authorised(req, secret) {
  const got = Buffer.from(String((req.headers && req.headers.authorization) || ''));
  const want = Buffer.from('Bearer ' + secret);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: 'CRON_SECRET is not set in the Vercel project' });
  if (!authorised(req, secret)) return res.status(401).json({ ok: false, error: 'unauthorised' });
  try {
    const e = readEnv(process.env, null);
    const r = await runTracker({ client: makeClient(e), secrets: e.secrets, extraRedact: [e.serviceKey, secret], scheduled: true });
    const body = { ok: r.ok, locked: !!r.locked, summary: r.summary ? { lookupsDue: r.summary.lookupsDue, lookupsMade: r.summary.lookupsMade,
      rowsUpdated: r.summary.rowsUpdated, alertsQueued: r.summary.alertsQueued } : null, writes: r.writes, notes: r.notes, error: r.error || null, ms: r.ms };
    return res.status(r.ok ? 200 : 500).json(body);
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
};
