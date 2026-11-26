'use strict';

// DICE Ticket Holders API (GraphQL): https://partners-endpoint.dice.fm/graphql/docs/index.html
// Token: MIO > your company name > Account Settings > Access Tokens > Ticket holder API token.
// Ticket.code (the QR value), Ticket.holder and Ticket.ticketType are RESTRICTED fields:
// DICE has to enable them for your account before this works. Ask your DICE rep for
// "restricted field access (ticket code) on the Ticket Holders API for door access control".
//
// DICE creates a ticket's QR when the fan activates it in the app (about 2 hours before the event), so codes
// arrive late. Tickets without a code yet are skipped, and never voided for it.
//
// Every sync pulls the full ticket list for the event (DICE only offers an "updated since" filter on
// events, not tickets) and returns. Anything that disappears, or was returned, gets voided.

const { requestJson, ConnectorError, sleep } = require('./http-client');

const TICKETS_QUERY = `
query DoorTickets($first: Int!, $after: String, $eventId: ID!) {
  viewer {
    tickets(first: $first, after: $after, where: { eventId: { eq: $eventId } }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { node { id code claimedAt holder { firstName lastName } ticketType { name } } }
    }
  }
}`;

const RETURNS_QUERY = `
query DoorReturns($first: Int!, $after: String, $eventId: ID!) {
  viewer {
    returns(first: $first, after: $after, where: { eventId: { eq: $eventId } }) {
      pageInfo { hasNextPage endCursor }
      edges { node { ticketId returnedAt reason } }
    }
  }
}`;

const EVENTS_QUERY = `
query DoorEvents($first: Int!, $after: String) {
  viewer {
    events(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name startDatetime state } }
    }
  }
}`;

async function gql(fetchImpl, url, token, query, variables) {
  const data = await requestJson(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(token).trim()}` },
    body: JSON.stringify({ query, variables }),
    platform: 'DICE',
  });
  if (data.errors && data.errors.length) {
    const msg = data.errors.map((e) => e.message).join('; ');
    const restricted = /restrict|permission|not authori[sz]ed|forbidden|access/i.test(msg);
    throw new ConnectorError(`DICE: ${msg.slice(0, 400)}`, {
      hint: restricted ? 'DICE has not enabled the restricted ticket fields (code, holder, ticket type) for this token. Ask your DICE rep to turn them on.' : undefined,
    });
  }
  if (!data.data || !data.data.viewer) throw new ConnectorError('DICE: empty response');
  return data.data.viewer;
}

async function paginate(fetchImpl, url, token, query, variables, field, pageDelayMs) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 1000; page++) {
    const viewer = await gql(fetchImpl, url, token, query, { ...variables, first: 100, after });
    const conn = viewer[field];
    if (!conn) break;
    for (const e of conn.edges || []) if (e && e.node) nodes.push(e.node);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return nodes;
    after = conn.pageInfo.endCursor;
    if (pageDelayMs) await sleep(pageDelayMs);
  }
  return nodes;
}

async function sync({ config: cfg, fetchImpl, baseUrl, pageDelayMs = 200 }) {
  if (!cfg.token || !cfg.eventId) throw new ConnectorError('DICE: API token and DICE event are required');
  const eventId = String(cfg.eventId).trim();
  const tickets = await paginate(fetchImpl, baseUrl, cfg.token, TICKETS_QUERY, { eventId }, 'tickets', pageDelayMs);
  let returns = [];
  try {
    returns = await paginate(fetchImpl, baseUrl, cfg.token, RETURNS_QUERY, { eventId }, 'returns', pageDelayMs);
  } catch (_) {
    returns = []; // returns are a bonus; missing tickets are voided by the full-list sync anyway
  }
  const returned = new Map(returns.map((r) => [String(r.ticketId), r]));

  let missingCode = 0;
  const keepExtIds = [];
  const rows = [];
  for (const t of tickets) {
    // A ticket we know about that comes back without a code this time is kept as-is, never voided.
    if (!t.code) { missingCode++; keepExtIds.push(String(t.id)); continue; }
    const h = t.holder || {};
    const ret = returned.get(String(t.id));
    rows.push({
      extId: String(t.id),
      code: t.code,
      holderName: `${h.firstName || ''} ${h.lastName || ''}`.trim() || null,
      holderEmail: null, // DICE's token terms: don't download personal information. Names stay for search at the door.
      ticketType: (t.ticketType && t.ticketType.name) || null,
      valid: !ret,
      sourceStatus: ret ? 'returned' : 'active',
      voidReason: ret ? `Returned on DICE${ret.reason ? ` (${ret.reason})` : ''}` : null,
    });
  }
  if (tickets.length && missingCode === tickets.length) {
    // Before fans activate their tickets (about 2 hours before the event) there may be no codes at all.
    throw new ConnectorError(`DICE: found ${tickets.length} tickets, but none has a QR code yet`, {
      hint: 'Either no fan has activated a ticket yet (DICE creates the QR when the fan activates it in the app, about 2 hours before the event), or the restricted "code" field isn\'t enabled for this token. If it\'s still empty once doors open, ask your DICE rep to enable it.',
    });
  }
  const msg = `${rows.length} tickets${returns.length ? `, ${returns.length} returned` : ''}${missingCode ? `, ${missingCode} without a code yet` : ''}`;
  return { mode: 'replace', rows, keepExtIds, message: msg };
}

async function listEvents({ token, fetchImpl, baseUrl }) {
  if (!token) throw new ConnectorError('DICE: token required');
  const events = await paginate(fetchImpl, baseUrl, token, EVENTS_QUERY, {}, 'events', 0);
  return events
    .map((e) => ({ id: e.id, name: e.name, startsAt: e.startDatetime, state: e.state }))
    .sort((a, b) => String(b.startsAt || '').localeCompare(String(a.startsAt || '')));
}

module.exports = { sync, listEvents, TICKETS_QUERY, RETURNS_QUERY, EVENTS_QUERY };
