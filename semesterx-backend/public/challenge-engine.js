/* SemesterX Execution Challenge - pure engine (no DOM, no network, no storage).
 * Runs in the browser (window.CXEngine) and in Node tests (module.exports).
 * Timer rule: only timestamps and durations are stored; elapsed/remaining are always derived from `now`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CXEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  // Must stay identical to lib/challengeConfig.js (enforced by tests/challenge.parity.test.js).
  const CONFIG = Object.freeze({
    DAYS: 15,
    SESSIONS_PER_DAY: 8,
    STUDY_MS: 55 * MIN,
    REST_MS: 5 * MIN,
    LEVEL_OF_SESSION: Object.freeze([1, 1, 1, 2, 2, 2, 3, 3]),
    PUSHUPS_PER_SET: 50,
    EVAL_DAYS: Object.freeze([16, 17]),
    TIMER_STATES: Object.freeze([
      'IDLE', 'STUDY_RUNNING', 'STUDY_PAUSED', 'WORKOUT_PENDING', 'WORKOUT_RUNNING',
      'WORKOUT_PAUSED', 'WORKOUT_LOGGING', 'REST_RUNNING', 'REST_PAUSED',
      'SESSION_COMPLETED', 'LEVEL_COMPLETED', 'DAY_COMPLETED', 'CHALLENGE_COMPLETED'
    ]),
    XP: Object.freeze({ study: 10, workout: 10, nutrition: 5, recovery: 5, day: 25, evaluation: 50 })
  });
  const TZ = 'Asia/Kolkata';
  const SORENESS = ['back', 'biceps', 'chest', 'shoulders', 'triceps', 'forearms'];
  const RUNNING = { STUDY_RUNNING: 'STUDY_PAUSED', WORKOUT_RUNNING: 'WORKOUT_PAUSED', REST_RUNNING: 'REST_PAUSED' };
  const PAUSED = { STUDY_PAUSED: 'STUDY_RUNNING', WORKOUT_PAUSED: 'WORKOUT_RUNNING', REST_PAUSED: 'REST_RUNNING' };
  const WAITING = ['IDLE', 'SESSION_COMPLETED', 'LEVEL_COMPLETED', 'DAY_COMPLETED', 'CHALLENGE_COMPLETED'];

  class EngineError extends Error {
    constructor(code, message) { super(message); this.name = 'EngineError'; this.code = code; }
  }
  const fail = (code, msg) => { throw new EngineError(code, msg); };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---- dates (calendar-based challenge days, Asia/Kolkata like the rest of SemesterX) ----
  const isoToday = (now) => new Date(now).toLocaleDateString('en-CA', { timeZone: TZ });
  const dayMs = (iso) => { const p = iso.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  const diffDays = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 864e5);
  const addDays = (iso, n) => new Date(dayMs(iso) + n * 864e5).toISOString().slice(0, 10);
  const validIso = (s) => {
  if (
    typeof s !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    s < '2020-01-01' ||
    s > '2100-01-01'
  ) return false;

  const [y, m, d] = s.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));

  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
};
  /** Challenge day number for `now` (0 before setup, <=0 before start, >15 after the 15 days). */
  const calendarDay = (doc, now) => (doc.challenge.startDate ? diffDays(doc.challenge.startDate, isoToday(now)) + 1 : 0);
  const dateOfDay = (doc, day) => addDays(doc.challenge.startDate, day - 1);

  // ---- plan ----
  const pullupsPerSet = (day) => (day <= 4 ? 2 : day <= 8 ? 3 : day <= 12 ? 4 : 5);
  const plan = (day) => ({
    pullupsPerSet: pullupsPerSet(day), pullupsDay: pullupsPerSet(day) * CONFIG.SESSIONS_PER_DAY,
    pushupsPerSet: CONFIG.PUSHUPS_PER_SET, pushupsDay: CONFIG.PUSHUPS_PER_SET * CONFIG.SESSIONS_PER_DAY,
    studyMinDay: (CONFIG.STUDY_MS / MIN) * CONFIG.SESSIONS_PER_DAY
  });
  const planTotals = () => {
    let pull = 0, push = 0, study = 0;
    for (let d = 1; d <= CONFIG.DAYS; d++) { const p = plan(d); pull += p.pullupsDay; push += p.pushupsDay; study += p.studyMinDay; }
    return { pullups: pull, pushups: push, studyMin: study };
  };

  // ---- document ----
  const idleTimer = () => ({ state: 'IDLE', day: null, session: null, phaseStartedAt: null, phaseDurationMs: null, pausedAt: null, pausedRemainingMs: null, accumulatedPausedMs: 0, workoutDurationMs: null });
  const emptyDoc = () => ({
    schemaVersion: 1,
    challenge: { status: 'setup', startDate: null, startingMaxPullups: null, startingWeightKg: null, startedAt: null },
    timer: idleTimer(), sessions: [], workouts: [], nutrition: [], recovery: [], evaluation: null,
    xp: { awarded: {}, total: 0 }, achievements: {}
  });

  const findSession = (doc, day, idx) => doc.sessions.find((s) => s.day === day && s.idx === idx);
  const findWorkout = (doc, day, idx) => doc.workouts.find((w) => w.day === day && w.idx === idx);
  const byDay = (list, day) => list.find((r) => r.day === day);
  const upsert = (list, rec, same) => { const i = list.findIndex(same); if (i >= 0) list[i] = rec; else list.push(rec); return rec; };

  // ---- timer maths (derived, never ticked) ----
  function elapsedMs(t, now) {
    if (t.phaseStartedAt == null) return 0;
    const end = PAUSED[t.state] && t.pausedAt != null ? t.pausedAt : now;
    return Math.max(0, end - t.phaseStartedAt - t.accumulatedPausedMs);
  }
  function remainingMs(t, now) {
    if (t.phaseDurationMs == null) return null;
    return Math.max(0, t.phaseDurationMs - elapsedMs(t, now));
  }

  // ---- validation helpers ----
  const needInt = (v, min, max, name) => { if (!Number.isInteger(v) || v < min || v > max) fail('INVALID', name + ' must be a whole number from ' + min + ' to ' + max + '.'); return v; };
  const optInt = (v, min, max, name) => (v === null || v === undefined || v === '' ? null : needInt(v, min, max, name));
  const optNum = (v, min, max, name) => { if (v === null || v === undefined || v === '') return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('INVALID', name + ' must be a number from ' + min + ' to ' + max + '.'); return v; };
  const text = (v, max, name) => { const s = v == null ? '' : String(v); if (s.length > max) fail('INVALID', name + ' is too long (max ' + max + ').'); return s; };

  function requireActive(doc) { if (doc.challenge.status === 'setup') fail('NOT_STARTED', 'Set up the challenge first.'); }
  function checkDay(doc, day, now) {
    requireActive(doc);
    needInt(day, 1, CONFIG.DAYS, 'Day');
    if (day > calendarDay(doc, now)) fail('FUTURE_DAY', 'Day ' + day + ' has not started yet.');
    return day;
  }

  // ---- xp (idempotent by key) ----
  function award(doc, key, amt, now) {
    if (doc.xp.awarded[key]) return false;
    doc.xp.awarded[key] = { amt, at: now };
    doc.xp.total += amt;
    return true;
  }

  const dayComplete = (doc, day) => {
    for (let i = 0; i < CONFIG.SESSIONS_PER_DAY; i++) {
      const s = findSession(doc, day, i);
      if (!s || !s.studyComplete || !findWorkout(doc, day, i)) return false;
    }
    return true;
  };
  const daysComplete = (doc) => { let n = 0; for (let d = 1; d <= CONFIG.DAYS; d++) if (dayComplete(doc, d)) n++; return n; };

  function streak(doc, now) {
    if (doc.challenge.status === 'setup') return 0;
    const cal = Math.min(calendarDay(doc, now), CONFIG.DAYS);
    let d = cal >= 1 && dayComplete(doc, cal) ? cal : cal - 1;
    let n = 0;
    while (d >= 1 && dayComplete(doc, d)) { n++; d--; }
    return n;
  }

  // ---- achievements (derived; unlock time is stored once) ----
  const ACHIEVEMENTS = [
    { id: 'first_block', name: 'First block', desc: 'Finish one 55-minute study block.', test: (d) => d.sessions.some((s) => s.studyComplete) },
    { id: 'first_day', name: 'Full day', desc: 'Complete all 8 sessions in one day.', test: (d) => daysComplete(d) >= 1 },
    { id: 'streak_3', name: 'Three in a row', desc: 'Complete 3 days in a row.', test: (d, n) => streak(d, n) >= 3 || d.achievements.streak_3 },
    { id: 'streak_7', name: 'Seven in a row', desc: 'Complete 7 days in a row.', test: (d, n) => streak(d, n) >= 7 || d.achievements.streak_7 },
    { id: 'honest_log', name: 'Honest log', desc: 'Record a modified or skipped workout with a reason.', test: (d) => d.workouts.some((w) => w.status !== 'completed' && w.reason) },
    { id: 'log_keeper', name: 'Log keeper', desc: 'Log nutrition and recovery on 5 days.', test: (d) => d.nutrition.filter((x) => d.recovery.some((r) => r.day === x.day)).length >= 5 },
    { id: 'halfway', name: 'Halfway', desc: 'Complete 8 days.', test: (d) => daysComplete(d) >= 8 },
    { id: 'challenge_done', name: 'Fifteen days', desc: 'Complete all 15 days.', test: (d) => daysComplete(d) >= CONFIG.DAYS },
    { id: 'evaluated', name: 'Evaluated', desc: 'Record the final evaluation.', test: (d) => !!d.evaluation }
  ];
  function evaluateAchievements(doc, now) {
    for (const a of ACHIEVEMENTS) if (!doc.achievements[a.id] && a.test(doc, now)) doc.achievements[a.id] = now;
  }

  /** Runs after every action: day-complete XP, challenge status, achievements. */
  function settle(doc, now) {
    for (let d = 1; d <= CONFIG.DAYS; d++) if (dayComplete(doc, d)) award(doc, 'd' + d + ':complete', CONFIG.XP.day, now);
    if (doc.challenge.status === 'active' && daysComplete(doc) >= CONFIG.DAYS) doc.challenge.status = 'completed';
    evaluateAchievements(doc, now);
  }

  // ---- phase transitions ----
  function finishStudy(doc) {
    const t = doc.timer;
    const s = findSession(doc, t.day, t.session);
    s.studyEndedAt = t.phaseStartedAt + t.phaseDurationMs + t.accumulatedPausedMs; // the moment the countdown reached zero
    s.studyActualMs = t.phaseDurationMs;
    s.studyComplete = true;
    doc.timer = Object.assign(idleTimer(), { state: 'WORKOUT_PENDING', day: t.day, session: t.session });
  }
  function finishRest(doc, endedAt) {
    const t = doc.timer;
    const s = findSession(doc, t.day, t.session);
    s.restEndedAt = endedAt; s.completedAt = endedAt;
    const last = t.session === CONFIG.SESSIONS_PER_DAY - 1;
    const state = last ? (t.day === CONFIG.DAYS ? 'CHALLENGE_COMPLETED' : 'DAY_COMPLETED') : (t.session === 2 || t.session === 5 ? 'LEVEL_COMPLETED' : 'SESSION_COMPLETED');
    doc.timer = Object.assign(idleTimer(), { state, day: t.day, session: t.session });
  }
  const startRest = (doc, now) => { doc.timer = Object.assign(idleTimer(), { state: 'REST_RUNNING', day: doc.timer.day, session: doc.timer.session, phaseStartedAt: now, phaseDurationMs: CONFIG.REST_MS }); };
  /** Study XP is awarded on an explicit action (begin or skip the workout), never merely because time passed. */
  const acknowledgeStudy = (doc, now) => award(doc, 'd' + doc.timer.day + ':s' + doc.timer.session + ':study', CONFIG.XP.study, now);

  /** Applies timestamp-derived transitions. Returns the SAME object when nothing changed. */
  function reconcile(doc, now) {
    const t = doc.timer;
    if (t.state === 'STUDY_RUNNING' && remainingMs(t, now) <= 0) { const d = clone(doc); finishStudy(d); settle(d, now); return d; }
    if (t.state === 'REST_RUNNING' && remainingMs(t, now) <= 0) { const d = clone(doc); finishRest(d, t.phaseStartedAt + t.phaseDurationMs + t.accumulatedPausedMs); settle(d, now); return d; }
    return doc;
  }

  const firstIncomplete = (doc, day) => {
    for (let i = 0; i < CONFIG.SESSIONS_PER_DAY; i++) { const s = findSession(doc, day, i); if (!s || !s.studyComplete) return i; }
    return -1;
  };
  const deriveWorkoutStatus = (a, b, pa, pb) => (a === 0 && b === 0 ? 'skipped' : a === pa && b === pb ? 'completed' : 'modified');

  function logWorkout(doc, day, idx, input, now, durationMs) {
    const p = plan(day);
    const a = needInt(input.actualPullups, 0, 100, 'Actual pull-ups');
    const b = needInt(input.actualPushups, 0, 500, 'Actual push-ups');
    const status = deriveWorkoutStatus(a, b, p.pullupsPerSet, p.pushupsPerSet);
    const reason = text(input.reason, 200, 'Reason').trim();
    if (status !== 'completed' && !reason) fail('REASON_REQUIRED', 'Add a short reason when the workout was reduced or skipped.');
    upsert(doc.workouts, {
      day, idx, status, plannedPullups: p.pullupsPerSet, actualPullups: a, plannedPushups: p.pushupsPerSet, actualPushups: b,
      durationMs: durationMs == null ? null : durationMs, reason, notes: text(input.notes, 500, 'Notes'), at: now
    }, (w) => w.day === day && w.idx === idx);
    // Fixed XP regardless of reps: volume is never rewarded.
    if (status !== 'skipped') award(doc, 'd' + day + ':s' + idx + ':workout', CONFIG.XP.workout, now);
  }

  /** Pure: returns a new document or throws EngineError. */
  function apply(prev, action, now) {
    const base = reconcile(prev, now);
    const doc = base === prev ? clone(prev) : base;
    const t = doc.timer;
    const badState = () => fail('BAD_STATE', 'That is not possible right now (' + t.state + ').');

    switch (action.type) {
      case 'SETUP': {
        if (doc.challenge.status !== 'setup') fail('ALREADY_STARTED', 'The challenge has already been set up.');
        if (!validIso(action.startDate)) fail('INVALID', 'Enter a valid start date.');
        doc.challenge = {
          status: 'active', startDate: action.startDate, startedAt: now,
          startingMaxPullups: optInt(action.startingMaxPullups, 0, 100, 'Starting max pull-ups'),
          startingWeightKg: optNum(action.startingWeightKg, 20, 400, 'Starting weight')
        };
        break;
      }
      case 'START_SESSION': {
        requireActive(doc);
        if (!WAITING.includes(t.state)) badState();
        const day = checkDay(doc, action.day, now);
        const midDay = t.state === 'SESSION_COMPLETED' || t.state === 'LEVEL_COMPLETED';
        if (!(day === calendarDay(doc, now) || (midDay && day === t.day))) fail('WRONG_DAY', 'Sessions can only be run for today (or to finish the day already in progress).');
        const idx = firstIncomplete(doc, day);
        if (idx < 0) fail('DAY_COMPLETE', 'Day ' + day + ' is already complete.');
        upsert(doc.sessions, { day, idx, level: CONFIG.LEVEL_OF_SESSION[idx], studyStartedAt: now, studyEndedAt: null, studyActualMs: 0, studyComplete: false, restEndedAt: null, completedAt: null }, (s) => s.day === day && s.idx === idx);
        doc.timer = Object.assign(idleTimer(), { state: 'STUDY_RUNNING', day, session: idx, phaseStartedAt: now, phaseDurationMs: CONFIG.STUDY_MS });
        break;
      }
      case 'PAUSE': {
        if (!RUNNING[t.state]) badState();
        t.pausedRemainingMs = remainingMs(t, now);
        t.pausedAt = now;
        t.state = RUNNING[t.state];
        break;
      }
      case 'RESUME': {
        if (!PAUSED[t.state]) badState();
        t.accumulatedPausedMs += Math.max(0, now - t.pausedAt);
        t.pausedAt = null; t.pausedRemainingMs = null;
        t.state = PAUSED[t.state];
        break;
      }
      case 'BEGIN_WORKOUT': {
        if (t.state !== 'WORKOUT_PENDING') badState();
        acknowledgeStudy(doc, now);
        doc.timer = Object.assign(idleTimer(), { state: 'WORKOUT_RUNNING', day: t.day, session: t.session, phaseStartedAt: now });
        break;
      }
      case 'SKIP_WORKOUT': {
        if (t.state !== 'WORKOUT_PENDING') badState();
        const reason = text(action.reason, 200, 'Reason').trim();
        if (!reason) fail('REASON_REQUIRED', 'Add a short reason for skipping.');
        acknowledgeStudy(doc, now);
        logWorkout(doc, t.day, t.session, { actualPullups: 0, actualPushups: 0, reason }, now, null);
        startRest(doc, now);
        break;
      }
      case 'FINISH_WORKOUT': {
        if (t.state !== 'WORKOUT_RUNNING' && t.state !== 'WORKOUT_PAUSED') badState();
        const dur = elapsedMs(t, now);
        doc.timer = Object.assign(idleTimer(), { state: 'WORKOUT_LOGGING', day: t.day, session: t.session, workoutDurationMs: dur });
        break;
      }
      case 'LOG_WORKOUT': {
        if (t.state !== 'WORKOUT_LOGGING') badState();
        logWorkout(doc, t.day, t.session, action, now, t.workoutDurationMs);
        startRest(doc, now);
        break;
      }
      case 'SKIP_REST': {
        if (t.state !== 'REST_RUNNING' && t.state !== 'REST_PAUSED') badState();
        finishRest(doc, now);
        break;
      }
      case 'ABANDON': {
        if (t.state !== 'STUDY_RUNNING' && t.state !== 'STUDY_PAUSED') badState();
        const s = findSession(doc, t.day, t.session);
        s.studyActualMs = Math.min(elapsedMs(t, now), CONFIG.STUDY_MS); s.studyEndedAt = now; s.studyComplete = false;
        doc.timer = idleTimer();
        break;
      }
      case 'SAVE_NUTRITION': {
        const day = checkDay(doc, action.day, now);
        const rec = {
          day, shake1: !!action.shake1, shake2: !!action.shake2, creatine: !!action.creatine,
          waterL: optNum(action.waterL, 0, 20, 'Water'), weightKg: optNum(action.weightKg, 20, 400, 'Body weight'), at: now
        };
        upsert(doc.nutrition, rec, (r) => r.day === day);
        if (rec.shake1 && rec.shake2 && rec.creatine) award(doc, 'd' + day + ':nutrition', CONFIG.XP.nutrition, now);
        break;
      }
      case 'SAVE_RECOVERY': {
        const day = checkDay(doc, action.day, now);
        const w = action.warn || {};
        const rec = { day, sleepH: optNum(action.sleepH, 0, 24, 'Sleep'), energy: optInt(action.energy, 0, 5, 'Energy') };
        SORENESS.forEach((k) => { rec[k] = optInt(action[k], 0, 5, k + ' soreness'); });
        rec.warn = { sharpPain: !!w.sharpPain, jointPain: !!w.jointPain, swelling: !!w.swelling, weakness: !!w.weakness };
        rec.notes = text(action.notes, 500, 'Notes'); rec.at = now;
        upsert(doc.recovery, rec, (r) => r.day === day);
        if (rec.sleepH !== null && rec.energy !== null) award(doc, 'd' + day + ':recovery', CONFIG.XP.recovery, now);
        break;
      }
      case 'SAVE_WORKOUT': {
        const day = checkDay(doc, action.day, now);
        const idx = needInt(action.idx, 0, CONFIG.SESSIONS_PER_DAY - 1, 'Set');
        const busy = ['WORKOUT_PENDING', 'WORKOUT_RUNNING', 'WORKOUT_PAUSED', 'WORKOUT_LOGGING'].includes(t.state) && t.day === day && t.session === idx;
        if (busy) fail('BUSY', 'That set is in progress in Focus Mode.');
        const old = findWorkout(doc, day, idx);
        logWorkout(doc, day, idx, action, now, old ? old.durationMs : null);
        break;
      }
      case 'SAVE_EVAL': {
        requireActive(doc);
        const cal = calendarDay(doc, now);
        const day = needInt(action.day, 16, 17, 'Evaluation day');
        if (day > cal) fail('FUTURE_DAY', 'Day ' + day + ' has not started yet.');
        doc.evaluation = {
          day, maxPullups: needInt(action.maxPullups, 0, 100, 'Max consecutive pull-ups'), technique: optInt(action.technique, 0, 5, 'Technique rating'),
          techniqueNotes: text(action.techniqueNotes, 500, 'Technique notes'), pushupTestReps: optInt(action.pushupTestReps, 0, 1000, 'Push-up test reps'),
          pushupProtocol: text(action.pushupProtocol, 200, 'Push-up protocol'), finalWeightKg: optNum(action.finalWeightKg, 20, 400, 'Final weight'),
          recoveryNote: text(action.recoveryNote, 500, 'Recovery note'), notes: text(action.notes, 500, 'Notes'), at: now
        };
        award(doc, 'eval', CONFIG.XP.evaluation, now);
        break;
      }
      default: fail('UNKNOWN_ACTION', 'Unknown action.');
    }
    settle(doc, now);
    return doc;
  }

  // ---- read models for the UI ----
  function dayStats(doc, day) {
    const sessions = doc.sessions.filter((s) => s.day === day);
    const workouts = doc.workouts.filter((w) => w.day === day);
    const p = plan(day);
    const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
    return {
      day, plan: p,
      sessionsDone: sessions.filter((s) => s.studyComplete).length,
      studyMin: sessions.length ? Math.round(sum(sessions, 'studyActualMs') / MIN) : null,
      workoutsLogged: workouts.length,
      pullups: workouts.length ? sum(workouts, 'actualPullups') : null,
      pushups: workouts.length ? sum(workouts, 'actualPushups') : null,
      nutrition: byDay(doc.nutrition, day) || null,
      recovery: byDay(doc.recovery, day) || null,
      complete: dayComplete(doc, day)
    };
  }
  function levelCounts(doc, day) {
    const c = [0, 0, 0];
    doc.sessions.filter((s) => s.day === day && s.studyComplete).forEach((s) => { c[s.level - 1]++; });
    return c;
  }
  function nutritionConsistency(doc) {
    const n = doc.nutrition.length;
    const ok = doc.nutrition.filter((r) => r.shake1 && r.shake2 && r.creatine).length;
    return { recorded: n, adherent: ok, pct: n ? Math.round((ok / n) * 100) : null };
  }
  function latestRecovery(doc) {
    const r = doc.recovery.slice().sort((a, b) => b.day - a.day)[0];
    if (!r) return null;
    const vals = SORENESS.map((k) => r[k]).filter((v) => v !== null);
    return { day: r.day, energy: r.energy, sleepH: r.sleepH, maxSoreness: vals.length ? Math.max.apply(null, vals) : null, warning: r.warn.sharpPain || r.warn.jointPain || r.warn.swelling || r.warn.weakness };
  }
  /** One row per elapsed day. Missing records stay null - nothing is assumed. */
  function analytics(doc, now) {
    const last = Math.min(Math.max(calendarDay(doc, now), 0), CONFIG.DAYS);
    const rows = []; let cumPull = 0, cumPush = 0;
    for (let d = 1; d <= last; d++) {
      const s = dayStats(doc, d);
      if (s.pullups !== null) cumPull += s.pullups;
      if (s.pushups !== null) cumPush += s.pushups;
      rows.push(Object.assign({ date: dateOfDay(doc, d), levels: levelCounts(doc, d), cumPullups: cumPull, cumPushups: cumPush }, s));
    }
    const totals = planTotals();
    return {
      rows, planned: totals,
      sessionsPlanned: last * CONFIG.SESSIONS_PER_DAY,
      sessionsDone: doc.sessions.filter((s) => s.studyComplete).length,
      studyMinActual: Math.round(doc.sessions.reduce((a, s) => a + s.studyActualMs, 0) / MIN),
      workoutsByStatus: ['completed', 'modified', 'skipped'].reduce((o, k) => { o[k] = doc.workouts.filter((w) => w.status === k).length; return o; }, {}),
      nutrition: nutritionConsistency(doc), daysComplete: daysComplete(doc)
    };
  }
  function evaluationSummary(doc, now) {
    const a = analytics(doc, now);
    const ev = doc.evaluation; const ch = doc.challenge;
    const delta = (x, y) => (typeof x === 'number' && typeof y === 'number' ? Math.round((y - x) * 10) / 10 : null);
    return {
      startMax: ch.startingMaxPullups, finalMax: ev ? ev.maxPullups : null, maxDelta: ev ? delta(ch.startingMaxPullups, ev.maxPullups) : null,
      startWeight: ch.startingWeightKg, finalWeight: ev ? ev.finalWeightKg : null, weightDelta: ev ? delta(ch.startingWeightKg, ev.finalWeightKg) : null,
      daysComplete: a.daysComplete, sessionsDone: a.sessionsDone, sessionsPlanned: CONFIG.DAYS * CONFIG.SESSIONS_PER_DAY,
      pullupsActual: doc.workouts.reduce((s, w) => s + w.actualPullups, 0), pullupsPlanned: a.planned.pullups,
      workouts: a.workoutsByStatus, recovery: latestRecovery(doc)
    };
  }
  /** What the main button should do and say. */
  function nextAction(doc, now) {
    const t = doc.timer;
    if (doc.challenge.status === 'setup') return { kind: 'setup' };
    if (!WAITING.includes(t.state)) return { kind: 'resume', day: t.day };
    const cal = calendarDay(doc, now);
    if (cal < 1) return { kind: 'wait', note: 'Day 1 starts on ' + doc.challenge.startDate + '.' };
    if (cal > CONFIG.DAYS) {
      const midDay = (t.state === 'SESSION_COMPLETED' || t.state === 'LEVEL_COMPLETED') && firstIncomplete(doc, t.day) >= 0;
      return midDay ? { kind: 'continue', day: t.day, session: firstIncomplete(doc, t.day) } : { kind: 'evaluate' };
    }
    const midDay = t.state === 'SESSION_COMPLETED' || t.state === 'LEVEL_COMPLETED';
    const day = midDay ? t.day : cal;
    const idx = firstIncomplete(doc, day);
    if (idx < 0) return { kind: 'day-done', day };
    return { kind: midDay ? 'continue' : 'start', day, session: idx };
  }
  function focusModel(doc, now) {
    const t = doc.timer;
    const paused = !!PAUSED[t.state];
    const study = t.state.startsWith('STUDY'), rest = t.state.startsWith('REST'), work = t.state.startsWith('WORKOUT');
    const rem = remainingMs(t, now);
    return {
      state: t.state, paused, level: t.session == null ? null : CONFIG.LEVEL_OF_SESSION[t.session], session: t.session == null ? null : t.session + 1, day: t.day,
      phase: study ? 'DEEP WORK' : rest ? 'REST' : work ? 'WORKOUT' : '',
      countUp: t.state === 'WORKOUT_RUNNING' || t.state === 'WORKOUT_PAUSED',
      ms: rem !== null ? rem : (t.state === 'WORKOUT_RUNNING' || t.state === 'WORKOUT_PAUSED' ? elapsedMs(t, now) : 0),
      progress: t.phaseDurationMs ? Math.min(1, elapsedMs(t, now) / t.phaseDurationMs) : 0
    };
  }
  /** Per-session node states for the progression map of one day. */
  function mapNodes(doc, day) {
    const t = doc.timer;
    const here = (i) => t.day === day && t.session === i;
    const nodes = [];
    for (let i = 0; i < CONFIG.SESSIONS_PER_DAY; i++) {
      const s = findSession(doc, day, i), w = findWorkout(doc, day, i);
      nodes.push({
        idx: i, level: CONFIG.LEVEL_OF_SESSION[i],
        study: s && s.studyComplete ? 'done' : here(i) && (t.state === 'STUDY_RUNNING' || t.state === 'STUDY_PAUSED') ? 'current' : 'todo',
        workout: w ? w.status : here(i) && ['WORKOUT_PENDING', 'WORKOUT_RUNNING', 'WORKOUT_PAUSED', 'WORKOUT_LOGGING'].includes(t.state) ? 'current' : 'todo',
        rest: s && s.restEndedAt ? 'done' : here(i) && (t.state === 'REST_RUNNING' || t.state === 'REST_PAUSED') ? 'current' : 'todo'
      });
    }
    return nodes;
  }

  return {
    CONFIG, TZ, SORENESS, ACHIEVEMENTS, EngineError, emptyDoc, apply, reconcile, elapsedMs, remainingMs,
    isoToday, addDays, diffDays, calendarDay, dateOfDay, plan, planTotals, dayComplete, daysComplete, streak,
    dayStats, levelCounts, nutritionConsistency, latestRecovery, analytics, evaluationSummary, nextAction, focusModel, mapNodes, firstIncomplete
  };
});
