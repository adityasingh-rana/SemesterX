'use strict';
/**
 * Browser tests (headless Chromium via Playwright). NOT part of `npm test` (Playwright is not a project dependency).
 *   npm i --no-save playwright && npx playwright install chromium && node tests/e2e/run.js
 * Optional: UNPATCHED_PUBLIC=<path to the ORIGINAL public dir> also proves the security test fails on unpatched code.
 */
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, BASE } = require('./server');
const E = require('../../public/challenge-engine.js');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright is not installed (see header of this file).'); process.exit(2); }

const PUB = path.join(__dirname, '..', '..', 'public');
const PW = 'e2e password 4821';
process.env.SEMESTERX_PASSWORD = PW; process.env.SEMESTERX_LOGIN_DELAY_MS = '0';
const MIN = 60000;
const only = process.argv[2];

const academicSeed = () => ({
  v: 2, lastBackup: '', subjects: [{ id: 'sub1', name: 'Maths', modules: [{ id: 'mod1', name: 'Calculus', topics: [{ id: 'top1', name: 'Limits', diff: 'Medium', imp: 'High', s: true, a: false, r1: false, r2: false, p: false, w: false, notes: '', res: [] }] }] }],
  tx: [{ d: '2026-11-12', t: 1, amt: 10, label: 'Seed XP', key: 'top1:s' }], aw: { 'top1:s': 1 }, ach: {}, missions: [], sessions: [], exams: [], man: {},
  set: { start: '2026-11-09', l2: '2026-11-16', l3: '2026-11-22', exam: '2026-11-26', goal: 13, deep: 6, theme: 'dark', sound: 1 }
});

let browser; const results = [];
async function t(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log('PASS  ' + name + '  (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { results.push({ name, ok: false, err: e }); console.log('FAIL  ' + name + '\n        ' + String(e.message).split('\n').slice(0, 4).join('\n        ')); }
}
async function fresh(o = {}) {
  const srv = await startServer({ staticDir: o.staticDir || PUB, academic: o.academic === undefined ? academicSeed() : o.academic });
  if (o.mode) srv.mode = o.mode;
  const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  if (o.clock !== false) await page.clock.install({ time: BASE });
  if (o.init) await page.addInitScript(o.init);
  await page.goto(srv.url + '/');
  await page.waitForSelector('#main');
  return { srv, ctx, page, errors, adv: async (ms) => { srv.skew += ms; await page.clock.fastForward(ms); }, close: async () => { await ctx.close(); await srv.close(); } };
}
const poll = { polling: 100, timeout: 8000 };
const nav = (page) => (page.viewportSize().width < 800 ? page.evaluate(() => go('cx')) : page.locator('#side a', { hasText: 'Execution Challenge' }).click()); // small screens: drawer menu
async function signIn(page) { await nav(page); await page.fill('form[data-cx-form=login] input[name=password]', PW); await page.click('form[data-cx-form=login] button[type=submit]'); }
async function setup(page, start) {
  await page.waitForSelector('form[data-cx-form=setup]');
  if (start) await page.fill('form[data-cx-form=setup] input[name=startDate]', start);
  await page.fill('form[data-cx-form=setup] input[name=startingMaxPullups]', '5');
  await page.fill('form[data-cx-form=setup] input[name=startingWeightKg]', '70.5');
  await page.click('form[data-cx-form=setup] button[type=submit]');
  await page.waitForSelector('.cx-tabs');
}
const savedState = (page) => page.waitForFunction(() => [...document.querySelectorAll('[data-cx-save]')].some((e) => e.textContent.trim() === 'Saved'), null, poll);
const text = (page, sel) => page.locator(sel).first().innerText();
const startSession = async (page) => { await page.click('button[data-cx-act=start]'); await page.waitForSelector('#cx-focus #cx-ftime'); };
async function ready(o) { const c = await fresh(o); await signIn(c.page); await setup(c.page); await savedState(c.page); return c; }
async function apiClient(srv) {
  const r = await fetch(srv.url + '/api/challenge/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (method, body) => { const x = await fetch(srv.url + '/api/challenge/', { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json() }; };
  return { get: () => call('GET'), put: (rev, data) => call('PUT', { rev, opId: 'op' + Math.random().toString(16).slice(2, 12), data }) };
}
const docOf = (srv) => srv.store.peek();
const hostile = '<img src=x onerror=window.__pwn=1>';

(async () => {
  browser = await chromium.launch();

  await t('academic app still renders while the challenge API is failing or hanging', async () => {
    for (const mode of ['error500', 'hang']) {
      const c = await fresh({ mode });
      try {
        assert.ok((await text(c.page, '#main')).length > 20, 'academic main view rendered');
        await c.page.evaluate(() => go('subj'));
        assert.match(await text(c.page, '#main'), /Maths/);
        await nav(c.page);
        assert.match(await text(c.page, '#cx-root'), mode === 'hang' ? /Loading your challenge/ : /Could not load the challenge/);
        await c.page.evaluate(() => go('dash'));
        assert.ok((await text(c.page, '#main')).length > 20, 'can navigate back to the academic dashboard');
        assert.deepEqual(c.errors, [], 'no page errors');
      } finally { await c.close(); }
    }
  });

  await t('sign-in: wrong password rejected, correct password opens setup; no password in page or storage', async () => {
    const c = await fresh();
    try {
      await nav(c.page);
      assert.match(await text(c.page, '#cx-root'), /Enter the challenge password/);
      await c.page.fill('input[name=password]', 'nope'); await c.page.click('form[data-cx-form=login] button[type=submit]');
      await c.page.waitForSelector('.cx-err'); assert.match(await text(c.page, '.cx-err'), /Incorrect password/);
      await c.page.fill('input[name=password]', PW); await c.page.click('form[data-cx-form=login] button[type=submit]');
      await c.page.waitForSelector('form[data-cx-form=setup]');
      const html = await c.page.content();
      assert.ok(!html.includes(PW), 'password never appears in the DOM');
      assert.ok(!(await c.page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).includes(PW));
      assert.deepEqual(c.errors, []);
    } finally { await c.close(); }
  });

  await t('setup uses the entered start date; lobby shows day, remaining days, 8-node map; saved to MongoDB layer', async () => {
    const c = await fresh();
    try {
      await signIn(c.page); await setup(c.page); await savedState(c.page);
      assert.equal((await text(c.page, '.cx-daynum')).trim(), '01');
      assert.match(await text(c.page, '.cx-herometa'), /14 days remaining/);
      assert.equal(await c.page.locator('.cx-map-h .cx-nd.s-todo').count() + await c.page.locator('.cx-map-h .cx-nd.s-current').count(), 8);
      assert.equal(await c.page.locator('.cx-map-h .cx-lv').count(), 3);
      const d = docOf(c.srv);
      assert.equal(d.rev, 1); assert.equal(d.challenge.startDate, '2026-11-12'); assert.equal(d.challenge.startingMaxPullups, 5); assert.equal(d.challenge.status, 'active');
      await c.page.evaluate(() => go('dash')); await nav(c.page);
      await c.page.click('button[data-cx-act=tab][data-tab=log]');
    } finally { await c.close(); }
    const c2 = await fresh();
    try { await signIn(c2.page); await setup(c2.page, '2026-11-10'); assert.equal((await text(c2.page, '.cx-daynum')).trim(), '03', 'day number follows the configured start date'); assert.match(await text(c2.page, '.cx-herometa'), /12 days remaining/); }
    finally { await c2.close(); }
  });

  await t('focus mode: starts, counts down from timestamps, pause freezes the exact time, resume continues', async () => {
    const c = await ready();
    try {
      await startSession(c.page);
      const first = await text(c.page, '#cx-ftime'); assert.match(first, /^(55:00|54:5\d)$/);
      const top = await text(c.page, '.cx-ftop'); assert.match(top, /SEMESTERX/); assert.match(top, /LEVEL 01/); assert.match(top, /SESSION 01/);
      assert.match(await text(c.page, '.cx-flabel'), /DEEP WORK/);
      assert.match(await text(c.page, '.cx-ffoot'), /SESSION 1\/8/);
      assert.match(await text(c.page, '.cx-fdnd'), /Do Not Disturb/);
      assert.equal(await c.page.evaluate(() => getComputedStyle(document.querySelector('#cx-focus')).backgroundColor), 'rgb(0, 0, 0)');
      await c.page.waitForFunction((f) => document.querySelector('#cx-ftime').textContent !== f, first, poll);
      await c.page.click('button[data-cx-act=pause]');
      await c.page.waitForSelector('button[data-cx-act=resume]');
      assert.match(await text(c.page, '.cx-flabel'), /PAUSED/);
      const frozen = await text(c.page, '#cx-ftime'); await c.page.waitForTimeout(1600);
      assert.equal(await text(c.page, '#cx-ftime'), frozen, 'paused time does not move');
      await c.page.click('button[data-cx-act=resume]');
      await c.page.waitForFunction((f) => document.querySelector('#cx-ftime').textContent !== f, frozen, poll);
      await savedState(c.page);
      assert.equal(docOf(c.srv).timer.state, 'STUDY_RUNNING');
      assert.deepEqual(c.errors, []);
    } finally { await c.close(); }
  });

  await t('refresh during an active study block and during a pause restores the exact timer from MongoDB', async () => {
    const c = await ready();
    try {
      await startSession(c.page); await savedState(c.page);
      await c.page.reload(); await c.page.waitForSelector('#cx-focus #cx-ftime');
      const t1 = await text(c.page, '#cx-ftime'); assert.match(t1, /^(55:00|54:\d\d)$/, 'still counting down after refresh');
      await c.page.click('button[data-cx-act=pause]'); await savedState(c.page);
      const frozen = await text(c.page, '#cx-ftime');
      await c.page.reload(); await c.page.waitForSelector('#cx-focus #cx-ftime');
      assert.match(await text(c.page, '.cx-flabel'), /PAUSED/);
      assert.equal(await text(c.page, '#cx-ftime'), frozen, 'paused remaining time identical after refresh');
    } finally { await c.close(); }
  });

  await t('study completes live, workout is manual, reps are explicit, rest runs, next session starts', async () => {
    const c = await ready();
    try {
      await startSession(c.page);
      await c.adv(55 * MIN);
      await c.page.waitForSelector('button[data-cx-act=beginworkout]', poll);
      assert.match(await text(c.page, '.cx-fmain'), /STUDY BLOCK COMPLETE/);
      assert.match(await text(c.page, '.cx-ftarget'), /2.*pull-ups.*50.*incline push-ups/s);
      await c.adv(90 * MIN);
      assert.match(await text(c.page, '.cx-fmain'), /STUDY BLOCK COMPLETE/, 'workout never starts or completes on its own');
      await c.page.click('button[data-cx-act=beginworkout]');
      await c.page.waitForSelector('button[data-cx-act=finishworkout]');
      assert.match(await text(c.page, '.cx-flabel'), /WORKOUT/);
      await c.adv(3 * MIN);
      await c.page.click('button[data-cx-act=finishworkout]');
      await c.page.waitForSelector('form[data-cx-form=logworkout]');
      await c.page.fill('input[name=actualPullups]', '1'); await c.page.fill('input[name=actualPushups]', '30');
      await c.page.click('form[data-cx-form=logworkout] button[type=submit]');
      await c.page.waitForSelector('[data-cx-err]:not([hidden])'); assert.match(await text(c.page, '[data-cx-err]'), /reason/i);
      assert.equal(await c.page.inputValue('input[name=actualPullups]'), '1', 'typed values survive a validation error');
      assert.equal(await c.page.inputValue('input[name=actualPushups]'), '30');
      await c.page.fill('input[name=reason]', 'Shoulder felt tight');
      await c.page.click('form[data-cx-form=logworkout] button[type=submit]');
      await c.page.waitForSelector('button[data-cx-act=skiprest]');
      assert.match(await text(c.page, '.cx-flabel'), /REST/); assert.match(await text(c.page, '#cx-ftime'), /^(05:00|04:5\d)$/);
      await savedState(c.page);
      const d = docOf(c.srv);
      assert.equal(d.workouts[0].status, 'modified'); assert.equal(d.workouts[0].actualPullups, 1); assert.equal(d.workouts[0].plannedPullups, 2);
      assert.ok(d.workouts[0].durationMs >= 3 * MIN);
      assert.equal(d.xp.awarded['d1:s0:study'].amt, 10); assert.equal(d.xp.awarded['d1:s0:workout'].amt, 10);
      await c.adv(5 * MIN);
      await c.page.waitForSelector('#cx-focus button[data-cx-act=start]', poll);
      assert.match(await text(c.page, '.cx-fmain'), /SESSION 01 COMPLETE/);
      await c.page.click('#cx-focus button[data-cx-act=start]');
      await c.page.waitForFunction(() => /SESSION 02/.test(document.querySelector('.cx-ftop').textContent), null, poll);
      assert.match(await text(c.page, '.cx-ffoot'), /SESSION 2\/8/);
      assert.deepEqual(c.errors, []);
    } finally { await c.close(); }
  });

  await t('reopening after a long absence derives completion from timestamps (credited at the real end time)', async () => {
    const c = await ready();
    try {
      await startSession(c.page); await savedState(c.page);
      c.srv.skew += 70 * MIN; // time passes while the tab is closed
      await c.page.reload();
      await c.page.waitForSelector('button[data-cx-act=beginworkout]', poll);
      await savedState(c.page);
      const s = docOf(c.srv).sessions[0];
      assert.equal(s.studyComplete, true);
      assert.equal(s.studyEndedAt - s.studyStartedAt, 55 * MIN, 'credited at the original end, not at reopen time');
      assert.equal(s.studyActualMs, 55 * MIN);
    } finally { await c.close(); }
  });

  await t('fullscreen rejected falls back to full-page; leaving fullscreen never pauses the timer', async () => {
    const c = await ready({ init: () => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('denied')); } });
    try {
      await startSession(c.page);
      assert.ok(await c.page.locator('#cx-focus').isVisible());
      const box = await c.page.locator('#cx-focus').boundingBox(); assert.ok(box.width >= 1270 && box.height >= 890, 'immersive full-page overlay');
      await c.page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
      assert.ok(await c.page.locator('#cx-focus').isVisible());
      assert.ok(await c.page.locator('button[data-cx-act=fs]').isVisible(), 'offers to re-enter fullscreen');
      const a = await text(c.page, '#cx-ftime');
      await c.page.waitForFunction((f) => document.querySelector('#cx-ftime').textContent !== f, a, poll);
      assert.match(await text(c.page, '.cx-flabel'), /DEEP WORK/);
    } finally { await c.close(); }
  });

  await t('leaving fullscreen while typing reps does not wipe the form', async () => {
    const c = await ready();
    try {
      await startSession(c.page); await c.adv(55 * MIN); await c.page.click('button[data-cx-act=beginworkout]'); await c.page.click('button[data-cx-act=finishworkout]');
      await c.page.fill('input[name=actualPullups]', '2'); await c.page.fill('input[name=actualPushups]', '41');
      await c.page.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
      assert.equal(await c.page.inputValue('input[name=actualPushups]'), '41', 'typed value survives a fullscreenchange');
    } finally { await c.close(); }
  });

  await t('exiting focus mode asks for confirmation; leaving keeps the timer running; abandoning records partial time', async () => {
    const c = await ready();
    try {
      await startSession(c.page);
      await c.page.click('button[data-cx-act=focusexit]');
      await c.page.waitForSelector('.cx-modal');
      assert.match(await text(c.page, '.cx-modal'), /Leave Focus Mode/);
      await c.page.click('button[data-cx-act=modalclose]');
      assert.ok(await c.page.locator('#cx-focus').isVisible());
      await c.page.click('button[data-cx-act=focusexit]'); await c.page.click('button[data-cx-act=focusleave]');
      assert.equal(await c.page.locator('#cx-focus').count(), 0);
      assert.match(await text(c.page, '.cx-cta'), /Resume Execution/);
      await c.page.click('button[data-cx-act=openfocus]'); await c.adv(20 * MIN);
      await c.page.click('button[data-cx-act=focusexit]'); await c.page.click('button[data-cx-act=abandon]');
      await savedState(c.page);
      const d = docOf(c.srv);
      assert.equal(d.timer.state, 'IDLE'); assert.equal(d.sessions[0].studyComplete, false); assert.ok(d.sessions[0].studyActualMs >= 19 * MIN);
    } finally { await c.close(); }
  });

  await t('offline: UI says changes are NOT saved (never "Saved"), then recovers and persists', async () => {
    const c = await ready();
    try {
      await startSession(c.page); await savedState(c.page);
      await c.ctx.setOffline(true);
      await c.page.click('button[data-cx-act=pause]');
      await c.page.waitForFunction(() => [...document.querySelectorAll('[data-cx-save]')].some((e) => /NOT saved/.test(e.textContent)), null, poll);
      for (let i = 0; i < 4; i++) { const s = await c.page.evaluate(() => [...document.querySelectorAll('[data-cx-save]')].map((e) => e.textContent.trim())); assert.ok(s.every((x) => x !== 'Saved'), 'must not claim Saved while offline: ' + s); await c.page.waitForTimeout(300); }
      assert.equal(docOf(c.srv).timer.state, 'STUDY_RUNNING', 'server really has not received it');
      await c.ctx.setOffline(false);
      await c.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await savedState(c.page);
      assert.equal(docOf(c.srv).timer.state, 'STUDY_PAUSED', 'the offline change was kept in memory and delivered');
    } finally { await c.close(); }
  });

  await t('conflicts: a change from another device is merged; an unmergeable one is shown and nothing is overwritten', async () => {
    const c = await ready();
    try {
      await startSession(c.page); await savedState(c.page);
      const api = await apiClient(c.srv);
      let cur = await api.get();
      const other = E.apply(cur.body.data, { type: 'SAVE_NUTRITION', day: 1, shake1: true, shake2: true, creatine: true, waterL: 3, weightKg: 70 }, c.srv.now());
      assert.equal((await api.put(cur.body.rev, other)).status, 200);
      await c.page.click('button[data-cx-act=pause]'); // stale revision -> 409 -> rebase
      await c.page.waitForFunction(() => [...document.querySelectorAll('[data-cx-save]')].some((e) => e.textContent.trim() === 'Saved'), null, poll);
      let d = docOf(c.srv);
      assert.equal(d.timer.state, 'STUDY_PAUSED'); assert.equal(d.nutrition.length, 1, 'the other device change survived');
      // unmergeable: other device resumes, then this tab (stale) resumes too
      cur = await api.get();
      const resumed = E.apply(cur.body.data, { type: 'RESUME' }, c.srv.now());
      await api.put(cur.body.rev, resumed);
      await c.page.click('button[data-cx-act=resume]');
      await c.page.waitForSelector('.cx-modal', poll);
      assert.match(await text(c.page, '.cx-modal'), /Newer data on the server/);
      assert.equal(docOf(c.srv).timer.state, 'STUDY_RUNNING', 'server copy untouched while the conflict is open');
      await c.page.click('button[data-cx-act=use-server]');
      await c.page.waitForFunction(() => !document.querySelector('.cx-modal'), null, poll);
      assert.match(await text(c.page, '.cx-flabel'), /DEEP WORK/);
      await savedState(c.page);
    } finally { await c.close(); }
  });

  await t('mobile (390px): vertical path shown, no horizontal scroll, focus time fits, touch targets >= 44px', async () => {
    const c = await ready({ viewport: { width: 390, height: 844 } });
    try {
      assert.ok(await c.page.locator('.cx-path').isVisible(), 'vertical path visible');
      assert.ok(!(await c.page.locator('.cx-map-h').isVisible()), 'horizontal map hidden');
      assert.ok(await c.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll');
      await c.page.locator('button[data-cx-act=start]').waitFor({ state: 'visible' });
      assert.ok((await c.page.locator('button[data-cx-act=start]').boundingBox()).height >= 44);
      await startSession(c.page);
      const r = await c.page.locator('#cx-ftime').boundingBox(); assert.ok(r.width <= 390 && r.x >= 0, 'time fits: ' + JSON.stringify(r));
      assert.ok(await c.page.evaluate(() => document.getElementById('cx-focus').scrollWidth <= window.innerWidth + 1));
      assert.ok((await c.page.locator('button[data-cx-act=pause]').boundingBox()).height >= 44);
    } finally { await c.close(); }
  });

  await t('daily log, nutrition (no protein anywhere), recovery, analytics: only recorded values appear', async () => {
    const c = await ready();
    try {
      await c.page.click('button[data-cx-act=tab][data-tab=log]');
      const row = c.page.locator('form[data-cx-form=workout]').first();
      await row.locator('input[name=actualPullups]').fill('2'); await row.locator('input[name=actualPushups]').fill('50'); await row.locator('button[type=submit]').click();
      await c.page.waitForSelector('.cx-setrow .cx-badge.completed');
      await c.page.locator('form[data-cx-form=nutrition] input[name=shake1]').check();
      await c.page.fill('form[data-cx-form=nutrition] input[name=waterL]', '2.5');
      await c.page.click('form[data-cx-form=nutrition] button[type=submit]');
      await c.page.fill('form[data-cx-form=recovery] input[name=sleepH]', '7');
      await c.page.locator('form[data-cx-form=recovery] input[name=energy][value="4"]').check({ force: true });
      await c.page.locator('form[data-cx-form=recovery] input[name=chest][value="2"]').check({ force: true });
      await c.page.click('form[data-cx-form=recovery] button[type=submit]');
      await savedState(c.page);
      const d = docOf(c.srv);
      assert.equal(d.nutrition[0].shake2, false); assert.equal(d.nutrition[0].waterL, 2.5); assert.equal(d.recovery[0].chest, 2); assert.equal(d.recovery[0].back, null);
      assert.equal(d.xp.total, 15, 'workout 10 + recovery 5; nutrition incomplete earns nothing');
      assert.doesNotMatch(await c.page.content(), /protein|whey/i);
      await c.page.click('button[data-cx-act=tab][data-tab=analytics]');
      assert.equal(await c.page.locator('.cx-fig').count(), 6);
      assert.equal(await c.page.locator('.cx-fig svg').count(), 5, 'weight chart has no data so it draws nothing');
      assert.match(await text(c.page, '.cx-fig:has-text("Body weight")'), /No records yet/, 'missing data stays missing');
      assert.equal(await c.page.locator('.cx-tbl:not(.cx-heat) tbody tr').count(), 1, 'only elapsed days are listed');
      const heat = await text(c.page, '.cx-heat tbody');
      assert.match(heat, /Chest\s*2/); assert.match(heat, /Back\s*·/);
      await c.page.click('button[data-cx-act=tab][data-tab=lobby]');
      assert.match(await text(c.page, '.cx-cols'), /15 XP/); assert.match(await text(c.page, '.cx-cols'), /0 of 1 logged days complete/);
      assert.deepEqual(c.errors, []);
    } finally { await c.close(); }
  });

  await t('evaluation: locked before Day 16, then compares only real entered values', async () => {
    const early = await ready();
    try { await early.page.click('button[data-cx-act=tab][data-tab=eval]'); assert.match(await text(early.page, '#cx-root'), /opens on Day 16/); } finally { await early.close(); }
    const c = await fresh();
    try {
      await signIn(c.page); await setup(c.page, '2026-10-27');
      assert.match(await text(c.page, '.cx-herometa'), /15 days are over/);
      await c.page.click('button[data-cx-act=tab][data-tab=eval]');
      await c.page.fill('form[data-cx-form=eval] input[name=maxPullups]', '8');
      await c.page.fill('form[data-cx-form=eval] input[name=finalWeightKg]', '71');
      await c.page.click('form[data-cx-form=eval] button[type=submit]'); await savedState(c.page);
      const cmp = await text(c.page, '.cx-tbl');
      assert.match(cmp, /Max strict pull-ups\s*5\s*8\s*\+3/); assert.match(cmp, /Body weight\s*70\.5 kg\s*71 kg\s*\+0\.5 kg/);
      assert.equal(docOf(c.srv).evaluation.day, 16); assert.equal(docOf(c.srv).xp.awarded.eval.amt, 50);
    } finally { await c.close(); }
  });

  await t('isolation: challenge use never touches the academic doc, academic XP, localStorage or other browser storage', async () => {
    const seed = academicSeed();
    const c = await fresh({ academic: seed });
    try {
      const before = await c.page.evaluate(async () => ({ ls: Object.keys(localStorage).sort(), xp: XP(), keys: Object.keys(S).sort(), idb: (await indexedDB.databases()).length }));
      await signIn(c.page); await setup(c.page); await startSession(c.page); await c.adv(55 * MIN); await c.page.click('button[data-cx-act=beginworkout]');
      await c.page.click('button[data-cx-act=finishworkout]'); await c.page.fill('input[name=actualPullups]', '2'); await c.page.fill('input[name=actualPushups]', '50');
      await c.page.click('form[data-cx-form=logworkout] button[type=submit]'); await savedState(c.page);
      const after = await c.page.evaluate(async () => ({ ls: Object.keys(localStorage).sort(), xp: XP(), keys: Object.keys(S).sort(), ss: sessionStorage.length, idb: (await indexedDB.databases()).length, lsDump: JSON.stringify(localStorage) }));
      assert.deepEqual(after.ls, before.ls, 'no new localStorage keys'); assert.equal(after.ss, 0); assert.equal(after.idb, before.idb);
      assert.equal(after.xp, before.xp, 'academic XP unchanged by challenge XP'); assert.deepEqual(after.keys, before.keys, 'academic state has no challenge fields');
      assert.ok(!/timer|workout|challenge/i.test(after.lsDump) || !/STUDY|WORKOUT_/.test(after.lsDump), 'no challenge state in localStorage');
      assert.equal(c.srv.academicPuts, 0, 'no academic write happened'); assert.deepEqual(c.srv.academic, c.srv.academicSeed, 'academic document identical');
      assert.ok(docOf(c.srv).xp.total >= 20, 'challenge XP lives in the challenge doc');
      // academic reset must not delete challenge data
      const rev = docOf(c.srv).rev;
      await c.page.evaluate(() => { const s = S.set; S = structuredClone(def); S.set = s; commit(); });
      await c.page.waitForFunction(() => true); await c.page.waitForTimeout(1200);
      assert.ok(c.srv.academicPuts >= 1); assert.equal(docOf(c.srv).rev, rev, 'challenge doc untouched by academic reset'); assert.ok(docOf(c.srv).workouts.length === 1);
      assert.ok(!JSON.stringify(c.srv.academic).includes('workouts'));
    } finally { await c.close(); }
  });

  await t('security patch: hostile academic data cannot run script (and the unpatched original can)', async () => {
    const bad = academicSeed();
    const evil = '"><img src=x onerror=window.__pwn=1>';
    bad.subjects[0].id = 'a' + evil; bad.subjects[0].modules[0].id = "m');window.__pwn=1;('"; bad.subjects[0].modules[0].topics[0].id = "t');window.__pwn=1;('";
    bad.missions = [{ id: "x');window.__pwn=1;('", t: 'Task', sid: evil, top: '', p: hostile, m: hostile, main: false, done: false, d: '2026-11-12' }];
    bad.exams = [{ id: 'e1', s: 'Exam', d: '2026-11-26', t: hostile, n: '' }];
    bad.tx = [{ d: '2026-11-12', t: 1, amt: hostile, label: 'x', key: 'k' }]; bad.set.start = evil; bad.set.exam = evil;
    const run = async (dir) => {
      const c = await fresh({ staticDir: dir, academic: JSON.parse(JSON.stringify(bad)) });
      try {
        const keys = await c.page.evaluate(() => NAV.map((n) => n[0]).filter((k) => k !== 'cx'));
        for (const k of keys) { await c.page.evaluate((v) => { try { go(v) } catch (e) { } }, k); await c.page.waitForTimeout(60); const h = c.page.locator('[onclick*="__pwn"]'); if (await h.count()) { await h.first().click({ force: true, timeout: 800 }).catch(() => { }); } }
        return { pwned: await c.page.evaluate(() => window.__pwn === 1), handlers: await c.page.locator('[onclick*="__pwn"]').count() };
      } finally { await c.close(); }
    };
    const patched = await run(PUB); assert.equal(patched.pwned, false, 'patched app must not execute injected script'); assert.equal(patched.handlers, 0);
    if (process.env.UNPATCHED_PUBLIC) { const orig = await run(process.env.UNPATCHED_PUBLIC); assert.equal(orig.pwned, true, 'sanity: the ORIGINAL code is exploitable with this data, so this test is meaningful'); console.log('        (unpatched original: script executed = ' + orig.pwned + ')'); }
    const ok = await fresh({ academic: academicSeed() });
    try { assert.equal(await ok.page.evaluate(() => S.subjects[0].id + '|' + S.subjects[0].modules[0].topics[0].id), 'sub1|top1', 'legitimate ids are untouched'); } finally { await ok.close(); }
  });

  await t('hostile text saved in challenge notes/reasons is rendered inert everywhere', async () => {
    const c = await fresh();
    try {
      const api = await apiClient(c.srv); const now = c.srv.now();
      let d = E.apply(E.emptyDoc(), { type: 'SETUP', startDate: '2026-10-25', startingMaxPullups: 5, startingWeightKg: 70 }, now);
      d = E.apply(d, { type: 'SAVE_WORKOUT', day: 1, idx: 0, actualPullups: 1, actualPushups: 10, reason: hostile, notes: hostile }, now);
      d = E.apply(d, { type: 'SAVE_RECOVERY', day: 1, sleepH: 7, energy: 3, notes: hostile }, now);
      d = E.apply(d, { type: 'SAVE_EVAL', day: 16, maxPullups: 6, techniqueNotes: hostile, pushupProtocol: hostile, recoveryNote: hostile, notes: hostile }, now);
      assert.equal((await api.put(0, d)).status, 200);
      await signIn(c.page); await c.page.waitForSelector('.cx-tabs');
      for (const tab of ['log', 'analytics', 'eval', 'lobby', 'data']) { await c.page.click('button[data-cx-act=tab][data-tab=' + tab + ']'); await c.page.waitForTimeout(80); }
      await c.page.click('button[data-cx-act=tab][data-tab=log]'); await c.page.click('button[data-cx-act=trackday][data-day="1"]');
      assert.equal(await c.page.locator('form[data-cx-form=workout] input[name=reason]').first().inputValue(), hostile, 'attribute value is escaped and round-trips exactly');
      assert.equal(await c.page.evaluate(() => window.__pwn), undefined);
      assert.equal(await c.page.locator('#cx-root img[src="x"]').count(), 0, 'no injected elements');
      await c.page.click('button[data-cx-act=tab][data-tab=eval]');
      assert.equal(await c.page.locator('textarea[name=notes]').inputValue(), hostile);
      assert.deepEqual(c.errors, []);
    } finally { await c.close(); }
  });

  await t('data tab: export, typed-phrase reset (academic untouched), import into the empty challenge', async () => {
    const c = await ready();
    try {
      await c.page.click('button[data-cx-act=tab][data-tab=data]');
      const [dl] = await Promise.all([c.page.waitForEvent('download'), c.page.click('button[data-cx-act=export]')]);
      const file = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
      assert.equal(file.format, 'semesterx-challenge-v1'); assert.equal(file.data.challenge.startDate, '2026-11-12');
      assert.equal(await c.page.locator('input[data-cx-file=import]').isDisabled(), true, 'import is disabled while data exists');
      await c.page.click('button[data-cx-act=reset]');
      await c.page.fill('#cx-phrase', 'reset'); await c.page.click('button[data-cx-act=doreset]');
      assert.match(await text(c.page, '.cx-modal'), /exactly/);
      await c.page.fill('#cx-phrase', 'RESET CHALLENGE'); await c.page.click('button[data-cx-act=doreset]');
      await c.page.waitForSelector('form[data-cx-form=setup]', poll);
      assert.equal(docOf(c.srv), null); assert.equal(c.srv.academicPuts, 0); assert.deepEqual(c.srv.academic, c.srv.academicSeed);
      await c.page.setInputFiles('input[data-cx-file=import]', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
      await c.page.waitForSelector('.cx-tabs', poll); await savedState(c.page);
      assert.equal(docOf(c.srv).challenge.startDate, '2026-11-12'); assert.equal((await text(c.page, '.cx-daynum')).trim(), '01');
      const bad = await c.page.evaluate(() => 1);
    } finally { await c.close(); }
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, ' + results.length + ' total');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
