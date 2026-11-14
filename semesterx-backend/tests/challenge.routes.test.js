'use strict';
/**
 * Route tests. If the real `express` package is installed they run over real HTTP against real Express.
 * Otherwise they run against tests/helpers/expressShim.js (a minimal stand-in) - see README-APPLY.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const E = require('../public/challenge-engine.js');
const { memoryStore } = require('./helpers/memoryStore');

let realExpress = null;
try { realExpress = require('express'); } catch (e) { realExpress = null; }
const shim = require('./helpers/expressShim');
if (!realExpress) {
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'express' ? shim.express : load.call(this, request, ...rest); };
}
const routes = require('../routes/challengeRoutes');
const MODE = realExpress ? 'real Express over HTTP' : 'Express stand-in (no real Express installed)';

const PW = 'route-test password 7731';
process.env.SEMESTERX_PASSWORD = PW;
process.env.SEMESTERX_LOGIN_DELAY_MS = '0';
const T0 = Date.parse('2026-11-12T00:30:00Z');
const goodDoc = () => E.apply(E.emptyDoc(), { type: 'SETUP', startDate: '2026-11-12', startingMaxPullups: 5, startingWeightKg: 70 }, T0);
let opN = 0; const op = () => 'op-' + String(++opN).padStart(8, '0');
const clone = (o) => JSON.parse(JSON.stringify(o));

async function makeEnv({ initial, connect } = {}) {
  const store = memoryStore(initial);
  const connectCalls = { n: 0 };
  const router = routes.build({ store, connect: connect || (async () => { connectCalls.n++; }) });
  if (!realExpress) {
    return { store, connectCalls, host: 'app.test', close() {}, request: (o) => shim.invoke(router, { ...o, headers: { host: 'app.test', ...(o.headers || {}) } }) };
  }
  const app = realExpress(); app.use('/api/challenge', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const host = '127.0.0.1:' + server.address().port;
  const request = async ({ method = 'GET', path = '/', headers = {}, body }) => {
    const h = { ...headers };
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const r = await fetch('http://' + host + '/api/challenge' + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch (e) { /* non-json */ }
    return { status: r.status, headers: { 'set-cookie': r.headers.get('set-cookie') || undefined, 'cache-control': r.headers.get('cache-control') }, body: json };
  };
  return { store, connectCalls, host, close: () => new Promise((r) => server.close(r)), request };
}
async function signedIn(env) {
  const r = await env.request({ method: 'POST', path: '/login', body: { password: PW } });
  assert.equal(r.status, 200);
  return { cookie: r.headers['set-cookie'].split(';')[0] };
}
const withEnv = (opts, fn) => async () => { const env = await makeEnv(opts); try { await fn(env); } finally { await env.close(); } };

test('[' + MODE + '] unauthenticated requests are refused and never reach the database', withEnv({}, async (env) => {
  for (const [method, path, body] of [['GET', '/'], ['PUT', '/', { rev: 0, opId: op(), data: goodDoc() }], ['DELETE', '/', { rev: 0, confirm: 'RESET CHALLENGE' }]]) {
    const r = await env.request({ method, path, body });
    assert.equal(r.status, 401, method);
    assert.equal(r.body.code, 'UNAUTHENTICATED');
  }
  assert.deepEqual(env.store.calls, []);
  assert.equal(env.connectCalls.n, 0);
  const forged = await env.request({ headers: { cookie: 'sx_challenge=abc.def' } });
  assert.equal(forged.status, 401);
}));

test('login/logout and no-store caching', withEnv({}, async (env) => {
  const bad = await env.request({ method: 'POST', path: '/login', body: { password: 'wrong' } });
  assert.equal(bad.status, 401); assert.equal(bad.headers['set-cookie'], undefined);
  const { cookie } = await signedIn(env);
  const r = await env.request({ headers: { cookie } });
  assert.equal(r.status, 200); assert.match(r.headers['cache-control'], /no-store/);
  const out = await env.request({ method: 'POST', path: '/logout', body: {} });
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
}));

test('GET before any write reports exists:false without creating anything', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const r = await env.request({ headers: { cookie } });
  assert.equal(r.body.exists, false); assert.equal(r.body.rev, 0); assert.equal(r.body.data, null);
  assert.equal(typeof r.body.serverTime, 'number');
  assert.equal(env.store.peek(), null);
}));

test('PUT creates at rev 0, GET returns it, revision increments on every write', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const doc = goodDoc();
  const c = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: doc } });
  assert.equal(c.status, 200); assert.equal(c.body.rev, 1);
  const g = await env.request({ headers: { cookie } });
  assert.equal(g.body.exists, true); assert.equal(g.body.rev, 1); assert.deepEqual(g.body.data, doc);
  assert.equal(g.body.data.lastOpId, undefined, 'bookkeeping is not leaked');
  const next = E.apply(doc, { type: 'SAVE_NUTRITION', day: 1, shake1: true }, T0 + 1000);
  const u = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 1, opId: op(), data: next } });
  assert.equal(u.status, 200); assert.equal(u.body.rev, 2);
}));

test('stale revision returns 409 and never overwrites newer data', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const a = goodDoc();
  await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: a } });
  const b = E.apply(a, { type: 'SAVE_NUTRITION', day: 1, shake1: true }, T0 + 1000);
  await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 1, opId: op(), data: b } });
  const stale = E.apply(a, { type: 'SAVE_NUTRITION', day: 1, shake2: true }, T0 + 2000);
  const r = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 1, opId: op(), data: stale } });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'REV_CONFLICT'); assert.equal(r.body.currentRev, 2);
  const g = await env.request({ headers: { cookie } });
  assert.deepEqual(g.body.data, b);
  const create = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: a } });
  assert.equal(create.status, 409, 'creating when a document already exists is a conflict');
}));

test('a retried request with the same opId is idempotent (no double increment, no false conflict)', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const id = op(); const body = { rev: 0, opId: id, data: goodDoc() };
  const first = await env.request({ method: 'PUT', headers: { cookie }, body });
  const again = await env.request({ method: 'PUT', headers: { cookie }, body });
  assert.equal(first.status, 200); assert.equal(again.status, 200);
  assert.equal(again.body.rev, 1);
  assert.equal(env.store.peek().rev, 1);
}));

test('invalid payloads are rejected with 400 and nothing is written', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const put = (body) => env.request({ method: 'PUT', headers: { cookie }, body });
  const good = goodDoc();
  const cases = [
    { opId: op(), data: good }, { rev: -1, opId: op(), data: good }, { rev: '0', opId: op(), data: good }, { rev: 0, data: good },
    { rev: 0, opId: 'short', data: good }, { rev: 0, opId: op() }, { rev: 0, opId: op(), data: 'text' },
    { rev: 0, opId: op(), data: { ...good, injected: { $set: 1 } } }, { rev: 0, opId: op(), data: { ...good, timer: { ...good.timer, state: 'HACK' } } }
  ];
  for (const b of cases) { const r = await put(b); assert.equal(r.status, 400, JSON.stringify(b).slice(0, 60)); assert.equal(r.body.success, false); }
  assert.equal(env.store.peek(), null);
  const bad = await env.request({ method: 'PUT', headers: { cookie }, body: '{not json' });
  assert.equal(bad.status, 400);
}));

test('oversized payload is rejected with 413', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const r = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: goodDoc(), pad: 'x'.repeat(300000) } });
  assert.equal(r.status, 413);
  assert.equal(env.store.peek(), null);
}));

test('history cannot be erased through the API (invariants)', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  let d = goodDoc();
  d = E.apply(d, { type: 'SAVE_NUTRITION', day: 1, shake1: true, shake2: true, creatine: true }, T0);
  await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: d } });
  const wiped = clone(d); wiped.xp = { awarded: {}, total: 0 };
  const r = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 1, opId: op(), data: wiped } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'INVARIANT');
  const moved = clone(d); moved.challenge.startDate = '2026-12-01';
  assert.equal((await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 1, opId: op(), data: moved } })).body.code, 'INVARIANT');
  assert.equal(env.store.peek().rev, 1);
}));

test('database connection failure returns 503 after auth and saves nothing', withEnv({ connect: async () => { throw new Error('no db'); } }, async (env) => {
  const { cookie } = await signedIn(env);
  const r = await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: goodDoc() } });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'DB_UNAVAILABLE');
  assert.deepEqual(env.store.calls, []);
}));

test('an unexpected database error mid-request returns a generic 500', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  env.store.get = async () => { throw new Error('secret internal detail'); };
  const r = await env.request({ headers: { cookie } });
  assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.body).includes('secret internal detail'));
}));

test('cross-site and non-JSON writes are blocked even with a valid cookie', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const base = { method: 'PUT', body: { rev: 0, opId: op(), data: goodDoc() } };
  const evil = await env.request({ ...base, headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const site = await env.request({ ...base, headers: { cookie, 'sec-fetch-site': 'cross-site' } });
  assert.equal(site.status, 403);
  const text = await env.request({ ...base, body: 'rev=0', headers: { cookie, 'content-type': 'text/plain' } });
  assert.equal(text.status, 415);
  const same = await env.request({ ...base, headers: { cookie, origin: 'http://' + env.host } });
  assert.equal(same.status, 200);
}));

test('reset needs the exact phrase and the current revision', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  await env.request({ method: 'PUT', headers: { cookie }, body: { rev: 0, opId: op(), data: goodDoc() } });
  const del = (body) => env.request({ method: 'DELETE', headers: { cookie }, body });
  assert.equal((await del({ rev: 1 })).status, 400);
  assert.equal((await del({ rev: 1, confirm: 'reset' })).status, 400);
  assert.equal((await del({ rev: 7, confirm: 'RESET CHALLENGE' })).status, 409);
  assert.notEqual(env.store.peek(), null);
  assert.equal((await del({ rev: 1, confirm: 'RESET CHALLENGE' })).status, 200);
  assert.equal(env.store.peek(), null);
  assert.equal((await env.request({ headers: { cookie } })).body.exists, false);
  assert.equal((await del({ rev: 0, confirm: 'RESET CHALLENGE' })).status, 200, 'resetting an empty challenge is harmless');
}));

test('unknown challenge endpoints return JSON 404', withEnv({}, async (env) => {
  const { cookie } = await signedIn(env);
  const r = await env.request({ path: '/nope', headers: { cookie } });
  assert.equal(r.status, 404); assert.equal(r.body.code, 'NOT_FOUND');
}));
