'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../middleware/challengeAuth');

const PW = 'correct horse battery staple 42';
process.env.SEMESTERX_LOGIN_DELAY_MS = '0';
const res = () => { const r = { code: 200, headers: {}, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; return r; };
const req = (o = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', host: 'app.test' }, body: {}, socket: { remoteAddress: '198.51.100.7' }, ...o });
const withEnv = (v, fn) => async () => { const old = process.env.SEMESTERX_PASSWORD; if (v === undefined) delete process.env.SEMESTERX_PASSWORD; else process.env.SEMESTERX_PASSWORD = v; auth._failures.clear(); try { await fn(); } finally { if (old === undefined) delete process.env.SEMESTERX_PASSWORD; else process.env.SEMESTERX_PASSWORD = old; } };

test('fails closed when SEMESTERX_PASSWORD is not configured', withEnv(undefined, async () => {
  const r = res(); await auth.login(req({ body: { password: 'x' } }), r);
  assert.equal(r.code, 503); assert.equal(r.body.code, 'NOT_CONFIGURED'); assert.equal(r.headers['set-cookie'], undefined);
  const g = res(); let called = false; auth.requireAuth(req({ method: 'GET' }), g, () => { called = true; });
  assert.equal(g.code, 503); assert.equal(called, false);
}));

test('wrong or missing password is rejected without a cookie', withEnv(PW, async () => {
  for (const body of [{ password: 'nope' }, { password: '' }, {}, { password: 123 }, { password: 'x'.repeat(300) }]) {
    const r = res(); await auth.login(req({ body }), r);
    assert.ok([400, 401].includes(r.code), JSON.stringify(body).slice(0, 30));
    assert.equal(r.headers['set-cookie'], undefined);
  }
}));

test('correct password sets a hardened cookie that never contains the password', withEnv(PW, async () => {
  const r = res(); await auth.login(req({ body: { password: PW } }), r);
  assert.equal(r.code, 200);
  const c = r.headers['set-cookie'];
  assert.match(c, /^sx_challenge=/); assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Path=\/api\/challenge/); assert.match(c, /Max-Age=\d+/);
  assert.ok(!c.includes(PW)); assert.ok(!JSON.stringify(r.body).includes(PW));
  const old = process.env.VERCEL; process.env.VERCEL = '1';
  const r2 = res(); await auth.login(req({ body: { password: PW } }), r2);
  assert.match(r2.headers['set-cookie'], /; Secure/);
  if (old === undefined) delete process.env.VERCEL; else process.env.VERCEL = old;
}));

test('requireAuth accepts a valid cookie and rejects tampered, expired, foreign and missing ones', withEnv(PW, async () => {
  const s = auth.secrets();
  const good = auth.createToken(s.key);
  const ok = (cookie) => { const r = res(); let n = false; auth.requireAuth({ headers: { cookie } }, r, () => { n = true; }); return { n, code: r.code }; };
  assert.equal(ok('sx_challenge=' + good).n, true);
  assert.equal(ok('a=1; sx_challenge=' + good + '; b=2').n, true);
  assert.equal(ok(undefined).code, 401);
  assert.equal(ok('sx_challenge=').code, 401);
  assert.equal(ok('sx_challenge=' + good.slice(0, -2) + 'xx').code, 401);
  const [p, sig] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, iat: 1, exp: 9e15 })).toString('base64url');
  assert.equal(ok('sx_challenge=' + forged + '.' + sig).code, 401);
  assert.equal(ok('sx_challenge=' + auth.createToken(s.key, Date.now() - 8 * 24 * 3600 * 1000)).code, 401);
  process.env.SEMESTERX_PASSWORD = 'a different password';
  assert.equal(ok('sx_challenge=' + good).code, 401, 'changing the password invalidates every session');
}));

test('login is throttled after repeated failures, and success resets the counter', withEnv(PW, async () => {
  for (let i = 0; i < 8; i++) await auth.login(req({ body: { password: 'bad' + i } }), res());
  const r = res(); await auth.login(req({ body: { password: PW } }), r);
  assert.equal(r.code, 429); assert.ok(r.headers['retry-after']);
  const other = res(); await auth.login(req({ body: { password: PW }, socket: { remoteAddress: '198.51.100.99' } }), other);
  assert.equal(other.code, 200, 'a different client is not locked out');
}));

test('logout clears the cookie', () => {
  const r = res(); auth.logout(req(), r);
  assert.match(r.headers['set-cookie'], /Max-Age=0/);
});

test('originGuard blocks cross-site writes but allows same-origin JSON and safe reads', () => {
  const run = (o) => { const r = res(); let n = false; auth.originGuard(req(o), r, () => { n = true; }); return { n, code: r.code }; };
  assert.equal(run({ method: 'GET', headers: {} }).n, true);
  assert.equal(run({ headers: { host: 'app.test', origin: 'https://app.test', 'content-type': 'application/json' } }).n, true);
  assert.equal(run({ headers: { host: 'app.test', 'content-type': 'application/json' } }).n, true);
  assert.equal(run({ headers: { host: 'app.test', origin: 'https://evil.test', 'content-type': 'application/json' } }).code, 403);
  assert.equal(run({ headers: { host: 'app.test', origin: 'null', 'content-type': 'application/json' } }).code, 403);
  assert.equal(run({ headers: { host: 'app.test', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' } }).code, 403);
  assert.equal(run({ headers: { host: 'app.test', 'content-type': 'text/plain' } }).code, 415);
  assert.equal(run({ method: 'PUT', headers: { host: 'app.test' } }).code, 415);
});
