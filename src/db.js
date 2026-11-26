'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    starts_at TEXT,
    door_pin_hash TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL,              -- api | webhook | file
    config_enc TEXT,                 -- encrypted JSON: tokens, ids, field mapping
    cursor TEXT,                     -- incremental sync position (Shotgun)
    webhook_secret TEXT,
    last_sync_at TEXT,
    last_sync_ok INTEGER,
    last_sync_message TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sources_event ON sources(event_id);

  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    ext_id TEXT,
    code TEXT NOT NULL,
    code_key TEXT NOT NULL,
    holder_name TEXT,
    holder_email TEXT,
    ticket_type TEXT,
    status TEXT NOT NULL DEFAULT 'valid',     -- valid | void
    void_reason TEXT,
    source_status TEXT,
    scanned_at TEXT,
    scanned_by TEXT,
    scan_count INTEGER NOT NULL DEFAULT 0,
    flag TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rev INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX tickets_source_key ON tickets(source_id, code_key);
  CREATE INDEX tickets_event_key ON tickets(event_id, code_key);
  CREATE INDEX tickets_event_rev ON tickets(event_id, rev, id);
  CREATE INDEX tickets_source_ext ON tickets(source_id, ext_id);

  CREATE TABLE scans (
    id INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL,
    ticket_id INTEGER,
    code_raw TEXT,
    result TEXT NOT NULL,           -- admitted | duplicate | void | not_found | undo
    method TEXT NOT NULL,           -- camera | manual | search | sync
    device_id TEXT,
    device_name TEXT,
    scanned_at TEXT NOT NULL,       -- device clock
    received_at TEXT NOT NULL,      -- server clock
    offline INTEGER NOT NULL DEFAULT 0,
    client_scan_id TEXT UNIQUE,
    note TEXT
  );
  CREATE INDEX scans_event ON scans(event_id, id);

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  );

  CREATE TABLE webhook_log (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    result TEXT
  );
  CREATE INDEX webhook_log_source ON webhook_log(source_id, id);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta (key, value) VALUES ('rev', '0');
  `,
  // 2: venue, and the door PIN kept encrypted so the admin can show it (the hash still does the checking)
  `
  ALTER TABLE events ADD COLUMN venue TEXT;
  ALTER TABLE events ADD COLUMN door_pin_enc TEXT;
  `,
];

function openDb(fileOrMemory) {
  if (fileOrMemory !== ':memory:') fs.mkdirSync(path.dirname(fileOrMemory), { recursive: true });
  const db = new DatabaseSync(fileOrMemory);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (fileOrMemory !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function wrap(db) {
  const cache = new Map();
  let depth = 0;

  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  }

  const api = {
    raw: db,
    get: (sql, ...params) => plain(stmt(sql).get(...params)),
    all: (sql, ...params) => stmt(sql).all(...params).map(plain),
    run: (sql, ...params) => stmt(sql).run(...params),
    exec: (sql) => db.exec(sql),
    /** Runs fn inside one transaction (nested calls join the outer one). */
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
        throw err;
      } finally {
        depth--;
      }
    },
    /** Every change to tickets gets a revision number so door devices can pull "what changed since rev N". */
    nextRev() {
      const row = stmt("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value").get();
      return Number(row.value);
    },
    close: () => db.close(),
  };
  return api;
}

function plain(row) {
  if (!row) return row;
  return Object.assign({}, row);
}

module.exports = { openDb };
