'use strict';

const crypto = require('node:crypto');

/** RFC 4180 CSV parser that copes with BOMs, ; or tab delimiters, quoted newlines and \r\n. */
function parseCsv(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const delimiter = detectDelimiter(s);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return { delimiter, headers, rows };
}

function detectDelimiter(s) {
  const firstLine = s.slice(0, Math.max(0, s.search(/\r|\n/)) || s.length);
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  let best = ',';
  for (const d of Object.keys(counts)) if (counts[d] > counts[best]) best = d;
  return best;
}

function norm(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Header names seen in RA, Shotgun, DICE, Eventbrite, Posh, Bucket Listers and generic exports.
// First match wins, so the most specific names come first.
const FIELD_HINTS = {
  code: ['barcode', 'barcode id', 'barcode number', 'ticket barcode', 'scan code', 'qr code', 'qr', 'qr code data',
    'qr data', 'ticket code', 'code', 'access code', 'entry code', 'ticket number', 'ticket no', 'ticket reference',
    'ticket ref', 'secret', 'ticket id'],
  name: ['full name', 'name', 'attendee name', 'attendee', 'holder name', 'ticket holder', 'ticket holder name',
    'guest name', 'guest', 'customer name', 'customer', 'buyer name', 'purchaser name', 'purchaser'],
  firstName: ['first name', 'firstname', 'given name', 'attendee first name', 'buyer first name', 'holder first name', 'first'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'attendee last name', 'buyer last name', 'holder last name', 'last'],
  email: ['email', 'email address', 'e mail', 'attendee email', 'buyer email', 'customer email', 'holder email', 'purchaser email'],
  ticketType: ['ticket type', 'ticket type name', 'ticket name', 'ticket class', 'ticket tier', 'tier', 'type', 'ticket',
    'product', 'product name', 'deal title', 'price tier', 'item', 'item name', 'category'],
  status: ['status', 'ticket status', 'order status', 'attendee status', 'state'],
  // Only used for lists without codes, where one row can stand for several tickets.
  quantity: ['quantity', 'qty', 'ticket quantity', 'ticket qty', 'tickets quantity', 'number of tickets', 'no of tickets',
    'of tickets', 'tickets purchased', 'tickets bought', 'ticket count', 'party size', 'tickets', 'count'],
  extId: ['ticket id', 'order id', 'order number', 'order', 'id'],
};

/** Suggests which column holds what. Returns column indexes (or -1). */
function suggestMapping(headers) {
  const normalized = headers.map(norm);
  const used = new Set();
  const mapping = {};
  const order = ['code', 'firstName', 'lastName', 'email', 'ticketType', 'status', 'quantity', 'name', 'extId'];
  for (const field of order) {
    mapping[field] = -1;
    for (const hint of FIELD_HINTS[field]) {
      const idx = normalized.findIndex((h, i) => !used.has(i) && h === hint);
      if (idx !== -1) { mapping[field] = idx; used.add(idx); break; }
    }
  }
  // Loose second pass for the code column only: headers containing "barcode" or "qr".
  if (mapping.code === -1) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && /\b(barcode|qr|scan)\b/.test(h));
    if (idx !== -1) { mapping.code = idx; used.add(idx); }
  }
  return mapping;
}

const VOID_STATUS = /refund|cancel|void|invalid|revoked|transferr|resold|declin|reject|chargeback|deleted|not attending|returned/i;

const MAX_PER_ROW = 50;

/** "2", "2 tickets", "1,200" -> the number; blank or unreadable -> 1. */
function quantityOf(raw) {
  if (!raw) return 1;
  const m = String(raw).replace(/,/g, '').match(/-?\d+/);
  return m ? Math.max(0, parseInt(m[0], 10)) : 1;
}

const squash = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Turns parsed CSV rows into ticket rows using a mapping of column indexes.
 *
 * With a code column, each row that has a code is one ticket. Without one (names from a platform that won't
 * share QR values, or a guest list), each row becomes `quantity` tickets with a made-up code nobody can scan:
 * door staff find the guest with Search and tap Admit. The made-up codes come out the same on every upload of
 * the same list, so a re-upload updates tickets instead of duplicating them. `salt` (the source id) keeps two
 * name lists from sharing a code, because a shared code only gets in once.
 */
function rowsToTickets(rows, mapping, { salt = '' } = {}) {
  const has = (k) => Number.isInteger(mapping[k]) && mapping[k] >= 0;
  const col = (row, k) => (has(k) && mapping[k] < row.length ? String(row[mapping[k]]).trim() : '');
  const nameOnly = !has('code');
  const out = [];
  const people = new Map();
  for (const row of rows) {
    const code = col(row, 'code');
    if (!nameOnly && !code) continue;
    let name = col(row, 'name');
    if (!name) name = [col(row, 'firstName'), col(row, 'lastName')].filter(Boolean).join(' ');
    const email = col(row, 'email');
    const status = col(row, 'status');
    const isVoid = Boolean(status) && VOID_STATUS.test(status);
    const ticket = {
      extId: col(row, 'extId') || null,
      code,
      holderName: name || null,
      holderEmail: email || null,
      ticketType: col(row, 'ticketType') || null,
      valid: !isVoid,
      sourceStatus: status || null,
      voidReason: isVoid ? status : null,
    };
    if (!nameOnly) { out.push(ticket); continue; }
    if (!name && !email) continue;
    const id = crypto.createHash('sha256')
      .update([salt, squash(name), squash(email), squash(ticket.ticketType), squash(ticket.extId)].join('|'))
      .digest('hex').slice(0, 12).toUpperCase();
    if (!people.has(id)) people.set(id, { valid: [], void: [] });
    people.get(id)[isVoid ? 'void' : 'valid'].push({ ticket, qty: has('quantity') ? quantityOf(col(row, 'quantity')) : 1 });
  }
  // Valid tickets take the low numbers, so a refunded order turns the last numbers void and the rest keep theirs.
  for (const [id, p] of people) {
    let n = 0;
    for (const { ticket, qty } of [...p.valid, ...p.void]) {
      for (let i = 0; i < Math.min(qty, MAX_PER_ROW); i++) {
        n++;
        out.push({ ...ticket, extId: ticket.extId ? `${ticket.extId}#${n}` : null, code: `NOQR-${id}-${n}`, noQr: true, capped: i === 0 && qty > MAX_PER_ROW });
      }
    }
  }
  return out;
}

function toCsv(headers, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Leading = + - @ would run as a formula when opened in Excel/Sheets.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}

module.exports = { parseCsv, suggestMapping, rowsToTickets, toCsv, FIELD_HINTS };
