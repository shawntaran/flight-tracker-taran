'use strict';
// Live aircraft positions for the Node engine. OpenSky refuses connections from Google Cloud, so the engine asks
// adsb.lol first (free, no key, community ADS-B data under the ODbL licence: credit "adsb.lol") and falls back to
// OpenSky. The answer is converted to OpenSky's state-vector layout, so the tracking rules in src/Providers.js
// (findState, liveEta) and src/Tracker.js use it unchanged.
//   OpenSky state vector: 0 icao24, 1 callsign, 2 country, 3 time_position (s), 4 last_contact (s), 5 lon, 6 lat,
//   7 baro_altitude (m), 8 on_ground, 9 velocity (m/s), 10 true_track (deg), 11 vertical_rate (m/s), 13 geo_altitude, 14 squawk

const ADSB_LOL = 'https://api.adsb.lol/v2';
// adsb.lol answers 403 "User-Agent too generic; include valid contact info" to Node's default "node".
const USER_AGENT = 'flight-tracker/1.0 (+https://github.com/shawntaran/flight-tracker-taran)';
const FT_TO_M = 0.3048, KT_TO_MS = 0.514444, FPM_TO_MS = 0.00508;
const HEX_RE = /^[0-9a-f]{6}$/i, CALLSIGN_RE = /^[A-Z0-9]{3,8}$/;
const MAX_PER_REQUEST = 40;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** Pure: one adsb.lol aircraft + the response's "now" (ms) -> OpenSky state vector, or null without a position. */
function toStateVector(ac, nowMs) {
  if (!ac || num(ac.lat) == null || num(ac.lon) == null) return null;
  const ground = ac.alt_baro === 'ground';
  const posSec = (nowMs - (num(ac.seen_pos) != null ? ac.seen_pos : num(ac.seen) || 0) * 1000) / 1000;
  const lastSec = (nowMs - (num(ac.seen) || 0) * 1000) / 1000;
  return [String(ac.hex || '').toLowerCase().replace(/^~/, ''), String(ac.flight || '').padEnd(8).slice(0, 8), '', posSec, lastSec, ac.lon, ac.lat,
    ground ? 0 : num(ac.alt_baro) != null ? ac.alt_baro * FT_TO_M : null, ground, num(ac.gs) != null ? ac.gs * KT_TO_MS : null,
    num(ac.track) != null ? ac.track : num(ac.true_heading), num(ac.baro_rate) != null ? ac.baro_rate * FPM_TO_MS : null, null,
    num(ac.alt_geom) != null ? ac.alt_geom * FT_TO_M : null, ac.squawk || null, false, 0];
}

/** Pure: state vector -> the dashboard's telemetry shape (tools/flight-position.js). */
function toTelemetry(s, source) {
  return { lat: s[6], lon: s[5], onGround: s[8] === true,
    altFt: num(s[7]) != null ? Math.round(s[7] / FT_TO_M) : null, gsKts: num(s[9]) != null ? Math.round(s[9] / KT_TO_MS) : null,
    headingDeg: num(s[10]) != null ? Math.round(s[10]) : null, vsFpm: num(s[11]) != null ? Math.round(s[11] / FPM_TO_MS / 10) * 10 : null,
    squawk: s[14] || null, fixAt: Math.round((num(s[3]) != null ? s[3] : s[4]) * 1000), callsign: String(s[1] || '').trim(), source };
}

/**
 * fetchJson: (url) -> {ok, json} | {ok: false, error}, synchronous (the engine's UrlFetchApp).
 * -> (icao24s, callsigns) -> {ok, states, source} | {ok: false, error}: at most one request by hex, one by callsign.
 */
function createAdsbLol(fetchJson) {
  return function states(icao24s, callsigns) {
    const hexes = [...new Set((icao24s || []).map((h) => String(h || '').trim().toLowerCase()).filter((h) => HEX_RE.test(h)))].slice(0, MAX_PER_REQUEST);
    // Every flight is also looked up by callsign: the transponder id comes from the provider's planned aircraft, and
    // after a last-minute aircraft swap only the callsign finds the flight (findState tries the id first).
    const calls = [...new Set((callsigns || []).map((c) => String(c || '').trim().toUpperCase()).filter((c) => CALLSIGN_RE.test(c)))].slice(0, MAX_PER_REQUEST);
    if (!hexes.length && !calls.length) return { ok: true, states: [], source: 'adsb.lol' };
    const out = [], errors = [];
    [[hexes, '/icao/'], [calls, '/callsign/']].forEach(([list, path]) => {
      if (!list.length) return;
      const r = fetchJson(ADSB_LOL + path + list.map(encodeURIComponent).join(','));
      if (!r.ok) { errors.push(r.error); return; }
      const now = num(r.json && r.json.now) || Date.now();
      ((r.json && r.json.ac) || []).forEach((ac) => { const s = toStateVector(ac, now); if (s) out.push(s); });
    });
    if (errors.length && errors.length === [hexes, calls].filter((l) => l.length).length) return { ok: false, error: 'adsb.lol: ' + errors.join('; ') };
    return { ok: true, states: out, source: 'adsb.lol' };
  };
}

module.exports = { createAdsbLol, toStateVector, toTelemetry, ADSB_LOL, USER_AGENT };
