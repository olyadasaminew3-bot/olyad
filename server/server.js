'use strict';
/**
 * HTTP server: static assets + JSON API + SSE change stream.
 * No external dependencies — `node server/server.js` is the whole install.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const db = require('./db');
const api = require('./api');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/* ------------------------------------------------------------- utilities */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  }, headers));
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new api.HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new api.HttpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function matchRoute(method, pathname) {
  for (const r of api.routes) {
    if (r.method !== method) continue;
    if (!r.path.includes(':')) {
      if (r.path === pathname) return { route: r, params: {} };
      continue;
    }
    const rSeg = r.path.split('/');
    const pSeg = pathname.split('/');
    if (rSeg.length !== pSeg.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rSeg.length; i++) {
      const a = rSeg[i];
      const b = pSeg[i];
      if (a.startsWith(':')) {
        if (!b) { ok = false; break; }
        params[a.slice(1)] = decodeURIComponent(b);
      } else if (a !== b) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

/* --------------------------------------------------------------- throttle */

const hits = new Map(); // ip -> number[] (timestamps)
function throttled(ip, limit = 20, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 4000) hits.clear();
  return arr.length > limit;
}

/* ----------------------------------------------------------------- static */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      // friendly 404 with a way back to the app
      return send(
        res,
        404,
        `<!doctype html><meta charset="utf-8"><title>404 — Not found</title>
         <body style="font:16px/1.5 system-ui;padding:48px;max-width:40rem;margin:auto">
         <h1 style="margin:0 0 .5rem">404 — not found</h1>
         <p style="color:#555">${rel.replace(/[<>]/g, '')} does not exist on this server.</p>
         <p><a href="/">Dine-in home</a> · <a href="/staff.html">Staff sign-in</a> · <a href="/admin.html">Admin</a></p>`,
        { 'Content-Type': 'text/html; charset=utf-8' }
      );
    }
    const ext = path.extname(full).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    return send(res, 204, '', {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
    });
  }

  const found = matchRoute(req.method, pathname);
  if (!found) {
    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: `No API route for ${req.method} ${pathname}` });
    return serveStatic(req, res, pathname);
  }

  const { route, params } = found;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';

  try {
    if (route.opts.throttle && throttled(ip)) {
      throw new api.HttpError(429, 'Too many orders from this device — please wait a minute.');
    }
    const staff = api.sessionFrom(req);
    if ((route.opts.auth || route.opts.roles) && !staff) {
      throw new api.HttpError(401, 'Please sign in with a staff PIN.');
    }
    if (route.opts.roles) {
      if (!route.opts.roles.includes(staff.role)) {
        throw new api.HttpError(403, `Your role (${staff.role}) cannot do that — ask a ${route.opts.roles[0]}.`);
      }
    }
    let body = {};
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) body = await readBody(req);

    const result = await route.handler({
      req,
      res,
      params,
      query: new URLSearchParams(parsed.query || {}),
      body,
      staff,
      ip
    });

    if (result && result.__handled) return;             // SSE took over the socket
    if (result && result.__svg) {
      return send(res, 200, result.__svg, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (result && result.__html) {
      return send(res, 200, result.__html, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', req.method, pathname, err);
    return sendJson(res, status, { error: err.message || 'Server error' });
  }
});

db.load();

server.listen(PORT, HOST, () => {
  const s = db.settings;
  console.log(`\n  🍽  ${s.hotelName} — ${s.restaurantName}`);
  console.log(`  Dine-in QR system listening on http://${HOST}:${PORT}`);
  console.log(`  Staff sign-in: /staff.html   (manager PIN 9999 · cashier 1111 · chef 2222 · waiter 3333)`);
  console.log(`  Data file: ${path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json')}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — saving data and shutting down`);
    db.persistNow();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
