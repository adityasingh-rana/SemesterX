'use strict';
// Static isolation checks: by construction, challenge code cannot touch academic data or browser storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('backend challenge code never references the academic collection, model, controller or route', () => {
  for (const f of ['lib/challengeValidate.js', 'lib/challengeConfig.js', 'models/ChallengeState.js', 'middleware/challengeAuth.js', 'controllers/challengeController.js', 'routes/challengeRoutes.js']) {
    assert.doesNotMatch(strip(read(f)), /app_state|AppState|stateController|stateRoutes|\/api\/state/, f);
  }
  assert.match(read('models/ChallengeState.js'), /collection: 'challenge_state'/);
});

test('browser challenge code uses no browser storage and never touches the academic key or API', () => {
  for (const f of ['public/challenge-engine.js', 'public/challenge.js']) {
    if (!fs.existsSync(path.join(root, f))) continue;
    const code = strip(read(f));
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|openDatabase|caches\./, f + ' must not use browser storage');
    assert.doesNotMatch(code, /comeback_v1|SemesterXAPI|\/api\/state|\bcommit\s*\(/, f + ' must not touch academic persistence');
  }
});

test('no secrets or password literals in shipped code', () => {
  for (const f of ['middleware/challengeAuth.js', 'routes/challengeRoutes.js', 'public/challenge.js', '.env.example']) {
    if (!fs.existsSync(path.join(root, f))) continue;
    const t = read(f);
    assert.doesNotMatch(t, /mongodb(\+srv)?:\/\/[^\s'"<]+:[^\s'"<]+@/i, f);
    assert.doesNotMatch(t, /SEMESTERX_PASSWORD\s*=\s*\S+/, f);
  }
});
