'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const escaped = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, `Upload too large (max ${Math.round(limitBytes / 1024 / 1024)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limitBytes = 1024 * 1024) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

// Text over ~1 KB goes out gzipped when the browser accepts it: door phones on venue Wi-Fi load and sync faster.
const GZIP_MIN = 1024;
function acceptsGzip(req) { return !!req && /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }

function json(res, status, obj, headers = {}) {
  let body = JSON.stringify(obj);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
  if (Buffer.byteLength(body) > GZIP_MIN && acceptsGzip(res.req)) {
    body = zlib.gzipSync(body, { level: 5 });
    h['Content-Encoding'] = 'gzip';
    h.Vary = 'Accept-Encoding';
  }
  send(res, status, body, h);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, publicDir, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  const type = TYPES[ext] || 'application/octet-stream';
  const text = /^(text\/|application\/(json|manifest\+json)|image\/svg)/.test(type);
  const gz = text && stat.size > GZIP_MIN && acceptsGzip(req);
  // The gzipped copy is a different representation, so it gets its own ETag.
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}${gz ? '-gz' : ''}"`;
  // App shell must revalidate so door phones pick up new versions; the service worker caches for offline.
  const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
  if (text) headers.Vary = 'Accept-Encoding';
  if (gz) headers['Content-Encoding'] = 'gzip';
  if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) { send(res, 304, undefined, headers); return true; }
  if (req.method === 'HEAD') { send(res, 200, undefined, headers); return true; }
  send(res, 200, gz ? gzipped(file, etag) : fs.readFileSync(file), headers);
  return true;
}

// Static files are compressed once per version and kept in memory (the app ships a handful of small files).
const gzCache = new Map();
function gzipped(file, etag) {
  const hit = gzCache.get(file);
  if (hit && hit.etag === etag) return hit.buf;
  const buf = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
  gzCache.set(file, { etag, buf });
  return buf;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Fixed-window counter of failed attempts, in memory (one server). Only failures count, so a crew of door
 * phones signing in from the same venue Wi-Fi never trips it.
 */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  function entry(key) {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return h;
  }
  return {
    blocked: (key) => entry(key).count >= max,
    fail: (key) => { entry(key).count++; },
  };
}

module.exports = { Router, HttpError, readBody, readJson, send, json, serveStatic, parseCookies, rateLimiter };
