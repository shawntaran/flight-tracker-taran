'use strict';
// IST helpers. India has no DST, so a fixed +05:30 offset is exact (same rule as src/Util.js).

const MIN = 60 * 1000;
const IST_OFFSET = 330 * MIN;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** A plausible epoch-ms value, or null. */
function validMs(ms) {
  return typeof ms === 'number' && isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

/**
 * Sheet value -> ms or null. Machine columns hold UTC ISO strings; coordinator columns may hold
 * "2026-10-21 08:00" (IST). Anything else (serial numbers, free text, impossible dates) is null.
 */
function parseTime(v) {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'number') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return validMs(Date.parse(s));
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59) return null;
  return validMs(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - IST_OFFSET);
}

/** 'Wed 21 Oct 08:35 IST' */
function fmtIST(ms) {
  if (validMs(ms) == null) return '';
  const d = new Date(ms + IST_OFFSET);
  return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' IST';
}

/** '08:35 IST' */
function fmtTimeIST(ms) {
  if (validMs(ms) == null) return '';
  const d = new Date(ms + IST_OFFSET);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' IST';
}

module.exports = { MIN, HOUR: 60 * MIN, validMs, parseTime, fmtIST, fmtTimeIST };
