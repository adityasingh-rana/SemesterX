'use strict';
/**
 * Strict whitelist validation for the challenge document.
 * - Unknown fields are REJECTED (never silently dropped, so nothing is lost without notice).
 * - Returns a sanitized copy; xp.total is recomputed here and never trusted from the client.
 * - checkInvariants() protects history that must never silently disappear.
 */
const C = require('./challengeConfig');

const MAX_MS = 4102444800000; // 2100-01-01
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const XP_KEY = /^(d([1-9]|1[0-5]):s[0-7]:(study|workout)|d([1-9]|1[0-5]):(nutrition|recovery|complete)|eval)$/;
const ACH_KEY = /^[a-z0-9_]{1,40}$/;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const DATA_KEYS = ['schemaVersion', 'challenge', 'timer', 'sessions', 'workouts', 'nutrition', 'recovery', 'evaluation', 'xp', 'achievements'];
const SORENESS = ['back', 'biceps', 'chest', 'shoulders', 'triceps', 'forearms'];

function validateData(input) {
  const errors = [];
  const bad = (p, m) => { if (errors.length < 20) errors.push(p + ': ' + m); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keysOk = (o, keys, p) => {
    if (!isObj(o)) { bad(p, 'must be an object'); return false; }
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(p, 'unknown field "' + k.slice(0, 40) + '"');
    return true;
  };
  const int = (v, min, max, p, nullable) => {
    if (v === null && nullable) return null;
    if (!Number.isInteger(v) || v < min || v > max) { bad(p, 'must be an integer ' + min + '-' + max + (nullable ? ' or null' : '')); return nullable ? null : min; }
    return v;
  };
  const num = (v, min, max, p, nullable) => {
    if (v === null && nullable) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) { bad(p, 'must be a number ' + min + '-' + max + (nullable ? ' or null' : '')); return nullable ? null : min; }
    return v;
  };
  const bool = (v, p) => { if (typeof v !== 'boolean') { bad(p, 'must be true or false'); return false; } return v; };
  const str = (v, max, p) => {
    if (typeof v !== 'string' || v.length > max || CTRL.test(v)) { bad(p, 'must be text up to ' + max + ' characters'); return ''; }
    return v;
  };
  const ms = (v, p, nullable) => int(v, 0, MAX_MS, p, nullable);
  const date = (v, p, nullable) => {
  if (v === null && nullable) return null;

  if (
    typeof v !== 'string' ||
    !ISO_DATE.test(v) ||
    v < '2020-01-01' ||
    v > '2100-01-01'
  ) {
    bad(p, 'must be a valid date YYYY-MM-DD');
    return nullable ? null : '2020-01-01';
  }

  const [y, m, d] = v.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));

  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    bad(p, 'must be a valid calendar date');
    return nullable ? null : '2020-01-01';
  }

  return v;
};
  const list = (arr, max, p, each, keyOf) => {
    if (!Array.isArray(arr)) { bad(p, 'must be a list'); return []; }
    if (arr.length > max) { bad(p, 'too many entries (max ' + max + ')'); return []; }
    const seen = new Set(); const out = [];
    arr.forEach((item, i) => {
      const r = each(item, p + '[' + i + ']');
      const k = keyOf(r);
      if (seen.has(k)) bad(p + '[' + i + ']', 'duplicate record ' + k);
      seen.add(k); out.push(r);
    });
    return out;
  };

  if (!keysOk(input, DATA_KEYS, 'data')) return { ok: false, errors };
  const out = {};
  out.schemaVersion = int(input.schemaVersion, 1, 1, 'schemaVersion');

  // challenge
  const ch = input.challenge;
  if (keysOk(ch, ['status', 'startDate', 'startingMaxPullups', 'startingWeightKg', 'startedAt'], 'challenge')) {
    if (!['setup', 'active', 'completed'].includes(ch.status)) bad('challenge.status', 'must be setup, active or completed');
    out.challenge = {
      status: ch.status,
      startDate: date(ch.startDate, 'challenge.startDate', true),
      startingMaxPullups: int(ch.startingMaxPullups, 0, 100, 'challenge.startingMaxPullups', true),
      startingWeightKg: num(ch.startingWeightKg, 20, 400, 'challenge.startingWeightKg', true),
      startedAt: ms(ch.startedAt, 'challenge.startedAt', true)
    };
    if (ch.status !== 'setup' && !out.challenge.startDate) bad('challenge.startDate', 'required once the challenge has started');
  }

  // timer
  const t = input.timer;
  if (keysOk(t, ['state', 'day', 'session', 'phaseStartedAt', 'phaseDurationMs', 'pausedAt', 'pausedRemainingMs', 'accumulatedPausedMs', 'workoutDurationMs'], 'timer')) {
    if (!C.TIMER_STATES.includes(t.state)) bad('timer.state', 'unknown state');
    out.timer = {
      state: t.state,
      day: int(t.day, 1, C.DAYS, 'timer.day', true),
      session: int(t.session, 0, C.SESSIONS_PER_DAY - 1, 'timer.session', true),
      phaseStartedAt: ms(t.phaseStartedAt, 'timer.phaseStartedAt', true),
      phaseDurationMs: int(t.phaseDurationMs, 0, 4 * 3600000, 'timer.phaseDurationMs', true),
      pausedAt: ms(t.pausedAt, 'timer.pausedAt', true),
      pausedRemainingMs: int(t.pausedRemainingMs, 0, 4 * 3600000, 'timer.pausedRemainingMs', true),
      accumulatedPausedMs: int(t.accumulatedPausedMs, 0, 30 * 86400000, 'timer.accumulatedPausedMs'),
      workoutDurationMs: int(t.workoutDurationMs, 0, 12 * 3600000, 'timer.workoutDurationMs', true)
    };
  }

  const sessionKeys = ['day', 'idx', 'level', 'studyStartedAt', 'studyEndedAt', 'studyActualMs', 'studyComplete', 'restEndedAt', 'completedAt'];
  out.sessions = list(input.sessions, C.DAYS * C.SESSIONS_PER_DAY, 'sessions', (s, p) => {
    if (!keysOk(s, sessionKeys, p)) return { day: 0, idx: 0 };
    const idx = int(s.idx, 0, C.SESSIONS_PER_DAY - 1, p + '.idx');
    const level = int(s.level, 1, 3, p + '.level');
    if (level !== C.LEVEL_OF_SESSION[idx]) bad(p + '.level', 'does not match the session');
    return {
      day: int(s.day, 1, C.DAYS, p + '.day'), idx, level,
      studyStartedAt: ms(s.studyStartedAt, p + '.studyStartedAt'),
      studyEndedAt: ms(s.studyEndedAt, p + '.studyEndedAt', true),
      studyActualMs: int(s.studyActualMs, 0, C.STUDY_MS, p + '.studyActualMs'),
      studyComplete: bool(s.studyComplete, p + '.studyComplete'),
      restEndedAt: ms(s.restEndedAt, p + '.restEndedAt', true),
      completedAt: ms(s.completedAt, p + '.completedAt', true)
    };
  }, (r) => r.day + ':' + r.idx);

  const workoutKeys = ['day', 'idx', 'status', 'plannedPullups', 'actualPullups', 'plannedPushups', 'actualPushups', 'durationMs', 'reason', 'notes', 'at'];
  out.workouts = list(input.workouts, C.DAYS * C.SESSIONS_PER_DAY, 'workouts', (w, p) => {
    if (!keysOk(w, workoutKeys, p)) return { day: 0, idx: 0 };
    if (!['completed', 'modified', 'skipped'].includes(w.status)) bad(p + '.status', 'must be completed, modified or skipped');
    return {
      day: int(w.day, 1, C.DAYS, p + '.day'), idx: int(w.idx, 0, C.SESSIONS_PER_DAY - 1, p + '.idx'), status: w.status,
      plannedPullups: int(w.plannedPullups, 0, 100, p + '.plannedPullups'),
      actualPullups: int(w.actualPullups, 0, 100, p + '.actualPullups'),
      plannedPushups: int(w.plannedPushups, 0, 500, p + '.plannedPushups'),
      actualPushups: int(w.actualPushups, 0, 500, p + '.actualPushups'),
      durationMs: int(w.durationMs, 0, 12 * 3600000, p + '.durationMs', true),
      reason: str(w.reason, 200, p + '.reason'), notes: str(w.notes, 500, p + '.notes'),
      at: ms(w.at, p + '.at')
    };
  }, (r) => r.day + ':' + r.idx);

  out.nutrition = list(input.nutrition, C.DAYS, 'nutrition', (n, p) => {
    if (!keysOk(n, ['day', 'shake1', 'shake2', 'creatine', 'waterL', 'weightKg', 'at'], p)) return { day: 0 };
    return {
      day: int(n.day, 1, C.DAYS, p + '.day'),
      shake1: bool(n.shake1, p + '.shake1'), shake2: bool(n.shake2, p + '.shake2'), creatine: bool(n.creatine, p + '.creatine'),
      waterL: num(n.waterL, 0, 20, p + '.waterL', true), weightKg: num(n.weightKg, 20, 400, p + '.weightKg', true),
      at: ms(n.at, p + '.at')
    };
  }, (r) => String(r.day));

  out.recovery = list(input.recovery, C.DAYS, 'recovery', (r, p) => {
    if (!keysOk(r, ['day', 'sleepH', 'energy', ...SORENESS, 'warn', 'notes', 'at'], p)) return { day: 0 };
    const rec = { day: int(r.day, 1, C.DAYS, p + '.day'), sleepH: num(r.sleepH, 0, 24, p + '.sleepH', true), energy: int(r.energy, 0, 5, p + '.energy', true) };
    SORENESS.forEach((k) => { rec[k] = int(r[k], 0, 5, p + '.' + k, true); });
    const w = r.warn;
    if (keysOk(w, ['sharpPain', 'jointPain', 'swelling', 'weakness'], p + '.warn')) {
      rec.warn = { sharpPain: bool(w.sharpPain, p + '.warn.sharpPain'), jointPain: bool(w.jointPain, p + '.warn.jointPain'), swelling: bool(w.swelling, p + '.warn.swelling'), weakness: bool(w.weakness, p + '.warn.weakness') };
    }
    rec.notes = str(r.notes, 500, p + '.notes'); rec.at = ms(r.at, p + '.at');
    return rec;
  }, (r) => String(r.day));

  if (input.evaluation === null) out.evaluation = null;
  else if (keysOk(input.evaluation, ['day', 'maxPullups', 'technique', 'techniqueNotes', 'pushupTestReps', 'pushupProtocol', 'finalWeightKg', 'recoveryNote', 'notes', 'at'], 'evaluation')) {
    const e = input.evaluation;
    if (!C.EVAL_DAYS.includes(e.day)) bad('evaluation.day', 'must be 16 or 17');
    out.evaluation = {
      day: e.day, maxPullups: int(e.maxPullups, 0, 100, 'evaluation.maxPullups'), technique: int(e.technique, 0, 5, 'evaluation.technique', true),
      techniqueNotes: str(e.techniqueNotes, 500, 'evaluation.techniqueNotes'), pushupTestReps: int(e.pushupTestReps, 0, 1000, 'evaluation.pushupTestReps', true),
      pushupProtocol: str(e.pushupProtocol, 200, 'evaluation.pushupProtocol'), finalWeightKg: num(e.finalWeightKg, 20, 400, 'evaluation.finalWeightKg', true),
      recoveryNote: str(e.recoveryNote, 500, 'evaluation.recoveryNote'), notes: str(e.notes, 500, 'evaluation.notes'), at: ms(e.at, 'evaluation.at')
    };
  } else out.evaluation = null;

  // xp: awarded keys are idempotency keys; total is always recomputed here.
  const xp = input.xp;
  out.xp = { awarded: {}, total: 0 };
  if (keysOk(xp, ['awarded', 'total'], 'xp')) {
    if (!isObj(xp.awarded)) bad('xp.awarded', 'must be an object');
    else {
      const keys = Object.keys(xp.awarded);
      if (keys.length > 200) bad('xp.awarded', 'too many entries');
      else for (const k of keys) {
        if (!XP_KEY.test(k)) { bad('xp.awarded', 'unknown award key "' + k.slice(0, 40) + '"'); continue; }
        const a = xp.awarded[k];
        if (!keysOk(a, ['amt', 'at'], 'xp.awarded.' + k)) continue;
        const rec = { amt: int(a.amt, 1, 200, 'xp.awarded.' + k + '.amt'), at: ms(a.at, 'xp.awarded.' + k + '.at') };
        out.xp.awarded[k] = rec; out.xp.total += rec.amt;
      }
    }
  }

  out.achievements = {};
  if (!isObj(input.achievements)) bad('achievements', 'must be an object');
  else {
    const keys = Object.keys(input.achievements);
    if (keys.length > 40) bad('achievements', 'too many entries');
    else for (const k of keys) {
      if (!ACH_KEY.test(k)) { bad('achievements', 'invalid key'); continue; }
      out.achievements[k] = ms(input.achievements[k], 'achievements.' + k);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/** History that must never silently disappear or change. `prev` and `next` are validated data objects. */
function checkInvariants(prev, next) {
  const errs = [];
  for (const [k, v] of Object.entries((prev.xp && prev.xp.awarded) || {})) {
    const n = next.xp.awarded[k];
    if (!n || n.amt !== v.amt) errs.push('XP award "' + k + '" cannot be removed or changed');
  }
  if (prev.challenge && prev.challenge.status !== 'setup' && prev.challenge.startDate !== next.challenge.startDate) {
    errs.push('startDate is locked once the challenge has started');
  }
  for (const s of prev.sessions || []) {
    if (!s.studyComplete) continue;
    const n = next.sessions.find((x) => x.day === s.day && x.idx === s.idx);
    if (!n || !n.studyComplete) errs.push('completed study session d' + s.day + ':s' + s.idx + ' cannot be reverted');
  }
  return errs.slice(0, 10);
}

/** The data fields of a stored/lean Mongo document, without Mongo bookkeeping. */
function pickData(doc) {
  const o = {};
  for (const k of DATA_KEYS) o[k] = doc[k];
  return o;
}

module.exports = { validateData, checkInvariants, pickData, DATA_KEYS };
