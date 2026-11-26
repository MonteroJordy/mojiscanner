'use strict';

// Eventbrite API v3: GET /events/{event_id}/attendees/ with a private token (Account Settings > Developer Links > API Keys).
// Each attendee carries barcodes[] with the barcode value and its status. Full list every sync.

const { requestJson, ConnectorError, sleep } = require('./http-client');

const VOID_ATTENDEE = /not attending|deleted|transferred|refunded|cancel/i;

function mapAttendee(a) {
  const p = a.profile || {};
  const name = p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
  const attendeeVoid = a.cancelled || a.refunded || (a.status && VOID_ATTENDEE.test(a.status));
  return (a.barcodes || []).filter((b) => b && b.barcode).map((b) => {
    const barcodeVoid = b.status && /refund|cancel|void/i.test(b.status);
    const valid = !attendeeVoid && !barcodeVoid;
    return {
      extId: `${a.id}:${b.barcode}`,
      code: b.barcode,
      holderName: name || null,
      holderEmail: p.email || null,
      ticketType: a.ticket_class_name || null,
      valid,
      sourceStatus: a.status || b.status || null,
      voidReason: valid ? null : (a.refunded ? 'Refunded on Eventbrite' : a.cancelled ? 'Canceled on Eventbrite' : (a.status || b.status || 'Not valid')),
      externalScannedAt: b.status === 'used' ? (b.changed || a.changed || new Date().toISOString()) : null,
    };
  });
}

async function sync({ config: cfg, fetchImpl, baseUrl, pageDelayMs = 150 }) {
  if (!cfg.token || !cfg.eventId) throw new ConnectorError('Eventbrite: private token and event ID are required');
  const base = baseUrl.replace(/\/+$/, '');
  const rows = [];
  let continuation = null;
  let page = 1;
  for (let i = 0; i < 2000; i++) {
    const u = new URL(`${base}/events/${encodeURIComponent(String(cfg.eventId).trim())}/attendees/`);
    if (continuation) u.searchParams.set('continuation', continuation);
    else if (page > 1) u.searchParams.set('page', String(page));
    const data = await requestJson(fetchImpl, u.toString(), { headers: { Authorization: `Bearer ${String(cfg.token).trim()}` }, platform: 'Eventbrite' });
    for (const a of data.attendees || []) rows.push(...mapAttendee(a));
    const pg = data.pagination || {};
    if (pg.has_more_items && pg.continuation) { continuation = pg.continuation; }
    else if (!pg.continuation && pg.page_count && pg.page_number < pg.page_count) { page = pg.page_number + 1; continuation = null; }
    else break;
    if (pageDelayMs) await sleep(pageDelayMs);
  }
  return { mode: 'replace', rows, message: `${rows.length} barcodes` };
}

module.exports = { sync, mapAttendee };
