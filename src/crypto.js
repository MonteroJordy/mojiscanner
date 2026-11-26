'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** Loads APP_SECRET from env, or creates one in the data dir on first run so encrypted settings survive restarts. */
function loadAppSecret(config) {
  if (config.appSecret) return config.appSecret;
  const file = path.join(config.dataDir, 'app-secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (_) { /* first run */ }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

function createCrypto(appSecret) {
  const encKey = crypto.createHash('sha256').update(`${appSecret}:enc:v1`).digest();
  const macKey = crypto.createHash('sha256').update(`${appSecret}:mac:v1`).digest();

  function encryptJson(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(obj ?? {}), 'utf8'), cipher.final()]);
    return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }

  function decryptJson(str) {
    if (!str) return {};
    if (!str.startsWith('v1.')) throw new Error('Unknown secret format');
    const buf = Buffer.from(str.slice(3), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  }

  function mac(value) {
    return crypto.createHmac('sha256', macKey).update(String(value)).digest('base64url');
  }

  /** Signed, expiring value: payload.expiry.signature */
  function sign(payload, ttlSeconds) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = `${Buffer.from(String(payload)).toString('base64url')}.${exp}`;
    return `${body}.${mac(body)}`;
  }

  function unsign(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const body = `${parts[0]}.${parts[1]}`;
    if (!safeEqual(mac(body), parts[2])) return null;
    if (Number(parts[1]) < Math.floor(Date.now() / 1000)) return null;
    return Buffer.from(parts[0], 'base64url').toString('utf8');
  }

  return { encryptJson, decryptJson, mac, sign, unsign };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [kind, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltB64, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function shortId(len = 10) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = { loadAppSecret, createCrypto, safeEqual, hashPin, verifyPin, randomToken, sha256, shortId };
