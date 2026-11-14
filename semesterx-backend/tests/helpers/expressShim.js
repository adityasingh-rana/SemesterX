'use strict';
/**
 * MINIMAL STAND-IN for Express, used only by tests when the real package is not installed.
 * It implements just what routes/challengeRoutes.js uses (Router, use/get/put/post/delete, express.json,
 * 4-arg error handlers, rejected promises -> next(err)). It is NOT Express: behaviour that depends on
 * real Express internals still has to be verified against the real server (see README-APPLY.md).
 */
function json(opts = {}) {
  const limit = opts.limit === '256kb' ? 256 * 1024 : 100 * 1024;
  return (req, res, next) => {
    const raw = req.rawBody;
    if (typeof raw !== 'string' || raw.length === 0 || !/json/i.test(req.headers['content-type'] || '')) { req.body = {}; return next(); }
    if (Buffer.byteLength(raw) > limit) { const e = new Error('request entity too large'); e.type = 'entity.too.large'; e.status = 413; return next(e); }
    try { req.body = JSON.parse(raw); } catch (err) { err.type = 'entity.parse.failed'; return next(err); }
    return next();
  };
}

function Router() {
  const layers = [];
  const add = (method, path, fns) => fns.forEach((fn) => layers.push({ method, path, fn }));
  const router = (req, res, done) => router.handle(req, res, done);
  router.use = (...fns) => add(null, null, fns);
  ['get', 'put', 'post', 'delete'].forEach((m) => { router[m] = (path, ...fns) => add(m.toUpperCase(), path, fns); });
  router.handle = (req, res, done) => {
    let i = 0;
    const next = (err) => {
      while (i < layers.length) {
        const l = layers[i++];
        const matches = !l.method || (l.method === req.method && l.path === req.path);
        const isErr = l.fn.length === 4;
        if (!matches || (err && !isErr) || (!err && isErr)) continue;
        try {
          const r = isErr ? l.fn(err, req, res, next) : l.fn(req, res, next);
          if (r && typeof r.then === 'function') r.catch(next);
        } catch (e) { next(e); }
        return;
      }
      if (done) done(err);
    };
    next();
  };
  return router;
}

function express() { throw new Error('shim: express() app not supported'); }
express.Router = Router;
express.json = json;

/** Drive a router like an HTTP request. Returns { status, headers, body }. */
function invoke(router, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const h = {}; Object.keys(headers).forEach((k) => { h[k.toLowerCase()] = headers[k]; });
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const req = { method, path, headers: h, rawBody: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), socket: { remoteAddress: '203.0.113.9' } };
    const out = { status: 200, headers: {} };
    const res = {
      status(c) { out.status = c; return res; },
      setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
      json(b) { out.body = b; resolve(out); return res; }
    };
    router(req, res, (err) => { out.status = err ? 500 : 404; out.body = { fellThrough: true, err: err && err.message }; resolve(out); });
  });
}

module.exports = { express, invoke };
