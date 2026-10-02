// Bootstrap: settings/library/scores, screen router with Android back-button support, audio input,
// fullscreen / orientation / wake-lock helpers, global error toasts and service worker registration.

import { Settings, Library, ScoreBook } from './core/storage.js';
import { toast, closeTopModal } from './ui/dom.js';

export const APP_VERSION = '1.0.0';

const SCREENS = ['home', 'play', 'results', 'settings', 'calibrate', 'editor'];
const TRANSIENT = new Set(['play', 'results']);
const LOADERS = {
  home: () => import('./screens/home.js'),
  play: () => import('./screens/play.js'),
  results: () => import('./screens/results.js'),
  settings: () => import('./screens/settings.js'),
  calibrate: () => import('./screens/calibrate.js'),
  editor: () => import('./screens/editor.js'),
};

const query = new URLSearchParams(location.search);
const overrides = {};
const inputParam = query.get('input');
if (['mic', 'touch', 'sim'].includes(inputParam)) overrides.inputMode = inputParam;

const settings = new Settings(overrides);
const library = new Library();
const scores = new ScoreBook();

// ---------------------------------------------------------------- audio input
// Audio modules are loaded dynamically so that home/settings still work (touch mode) if they fail to load.

let audio = null; // { AudioInput, unlockAudio, setMasterVolume }
const audioReady = Promise.all([import('./audio/engine.js'), import('./audio/input.js')])
  .then(([engine, inputMod]) => {
    audio = {
      AudioInput: inputMod.AudioInput,
      unlockAudio: engine.unlockAudio,
      setMasterVolume: engine.setMasterVolume,
    };
    return audio;
  })
  .catch((err) => {
    console.error('[app] audio modules failed to load', err);
    return null;
  });

let input = null;
let audioUnlocked = false;

function audioUnavailable() {
  const err = new Error('오디오 모듈을 불러오지 못했어요.');
  err.code = 'unsupported';
  return err;
}

/** Shared AudioInput (created lazily with the current sensitivity / A4). null only if the audio modules failed. */
function getInput() {
  if (!input && audio) {
    input = new audio.AudioInput({ sensitivity: settings.get('sensitivity'), a4: settings.get('a4') });
  }
  return input;
}

async function unlock() {
  const mod = audio || await audioReady;
  if (!mod) throw audioUnavailable();
  try {
    const ctx = await mod.unlockAudio();
    audioUnlocked = true;
    mod.setMasterVolume(settings.get('masterVolume'));
    return ctx;
  } catch (err) {
    if (err && !err.code) err.code = 'unsupported';
    throw err;
  }
}

async function ensureInput() {
  await unlock();
  const mode = settings.get('inputMode');
  if (mode === 'touch') return null;
  const inp = getInput();
  if (!inp) throw audioUnavailable();
  const running = inp.state === 'running';
  if (mode === 'sim') {
    if (!(running && inp.mode === 'sim')) await inp.startSimulation();
  } else if (!(running && inp.mode === 'mic')) {
    await inp.startMic();
  }
  return inp;
}

/** Korean explanation for an error thrown by ensureInput()/startMic(). */
function inputErrorMessage(err) {
  switch (err?.code) {
    case 'insecure':
      return '마이크는 HTTPS 주소에서만 사용할 수 있어요. https:// 로 시작하는 주소로 접속해 주세요.';
    case 'denied':
      return '마이크 권한이 거부되었어요. 주소창의 자물쇠(사이트 설정) → 권한에서 마이크를 허용한 뒤 다시 시도해 주세요.';
    case 'unsupported':
      return '이 브라우저는 마이크 입력이나 오디오 기능을 지원하지 않아요. 최신 Chrome 또는 삼성 인터넷을 사용해 주세요.';
    default:
      return `마이크를 시작하지 못했어요.${err?.message ? ` (${err.message})` : ''} 다른 앱이 마이크를 쓰고 있지 않은지 확인해 주세요.`;
  }
}

settings.on('change', (key, value) => {
  if (key === 'sensitivity') input?.setSensitivity(value);
  else if (key === 'a4') input?.setA4(value);
  else if (key === 'masterVolume') {
    if (audioUnlocked && audio) {
      try { audio.setMasterVolume(value); } catch (err) { console.warn(err); }
    }
  } else if (key === 'inputMode') {
    if (input && input.mode && input.mode !== value) {
      try { input.stop(); } catch (err) { console.warn(err); }
    }
  } else if (key === 'keepAwake' && !value) {
    keepAwake(false);
  }
});

// ---------------------------------------------------------------- fullscreen / orientation / wake lock

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

async function lockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
      return true;
    }
  } catch { /* only allowed in fullscreen / installed apps */ }
  return false;
}

async function requestFullscreen() {
  const el = document.documentElement;
  try {
    if (!fullscreenElement()) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    }
  } catch (err) {
    console.warn('[app] fullscreen', err);
  }
  await lockLandscape();
  return !!fullscreenElement();
}

async function exitFullscreen() {
  try {
    if (fullscreenElement()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  } catch (err) {
    console.warn('[app] exit fullscreen', err);
  }
}

async function toggleFullscreen() {
  if (fullscreenElement()) {
    await exitFullscreen();
    return false;
  }
  return requestFullscreen();
}

function orientation() {
  return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
}

let wakeWanted = false;
let wakeSentinel = null;

async function keepAwake(on) {
  wakeWanted = !!on && settings.get('keepAwake');
  if (!wakeWanted) {
    const s = wakeSentinel;
    wakeSentinel = null;
    if (s && !s.released) {
      try { await s.release(); } catch { /* ignore */ }
    }
    return false;
  }
  if (!('wakeLock' in navigator)) return false;
  if (wakeSentinel && !wakeSentinel.released) return true;
  if (document.visibilityState !== 'visible') return false;
  try {
    const s = await navigator.wakeLock.request('screen');
    if (!wakeWanted) {
      s.release().catch(() => {});
      return false;
    }
    wakeSentinel = s;
    s.addEventListener('release', () => {
      if (wakeSentinel === s) wakeSentinel = null;
    });
    return true;
  } catch (err) {
    console.warn('[app] wake lock', err);
    return false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeWanted) keepAwake(true);
});

function updateViewportVars() {
  const root = document.documentElement;
  root.style.setProperty('--app-h', `${window.innerHeight}px`);
  document.body.dataset.orientation = orientation();
}

function onFullscreenChange() {
  document.body.classList.toggle('is-fullscreen', !!fullscreenElement());
}

// ---------------------------------------------------------------- router

const sections = {};
const modCache = new Map();
let current = null; // { name, mod, root, params }
let stack = [];
let navQueue = Promise.resolve();
let navigating = false;

function loadScreen(name) {
  if (!modCache.has(name)) {
    const p = LOADERS[name]().catch((err) => {
      modCache.delete(name);
      throw err;
    });
    modCache.set(name, p);
  }
  return modCache.get(name);
}

function enqueue(task) {
  const run = async () => {
    navigating = true;
    try {
      await task();
    } catch (err) {
      console.error('[router]', err);
    } finally {
      navigating = false;
    }
  };
  navQueue = navQueue.then(run, run);
  // A navigation requested while another one is running (e.g. from inside mount/unmount) is queued; we return
  // immediately so a screen awaiting app.go() inside its own mount cannot deadlock the queue.
  return navigating ? Promise.resolve() : navQueue;
}

function pushToStack(name, params, replace) {
  if (name === 'home') {
    stack = [{ name, params }];
    return;
  }
  const idx = stack.findIndex((e) => e.name === name);
  if (idx >= 0) {
    stack = stack.slice(0, idx);
    stack.push({ name, params });
    return;
  }
  const top = stack[stack.length - 1];
  if (top && (replace || TRANSIENT.has(top.name))) stack[stack.length - 1] = { name, params };
  else stack.push({ name, params });
}

async function mountScreen(name, params) {
  ensureAppHistoryEntry();
  keepAwake(false);
  if (current) {
    const prev = current;
    current = null;
    try {
      await prev.mod.unmount?.();
    } catch (err) {
      console.error(`[router] ${prev.name}.unmount`, err);
    }
    prev.root.replaceChildren();
    prev.root.hidden = true;
  }
  let mod;
  try {
    mod = await loadScreen(name);
  } catch (err) {
    console.error(`[router] load ${name}`, err);
    toast('화면을 불러오지 못했어요. 네트워크 상태를 확인하고 새로고침해 주세요.', { type: 'error' });
    if (name !== 'home') {
      stack = [];
      pushToStack('home', {});
      await mountScreen('home', {});
    }
    return;
  }
  const root = sections[name];
  root.replaceChildren();
  root.hidden = false;
  current = { name, mod, root, params };
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
  root.scrollTop = 0;
  try {
    await mod.mount(root, params, app);
  } catch (err) {
    console.error(`[router] ${name}.mount`, err);
    toast(`화면을 여는 중 오류가 발생했어요.${err?.message ? ` (${err.message})` : ''}`, { type: 'error' });
    if (name !== 'home') {
      try { await mod.unmount?.(); } catch { /* ignore */ }
      root.replaceChildren();
      root.hidden = true;
      current = null;
      stack = [];
      pushToStack('home', {});
      await mountScreen('home', {});
    } else {
      root.replaceChildren(fatalPanel(err));
    }
  }
}

function fatalPanel(err) {
  const box = document.createElement('div');
  box.className = 'fatal panel';
  const title = document.createElement('h2');
  title.textContent = '앱을 시작하지 못했어요';
  const msg = document.createElement('p');
  msg.className = 'muted';
  msg.textContent = err?.message || String(err);
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.type = 'button';
  btn.textContent = '새로고침';
  btn.addEventListener('click', () => location.reload());
  box.append(title, msg, btn);
  return box;
}

function go(name, params = {}, opts = {}) {
  if (!SCREENS.includes(name)) {
    console.error(`[router] unknown screen "${name}"`);
    name = 'home';
    params = {};
  }
  return enqueue(async () => {
    pushToStack(name, params || {}, !!opts.replace);
    await mountScreen(name, params || {});
  });
}

function back() {
  return enqueue(async () => {
    if (current?.name === 'play' && current.params?.returnTo && SCREENS.includes(current.params.returnTo)) {
      const target = current.params.returnTo;
      const targetParams = current.params.returnParams || {};
      pushToStack(target, targetParams, true);
      await mountScreen(target, targetParams);
      return;
    }
    if (stack.length > 1) {
      stack.pop();
      const prev = stack[stack.length - 1];
      await mountScreen(prev.name, prev.params || {});
      return;
    }
    pushToStack('home', {});
    await mountScreen('home', {});
  });
}

// ---------------------------------------------------------------- hardware back button (history API)
// Browser history holds exactly two entries for the app: a 'root' guard and an 'app' entry. Pressing back pops to the
// guard; we then navigate inside the app and push the 'app' entry again. On the home screen the first back press only
// shows a hint and the second one leaves the app.

let rearmTimer = 0;

let historyReady = false;

function ensureAppHistoryEntry() {
  if (!historyReady) return;
  if (history.state?.pk !== 'app') {
    clearTimeout(rearmTimer);
    try { history.pushState({ pk: 'app' }, '', location.href); } catch { /* ignore */ }
  }
}

// Chrome skips history entries pushed without a user activation, so the 'app' entry is first pushed from inside the
// user's first click/keypress rather than at load time.
function initHistory() {
  const st = history.state?.pk;
  if (st !== 'app' && st !== 'root') {
    try { history.replaceState({ pk: 'root' }, '', location.href); } catch { /* ignore */ }
  }
  const arm = () => {
    window.removeEventListener('click', arm, true);
    window.removeEventListener('keydown', arm, true);
    historyReady = true;
    ensureAppHistoryEntry();
  };
  window.addEventListener('click', arm, true);
  window.addEventListener('keydown', arm, true);
}

window.addEventListener('popstate', async (e) => {
  if (e.state?.pk === 'app') return;
  if (closeTopModal()) {
    ensureAppHistoryEntry();
    return;
  }
  const atRoot = stack.length <= 1 && (!current || current.name === 'home');
  if (atRoot) {
    toast('뒤로 버튼을 한 번 더 누르면 앱이 종료돼요.', { duration: 2000 });
    clearTimeout(rearmTimer);
    rearmTimer = setTimeout(() => {
      if (history.state?.pk !== 'app') {
        try { history.pushState({ pk: 'app' }, '', location.href); } catch { /* ignore */ }
      }
    }, 2200);
    return;
  }
  ensureAppHistoryEntry();
  const mod = current?.mod;
  try {
    if (mod?.onBack && (await mod.onBack()) === true) return;
    if (mod?.beforeLeave && (await mod.beforeLeave()) === false) return;
  } catch (err) {
    console.error('[router] back hook', err);
  }
  back();
});

// ---------------------------------------------------------------- global errors

let lastErr = { msg: '', at: 0 };

function reportError(err) {
  if (!err) return;
  const name = err.name || '';
  const msg = String(err.message || err.reason || err || '');
  if (name === 'AbortError' || /ResizeObserver loop|^Script error\.?$/i.test(msg)) return;
  const text = err.code && ['insecure', 'denied', 'unsupported', 'error'].includes(err.code)
    ? inputErrorMessage(err)
    : `오류가 발생했어요: ${msg || '알 수 없는 오류'}`;
  const now = Date.now();
  if (text === lastErr.msg && now - lastErr.at < 3000) return;
  lastErr = { msg: text, at: now };
  toast(text, { type: 'error' });
}

window.addEventListener('error', (e) => {
  if (!e || (!e.error && !e.message)) return;
  console.error(e.error || e.message);
  reportError(e.error || { message: e.message });
});

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  reportError(e.reason);
});

// ---------------------------------------------------------------- service worker

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (query.has('nosw')) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch { /* ignore */ }
    return;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  try {
    const hadController = !!navigator.serviceWorker.controller;
    await navigator.serviceWorker.register('sw.js');
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('새 버전이 설치되었어요. 앱을 다시 열면 적용돼요.', { type: 'success', duration: 4000 });
    });
  } catch (err) {
    console.warn('[app] service worker registration failed', err);
  }
}

/** Removes the service worker and its caches, then reloads (settings → 문제 해결). */
async function hardReload() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch { /* ignore */ }
  try {
    const keys = await caches?.keys?.() || [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* ignore */ }
  location.reload();
}

// ---------------------------------------------------------------- app object

const app = {
  version: APP_VERSION,
  go,
  back,
  settings,
  library,
  scores,
  getInput,
  ensureInput,
  inputErrorMessage,
  unlockAudio: unlock,
  toast: (msg, type = 'info') => toast(msg, typeof type === 'object' ? type : { type }),
  requestFullscreen,
  exitFullscreen,
  toggleFullscreen,
  isFullscreen: () => !!fullscreenElement(),
  fullscreenSupported,
  lockLandscape,
  orientation,
  keepAwake,
  hardReload,
  get screen() { return current?.name || null; },
};

// ---------------------------------------------------------------- boot

function hideBootSplash() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 400);
}

async function boot() {
  for (const name of SCREENS) {
    let sec = document.querySelector(`section.screen[data-screen="${name}"]`);
    if (!sec) {
      sec = document.createElement('section');
      sec.className = 'screen';
      sec.dataset.screen = name;
      sec.hidden = true;
      (document.getElementById('app') || document.body).append(sec);
    }
    sections[name] = sec;
  }

  updateViewportVars();
  window.addEventListener('resize', updateViewportVars);
  window.addEventListener('orientationchange', () => setTimeout(updateViewportVars, 250));
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('contextmenu', (e) => {
    if (document.body.dataset.screen === 'play' && !e.target.closest?.('input, textarea')) e.preventDefault();
  });
  initHistory();
  await Promise.all([library.init(), audioReady]);
  if (!audio) toast('오디오 기능을 불러오지 못했어요. 터치 모드로만 플레이할 수 있어요.', { type: 'error', duration: 6000 });
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* ignore */ }

  window.__pkBooted = true;
  await go('home');
  hideBootSplash();

  const deep = query.get('screen');
  if (deep && ['settings', 'calibrate', 'editor'].includes(deep)) go(deep, {});

  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker, { once: true });
}

window.pianoKaraoke = app;
boot().catch((err) => {
  console.error('[app] boot failed', err);
  window.__pkBooted = true;
  hideBootSplash();
  const home = sections.home || document.body;
  home.hidden = false;
  home.replaceChildren(fatalPanel(err));
});

export default app;
