// Service worker: precaches the whole app for offline use.
// Network-first for every same-origin GET (falls back to the cache when offline or slow), so a new deploy is
// picked up on the next load without mixing old and new ES modules.

const CACHE = 'pk-v2';
const NETWORK_TIMEOUT_MS = 4000;

const PRECACHE = [
  './',
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

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add files one by one so a single missing file does not abort the whole install.
    await Promise.allSettled(PRECACHE.map(async (path) => {
      const res = await fetch(new Request(path, { cache: 'reload' }));
      if (res.ok) await cache.put(path, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function fromNetwork(request, cache, cacheKey) {
  const res = await fetch(request, { cache: 'no-cache' });
  if (res && res.ok && res.type === 'basic') {
    try { await cache.put(cacheKey, res.clone()); } catch { /* quota: serve anyway */ }
  }
  return res;
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has('range')) return;

  const shellUrl = new URL('./', self.registration.scope).href;
  const path = url.origin + url.pathname;
  const isNav = request.mode === 'navigate';
  // Only the app's own page (with any ?query such as ?input=sim) is handled as the app shell.
  if (isNav && path !== shellUrl && path !== `${shellUrl}index.html`) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cacheKey = isNav ? shellUrl : request;
    const network = fromNetwork(isNav ? shellUrl : request, cache, cacheKey).catch(() => null);
    // Wait for the network first; only if it fails or is too slow, fall back to the cache.
    const first = await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
    if (first && first.ok) return first;
    const cached = await cache.match(cacheKey, { ignoreSearch: isNav, ignoreVary: true })
      || (isNav ? await cache.match('index.html', { ignoreVary: true }) : null);
    if (cached) {
      if (!first) event.waitUntil(network); // a slow response still refreshes the cache
      return cached;
    }
    const late = first || await network;
    if (late) return late;
    return new Response('오프라인 상태라 파일을 불러올 수 없어요.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
