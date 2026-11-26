'use strict';

const path = require('node:path');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
  const n = Number(env(name, fallback));
  return Number.isFinite(n) ? n : fallback;
}

function load() {
  return {
    port: num('PORT', 3000),
    host: env('HOST', '0.0.0.0'),
    dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),
    adminPassword: env('ADMIN_PASSWORD', ''),
    appSecret: env('APP_SECRET', ''),
    // How often API sources (Shotgun, DICE, Eventbrite) are pulled while an event is "live"
    // (from 36h before start to 12h after). Outside that window they are pulled every idleSyncSec.
    liveSyncSec: num('SYNC_INTERVAL_SECONDS', 60),
    idleSyncSec: num('IDLE_SYNC_INTERVAL_SECONDS', 1800),
    schedulerEnabled: env('SCHEDULER', '1') !== '0',
    // Behind Railway/Render/Fly/Cloudflare the client IP and protocol come from proxy headers.
    trustProxy: env('TRUST_PROXY', '1') === '1',
    secureCookies: env('SECURE_COOKIES', 'auto'), // auto | 1 | 0
    shotgunBaseUrl: env('SHOTGUN_API_URL', 'https://api.shotgun.live'),
    diceGraphqlUrl: env('DICE_API_URL', 'https://partners-endpoint.dice.fm/graphql'),
    eventbriteBaseUrl: env('EVENTBRITE_API_URL', 'https://www.eventbriteapi.com/v3'),
    publicDir: path.join(__dirname, '..', 'public'),
  };
}

module.exports = { load };
