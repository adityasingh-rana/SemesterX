/* SemesterX Execution Challenge - browser module (window.CX).
 * - Independent from academic state: own in-memory store, own save queue, own API. Never calls the
 *   academic commit()/save(), never reads or writes any browser storage.
 * - MongoDB (via /api/challenge) is the only persistent copy. If a save cannot reach the server the UI says so.
 * - All dynamic text goes through esc(); no inline JS handlers; ids/params are validated before use. */
(function () {
  'use strict';
  const E = window.CXEngine;
  if (!E) { console.error('Execution Challenge: engine missing'); return; }
  const C = E.CONFIG;
  const MIN = 60000;
  const TABS = ['lobby', 'log', 'analytics', 'eval', 'data'];
  const TAB_LABEL = { lobby: 'Lobby', log: 'Daily log', analytics: 'Analytics', eval: 'Evaluation', data: 'Data' };
  const ACTIVE = ['STUDY_RUNNING', 'STUDY_PAUSED', 'WORKOUT_PENDING', 'WORKOUT_RUNNING', 'WORKOUT_PAUSED', 'WORKOUT_LOGGING', 'REST_RUNNING', 'REST_PAUSED'];
  const RESET_PHRASE = 'RESET CHALLENGE';

  const st = {
    phase: 'idle', doc: null, rev: 0, exists: false, offset: 0,
    save: 'saved', saveDetail: '', notice: '', formError: '',
    tab: 'lobby', trackDay: 1, focus: false, modal: null, conflict: null,
    pending: [], version: 0, sentVersion: 0, saving: false, inflight: null, flushTimer: null, retryTimer: null, backoff: 0, halted: false,
    wake: null, booted: false, loginError: '', busy: false
  };

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (s, r) => (r || document).querySelector(s);
  const now = () => Math.round(Date.now() + st.offset);
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (ms, up) => { const s = up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60); };
  const fmtDate = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '—');
  const numAttr = (v) => (v === null || v === undefined ? '' : String(Number(v)));
  const dash = (v, suffix) => (v === null || v === undefined ? '—' : v + (suffix || ''));
  const opId = () => { const a = new Uint8Array(12); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); }); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const L = (n) => pad(n);

  // ---------- API (credentials via same-origin cookie; nothing stored in the browser) ----------
  async function api(method, path, body, keepalive) {
    const t0 = Date.now();
    let r;
    try {
      r = await fetch('/api/challenge' + path, {
        method, credentials: 'same-origin', keepalive: !!keepalive, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) { const err = new Error('network'); err.network = true; throw err; }
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    if (json && typeof json.serverTime === 'number') st.offset = json.serverTime - Math.round((t0 + Date.now()) / 2);
    return { status: r.status, body: json || {} };
  }

  // ---------- save indicator (never claims "saved" before the server confirmed) ----------
  const SAVE_TEXT = {
    saved: 'Saved', saving: 'Saving…', unsaved: 'Not saved yet', offline: 'Offline — changes are NOT saved. Keep this tab open; retrying.',
    conflict: 'Conflict — resolve it to keep saving.', locked: 'Signed out — changes are NOT saved until you sign in.', error: 'The server rejected the data — NOT saved.'
  };
  function setSave(state, detail) { st.save = state; st.saveDetail = detail || ''; paintSave(); }
  function paintSave() {
    document.querySelectorAll('[data-cx-save]').forEach((el) => {
      el.textContent = SAVE_TEXT[st.save] + (st.saveDetail ? ' ' + st.saveDetail : '');
      el.className = 'cx-save cx-save-' + st.save;
    });
  }
  const dirty = () => st.version !== st.sentVersion;

  const errSlot = () => '<p class="cx-err" data-cx-err role="alert"' + (st.formError ? '' : ' hidden') + '>' + esc(st.formError) + '</p>';
  function paintErrors() { document.querySelectorAll('[data-cx-err]').forEach((el) => { el.textContent = st.formError; el.hidden = !st.formError; }); }
  // ---------- mutations: pure engine action -> in-memory doc -> queued save ----------
  function dispatch(action, opts) {
    if (st.phase !== 'ready') return false;
    if (st.save === 'conflict') { st.notice = 'Resolve the conflict first.'; refresh(); return false; }
    const at = now();
    let next;
    try { next = E.apply(st.doc, action, at); }
    catch (e) {
      if (!(e instanceof E.EngineError)) throw e;
      if (opts && opts.inplace) { st.formError = e.message; paintErrors(); } // keep everything the user typed
      else { st.notice = e.message; refresh(); }
      return false;
    }
    st.doc = next; st.notice = ''; st.formError = '';
    st.pending.push({ action, at });
    markDirty(opts && opts.debounce);
    refresh();
    return true;
  }
  function reconcileNow() {
    if (st.phase !== 'ready' || st.save === 'conflict') return false;
    const at = now();
    const next = E.reconcile(st.doc, at);
    if (next === st.doc) return false;
    st.doc = next; st.pending.push({ reconcile: true, at });
    markDirty();
    return true;
  }
  function markDirty(debounce) {
    st.version++; st.halted = false;
    setSave(st.saving ? 'saving' : 'unsaved');
    clearTimeout(st.flushTimer);
    st.flushTimer = setTimeout(flush, debounce ? 800 : 0);
  }

  async function flush(opts) {
    if (st.saving || st.phase === 'locked' || st.phase !== 'ready' || !dirty() || st.halted || st.save === 'conflict') return;
    clearTimeout(st.retryTimer);
    st.saving = true;
    const v = st.version, snapshot = st.doc, n = st.pending.length;
    if (!st.inflight || st.inflight.version !== v) st.inflight = { version: v, id: opId() };
    setSave('saving');
    try {
      const payload = { rev: st.rev, opId: st.inflight.id, data: snapshot };
      const r = await api('PUT', '/', payload, opts && opts.keepalive && JSON.stringify(payload).length < 60000);
      if (r.status === 200) {
        st.rev = r.body.rev; st.exists = true; st.sentVersion = v; st.pending.splice(0, n); st.inflight = null; st.backoff = 0;
        setSave(dirty() ? 'unsaved' : 'saved');
      } else if (r.status === 401) { st.phase = 'locked'; setSave('locked'); refresh(); }
      else if (r.status === 409) { await rebase(); }
      else if (r.status === 400 || r.status === 413) { st.halted = true; setSave('error', (r.body.errors && r.body.errors[0]) || r.body.message || ''); }
      else { retryLater('Server problem (' + r.status + '). Retrying.'); }
    } catch (e) { if (e.network) retryLater(''); else { st.halted = true; setSave('error', 'Unexpected error.'); console.error(e); } }
    finally {
      st.saving = false;
      if (dirty() && !st.halted && st.save !== 'conflict' && st.phase === 'ready' && !st.retryTimer) { st.flushTimer = setTimeout(flush, 0); }
    }
  }
  function retryLater(detail) {
    setSave('offline', detail);
    st.backoff = Math.min(30000, (st.backoff || 1500) * 2);
    clearTimeout(st.retryTimer);
    st.retryTimer = setTimeout(() => { st.retryTimer = null; flush(); }, st.backoff);
  }

  /** The server has a newer revision: fetch it, then replay every unsaved action on top of it. */
  async function rebase() {
    let r;
    try { r = await api('GET', '/'); } catch (e) { retryLater(''); return; }
    if (r.status === 401) { st.phase = 'locked'; setSave('locked'); refresh(); return; }
    if (r.status !== 200) { retryLater('Could not reload the server copy.'); return; }
    const server = r.body.exists ? r.body.data : E.emptyDoc();
    let doc = server;
    try {
      for (const p of st.pending) doc = p.reconcile ? E.reconcile(doc, p.at) : E.apply(doc, p.action, p.at);
    } catch (e) {
      st.conflict = { server, rev: r.body.rev, exists: !!r.body.exists, reason: e && e.message };
      setSave('conflict'); refresh(); return;
    }
    st.doc = doc; st.rev = r.body.rev; st.exists = !!r.body.exists; st.inflight = null; st.version++;
    setSave('unsaved');
    st.notice = 'Newer data was found on the server. Your unsaved changes were re-applied on top of it.';
    refresh();
  }
  function resolveConflict(useServer) {
    const c = st.conflict; if (!c) return;
    if (!useServer) return;
    st.doc = c.server; st.rev = c.rev; st.exists = c.exists; st.pending = []; st.conflict = null; st.inflight = null;
    st.sentVersion = st.version; st.halted = false; setSave('saved'); st.notice = 'Loaded the server copy. Your unsaved changes were discarded.'; refresh();
  }

  // ---------- loading ----------
  async function load() {
    st.phase = 'loading'; refresh();
    let r;
    try { r = await api('GET', '/'); } catch (e) { st.phase = 'error'; st.notice = 'Could not reach the server. Nothing is lost; try again.'; refresh(); return; }
    if (r.status === 401) { st.phase = 'locked'; refresh(); return; }
    if (r.status === 503 && r.body.code === 'NOT_CONFIGURED') { st.phase = 'unconfigured'; refresh(); return; }
    if (r.status !== 200) { st.phase = 'error'; st.notice = r.body.message || 'The challenge could not be loaded.'; refresh(); return; }
    const hadPending = st.pending.length > 0;
    st.phase = 'ready'; st.exists = !!r.body.exists; st.rev = r.body.rev;
    if (hadPending) { st.doc = r.body.exists ? r.body.data : E.emptyDoc(); await rebase(); }
    else { st.doc = r.body.exists ? r.body.data : E.emptyDoc(); st.sentVersion = st.version; setSave('saved'); }
    st.trackDay = Math.min(Math.max(E.calendarDay(st.doc, now()), 1), C.DAYS);
    reconcileNow();
    if (ACTIVE.includes(st.doc.timer.state)) st.focus = true;
    refresh();
  }
  async function login(pw) {
    st.busy = true; st.loginError = ''; refresh();
    try {
      const r = await api('POST', '/login', { password: pw });
      if (r.status === 200) { st.busy = false; await load(); return; }
      st.loginError = r.status === 429 ? 'Too many attempts. Try again later.' : r.status === 503 ? 'Access is not configured on the server.' : 'Incorrect password.';
    } catch (e) { st.loginError = 'Could not reach the server.'; }
    st.busy = false; refresh();
  }
  async function logout() {
    try { await api('POST', '/logout', {}); } catch (e) { /* cookie expires on its own */ }
    closeFocus(); st.phase = 'locked'; st.doc = null; st.pending = []; st.sentVersion = st.version; refresh();
  }

  // ======================================================================
  // VIEWS
  // ======================================================================
  const safe = (fn, label) => {
    try { return fn(); } catch (e) {
      console.error('Execution Challenge render error (' + (label || 'view') + ')', e);
      return '<div class="cx-panel"><h2>This screen could not be drawn</h2><p class="cx-mu">The rest of SemesterX is not affected. Reload the page to try again.</p></div>';
    }
  };
  const btn = (act, label, attrs, cls) => '<button type="button" class="cx-btn ' + (cls || '') + '" data-cx-act="' + act + '" ' + (attrs || '') + '>' + label + '</button>';

  function view() { return '<div id="cx-root" class="cx">' + safe(rootHtml, 'root') + '</div>'; }

  function rootHtml() {
    const head = '<header class="cx-head"><div><h1>Execution Challenge</h1><p class="cx-mu">Fifteen days of deep work, progressive pull-ups and recovery.</p></div><span data-cx-save role="status" aria-live="polite" class="cx-save"></span></header>';
    if (st.phase !== 'ready') return head + gate();
    const notice = st.notice ? '<div class="cx-notice" role="status">' + esc(st.notice) + ' ' + btn('dismiss', 'Dismiss', '', 'cx-link') + '</div>' : '';
    const needSetup = st.doc.challenge.status === 'setup';
    const tabs = needSetup ? '' : '<nav class="cx-tabs" aria-label="Challenge sections">' + TABS.map((t) => '<button type="button" data-cx-act="tab" data-tab="' + t + '"' + (st.tab === t ? ' aria-current="page"' : '') + '>' + TAB_LABEL[t] + '</button>').join('') + '</nav>';
    const body = needSetup ? safe(setupForm, 'setup') : safe(() => ({ lobby, log: logTab, analytics: analyticsTab, eval: evalTab, data: dataTab }[st.tab] || lobby)(), st.tab);
    return head + tabs + notice + body + (st.focus ? '' : (st.conflict ? safe(conflictPanel) : '') + safe(modalHtml));
  }

  function gate() {
    if (st.phase === 'idle' || st.phase === 'loading') return '<section class="cx-panel"><p class="cx-mu">Loading your challenge…</p></section>';
    if (st.phase === 'unconfigured') return '<section class="cx-panel"><h2>Challenge access is not set up</h2><p class="cx-mu">The server has no challenge password. Set the <code>SEMESTERX_PASSWORD</code> environment variable for this deployment, then reload. Nothing here works without it, on purpose.</p></section>';
    if (st.phase === 'error') return '<section class="cx-panel"><h2>Could not load the challenge</h2><p class="cx-mu">' + esc(st.notice || 'The server could not be reached.') + ' Nothing has been changed.</p>' + btn('retry', 'Try again', '', 'cx-primary') + '</section>';
    return '<section class="cx-panel cx-narrow"><h2>Enter the challenge password</h2><p class="cx-mu">This area is protected separately from your academic data.</p>'
      + '<form data-cx-form="login" autocomplete="off"><label class="cx-f">Password<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label>'
      + (st.loginError ? '<p class="cx-err" role="alert">' + esc(st.loginError) + '</p>' : '')
      + '<button class="cx-btn cx-primary" type="submit"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Checking…' : 'Unlock') + '</button></form></section>';
  }

  function setupForm() {
    const today = E.isoToday(now());
    return '<section class="cx-panel cx-narrow"><h2>Set up the challenge</h2><p class="cx-mu">Days are counted from the start date you choose. It cannot be changed once the challenge begins.</p>'
      + '<form data-cx-form="setup">'
      + '<label class="cx-f">Start date (Day 1)<input type="date" name="startDate" value="' + esc(today) + '" required></label>'
      + '<label class="cx-f">Your starting max strict pull-ups<input type="number" name="startingMaxPullups" min="0" max="100" step="1" inputmode="numeric" placeholder="e.g. 5"></label>'
      + '<label class="cx-f">Your starting body weight (kg)<input type="number" name="startingWeightKg" min="20" max="400" step="0.1" inputmode="decimal" placeholder="e.g. 70.5"></label>'
      + errSlot()
      + '<button class="cx-btn cx-primary" type="submit">Begin challenge</button></form>'
      + '<p class="cx-mu cx-or">Restoring from a backup instead?</p>'
      + '<label class="cx-btn">Import an exported challenge (JSON)<input type="file" accept="application/json,.json" data-cx-file="import" hidden></label></section>';
  }

  // ---------- lobby ----------
  function lobby() {
    const d = st.doc, n = now(), cal = E.calendarDay(d, n), nx = E.nextAction(d, n);
    const day = d.timer.day || Math.min(Math.max(cal, 1), C.DAYS);
    const s = E.dayStats(d, day);
    const level = nx.session != null ? C.LEVEL_OF_SESSION[nx.session] : d.timer.session != null ? C.LEVEL_OF_SESSION[d.timer.session] : null;
    const remaining = cal < 1 ? 'Day 1 starts ' + fmtDate(d.challenge.startDate) : cal > C.DAYS ? 'The 15 days are over' : cal === C.DAYS ? 'Final day' : (C.DAYS - cal) + ' days remaining';
    const strip = Array.from({ length: C.DAYS }, (_, i) => { const k = i + 1, st2 = E.dayStats(d, k); return '<i class="' + (st2.complete ? 'done' : st2.sessionsDone ? 'part' : '') + (k === cal ? ' now' : '') + '" title="Day ' + k + '"></i>'; }).join('');
    let cta;
    if (nx.kind === 'start') cta = btn('start', 'Start Execution', 'data-day="' + nx.day + '"', 'cx-primary cx-big');
    else if (nx.kind === 'continue') cta = btn('start', 'Continue with session ' + (nx.session + 1), 'data-day="' + nx.day + '"', 'cx-primary cx-big');
    else if (nx.kind === 'resume') cta = btn('openfocus', 'Resume Execution', '', 'cx-primary cx-big');
    else if (nx.kind === 'evaluate') cta = btn('tab', 'Open the evaluation', 'data-tab="eval"', 'cx-primary cx-big');
    else cta = '<button class="cx-btn cx-big" disabled>' + (nx.kind === 'day-done' ? 'Day complete' : esc(nx.note || 'Not available yet')) + '</button>';

    const rec = E.latestRecovery(d), nut = E.nutritionConsistency(d);
    const todayNut = s.nutrition, todayRec = s.recovery;
    const row = (k, v, bar) => '<div class="cx-row"><dt>' + k + '</dt><dd>' + v + '</dd>' + (bar === undefined ? '' : '<div class="cx-track" role="presentation"><i style="width:' + Math.max(0, Math.min(100, bar)) + '%"></i></div>') + '</div>';
    const pct = (a, b) => (a === null || !b ? 0 : (a / b) * 100);
    const today = '<section class="cx-panel"><h2>Day ' + day + (day === cal ? ' today' : '') + '</h2><dl class="cx-dl">'
      + row('Focused study', dash(s.studyMin, '') + ' / ' + s.plan.studyMinDay + ' min', pct(s.studyMin, s.plan.studyMinDay))
      + row('Sessions completed', s.sessionsDone + ' / ' + C.SESSIONS_PER_DAY, pct(s.sessionsDone, C.SESSIONS_PER_DAY))
      + row('Pull-ups', dash(s.pullups) + ' / ' + s.plan.pullupsDay + ' planned', pct(s.pullups, s.plan.pullupsDay))
      + row('Incline push-ups', dash(s.pushups) + ' / ' + s.plan.pushupsDay + ' planned', pct(s.pushups, s.plan.pushupsDay))
      + row('Nutrition', todayNut ? (Number(todayNut.shake1) + Number(todayNut.shake2)) + ' of 2 shakes · creatine ' + (todayNut.creatine ? 'taken' : 'not taken') : 'Not logged yet')
      + row('Recovery', todayRec ? 'Energy ' + dash(todayRec.energy, '/5') + (todayRec.warn.sharpPain || todayRec.warn.jointPain || todayRec.warn.swelling || todayRec.warn.weakness ? ' · warning sign noted' : '') : 'Not logged yet')
      + '</dl></section>';
    const so = '<section class="cx-panel"><h2>Challenge so far</h2><dl class="cx-dl">'
      + row('Current streak', E.streak(d, n) + (E.streak(d, n) === 1 ? ' day' : ' days'))
      + row('Days completed', E.daysComplete(d) + ' / ' + C.DAYS, pct(E.daysComplete(d), C.DAYS))
      + row('Challenge XP', d.xp.total + ' XP')
      + row('Nutrition consistency', nut.pct === null ? 'No days logged' : nut.adherent + ' of ' + nut.recorded + ' logged days complete')
      + row('Latest recovery', rec ? 'Day ' + rec.day + ' · energy ' + dash(rec.energy, '/5') + ' · highest soreness ' + dash(rec.maxSoreness, '/5') + (rec.warning ? ' · warning sign' : '') : 'Not logged yet')
      + '</dl></section>';
    const ach = '<section class="cx-panel"><h2>Achievements</h2><ul class="cx-ach">' + E.ACHIEVEMENTS.map((a) => '<li class="' + (d.achievements[a.id] ? 'on' : '') + '"><b>' + esc(a.name) + '</b><span>' + esc(a.desc) + '</span></li>').join('') + '</ul></section>';

    return '<section class="cx-hero"><div class="cx-day"><span class="cx-daynum">' + (cal >= 1 && cal <= C.DAYS ? L(cal) : '—') + '</span><span class="cx-of">of ' + C.DAYS + '</span></div>'
      + '<div class="cx-herometa"><p class="cx-big2">' + esc(remaining) + '</p><p class="cx-mu">' + (level ? 'Level ' + level + ' next' : 'No session in progress') + '</p><div class="cx-strip" role="img" aria-label="Days completed: ' + E.daysComplete(d) + ' of ' + C.DAYS + '">' + strip + '</div></div>'
      + '<div class="cx-cta">' + cta + '</div></section>'
      + safe(() => mapBlock(d, day), 'map') + '<div class="cx-cols">' + today + so + '</div>' + ach;
  }

  // ---------- progression map ----------
  const DONE = { done: 1, completed: 1, modified: 1, skipped: 1 };
  const STATUS_WORD = { done: 'Done', current: 'Now', todo: 'Next', completed: 'Done', modified: 'Reduced', skipped: 'Skipped' };
  function mapBlock(d, day) {
    const nodes = E.mapNodes(d, day), p = E.plan(day);
    const done = nodes.filter((n) => n.study === 'done').length;
    const y = 96, pts = [];
    nodes.forEach((n, i) => { const x0 = 20 + i * 122; pts.push({ x: x0 + 16, kind: 's', st: n.study, n: i + 1 }, { x: x0 + 62, kind: 'w', st: n.workout }, { x: x0 + 94, kind: 'r', st: n.rest }); });
    let g = '';
    for (let i = 0; i < pts.length - 1; i++) g += '<line x1="' + pts[i].x + '" y1="' + y + '" x2="' + pts[i + 1].x + '" y2="' + y + '" class="cx-ln' + (DONE[pts[i].st] ? ' on' : '') + '"/>';
    [[0, 2, 'Level 1'], [3, 5, 'Level 2'], [6, 7, 'Level 3']].forEach((b) => {
      const xa = 20 + b[0] * 122 - 6, xb = 20 + b[1] * 122 + 106;
      g += '<path d="M' + xa + ' 52 V44 H' + xb + ' V52" class="cx-br"/><text x="' + ((xa + xb) / 2) + '" y="30" text-anchor="middle" class="cx-lv">' + b[2] + '</text>';
    });
    pts.forEach((q) => {
      if (q.kind === 's') g += '<circle cx="' + q.x + '" cy="' + y + '" r="16" class="cx-nd s-' + q.st + '"/><text x="' + q.x + '" y="' + (y + 5) + '" text-anchor="middle" class="cx-nt s-' + q.st + '">' + q.n + '</text>';
      else if (q.kind === 'w') g += '<rect x="' + (q.x - 8) + '" y="' + (y - 8) + '" width="16" height="16" transform="rotate(45 ' + q.x + ' ' + y + ')" class="cx-nd w-' + q.st + '"/>';
      else g += '<circle cx="' + q.x + '" cy="' + y + '" r="7" class="cx-nd r-' + q.st + '"/>';
    });
    const svg = '<svg viewBox="0 0 990 140" class="cx-map-h" role="img" aria-label="Day ' + day + ' progression map: ' + done + ' of 8 study sessions complete">' + g + '</svg>';
    const list = '<ol class="cx-path">' + nodes.map((n, i) => {
      const hd = i === 0 || C.LEVEL_OF_SESSION[i] !== C.LEVEL_OF_SESSION[i - 1] ? '<li class="cx-lvh" aria-hidden="true">Level ' + n.level + '</li>' : '';
      const r = (cls, st2, text) => '<div class="cx-pr"><i class="m ' + cls + '-' + st2 + '"></i><span>' + text + '</span><em>' + (STATUS_WORD[st2] || '') + '</em></div>';
      return hd + '<li class="cx-ps">' + r('s', n.study, 'Session ' + (i + 1) + ' · Study 55 min') + r('w', n.workout, 'Workout · ' + p.pullupsPerSet + ' pull-ups, ' + p.pushupsPerSet + ' incline push-ups') + r('r', n.rest, 'Rest 5 min') + '</li>';
    }).join('') + '</ol>';
    return '<section class="cx-panel cx-mapwrap"><div class="cx-maphead"><h2>Day ' + day + ' mission path</h2><p class="cx-mu">' + done + ' of 8 study sessions complete</p></div>' + svg + list
      + '<p class="cx-legend"><span><i class="m s-done"></i>Study</span><span><i class="m w-completed"></i>Workout</span><span><i class="m r-done"></i>Rest</span><span><i class="m w-modified"></i>Reduced</span><span><i class="m w-skipped"></i>Skipped</span></p></section>';
  }

  // ---------- daily log ----------
  function logTab() {
    const d = st.doc, n = now(), cal = E.calendarDay(d, n), day = st.trackDay, p = E.plan(day);
    const chips = '<div class="cx-days" role="group" aria-label="Choose a day">' + Array.from({ length: C.DAYS }, (_, i) => {
      const k = i + 1, ok = cal >= 1 && k <= cal;
      return '<button type="button" data-cx-act="trackday" data-day="' + k + '"' + (k === day ? ' aria-current="true"' : '') + (ok ? '' : ' disabled') + '>' + k + '</button>';
    }).join('') + '</div>';
    if (cal < 1) return chips + '<section class="cx-panel"><p class="cx-mu">Daily logging opens on Day 1 (' + esc(fmtDate(d.challenge.startDate)) + ').</p></section>';

    const sets = Array.from({ length: C.SESSIONS_PER_DAY }, (_, i) => {
      const w = d.workouts.find((x) => x.day === day && x.idx === i);
      const busy = ['WORKOUT_PENDING', 'WORKOUT_RUNNING', 'WORKOUT_PAUSED', 'WORKOUT_LOGGING'].includes(d.timer.state) && d.timer.day === day && d.timer.session === i;
      return '<form class="cx-setrow" data-cx-form="workout"><input type="hidden" name="idx" value="' + i + '">'
        + '<b>Set ' + (i + 1) + '</b><span class="cx-mu">plan ' + p.pullupsPerSet + ' pull-ups · ' + p.pushupsPerSet + ' push-ups</span>'
        + '<label>Pull-ups done<input type="number" name="actualPullups" min="0" max="100" step="1" inputmode="numeric" value="' + numAttr(w && w.actualPullups) + '"' + (busy ? ' disabled' : '') + '></label>'
        + '<label>Push-ups done<input type="number" name="actualPushups" min="0" max="500" step="1" inputmode="numeric" value="' + numAttr(w && w.actualPushups) + '"' + (busy ? ' disabled' : '') + '></label>'
        + '<label>Reason if reduced or skipped<input type="text" name="reason" maxlength="200" value="' + esc(w ? w.reason : '') + '"' + (busy ? ' disabled' : '') + '></label>'
        + '<button class="cx-btn" type="submit"' + (busy ? ' disabled' : '') + '>' + (busy ? 'In Focus Mode' : 'Save set') + '</button>'
        + '<span class="cx-badge ' + (w ? w.status : '') + '">' + (w ? ({ completed: 'Completed', modified: 'Reduced', skipped: 'Skipped' }[w.status]) : 'Not logged') + '</span></form>';
    }).join('');

    const nu = d.nutrition.find((x) => x.day === day) || {};
    const nutrition = '<form class="cx-panel" data-cx-form="nutrition"><h2>Nutrition</h2>'
      + '<label class="cx-ck"><input type="checkbox" name="shake1"' + (nu.shake1 ? ' checked' : '') + '> Shake 1 done</label>'
      + '<label class="cx-ck"><input type="checkbox" name="shake2"' + (nu.shake2 ? ' checked' : '') + '> Shake 2 done</label>'
      + '<label class="cx-ck"><input type="checkbox" name="creatine"' + (nu.creatine ? ' checked' : '') + '> Creatine taken</label>'
      + '<label class="cx-f">Water (litres)<input type="number" name="waterL" min="0" max="20" step="0.1" inputmode="decimal" value="' + numAttr(nu.waterL) + '"></label>'
      + '<label class="cx-f">Body weight (kg)<input type="number" name="weightKg" min="20" max="400" step="0.1" inputmode="decimal" value="' + numAttr(nu.weightKg) + '"></label>'
      + '<button class="cx-btn cx-primary" type="submit">Save nutrition</button></form>';

    const rc = d.recovery.find((x) => x.day === day) || { warn: {} };
    const chip = (name, label, val) => '<fieldset class="cx-chips"><legend>' + label + '</legend>' + ['', 0, 1, 2, 3, 4, 5].map((v) => '<label><input type="radio" name="' + name + '" value="' + v + '"' + (String(val === null || val === undefined ? '' : val) === String(v) ? ' checked' : '') + '><span>' + (v === '' ? '–' : v) + '</span></label>').join('') + '</fieldset>';
    const recovery = '<form class="cx-panel" data-cx-form="recovery"><h2>Recovery</h2>'
      + '<label class="cx-f">Sleep (hours)<input type="number" name="sleepH" min="0" max="24" step="0.25" inputmode="decimal" value="' + numAttr(rc.sleepH) + '"></label>'
      + chip('energy', 'Energy (0 flat – 5 great)', rc.energy)
      + '<p class="cx-mu">Muscle soreness, 0 none – 5 severe. Ordinary soreness is dull, felt in the muscle, and eases with gentle movement. It is not a measure of progress.</p>'
      + [['back', 'Back'], ['biceps', 'Biceps'], ['chest', 'Chest'], ['shoulders', 'Shoulders'], ['triceps', 'Triceps'], ['forearms', 'Forearms']].map((g) => chip(g[0], g[1], rc[g[0]])).join('')
      + '<fieldset class="cx-warn"><legend>Warning signs — stop and consider medical advice</legend>'
      + [['sharpPain', 'Sharp pain'], ['jointPain', 'Joint pain'], ['swelling', 'Swelling'], ['weakness', 'Unusual weakness']].map((w) => '<label class="cx-ck"><input type="checkbox" name="' + w[0] + '"' + (rc.warn[w[0]] ? ' checked' : '') + '> ' + w[1] + '</label>').join('') + '</fieldset>'
      + '<label class="cx-f">Notes<textarea name="notes" maxlength="500" rows="3">' + esc(rc.notes || '') + '</textarea></label>'
      + '<button class="cx-btn cx-primary" type="submit">Save recovery</button></form>';

    return chips + errSlot()
      + '<section class="cx-panel"><h2>Day ' + day + ' workout sets</h2><p class="cx-mu">Enter what you actually did. Nothing is assumed. If the numbers differ from the plan, say why. Reducing or skipping is a valid choice, and volume never earns extra XP.</p>' + sets + '</section>'
      + '<div class="cx-cols">' + nutrition + recovery + '</div>';
  }

  // ---------- analytics ----------
  function barChart(rows, key, planKey, title, unit) {
    const W = 560, H = 170, L0 = 36, B = 22, T = 8, slot = (W - L0 - 6) / C.DAYS;
    const max = Math.max(1, ...rows.map((r) => Math.max(r[key] || 0, planKey(r) || 0)));
    const yv = (v) => T + (H - T - B) * (1 - v / max);
    let g = '';
    [0, 0.5, 1].forEach((f) => { g += '<line x1="' + L0 + '" x2="' + W + '" y1="' + yv(max * f) + '" y2="' + yv(max * f) + '" class="cx-gl"/><text x="' + (L0 - 6) + '" y="' + (yv(max * f) + 3) + '" text-anchor="end" class="cx-ax">' + Math.round(max * f) + '</text>'; });
    for (let i = 0; i < C.DAYS; i++) {
      const r = rows[i], x = L0 + i * slot + 3, w = slot - 6;
      g += '<text x="' + (x + w / 2) + '" y="' + (H - 6) + '" text-anchor="middle" class="cx-ax">' + (i + 1) + '</text>';
      if (!r) continue;
      const pl = planKey(r);
      g += '<rect x="' + x + '" y="' + yv(pl) + '" width="' + w + '" height="' + (H - B - yv(pl)) + '" class="cx-plan"><title>Day ' + r.day + ' plan: ' + pl + unit + '</title></rect>';
      if (r[key] !== null && r[key] !== undefined) g += '<rect x="' + (x + 3) + '" y="' + yv(r[key]) + '" width="' + (w - 6) + '" height="' + Math.max(1, H - B - yv(r[key])) + '" class="cx-act"><title>Day ' + r.day + ' actual: ' + r[key] + unit + '</title></rect>';
    }
    return '<figure class="cx-fig"><figcaption>' + title + '</figcaption><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + '">' + g + '</svg></figure>';
  }
  function lineChart(series, title, unit) { // series: [{name, cls, vals:[15 numbers|null]}]
    const W = 560, H = 170, L0 = 36, B = 22, T = 10, slot = (W - L0 - 12) / (C.DAYS - 1);
    const all = series.flatMap((s) => s.vals).filter((v) => v !== null && v !== undefined);
    if (!all.length) return '<figure class="cx-fig"><figcaption>' + title + '</figcaption><p class="cx-mu cx-empty">No records yet.</p></figure>';
    let lo = Math.min(...all), hi = Math.max(...all); if (hi === lo) { hi += 1; lo -= 1; }
    const pad2 = (hi - lo) * 0.15; lo -= pad2; hi += pad2;
    const xv = (i) => L0 + 6 + i * slot, yv = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    let g = '';
    [0, 0.5, 1].forEach((f) => { const v = lo + (hi - lo) * f; g += '<line x1="' + L0 + '" x2="' + W + '" y1="' + yv(v) + '" y2="' + yv(v) + '" class="cx-gl"/><text x="' + (L0 - 6) + '" y="' + (yv(v) + 3) + '" text-anchor="end" class="cx-ax">' + (Math.round(v * 10) / 10) + '</text>'; });
    for (let i = 0; i < C.DAYS; i++) g += '<text x="' + xv(i) + '" y="' + (H - 6) + '" text-anchor="middle" class="cx-ax">' + (i + 1) + '</text>';
    series.forEach((s) => {
      let path = '', open = false;
      s.vals.forEach((v, i) => { if (v === null || v === undefined) { open = false; return; } path += (open ? 'L' : 'M') + xv(i).toFixed(1) + ' ' + yv(v).toFixed(1); open = true; });
      g += '<path d="' + path + '" class="cx-line ' + s.cls + '"/>';
      s.vals.forEach((v, i) => { if (v !== null && v !== undefined) g += '<circle cx="' + xv(i).toFixed(1) + '" cy="' + yv(v).toFixed(1) + '" r="3" class="cx-dot ' + s.cls + '"><title>Day ' + (i + 1) + ' ' + esc(s.name) + ': ' + v + unit + '</title></circle>'; });
    });
    const legend = series.length > 1 ? '<span class="cx-lgd">' + series.map((s) => '<i class="' + s.cls + '"></i>' + esc(s.name)).join(' ') + '</span>' : '';
    return '<figure class="cx-fig"><figcaption>' + title + legend + '</figcaption><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title) + '">' + g + '</svg></figure>';
  }

  function analyticsTab() {
    const d = st.doc, a = E.analytics(d, now()), rows = a.rows;
    if (!rows.length) return '<section class="cx-panel"><p class="cx-mu">Analytics appear once the challenge has started. Missing days are never filled in.</p></section>';
    const col = (f) => Array.from({ length: C.DAYS }, (_, i) => (rows[i] ? f(rows[i]) : null));
    const cumPlan = (day) => { let s = 0; for (let k = 1; k <= day; k++) s += E.plan(k).pullupsDay; return s; };
    const wk = a.workoutsByStatus, logged = wk.completed + wk.modified + wk.skipped;
    const summary = '<section class="cx-panel"><h2>Summary</h2><dl class="cx-sum">'
      + '<div><dt>Study</dt><dd>' + a.studyMinActual + ' min</dd><small>of ' + rows.length * 440 + ' planned so far</small></div>'
      + '<div><dt>Sessions</dt><dd>' + a.sessionsDone + '</dd><small>of ' + a.sessionsPlanned + ' planned so far</small></div>'
      + '<div><dt>Workouts logged</dt><dd>' + logged + '</dd><small>' + wk.completed + ' as planned · ' + wk.modified + ' reduced · ' + wk.skipped + ' skipped</small></div>'
      + '<div><dt>Days completed</dt><dd>' + a.daysComplete + '</dd><small>of ' + C.DAYS + '</small></div></dl></section>';
    const charts = '<div class="cx-cols">'
      + barChart(rows, 'studyMin', (r) => r.plan.studyMinDay, 'Focused study per day (minutes)', ' min')
      + barChart(rows, 'pullups', (r) => r.plan.pullupsDay, 'Pull-ups per day', '')
      + barChart(rows, 'pushups', (r) => r.plan.pushupsDay, 'Incline push-ups per day', '') 
      + lineChart([{ name: 'Planned', cls: 'p', vals: col((r) => cumPlan(r.day)) }, { name: 'Actual', cls: 'a', vals: col((r) => r.cumPullups) }], 'Cumulative pull-ups', '')
      + lineChart([{ name: 'Weight', cls: 'a', vals: col((r) => (r.nutrition ? r.nutrition.weightKg : null)) }], 'Body weight (kg)', ' kg')
      + lineChart([{ name: 'Sleep (h)', cls: 'a', vals: col((r) => (r.recovery ? r.recovery.sleepH : null)) }, { name: 'Energy (0–5)', cls: 'p', vals: col((r) => (r.recovery ? r.recovery.energy : null)) }], 'Sleep and energy', '')
      + '</div>';
    const sor = E.SORENESS.map((k) => '<tr><th scope="row">' + k[0].toUpperCase() + k.slice(1) + '</th>' + Array.from({ length: C.DAYS }, (_, i) => { const r = rows[i] && rows[i].recovery; const v = r ? r[k] : null; return '<td class="' + (v === null || v === undefined ? 'na' : 'v' + v) + '">' + (v === null || v === undefined ? '·' : v) + '</td>'; }).join('') + '</tr>').join('');
    const soreness = '<section class="cx-panel"><h2>Muscle soreness by group</h2><div class="cx-scroll"><table class="cx-tbl cx-heat"><thead><tr><th></th>' + Array.from({ length: C.DAYS }, (_, i) => '<th>' + (i + 1) + '</th>').join('') + '</tr></thead><tbody>' + sor + '</tbody></table></div><p class="cx-mu">0 none – 5 severe. A dot means nothing was recorded that day.</p></section>';
    const tbl = '<section class="cx-panel"><h2>Day by day</h2><div class="cx-scroll"><table class="cx-tbl"><thead><tr><th>Day</th><th>Date</th><th>Sessions</th><th>Level 1/2/3</th><th>Study min</th><th>Pull-ups</th><th>Push-ups</th><th>Shakes</th><th>Creatine</th><th>Water</th></tr></thead><tbody>'
      + rows.map((r) => '<tr><td>' + r.day + '</td><td>' + esc(fmtDate(r.date)) + '</td><td>' + r.sessionsDone + '/8</td><td>' + r.levels.join(' / ') + '</td><td>' + dash(r.studyMin) + '</td><td>' + dash(r.pullups) + ' / ' + r.plan.pullupsDay + '</td><td>' + dash(r.pushups) + ' / ' + r.plan.pushupsDay + '</td><td>' + (r.nutrition ? Number(r.nutrition.shake1) + Number(r.nutrition.shake2) + '/2' : '—') + '</td><td>' + (r.nutrition ? (r.nutrition.creatine ? 'Yes' : 'No') : '—') + '</td><td>' + (r.nutrition ? dash(r.nutrition.waterL, ' L') : '—') + '</td></tr>').join('')
      + '</tbody></table></div></section>';
    return summary + charts + soreness + tbl;
  }

  // ---------- evaluation ----------
  function evalTab() {
    const d = st.doc, n = now(), cal = E.calendarDay(d, n), ev = d.evaluation;
    const s = E.evaluationSummary(d, n);
    const sign = (v, u) => (v === null ? '—' : (v > 0 ? '+' : '') + v + u);
    const cmp = '<section class="cx-panel"><h2>Starting point vs final</h2><div class="cx-scroll"><table class="cx-tbl"><thead><tr><th></th><th>Start</th><th>Final</th><th>Change</th></tr></thead><tbody>'
      + '<tr><th scope="row">Max strict pull-ups</th><td>' + dash(s.startMax) + '</td><td>' + dash(s.finalMax) + '</td><td>' + sign(s.maxDelta, '') + '</td></tr>'
      + '<tr><th scope="row">Body weight</th><td>' + dash(s.startWeight, ' kg') + '</td><td>' + dash(s.finalWeight, ' kg') + '</td><td>' + sign(s.weightDelta, ' kg') + '</td></tr></tbody></table></div>'
      + '<p class="cx-mu">Only values you entered are compared. A dash means it was not recorded.</p></section>'
      + '<section class="cx-panel"><h2>Challenge record</h2><dl class="cx-dl">'
      + '<div class="cx-row"><dt>Days completed</dt><dd>' + s.daysComplete + ' / ' + C.DAYS + '</dd></div>'
      + '<div class="cx-row"><dt>Study sessions completed</dt><dd>' + s.sessionsDone + ' / ' + s.sessionsPlanned + '</dd></div>'
      + '<div class="cx-row"><dt>Pull-ups recorded</dt><dd>' + s.pullupsActual + ' of ' + s.pullupsPlanned + ' planned</dd></div>'
      + '<div class="cx-row"><dt>Workouts</dt><dd>' + s.workouts.completed + ' as planned · ' + s.workouts.modified + ' reduced · ' + s.workouts.skipped + ' skipped</dd></div>'
      + '<div class="cx-row"><dt>Latest recovery</dt><dd>' + (s.recovery ? 'Day ' + s.recovery.day + ' · energy ' + dash(s.recovery.energy, '/5') + ' · highest soreness ' + dash(s.recovery.maxSoreness, '/5') + (s.recovery.warning ? ' · warning sign noted' : '') : 'Not recorded') + '</dd></div></dl></section>';
    if (cal < C.EVAL_DAYS[0]) return '<section class="cx-panel"><h2>Final evaluation</h2><p>The evaluation opens on Day 16 (' + esc(fmtDate(E.dateOfDay(d, 16))) + '). Day 17 is available if you want 24–48 hours of recovery first.</p></section>' + cmp;
    const e = ev || {};
    const form = '<form class="cx-panel" data-cx-form="eval"><h2>Final evaluation</h2><p class="cx-mu">Enter your real measurements. Nothing is predicted or filled in for you.</p>'
      + '<label class="cx-f">Evaluation day<select name="day">' + C.EVAL_DAYS.map((k) => '<option value="' + k + '"' + ((e.day || 16) === k ? ' selected' : '') + (k > cal ? ' disabled' : '') + '>Day ' + k + '</option>').join('') + '</select></label>'
      + '<label class="cx-f">Max consecutive strict pull-ups<input type="number" name="maxPullups" min="0" max="100" step="1" inputmode="numeric" required value="' + numAttr(e.maxPullups) + '"></label>'
      + '<label class="cx-f">Technique and control (0 poor – 5 excellent)<input type="number" name="technique" min="0" max="5" step="1" inputmode="numeric" value="' + numAttr(e.technique) + '"></label>'
      + '<label class="cx-f">Technique notes<textarea name="techniqueNotes" maxlength="500" rows="2">' + esc(e.techniqueNotes || '') + '</textarea></label>'
      + '<label class="cx-f">Incline push-up test, reps (optional)<input type="number" name="pushupTestReps" min="0" max="1000" step="1" inputmode="numeric" value="' + numAttr(e.pushupTestReps) + '"></label>'
      + '<label class="cx-f">How you ran the push-up test (angle, tempo, rest)<input type="text" name="pushupProtocol" maxlength="200" value="' + esc(e.pushupProtocol || '') + '"></label>'
      + '<label class="cx-f">Final body weight (kg)<input type="number" name="finalWeightKg" min="20" max="400" step="0.1" inputmode="decimal" value="' + numAttr(e.finalWeightKg) + '"></label>'
      + '<label class="cx-f">Recovery condition<textarea name="recoveryNote" maxlength="500" rows="2">' + esc(e.recoveryNote || '') + '</textarea></label>'
      + '<label class="cx-f">Other notes<textarea name="notes" maxlength="500" rows="2">' + esc(e.notes || '') + '</textarea></label>'
      + errSlot()
      + '<button class="cx-btn cx-primary" type="submit">' + (ev ? 'Update evaluation' : 'Save evaluation') + '</button></form>';
    return form + cmp;
  }

  // ---------- data: export / import / reset ----------
  function dataTab() {
    const empty = !st.exists;
    return '<section class="cx-panel"><h2>Backup and restore</h2>'
      + '<p>Challenge data lives in its own MongoDB collection. It is <b>not</b> part of the academic backup, and academic reset or restore never touches it.</p>'
      + '<ul class="cx-list"><li><b>Export</b> downloads a JSON copy of the challenge. Do this before a reset.</li><li><b>Import</b> loads an exported file into an <em>empty</em> challenge only, so it can never overwrite existing records.</li><li><b>Reset</b> permanently deletes the challenge data after you type a confirmation phrase.</li></ul>'
      + '<div class="cx-actions">' + btn('export', 'Export challenge JSON', empty ? 'disabled' : '', '')
      + '<label class="cx-btn' + (empty ? '' : ' cx-off') + '">Import JSON<input type="file" accept="application/json,.json" data-cx-file="import" hidden' + (empty ? '' : ' disabled') + '></label>'
      + btn('reset', 'Reset challenge…', empty ? 'disabled' : '', 'cx-danger') + btn('logout', 'Sign out', '', '') + '</div>'
      + errSlot() + '</section>'
      + '<section class="cx-panel"><h2>Notes</h2><p class="cx-mu">Do Not Disturb cannot be switched on by a web page. Turn it on yourself before you start. Challenge records are saved to the server only; if the connection drops, the screen says so and keeps retrying while this tab stays open.</p></section>';
  }

  function conflictPanel() {
    const c = st.conflict;
    return '<div class="cx-modalbg"><div class="cx-modal" role="alertdialog" aria-modal="true" aria-labelledby="cx-ct"><h2 id="cx-ct">Newer data on the server</h2>'
      + '<p>The challenge was changed somewhere else, and your ' + st.pending.length + ' unsaved change(s) could not be combined with it automatically' + (c.reason ? ' (' + esc(c.reason) + ')' : '') + '.</p>'
      + '<p class="cx-mu">Nothing was overwritten. You can download your unsaved copy first, then load the server version.</p>'
      + '<div class="cx-actions">' + btn('dl-local', 'Download my unsaved copy', '', '') + btn('use-server', 'Load the server version', '', 'cx-primary') + '</div></div></div>';
  }
  function modalHtml() {
    const m = st.modal;
    if (!m) return '';
    return '<div class="cx-modalbg"><div class="cx-modal" role="alertdialog" aria-modal="true" aria-labelledby="cx-mt"><h2 id="cx-mt">' + esc(m.title) + '</h2>' + m.body
      + '<div class="cx-actions">' + m.actions.map((a) => btn(a.act, esc(a.label), a.attrs || '', a.cls || '')).join('') + '</div></div></div>';
  }

  // ======================================================================
  // FOCUS MODE (fixed overlay outside #main: academic render() can never destroy it)
  // ======================================================================
  const WAIT_LABEL = (t) => ({
    SESSION_COMPLETED: 'SESSION ' + L((t.session || 0) + 1) + ' COMPLETE', LEVEL_COMPLETED: 'LEVEL ' + L(C.LEVEL_OF_SESSION[t.session || 0]) + ' COMPLETE',
    DAY_COMPLETED: 'DAY COMPLETE', CHALLENGE_COMPLETED: 'FIFTEEN DAYS COMPLETE'
  }[t.state] || '');
  const fsApi = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  const inFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  function focusHtml() {
    const d = st.doc, t = d.timer, n = now(), m = E.focusModel(d, n), p = E.plan(t.day || 1);
    const top = '<div class="cx-ftop"><span>SEMESTERX</span>' + (m.level ? '<span>LEVEL ' + L(m.level) + '</span>' : '') + (m.session ? '<span>SESSION ' + L(m.session) + '</span>' : '') + '</div>';
    const fb = (act, label, cls) => '<button type="button" class="cx-fbtn ' + (cls || '') + '" data-cx-act="' + act + '">' + label + '</button>';
    let main = '';
    if (t.state === 'STUDY_RUNNING' || t.state === 'STUDY_PAUSED' || t.state === 'REST_RUNNING' || t.state === 'REST_PAUSED' || t.state === 'WORKOUT_RUNNING' || t.state === 'WORKOUT_PAUSED') {
      const label = (m.paused ? 'PAUSED · ' : '') + m.phase;
      main = '<div class="cx-fmain"><div class="cx-ftime" id="cx-ftime" role="timer" aria-live="off">' + clock(m.ms, m.countUp) + '</div><div class="cx-flabel">' + label + '</div>'
        + (m.countUp ? '' : '<div class="cx-fbar" role="presentation"><i id="cx-fprog" style="width:' + (m.progress * 100).toFixed(2) + '%"></i></div>')
        + '<div class="cx-fbtns">' + fb(m.paused ? 'resume' : 'pause', m.paused ? 'RESUME' : 'PAUSE', 'main')
        + (t.state.startsWith('WORKOUT') ? fb('finishworkout', 'FINISH WORKOUT') : '') + (t.state.startsWith('REST') ? fb('skiprest', 'SKIP REST') : '') + '</div></div>';
    } else if (t.state === 'WORKOUT_PENDING') {
      main = '<div class="cx-fmain"><div class="cx-flabel">STUDY BLOCK COMPLETE</div><div class="cx-ftarget">Set ' + ((t.session || 0) + 1) + ' of 8<br><b>' + p.pullupsPerSet + '</b> pull-ups · <b>' + p.pushupsPerSet + '</b> incline push-ups</div>'
        + (st.skipOpen
          ? '<form data-cx-form="skipworkout" class="cx-fform"><label>Why are you skipping this set?<input name="reason" required maxlength="200" autocomplete="off" placeholder="e.g. shoulder pain, very tired"></label>' + errSlot() + '<div class="cx-fbtns"><button class="cx-fbtn main" type="submit">SKIP THIS SET</button>' + fb('skipcancel', 'CANCEL') + '</div></form>'
          : '<div class="cx-fbtns">' + fb('beginworkout', 'BEGIN WORKOUT', 'main') + fb('skipopen', 'SKIP WORKOUT') + '</div>') + '</div>';
    } else if (t.state === 'WORKOUT_LOGGING') {
      const num = (name, label, max) => '<label>' + label + '<input type="number" name="' + name + '" min="0" max="' + max + '" step="1" inputmode="numeric" required></label>';
      main = '<div class="cx-fmain"><div class="cx-flabel">LOG WHAT YOU ACTUALLY DID</div><p class="cx-fnote">Plan: ' + p.pullupsPerSet + ' pull-ups · ' + p.pushupsPerSet + ' incline push-ups. Enter your real numbers. Nothing is assumed.</p>'
        + '<form data-cx-form="logworkout" class="cx-fform">' + num('actualPullups', 'Pull-ups done', 100) + num('actualPushups', 'Incline push-ups done', 500)
        + '<label>Reason, if reduced or skipped<input name="reason" maxlength="200" autocomplete="off" list="cx-reasons"></label><datalist id="cx-reasons"><option value="Fatigue"><option value="Soreness"><option value="Recovery"><option value="Time"></datalist>'
        + '<p class="cx-fwarn">Sharp pain, joint pain, swelling or unusual weakness are warning signs, not normal soreness. Stop and rest.</p>'
        + errSlot() + '<button class="cx-fbtn main" type="submit">SAVE AND START REST</button></form></div>';
    } else {
      const nx = E.nextAction(d, n);
      main = '<div class="cx-fmain"><div class="cx-flabel">' + WAIT_LABEL(t) + '</div><div class="cx-fbtns">' + (nx.kind === 'continue' ? '<button type="button" class="cx-fbtn main" data-cx-act="start" data-day="' + nx.day + '">NEXT SESSION</button>' : '') + fb('focusleave', 'EXIT FOCUS MODE') + '</div></div>';
    }
    const foot = '<div class="cx-ffoot"><span>SESSION ' + (m.session || '–') + '/8</span><span data-cx-save class="cx-save" role="status" aria-live="polite"></span>'
      + (fsApi() ? '<button type="button" class="cx-fbtn ghost" data-cx-act="fs" data-cx-fsbtn' + (inFs() ? ' hidden' : '') + '>FULLSCREEN</button>' : '') + fb('focusexit', 'EXIT', 'ghost') + '</div>'
      + '<p class="cx-fdnd">Turn on Do Not Disturb on your device yourself — a web page cannot do it for you.</p>';
    return top + main + foot + safe(modalHtml) + (st.conflict ? safe(conflictPanel) : '');
  }
  function renderFocus() {
    let el = $('#cx-focus');
    if (!el) { el = document.createElement('div'); el.id = 'cx-focus'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Focus mode'); document.body.appendChild(el); }
    el.innerHTML = safe(focusHtml, 'focus');
    paintSave();
  }
  function requestFs() {
    const el = $('#cx-focus'); const f = el && (el.requestFullscreen || el.webkitRequestFullscreen);
    if (!f) return;
    try { const r = f.call(el); if (r && r.catch) r.catch(() => { /* rejected: the immersive full-page view stays */ }); } catch (e) { /* same */ }
  }
  async function wakeLock() {
    try {
      if (navigator.wakeLock && !st.wake) { st.wake = await navigator.wakeLock.request('screen'); st.wake.addEventListener('release', () => { st.wake = null; }); }
    } catch (e) { /* best effort only */ }
  }
  /** While Focus Mode is open the page behind it is made inert (no tabbing or screen-reader access to it). */
  function setBackgroundInert(on) {
    ['#side', '#main'].forEach((sel) => { const el = $(sel); if (el) { if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
  }
  function openFocus() {
    st.focus = true; st.skipOpen = false; st.origTitle = st.origTitle || document.title;
    renderFocus(); requestFs(); wakeLock();
    document.documentElement.classList.add('cx-noscroll');
    setBackgroundInert(true);
  }
  function closeFocus() {
    st.focus = false; st.skipOpen = false; st.modal = null;
    const el = $('#cx-focus'); if (el) el.remove();
    document.documentElement.classList.remove('cx-noscroll');
    setBackgroundInert(false);
    try { if (inFs()) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) { /* ignore */ }
    if (st.wake) { try { st.wake.release(); } catch (e) { /* ignore */ } st.wake = null; }
    if (st.origTitle) { document.title = st.origTitle; st.origTitle = ''; }
  }
  function cue() {
    try { if (navigator.vibrate) navigator.vibrate([180, 80, 180]); } catch (e) { /* ignore */ }
    try {
      const A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      const c = new A(), o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(c.destination); o.start(); setTimeout(() => { o.stop(); c.close(); }, 350);
    } catch (e) { /* ignore */ }
  }

  /** Called ~4x per second. Updates two text nodes only; never re-renders unless a phase actually ended. */
  function tick() {
    if (st.phase !== 'ready' || !st.doc) return;
    const t = st.doc.timer;
    if (!ACTIVE.includes(t.state)) return;
    const n = now();
    if ((t.state === 'STUDY_RUNNING' || t.state === 'REST_RUNNING') && E.remainingMs(t, n) <= 0) { if (reconcileNow()) { cue(); refresh(); } return; }
    const m = E.focusModel(st.doc, n);
    const te = $('#cx-ftime'); if (te) { const txt = clock(m.ms, m.countUp); if (te.textContent !== txt) te.textContent = txt; }
    const pe = $('#cx-fprog'); if (pe) pe.style.width = (m.progress * 100).toFixed(2) + '%';
    if (st.focus && st.origTitle) document.title = clock(m.ms, m.countUp) + ' · ' + (m.phase || 'Focus');
  }

  // ======================================================================
  // RENDER + EVENTS
  // ======================================================================
  function refresh() {
    safe(() => { const r = $('#cx-root'); if (r) r.innerHTML = safe(rootHtml, 'root'); return ''; }, 'refresh');
    if (st.focus && st.phase === 'ready' && st.doc && st.doc.timer.state !== 'IDLE') renderFocus();
    else if (st.focus) closeFocus();
    paintSave();
  }

  const fv = (fd, k) => { const v = fd.get(k); return v === null ? '' : String(v); };
  const numOrNull = (fd, k) => { const v = fv(fd, k).trim(); return v === '' ? null : Number(v); };
  const flag = (fd, k) => fd.get(k) !== null;
  const dayOf = (el) => { const d = Number(el.dataset.day); return Number.isInteger(d) && d >= 1 && d <= C.DAYS ? d : null; };

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const exportDoc = () => ({ format: 'semesterx-challenge-v1', exportedAt: new Date().toISOString(), data: st.doc });

  async function importFile(file) {
    st.formError = '';
    if (!file || st.exists || st.pending.length) return;
    if (file.size > 250 * 1024) { st.formError = 'That file is too large to be a challenge export.'; refresh(); return; }
    let obj; try { obj = JSON.parse(await file.text()); } catch (e) { st.formError = 'That file is not valid JSON.'; refresh(); return; }
    if (!obj || obj.format !== 'semesterx-challenge-v1' || !obj.data) { st.formError = 'That is not a SemesterX challenge export.'; refresh(); return; }
    try {
      const r = await api('PUT', '/', { rev: 0, opId: opId(), data: obj.data });
      if (r.status === 200) { st.tab = 'lobby'; await load(); st.notice = 'Challenge imported.'; refresh(); return; }
      st.formError = r.status === 409 ? 'A challenge already exists. Import only works into an empty challenge.' : (r.body.errors && r.body.errors[0]) || r.body.message || 'Import failed.';
    } catch (e) { st.formError = 'Could not reach the server. Nothing was imported.'; }
    refresh();
  }
  async function doReset() {
    const typed = ($('#cx-phrase') || {}).value || '';
    if (typed !== RESET_PHRASE) { st.formError = 'Type ' + RESET_PHRASE + ' exactly.'; st.modal.body = modalReset(); refresh(); return; }
    if (st.save !== 'saved') { st.modal = null; st.notice = 'Wait until everything is saved before resetting.'; refresh(); return; }
    try {
      const r = await api('DELETE', '/', { rev: st.rev, confirm: RESET_PHRASE });
      st.modal = null;
      if (r.status === 200) { st.tab = 'lobby'; st.doc = E.emptyDoc(); st.rev = 0; st.exists = false; st.pending = []; st.sentVersion = st.version; closeFocus(); setSave('saved'); st.notice = 'The challenge was reset.'; }
      else if (r.status === 409) { st.notice = 'The challenge changed elsewhere. It was reloaded; nothing was deleted.'; await load(); }
      else st.notice = r.body.message || 'Reset failed. Nothing was deleted.';
    } catch (e) { st.modal = null; st.notice = 'Could not reach the server. Nothing was deleted.'; }
    refresh();
  }
  const modalReset = () => '<p>This permanently deletes every challenge record. Academic data is not affected. Export a copy first if you might want it back.</p><label class="cx-f">Type <b>' + RESET_PHRASE + '</b> to confirm<input id="cx-phrase" autocomplete="off"></label>' + errSlot();

  function handle(act, el) {
    const run = (type, extra) => dispatch(Object.assign({ type }, extra || {}));
    switch (act) {
      case 'tab': { const t = el.dataset.tab; if (TABS.includes(t)) { st.tab = t; st.formError = ''; refresh(); } break; }
      case 'dismiss': st.notice = ''; refresh(); break;
      case 'retry': load(); break;
      case 'logout': logout(); break;
      case 'trackday': { const d = dayOf(el); if (d) { st.trackDay = d; st.formError = ''; refresh(); } break; }
      case 'start': { const d = dayOf(el); if (d && run('START_SESSION', { day: d })) openFocus(); break; }
      case 'openfocus': openFocus(); break;
      case 'pause': run('PAUSE'); break;
      case 'resume': run('RESUME'); break;
      case 'beginworkout': run('BEGIN_WORKOUT'); break;
      case 'skipopen': st.skipOpen = true; st.formError = ''; refresh(); break;
      case 'skipcancel': st.skipOpen = false; st.formError = ''; refresh(); break;
      case 'finishworkout': run('FINISH_WORKOUT'); break;
      case 'skiprest': run('SKIP_REST'); break;
      case 'fs': requestFs(); break;
      case 'focusexit': {
        const s = st.doc.timer.state;
        if (!ACTIVE.includes(s)) { closeFocus(); refresh(); break; }
        const actions = [{ act: 'modalclose', label: 'Stay in Focus Mode', cls: 'cx-primary' }, { act: 'focusleave', label: 'Leave, keep the timer running' }];
        if (s.startsWith('STUDY')) actions.push({ act: 'abandon', label: 'Abandon this study block', cls: 'cx-danger' });
        st.modal = { title: 'Leave Focus Mode?', body: '<p>Your session is still in progress. The timer keeps running while you are away, and you can return from the Lobby.</p>', actions };
        refresh(); break;
      }
      case 'focusleave': st.modal = null; closeFocus(); refresh(); break;
      case 'modalclose': st.modal = null; st.formError = ''; refresh(); break;
      case 'abandon': st.modal = null; if (run('ABANDON')) { closeFocus(); refresh(); } break;
      case 'export': if (st.exists) download('semesterx-challenge-' + E.isoToday(now()) + '.json', exportDoc()); break;
      case 'dl-local': download('semesterx-challenge-UNSAVED-' + E.isoToday(now()) + '.json', exportDoc()); break;
      case 'use-server': resolveConflict(true); break;
      case 'reset': st.formError = ''; st.modal = { title: 'Reset the challenge?', body: modalReset(), actions: [{ act: 'modalclose', label: 'Cancel' }, { act: 'doreset', label: 'Delete everything', cls: 'cx-danger' }] }; refresh(); break;
      case 'doreset': doReset(); break;
      default: break;
    }
  }

  function submit(kind, form) {
    const fd = new FormData(form), d = st.trackDay;
    const submitAction = (action) => dispatch(action, { inplace: true }); // errors shown in place, typed values kept
    switch (kind) {
      case 'login': login(fv(fd, 'password')); break;
      case 'setup': submitAction({ type: 'SETUP', startDate: fv(fd, 'startDate'), startingMaxPullups: numOrNull(fd, 'startingMaxPullups'), startingWeightKg: numOrNull(fd, 'startingWeightKg') }); break;
      case 'workout': submitAction({ type: 'SAVE_WORKOUT', day: d, idx: Number(fv(fd, 'idx')), actualPullups: numOrNull(fd, 'actualPullups'), actualPushups: numOrNull(fd, 'actualPushups'), reason: fv(fd, 'reason') }); break;
      case 'nutrition': submitAction({ type: 'SAVE_NUTRITION', day: d, shake1: flag(fd, 'shake1'), shake2: flag(fd, 'shake2'), creatine: flag(fd, 'creatine'), waterL: numOrNull(fd, 'waterL'), weightKg: numOrNull(fd, 'weightKg') }); break;
      case 'recovery': {
        const a = { type: 'SAVE_RECOVERY', day: d, sleepH: numOrNull(fd, 'sleepH'), energy: numOrNull(fd, 'energy'), notes: fv(fd, 'notes'), warn: { sharpPain: flag(fd, 'sharpPain'), jointPain: flag(fd, 'jointPain'), swelling: flag(fd, 'swelling'), weakness: flag(fd, 'weakness') } };
        E.SORENESS.forEach((k) => { a[k] = numOrNull(fd, k); });
        submitAction(a); break;
      }
      case 'eval': submitAction({ type: 'SAVE_EVAL', day: Number(fv(fd, 'day')), maxPullups: numOrNull(fd, 'maxPullups'), technique: numOrNull(fd, 'technique'), techniqueNotes: fv(fd, 'techniqueNotes'), pushupTestReps: numOrNull(fd, 'pushupTestReps'), pushupProtocol: fv(fd, 'pushupProtocol'), finalWeightKg: numOrNull(fd, 'finalWeightKg'), recoveryNote: fv(fd, 'recoveryNote'), notes: fv(fd, 'notes') }); break;
      case 'logworkout': submitAction({ type: 'LOG_WORKOUT', actualPullups: numOrNull(fd, 'actualPullups'), actualPushups: numOrNull(fd, 'actualPushups'), reason: fv(fd, 'reason') }); break;
      case 'skipworkout': if (submitAction({ type: 'SKIP_WORKOUT', reason: fv(fd, 'reason') })) st.skipOpen = false; break;
      default: break;
    }
  }

  function boot() {
    if (st.booted) return;
    st.booted = true;
    document.addEventListener('click', (ev) => { const el = ev.target.closest && ev.target.closest('[data-cx-act]'); if (el && !el.disabled) handle(el.dataset.cxAct, el); });
    document.addEventListener('submit', (ev) => { const f = ev.target.closest && ev.target.closest('form[data-cx-form]'); if (f) { ev.preventDefault(); submit(f.dataset.cxForm, f); } });
    document.addEventListener('change', (ev) => { const i = ev.target.closest && ev.target.closest('[data-cx-file="import"]'); if (i && i.files && i.files[0]) { importFile(i.files[0]); i.value = ''; } });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (dirty() && st.phase === 'ready') flush({ keepalive: true }); }
      else { tick(); if (st.focus) wakeLock(); if (dirty() && st.phase === 'ready') flush(); }
    });
    // Only toggle the button: re-rendering here would wipe anything being typed (e.g. reps) when Esc leaves fullscreen.
    document.addEventListener('fullscreenchange', () => { const b = $('[data-cx-fsbtn]'); if (b) b.hidden = inFs(); });
    window.addEventListener('online', () => { if (dirty()) { st.backoff = 0; flush(); } });
    window.addEventListener('pagehide', () => { if (dirty() && st.phase === 'ready') flush({ keepalive: true }); });
    window.addEventListener('beforeunload', (e) => { if (st.phase === 'ready' && (dirty() || st.saving || st.save === 'conflict')) { e.preventDefault(); e.returnValue = ''; } });
    setInterval(tick, 250);
    load();
  }

  window.CX = { view, boot };
})();
