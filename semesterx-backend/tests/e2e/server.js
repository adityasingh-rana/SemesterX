'use strict';
/**
 * Test server for the browser tests. Serves the real public/ files, stubs the academic /api/state endpoint
 * (so academic isolation can be asserted), and runs the REAL challenge router/auth/validator/controller on an
 * in-memory store. Express itself is the stand-in shim unless the real package is installed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');
let realExpress = null; try { realExpress = require('express'); } catch (e) { /* use shim */ }
const shim = require('../helpers/expressShim');
if (!realExpress) { const load = Module._load; Module._load = function (r, ...a) { return r === 'express' ? shim.express : load.call(this, r, ...a); }; }
const routes = require('../../routes/challengeRoutes');
const { memoryStore } = require('../helpers/memoryStore');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const BASE = Date.parse('2026-11-12T00:30:00Z'); // 06:00 IST, 2026-11-12 = Day 1 when the challenge starts "today"
const clone = (o) => JSON.parse(JSON.stringify(o));

function startServer({ staticDir, academic }) {
  const t0 = Date.now();
  const ctl = {
    skew: 0, mode: 'normal', dbDown: false, store: memoryStore(), academic: academic ? clone(academic) : null,
    academicSeed: academic ? clone(academic) : null, academicPuts: 0, challengeCalls: [], port: 0
  };
  ctl.now = () => BASE + (Date.now() - t0) + ctl.skew;
  const router = routes.build({ store: ctl.store, now: ctl.now, connect: async () => { if (ctl.dbDown) throw new Error('db down'); } });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      const json = (code, body, headers) => { res.writeHead(code, { 'Content-Type': 'application/json', ...(headers || {}) }); res.end(JSON.stringify(body)); };

      if (url.pathname === '/api/state') {
        if (req.method === 'PUT') { ctl.academicPuts++; try { ctl.academic = JSON.parse(raw).data; } catch (e) { /* ignore */ } return json(200, { success: true, updatedAt: new Date().toISOString() }); }
        return ctl.academic ? json(200, { success: true, exists: true, data: ctl.academic, updatedAt: new Date().toISOString() }) : json(200, { success: true, exists: false, data: null });
      }
      if (url.pathname.startsWith('/api/challenge')) {
        ctl.challengeCalls.push(req.method + ' ' + url.pathname);
        if (ctl.mode === 'hang') return; // never answers
        if (ctl.mode === 'error500') return json(500, { success: false, message: 'boom' });
        const rel = url.pathname.slice('/api/challenge'.length) || '/';
        const out = await shim.invoke(router, { method: req.method, path: rel === '' ? '/' : rel, headers: req.headers, body: raw === '' ? undefined : raw });
        const h = { 'Content-Type': 'application/json' };
        if (out.headers['set-cookie']) h['Set-Cookie'] = out.headers['set-cookie'];
        return json(out.status, out.body, h);
      }
      let file = url.pathname === '/' ? '/index.html' : url.pathname;
      const full = path.join(staticDir, path.normalize(file).replace(/^(\.\.[\\/])+/, ''));
      if (!full.startsWith(staticDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(fs.readFileSync(full));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    ctl.port = server.address().port; ctl.url = 'http://127.0.0.1:' + ctl.port;
    ctl.close = () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); });
    resolve(ctl);
  }));
}
module.exports = { startServer, BASE };
