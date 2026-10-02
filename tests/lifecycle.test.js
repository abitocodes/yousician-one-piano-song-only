// Page-side update flow and input policy (js/core/lifecycle.js), driven with fake service worker objects that
// follow the browser's order of events: an update installs as 'waiting', a page's SKIP_WAITING activates it, and
// 'controllerchange' fires on every page it takes over.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createUpdater, inputNeeded, isSafePoint, serviceWorkerMode, isOwnCache, askWorkerVersion, INPUT_SCREENS,
  UPDATED_KEY, looksLikeModuleLoadError,
} from '../js/core/lifecycle.js';
import { memoryStorage } from '../js/core/storage.js';

const SCOPE = 'https://example.test/app/';
const SCRIPT = `${SCOPE}sw.js`;
const V1 = '1.0.0+11111111';
const V2 = '1.0.0+22222222';

class FakeTarget {
  constructor() { this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] || []) fn({ type }); }
}

class FakeWorker extends FakeTarget {
  constructor(version, { scriptURL = SCRIPT, answers = true } = {}) {
    super();
    this.version = version;
    this.scriptURL = scriptURL;
    this.answers = answers;
    this.state = 'installing';
    this.posted = [];
  }

  postMessage(msg, ports) {
    this.posted.push(msg.type);
    if (msg.type === 'GET_VERSION' && this.answers && ports?.[0]) ports[0].postMessage({ type: 'VERSION', version: this.version });
  }

  setState(state) {
    this.state = state;
    this.dispatch('statechange');
  }
}

class FakeRegistration extends FakeTarget {
  constructor(scope = SCOPE) {
    super();
    this.scope = scope;
    this.installing = null;
    this.waiting = null;
    this.active = null;
    this.updates = 0;
    this.unregistered = false;
  }

  async update() { this.updates++; }

  async unregister() {
    this.unregistered = true;
    return true;
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A page running `version`, with a fake navigator.serviceWorker. The browser side is driven through the helpers. */
function makePage({
  version = V1, controller = null, reg = new FakeRegistration(), storage = memoryStorage(), cacheStorage = null,
  online = true, now = () => Date.now(), queryVersion = (w) => askWorkerVersion(w, { timeoutMs: 20 }),
} = {}) {
  const container = new FakeTarget();
  container.controller = controller;
  container.registered = 0;
  container.register = async (url) => {
    assert.equal(url, 'sw.js');
    container.registered++;
    return reg;
  };
  container.getRegistration = async () => reg;
  const page = { reloads: 0, toasts: [], safe: true, timers: [], container, reg, storage };
  page.updater = createUpdater({
    version,
    container,
    scopeUrl: SCOPE,
    cacheStorage,
    storage: () => storage,
    reload: () => { page.reloads++; },
    notify: (msg) => page.toasts.push(msg),
    isSafePoint: () => page.safe,
    online: () => online,
    queryVersion,
    setTimer: (fn, ms) => page.timers.push({ fn, ms }),
    now,
  });
  /** Runs the queued timers (e.g. the maybeApply a released hold schedules). */
  page.runTimers = (ms = 0) => {
    const due = page.timers.filter((t) => t.ms <= ms);
    page.timers = page.timers.filter((t) => t.ms > ms);
    for (const t of due) t.fn();
  };
  /** The browser finished installing `worker` as an update: it waits. */
  page.installUpdate = (worker) => {
    reg.installing = worker;
    reg.dispatch('updatefound');
    reg.installing = null;
    reg.waiting = worker;
    worker.setState('installed');
  };
  /** `worker` becomes active and takes this page over (after SKIP_WAITING, a first install's claim, or another tab). */
  page.takeOver = (worker) => {
    if (reg.waiting === worker) reg.waiting = null;
    reg.active = worker;
    worker.setState('activating');
    container.controller = worker;
    container.dispatch('controllerchange');
  };
  return page;
}

// ---------------------------------------------------------------- update flow

test('a page that starts uncontrolled still reloads for a later update (first control is not an update)', async () => {
  const w1 = new FakeWorker(V1);
  const page = makePage();
  page.reg.installing = w1;
  await page.updater.start('register');
  assert.equal(page.container.registered, 1);

  // First visit / after 앱 새로 고침: the first worker installs, activates on its own and claims the page.
  page.reg.installing = null;
  w1.setState('installed');
  assert.deepEqual(w1.posted, [], 'nothing waits: an uncontrolled page has no update to apply');
  page.takeOver(w1);
  await settle();
  assert.equal(page.reloads, 0, 'the first worker serves the very version this page runs');
  assert.deepEqual(w1.posted, ['GET_VERSION']);

  // Later, in the same page: a new deploy.
  const w2 = new FakeWorker(V2);
  page.installUpdate(w2);
  assert.deepEqual(w2.posted, ['SKIP_WAITING'], 'applied at once: the page is at a safe point');
  page.takeOver(w2);
  assert.equal(page.reloads, 1, 'the page reloads onto the new version instead of mixing files');
  assert.equal(page.storage.getItem(UPDATED_KEY), V1);

  // The next update in a page that stayed open is handled the same way.
  const after = makePage({ version: V2, controller: w2 });
  await after.updater.start('register');
  const w3 = new FakeWorker('1.0.0+33333333');
  after.installUpdate(w3);
  after.takeOver(w3);
  assert.equal(after.reloads, 1);
});

test('the first worker to take over reloads the page when it serves another version (or does not answer)', async () => {
  const page = makePage({ version: V1 });
  await page.updater.start('register');
  page.safe = false;
  page.takeOver(new FakeWorker(V2)); // e.g. the page came from the HTTP cache while a newer deploy installed
  await settle();
  assert.equal(page.reloads, 0, 'waits for a safe point');
  page.safe = true;
  page.updater.maybeApply();
  assert.equal(page.reloads, 1);

  const silent = makePage({ version: V1 });
  await silent.updater.start('register');
  silent.takeOver(new FakeWorker(V1, { answers: false }));
  await new Promise((resolve) => setTimeout(resolve, 60)); // the 20 ms query timeout
  await settle();
  assert.equal(silent.reloads, 1, 'no answer: assume the files differ');

  const foreign = makePage({ version: V1 });
  await foreign.updater.start('register');
  foreign.takeOver(new FakeWorker('x', { scriptURL: 'https://example.test/sw.js' }));
  await settle();
  assert.equal(foreign.reloads, 0, 'another app\'s worker is none of our business');
});

test('an update found mid-song waits; it is applied when the page reaches a safe point', async () => {
  const w1 = new FakeWorker(V1);
  w1.state = 'activated';
  const page = makePage({ controller: w1 });
  await page.updater.start('register');
  page.safe = false; // playing
  const w2 = new FakeWorker(V2);
  page.installUpdate(w2);
  page.updater.maybeApply(); // e.g. the tab was hidden mid-song
  assert.deepEqual(w2.posted, [], 'never activated mid-song');
  page.safe = true; // back on home
  page.updater.maybeApply();
  assert.deepEqual(w2.posted, ['SKIP_WAITING']);
  page.takeOver(w2);
  assert.equal(page.reloads, 1);
});

test('an update another tab activated reloads this page only at its next safe point', async () => {
  const w1 = new FakeWorker(V1);
  const page = makePage({ controller: w1 });
  await page.updater.start('register');
  page.safe = false;
  page.takeOver(new FakeWorker(V2));
  assert.equal(page.reloads, 0);
  page.safe = true;
  page.updater.maybeApply();
  assert.equal(page.reloads, 1);
});

test('a waiting update found at start is applied at once when the page is safe', async () => {
  const w2 = new FakeWorker(V2);
  w2.state = 'installed';
  const page = makePage({ controller: new FakeWorker(V1) });
  page.reg.waiting = w2;
  await page.updater.start('register');
  assert.deepEqual(w2.posted, ['SKIP_WAITING']);
});

test('holds keep an update from reloading the page until every one is released', async () => {
  const page = makePage({ controller: new FakeWorker(V1) });
  await page.updater.start('register');
  const releaseImport = page.updater.hold();
  const releaseTap = page.updater.hold();
  assert.equal(page.updater.held, true);
  const w2 = new FakeWorker(V2);
  page.installUpdate(w2);
  assert.deepEqual(w2.posted, []);
  releaseImport();
  releaseImport(); // idempotent
  page.runTimers();
  assert.deepEqual(w2.posted, [], 'one hold is still taken');
  releaseTap();
  assert.deepEqual(w2.posted, [], 'applied on the next task, not inside release()');
  page.runTimers();
  assert.deepEqual(w2.posted, ['SKIP_WAITING']);
  assert.equal(page.updater.held, false);

  // A hold taken after the new version took over delays the reload the same way.
  const release = page.updater.hold();
  page.takeOver(w2);
  assert.equal(page.reloads, 0);
  release();
  page.runTimers();
  assert.equal(page.reloads, 1);
});

test('update reload guard: a second reload within 15 s is refused and explained instead of looping', async () => {
  const storage = memoryStorage();
  storage.setItem(`pk.updateReloadAt:${V1}`, String(Date.now()));
  const page = makePage({ controller: new FakeWorker(V1), storage });
  await page.updater.start('register');
  page.takeOver(new FakeWorker(V2));
  assert.equal(page.reloads, 0);
  assert.match(page.toasts.join('\n'), /새 버전이 준비됐어요/);

  const noStorage = makePage({ controller: new FakeWorker(V1), storage: null });
  await noStorage.updater.start('register');
  noStorage.takeOver(new FakeWorker(V2));
  assert.equal(noStorage.reloads, 0, 'never reload without a working guard');
});

test('reloadAfterLoadFailure activates a waiting version and reloads once; the guard refuses a repeat', async () => {
  const storage = memoryStorage();
  const w2 = new FakeWorker(V2);
  w2.state = 'installed';
  const page = makePage({ controller: new FakeWorker(V1), storage });
  page.safe = false; // a screen failed to load mid-navigation
  page.reg.waiting = w2;
  await page.updater.start('register');
  assert.equal(page.updater.reloadAfterLoadFailure(), true);
  assert.deepEqual(w2.posted, ['SKIP_WAITING']);
  assert.equal(page.reloads, 0);
  page.takeOver(w2);
  assert.equal(page.reloads, 1);
  page.runTimers(3000); // the fallback timer does not reload twice
  assert.equal(page.reloads, 1);

  // The reloaded page (same version, same tab) fails again: no loop.
  const again = makePage({ controller: new FakeWorker(V1), storage });
  await again.updater.start('register');
  assert.equal(again.updater.reloadAfterLoadFailure(), false);
  assert.equal(again.reloads, 0);

  const plain = makePage({ controller: new FakeWorker(V1) });
  await plain.updater.start('register');
  assert.equal(plain.updater.reloadAfterLoadFailure(), true);
  assert.equal(plain.reloads, 1, 'no waiting version: reload right away');

  const offline = makePage({ online: false });
  assert.equal(offline.updater.reloadAfterLoadFailure(), false, 'offline a reload cannot fetch anything new');
});

test('a failed boot (no screen) applies a waiting fixed version at once', async () => {
  // isSafePoint({ screen: null }) is true, so registering from the error path is enough.
  assert.equal(isSafePoint({ screen: null }), true);
  const w2 = new FakeWorker(V2);
  w2.state = 'installed';
  const page = makePage({ controller: new FakeWorker(V1) });
  page.reg.waiting = w2;
  await page.updater.start('register');
  page.takeOver(w2);
  assert.deepEqual(w2.posted, ['SKIP_WAITING']);
  assert.equal(page.reloads, 1);
});

function fakeCaches(entries) {
  const store = new Map(Object.entries(entries).map(([name, urls]) => [name, new Set(urls)]));
  return {
    store,
    async keys() { return [...store.keys()]; },
    async open(name) {
      if (!store.has(name)) store.set(name, new Set());
      const urls = store.get(name);
      return { async match(url) { return urls.has(url) ? { ok: true } : undefined; } };
    },
    async delete(name) { return store.delete(name); },
  };
}

test('start("remove") clears only this app\'s worker and caches, and reloads once off a stale worker', async () => {
  const cacheStorage = fakeCaches({
    [`piano-karaoke-${V1}@/app/`]: [],
    [`piano-karaoke-${V1}@/other-app/`]: [],
    'pk-v2': [`${SCOPE}js/app.js`], // an older build of this app (e.g. a developer's localhost)
    'pk-v1': ['https://example.test/js/app.js'], // the same generic name used by another app
    'someone-else': [],
  });
  const storage = memoryStorage();
  const page = makePage({ controller: new FakeWorker('old'), cacheStorage, storage });
  await page.updater.start('remove');
  assert.equal(page.reg.unregistered, true);
  assert.deepEqual([...cacheStorage.store.keys()].sort(),
    [`piano-karaoke-${V1}@/other-app/`, 'pk-v1', 'someone-else'].sort());
  assert.equal(page.reloads, 1, 'this load still ran the removed worker\'s files');
  assert.equal(page.container.registered, 0);

  const reloaded = makePage({ controller: new FakeWorker('old'), storage });
  await reloaded.updater.start('remove');
  assert.equal(reloaded.reloads, 0, 'guarded: never a reload loop');

  const live = makePage(); // not controlled: already on the live files
  await live.updater.start('remove');
  assert.equal(live.reloads, 0);

  const parent = makePage({ reg: new FakeRegistration('https://example.test/') });
  await parent.updater.start('remove');
  assert.equal(parent.reg.unregistered, false, 'a parent-scope worker belongs to another app');
});

test('start runs once; "none" does nothing; hardReload removes and reloads', async () => {
  const page = makePage();
  await page.updater.start('register');
  await page.updater.start('register');
  assert.equal(page.container.registered, 1);

  const none = makePage();
  await none.updater.start('none');
  assert.equal(none.container.registered, 0);

  const cacheStorage = fakeCaches({ [`piano-karaoke-${V1}@/app/`]: [] });
  const hard = makePage({ cacheStorage });
  await hard.updater.hardReload();
  assert.equal(hard.reg.unregistered, true);
  assert.deepEqual([...cacheStorage.store.keys()], []);
  assert.equal(hard.reloads, 1);
});

test('checkForUpdate asks the browser for a new sw.js at most every 30 minutes', async () => {
  let t = 1_000_000;
  const page = makePage({ controller: new FakeWorker(V1), now: () => t });
  page.updater.checkForUpdate();
  await settle();
  assert.equal(page.reg.updates, 0, 'nothing registered yet');
  await page.updater.start('register');
  page.updater.checkForUpdate();
  await settle();
  assert.equal(page.reg.updates, 0, 'registering just checked');
  t += 31 * 60 * 1000;
  page.updater.checkForUpdate();
  page.updater.checkForUpdate();
  await settle();
  assert.equal(page.reg.updates, 1);
});

test('announce says "updated" once after an update reload', () => {
  const storage = memoryStorage();
  storage.setItem(UPDATED_KEY, V1);
  const page = makePage({ version: V2, storage });
  assert.equal(page.updater.announce(), true);
  assert.match(page.toasts[0], /새 버전으로 업데이트했어요/);
  assert.equal(page.updater.announce(), false);

  storage.setItem(UPDATED_KEY, V2); // the reload landed on the same version
  assert.equal(makePage({ version: V2, storage }).updater.announce(), false);
});

test('askWorkerVersion: the answer comes back through a MessageChannel; null on silence or without a worker', async () => {
  assert.equal(await askWorkerVersion(new FakeWorker(V2)), V2);
  assert.equal(await askWorkerVersion(new FakeWorker(V2, { answers: false }), { timeoutMs: 20 }), null);
  assert.equal(await askWorkerVersion(null), null);
  const broken = { postMessage() { throw new Error('gone'); } };
  assert.equal(await askWorkerVersion(broken), null);
});

test('isOwnCache: versioned names by scope; legacy names only with this app\'s files', async () => {
  const cs = fakeCaches({ 'pk-v2': [`${SCOPE}js/app.js`], 'pk-v1': [] });
  assert.equal(await isOwnCache(cs, `piano-karaoke-${V1}@/app/`, SCOPE), true);
  assert.equal(await isOwnCache(cs, `piano-karaoke-${V1}@/app/sub/`, SCOPE), false);
  assert.equal(await isOwnCache(cs, `piano-karaoke-${V1}@/other/`, SCOPE), false);
  assert.equal(await isOwnCache(cs, 'pk-v2', SCOPE), true);
  assert.equal(await isOwnCache(cs, 'pk-v1', SCOPE), false);
  assert.equal(await isOwnCache(cs, 'whatever', SCOPE), false);
});

// ---------------------------------------------------------------- policies

test('serviceWorkerMode: HTTPS registers; localhost only with ?sw and otherwise removes leftovers; ?nosw removes', () => {
  const mode = (url) => {
    const u = new URL(url);
    return serviceWorkerMode({ protocol: u.protocol, hostname: u.hostname, params: u.searchParams });
  };
  assert.equal(mode('https://user.github.io/app/'), 'register');
  assert.equal(mode('https://user.github.io/app/?nosw'), 'remove');
  assert.equal(mode('http://localhost:8080/'), 'remove', 'a stale ?sw / older worker must not hide edits');
  assert.equal(mode('http://localhost:8080/?sw'), 'register');
  assert.equal(mode('http://127.0.0.1:8080/?sw&nosw'), 'remove');
  assert.equal(mode('http://[::1]:8080/'), 'remove');
  assert.equal(mode('http://app.localhost:8080/?sw'), 'register');
  assert.equal(mode('http://192.168.0.10:8080/'), 'none');
});

test('isSafePoint: only home with nothing in progress, or no screen at all', () => {
  assert.equal(isSafePoint({ screen: 'home' }), true);
  assert.equal(isSafePoint({ screen: 'home', modalOpen: true }), false);
  assert.equal(isSafePoint({ screen: 'home', pickingFile: true }), false, 'the system file picker hides the page');
  assert.equal(isSafePoint({ screen: 'home', navigating: true }), false);
  for (const screen of ['play', 'results', 'settings', 'calibrate', 'editor']) {
    assert.equal(isSafePoint({ screen }), false, screen);
  }
  assert.equal(isSafePoint({}), true);
  assert.equal(isSafePoint({ navigating: true }), false);
});

test('inputNeeded: play and calibrate keep the input; the editor only while its recorder dialog is open', () => {
  assert.deepEqual([...INPUT_SCREENS].sort(), ['calibrate', 'play']);
  assert.equal(inputNeeded('play'), true);
  assert.equal(inputNeeded('calibrate'), true);
  assert.equal(inputNeeded('editor'), false, 'released on arrival; the recorder starts the mic on demand');
  assert.equal(inputNeeded('editor', { modalOpen: true }), true);
  for (const screen of ['home', 'results', 'settings', null, undefined]) {
    assert.equal(inputNeeded(screen, { modalOpen: true }), false, String(screen));
  }
  // A screen can decide for itself.
  assert.equal(inputNeeded('editor', { mod: { usesInput: () => false }, modalOpen: true }), false);
  assert.equal(inputNeeded('editor', { mod: { usesInput: () => true } }), true);
  assert.equal(inputNeeded('home', { mod: { usesInput: () => { throw new Error('x'); } } }), true, 'keep it when unsure');
});

test('looksLikeModuleLoadError: fetch / link failures of import()', () => {
  assert.equal(looksLikeModuleLoadError(new TypeError('Failed to fetch dynamically imported module')), true);
  assert.equal(looksLikeModuleLoadError(new SyntaxError("does not provide an export named 'x'")), true);
  assert.equal(looksLikeModuleLoadError(new Error('mount failed')), false);
  assert.equal(looksLikeModuleLoadError(null), false);
});
