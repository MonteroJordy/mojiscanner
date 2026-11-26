'use strict';

// Generic webhook receiver. Built for Posh ("Order Created" webhooks, Settings > API Webhooks), but works for any
// platform that POSTs JSON. Posh doesn't publish its payload format, so every payload is stored, and in the admin you
// point at the fields once ("the QR value is at tickets[].qrCode") and re-run the stored payloads.

/**
 * Path syntax: dot-separated keys; `[]` fans out over an array; `[2]` picks an index; a leading `$.` means
 * "from the top of the payload" when used inside an items mapping.
 *   order.buyer.email   tickets[].qrCode   $.order.id
 */
function resolve(obj, path) {
  if (!path) return [];
  const segments = String(path).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let current = [obj];
  for (const seg of segments) {
    const m = /^([^[\]]*)((?:\[\d*\])*)$/.exec(seg);
    if (!m) return [];
    const key = m[1];
    const brackets = m[2].match(/\[\d*\]/g) || [];
    let next = [];
    for (const c of current) {
      if (c === null || c === undefined) continue;
      next.push(key ? c[key] : c);
    }
    for (const b of brackets) {
      const fanned = [];
      for (const c of next) {
        if (!Array.isArray(c)) continue;
        if (b === '[]') fanned.push(...c);
        else { const v = c[Number(b.slice(1, -1))]; if (v !== undefined) fanned.push(v); }
      }
      next = fanned;
    }
    current = next;
  }
  return current.filter((v) => v !== undefined && v !== null);
}

function first(root, item, path) {
  if (!path) return null;
  const fromRoot = String(path).startsWith('$');
  const vals = resolve(fromRoot ? root : item, path);
  const v = vals.find((x) => typeof x !== 'object');
  return v === undefined ? null : String(v);
}

const VOID_STATUS = /refund|cancel|void|invalid|revoked|transferr|resold|declin|reject|chargeback|deleted/i;

function extractRows(payload, mapping) {
  if (!mapping || !mapping.code) return { rows: [], error: 'No field mapping yet' };
  const items = mapping.items ? resolve(payload, mapping.items).filter((x) => x && typeof x === 'object') : [payload];
  const rows = [];
  for (const item of items) {
    const code = first(payload, item, mapping.code);
    if (!code) continue;
    let name = first(payload, item, mapping.name);
    if (!name) name = [first(payload, item, mapping.firstName), first(payload, item, mapping.lastName)].filter(Boolean).join(' ') || null;
    const status = first(payload, item, mapping.status);
    const isVoid = !!(status && VOID_STATUS.test(status));
    rows.push({
      extId: first(payload, item, mapping.extId),
      code,
      holderName: name,
      holderEmail: first(payload, item, mapping.email),
      ticketType: first(payload, item, mapping.ticketType),
      valid: !isVoid,
      sourceStatus: status,
      voidReason: isVoid ? status : null,
    });
  }
  return { rows };
}

/** Lists every leaf field in a payload with a sample value, likely QR fields first. */
function describeFields(payload, limit = 200) {
  const out = [];
  (function walk(v, path, depth) {
    if (out.length >= limit || depth > 8) return;
    if (Array.isArray(v)) { if (v.length) walk(v[0], `${path}[]`, depth + 1); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, depth + 1); return; }
    out.push({ path, sample: v === null ? null : String(v).slice(0, 80) });
  })(payload, '', 0);
  const score = (p) => (/qr|barcode|scan.?code/i.test(p) ? 0 : /(ticket|pass).?(id|code|number)|\bcode\b|secret/i.test(p) ? 1 : 2);
  return out.sort((a, b) => score(a.path) - score(b.path));
}

/** Best guess at a mapping from one payload, so the admin only has to confirm. */
function guessMapping(payload) {
  const fields = describeFields(payload);
  const pick = (re) => (fields.find((f) => re.test(f.path)) || {}).path || '';
  const code = pick(/qr|barcode|scan.?code/i) || pick(/(ticket|pass).?(code|id)$/i);
  const arr = /^(.*?\[\])\./.exec(code);
  const items = arr ? arr[1] : '';
  const rel = (p) => (p && items && p.startsWith(`${items}.`) ? p.slice(items.length + 1) : p ? (items ? `$.${p}` : p) : '');
  return {
    items,
    code: rel(code),
    // Only take a "name" that clearly belongs to a person (not the event or venue name).
    name: rel(pick(/(full_?name|attendee_?name|holder_?name|customer_?name|buyer_?name|guest_?name)$/i)
      || pick(/(attendee|holder|buyer|customer|purchaser|user|guest|account)[^.]*\.name$/i)),
    firstName: rel(pick(/first_?name$/i)),
    lastName: rel(pick(/last_?name$/i)),
    email: rel(pick(/e_?mail$/i)),
    ticketType: rel(pick(/ticket_?(type|name)|tier|deal_?title/i)),
    extId: '',
    status: '',
  };
}

module.exports = { resolve, extractRows, describeFields, guessMapping };
