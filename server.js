'use strict';

const path = require('node:path');
const { load } = require('./src/config');
const { openDb } = require('./src/db');
const { loadAppSecret, createCrypto } = require('./src/crypto');
const { createApp } = require('./src/app');

const config = load();

if (!config.adminPassword || config.adminPassword.length < 8) {
  console.error('Set ADMIN_PASSWORD (at least 8 characters) before starting, e.g.\n  ADMIN_PASSWORD="something-long" npm start');
  process.exit(1);
}

const db = openDb(path.join(config.dataDir, 'door.db'));
const crypto = createCrypto(loadAppSecret(config));
const { server, syncer } = createApp({ config, db, crypto });

server.listen(config.port, config.host, () => {
  console.log(`Door scanner running on http://localhost:${config.port}`);
  console.log(`  Door app:  http://localhost:${config.port}/`);
  console.log(`  Admin:     http://localhost:${config.port}/admin`);
  console.log(`  Data:      ${config.dataDir}`);
});

if (config.schedulerEnabled) syncer.start();

function shutdown() {
  syncer.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
