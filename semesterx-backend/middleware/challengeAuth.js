'use strict';
/**
 * Minimal single-user protection for the /api/challenge routes ONLY.
 * The academic API (/api/state) is NOT protected by this module.
 *
 * Design (Vercel serverless = no shared memory, so no server-side session store):
 *  - Password comes from SEMESTERX_PASSWORD (never hard-coded, never sent to the browser).
 *  - Comparison: SHA-256 both sides, then crypto.timingSafeEqual.
 *  - Session: stateless HMAC-signed token in an HttpOnly, SameSite=Strict cookie. The signing key is
 *    derived from the password with scrypt, so changing the password invalidates every session.
 *  - Fails closed: if SEMESTERX_PASSWORD is not set, every protected route answers 503.
 *  - Nothing secret is logged.
 */
const crypto = require('crypto');

const COOKIE = 'sx_challenge';
const MAX_AGE_S = 7 * 24 * 3600;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

let cache = null;
const failures = new Map(); // best-effort, per serverless instance only

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function secrets() {
  const pw = process.env.SEMESTERX_PASSWORD;
  if (typeof pw !== 'string' || pw.length === 0) return null;
  if (!cache || cache.pw !== pw) {
    cache = { pw, digest: sha256(pw), key: crypto.scryptSync(pw, 'semesterx-challenge-session-v1', 32) };
  }
  return cache;
}

function sign(payload, key) { return b64u(crypto.createHmac('sha256', key).update(payload).digest()); }

function createToken(key, now = Date.now()) {
  const payload = b64u(JSON.stringify({ v: 1, iat: now, exp: now + MAX_AGE_S * 1000 }));
  return payload + '.' + sign(payload, key);
}

function verifyToken(token, key, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 400) return false;
  const i = token.indexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload, key));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return p && p.v === 1 && typeof p.exp === 'number' && p.exp > now;
  } catch (e) { return false; }
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const secureFlag = () => (process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '');
const cookieHeader = (value, maxAge) => COOKIE + '=' + value + '; Max-Age=' + maxAge + '; Path=/api/challenge; HttpOnly; SameSite=Strict' + secureFlag();

function clientKey(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function throttled(key, now) {
  const list = (failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  failures.set(key, list);
  return list.length >= FAIL_LIMIT;
}

const deny = (res, status, code, message) => res.status(status).json({ success: false, code, message });

/** Blocks cross-site writes. Works together with SameSite=Strict. */
function originGuard(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const h = req.headers || {};
  if (h['sec-fetch-site'] === 'cross-site') return deny(res, 403, 'CROSS_SITE', 'Cross-site requests are not allowed.');
  if (h.origin) {
    let host = '';
    try { host = new URL(h.origin).host; } catch (e) { /* denied below */ }
    if (!host || host !== h.host) return deny(res, 403, 'CROSS_SITE', 'Cross-site requests are not allowed.');
  } else if (!/^application\/json/i.test(h['content-type'] || '')) {
    return deny(res, 415, 'JSON_REQUIRED', 'Requests must be JSON.');
  }
  return next();
}

async function login(req, res) {
  const s = secrets();
  if (!s) return deny(res, 503, 'NOT_CONFIGURED', 'Challenge access is not configured on the server.');
  const now = Date.now();
  const key = clientKey(req);
  if (throttled(key, now)) {
    res.setHeader('Retry-After', String(Math.ceil(FAIL_WINDOW_MS / 1000)));
    return deny(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again later.');
  }
  const pw = req.body && req.body.password;
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 256) return deny(res, 400, 'INVALID', 'A password is required.');
  if (!crypto.timingSafeEqual(sha256(pw), s.digest)) {
    failures.get(key).push(now);
    const delay = Number(process.env.SEMESTERX_LOGIN_DELAY_MS ?? 400);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return deny(res, 401, 'BAD_PASSWORD', 'Incorrect password.');
  }
  failures.delete(key);
  res.setHeader('Set-Cookie', cookieHeader(createToken(s.key, now), MAX_AGE_S));
  return res.status(200).json({ success: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  return res.status(200).json({ success: true });
}

function requireAuth(req, res, next) {
  const s = secrets();
  if (!s) return deny(res, 503, 'NOT_CONFIGURED', 'Challenge access is not configured on the server.');
  const token = parseCookies(req.headers && req.headers.cookie)[COOKIE];
  if (!verifyToken(token, s.key)) return deny(res, 401, 'UNAUTHENTICATED', 'Sign in to use the Execution Challenge.');
  return next();
}

module.exports = { login, logout, requireAuth, originGuard, createToken, verifyToken, parseCookies, secrets, COOKIE, _failures: failures };
