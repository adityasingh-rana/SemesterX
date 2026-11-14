'use strict';
const express = require('express');
const auth = require('../middleware/challengeAuth');
const { createController, mongooseStore } = require('../controllers/challengeController');

/**
 * Every request: no-store -> origin guard -> JSON body (256 KB cap) -> login/logout -> auth -> DB connect -> data routes.
 * Unauthenticated requests never reach the database.
 */
function build(deps = {}) {
  const store = deps.store || mongooseStore();
  const connect = deps.connect || (() => require('../config/db')());
  const controller = createController({ store, now: deps.now }); // deps.now: tests only
  const router = express.Router();

  // Express 5 forwards rejected promises to the error handler below.
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.use(auth.originGuard);
  router.use(express.json({ limit: '256kb' }));

  router.post('/login', auth.login);
  router.post('/logout', auth.logout);

  router.use(auth.requireAuth);
  router.use(async (req, res, next) => {
    try { await connect(); next(); }
    catch (e) {
      console.error('Challenge: database connection error:', e && e.message);
      res.status(503).json({ success: false, code: 'DB_UNAVAILABLE', message: 'The database is unavailable. Nothing was saved.' });
    }
  });

  router.get('/', controller.get);
  router.put('/', controller.put);
  router.delete('/', controller.del);

  router.use((req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Unknown challenge endpoint.' }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const type = err && err.type;
    if (type === 'entity.too.large') return res.status(413).json({ success: false, code: 'TOO_LARGE', message: 'The request is too large.' });
    if (type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ success: false, code: 'INVALID', message: 'The request body is not valid JSON.' });
    console.error('Challenge: unexpected error:', err && err.message);
    return res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Unexpected server error. Nothing was saved.' });
  });

  return router;
}

module.exports = build();
module.exports.build = build;
