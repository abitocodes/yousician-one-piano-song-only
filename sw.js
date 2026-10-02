// Service worker: offline cache that always serves ONE consistent file set per deploy.
//
// VERSION is a content hash of every file in PRECACHE and of this script, written by tools/stamp-version.mjs
// (`npm run stamp`; tests/version.test.js fails while it is stale). So every deploy that changes a file also changes
// this script's bytes and its cache name, and the browser installs a new worker:
//   install  → downloads ALL files (bypassing the HTTP cache) into a fresh cache; any failure fails the install,
//              so a half-downloaded version never activates. The new worker then waits.
//   (page)   → js/app.js asks the waiting worker to take over only at a safe point (home screen), never mid-song
//              or mid-edit, and reloads once it has (js/core/lifecycle.js).
//   activate → deletes this app's older caches (only ours: other apps may share the origin), claims the page.
// Within a version, the app shell (index.html) and every precached file come from that version's cache, so a page
// never pairs one deploy's markup with another's scripts and never links old and new modules. The browser still
// checks sw.js on every navigation, which is how a new deploy is found.

const VERSION = '1.0.0+d76df55e';
const CACHE_PREFIX = 'piano-karaoke-';
// Generic cache names of pre-release builds (e.g. a developer's localhost). Ours only when they hold this app's files.
const LEGACY_CACHES = ['pk-v1', 'pk-v2'];

// Every runtime file of the app (paths relative to this script). tests/version.test.js checks that all js/css files
// are listed and that every entry exists: one missing file would make every install fail.
const PRECACHE = [
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'css/base.css',
  'css/play.css',
  'css/editor.css',
  'css/calibrate.css',
  'js/app.js',
  'js/ui/dom.js',
  'js/core/emitter.js',
  'js/core/notes.js',
  'js/core/keyboard.js',
  'js/core/lyrics.js',
  'js/core/song.js',
  'js/core/midi.js',
  'js/core/notation.js',
  'js/core/musicxml.js',
  'js/core/unzip.js',
  'js/core/storage.js',
  'js/core/lifecycle.js',
  'js/audio/engine.js',
  'js/audio/dsp.js',
  'js/audio/detector.js',
  'js/audio/input.js',
  'js/audio/capture-worklet.js',
  'js/audio/synth.js',
  'js/audio/backing.js',
  'js/game/clock.js',
  'js/game/judge.js',
  'js/game/session.js',
  'js/game/renderer.js',
  'js/game/karaoke.js',
  'js/screens/home.js',
  'js/screens/results.js',
  'js/screens/settings.js',
  'js/screens/play.js',
  'js/screens/calibrate.js',
  'js/screens/editor.js',
  'js/data/demo-songs.js',
];

const SCOPE = self.registration.scope; // e.g. https://user.github.io/yousician-one-piano-song-only/
const SCOPE_PATH = new URL(SCOPE).pathname;
// The scope is part of the name: a GitHub Pages origin hosts many projects (or two copies of this app), and Cache
// Storage is per origin, so caches are only ever touched when they belong to this app at this path.
const CACHE = `${CACHE_PREFIX}${VERSION}@${SCOPE_PATH}`;
const SHELL_URL = new URL('index.html', SCOPE).href;
const PRECACHED = new Set(PRECACHE.map((p) => new URL(p, SCOPE).href));

async function isOwnCache(key) {
  if (key.startsWith(CACHE_PREFIX)) return key.endsWith(`@${SCOPE_PATH}`);
  if (!LEGACY_CACHES.includes(key)) return false;
  try {
    return !!(await (await caches.open(key)).match(new URL('js/app.js', SCOPE).href));
  } catch {
    return false;
  }
}

// A response that followed a redirect cannot answer a navigation; store a plain copy instead.
async function storable(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function precacheAll() {
  // Download everything first, then write: a failed or stale download leaves no partial cache behind.
  const entries = await Promise.all(PRECACHE.map(async (path) => {
    const url = new URL(path, SCOPE).href;
    const res = await fetch(new Request(url, { cache: 'reload' }));
    if (!res.ok) throw new Error(`[sw] precache ${path}: HTTP ${res.status}`);
    return [url, await storable(res)];
  }));
  // The module graph's root must come from the same deploy as this script (guards against a CDN edge that still
  // serves an older app.js right after a deploy). The install fails and the browser retries on a later check.
  const appEntry = entries.find(([url]) => url.endsWith('/js/app.js'));
  if (appEntry && !(await appEntry[1].clone().text()).includes(`'${VERSION}'`)) {
    throw new Error(`[sw] js/app.js is not version ${VERSION}`);
  }
  // Normally a fresh cache. Should one by this name exist (only an identical version can have it), it is never
  // deleted here: an active worker may be serving from it.
  const created = !(await caches.has(CACHE));
  const cache = await caches.open(CACHE);
  try {
    await Promise.all(entries.map(([url, res]) => cache.put(url, res)));
  } catch (err) {
    if (created) await caches.delete(CACHE);
    throw err;
  }
}

// The very first worker activates on its own. An update waits until a page asks for it (SKIP_WAITING).
self.addEventListener('install', (event) => {
  event.waitUntil(precacheAll());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const old = await Promise.all(keys.map(async (k) => k !== CACHE && (await isOwnCache(k))));
    await Promise.all(keys.filter((k, i) => old[i]).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'GET_VERSION' && event.ports && event.ports[0]) {
    // A page that this worker just took over checks that it runs the same version (js/core/lifecycle.js).
    event.ports[0].postMessage({ type: 'VERSION', version: VERSION });
  }
});

function offlineResponse() {
  return new Response('오프라인 상태라 파일을 불러올 수 없어요.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// App shell: the active version's copy, so the markup always matches the scripts and styles it loads (and a launch
// never waits for a slow network). The network only when it is missing.
async function fromShellCache(request) {
  const cache = await caches.open(CACHE);
  const shell = await cache.match(SHELL_URL, { ignoreVary: true });
  if (shell) return shell;
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

// Precached file: always the active version's copy, so the module graph stays consistent.
async function fromVersionCache(request, url) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url, { ignoreVary: true });
  if (hit) return hit;
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

// Anything else inside the app (not part of the module graph): network, remembered for offline use.
async function fromNetworkThenCache(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) event.waitUntil(cache.put(request, res.clone()).catch(() => {}));
    return res;
  } catch {
    return (await cache.match(request, { ignoreVary: true })) || offlineResponse();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return;
  const path = url.origin + url.pathname;

  if (request.mode === 'navigate') {
    // Only the app's own page (with any ?query such as ?input=sim) is the app shell.
    if (path !== SCOPE && path !== SHELL_URL) return;
    event.respondWith(fromShellCache(request));
    return;
  }
  if (!url.search && PRECACHED.has(path)) {
    event.respondWith(fromVersionCache(request, path));
    return;
  }
  event.respondWith(fromNetworkThenCache(event));
});
