'use strict';

// Shotgun /tickets API: https://shotguntheapp.notion.site/tickets-API-2a2655f4cc2a80bfa811f3b93a889666
// Token: Smartboard > Settings > Integrations > Shotgun APIs > Generate a token.
// Each ticket has ticket_scan_code (the QR value) and ticket_status. A transfer cancels the old ticket
// and issues a new one with a new QR, so we keep pulling "updated after <cursor>" until doors.

const { requestJson, ConnectorError, sleep } = require('./http-client');

const STATUS_LABELS = {
  resold: 'Resold on Shotgun',
  refunded: 'Refunded',
  canceled: 'Canceled (or transferred to someone else)',
  payment_plan_pending: 'Payment plan not finished',
  pending_approval: 'Waiting for organizer approval',
  rejected: 'Rejected by organizer',
};

function mapTicket(t) {
  const first = t.contact_first_name || '';
  const last = t.contact_last_name || '';
  const status = t.ticket_status || 'valid';
  const valid = status === 'valid' && !t.ticket_canceled_at && !t.event_canceled_at;
  return {
    extId: t.ticket_id != null ? String(t.ticket_id) : null,
    code: t.ticket_scan_code,
    holderName: `${first} ${last}`.trim() || null,
    holderEmail: t.contact_email || null,
    ticketType: t.deal_sub_category ? `${t.deal_title} · ${t.deal_sub_category}` : (t.deal_title || null),
    valid,
    sourceStatus: status,
    voidReason: valid ? null : (t.event_canceled_at ? 'Event canceled on Shotgun' : (STATUS_LABELS[status] || status)),
    externalScannedAt: t.ticket_scanned_at ? toIso(t.ticket_scanned_at) : null,
  };
}

function toIso(s) {
  // Shotgun returns "2025-02-21 17:29:52.462881" (UTC).
  const d = new Date(String(s).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function sync({ config: cfg, cursor, fetchImpl, baseUrl, pageDelayMs = 650 }) {
  if (!cfg.organizerId || !cfg.token || !cfg.eventId) {
    throw new ConnectorError('Shotgun: organizer ID, API token and Shotgun event ID are all required');
  }
  const base = new URL(baseUrl);
  const first = new URL('/tickets', base);
  first.searchParams.set('organizer_id', String(cfg.organizerId).trim());
  first.searchParams.set('event_id', String(cfg.eventId).trim());
  if (cfg.includeCohosted) first.searchParams.set('include_cohosted_events', '1');
  if (cursor) first.searchParams.set('after', cursor);

  const rows = [];
  let nextCursor = cursor || null;
  let url = first.toString();
  let pages = 0;
  while (url) {
    const data = await requestJson(fetchImpl, url, { headers: { Authorization: `Bearer ${String(cfg.token).trim()}` }, platform: 'Shotgun' });
    const list = Array.isArray(data.data) ? data.data : [];
    for (const t of list) {
      if (t.ticket_updated_at && t.ticket_id != null) nextCursor = `${t.ticket_updated_at}_${t.ticket_id}`;
      if (t.event_id != null && String(t.event_id) !== String(cfg.eventId).trim()) continue;
      if (t.ticket_scan_code) rows.push(mapTicket(t));
    }
    pages++;
    const next = data.pagination && data.pagination.next;
    url = null;
    if (next && list.length) {
      const n = new URL(next, base);
      // Only follow pagination links on Shotgun's own host, so the token never goes anywhere else.
      if (n.origin !== base.origin) throw new ConnectorError('Shotgun: pagination link pointed to another host; stopped');
      url = n.toString();
      if (pages >= 1000) throw new ConnectorError('Shotgun: too many pages, stopped');
      if (pageDelayMs) await sleep(pageDelayMs); // stay under 100 requests/minute
    }
  }
  return { mode: 'merge', rows, cursor: nextCursor, message: `${rows.length} new or changed tickets` };
}

module.exports = { sync, mapTicket, toIso };
