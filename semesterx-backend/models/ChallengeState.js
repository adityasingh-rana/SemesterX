'use strict';
const mongoose = require('mongoose');

/**
 * Collection `challenge_state` (created lazily on the first successful write).
 * One single-user document, _id "primary". Completely separate from `app_state`.
 *
 * Sub-trees use Mixed on purpose: lib/challengeValidate.js is the ONE strict, tested definition of
 * their shape, and every write passes through it. A second typed copy here could silently drop
 * fields if the two ever drifted apart.
 */
const { Mixed } = mongoose.Schema.Types;

const schema = new mongoose.Schema(
  {
    _id: { type: String, default: 'primary' },
    schemaVersion: { type: Number, default: 1 },
    rev: { type: Number, required: true, min: 1 },
    lastOpId: { type: String, default: '' },
    challenge: { type: Mixed, required: true },
    timer: { type: Mixed, required: true },
    sessions: { type: Mixed, default: [] },
    workouts: { type: Mixed, default: [] },
    nutrition: { type: Mixed, default: [] },
    recovery: { type: Mixed, default: [] },
    evaluation: { type: Mixed, default: null },
    xp: { type: Mixed, required: true },
    achievements: { type: Mixed, default: {} }
  },
  { collection: 'challenge_state', versionKey: false, timestamps: true, minimize: false }
);

module.exports = mongoose.models.ChallengeState || mongoose.model('ChallengeState', schema);
