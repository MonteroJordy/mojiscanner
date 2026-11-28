'use strict';

// "Is everything running?" in plain words. Each check says what's wrong, and what to do about it,
// for the server itself and for every event that is on tonight.

const fs = require('node:fs');
const path = require('node:path');
const tickets = require('./tickets');
const { PLATFORMS } = require('./sync');

const MIN = 60e3;
const HOUR = 3600e3;

const RAILWAY_RESTART = 'In Railway open mojiscanner → Deployments → the active deployment → ⋮ → Restart. Door phones keep scanning offline while it restarts (about a minute).';

function ago(ms) {
  if (ms < MIN) return 'just now';
  const m = Math.round(ms / MIN);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  return h + ' h ' + (m % 60 ? (m % 60) + ' min ' : '') + 'ago';
}

function platformName(p) { return (PLATFORMS[p] || {}).name || p; }

// Same rule the admin uses: repeated digits, runs, years, straight down the keypad.
function weakPin(p) {
  p = String(p || '');
  if (!/^\d+$/.test(p)) return false;
  if (/^(\d)\1+$/.test(p) || /^(\d\d)\1+$/.test(p) || /^(19|20)\d\d$/.test(p)) return true;
  return '01234567890123456789'.indexOf(p) !== -1 || '98765432109876543210'.indexOf(p) !== -1 || p === '2580' || p === '0852';
}

function dbCheck(db) {
  try {
    db.get('SELECT 1 AS one');
    // A real write, so a full or read-only disk shows up here and not at the door.
    db.run("UPDATE meta SET value = value WHERE key = 'rev'");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err && err.message || err) };
  }
}

function disk(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { freeMB: Math.round((s.bavail * s.bsize) / 1048576), totalMB: Math.round((s.blocks * s.bsize) / 1048576) };
  } catch (_) {
    return null;
  }
}

function dbSizeMB(dir) {
  let bytes = 0;
  for (const f of ['door.db', 'door.db-wal']) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch (_) { /* not there */ } }
  return Math.round(bytes / 104857.6) / 10;
}

function syncState(syncer, schedulerEnabled, bootedAt, now) {
  if (!schedulerEnabled) return { state: 'off' };
  const h = syncer.health();
  if (h.busySince && now - h.busySince > 5 * MIN) return { state: 'stuck', since: h.busySince };
  if (h.lastTickAt && now - h.lastTickAt < 2 * MIN) return { state: 'ok', lastTickAt: h.lastTickAt };
  if (now - bootedAt < MIN) return { state: 'starting' };
  return { state: 'stalled', lastTickAt: h.lastTickAt };
}

/** Quick and public: can the server serve the door right now? For uptime checks. No names, no numbers. */
function health({ db, syncer, config, bootedAt, now = Date.now() }) {
  const d = dbCheck(db);
  const s = syncState(syncer, config.schedulerEnabled, bootedAt, now);
  const ok = d.ok && s.state !== 'stalled' && s.state !== 'stuck';
  return { ok, db: d.ok ? 'ok' : 'error', sync: s.state, uptimeSec: Math.round((now - bootedAt) / 1000), time: new Date(now).toISOString() };
}

// Where an event is in its night: before doors, doors (half an hour before start until 10 hours after), after.
function phase(startsAt, now) {
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return 'doors';
  if (now < t - 30 * MIN) return 'before';
  if (now <= t + 10 * HOUR) return 'doors';
  return 'after';
}

function sourceFix(platform, message) {
  const name = platformName(platform);
  const m = String(message || '');
  if (/restricted/i.test(m)) return 'DICE has to switch on restricted fields (ticket code) on the Ticket holder API token. Until then, upload DICE\'s barcode export as a file source.';
  if (/token|unauthori[sz]ed|forbidden|401|403|rejected|expired|invalid key|api key/i.test(m)) return 'Open the event, tap the ' + name + ' source → Settings, paste a fresh token and save. Then Sync now.';
  if (/not found|404|event id/i.test(m)) return 'Open the event, tap the ' + name + ' source → Settings and check the event ID.';
  return name + ' isn\'t answering right now. It retries every minute on its own, and door phones keep the list they have. If it lasts more than 15 minutes, upload a CSV export from ' + name + ' as a backup.';
}

/** Everything the admin's Status page shows. */
function status({ db, syncer, config, crypto, bootedAt, now = Date.now() }) {
  const checks = [];
  function add(level, scope, title, detail, fix, href) {
    checks.push({ level, scope, title, detail: detail || null, fix: fix || null, href: href || null });
  }

  // ---- the server
  const d = dbCheck(db);
  if (d.ok) add('ok', 'server', 'Database is answering');
  else add('bad', 'server', 'The database isn\'t answering', d.message, RAILWAY_RESTART);

  const s = syncState(syncer, config.schedulerEnabled, bootedAt, now);
  if (s.state === 'ok' || s.state === 'off') add('ok', 'server', s.state === 'off' ? 'Background sync is switched off' : 'Background sync is running');
  else if (s.state === 'starting') add('ok', 'server', 'Background sync is starting');
  else if (s.state === 'stuck') add('bad', 'server', 'Background sync is stuck', 'One round has been running since ' + new Date(s.since).toISOString() + '.', RAILWAY_RESTART);
  else add('bad', 'server', 'Background sync stopped', s.lastTickAt ? 'It last ran ' + ago(now - s.lastTickAt) + '.' : 'It hasn\'t run since the server started.', RAILWAY_RESTART);

  const up = now - bootedAt;
  if (up < 15 * MIN) add('warn', 'server', 'The server restarted ' + ago(up), 'Normal right after a deploy. If nobody deployed, it crashed and Railway restarted it.', 'If it keeps happening: Railway → mojiscanner → Deployments → View logs, and send me what\'s there.');

  // The trial volume is 500 MB, so go by what's left, not by a fixed size.
  const space = disk(config.dataDir);
  if (space && space.totalMB) {
    const left = space.freeMB / space.totalMB;
    const grow = 'In Railway open mojiscanner-volume → Settings and make the volume bigger (the trial plan caps it; upgrading lifts that).';
    if (space.freeMB < 50 || left < 0.05) add('bad', 'server', 'The data disk is almost full', space.freeMB + ' MB free of ' + space.totalMB + ' MB.', grow);
    else if (space.freeMB < 100 || left < 0.2) add('warn', 'server', 'The data disk is getting full', space.freeMB + ' MB free of ' + space.totalMB + ' MB.', grow);
  }
  const memoryMB = Math.round(process.memoryUsage().rss / 1048576);
  if (memoryMB > 400) add('warn', 'server', 'Memory use is high', memoryMB + ' MB.', 'Restart the service in Railway at a quiet moment between scans. ' + RAILWAY_RESTART.slice(RAILWAY_RESTART.indexOf('Door phones')));

  // ---- tonight's events: started up to 12 hours ago, or starting in the next 36 hours
  const events = db.all(
    `SELECT id, name, venue, starts_at, door_pin_hash, door_pin_enc FROM events
      WHERE archived = 0 AND (starts_at IS NULL OR (starts_at >= ? AND starts_at <= ?)) ORDER BY starts_at`,
    new Date(now - 12 * HOUR).toISOString(), new Date(now + 36 * HOUR).toISOString(),
  );
  const out = events.map((e) => {
    const scope = e.id;
    const href = '#/event/' + e.id;
    const when = phase(e.starts_at, now);
    const st = tickets.stats(db, e.id);
    const sources = db.all('SELECT * FROM sources WHERE event_id = ? AND removed = 0 ORDER BY created_at', e.id);
    const devices = db.all('SELECT name, last_seen_at, revoked FROM devices WHERE event_id = ? AND revoked = 0 ORDER BY created_at', e.id);
    const counts = {};
    (st.bySource || []).forEach((r) => { counts[r.source_id] = r; });

    const rows = sources.map((src) => {
      const name = platformName(src.platform);
      const last = src.last_sync_at ? Date.parse(src.last_sync_at) : null;
      const c = counts[src.id] || { valid: 0 };
      let state = 'ok';
      let line = '';
      if (src.kind === 'api') {
        const every = Math.max(config.liveSyncSec, (PLATFORMS[src.platform] || {}).minIntervalSec || 60) * 1000;
        if (src.last_sync_ok === 0) {
          state = 'bad';
          line = 'Sync failing';
          add('bad', scope, name + ' sync is failing', String(src.last_sync_message || '').split('\n')[0] || null, sourceFix(src.platform, src.last_sync_message), href);
        } else if (src.last_sync_message && /safety check/.test(src.last_sync_message)) {
          state = 'warn';
          line = 'Voids on hold';
          add('warn', scope, name + ': some tickets disappeared, voids are on hold', 'Nothing is voided until you confirm.', 'Check the numbers on ' + name + ', then on the event page tap Apply voids.', href);
        } else if (!last) {
          state = 'warn';
          line = 'Waiting for the first sync';
          add('warn', scope, name + ' hasn\'t synced yet', null, 'Open the event and tap the ' + name + ' source → Sync now.', href);
        } else if (when !== 'after' && now - last > Math.max(3 * every, 6 * MIN)) {
          state = 'warn';
          line = 'Last synced ' + ago(now - last);
          add('warn', scope, name + ' hasn\'t synced for ' + ago(now - last).replace(' ago', ''), null, 'Open the event, tap the ' + name + ' source → Sync now. If it stays stuck, restart the service: ' + RAILWAY_RESTART, href);
        } else {
          line = 'Synced ' + ago(now - last);
        }
      } else if (src.kind === 'file') {
        if (!last) {
          state = 'bad';
          line = 'No file uploaded';
          add('bad', scope, name + ' list isn\'t uploaded', null, 'Open the event, tap the ' + name + ' source → Upload file.', href + '/upload/' + src.id);
        } else if (when !== 'after' && now - last > HOUR) {
          state = 'warn';
          line = 'Uploaded ' + ago(now - last);
          add('warn', scope, name + ' list is ' + ago(now - last).replace(' ago', '') + ' old', 'Refunds and resales since then aren\'t in it.', 'Upload a fresh export from ' + name + ' (event → ' + name + ' → Upload file).', href + '/upload/' + src.id);
        } else {
          line = 'Uploaded ' + ago(now - last);
        }
      } else {
        line = last ? 'Last sale ' + ago(now - last) : 'No sales received yet';
        if (!c.valid) {
          state = 'warn';
          add('warn', scope, 'No sales received from ' + name + ' yet', null, 'Check the webhook is set up on ' + name + ' (event → ' + name + ' → Webhook setup).', href);
        }
      }
      return { platformName: name, label: src.label, kind: src.kind, state, line, valid: c.valid || 0 };
    });

    if (!sources.length) add('bad', scope, 'No ticket sources', 'Door phones have nothing to scan against.', 'Open the event → Add source.', href + '/add');
    else if (!st.valid) add('bad', scope, 'No valid tickets in the list', null, 'Open the event and check each source synced or uploaded.', href);

    // Only whether the PIN is easy to guess leaves here, never the PIN.
    let pinWeak = false;
    if (crypto && e.door_pin_enc) { try { pinWeak = weakPin(crypto.decryptJson(e.door_pin_enc).pin); } catch (_) { pinWeak = false; } }
    if (!e.door_pin_hash) add('bad', scope, 'No door PIN set', 'Door phones can\'t sign in.', 'Door tab → Change PIN.', href + '/door');
    else if (pinWeak && when !== 'after') add('info', scope, 'The door PIN is easy to guess', null, 'Door tab → Change PIN, then Send to staff again. Phones already scanning stay signed in.', href + '/door');

    const seen = devices.map((dv) => ({ name: dv.name, lastSeenAt: dv.last_seen_at, ms: dv.last_seen_at ? now - Date.parse(dv.last_seen_at) : Infinity }));
    const active = seen.filter((dv) => dv.ms < 3 * MIN);
    if (when !== 'after') {
      if (!seen.length && (when === 'doors' || Date.parse(e.starts_at) - now < 3 * HOUR)) {
        add('warn', scope, 'No door phones signed in', null, 'Door tab → Send to staff. Each phone opens the link once with signal, types the PIN and picks its door.', href + '/door');
      }
      if (when === 'doors') {
        // A phone only reports while the door app is open on screen, so a phone locked between guests goes
        // quiet with nothing wrong. That's worth knowing, never an alert. The alert below is for real trouble.
        const quiet = seen.filter((dv) => dv.ms >= 3 * MIN && dv.ms < 6 * HOUR);
        if (quiet.length) {
          add('info', scope,
            (quiet.length === 1 ? '1 signed-in phone is' : quiet.length + ' signed-in phones are') + ' quiet',
            'Last reached the server: ' + quiet.map((dv) => dv.name + ' ' + ago(dv.ms)).join(', ') + '. '
              + (active.length ? (active.length === 1 ? '1 phone is' : active.length + ' phones are') + ' online now. ' : '')
              + 'A phone only reports while the door app is open on screen, so a locked phone goes quiet. If a door loses internet, its scans arrive late and this page says so.',
            'Nothing to do unless a door says it has no internet. A phone that typed the PIN again leaves its old entry behind: sign that entry out in the Door tab.',
            href + '/door');
        }
      }
    }

    // Scans that reached the server late: that door was scanning without internet, so it can't see new orders.
    if (when !== 'after') {
      const late = db.all(
        `SELECT device_name AS name, COUNT(*) AS n, MAX((julianday(received_at) - julianday(scanned_at)) * 1440) AS maxMin
           FROM scans WHERE event_id = ? AND offline = 1 AND received_at >= ? GROUP BY device_name`,
        e.id, new Date(now - 30 * MIN).toISOString());
      late.filter((r) => r.maxMin >= 2).forEach((r) => {
        add('warn', scope, (r.name || 'A door phone') + ' scanned ' + r.n + (r.n === 1 ? ' guest' : ' guests') + ' without internet',
          'Those scans reached the server up to ' + Math.round(r.maxMin) + ' min late. While a phone is offline it can\'t see new orders, so a new buyer shows Not found.',
          'Check that door\'s signal or Wi-Fi. A guest who shows Not found with OFFLINE on the screen: find them in the admin\'s Guests tab and tap Admit.',
          href + '/scans');
      });
    }

    const flags = st.flags || {};
    if (flags.double_entry) add('warn', scope, flags.double_entry + (flags.double_entry === 1 ? ' ticket' : ' tickets') + ' got in twice while a phone was offline', null, 'Guests → Flagged shows who.', href + '/guests');

    if (when === 'doors' && st.valid && Date.parse(e.starts_at) + 45 * MIN < now) {
      const lastScan = st.lastScanAt ? Date.parse(st.lastScanAt) : 0;
      if (!lastScan || now - lastScan > 45 * MIN) add('info', scope, lastScan ? 'No scans for ' + ago(now - lastScan).replace(' ago', '') : 'No scans yet', 'Only a problem if guests are arriving: then check the door phones have signal and the app open.', null, href + '/door');
    }

    return {
      id: e.id,
      name: e.name,
      venue: e.venue || null,
      startsAt: e.starts_at,
      phase: when,
      valid: st.valid,
      checkedIn: st.scanned,
      phones: { signedIn: seen.length, active: active.length, list: seen.map((dv) => ({ name: dv.name, lastSeenAt: dv.lastSeenAt })) },
      sources: rows,
      pinWeak,
    };
  });

  const rank = { bad: 3, warn: 2, info: 1, ok: 0 };
  const worst = checks.reduce((w, c) => (rank[c.level] > rank[w] ? c.level : w), 'ok');
  return {
    now: new Date(now).toISOString(),
    overall: worst === 'info' ? 'ok' : worst,
    version: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    server: {
      bootedAt: new Date(bootedAt).toISOString(),
      uptimeSec: Math.round(up / 1000),
      memoryMB,
      dbMB: dbSizeMB(config.dataDir),
      disk: space,
      sync: s.state,
      syncLastRunAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null,
      node: process.version,
    },
    checks,
    events: out,
  };
}

/** How many checks need someone, for the public health answer: counts only, nothing that names an event. */
function counts(st) {
  return {
    needsYou: st.checks.filter((c) => c.level === 'bad').length,
    toCheck: st.checks.filter((c) => c.level === 'warn').length,
  };
}

module.exports = { health, status, counts, dbCheck };
