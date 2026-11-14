'use strict';
const { validateData, checkInvariants, pickData } = require('../lib/challengeValidate');

const ID = 'primary';
const OP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RESET_PHRASE = 'RESET CHALLENGE';

/** Production store backed by Mongoose. Loaded lazily so tests never need Mongoose. */
function mongooseStore(getModel = () => require('../models/ChallengeState')) {
  return {
    async get() { return getModel().findById(ID).lean(); },
    // Returns null when another request created the document first (duplicate key).
    async create(fields) {
      try { return (await getModel().create({ _id: ID, ...fields })).toObject(); }
      catch (e) { if (e && e.code === 11000) return null; throw e; }
    },
    // Atomic compare-and-set on rev. Returns null when the revision no longer matches.
    async update(expectedRev, fields) {
      return getModel().findOneAndUpdate({ _id: ID, rev: expectedRev }, { $set: fields }, { returnDocument: 'after' }).lean();
    },
    async remove(expectedRev) { return (await getModel().deleteOne({ _id: ID, rev: expectedRev })).deletedCount === 1; }
  };
}

function createController({ store, now = () => Date.now() }) {
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
  const fail = (res, status, code, message, extra) => res.status(status).json({ success: false, code, message, ...extra });
  const conflict = async (res, currentRev) => fail(res, 409, 'REV_CONFLICT', 'The challenge data changed elsewhere. Reload before saving.', { currentRev, serverTime: now() });
  const ok = (res, doc) => res.status(200).json({ success: true, exists: true, rev: doc.rev, updatedAt: doc.updatedAt || null, serverTime: now() });

  return {
    async get(req, res) {
      const doc = await store.get();
      if (!doc) return res.status(200).json({ success: true, exists: false, rev: 0, data: null, updatedAt: null, serverTime: now() });
      return res.status(200).json({ success: true, exists: true, rev: doc.rev, data: pickData(doc), updatedAt: doc.updatedAt || null, serverTime: now() });
    },

    async put(req, res) {
      const b = body(req);
      if (!Number.isInteger(b.rev) || b.rev < 0) return fail(res, 400, 'INVALID', 'rev must be a non-negative integer.');
      if (typeof b.opId !== 'string' || !OP_ID.test(b.opId)) return fail(res, 400, 'INVALID', 'opId is required.');
      const v = validateData(b.data);
      if (!v.ok) return fail(res, 400, 'INVALID', 'The challenge data is not valid.', { errors: v.errors });

      const cur = await store.get();
      // A retried request that already succeeded must not look like a conflict.
      if (cur && cur.lastOpId === b.opId) return ok(res, cur);

      const fields = { ...v.value, lastOpId: b.opId };
      if (!cur) {
        if (b.rev !== 0) return conflict(res, 0);
        const created = await store.create({ ...fields, rev: 1 });
        return created ? ok(res, created) : conflict(res, (await store.get() || { rev: 0 }).rev);
      }
      if (b.rev !== cur.rev) return conflict(res, cur.rev);

      const prev = validateData(pickData(cur));
      if (prev.ok) {
        const broken = checkInvariants(prev.value, v.value);
        if (broken.length) return fail(res, 400, 'INVARIANT', 'That change would erase recorded history.', { errors: broken });
      }
      const updated = await store.update(cur.rev, { ...fields, rev: cur.rev + 1 });
      return updated ? ok(res, updated) : conflict(res, (await store.get() || { rev: 0 }).rev);
    },

    async del(req, res) {
      const b = body(req);
      if (b.confirm !== RESET_PHRASE) return fail(res, 400, 'CONFIRM_REQUIRED', 'Type ' + RESET_PHRASE + ' to confirm.');
      if (!Number.isInteger(b.rev) || b.rev < 0) return fail(res, 400, 'INVALID', 'rev must be a non-negative integer.');
      const cur = await store.get();
      if (!cur) return res.status(200).json({ success: true, exists: false, rev: 0, serverTime: now() });
      if (b.rev !== cur.rev) return conflict(res, cur.rev);
      if (!(await store.remove(cur.rev))) return conflict(res, (await store.get() || { rev: 0 }).rev);
      return res.status(200).json({ success: true, exists: false, rev: 0, serverTime: now() });
    }
  };
}

module.exports = { createController, mongooseStore, RESET_PHRASE };
