'use strict';
/**
 * REAL MongoDB test. Skipped unless you provide a THROWAWAY database:
 *   TEST_MONGODB_URI=<connection string>  TEST_DB_NAME=test_semesterx_challenge  npm test
 * Safety: TEST_DB_NAME must start with "test_" and differ from DB_NAME; the whole test database is dropped at the end.
 * This file was NOT executed where the patch was authored (no database or network there). Run it before trusting
 * the Mongoose store: it covers atomic revision checks, a real concurrent-write race, and academic-collection isolation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/challenge-engine.js');

const URI = process.env.TEST_MONGODB_URI, DB = process.env.TEST_DB_NAME;
const skip = !URI || !DB ? 'set TEST_MONGODB_URI and TEST_DB_NAME (a throwaway database named test_...) to run' : false;
if (!skip && (!/^test_/.test(DB) || DB === process.env.DB_NAME)) throw new Error('Refusing to run: TEST_DB_NAME must start with "test_" and differ from DB_NAME.');

const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

test('real MongoDB: revision control, concurrent writes, lazy collection creation, academic isolation', { skip }, async () => {
  const mongoose = require('mongoose');
  const { createController, mongooseStore } = require('../controllers/challengeController');
  await mongoose.connect(URI, { dbName: DB });
  try {
    const academic = mongoose.connection.collection('app_state');
    await academic.insertOne({ _id: 'primary', data: { subjects: [], sentinel: 'academic-data' }, schemaVersion: 1 });
    const academicBefore = JSON.stringify(await academic.findOne({ _id: 'primary' }));
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    assert.ok(!names.includes('challenge_state'), 'the challenge collection must not exist before the first write');

    const ctl = createController({ store: mongooseStore() });
    const put = async (rev, data, opId) => { const r = res(); await ctl.put({ body: { rev, opId, data } }, r); return r; };
    const get = async () => { const r = res(); await ctl.get({}, r); return r; };
    const T0 = Date.parse('2026-11-12T00:30:00Z');
    const d0 = E.apply(E.emptyDoc(), { type: 'SETUP', startDate: '2026-11-12', startingMaxPullups: 5 }, T0);

    assert.equal((await get()).body.exists, false);
    const created = await put(0, d0, 'db-test-op-0001');
    assert.equal(created.code, 200); assert.equal(created.body.rev, 1);
    assert.equal((await put(0, d0, 'db-test-op-0002')).code, 409, 'creating twice conflicts');
    assert.equal((await put(0, d0, 'db-test-op-0001')).code, 200, 'a replay of the same opId is idempotent');

    const d1 = E.apply(d0, { type: 'SAVE_NUTRITION', day: 1, shake1: true }, T0 + 1000);
    const [a, b] = await Promise.all([put(1, d1, 'db-test-op-0003'), put(1, E.apply(d0, { type: 'SAVE_NUTRITION', day: 1, shake2: true }, T0 + 1000), 'db-test-op-0004')]);
    assert.deepEqual([a.code, b.code].sort(), [200, 409], 'exactly one of two concurrent writes with the same rev wins');
    const now = await get();
    assert.equal(now.body.rev, 2);
    assert.deepEqual(Object.keys(now.body.data).sort(), ['achievements', 'challenge', 'evaluation', 'nutrition', 'recovery', 'schemaVersion', 'sessions', 'timer', 'workouts', 'xp']);

    const wiped = JSON.parse(JSON.stringify(now.body.data)); wiped.challenge.startDate = '2026-12-01';
    assert.equal((await put(2, wiped, 'db-test-op-0005')).code, 400, 'start date is locked once started');

    const del = res(); await ctl.del({ body: { rev: 2, confirm: 'RESET CHALLENGE' } }, del);
    assert.equal(del.code, 200); assert.equal((await get()).body.exists, false);

    assert.equal(JSON.stringify(await academic.findOne({ _id: 'primary' })), academicBefore, 'the academic document was never modified');
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
