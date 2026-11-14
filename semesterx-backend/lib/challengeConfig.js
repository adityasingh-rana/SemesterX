'use strict';
// Single source of truth for the server. public/challenge-engine.js carries an identical
// CONFIG for the browser; tests/challenge.parity.test.js fails if the two ever diverge.
const MIN = 60000;

module.exports = Object.freeze({
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
