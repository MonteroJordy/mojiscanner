'use strict';

const http = require('node:http');
const { Router, HttpError, readBody, readJson, send, json, serveStatic, parseCookies, rateLimiter } = require('./http');
const { safeEqual, hashPin, verifyPin, randomToken, sha256, shortId } = require('./crypto');
const tickets = require('./tickets');
const { parseCsv, suggestMapping, rowsToTickets, toCsv } = require('./csv');
const { createSyncer, PLATFORMS, summarize } = require('./sync');
const dice = require('./connectors/dice');
const webhook = require('./connectors/webhook');

const ADMIN_COOKIE = 'ds_admin';
const ADMIN_TTL = 12 * 3600;
const MAX_UPLOAD = 25 * 1024 * 1024;

// Which config fields each API platform needs, and which of them are secret (never sent back to the browser).
const API_FIELDS = {
  shotgun: { required: ['organizerId', 'token', 'eventId'], secret: ['token'], optional: ['includeCohosted'] },
  dice: { required: ['token', 'eventId'], secret: ['token'], optional: ['eventName'] },
  eventbrite: { required: ['token', 'eventId'], secret: ['token'], optional: [] },
};

function createApp({ config, db, crypto, fetchImpl = globalThis.fetch, log = console, syncPageDelayMs }) {
  const router = new Router();
  const syncer = createSyncer({ db, crypto, config, fetchImpl, log, pageDelayMs: syncPageDelayMs });
  const loginLimiter = rateLimiter({ windowMs: 10 * 60e3, max: 10 });
  const pinLimiter = rateLimiter({ windowMs: 5 * 60e3, max: 8 });
  const eventPinLimiter = rateLimiter({ windowMs: 15 * 60e3, max: 40 }); // caps guessing from many IPs
  const unlockLimiter = rateLimiter({ windowMs: 15 * 60e3, max: 60 }); // PIN-first sign-in: caps guessing across every event
  const lastSeen = new Map();

  // ---------- helpers ----------

  const nowIso = () => new Date().toISOString();

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function isHttps(req) {
    if (config.secureCookies === '1') return true;
    if (config.secureCookies === '0') return false;
    if (req.socket.encrypted) return true;
    return config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function baseUrl(req) {
    const proto = isHttps(req) ? 'https' : 'http';
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    return `${proto}://${host}`;
  }

  function requireAdmin(req) {
    const cookies = parseCookies(req.headers.cookie);
    if (crypto.unsign(cookies[ADMIN_COOKIE]) !== 'admin') throw new HttpError(401, 'Sign in again');
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'door-admin') throw new HttpError(403, 'Missing request header');
  }

  function requireDevice(req) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'Sign in to the door app');
    const device = db.get(
      `SELECT d.id, d.name, d.event_id, e.name AS event_name, e.venue AS event_venue, e.starts_at, e.archived
         FROM devices d JOIN events e ON e.id = d.event_id
        WHERE d.token_hash = ? AND d.revoked = 0`, sha256(token));
    if (!device || device.archived) throw new HttpError(401, 'This device was signed out. Sign in again.');
    const t = Date.now();
    if ((lastSeen.get(device.id) || 0) < t - 60e3) {
      lastSeen.set(device.id, t);
      db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', nowIso(), device.id);
    }
    return device;
  }

  function getEvent(id) {
    const e = db.get('SELECT * FROM events WHERE id = ?', id);
    if (!e) throw new HttpError(404, 'Event not found');
    return e;
  }

  function getSource(id) {
    const s = db.get('SELECT * FROM sources WHERE id = ? AND removed = 0', id);
    if (!s) throw new HttpError(404, 'Source not found');
    return s;
  }

  function eventView(e) {
    let doorPin = null;
    if (e.door_pin_enc) { try { doorPin = crypto.decryptJson(e.door_pin_enc).pin || null; } catch (_) { doorPin = null; } }
    return { id: e.id, name: e.name, venue: e.venue || null, startsAt: e.starts_at, archived: !!e.archived, hasPin: !!e.door_pin_hash, doorPin, createdAt: e.created_at };
  }

  function setPin(eventId, pin) {
    db.run('UPDATE events SET door_pin_hash = ?, door_pin_enc = ? WHERE id = ?', hashPin(pin), crypto.encryptJson({ pin }), eventId);
  }

  function mask(v) {
    const s = String(v || '');
    return s ? `••••${s.slice(-4)}` : '';
  }

  function sourceView(s, req) {
    let cfg = {};
    try { cfg = crypto.decryptJson(s.config_enc); } catch (_) { cfg = {}; }
    const fields = API_FIELDS[s.platform];
    const settings = {};
    if (s.kind === 'api' && fields) {
      for (const k of [...fields.required, ...fields.optional]) {
        if (cfg[k] === undefined) continue;
        settings[k] = fields.secret.includes(k) ? mask(cfg[k]) : cfg[k];
      }
    }
    return {
      id: s.id,
      platform: s.platform,
      platformName: (PLATFORMS[s.platform] || {}).name || s.platform,
      kind: s.kind,
      label: s.label,
      settings,
      mapping: s.kind === 'webhook' ? cfg.mapping || null : undefined,
      webhookUrl: s.kind === 'webhook' && req ? `${baseUrl(req)}/hooks/${s.id}/${s.webhook_secret}` : undefined,
      lastSyncAt: s.last_sync_at,
      lastSyncOk: s.last_sync_ok === null ? null : !!s.last_sync_ok,
      lastSyncMessage: s.last_sync_message,
      syncing: syncer.isRunning(s.id),
    };
  }

  function validDate(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Invalid date');
    return d.toISOString();
  }

  function str(v, max = 200) {
    return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
  }

  function checkPin(pin) {
    const p = str(pin, 32);
    if (!/^\d{4,12}$/.test(p)) throw new HttpError(400, 'Door PIN must be 4–12 digits');
    return p;
  }

  function csvDownload(res, filename, content) {
    send(res, 200, content, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    });
  }

  // ---------- admin: session ----------

  router.post('/api/admin/login', async (req, res) => {
    const ip = clientIp(req);
    if (loginLimiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Wait a few minutes.');
    const body = await readJson(req);
    if (!config.adminPassword || !safeEqual(String(body.password || ''), config.adminPassword)) {
      loginLimiter.fail(ip);
      throw new HttpError(401, 'Wrong password');
    }
    const cookie = `${ADMIN_COOKIE}=${crypto.sign('admin', ADMIN_TTL)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL}${isHttps(req) ? '; Secure' : ''}`;
    json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  });

  router.post('/api/admin/logout', async (req, res) => {
    json(res, 200, { ok: true }, { 'Set-Cookie': `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  });

  router.get('/api/admin/me', async (req, res) => {
    requireAdmin(req);
    json(res, 200, { ok: true, platforms: PLATFORMS });
  });

  // ---------- admin: events ----------

  router.get('/api/admin/events', async (req, res) => {
    requireAdmin(req);
    const events = db.all('SELECT * FROM events ORDER BY archived, COALESCE(starts_at, created_at) DESC');
    json(res, 200, {
      events: events.map((e) => {
        const st = tickets.stats(db, e.id);
        const platforms = [...new Set(st.bySource.map((s) => (PLATFORMS[s.platform] || {}).name || s.platform))];
        return { ...eventView(e), doorPin: undefined, valid: st.valid, scanned: st.scanned, sources: st.bySource.length, platforms };
      }),
    });
  });

  router.post('/api/admin/events', async (req, res) => {
    requireAdmin(req);
    const body = await readJson(req);
    const name = str(body.name, 120);
    if (!name) throw new HttpError(400, 'Event name is required');
    const pin = checkPin(body.doorPin);
    const id = shortId(8);
    db.run('INSERT INTO events (id, name, venue, starts_at, created_at) VALUES (?,?,?,?,?)', id, name, str(body.venue, 120) || null, validDate(body.startsAt), nowIso());
    setPin(id, pin);
    json(res, 201, { event: eventView(getEvent(id)) });
  });

  router.get('/api/admin/events/:id', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const sources = db.all('SELECT * FROM sources WHERE event_id = ? AND removed = 0 ORDER BY created_at', e.id);
    const devices = db.all('SELECT id, name, created_at, last_seen_at, revoked FROM devices WHERE event_id = ? ORDER BY created_at DESC', e.id);
    json(res, 200, {
      event: eventView(e),
      stats: tickets.stats(db, e.id),
      sources: sources.map((s) => sourceView(s, req)),
      devices: devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, revoked: !!d.revoked })),
    });
  });

  router.patch('/api/admin/events/:id', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const body = await readJson(req);
    if (body.name !== undefined) {
      const name = str(body.name, 120);
      if (!name) throw new HttpError(400, 'Event name is required');
      db.run('UPDATE events SET name = ? WHERE id = ?', name, e.id);
    }
    if (body.startsAt !== undefined) db.run('UPDATE events SET starts_at = ? WHERE id = ?', validDate(body.startsAt), e.id);
    if (body.venue !== undefined) db.run('UPDATE events SET venue = ? WHERE id = ?', str(body.venue, 120) || null, e.id);
    if (body.doorPin) setPin(e.id, checkPin(body.doorPin));
    if (body.archived !== undefined) db.run('UPDATE events SET archived = ? WHERE id = ?', body.archived ? 1 : 0, e.id);
    json(res, 200, { event: eventView(getEvent(e.id)) });
  });

  router.post('/api/admin/events/:id/signout-devices', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const r = db.run('UPDATE devices SET revoked = 1 WHERE event_id = ? AND revoked = 0', e.id);
    json(res, 200, { ok: true, signedOut: Number(r.changes) });
  });

  router.post('/api/admin/devices/:id/revoke', async (req, res, p) => {
    requireAdmin(req);
    db.run('UPDATE devices SET revoked = 1 WHERE id = ?', p.id);
    json(res, 200, { ok: true });
  });

  // ---------- admin: sources ----------

  function cleanApiConfig(platform, input, existing = {}) {
    const fields = API_FIELDS[platform];
    const out = { ...existing };
    for (const k of [...fields.required, ...fields.optional]) {
      if (input[k] === undefined) continue;
      if (typeof input[k] === 'boolean') { out[k] = input[k]; continue; }
      const v = str(input[k], 4000);
      // A masked value coming back from the form means "keep what's stored".
      if (fields.secret.includes(k) && (v === '' || v.startsWith('••••'))) continue;
      out[k] = v;
    }
    for (const k of fields.required) if (!out[k]) throw new HttpError(400, `Missing ${k}`);
    return out;
  }

  router.post('/api/admin/events/:id/sources', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const body = await readJson(req);
    const platform = str(body.platform, 40);
    const meta = PLATFORMS[platform];
    if (!meta) throw new HttpError(400, 'Unknown platform');
    const kind = str(body.kind, 20) || meta.kinds[0];
    if (!meta.kinds.includes(kind)) throw new HttpError(400, `${meta.name} can't be added as ${kind}`);
    const label = str(body.label, 80) || `${meta.name}${kind === 'file' ? ' (file)' : ''}`;
    let cfg = {};
    if (kind === 'api') cfg = cleanApiConfig(platform, body.config || {});
    const id = shortId(10);
    db.run('INSERT INTO sources (id, event_id, platform, label, kind, config_enc, webhook_secret, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, e.id, platform, label, kind, crypto.encryptJson(cfg), kind === 'webhook' ? randomToken(24) : null, nowIso());
    let sync = null;
    if (kind === 'api') sync = await syncer.runSource(id);
    json(res, 201, { source: sourceView(getSource(id), req), sync });
  });

  router.patch('/api/admin/sources/:id', async (req, res, p) => {
    requireAdmin(req);
    const s = getSource(p.id);
    const body = await readJson(req);
    if (body.label !== undefined) db.run('UPDATE sources SET label = ? WHERE id = ?', str(body.label, 80) || s.label, s.id);
    if (body.config && s.kind === 'api') {
      const existing = crypto.decryptJson(s.config_enc);
      const next = cleanApiConfig(s.platform, body.config, existing);
      const eventChanged = String(next.eventId) !== String(existing.eventId);
      db.run('UPDATE sources SET config_enc = ? WHERE id = ?', crypto.encryptJson(next), s.id);
      if (eventChanged) db.run('UPDATE sources SET cursor = NULL WHERE id = ?', s.id);
    }
    json(res, 200, { source: sourceView(getSource(s.id), req) });
  });

  router.delete('/api/admin/sources/:id', async (req, res, p) => {
    requireAdmin(req);
    const s = getSource(p.id);
    const voided = tickets.voidSource(db, s.id, `Source "${s.label}" was removed`);
    db.run('UPDATE sources SET removed = 1 WHERE id = ?', s.id);
    json(res, 200, { ok: true, voided });
  });

  router.post('/api/admin/sources/:id/sync', async (req, res, p) => {
    requireAdmin(req);
    const s = getSource(p.id);
    const body = await readJson(req);
    const result = await syncer.runSource(s.id, { force: !!body.force, full: !!body.full });
    json(res, 200, { ...result, source: sourceView(getSource(s.id), req) });
  });

  router.post('/api/admin/sources/:id/import/preview', async (req, res, p) => {
    requireAdmin(req);
    getSource(p.id);
    const text = (await readBody(req, MAX_UPLOAD)).toString('utf8');
    const parsed = parseCsv(text);
    if (!parsed.headers.length) throw new HttpError(400, 'That file looks empty');
    const q = new URL(req.url, 'http://x').searchParams;
    let summary = null;
    if (q.get('mapping')) {
      // Dry run with the columns picked so far: how many tickets the import would make.
      let mapping = null;
      try { mapping = JSON.parse(q.get('mapping')); } catch (_) { mapping = null; }
      if (mapping && typeof mapping === 'object') {
        const rows = rowsToTickets(parsed.rows, mapping, { salt: p.id });
        const valid = rows.filter((r) => r.valid !== false).length;
        summary = { tickets: rows.length, valid, void: rows.length - valid, nameOnly: rows.some((r) => r.noQr) };
      }
    }
    json(res, 200, {
      headers: parsed.headers,
      delimiter: parsed.delimiter,
      rowCount: parsed.rows.length,
      sample: parsed.rows.slice(0, 8),
      mapping: suggestMapping(parsed.headers),
      summary,
    });
  });

  router.post('/api/admin/sources/:id/import', async (req, res, p) => {
    requireAdmin(req);
    const s = getSource(p.id);
    const q = new URL(req.url, 'http://x').searchParams;
    let mapping;
    try { mapping = JSON.parse(q.get('mapping') || '{}'); } catch (_) { throw new HttpError(400, 'Bad mapping'); }
    if (!mapping || typeof mapping !== 'object') throw new HttpError(400, 'Bad mapping');
    const mode = q.get('mode') === 'replace' ? 'replace' : 'merge';
    const mapped = (k) => Number.isInteger(mapping[k]) && mapping[k] >= 0;
    // No code column = a list of names (platforms that won't share QR values, guest lists). Staff admit by name.
    const nameOnly = !mapped('code');
    if (nameOnly && !['name', 'firstName', 'lastName', 'email'].some(mapped)) {
      throw new HttpError(400, 'Pick the column with the QR / barcode value. For a list without codes, pick at least a name or email column.');
    }
    const text = (await readBody(req, MAX_UPLOAD)).toString('utf8');
    const parsed = parseCsv(text);
    const rows = rowsToTickets(parsed.rows, mapping, { salt: s.id });
    if (!rows.length) throw new HttpError(400, nameOnly ? 'No rows with a name or email in the chosen columns' : 'No rows with a code in the chosen column');
    const stats = tickets.applyRows(db, s, rows, { mode, reason: `Not in the latest ${PLATFORMS[s.platform].name} ${nameOnly ? 'list' : 'export'} (refunded, resold or transferred)` });
    const capped = rows.filter((r) => r.capped).length;
    const what = nameOnly ? `${rows.length} name-only tickets (no QR)` : `${rows.length} codes`;
    const message = `File import (${mode === 'replace' ? 'full list' : 'add only'}): ${what}${capped ? `, ${capped} rows capped at 50 tickets` : ''}${summarize(stats)}`;
    db.run('UPDATE sources SET last_sync_at = ?, last_sync_ok = 1, last_sync_message = ? WHERE id = ?', nowIso(), message, s.id);
    json(res, 200, { ok: true, message, stats, source: sourceView(getSource(s.id), req) });
  });

  router.get('/api/admin/sources/:id/webhooks', async (req, res, p) => {
    requireAdmin(req);
    const s = getSource(p.id);
    const logs = db.all('SELECT id, received_at, payload, result FROM webhook_log WHERE source_id = ? ORDER BY id DESC LIMIT 20', s.id);
    const parsed = logs.map((l) => {
      let payload = null;
      try { payload = JSON.parse(l.payload); } catch (_) { payload = l.payload; }
      return { id: l.id, receivedAt: l.received_at, result: l.result, payload };
    });
    const latest = parsed.find((l) => l.payload && typeof l.payload === 'object');
    const cfg = crypto.decryptJson(s.config_enc);
    const total = db.get('SELECT COUNT(*) AS n FROM webhook_log WHERE source_id = ?', s.id).n;
    json(res, 200, {
      total,
      items: parsed,
      mapping: cfg.mapping || null,
      fields: latest ? webhook.describeFields(latest.payload) : [],
      guess: latest ? webhook.guessMapping(latest.payload) : null,
      preview: latest && cfg.mapping ? webhook.extractRows(latest.payload, cfg.mapping).rows.slice(0, 10) : [],
    });
  });

  router.put('/api/admin/sources/:id/mapping', async (req, res, p) => {
    requireAdmin(req);
    const s = getSource(p.id);
    const body = await readJson(req);
    const m = body.mapping || {};
    const mapping = {};
    for (const k of ['items', 'code', 'name', 'firstName', 'lastName', 'email', 'ticketType', 'extId', 'status']) mapping[k] = str(m[k], 200);
    if (!mapping.code) throw new HttpError(400, 'Choose the field that holds the QR / barcode value');
    const cfg = crypto.decryptJson(s.config_enc);
    cfg.mapping = mapping;
    db.run('UPDATE sources SET config_enc = ? WHERE id = ?', crypto.encryptJson(cfg), s.id);
    const result = syncer.reprocessWebhooks(s.id);
    json(res, 200, { ...result, source: sourceView(getSource(s.id), req) });
  });

  router.post('/api/admin/dice/events', async (req, res) => {
    requireAdmin(req);
    const body = await readJson(req);
    let token = str(body.token, 4000);
    if ((!token || token.startsWith('••••')) && body.sourceId) token = crypto.decryptJson(getSource(str(body.sourceId)).config_enc).token;
    try {
      const events = await dice.listEvents({ token, fetchImpl, baseUrl: config.diceGraphqlUrl });
      json(res, 200, { events });
    } catch (err) {
      throw new HttpError(502, `${err.message}${err.hint ? ` — ${err.hint}` : ''}`);
    }
  });

  // ---------- admin: tickets, scans, reports ----------

  router.get('/api/admin/events/:id/tickets', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const q = new URL(req.url, 'http://x').searchParams;
    json(res, 200, { tickets: tickets.searchTickets(db, e.id, q.get('q'), { limit: q.get('limit'), status: q.get('status'), sourceId: q.get('source') }) });
  });

  router.post('/api/admin/events/:id/lookup', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const body = await readJson(req);
    const found = tickets.findByCode(db, e.id, body.code);
    json(res, 200, { keys: found.keys, matchedKey: found.key || null, tickets: found.rows.map(tickets.publicTicket) });
  });

  // Admit from the admin's ticket list (a guest at the door the promoter checks in by hand).
  router.post('/api/admin/events/:id/admit', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const body = await readJson(req);
    const ticketId = Number(body.ticketId);
    if (!Number.isInteger(ticketId) || ticketId <= 0) throw new HttpError(400, 'Which ticket?');
    if (!db.get('SELECT 1 AS x FROM tickets WHERE id = ? AND event_id = ?', ticketId, e.id)) throw new HttpError(404, 'Ticket not found');
    json(res, 200, tickets.scan(db, e.id, { ticketId, device: { id: null, name: 'Admin' }, method: 'search' }));
  });

  router.post('/api/admin/tickets/:id/undo', async (req, res, p) => {
    requireAdmin(req);
    const t = db.get('SELECT event_id FROM tickets WHERE id = ?', Number(p.id));
    if (!t) throw new HttpError(404, 'Ticket not found');
    json(res, 200, tickets.undoScan(db, t.event_id, Number(p.id), { name: 'Admin' }));
  });

  router.get('/api/admin/events/:id/scans', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(Number(q.get('limit')) || 100, 1000);
    const rows = db.all(
      `SELECT s.id, s.result, s.method, s.device_name, s.scanned_at, s.received_at, s.offline, s.code_raw, s.note,
              t.holder_name, t.ticket_type, t.platform
         FROM scans s LEFT JOIN tickets t ON t.id = s.ticket_id
        WHERE s.event_id = ? ORDER BY s.id DESC LIMIT ?`, e.id, limit);
    json(res, 200, { scans: rows });
  });

  router.get('/api/admin/events/:id/export/tickets.csv', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const rows = db.all(
      `SELECT t.platform, s.label AS source, t.code, t.holder_name, t.holder_email, t.ticket_type, t.status, t.void_reason,
              t.scanned_at, t.scanned_by, t.scan_count, t.flag
         FROM tickets t JOIN sources s ON s.id = t.source_id WHERE t.event_id = ? ORDER BY t.platform, t.holder_name`, e.id);
    csvDownload(res, `${e.name}-tickets.csv`, toCsv(
      ['platform', 'source', 'code', 'name', 'email', 'ticket_type', 'status', 'void_reason', 'scanned_at', 'scanned_by', 'scan_count', 'flag'],
      // DICE's token terms say not to download personal information, so DICE holders stay out of downloads.
      rows.map((r) => [r.platform, r.source, r.code, r.platform === 'dice' ? '' : r.holder_name, r.platform === 'dice' ? '' : r.holder_email, r.ticket_type, r.status, r.void_reason, r.scanned_at, r.scanned_by, r.scan_count, r.flag]),
    ));
  });

  router.get('/api/admin/events/:id/export/scans.csv', async (req, res, p) => {
    requireAdmin(req);
    const e = getEvent(p.id);
    const rows = db.all(
      `SELECT s.scanned_at, s.received_at, s.result, s.method, s.device_name, s.offline, s.code_raw, s.note, t.platform, t.holder_name, t.ticket_type
         FROM scans s LEFT JOIN tickets t ON t.id = s.ticket_id WHERE s.event_id = ? ORDER BY s.id`, e.id);
    csvDownload(res, `${e.name}-scans.csv`, toCsv(
      ['scanned_at', 'received_at', 'result', 'method', 'device', 'offline', 'scanned_value', 'note', 'platform', 'name', 'ticket_type'],
      rows.map((r) => [r.scanned_at, r.received_at, r.result, r.method, r.device_name, r.offline ? 'yes' : '', r.code_raw, r.note, r.platform, r.platform === 'dice' ? '' : r.holder_name, r.ticket_type]),
    ));
  });

  // ---------- door app ----------

  // Door staff only need tonight's and upcoming events: hide ones that started more than 16 hours ago.
  function doorEvents() {
    const cutoff = new Date(Date.now() - 16 * 3600e3).toISOString();
    return db.all(
      `SELECT id, name, venue, starts_at, door_pin_hash, door_pin_enc FROM events
        WHERE archived = 0 AND door_pin_hash IS NOT NULL AND (starts_at IS NULL OR starts_at >= ?)
        ORDER BY starts_at IS NULL, starts_at ASC LIMIT 50`, cutoff);
  }

  function storedPin(e) {
    if (!e.door_pin_enc) return null;
    try { return String(crypto.decryptJson(e.door_pin_enc).pin || '') || null; } catch (_) { return null; }
  }

  function pinMatches(e, pin) {
    const plain = storedPin(e);
    return plain ? safeEqual(plain, pin) : verifyPin(pin, e.door_pin_hash);
  }

  router.get('/api/door/events', async (req, res) => {
    const rows = doorEvents();
    // How many digits to wait for before trying the PIN. Only the lengths, never which event has which.
    const lengths = new Set(rows.map((r) => (storedPin(r) || '').length).filter((n) => n >= 4));
    json(res, 200, {
      events: rows.map((r) => ({ id: r.id, name: r.name, venue: r.venue || null, startsAt: r.starts_at })),
      pinLengths: lengths.size ? [...lengths].sort((a, b) => a - b) : [4],
    });
  });

  // PIN first: the door PIN alone finds tonight's event(s). Sign-in itself still goes through /api/door/login.
  router.post('/api/door/unlock', async (req, res) => {
    const body = await readJson(req);
    const pin = str(body.pin, 32);
    const ipKey = `${clientIp(req)}|unlock`;
    if (pinLimiter.blocked(ipKey)) throw new HttpError(429, 'Too many wrong PINs. Wait 5 minutes.');
    if (unlockLimiter.blocked('all')) throw new HttpError(429, 'Too many wrong PINs. Wait 15 minutes.');
    const matched = /^\d{4,12}$/.test(pin) ? doorEvents().filter((e) => pinMatches(e, pin)) : [];
    if (!matched.length) {
      pinLimiter.fail(ipKey);
      unlockLimiter.fail('all');
      throw new HttpError(401, 'Wrong PIN');
    }
    json(res, 200, {
      events: matched.map((e) => {
        const st = tickets.stats(db, e.id);
        const platforms = db.get('SELECT COUNT(DISTINCT platform) AS n FROM sources WHERE event_id = ? AND removed = 0', e.id).n;
        return { id: e.id, name: e.name, venue: e.venue || null, startsAt: e.starts_at, tickets: st.valid, platforms };
      }),
    });
  });

  router.post('/api/door/login', async (req, res) => {
    const body = await readJson(req);
    const eventId = str(body.eventId, 40);
    const ipKey = `${clientIp(req)}|${eventId}`;
    if (pinLimiter.blocked(ipKey)) throw new HttpError(429, 'Too many wrong PINs. Wait 5 minutes.');
    if (eventPinLimiter.blocked(eventId)) throw new HttpError(429, 'Too many wrong PINs for this event. Wait 15 minutes.');
    const e = db.get('SELECT * FROM events WHERE id = ? AND archived = 0', eventId);
    if (!e || !verifyPin(str(body.pin, 32), e.door_pin_hash)) {
      pinLimiter.fail(ipKey);
      eventPinLimiter.fail(eventId);
      throw new HttpError(401, 'Wrong PIN');
    }
    const name = str(body.deviceName, 40) || 'Door';
    const token = randomToken(32);
    const id = shortId(10);
    db.run('INSERT INTO devices (id, event_id, name, token_hash, created_at, last_seen_at) VALUES (?,?,?,?,?,?)', id, e.id, name, sha256(token), nowIso(), nowIso());
    json(res, 200, { token, event: { id: e.id, name: e.name, venue: e.venue || null, startsAt: e.starts_at }, device: { id, name } });
  });

  router.get('/api/door/me', async (req, res) => {
    const d = requireDevice(req);
    const st = tickets.stats(db, d.event_id);
    json(res, 200, { event: { id: d.event_id, name: d.event_name, venue: d.event_venue || null, startsAt: d.starts_at }, device: { id: d.id, name: d.name }, stats: { valid: st.valid, scanned: st.scanned } });
  });

  router.get('/api/door/tickets', async (req, res) => {
    const d = requireDevice(req);
    const q = new URL(req.url, 'http://x').searchParams;
    const out = tickets.changesSince(db, d.event_id, Number(q.get('rev')) || 0, Number(q.get('id')) || 0, 2000);
    const st = tickets.stats(db, d.event_id);
    json(res, 200, { ...out, stats: { valid: st.valid, scanned: st.scanned }, serverTime: nowIso() });
  });

  function scanInput(d, body, offline) {
    return {
      raw: body.code !== undefined && body.code !== null ? String(body.code).slice(0, 2000) : null,
      ticketId: body.ticketId ? Number(body.ticketId) : null,
      device: { id: d.id, name: d.name },
      clientScanId: body.clientScanId ? str(body.clientScanId, 80) : null,
      scannedAt: body.scannedAt,
      offline,
      method: ['camera', 'manual', 'search', 'scanner'].includes(body.method) ? body.method : 'camera',
      localResult: body.localResult || null,
    };
  }

  router.post('/api/door/scan', async (req, res) => {
    const d = requireDevice(req);
    const body = await readJson(req);
    if (body.code === undefined && !body.ticketId) throw new HttpError(400, 'Nothing to scan');
    const out = tickets.scan(db, d.event_id, scanInput(d, body, false));
    // NOT FOUND can be a ticket created a minute ago (DICE activation, Shotgun transfer): look again now.
    if (out.result === 'not_found' && syncer.recheck(d.event_id)) out.rechecking = true;
    json(res, 200, out);
  });

  router.post('/api/door/scans', async (req, res) => {
    const d = requireDevice(req);
    const body = await readJson(req, 5 * 1024 * 1024);
    const list = Array.isArray(body.scans) ? body.scans.slice(0, 1000) : [];
    const results = list.map((s) => ({ clientScanId: s.clientScanId, ...tickets.scan(db, d.event_id, scanInput(d, s, true)) }));
    if (results.some((r) => r.result === 'not_found')) syncer.recheck(d.event_id);
    json(res, 200, { results });
  });

  router.post('/api/door/undo', async (req, res) => {
    const d = requireDevice(req);
    const body = await readJson(req);
    json(res, 200, tickets.undoScan(db, d.event_id, Number(body.ticketId), { id: d.id, name: d.name }));
  });

  // ---------- webhooks ----------

  router.post('/hooks/:id/:secret', async (req, res, p) => {
    const s = db.get("SELECT * FROM sources WHERE id = ? AND removed = 0 AND kind = 'webhook'", p.id);
    if (!s || !s.webhook_secret || !safeEqual(p.secret, s.webhook_secret)) throw new HttpError(404, 'Not found');
    const buf = await readBody(req, 1024 * 1024);
    let payload;
    const text = buf.toString('utf8');
    try { payload = JSON.parse(text); } catch (_) {
      payload = Object.fromEntries(new URLSearchParams(text));
    }
    const out = syncer.receiveWebhook(s, payload);
    json(res, 200, { ok: true, applied: out.applied });
  });

  router.get('/healthz', async (req, res) => json(res, 200, { ok: true }));

  // ---------- server ----------

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const m = router.match(req.method, url.pathname);
    try {
      if (m && m.handler) return await m.handler(req, res, m.params);
      if (m && m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/') && serveStatic(req, res, config.publicDir, url.pathname)) return undefined;
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (res.headersSent) { res.destroy(); return undefined; }
      if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...(err.extra || {}) });
      if (log && log.error) log.error('[http]', req.method, url.pathname, err);
      return json(res, 500, { error: 'Something went wrong on the server' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120e3;
  return { server, syncer, handle };
}

module.exports = { createApp };
