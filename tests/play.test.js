// Play screen run logic: lost mic input (pause / explain / reconnect before 계속 and 처음부터), '터치로 계속하기',
// the calibrate-mode key guard and the back button. Driven through play.js's pure helpers and its __test seam with
// a hand-made screen state, so no DOM is needed (DOM helpers are stubbed by helpers-screen-stubs.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { importScreen } from './helpers-screen-stubs.js';

const play = await importScreen('../js/screens/play.js');
const T = play.__test;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeEl(text = '') {
  const el = {
    hidden: false,
    disabled: false,
    textContent: text,
    dataset: {},
    style: {},
    kids: [],
    classes: new Set(),
    blurred: 0,
    replaceChildren(...kids) { el.kids = kids; },
    remove() {},
    blur() {
      el.blurred++;
      if (globalThis.document && globalThis.document.activeElement === el) globalThis.document.activeElement = null;
    },
  };
  el.classList = { toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)) };
  return el;
}

class FakeInput {
  constructor(state = 'running') {
    this.state = state;
    this.lastError = null;
    this.fns = new Set();
    this.stops = 0;
  }

  on(type, fn) {
    if (type !== 'state') return () => {};
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  emit(state, err) {
    this.state = state;
    if (err !== undefined) this.lastError = err;
    for (const fn of [...this.fns]) fn(state);
  }

  stop() {
    this.stops++;
    this.emit('idle');
  }
}

class FakeSession {
  constructor(input, state) {
    this.input = input;
    this.state = state;
    this.calls = [];
    this.settings = {};
  }

  pause() { this.calls.push('pause'); this.state = 'paused'; }
  resume() { this.calls.push('resume'); this.state = 'resuming'; }
  restart() { this.calls.push('restart'); this.state = 'ready'; }
  start() { this.calls.push('start'); this.state = 'playing'; }
  updateSettings(p) { this.calls.push('updateSettings'); Object.assign(this.settings, p); }
  touchDown(m) { this.calls.push(`down:${m}`); }
  touchUp(m) { this.calls.push(`up:${m}`); }
}

const count = (arr, v) => arr.filter((x) => x === v).length;

/**
 * Mounted-screen state as play.js builds it, with fake elements, session, input and app.
 * `ensureInput(input)` replaces app.ensureInput's behaviour (default: resolve the same, untouched input).
 */
function makeScreen({ mode = 'play', inputMode = 'mic', state = 'playing', inputState = 'running', ensureInput } = {}) {
  const input = new FakeInput(inputState);
  const session = new FakeSession(input, state);
  const log = { saved: [], went: [], ensure: 0 };
  const els = {};
  for (const k of ['back', 'pause', 'resumeBtn', 'restartBtn', 'pauseErr', 'finishOv', 'detect', 'desc', 'inputChip',
    'hint', 'micErr']) els[k] = fakeEl();
  els.resumeBtn.textContent = '계속';
  els.pauseErr.hidden = true;
  els.finishOv.hidden = true;
  els.micErr.hidden = true;
  const st = {
    mode,
    inputMode,
    settings: { inputMode, guideMelody: false },
    params: {},
    hasBacking: false,
    session,
    finished: false,
    reconnecting: false,
    confirmingExit: false,
    finishTimer: 0,
    flashEl: null,
    hud: {},
    lastState: '',
    dirty: false,
    pointers: new Map(),
    keyRefs: new Uint8Array(128),
    heldCodes: new Map(),
    cleanups: [],
    renderer: { clearEffects() {} },
    karaoke: null,
    els,
    app: {
      settings: { set: (k, v) => log.saved.push([k, v]), all: () => ({}) },
      ensureInput: async () => {
        log.ensure++;
        return ensureInput ? ensureInput(input) : input;
      },
      go: (...args) => log.went.push(args),
      keepAwake() {},
    },
  };
  T.attach(st);
  return { st, input, session, log, els };
}

/** ensureInput that brings the same input back up. */
const reconnects = (inp) => {
  inp.state = 'running';
  return inp;
};

afterEach(() => {
  T.attach(null);
  delete globalThis.document;
});

// ------------------------------------------------------------------ pure helpers

test('inputStateAction: pause on a dead input, explain failures, clear when running again', () => {
  for (const s of ['playing', 'holding', 'resuming']) {
    assert.equal(play.inputStateAction('error', s), 'explain', s);
    assert.equal(play.inputStateAction('denied', s), 'explain', s);
    assert.equal(play.inputStateAction('unsupported', s), 'explain', s);
    assert.equal(play.inputStateAction('idle', s), 'pause', s);
    assert.equal(play.inputStateAction('running', s), 'clear', s);
    assert.equal(play.inputStateAction('requesting', s), '', s);
  }
  // already paused: still explain (the overlay is showing), a plain stop changes nothing visible
  assert.equal(play.inputStateAction('error', 'paused'), 'explain');
  assert.equal(play.inputStateAction('idle', 'paused'), 'pause');
  // not running yet / over: nothing to pause
  for (const s of ['ready', 'countdown', 'finished', '']) {
    assert.equal(play.inputStateAction('error', s), '', s);
    assert.equal(play.inputStateAction('idle', s), '', s);
  }
});

test('acceptsKeys: screen keys / keyboard only in play and practice', () => {
  assert.equal(play.acceptsKeys('play'), true);
  assert.equal(play.acceptsKeys('practice'), true);
  assert.equal(play.acceptsKeys('listen'), false);
  assert.equal(play.acceptsKeys('calibrate'), false);
});

test('needsInput / needsReconnect', () => {
  const { st, input } = makeScreen();
  assert.equal(play.needsInput(st), true);
  assert.equal(play.needsReconnect(st), false);
  for (const s of ['error', 'denied', 'idle', 'requesting']) {
    input.state = s;
    assert.equal(play.needsReconnect(st), true, s);
  }
  st.inputMode = 'touch';
  assert.equal(play.needsInput(st), false);
  assert.equal(play.needsReconnect(st), false);
  st.inputMode = 'sim';
  assert.equal(play.needsReconnect(st), true);
  st.mode = 'listen';
  assert.equal(play.needsInput(st), false);
  st.mode = 'calibrate';
  assert.equal(play.needsInput(st), true);
  st.session.input = null;
  assert.equal(play.needsInput(st), false);
  st.session = null;
  assert.equal(play.needsInput(st), false);
  assert.equal(play.needsReconnect(st), false);
});

test('micErrorInfo: never offers touch in calibrate mode', () => {
  const codes = ['denied', 'insecure', 'unsupported', 'error', undefined];
  for (const code of codes) {
    const err = code ? Object.assign(new Error('x'), { code }) : null;
    const p = play.micErrorInfo({ mode: 'play', inputMode: 'mic', app: {} }, err);
    assert.equal(p.touch, true, `play ${code}`);
    assert.ok(p.title && p.body, `play ${code}`);
    const pr = play.micErrorInfo({ mode: 'practice', inputMode: 'sim', app: {} }, err);
    assert.equal(pr.touch, true, `practice ${code}`);
    const c = play.micErrorInfo({ mode: 'calibrate', inputMode: 'mic', app: {} }, err);
    assert.equal(c.touch, false, `calibrate ${code}`);
    assert.doesNotMatch(c.body, /터치 모드로 연주/, `calibrate ${code}`);
  }
  assert.equal(play.micErrorInfo({ mode: 'play', inputMode: 'mic', app: {} }, { code: 'denied' }).title,
    '마이크 권한이 필요해요');
  // touch input / listen mode: only audio unlocking can fail
  const t = play.micErrorInfo({ mode: 'play', inputMode: 'touch', app: {} }, { code: 'denied' });
  assert.equal(t.touch, false);
  assert.equal(t.title, '소리를 켜지 못했어요');
  assert.equal(play.micErrorInfo({ mode: 'listen', inputMode: 'mic', app: {} }, null).touch, false);
  // app wording for unknown failures
  const app = { inputErrorMessage: () => '앱 설명' };
  assert.equal(play.micErrorInfo({ mode: 'play', inputMode: 'mic', app }, { code: 'error' }).body, '앱 설명');
});

test('inputErrorInfo: lost mic vs failed reconnect, touch only outside calibrate with a live session', () => {
  const { st } = makeScreen();
  const lost = play.inputErrorInfo(st, { code: 'error' }, true);
  assert.equal(lost.title, '마이크 연결이 끊어졌어요');
  assert.equal(lost.touch, true);
  assert.equal(play.inputErrorInfo(st, null, true).title, '마이크 연결이 끊어졌어요');
  // a revoked permission says how to fix it even when lost mid-song
  assert.equal(play.inputErrorInfo(st, { code: 'denied' }, true).title, '마이크 권한이 필요해요');
  assert.equal(play.inputErrorInfo(st, { code: 'error' }, false).title, '마이크를 시작하지 못했어요');

  st.mode = 'calibrate';
  assert.equal(play.inputErrorInfo(st, { code: 'error' }, true).touch, false);
  assert.equal(play.inputErrorInfo(st, { code: 'denied' }, false).touch, false);
  st.mode = 'play';
  st.session = null;
  assert.equal(play.inputErrorInfo(st, { code: 'error' }, true).touch, false);
});

// ------------------------------------------------------------------ lost input mid-song

test('a mic failure mid-song pauses the run and explains it; running again clears the error', () => {
  const { st, input, session, els } = makeScreen();
  T.watchInput(st, input);
  assert.deepEqual(session.calls, []);

  input.emit('error', Object.assign(new Error('track ended'), { code: 'error' }));
  assert.deepEqual(session.calls, ['pause']);
  assert.equal(session.state, 'paused');
  assert.equal(els.pauseErr.hidden, false);
  assert.equal(els.pauseErr.kids.length, 3, 'title, text and the 터치로 계속하기 action');
  assert.equal(els.resumeBtn.textContent, '다시 연결');

  // another failure while paused: no second pause, message stays
  input.emit('denied', { code: 'denied' });
  assert.deepEqual(session.calls, ['pause']);
  assert.equal(els.pauseErr.hidden, false);

  input.emit('requesting');
  assert.equal(els.pauseErr.hidden, false);
  input.emit('running');
  assert.equal(els.pauseErr.hidden, true);
  assert.equal(els.resumeBtn.textContent, '계속');
  assert.equal(session.state, 'paused', 'the player resumes by themselves');
});

test('a plain stop pauses without an error; requesting changes nothing', () => {
  const { st, input, session, els } = makeScreen({ state: 'holding' });
  T.watchInput(st, input);
  input.emit('requesting');
  assert.deepEqual(session.calls, []);
  input.emit('idle');
  assert.deepEqual(session.calls, ['pause']);
  assert.equal(els.pauseErr.hidden, true);
  assert.equal(els.resumeBtn.textContent, '계속');
});

test('an input that already failed while preparing pauses as soon as it is watched', () => {
  const { st, input, session, els } = makeScreen({ state: 'resuming', inputState: 'error' });
  T.watchInput(st, input);
  assert.deepEqual(session.calls, ['pause']);
  assert.equal(els.pauseErr.hidden, false);
});

test('lost input is ignored for touch runs, finished runs, other inputs and unmounted screens', () => {
  const touch = makeScreen({ inputMode: 'touch' });
  T.watchInput(touch.st, touch.input);
  touch.input.emit('error', { code: 'error' });
  assert.deepEqual(touch.session.calls, []);

  const done = makeScreen();
  done.st.finished = true;
  T.watchInput(done.st, done.input);
  done.input.emit('error', { code: 'error' });
  assert.deepEqual(done.session.calls, []);

  const other = makeScreen();
  T.onInputState(other.st, new FakeInput('error'), 'error');
  assert.deepEqual(other.session.calls, []);

  const gone = makeScreen();
  T.watchInput(gone.st, gone.input);
  T.attach(null);
  gone.input.emit('error', { code: 'error' });
  assert.deepEqual(gone.session.calls, []);
});

test('calibrate: a lost mic pauses but never offers 터치로 계속하기', () => {
  const { st, input, session, els } = makeScreen({ mode: 'calibrate' });
  T.watchInput(st, input);
  input.emit('error', { code: 'error' });
  assert.deepEqual(session.calls, ['pause']);
  assert.equal(els.pauseErr.hidden, false);
  assert.equal(els.pauseErr.kids.length, 2, 'title and text only');
});

// ------------------------------------------------------------------ reconnect before 계속 / 처음부터

test('계속 restarts the lost input first, then resumes', async () => {
  const { st, input, session, els, log } = makeScreen({ ensureInput: reconnects });
  T.watchInput(st, input);
  input.emit('error', { code: 'error' });
  await T.resume(st);
  assert.equal(log.ensure, 1);
  assert.deepEqual(session.calls, ['pause', 'resume']);
  assert.equal(els.pauseErr.hidden, true);
  assert.equal(els.resumeBtn.textContent, '계속');
  assert.equal(els.resumeBtn.disabled, false);
  assert.equal(st.reconnecting, false);
});

test('계속 with a running input resumes without touching the mic', async () => {
  const { st, session, log } = makeScreen({ state: 'paused' });
  await T.resume(st);
  assert.equal(log.ensure, 0);
  assert.deepEqual(session.calls, ['resume']);
});

test('a failed reconnect keeps the run paused and explains why', async () => {
  const failures = [
    ['rejects', () => { throw Object.assign(new Error('nope'), { code: 'denied' }); }],
    ['stays down', (inp) => inp],
    ['other input', () => new FakeInput('running')],
    ['touch', () => null],
  ];
  for (const [name, ensureInput] of failures) {
    const { st, input, session, els, log } = makeScreen({ ensureInput });
    T.watchInput(st, input);
    input.emit('error', { code: 'error' });
    await T.resume(st);
    assert.equal(log.ensure, 1, name);
    assert.deepEqual(session.calls, ['pause'], name);
    assert.equal(session.state, 'paused', name);
    assert.equal(els.pauseErr.hidden, false, name);
    assert.equal(els.resumeBtn.textContent, '다시 연결', name);
    assert.equal(els.resumeBtn.disabled, false, name);
    assert.equal(els.restartBtn.disabled, false, name);
    assert.equal(st.reconnecting, false, name);
  }
});

test('계속 / 처음부터 while reconnecting do not start a second attempt', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { st, input, session, els, log } = makeScreen({
    ensureInput: async (inp) => {
      await gate;
      return reconnects(inp);
    },
  });
  T.watchInput(st, input);
  input.emit('error', { code: 'error' });
  const first = T.resume(st);
  assert.equal(st.reconnecting, true);
  assert.equal(els.resumeBtn.disabled, true);
  assert.equal(els.restartBtn.disabled, true);
  assert.equal(els.resumeBtn.textContent, '마이크 연결 중…');
  // events during the attempt are left to it
  input.emit('error', { code: 'error' });
  await T.resume(st);
  await T.restart(st);
  assert.equal(log.ensure, 1);
  release();
  await first;
  assert.deepEqual(session.calls, ['pause', 'resume']);
  assert.equal(st.reconnecting, false);
});

test('처음부터 reconnects first; on failure the run is not restarted', async () => {
  const bad = makeScreen({ ensureInput: (inp) => inp });
  T.watchInput(bad.st, bad.input);
  bad.input.emit('error', { code: 'error' });
  await T.restart(bad.st);
  assert.deepEqual(bad.session.calls, ['pause']);
  assert.equal(bad.session.state, 'paused');

  const good = makeScreen({ ensureInput: reconnects });
  T.watchInput(good.st, good.input);
  good.input.emit('error', { code: 'error' });
  await T.restart(good.st);
  assert.equal(good.log.ensure, 1);
  assert.deepEqual(good.session.calls, ['pause', 'restart', 'start']);
  assert.equal(good.els.pauseErr.hidden, true);
});

test('다시하기 after the finish with a dead mic reconnects before restarting', async () => {
  const { st, session, log } = makeScreen({ state: 'finished', inputState: 'idle', ensureInput: reconnects });
  st.finished = true;
  await T.restart(st);
  assert.equal(log.ensure, 1);
  assert.deepEqual(session.calls, ['restart', 'start']);
  assert.equal(st.finished, false);
});

// ------------------------------------------------------------------ 터치로 계속하기 / 터치 모드로 전환

test('터치로 계속하기 switches only this run to touch: the saved input mode is not changed', async () => {
  const { st, input, session, els, log } = makeScreen();
  T.watchInput(st, input);
  input.emit('error', { code: 'error' });
  T.continueWithTouch(st);
  await tick();
  assert.deepEqual(log.saved, [], 'no settings.set: the next song starts with the saved input mode');
  assert.equal(st.inputMode, 'touch');
  assert.equal(st.settings.inputMode, 'touch');
  assert.equal(session.settings.inputMode, 'touch');
  assert.equal(log.ensure, 0, 'no reconnect for a touch run');
  assert.deepEqual(session.calls, ['pause', 'updateSettings', 'resume']);
  assert.equal(els.pauseErr.hidden, true);
  assert.equal(els.detect.hidden, true);
  assert.equal(els.inputChip.dataset.input, 'touch');

  // the dead mic no longer pauses this run, and 처음부터 does not ask for it
  input.emit('error', { code: 'error' });
  assert.equal(count(session.calls, 'pause'), 1);
  session.state = 'paused';
  await T.restart(st);
  assert.equal(log.ensure, 0);
  assert.deepEqual(log.saved, []);
});

test('터치로 계속하기 stops an input that is still up, without pausing again', async () => {
  const { st, input, session } = makeScreen({ state: 'paused' });
  T.watchInput(st, input);
  T.continueWithTouch(st);
  await tick();
  assert.equal(input.stops, 1);
  assert.equal(count(session.calls, 'pause'), 0);
  assert.equal(session.state, 'resuming');
});

test('터치로 계속하기 is refused in calibrate mode and after the finish', () => {
  const cal = makeScreen({ mode: 'calibrate', state: 'paused', inputState: 'error' });
  T.continueWithTouch(cal.st);
  assert.equal(cal.st.inputMode, 'mic');
  assert.deepEqual(cal.session.calls, []);

  const done = makeScreen({ state: 'finished', inputState: 'error' });
  done.st.finished = true;
  T.continueWithTouch(done.st);
  assert.equal(done.st.inputMode, 'mic');
  assert.deepEqual(done.session.calls, []);
});

test('터치 모드로 전환 on the ready screen saves the input mode (except in calibrate mode)', () => {
  const { st, log } = makeScreen();
  st.session = null;
  T.switchToTouch(st);
  assert.deepEqual(log.saved, [['inputMode', 'touch']]);
  assert.equal(st.inputMode, 'touch');

  const cal = makeScreen({ mode: 'calibrate' });
  cal.st.session = null;
  T.switchToTouch(cal.st);
  assert.deepEqual(cal.log.saved, []);
  assert.equal(cal.st.inputMode, 'mic');
});

// ------------------------------------------------------------------ keys

test('pressKey: refused in calibrate / listen mode so taps never feed the mic latency', () => {
  for (const mode of ['calibrate', 'listen']) {
    const { st, session } = makeScreen({ mode });
    assert.equal(T.pressKey(st, 60), false, mode);
    assert.deepEqual(session.calls, [], mode);
    assert.equal(st.keyRefs[60], 0, mode);
  }
  for (const mode of ['play', 'practice']) {
    const { st, session } = makeScreen({ mode, inputMode: 'touch' });
    assert.equal(T.pressKey(st, 60), true, mode);
    assert.equal(T.pressKey(st, 60), true, `${mode} second pointer`);
    assert.deepEqual(session.calls, ['down:60'], mode);
  }
  const paused = makeScreen({ state: 'paused' });
  assert.equal(T.pressKey(paused.st, 60), false);
  const done = makeScreen();
  done.st.finished = true;
  assert.equal(T.pressKey(done.st, 60), false);
  const range = makeScreen();
  assert.equal(T.pressKey(range.st, 128), false);
  assert.equal(T.pressKey(range.st, -1), false);
});

// ------------------------------------------------------------------ back button

test('back button: leaves at once when nothing is running', async () => {
  const { st, log } = makeScreen();
  st.session = null;
  await T.onBackButton(st);
  assert.deepEqual(log.went, [['home']]);

  const done = makeScreen({ state: 'finished' });
  done.st.finished = true;
  done.st.params = { returnTo: 'editor', returnParams: { songId: 'x' } };
  await T.onBackButton(done.st);
  assert.deepEqual(done.log.went, [['editor', { songId: 'x' }]]);
});

test('back button mid-run pauses and asks; cancelling stays and drops focus from the button', async () => {
  // confirmDialog is stubbed to answer 계속 있기 (false)
  const { st, session, els, log } = makeScreen();
  globalThis.document = { activeElement: els.back };
  await T.onBackButton(st);
  assert.deepEqual(session.calls, ['pause']);
  assert.deepEqual(log.went, []);
  assert.equal(els.back.blurred, 1, 'Space must not re-click the focused back button');
  assert.equal(st.confirmingExit, false);
});

test('back button while paused still asks instead of dropping the run', async () => {
  const { st, session, els, log } = makeScreen({ state: 'paused' });
  globalThis.document = { activeElement: null };
  await T.onBackButton(st);
  assert.deepEqual(session.calls, []);
  assert.deepEqual(log.went, []);
  assert.equal(els.back.blurred, 0);
});

test('back button: a second press while the dialog is open is ignored', async () => {
  const { st, session, log } = makeScreen();
  globalThis.document = { activeElement: null };
  const first = T.onBackButton(st);
  assert.equal(st.confirmingExit, true);
  await T.onBackButton(st);
  await first;
  assert.deepEqual(session.calls, ['pause']);
  assert.deepEqual(log.went, []);
});
