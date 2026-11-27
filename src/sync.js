'use strict';

const shotgun = require('./connectors/shotgun');
const dice = require('./connectors/dice');
const eventbrite = require('./connectors/eventbrite');
const webhook = require('./connectors/webhook');
const { applyRows } = require('./tickets');
const { codeKey } = require('../public/js/codes.js');

/**
 * kinds: how tickets get in.
 *   api     – pulled on a schedule (Shotgun, DICE, Eventbrite)
 *   webhook – pushed by the platform (Posh, or anything that can POST JSON)
 *   file    – CSV export uploaded in the admin (RA, Bucket Listers, any platform)
 */
const PLATFORMS = {
  shotgun: { name: 'Shotgun', kinds: ['api', 'file'], minIntervalSec: 60 },
  dice: { name: 'DICE', kinds: ['api', 'file'], minIntervalSec: 120 },
  ra: { name: 'RA', kinds: ['file'] },
  bucketlisters: { name: 'Bucket Listers', kinds: ['file'] },
  eventbrite: { name: 'Eventbrite', kinds: ['api', 'file'], minIntervalSec: 120 },
  posh: { name: 'Posh', kinds: ['webhook', 'file'] },
  other: { name: 'Other', kinds: ['file', 'webhook'] },
};

const CONNECTORS = { shotgun, dice, eventbrite };

function summarize(stats) {
  const parts = [];
  if (stats.added) parts.push(`${stats.added} added`);
  if (stats.updated) parts.push(`${stats.updated} updated`);
  if (stats.voided) parts.push(`${stats.voided} voided`);
  if (stats.voidSkipped) parts.push(`${stats.voidSkipped} would be voided – held back as a safety check, run a forced sync if that's right`);
  if (stats.sharedWithOtherSources) parts.push(`${stats.sharedWithOtherSources} codes also exist in another source`);
  if (stats.scannedThenVoided) parts.push(`${stats.scannedThenVoided} were already scanned before being voided`);
  return parts.length ? ` (${parts.join(', ')})` : ' (no changes)';
}

// Platforms sometimes echo what they were sent back in an error (DICE repeats a bad event ID, which can be a
// pasted token). Mask anything token-shaped before it is stored or shown.
function maskSecrets(text) {
  return String(text || '').replace(/[A-Za-z0-9_\-]{24,}/g, (m) => `[hidden ••••${m.slice(-4)}]`);
}

// One plain sentence that says what went wrong and what to do, ahead of the technical detail.
function plainLead(platform, err) {
  const name = (PLATFORMS[platform] || {}).name || platform;
  const msg = String(err && err.message || '');
  if (err && (err.status === 401 || err.status === 403)) return `${name} rejected the token. Paste a fresh one in Settings.`;
  if (platform === 'dice' && /could not decode id|eventId/i.test(msg)) return 'DICE didn\'t recognize the event ID. Open Settings and pick the event with Load my DICE events.';
  if (/network error/i.test(msg)) return `Couldn't reach ${name}. It tries again automatically.`;
  return '';
}

function isLive(startsAt, now) {
  if (!startsAt) return true;
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return true;
  return now >= t - 36 * 3600e3 && now <= t + 12 * 3600e3;
}

function createSyncer({ db, crypto, config, fetchImpl = globalThis.fetch, log = console, pageDelayMs }) {
  const running = new Set();
  let timer = null;
  let ticking = false;

  const baseUrl = (platform) => ({ shotgun: config.shotgunBaseUrl, dice: config.diceGraphqlUrl, eventbrite: config.eventbriteBaseUrl })[platform];

  async function runSource(sourceId, { force = false, full = false } = {}) {
    if (running.has(sourceId)) return { ok: false, message: 'A sync is already running for this source' };
    const source = db.get('SELECT * FROM sources WHERE id = ? AND removed = 0', sourceId);
    if (!source) return { ok: false, message: 'Source not found' };
    if (source.kind !== 'api') return { ok: false, message: 'This source is not pulled from an API' };
    const connector = CONNECTORS[source.platform];
    if (!connector) return { ok: false, message: `No API connector for ${source.platform}` };
    running.add(sourceId);
    const startedAt = new Date().toISOString();
    try {
      const cfg = crypto.decryptJson(source.config_enc);
      const out = await connector.sync({
        config: cfg,
        cursor: full ? null : source.cursor,
        fetchImpl,
        baseUrl: baseUrl(source.platform),
        ...(pageDelayMs !== undefined ? { pageDelayMs } : {}),
      });
      const stats = applyRows(db, source, out.rows, {
        mode: out.mode,
        keepExtIds: out.keepExtIds || [],
        maxVoidRatio: force ? null : 0.3,
        reason: `No longer on ${PLATFORMS[source.platform].name} (refunded, returned or transferred)`,
      });
      const message = `${out.message}${summarize(stats)}`;
      db.run('UPDATE sources SET last_sync_at = ?, last_sync_ok = 1, last_sync_message = ?, cursor = ? WHERE id = ?',
        startedAt, message.slice(0, 1000), out.cursor !== undefined ? out.cursor : source.cursor, sourceId);
      return { ok: true, message, stats };
    } catch (err) {
      const lead = plainLead(source.platform, err);
      const detail = maskSecrets(`${err.message}${err.hint ? ` — ${err.hint}` : ''}`);
      const message = lead ? `${lead}\n${detail}` : detail;
      db.run('UPDATE sources SET last_sync_at = ?, last_sync_ok = 0, last_sync_message = ? WHERE id = ?', startedAt, message.slice(0, 1000), sourceId);
      if (log && log.warn) log.warn(`[sync] ${source.platform} ${sourceId}: ${message}`);
      return { ok: false, message };
    } finally {
      running.delete(sourceId);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const due = db.all(
        `SELECT s.id, s.platform, s.last_sync_at, e.starts_at FROM sources s JOIN events e ON e.id = s.event_id
          WHERE s.kind = 'api' AND s.removed = 0 AND e.archived = 0`,
      ).filter((s) => {
        const interval = Math.max(isLive(s.starts_at, now) ? config.liveSyncSec : config.idleSyncSec, PLATFORMS[s.platform].minIntervalSec || 60);
        const last = s.last_sync_at ? Date.parse(s.last_sync_at) : 0;
        return now - last >= interval * 1000;
      });
      for (const s of due) await runSource(s.id); // one at a time keeps us well inside every platform's rate limits
    } catch (err) {
      if (log && log.error) log.error('[sync] scheduler error', err);
    } finally {
      ticking = false;
    }
  }

  // A code the list has never seen may only be a minute old: DICE creates the QR when the fan activates the
  // ticket in the app, and Shotgun issues a new QR when a ticket is transferred. So when the door gets NOT FOUND,
  // pull the event's API sources again right away instead of waiting for the schedule (at most every 15 to 30s).
  const lastRecheck = new Map();
  const RECHECK_MIN_MS = { shotgun: 15000, dice: 30000, eventbrite: 30000 };
  function recheck(eventId) {
    const now = Date.now();
    let pending = false;
    for (const s of db.all("SELECT id, platform FROM sources WHERE event_id = ? AND kind = 'api' AND removed = 0", eventId)) {
      if (running.has(s.id)) { pending = true; continue; }
      if (now - (lastRecheck.get(s.id) || 0) < (RECHECK_MIN_MS[s.platform] || 30000)) continue;
      lastRecheck.set(s.id, now);
      pending = true;
      runSource(s.id).catch(() => {});
    }
    return pending;
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, 15000);
    timer.unref();
    setTimeout(tick, 2000).unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Stores a webhook payload and, if the fields are mapped, applies it. */
  function receiveWebhook(source, payload) {
    const cfg = crypto.decryptJson(source.config_enc);
    const text = JSON.stringify(payload);
    const info = db.run('INSERT INTO webhook_log (source_id, received_at, payload, result) VALUES (?,?,?,?)',
      source.id, new Date().toISOString(), text.length > 256 * 1024 ? text.slice(0, 256 * 1024) : text, 'stored');
    const logId = Number(info.lastInsertRowid);
    if (!cfg.mapping || !cfg.mapping.code) {
      db.run('UPDATE sources SET last_sync_at = ?, last_sync_ok = 1, last_sync_message = ? WHERE id = ?',
        new Date().toISOString(), 'Webhook received. Map the fields in the admin to start importing.', source.id);
      return { stored: true, applied: false };
    }
    const { rows } = webhook.extractRows(payload, cfg.mapping);
    const stats = applyRows(db, source, rows, { mode: 'merge' });
    const msg = rows.length ? `Webhook: ${rows.length} tickets${summarize(stats)}` : 'Webhook: no ticket codes found with the current field mapping';
    db.run('UPDATE webhook_log SET result = ? WHERE id = ?', msg, logId);
    db.run('UPDATE sources SET last_sync_at = ?, last_sync_ok = ?, last_sync_message = ? WHERE id = ?', new Date().toISOString(), rows.length ? 1 : 0, msg, source.id);
    return { stored: true, applied: true, stats };
  }

  /** Re-applies every stored payload (after the field mapping changes). */
  function reprocessWebhooks(sourceId) {
    const source = db.get('SELECT * FROM sources WHERE id = ?', sourceId);
    const cfg = crypto.decryptJson(source.config_enc);
    if (!cfg.mapping || !cfg.mapping.code) return { ok: false, message: 'Map the QR code field first' };
    const logs = db.all('SELECT id, payload FROM webhook_log WHERE source_id = ? ORDER BY id', sourceId);
    let rows = [];
    for (const l of logs) {
      try { rows = rows.concat(webhook.extractRows(JSON.parse(l.payload), cfg.mapping).rows); } catch (_) { /* truncated payload */ }
    }
    // Later webhooks win: keep the last row for each code.
    const byCode = new Map();
    for (const r of rows) byCode.set(codeKey(r.code), r);
    const stats = applyRows(db, source, [...byCode.values()], { mode: 'merge' });
    const message = `Re-ran ${logs.length} stored webhooks: ${byCode.size} tickets${summarize(stats)}`;
    db.run('UPDATE sources SET last_sync_at = ?, last_sync_ok = 1, last_sync_message = ? WHERE id = ?', new Date().toISOString(), message, sourceId);
    return { ok: true, message, stats };
  }

  return { runSource, tick, start, stop, receiveWebhook, reprocessWebhooks, recheck, isRunning: (id) => running.has(id) };
}

module.exports = { createSyncer, PLATFORMS, summarize, isLive, maskSecrets, plainLead };
