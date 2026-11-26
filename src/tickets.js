'use strict';

const { codeKey, candidateKeys, decide } = require('../public/js/codes.js');

const nowIso = () => new Date().toISOString();

const TICKET_COLUMNS = 'id, event_id, source_id, platform, ext_id, code, code_key, holder_name, holder_email, ticket_type, status, void_reason, source_status, scanned_at, scanned_by, scan_count, flag, rev';

/**
 * Writes rows from one source into the unified list.
 *
 * mode 'merge'   – add/update the rows given (incremental API pulls, webhooks, partial files)
 * mode 'replace' – the rows are the full current list; anything from this source that's missing gets voided
 *                  (that's how refunds, resales and transfers on RA / DICE / Eventbrite disappear)
 */
function applyRows(db, source, rows, { mode = 'merge', reason, keepExtIds = [], maxVoidRatio = null } = {}) {
  return db.tx(() => {
    const rev = db.nextRev();
    const ts = nowIso();
    const stats = { received: rows.length, added: 0, updated: 0, unchanged: 0, voided: 0, skipped: 0, duplicateInFile: 0, sharedWithOtherSources: 0, scannedThenVoided: 0, voidSkipped: 0 };
    const seen = new Set();

    for (const row of rows) {
      const key = codeKey(row.code);
      if (!key) { stats.skipped++; continue; }
      if (seen.has(key)) { stats.duplicateInFile++; continue; }
      seen.add(key);

      const status = row.valid === false ? 'void' : 'valid';
      const voidReason = status === 'void' ? (row.voidReason || row.sourceStatus || 'Not valid') : null;

      let existing = null;
      if (row.extId) existing = db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE source_id = ? AND ext_id = ?`, source.id, String(row.extId));
      if (!existing) existing = db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE source_id = ? AND code_key = ?`, source.id, key);

      if (!existing) {
        const other = db.get('SELECT 1 AS x FROM tickets WHERE event_id = ? AND code_key = ? AND source_id <> ? LIMIT 1', source.event_id, key, source.id);
        if (other) stats.sharedWithOtherSources++;
        const scannedAt = row.externalScannedAt || null;
        db.run(
          `INSERT INTO tickets (event_id, source_id, platform, ext_id, code, code_key, holder_name, holder_email, ticket_type,
             status, void_reason, source_status, scanned_at, scanned_by, scan_count, created_at, updated_at, rev)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          source.event_id, source.id, source.platform, row.extId ? String(row.extId) : null, String(row.code).trim(), key,
          row.holderName || null, row.holderEmail || null, row.ticketType || null,
          status, voidReason, row.sourceStatus || null,
          scannedAt, scannedAt ? `${platformName(source.platform)} scanner` : null, scannedAt ? 1 : 0, ts, ts, rev,
        );
        stats.added++;
        continue;
      }

      // If the code moved to a ticket we already store under another row (same code, new ext id), keep one row.
      if (existing.code_key !== key) {
        const clash = db.get('SELECT id FROM tickets WHERE source_id = ? AND code_key = ? AND id <> ?', source.id, key, existing.id);
        if (clash) { stats.duplicateInFile++; continue; }
      }

      const next = {
        ext_id: row.extId ? String(row.extId) : existing.ext_id,
        code: String(row.code).trim(),
        code_key: key,
        holder_name: row.holderName ?? existing.holder_name,
        holder_email: row.holderEmail ?? existing.holder_email,
        ticket_type: row.ticketType ?? existing.ticket_type,
        status,
        void_reason: voidReason,
        source_status: row.sourceStatus ?? existing.source_status,
        scanned_at: existing.scanned_at,
        scanned_by: existing.scanned_by,
        scan_count: existing.scan_count,
        flag: existing.flag,
      };
      if (row.externalScannedAt && !existing.scanned_at) {
        next.scanned_at = row.externalScannedAt;
        next.scanned_by = `${platformName(source.platform)} scanner`;
        next.scan_count = existing.scan_count + 1;
      }
      if (existing.status === 'valid' && status === 'void' && existing.scanned_at) {
        next.flag = 'voided_after_scan';
        stats.scannedThenVoided++;
      }
      const changed = ['ext_id', 'code', 'code_key', 'holder_name', 'holder_email', 'ticket_type', 'status', 'void_reason', 'source_status', 'scanned_at', 'flag']
        .some((k) => (existing[k] ?? null) !== (next[k] ?? null));
      if (!changed) { stats.unchanged++; continue; }
      if (existing.status === 'valid' && status === 'void') stats.voided++;
      db.run(
        `UPDATE tickets SET ext_id = ?, code = ?, code_key = ?, holder_name = ?, holder_email = ?, ticket_type = ?, status = ?,
           void_reason = ?, source_status = ?, scanned_at = ?, scanned_by = ?, scan_count = ?, flag = ?, updated_at = ?, rev = ?
         WHERE id = ?`,
        next.ext_id, next.code, next.code_key, next.holder_name, next.holder_email, next.ticket_type, next.status,
        next.void_reason, next.source_status, next.scanned_at, next.scanned_by, next.scan_count, next.flag, ts, rev, existing.id,
      );
      stats.updated++;
    }

    if (mode === 'replace') {
      const keep = new Set(keepExtIds.map(String));
      const current = db.all("SELECT id, ext_id, code_key, scanned_at FROM tickets WHERE source_id = ? AND status = 'valid'", source.id);
      const toVoid = current.filter((t) => !seen.has(t.code_key) && !(t.ext_id && keep.has(t.ext_id)));
      // Safety net for automatic syncs: an empty or half-empty response is far more likely to be an API
      // problem than a wave of refunds, and voiding the guest list an hour before doors is the worst outcome.
      if (maxVoidRatio !== null && toVoid.length > Math.max(10, Math.floor(current.length * maxVoidRatio))) {
        stats.voidSkipped = toVoid.length;
        return stats;
      }
      for (const t of toVoid) {
        db.run(
          "UPDATE tickets SET status = 'void', void_reason = ?, flag = CASE WHEN scanned_at IS NOT NULL THEN 'voided_after_scan' ELSE flag END, updated_at = ?, rev = ? WHERE id = ?",
          reason || 'No longer on the platform list (refunded, resold or transferred)', ts, rev, t.id,
        );
        stats.voided++;
        if (t.scanned_at) stats.scannedThenVoided++;
      }
    }
    return stats;
  });
}

/** Voids every ticket from a source (used when a source is removed). */
function voidSource(db, sourceId, reason) {
  return db.tx(() => {
    const rev = db.nextRev();
    const res = db.run("UPDATE tickets SET status = 'void', void_reason = ?, updated_at = ?, rev = ? WHERE source_id = ? AND status = 'valid'", reason, nowIso(), rev, sourceId);
    return Number(res.changes);
  });
}

function findByCode(db, eventId, raw) {
  const keys = candidateKeys(raw);
  if (!keys.length) return { keys, rows: [] };
  for (const key of keys) {
    const rows = db.all(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE event_id = ? AND code_key = ?`, eventId, key);
    if (rows.length) return { keys, key, rows };
  }
  return { keys, rows: [] };
}

/**
 * The door decision. First valid scan of a code admits; every later scan of the same code (on any device,
 * from any source) is a duplicate. Idempotent per clientScanId so offline retries never double count.
 */
function scan(db, eventId, input) {
  const { raw = null, ticketId = null, device = {}, clientScanId = null, scannedAt = null, offline = false, method = 'camera', localResult = null } = input;
  return db.tx(() => {
    if (clientScanId) {
      const prior = db.get('SELECT * FROM scans WHERE client_scan_id = ?', clientScanId);
      if (prior) return replay(db, prior);
    }
    let rows = [];
    if (ticketId) {
      const t = db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ? AND event_id = ?`, ticketId, eventId);
      if (t) rows = db.all(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE event_id = ? AND code_key = ?`, eventId, t.code_key);
      // Put the chosen ticket first so it is the one reported.
      rows.sort((a, b) => (a.id === Number(ticketId) ? -1 : b.id === Number(ticketId) ? 1 : 0));
    } else {
      rows = findByCode(db, eventId, raw).rows;
    }

    const decision = decide(rows);
    const at = validIso(scannedAt) || nowIso();
    const receivedAt = nowIso();
    let ticket = decision.ticket || null;
    let note = null;

    if (decision.result === 'admitted') {
      const rev = db.nextRev();
      db.run(
        `UPDATE tickets SET scanned_at = ?, scanned_by = ?, scan_count = scan_count + 1, updated_at = ?, rev = ?
         WHERE event_id = ? AND code_key = ? AND status = 'valid' AND scanned_at IS NULL`,
        at, device.name || null, receivedAt, rev, eventId, ticket.code_key,
      );
      ticket = db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`, ticket.id);
    } else if (decision.result === 'duplicate') {
      const rev = db.nextRev();
      // A device that was offline let this person in too: both entries happened, so flag it for the report.
      const doubleEntry = offline && localResult === 'admitted';
      if (doubleEntry) note = 'double_entry';
      db.run(
        `UPDATE tickets SET scan_count = scan_count + 1, flag = CASE WHEN ? THEN 'double_entry' ELSE flag END, updated_at = ?, rev = ?
         WHERE event_id = ? AND code_key = ? AND status = 'valid'`,
        doubleEntry ? 1 : 0, receivedAt, rev, eventId, ticket.code_key,
      );
      ticket = db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`, ticket.id);
    }

    db.run(
      `INSERT INTO scans (event_id, ticket_id, code_raw, result, method, device_id, device_name, scanned_at, received_at, offline, client_scan_id, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      eventId, ticket ? ticket.id : null, raw ? String(raw).slice(0, 500) : null, decision.result, method,
      device.id || null, device.name || null, at, receivedAt, offline ? 1 : 0, clientScanId, note,
    );
    return { result: decision.result, ticket: ticket ? publicTicket(ticket) : null, note };
  });
}

function replay(db, prior) {
  const ticket = prior.ticket_id ? db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`, prior.ticket_id) : null;
  return { result: prior.result, ticket: ticket ? publicTicket(ticket) : null, note: prior.note, replayed: true };
}

/** Lets a door person reverse an accidental admit. */
function undoScan(db, eventId, ticketId, device = {}) {
  return db.tx(() => {
    const t = db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ? AND event_id = ?`, ticketId, eventId);
    if (!t || !t.scanned_at) return { ok: false };
    const rev = db.nextRev();
    const ts = nowIso();
    db.run('UPDATE tickets SET scanned_at = NULL, scanned_by = NULL, updated_at = ?, rev = ? WHERE event_id = ? AND code_key = ?', ts, rev, eventId, t.code_key);
    db.run(
      "INSERT INTO scans (event_id, ticket_id, code_raw, result, method, device_id, device_name, scanned_at, received_at, offline) VALUES (?,?,?,?,?,?,?,?,?,0)",
      eventId, t.id, t.code, 'undo', 'manual', device.id || null, device.name || null, ts, ts,
    );
    return { ok: true, ticket: publicTicket(db.get(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE id = ?`, t.id)) };
  });
}

/** Everything that changed after (rev, id), in order, for door devices to keep their offline copy current. */
function changesSince(db, eventId, sinceRev = 0, sinceId = 0, limit = 2000) {
  const rows = db.all(
    `SELECT ${TICKET_COLUMNS} FROM tickets WHERE event_id = ? AND (rev > ? OR (rev = ? AND id > ?)) ORDER BY rev, id LIMIT ?`,
    eventId, sinceRev, sinceRev, sinceId, limit,
  );
  const last = rows[rows.length - 1];
  return {
    tickets: rows.map(doorTicket),
    cursor: last ? { rev: last.rev, id: last.id } : { rev: sinceRev, id: sinceId },
    more: rows.length === limit,
  };
}

function stats(db, eventId) {
  const bySource = db.all(
    `SELECT s.id AS source_id, s.label, s.platform,
            SUM(CASE WHEN t.status = 'valid' THEN 1 ELSE 0 END) AS valid,
            SUM(CASE WHEN t.status = 'valid' AND t.scanned_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned,
            SUM(CASE WHEN t.status = 'void' THEN 1 ELSE 0 END) AS void
       FROM sources s LEFT JOIN tickets t ON t.source_id = s.id
      WHERE s.event_id = ? AND s.removed = 0
      GROUP BY s.id ORDER BY s.created_at`,
    eventId,
  ).map((r) => ({ ...r, valid: r.valid || 0, scanned: r.scanned || 0, void: r.void || 0 }));
  const totals = db.get(
    `SELECT COUNT(DISTINCT CASE WHEN status = 'valid' THEN code_key END) AS valid,
            COUNT(DISTINCT CASE WHEN status = 'valid' AND scanned_at IS NOT NULL THEN code_key END) AS scanned
       FROM tickets WHERE event_id = ?`,
    eventId,
  );
  // Row counts for the admin's ticket filters (rows, not distinct codes, so they match the table).
  const rows = db.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'valid' AND scanned_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned,
            SUM(CASE WHEN status = 'valid' AND scanned_at IS NULL THEN 1 ELSE 0 END) AS unscanned,
            SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) AS void,
            SUM(CASE WHEN flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged,
            MAX(scanned_at) AS last_scan
       FROM tickets WHERE event_id = ?`,
    eventId,
  );
  const results = db.all('SELECT result, COUNT(*) AS n FROM scans WHERE event_id = ? GROUP BY result', eventId);
  const flags = db.all('SELECT flag, COUNT(*) AS n FROM tickets WHERE event_id = ? AND flag IS NOT NULL GROUP BY flag', eventId);
  return {
    valid: totals.valid || 0,
    scanned: totals.scanned || 0,
    bySource,
    rows: { all: rows.total || 0, scanned: rows.scanned || 0, unscanned: rows.unscanned || 0, void: rows.void || 0, flagged: rows.flagged || 0 },
    lastScanAt: rows.last_scan || null,
    scans: Object.fromEntries(results.map((r) => [r.result, r.n])),
    flags: Object.fromEntries(flags.map((r) => [r.flag, r.n])),
  };
}

function searchTickets(db, eventId, q, { limit = 50, status, sourceId } = {}) {
  const where = ['event_id = ?'];
  const params = [eventId];
  if (q) {
    const like = `%${String(q).replace(/[%_]/g, '')}%`;
    // Name-only lists have random made-up codes; matching on them would turn up random people.
    where.push("(holder_name LIKE ? OR holder_email LIKE ? OR (code LIKE ? AND code NOT LIKE 'NOQR-%') OR ext_id LIKE ?)");
    params.push(like, like, like, like);
  }
  if (status === 'scanned') where.push("status = 'valid' AND scanned_at IS NOT NULL");
  else if (status === 'unscanned') where.push("status = 'valid' AND scanned_at IS NULL");
  else if (status === 'void') where.push("status = 'void'");
  else if (status === 'flagged') where.push('flag IS NOT NULL');
  if (sourceId) { where.push('source_id = ?'); params.push(sourceId); }
  params.push(Math.min(Number(limit) || 50, 500));
  return db.all(`SELECT ${TICKET_COLUMNS} FROM tickets WHERE ${where.join(' AND ')} ORDER BY holder_name COLLATE NOCASE, id LIMIT ?`, ...params).map(publicTicket);
}

function publicTicket(t) {
  return {
    id: t.id,
    sourceId: t.source_id,
    platform: t.platform,
    code: t.code,
    holderName: t.holder_name,
    holderEmail: t.holder_email,
    ticketType: t.ticket_type,
    status: t.status,
    voidReason: t.void_reason,
    sourceStatus: t.source_status,
    scannedAt: t.scanned_at,
    scannedBy: t.scanned_by,
    scanCount: t.scan_count,
    flag: t.flag,
  };
}

/** Compact shape stored on door devices (short keys keep a 20k-ticket list small). */
function doorTicket(t) {
  return {
    id: t.id,
    k: t.code_key,
    c: t.code,
    p: t.platform,
    n: t.holder_name,
    e: t.holder_email,
    y: t.ticket_type,
    s: t.status,
    v: t.void_reason,
    a: t.scanned_at,
    b: t.scanned_by,
  };
}

function platformName(p) {
  return ({ shotgun: 'Shotgun', dice: 'DICE', ra: 'RA', bucketlisters: 'Bucket Listers', eventbrite: 'Eventbrite', posh: 'Posh', other: 'Other' })[p] || p;
}

function validIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { applyRows, voidSource, findByCode, scan, undoScan, changesSince, stats, searchTickets, publicTicket, platformName, TICKET_COLUMNS };
