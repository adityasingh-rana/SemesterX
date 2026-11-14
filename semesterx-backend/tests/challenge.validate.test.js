'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/challenge-engine.js');
const { validateData, checkInvariants } = require('../lib/challengeValidate');
const C = require('../lib/challengeConfig');

const MIN = 60000;
const T0 = Date.parse('2026-11-12T00:30:00Z');
const act = (d, type, now, x = {}) => E.apply(d, Object.assign({ type }, x), now);

/** A realistic document produced only by the engine: 2 sessions, workouts, nutrition, recovery. */
function richDoc() {
  let d = act(E.emptyDoc(), 'SETUP', T0, { startDate: '2026-11-12', startingMaxPullups: 5, startingWeightKg: 70.5 });
  let t = T0;
  for (let i = 0; i < 2; i++) {
    d = act(d, 'START_SESSION', t, { day: 1 }); t += 55 * MIN;
    d = act(d, 'BEGIN_WORKOUT', t); t += 3 * MIN;
    d = act(d, 'FINISH_WORKOUT', t);
    d = act(d, 'LOG_WORKOUT', t, i ? { actualPullups: 1, actualPushups: 30, reason: 'Tired', notes: 'ok' } : { actualPullups: 2, actualPushups: 50 });
    t += 5 * MIN; d = E.reconcile(d, t);
  }
  d = act(d, 'SAVE_NUTRITION', t, { day: 1, shake1: true, shake2: true, creatine: true, waterL: 3.5, weightKg: 70.2 });
  d = act(d, 'SAVE_RECOVERY', t, { day: 1, sleepH: 7, energy: 4, back: 1, chest: 2, warn: { swelling: true }, notes: 'ok' });
  d = act(d, 'START_SESSION', t, { day: 1 });
  d = act(d, 'PAUSE', t + MIN);
  return d;
}

test('every document the engine produces validates and is preserved exactly (no field is dropped)', () => {
  const docs = [E.emptyDoc(), richDoc()];
  for (const d of docs) {
    const v = validateData(JSON.parse(JSON.stringify(d)));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.value, d);
  }
});

test('unknown fields are rejected, never silently dropped', () => {
  const d = richDoc();
  assert.equal(validateData({ ...d, extra: 1 }).ok, false);
  assert.equal(validateData({ ...d, challenge: { ...d.challenge, protein: 5 } }).ok, false);
  const w = JSON.parse(JSON.stringify(d)); w.workouts[0].bonus = true;
  assert.equal(validateData(w).ok, false);
  assert.equal(validateData(null).ok, false);
  assert.equal(validateData([]).ok, false);
  assert.equal(validateData('x').ok, false);
});

test('type, range, duplicate and size rules', () => {
  const mut = (fn) => { const d = JSON.parse(JSON.stringify(richDoc())); fn(d); return validateData(d); };
  assert.equal(mut((d) => { d.recovery[0].energy = 6; }).ok, false);
  assert.equal(mut((d) => { d.recovery[0].back = -1; }).ok, false);
  assert.equal(mut((d) => { d.recovery[0].sleepH = 25; }).ok, false);
  assert.equal(mut((d) => { d.nutrition[0].waterL = '3'; }).ok, false);
  assert.equal(mut((d) => { d.nutrition[0].weightKg = 5; }).ok, false);
  assert.equal(mut((d) => { d.workouts[0].actualPullups = 1.5; }).ok, false);
  assert.equal(mut((d) => { d.workouts[0].status = 'great'; }).ok, false);
  assert.equal(mut((d) => { d.workouts[0].reason = 'x'.repeat(201); }).ok, false);
  assert.equal(mut((d) => { d.workouts[0].notes = 'bad\u0000text'; }).ok, false);
  assert.equal(mut((d) => { d.sessions[0].level = 3; }).ok, false, 'level must match the session');
  assert.equal(mut((d) => { d.sessions.push({ ...d.sessions[0] }); }).ok, false, 'duplicate day:idx');
  assert.equal(mut((d) => { d.nutrition.push({ ...d.nutrition[0] }); }).ok, false, 'duplicate day');
  assert.equal(mut((d) => { d.timer.state = 'FLYING'; }).ok, false);
  assert.equal(mut((d) => { d.timer.day = 16; }).ok, false);
  assert.equal(mut((d) => { d.challenge.startDate = '12/11/2026'; }).ok, false);
  assert.equal(mut((d) => { d.challenge.status = 'active'; d.challenge.startDate = null; }).ok, false);
  assert.equal(mut((d) => { d.schemaVersion = 2; }).ok, false);
  assert.equal(mut((d) => { d.sessions = new Array(121).fill(0); }).ok, false, 'too many sessions');
  assert.equal(mut((d) => { d.xp.awarded['d1:s0:protein'] = { amt: 5, at: 1 }; }).ok, false);
  assert.equal(mut((d) => { d.xp.awarded['d1:s0:study'].amt = 0; }).ok, false);
  assert.equal(mut((d) => { d.achievements['BAD KEY'] = 1; }).ok, false);
  assert.equal(mut((d) => { d.evaluation = { day: 15, maxPullups: 5 }; }).ok, false);
});

test('xp.total is always recomputed by the server', () => {
  const d = JSON.parse(JSON.stringify(richDoc()));
  const real = d.xp.total;
  d.xp.total = 999999;
  const v = validateData(d);
  assert.equal(v.ok, true);
  assert.equal(v.value.xp.total, real);
});

test('error list is bounded and never echoes large input', () => {
  const d = JSON.parse(JSON.stringify(richDoc()));
  d.sessions.forEach((s) => { s.idx = 99; s.day = 99; });
  d.recovery[0].energy = 'x'.repeat(100000);
  const v = validateData(d);
  assert.equal(v.ok, false);
  assert.ok(v.errors.length <= 20);
  assert.ok(JSON.stringify(v.errors).length < 4000);
});

test('invariants: awarded XP, start date and completed study sessions cannot be erased', () => {
  const prev = validateData(richDoc()).value;
  const next = () => JSON.parse(JSON.stringify(prev));
  assert.deepEqual(checkInvariants(prev, next()), []);
  const a = next(); delete a.xp.awarded['d1:s0:study'];
  assert.match(checkInvariants(prev, a)[0], /cannot be removed/);
  const b = next(); b.xp.awarded['d1:s0:study'].amt += 1;
  assert.equal(checkInvariants(prev, b).length, 1);
  const c = next(); c.challenge.startDate = '2026-11-13';
  assert.match(checkInvariants(prev, c)[0], /locked/);
  const d = next(); d.sessions[0].studyComplete = false;
  assert.match(checkInvariants(prev, d)[0], /cannot be reverted/);
  const e = next(); e.sessions = e.sessions.slice(1);
  assert.equal(checkInvariants(prev, e).length, 1);
  const setupPrev = validateData(E.emptyDoc()).value;
  const f = JSON.parse(JSON.stringify(setupPrev)); f.challenge.startDate = '2026-11-12'; f.challenge.status = 'active';
  assert.deepEqual(checkInvariants(setupPrev, f), [], 'start date may be set while still in setup');
});

test('parity: server config and browser engine config are identical', () => {
  const { CONFIG } = E;
  assert.deepEqual(JSON.parse(JSON.stringify(CONFIG)), JSON.parse(JSON.stringify(C)));
});
