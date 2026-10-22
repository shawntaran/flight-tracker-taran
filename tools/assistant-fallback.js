'use strict';
// The Operations Assistant WITHOUT a language model: when the model fails, times out or is not configured,
// questions are answered straight from the same FLIGHT DATA the page sends the model (assistantContext() in
// tools/preview-app.html: overview, guests, cabSuggestions). Keyword rules, no guessing: a question it cannot
// match gets a short status summary and the list of questions it can answer.

const HEADER = 'AI model unavailable, so this is answered directly from the tracker data:';
const FLIGHT_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?-?0*(\d{1,4})\b/gi;
const norm = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '').replace(/^([A-Z0-9]{2})0+/, '$1');

/** One leg (legForModel shape) -> 'EK568 · DELAYED · est. Sun 25 Oct 00:47 (sched. 00:30) · T2' */
function legText(l, kind) {
  if (!l) return '';
  const time = l.estimated && l.estimated !== l.scheduled ? 'est. ' + l.estimated + (l.scheduled ? ' (sched. ' + l.scheduled + ')' : '') : l.scheduled ? 'sched. ' + l.scheduled : 'time unknown';
  return [kind + ' ' + (l.flight || '?'), l.status || 'SCHEDULED', time, l.terminal ? 'Terminal ' + String(l.terminal).replace(/^T/i, '') : '',
    l.gate ? 'Gate ' + l.gate : '', l.delayMinutes ? l.delayMinutes + ' min late' : ''].filter(Boolean).join(' · ');
}

function guestLines(g) {
  const out = ['- ' + g.name + ':'];
  if (g.arrival) {
    out.push('  ' + legText(g.arrival, 'Arrives on'));
    const c = g.arrival.cabSuggestion;
    if (c) out.push('  Cab: ' + c.suggestion + (c.suggestedPickup ? ', pickup about ' + c.suggestedPickup : '') + (c.sharingWith ? ' with ' + c.sharingWith.join(', ') : ''));
  }
  if (g.departure) out.push('  ' + legText(g.departure, 'Departs on'));
  (g.otherFlights || []).forEach((l) => out.push('  ' + legText(l, 'Also')));
  return out;
}

const list = (title, items, empty) => (items && items.length ? [title].concat(items.map((x) => '- ' + x)) : [empty]);

/** Pure: (question, context) -> text. */
function answer(question, context) {
  const q = String(question || '');
  const lower = q.toLowerCase();
  const ctx = context || {}, ov = ctx.overview || {}, guests = Array.isArray(ctx.guests) ? ctx.guests : [];
  let lines = null;

  // 1. Flight numbers in the question.
  const wanted = (q.match(FLIGHT_RE) || []).map(norm);
  if (wanted.length) {
    const hits = guests.filter((g) => [g.arrival, g.departure].concat(g.otherFlights || []).some((l) => l && wanted.indexOf(norm(l.flight)) >= 0));
    lines = hits.length ? [].concat(...hits.map(guestLines)) : ['No guest on ' + wanted.join(', ') + ' is in the tracker.'];
  }
  // 2. A guest's name (any word of 3+ letters that is part of a name).
  if (!lines) {
    const words = lower.split(/[^a-zÀ-ɏ]+/).filter((w) => w.length >= 3 && !/^(the|and|when|where|what|who|does|did|land|lands|arrive|arrives|arriving|flight|flights|cab|cabs|for|with|from|today|tomorrow|status|delayed|late|next|leaving|leave|leaves|depart|departs|departing|departure|departures|arrival|arrivals|many|how|which|cabs|share|pickup|guest|guests|anyone|there|are|is)$/.test(w));
    const hits = guests.filter((g) => words.some((w) => String(g.name || '').toLowerCase().split(/[^a-zÀ-ɏ]+/).indexOf(w) >= 0));
    if (hits.length && hits.length <= 4) lines = [].concat(...hits.map(guestLines));
  }
  // 3. Topics.
  if (!lines) {
    if (/delay|late|behind/.test(lower)) {
      lines = ov.liveStatusAvailable === false ? [ov.liveStatusNote || 'The tracker has schedules only right now, so it cannot detect delays yet.']
        : list('Delayed:', ov.delayed, 'No tracked flight is delayed right now.');
    } else if (/unknown|unverif|could not|couldn/.test(lower)) {
      lines = list('Status could not be verified:', ov.unknownStatus, 'Every tracked flight has a verified status.');
    } else if (/cab|taxi|car\b|share|sharing|pick ?up|driver/.test(lower)) {
      const cabs = (ctx.cabSuggestions || []).map((c) => c.suggestion + ' · pickup about ' + c.suggestedPickup + ' · ' + c.members.join(', '));
      lines = list('Suggested shared cabs (suggestions only, nothing is booked):', cabs, 'No arrivals are close enough to share a cab right now.')
        .concat((ctx.individualPickups || []).length ? [(ctx.individualPickups.length) + ' other arrival(s) have an individual pickup suggested.'] : []);
    } else if (/depart|leaving|leave|outbound/.test(lower)) {
      lines = /today/.test(lower) ? list('Departing today:', ov.departuresToday, 'No departures today.') : list('Next departures:', ov.nextDepartures, 'No upcoming departures.');
    } else if (/tomorrow/.test(lower)) {
      lines = list('Arriving tomorrow:', ov.arrivalsTomorrow, 'No arrivals tomorrow.');
    } else if (/today/.test(lower)) {
      lines = list('Arriving today:', ov.arrivalsToday, 'No arrivals today.').concat(ov.arrivalsToday && ov.arrivalsToday.length ? [] : list('Next arrivals:', (ov.nextArrivals || []).slice(0, 3), ''));
    } else if (/how many|count|total|number of/.test(lower)) {
      const t = ov.totals || {};
      lines = [(t.guests || 0) + ' guests · ' + (t.arrivals || 0) + ' arrivals · ' + (t.departures || 0) + ' departures.']
        .concat(Object.keys(ov.arrivalsPerDay || {}).map((d) => '- ' + d + ': ' + ov.arrivalsPerDay[d] + ' arrival(s)'));
    } else if (/next|upcoming|soon|arriv|land/.test(lower)) {
      lines = list('Next arrivals:', ov.nextArrivals, 'No upcoming arrivals.');
    }
  }
  // 4. Anything else: a short summary and what can be asked.
  if (!lines) {
    lines = list('Next arrivals:', (ov.nextArrivals || []).slice(0, 3), 'No upcoming arrivals.')
      .concat([(ov.delayed || []).length ? (ov.delayed.length + ' delayed flight(s).') : 'No delayed flights.',
        'Without the AI I can answer: a flight number (EK568), a guest\'s name, delays, unverified flights, cabs, today, tomorrow, departures, next arrivals and counts.']);
  }
  return [HEADER].concat(lines.filter((l) => l !== '')).join('\n');
}

module.exports = { answer, HEADER };
