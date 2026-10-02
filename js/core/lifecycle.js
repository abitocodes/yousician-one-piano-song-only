// Page lifecycle policies used by js/app.js, kept free of DOM globals (every browser API is passed in) so that
// tests/lifecycle.test.js can drive them in node:
//   - when the shared audio input (microphone or simulation) may keep running;
//   - when a new deploy may take over the page (a "safe point");
//   - the page side of the service worker update flow. sw.js installs every deploy as a *waiting* worker. The page
//     activates it only at a safe point (home screen, nothing in progress) and then reloads once, so a song, a
//     calibration, an unsaved chart or an import is never interrupted and a running page never mixes the files of
//     two deploys.

import { claimOnce } from './storage.js';

export const CACHE_PREFIX = 'piano-karaoke-'; // must match sw.js and the recovery script in index.html
// Generic cache names of pre-release builds (e.g. a developer's localhost). Ours only when they hold this app's files.
export const LEGACY_CACHES = ['pk-v1', 'pk-v2'];

// ---------------------------------------------------------------- audio input

/** Screens that use the shared input whenever they are on display (each one starts it on demand). */
export const INPUT_SCREENS = new Set(['play', 'calibrate']);

/**
 * Whether the shared input should keep running while `screen` is on display. A screen module can decide for itself
 * by exporting usesInput(). Otherwise the editor counts as using it only while one of its dialogs is open: it uses the
 * mic only inside its 「피아노로 녹음」 dialog (and starts it again on demand).
 */
export function inputNeeded(screen, { mod = null, modalOpen = false } = {}) {
  if (mod && typeof mod.usesInput === 'function') {
    try {
      return !!mod.usesInput();
    } catch {
      return true;
    }
  }
  if (INPUT_SCREENS.has(screen)) return true;
  return screen === 'editor' && !!modalOpen;
}

// ---------------------------------------------------------------- safe point

/**
 * A moment when the page may reload for an update: the home screen with no navigation, dialog or system file picker
 * in progress — or no screen at all (a failed boot has nothing to interrupt).
 */
export function isSafePoint({ screen = null, navigating = false, modalOpen = false, pickingFile = false } = {}) {
  if (navigating || pickingFile) return false;
  if (!screen) return true;
  return screen === 'home' && !modalOpen;
}

// ---------------------------------------------------------------- service worker

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * What to do about the service worker on this page load:
 *   'register' — install and update it (HTTPS; on localhost only with ?sw, to try offline use and updates);
 *   'remove'   — remove this app's worker and caches: ?nosw, and localhost without ?sw, where a worker left over
 *                from an earlier ?sw session or an older build would keep serving stale files and hide every edit;
 *   'none'     — plain http on another host, where service workers are unavailable.
 */
export function serviceWorkerMode({ protocol, hostname, params }) {
  if (params.has('nosw')) return 'remove';
  if (LOCAL_HOSTS.includes(hostname) || hostname.endsWith('.localhost')) return params.has('sw') ? 'register' : 'remove';
  return protocol === 'https:' ? 'register' : 'none';
}

/** Cache Storage is shared by every app on the origin (e.g. all GitHub Pages projects): only ever touch ours. */
export async function isOwnCache(cacheStorage, key, scopeUrl) {
  const scopePath = new URL(scopeUrl).pathname;
  if (key.startsWith(CACHE_PREFIX)) return key.endsWith(`@${scopePath}`);
  if (!LEGACY_CACHES.includes(key)) return false;
  try {
    const cache = await cacheStorage.open(key);
    return !!(await cache.match(new URL('js/app.js', scopeUrl).href));
  } catch {
    return false;
  }
}

/** Asks a worker which version it serves (sw.js answers GET_VERSION). → the version, or null without an answer. */
export function askWorkerVersion(worker, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!worker || typeof MessageChannel !== 'function') {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    let timer = 0;
    const done = (value) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      try { channel.port1.close(); } catch { /* ignore */ }
      resolve(value);
    };
    timer = setTimeout(() => done(null), timeoutMs);
    channel.port1.onmessage = (e) => done(typeof e.data?.version === 'string' ? e.data.version : null);
    try {
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    } catch {
      done(null);
    }
  });
}

export const UPDATED_KEY = 'pk.updatedFrom';
const SW_REMOVED_KEY = 'pk.swRemovedReloadAt';
const UPDATE_CHECK_MS = 30 * 60 * 1000;

/**
 * Page-side update controller.
 * env: {
 *   version            this page's APP_VERSION
 *   container          navigator.serviceWorker (or null)
 *   scopeUrl           this app's directory, which is also the worker's scope
 *   cacheStorage       window.caches (or null)
 *   storage()          → sessionStorage or null (reload-loop guards survive the reload through it)
 *   reload()           location.reload
 *   notify(msg, opts)  toast
 *   isSafePoint()      see isSafePoint(); holds taken through hold() are checked on top of it
 *   online()           → false when the browser knows it is offline
 *   queryVersion(w)    → Promise<version | null> (askWorkerVersion)
 *   setTimer(fn, ms)   setTimeout
 *   now()              Date.now
 * }
 */
export function createUpdater(env) {
  const {
    version,
    container = null,
    scopeUrl,
    cacheStorage = null,
    storage = () => null,
    reload,
    notify = () => {},
    isSafePoint: pageAtSafePoint = () => true,
    online = () => true,
    queryVersion = (worker) => askWorkerVersion(worker),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    now = () => Date.now(),
  } = env;
  const scopePath = new URL(scopeUrl).pathname;
  const ownScriptUrl = new URL('sw.js', scopeUrl).href;
  // Reload-loop guards, per running version: a reload that did not get the page off this version within the window
  // did not help, so it is not repeated. A reload that did lands on a new version with a fresh guard.
  const updateReloadKey = `pk.updateReloadAt:${version}`;
  const loadReloadKey = `pk.loadFailReloadAt:${version}`;

  let started = false;
  let reg = null;
  let waitingWorker = null;
  let controlled = false; // this app's worker controls the page — tracked as it changes, not only at start
  let reloadPending = false; // a new version already controls this page; reload at the next safe point
  let reloadOnControllerChange = false;
  let reloading = false;
  let reloadIssued = false;
  let lastCheck = 0;
  let holds = 0;

  const controlledByUs = () => container?.controller?.scriptURL === ownScriptUrl;

  function reloadPage() {
    if (reloadIssued) return;
    reloadIssued = true;
    reload();
  }

  function atSafePoint() {
    return holds === 0 && pageAtSafePoint();
  }

  function reloadForUpdate() {
    reloadPending = false;
    const ss = storage();
    if (!claimOnce(ss, updateReloadKey, 15000)) {
      notify('새 버전이 준비됐어요. 앱을 다시 열면 적용돼요.', { type: 'success', duration: 4000 });
      return;
    }
    reloading = true;
    try { ss.setItem(UPDATED_KEY, version); } catch { /* ignore */ }
    reloadPage();
  }

  /** Applies a pending update when the page is at a safe point; otherwise it keeps waiting. */
  function maybeApply() {
    if (reloading || !atSafePoint()) return;
    if (reloadPending) {
      reloadForUpdate();
      return;
    }
    const worker = waitingWorker || reg?.waiting;
    if (!worker) return;
    waitingWorker = null;
    try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch (err) { console.warn('[app] skip waiting', err); }
    // → the worker activates → 'controllerchange' → reload
  }

  /** Keeps updates from reloading the page until the returned release function is called (idempotent). */
  function hold() {
    holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds--;
      // On the next task: a navigation the caller started right before releasing is under way by then.
      setTimer(maybeApply, 0);
    };
  }

  function onControllerChange() {
    if (reloadOnControllerChange) {
      reloadPage();
      return;
    }
    const wasControlled = controlled;
    controlled = controlledByUs();
    if (wasControlled) {
      // A new version took over (activated here at a safe point, or in another tab): reload at the next safe point.
      reloadPending = true;
      maybeApply();
      return;
    }
    if (!controlled) return; // some other app's worker
    // The first worker to control this page (first visit, after 앱 새로 고침 or ?nosw) normally serves the very files
    // this page runs. Not when a deploy landed in between or the page came from the HTTP cache: then it is an update.
    const worker = container.controller;
    Promise.resolve()
      .then(() => queryVersion(worker))
      .catch(() => null)
      .then((served) => {
        if (served === version || container.controller !== worker) return;
        reloadPending = true;
        maybeApply();
      });
  }

  function watch(registration) {
    reg = registration;
    lastCheck = now();
    const track = (worker) => {
      if (!worker) return;
      const onState = () => {
        // 'installed' while a worker controls this page = an update that waits for us.
        if (worker.state === 'installed' && container.controller) {
          waitingWorker = worker;
          maybeApply();
        }
      };
      worker.addEventListener('statechange', onState);
      onState();
    };
    track(registration.installing);
    registration.addEventListener('updatefound', () => track(registration.installing));
    if (registration.waiting) waitingWorker = registration.waiting;
    maybeApply();
  }

  /** This app's own registration — never a parent-scope worker of another app on the same origin. */
  async function ownRegistration() {
    const r = await container?.getRegistration?.(scopeUrl);
    return r && new URL(r.scope).pathname === scopePath ? r : null;
  }

  /** Unregisters this app's worker and deletes its caches (other apps on the origin are left alone). */
  async function removeAll() {
    try {
      const r = await ownRegistration();
      if (r) await r.unregister();
    } catch { /* ignore */ }
    if (!cacheStorage) return;
    try {
      const keys = await cacheStorage.keys();
      const own = await Promise.all(keys.map((k) => isOwnCache(cacheStorage, k, scopeUrl)));
      await Promise.all(keys.filter((k, i) => own[i]).map((k) => cacheStorage.delete(k)));
    } catch { /* ignore */ }
  }

  /** mode: see serviceWorkerMode(). Runs once; later calls do nothing. */
  async function start(mode) {
    if (started || !container) return;
    started = true;
    if (mode === 'remove') {
      const wasControlled = controlledByUs();
      await removeAll();
      // This load still runs on the removed worker's (stale) files: reload once onto the live ones.
      if (wasControlled && claimOnce(storage(), SW_REMOVED_KEY, 15000)) reloadPage();
      return;
    }
    if (mode !== 'register') return;
    controlled = controlledByUs();
    container.addEventListener('controllerchange', onControllerChange);
    try {
      watch(await container.register('sw.js'));
    } catch (err) {
      console.warn('[app] service worker registration failed', err);
    }
  }

  /** Asks the browser to look for a new sw.js (a PWA resumed from recents can stay open for days). Throttled. */
  function checkForUpdate() {
    if (!reg || now() - lastCheck < UPDATE_CHECK_MS) return;
    lastCheck = now();
    Promise.resolve().then(() => reg.update()).catch(() => { /* offline */ });
  }

  /**
   * After a screen module failed to fetch or link: reload once (at most every 30 s), onto the newest version if one
   * waits. → false when the guard refuses (the caller then explains instead).
   */
  function reloadAfterLoadFailure() {
    if (reloading || !online() || !claimOnce(storage(), loadReloadKey, 30000)) return false;
    reloading = true;
    notify('새 버전을 불러오는 중이에요…', { duration: 3000 });
    const worker = reg?.waiting;
    if (worker) {
      reloadOnControllerChange = true;
      try { worker.postMessage({ type: 'SKIP_WAITING' }); } catch { /* ignore */ }
      setTimer(reloadPage, 3000); // in case the waiting worker never takes over
    } else {
      reloadPage();
    }
    return true;
  }

  /** Settings → 앱 새로 고침: removes this app's worker and caches, then reloads. */
  async function hardReload() {
    await removeAll();
    reloadPage();
  }

  /** After an automatic update reload: say so once. → true when it did. */
  function announce() {
    const ss = storage();
    let from = null;
    try {
      from = ss ? ss.getItem(UPDATED_KEY) : null;
      ss?.removeItem(UPDATED_KEY);
    } catch { /* ignore */ }
    if (!from || from === version) return false;
    notify('새 버전으로 업데이트했어요.', { type: 'success', duration: 3000 });
    return true;
  }

  return {
    start,
    maybeApply,
    hold,
    checkForUpdate,
    reloadAfterLoadFailure,
    removeAll,
    hardReload,
    announce,
    get held() { return holds > 0; },
  };
}

/** A dynamic import() that failed to fetch the file or to link it against the modules already loaded. */
export function looksLikeModuleLoadError(err) {
  return err?.name === 'SyntaxError' || err?.name === 'TypeError';
}
