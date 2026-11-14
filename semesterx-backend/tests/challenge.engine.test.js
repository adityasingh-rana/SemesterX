'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../public/challenge-engine.js');

const MIN = 60000;
const T0 = Date.parse('2026-11-12T00:30:00Z'); // 06:00 IST on 2026-11-12
const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
const setup = (start = '2026-11-12', now = T0) => E.apply(E.emptyDoc(), { type: 'SETUP', startDate: start, startingMaxPullups: 5, startingWeightKg: 70 }, now);
const act = (doc, type, now, extra = {}) => E.apply(doc, Object.assign({ type }, extra), now);
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof E.EngineError && e.code === code, 'expected ' + code);

/** Runs one full session (study -> workout -> rest) with the planned reps; returns [doc, endTime]. */
function runSession(doc, day, t, reps) {
  const p = E.plan(day);
  doc = act(doc, 'START_SESSION', t, { day });
  t += 55 * MIN;
  doc = act(doc, 'BEGIN_WORKOUT', t);
  t += 3 * MIN;
  doc = act(doc, 'FINISH_WORKOUT', t);
  doc = act(doc, 'LOG_WORKOUT', t, reps || { actualPullups: p.pullupsPerSet, actualPushups: p.pushupsPerSet });
  t += 5 * MIN;
  doc = E.reconcile(doc, t);
  return [doc, t];
}

test('plan: totals match the specification', () => {
  const t = E.planTotals();
  assert.equal(t.pullups, 408);
  assert.equal(t.pushups, 6000);
  assert.equal(t.studyMin, 15 * 440);
  assert.deepEqual([1, 4, 5, 8, 9, 12, 13, 15].map((d) => E.plan(d).pullupsDay), [16, 16, 24, 24, 32, 32, 40, 40]);
  assert.equal(E.CONFIG.STUDY_MS * 8, 440 * MIN);
  assert.equal((E.CONFIG.STUDY_MS + E.CONFIG.REST_MS) * 8, 480 * MIN);
  const levels = [1, 2, 3].map((l) => E.CONFIG.LEVEL_OF_SESSION.filter((x) => x === l).length);
  assert.deepEqual(levels, [3, 3, 2]);
});

test('day numbering is calendar-based from the entered start date (not hard-coded)', () => {
  assert.equal(E.calendarDay(setup('2026-11-12'), T0), 1);
  assert.equal(E.calendarDay(setup('2026-11-10'), T0), 3);
  assert.equal(E.calendarDay(setup('2026-11-20'), T0) <= 0, true);
  throwsCode(() => act(setup('2026-11-20'), 'START_SESSION', T0, { day: 1 }), 'FUTURE_DAY');
  throwsCode(() => act(E.emptyDoc(), 'START_SESSION', T0, { day: 1 }), 'NOT_STARTED');
  throwsCode(() => act(setup(), 'SETUP', T0, { startDate: '2026-11-12' }), 'ALREADY_STARTED');
  throwsCode(() => E.apply(E.emptyDoc(), { type: 'SETUP', startDate: 'tomorrow' }, T0), 'INVALID');
});

test('timer: pause preserves exact remaining time; resume continues from the same point', () => {
  let d = act(setup(), 'START_SESSION', T0, { day: 1 });
  assert.equal(E.remainingMs(d.timer, T0 + 10 * MIN), 45 * MIN);
  d = act(d, 'PAUSE', T0 + 10 * MIN);
  assert.equal(d.timer.state, 'STUDY_PAUSED');
  assert.equal(d.timer.pausedRemainingMs, 45 * MIN);
  assert.equal(E.remainingMs(d.timer, T0 + 40 * MIN), 45 * MIN, 'paused time must not elapse');
  d = act(d, 'RESUME', T0 + 40 * MIN);
  assert.equal(d.timer.accumulatedPausedMs, 30 * MIN);
  assert.equal(E.remainingMs(d.timer, T0 + 40 * MIN), 45 * MIN);
  assert.equal(E.remainingMs(d.timer, T0 + 85 * MIN), 0);
  assert.equal(E.reconcile(d, T0 + 84 * MIN), d, 'no change before expiry returns the same object');
});

test('timer: refresh / reopen recovery uses timestamps only', () => {
  let d = act(setup(), 'START_SESSION', T0, { day: 1 });
  const reloaded = JSON.parse(JSON.stringify(d)); // what a refresh restores from MongoDB
  assert.equal(E.remainingMs(reloaded.timer, T0 + 20 * MIN), 35 * MIN);
  // reopened two hours after the block ended: still credited at the real end time, not "now"
  const late = E.reconcile(reloaded, T0 + 180 * MIN);
  assert.equal(late.timer.state, 'WORKOUT_PENDING');
  const s = late.sessions[0];
  assert.equal(s.studyComplete, true);
  assert.equal(s.studyActualMs, 55 * MIN);
  assert.equal(s.studyEndedAt, T0 + 55 * MIN);
  // paused session reopened much later keeps its remaining time
  let p = act(d, 'PAUSE', T0 + 5 * MIN);
  p = JSON.parse(JSON.stringify(p));
  assert.equal(E.reconcile(p, T0 + 9999 * MIN), p);
  assert.equal(E.remainingMs(p.timer, T0 + 9999 * MIN), 50 * MIN);
});

test('workout is never automatic and reps are never assumed', () => {
  let d = act(setup(), 'START_SESSION', T0, { day: 1 });
  d = E.reconcile(d, T0 + 56 * MIN);
  assert.equal(d.timer.state, 'WORKOUT_PENDING');
  assert.equal(E.reconcile(d, T0 + 9999 * MIN), d, 'time alone never advances a workout');
  assert.equal(d.workouts.length, 0);
  d = act(d, 'BEGIN_WORKOUT', T0 + 60 * MIN);
  assert.equal(E.elapsedMs(d.timer, T0 + 64 * MIN), 4 * MIN);
  d = act(d, 'FINISH_WORKOUT', T0 + 64 * MIN);
  assert.equal(d.timer.state, 'WORKOUT_LOGGING');
  assert.equal(d.timer.workoutDurationMs, 4 * MIN);
  throwsCode(() => act(d, 'LOG_WORKOUT', T0 + 65 * MIN, {}), 'INVALID');
  throwsCode(() => act(d, 'LOG_WORKOUT', T0 + 65 * MIN, { actualPullups: '2', actualPushups: 50 }), 'INVALID');
  throwsCode(() => act(d, 'LOG_WORKOUT', T0 + 65 * MIN, { actualPullups: 1, actualPushups: 30 }), 'REASON_REQUIRED');
  const m = act(d, 'LOG_WORKOUT', T0 + 65 * MIN, { actualPullups: 1, actualPushups: 30, reason: 'Shoulder felt tight' });
  assert.equal(m.workouts[0].status, 'modified');
  assert.equal(m.workouts[0].plannedPullups, 2);
  assert.equal(m.workouts[0].actualPullups, 1);
  assert.equal(m.timer.state, 'REST_RUNNING');
  const full = act(d, 'LOG_WORKOUT', T0 + 65 * MIN, { actualPullups: 2, actualPushups: 50 });
  assert.equal(full.workouts[0].status, 'completed');
  const zero = act(d, 'LOG_WORKOUT', T0 + 65 * MIN, { actualPullups: 0, actualPushups: 0, reason: 'Pain' });
  assert.equal(zero.workouts[0].status, 'skipped');
  assert.equal(zero.xp.awarded['d1:s0:workout'], undefined, 'skipped workouts earn no workout XP');
  assert.equal(m.xp.awarded['d1:s0:workout'].amt, full.xp.awarded['d1:s0:workout'].amt, 'XP is fixed, never volume-based');
});

test('skip workout requires a reason and still credits the study block', () => {
  let d = act(setup(), 'START_SESSION', T0, { day: 1 });
  d = E.reconcile(d, T0 + 56 * MIN);
  throwsCode(() => act(d, 'SKIP_WORKOUT', T0 + 57 * MIN, { reason: '  ' }), 'REASON_REQUIRED');
  d = act(d, 'SKIP_WORKOUT', T0 + 57 * MIN, { reason: 'Recovery day' });
  assert.equal(d.workouts[0].status, 'skipped');
  assert.equal(d.xp.awarded['d1:s0:study'].amt, 10);
  assert.equal(d.timer.state, 'REST_RUNNING');
});

test('rest, pause during rest, level boundaries and day completion', () => {
  let d = setup(), t = T0;
  for (let i = 0; i < 8; i++) {
    const p = E.plan(1);
    d = act(d, 'START_SESSION', t, { day: 1 });
    t += 55 * MIN; d = act(d, 'BEGIN_WORKOUT', t);
    t += 2 * MIN; d = act(d, 'FINISH_WORKOUT', t);
    d = act(d, 'LOG_WORKOUT', t, { actualPullups: p.pullupsPerSet, actualPushups: p.pushupsPerSet });
    if (i === 0) {
      d = act(d, 'PAUSE', t + 2 * MIN);
      assert.equal(d.timer.state, 'REST_PAUSED');
      d = act(d, 'RESUME', t + 10 * MIN);
      assert.equal(E.remainingMs(d.timer, t + 10 * MIN), 3 * MIN);
      assert.equal(E.reconcile(d, t + 12 * MIN), d, 'still 1 minute left');
      t += 13 * MIN; // resumed at +10 with 3 minutes left
    } else t += 5 * MIN;
    d = E.reconcile(d, t);
    const expected = i === 7 ? 'DAY_COMPLETED' : (i === 2 || i === 5) ? 'LEVEL_COMPLETED' : 'SESSION_COMPLETED';
    assert.equal(d.timer.state, expected, 'after session ' + (i + 1));
  }
  assert.equal(E.dayComplete(d, 1), true);
  assert.equal(d.xp.awarded['d1:complete'].amt, 25);
  assert.equal(E.streak(d, t), 1);
  assert.equal(E.nextAction(d, t).kind, 'day-done');
  assert.deepEqual(E.levelCounts(d, 1), [3, 3, 2]);
  throwsCode(() => act(d, 'START_SESSION', t, { day: 1 }), 'DAY_COMPLETE');
});

test('XP is idempotent and never counted twice', () => {
  let d = setup();
  const n = { type: 'SAVE_NUTRITION', day: 1, shake1: true, shake2: true, creatine: true, waterL: 3, weightKg: 70 };
  d = E.apply(d, n, T0); const once = d.xp.total;
  d = E.apply(d, n, T0 + 1000); d = E.apply(d, n, T0 + 2000);
  assert.equal(d.xp.total, once);
  assert.equal(Object.keys(d.xp.awarded).length, 1);
  let [x, t] = runSession(setup(), 1, T0);
  const before = x.xp.total;
  x = act(x, 'SAVE_WORKOUT', t, { day: 1, idx: 0, actualPullups: 2, actualPushups: 50 });
  assert.equal(x.xp.total, before, 're-saving an already-awarded set must not add XP');
  const sum = Object.values(x.xp.awarded).reduce((a, v) => a + v.amt, 0);
  assert.equal(x.xp.total, sum);
  const ed = setup();
  throwsCode(() => act(ed, 'BEGIN_WORKOUT', T0), 'BAD_STATE');
});

test('state machine rejects illegal transitions', () => {
  const d = act(setup(), 'START_SESSION', T0, { day: 1 });
  throwsCode(() => act(d, 'START_SESSION', T0 + MIN, { day: 1 }), 'BAD_STATE');
  throwsCode(() => act(d, 'RESUME', T0 + MIN), 'BAD_STATE');
  throwsCode(() => act(d, 'FINISH_WORKOUT', T0 + MIN), 'BAD_STATE');
  throwsCode(() => act(d, 'SKIP_REST', T0 + MIN), 'BAD_STATE');
  throwsCode(() => act(d, 'LOG_WORKOUT', T0 + MIN, { actualPullups: 2, actualPushups: 50 }), 'BAD_STATE');
  throwsCode(() => act(d, 'NOPE', T0), 'UNKNOWN_ACTION');
  throwsCode(() => act(setup(), 'START_SESSION', T0, { day: 2 }), 'FUTURE_DAY');
});

test('abandoning a study block records partial minutes honestly and allows a clean restart', () => {
  let d = act(setup(), 'START_SESSION', T0, { day: 1 });
  d = act(d, 'ABANDON', T0 + 20 * MIN);
  assert.equal(d.timer.state, 'IDLE');
  assert.equal(d.sessions[0].studyComplete, false);
  assert.equal(d.sessions[0].studyActualMs, 20 * MIN);
  d = act(d, 'START_SESSION', T0 + 30 * MIN, { day: 1 });
  assert.equal(d.sessions.length, 1);
  assert.equal(d.timer.session, 0);
});

test('missing records stay missing; analytics never fills gaps', () => {
  const t = Date.parse('2026-11-15T03:00:00Z'); // day 4
  let d = setup('2026-11-12');
  d = E.apply(d, { type: 'SAVE_NUTRITION', day: 2, shake1: true, shake2: false, creatine: true, waterL: null, weightKg: null }, t);
  const a = E.analytics(d, t);
  assert.equal(a.rows.length, 4);
  assert.equal(a.rows[0].pullups, null);
  assert.equal(a.rows[0].studyMin, null);
  assert.equal(a.rows[1].nutrition.waterL, null);
  assert.equal(a.rows[2].nutrition, null);
  assert.equal(a.nutrition.pct, 0);
  assert.equal(E.analytics(setup(), T0).nutrition.pct, null);
});

test('recovery: bounds enforced, empty values stay null, warning signs are separate fields', () => {
  const d = setup();
  throwsCode(() => E.apply(d, { type: 'SAVE_RECOVERY', day: 1, energy: 6 }, T0), 'INVALID');
  throwsCode(() => E.apply(d, { type: 'SAVE_RECOVERY', day: 1, chest: -1 }, T0), 'INVALID');
  const r = E.apply(d, { type: 'SAVE_RECOVERY', day: 1, sleepH: 7.5, energy: 3, chest: 2, warn: { jointPain: true } }, T0);
  assert.equal(r.recovery[0].back, null);
  assert.equal(r.recovery[0].warn.jointPain, true);
  assert.equal(r.recovery[0].warn.sharpPain, false);
  assert.equal(E.latestRecovery(r).warning, true);
});

test('evaluation: only from day 16, compares real start and end values, invents nothing', () => {
  const d = setup('2026-11-12');
  const day16 = Date.parse('2026-11-27T04:00:00Z');
  throwsCode(() => E.apply(d, { type: 'SAVE_EVAL', day: 16, maxPullups: 9 }, T0), 'FUTURE_DAY');
  assert.equal(E.evaluationSummary(d, day16).maxDelta, null);
  const e = E.apply(d, { type: 'SAVE_EVAL', day: 16, maxPullups: 8, finalWeightKg: 71.5, technique: 4 }, day16);
  const s = E.evaluationSummary(e, day16);
  assert.equal(s.startMax, 5); assert.equal(s.finalMax, 8); assert.equal(s.maxDelta, 3);
  assert.equal(s.weightDelta, 1.5);
  assert.equal(e.xp.awarded.eval.amt, 50);
  throwsCode(() => E.apply(e, { type: 'SAVE_EVAL', day: 17, maxPullups: 8 }, day16), 'FUTURE_DAY');
  const noWeight = E.apply(d, { type: 'SAVE_EVAL', day: 16, maxPullups: 8 }, day16);
  assert.equal(E.evaluationSummary(noWeight, day16).weightDelta, null);
  assert.equal(E.nextAction(d, day16).kind, 'evaluate');
});

test('sessions can only run for today (or to finish the same day across midnight)', () => {
  const day2 = Date.parse('2026-11-13T03:00:00Z');
  let d = setup('2026-11-12');
  throwsCode(() => act(d, 'START_SESSION', day2, { day: 1 }), 'WRONG_DAY');
  let [x, t] = runSession(d, 1, T0);
  assert.equal(x.timer.state, 'SESSION_COMPLETED');
  const nextMorning = Date.parse('2026-11-13T00:30:00Z');
  assert.equal(E.nextAction(x, nextMorning).day, 1, 'an unfinished day in progress is continued');
  const cont = act(x, 'START_SESSION', nextMorning, { day: 1 });
  assert.equal(cont.timer.session, 1);
});

test('apply() is pure (never mutates its input)', () => {
  const d = deepFreeze(JSON.parse(JSON.stringify(act(setup(), 'START_SESSION', T0, { day: 1 }))));
  assert.doesNotThrow(() => E.apply(d, { type: 'PAUSE' }, T0 + MIN));
  assert.doesNotThrow(() => E.apply(d, { type: 'SAVE_NUTRITION', day: 1, shake1: true }, T0 + MIN));
  assert.doesNotThrow(() => E.reconcile(d, T0 + 999 * MIN));
});

test('achievements unlock once and honesty is rewarded, not volume', () => {
  let d = setup();
  d = act(d, 'START_SESSION', T0, { day: 1 });
  d = act(d, 'ABANDON', T0 + MIN);
  assert.deepEqual(d.achievements, {});
  let [x] = runSession(setup(), 1, T0, { actualPullups: 1, actualPushups: 20, reason: 'Tired' });
  assert.ok(x.achievements.first_block);
  assert.ok(x.achievements.honest_log);
  const stamp = x.achievements.first_block;
  x = act(x, 'SAVE_NUTRITION', T0 + 999 * MIN, { day: 1, shake1: true });
  assert.equal(x.achievements.first_block, stamp);
});

test('no protein feature anywhere in the challenge code or data', () => {
  const files = ['public/challenge-engine.js', 'lib/challengeValidate.js', 'models/ChallengeState.js'];
  ['public/challenge.js', 'public/challenge.css'].forEach((f) => { if (fs.existsSync(path.join(__dirname, '..', f))) files.push(f); });
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), /protein|whey/i, f);
  const n = E.apply(setup(), { type: 'SAVE_NUTRITION', day: 1, shake1: true, shake2: true, creatine: true, waterL: 2, weightKg: 70 }, T0).nutrition[0];
  assert.deepEqual(Object.keys(n).sort(), ['at', 'creatine', 'day', 'shake1', 'shake2', 'waterL', 'weightKg']);
});
