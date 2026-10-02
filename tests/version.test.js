// Deploy/caching guarantees: the build stamp is current, sw.js precaches every runtime file, and the service worker
// installs atomically, cleans up only its own caches and serves one consistent file set per version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { ROOT, computeStamp, readStamps, precacheList, hashInput, stamp } from '../tools/stamp-version.mjs';
import { claimOnce, safeSessionStorage, memoryStorage } from '../js/core/storage.js';

const SW_SOURCE = readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const PRECACHE = precacheList(SW_SOURCE);

// ---------------------------------------------------------------- build stamp

test('build stamp is current (sw.js VERSION = js/app.js APP_VERSION = content hash of the precached files)', () => {
  const { version } = computeStamp();
  const cur = readStamps();
  assert.ok(
    cur.sw === version && cur.app === version,
    `The build stamp is stale: sw.js VERSION is '${cur.sw}' and js/app.js APP_VERSION is '${cur.app}', `
      + `but the precached files now hash to '${version}'.\n`
      + "Run 'npm run stamp' after changing any runtime file (js/, css/, index.html, manifest, icons) and commit "
      + 'the result; without a new stamp, installed apps never receive the change.\n'
      + 'If several people or agents are editing files at the same time, the hash keeps moving until they are '
      + "done: whoever integrates the changes runs 'npm run stamp' once at the end, then runs the tests again.",
  );
});

test('stamp tool: line endings, BOM and the sw.js / app.js stamp lines do not change the hash input', () => {
  const lf = Buffer.from('a\nb\n');
  assert.deepEqual(hashInput('js/x.js', Buffer.from('a\r\nb\r\n')), lf);
  assert.deepEqual(hashInput('css/x.css', Buffer.from('﻿a\nb\n')), lf);
  const appA = Buffer.from("// x\nexport const APP_VERSION = '1.0.0+aaaaaaaa';\nfoo();\n");
  const appB = Buffer.from("// x\r\nexport const APP_VERSION = '1.0.0+bbbbbbbb';\r\nfoo();\r\n");
  assert.deepEqual(hashInput('js/app.js', appA), hashInput('js/app.js', appB));
  assert.notDeepEqual(hashInput('js/app.js', appA), hashInput('js/app.js', Buffer.from("foo();\n")));
  const swA = Buffer.from("// sw\nconst VERSION = '1.0.0+aaaaaaaa';\nconst X = 1;\n");
  const swB = Buffer.from("// sw\r\nconst VERSION = '1.0.0+bbbbbbbb';\r\nconst X = 1;\r\n");
  assert.deepEqual(hashInput('sw.js', swA), hashInput('sw.js', swB));
  assert.notDeepEqual(hashInput('sw.js', swA), hashInput('sw.js', Buffer.from("// sw\nconst VERSION = '';\nconst X = 2;\n")));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(hashInput('icons/a.png', png), png, 'binary files are hashed as they are');
});

test('stamp tool: writes both stamps, changes only when a precached file changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pk-stamp-'));
  try {
    mkdirSync(path.join(dir, 'js'));
    writeFileSync(path.join(dir, 'package.json'), '{ "version": "2.1.0" }\n');
    writeFileSync(path.join(dir, 'sw.js'),
      "const VERSION = 'x';\nconst PRECACHE = [\n  './',\n  'index.html',\n  'js/app.js',\n];\n");
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\n');
    writeFileSync(path.join(dir, 'js/app.js'), "export const APP_VERSION = 'x';\n");

    const first = stamp(dir);
    assert.match(first.version, /^2\.1\.0\+[0-9a-f]{8}$/);
    assert.equal(first.changed, true);
    assert.deepEqual(readStamps(dir), { sw: first.version, app: first.version });
    assert.deepEqual(computeStamp(dir).files, ['index.html', 'js/app.js', 'sw.js'], "'./' is not a file");

    assert.equal(stamp(dir).changed, false, 'stamping twice is a no-op (the stamps themselves are not hashed)');
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html>\r\n');
    assert.equal(computeStamp(dir).version, first.version, 'CRLF checkout hashes like LF');

    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>new</title>\n');
    const second = stamp(dir);
    assert.notEqual(second.version, first.version);
    assert.deepEqual(readStamps(dir), { sw: second.version, app: second.version });

    // A deploy that changes only the worker gets a new version too, so it never installs into the live cache.
    writeFileSync(path.join(dir, 'sw.js'), `${readFileSync(path.join(dir, 'sw.js'), 'utf8')}// tweak\n`);
    const third = stamp(dir);
    assert.notEqual(third.version, second.version, 'a change to sw.js changes the stamp');
    assert.deepEqual(readStamps(dir), { sw: third.version, app: third.version });
    assert.equal(stamp(dir).changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- PRECACHE coverage

function walk(dir, ext) {
  const out = [];
  for (const ent of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walk(rel, ext));
    else if (ext.some((e) => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

test('sw.js PRECACHE lists every runtime file of the repo', () => {
  const runtime = [
    'index.html',
    'manifest.webmanifest',
    ...walk('js', ['.js']),
    ...walk('css', ['.css']),
    ...walk('icons', ['.png', '.svg', '.ico', '.webp']),
  ];
  const missing = runtime.filter((f) => !PRECACHE.includes(f));
  assert.deepEqual(missing, [],
    `Add these files to PRECACHE in sw.js (then run 'npm run stamp'); otherwise the offline app and the `
    + `consistent-version guarantee break: ${missing.join(', ')}`);
});

test('every PRECACHE entry exists (one missing file would make every service worker install fail)', () => {
  const absent = PRECACHE.filter((f) => !existsSync(path.join(ROOT, f)));
  assert.deepEqual(absent, []);
  assert.equal(new Set(PRECACHE).size, PRECACHE.length, 'no duplicates');
  assert.ok(!PRECACHE.includes('sw.js'));
});

test('files referenced by index.html and the manifest are precached', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\s(?:href|src)="([^"#?:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.includes('js/app.js') && refs.includes('css/base.css'));
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) refs.push(icon.src);
  assert.deepEqual(refs.filter((r) => !PRECACHE.includes(r)), []);
});

test('manifest id resolves inside the app (no origin-wide id on a shared github.io origin)', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  // The id is resolved against the ORIGIN of start_url, so a relative id such as './' would mean the origin root.
  if ('id' in manifest) assert.ok(String(manifest.id).startsWith('/') && manifest.id !== '/');
});

test('page and sw.js agree on which caches belong to this app; the page never touches other registrations', () => {
  const lifecycle = readFileSync(path.join(ROOT, 'js/core/lifecycle.js'), 'utf8');
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const prefix = (src) => /(?:const|var) CACHE_PREFIX = '([^']+)'/.exec(src)?.[1];
  const legacy = (src) => /const LEGACY_CACHES = (\[[^\]]*\])/.exec(src)?.[1];
  assert.ok(prefix(SW_SOURCE));
  assert.equal(prefix(lifecycle), prefix(SW_SOURCE));
  assert.equal(prefix(html), prefix(SW_SOURCE), 'the recovery script in index.html');
  assert.equal(legacy(lifecycle), legacy(SW_SOURCE));
  for (const src of [lifecycle, html, app]) {
    assert.ok(!/getRegistrations\s*\(/.test(src), 'getRegistrations() returns every app on the origin');
  }
});

// ---------------------------------------------------------------- service worker behaviour (sw.js in a sandbox)

const SCOPE = 'https://example.test/app/';
const TEST_VERSION = '9.9.9+abcdef12';
const CACHE = `piano-karaoke-${TEST_VERSION}@/app/`;

function memoryCaches() {
  const store = new Map(); // name → Map(url → Response)
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  const cacheObj = (map) => ({
    async match(req, opts = {}) {
      let key = keyOf(req);
      if (opts.ignoreSearch) key = key.split('?')[0];
      const hit = map.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) { map.set(keyOf(req), res.clone()); },
    async keys() { return [...map.keys()]; },
  });
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      return cacheObj(store.get(name));
    },
    async keys() { return [...store.keys()]; },
    async has(name) { return store.has(name); },
    async delete(name) { return store.delete(name); },
  };
}

function siteFiles(version = TEST_VERSION) {
  const files = new Map();
  for (const p of PRECACHE) files.set(`${SCOPE}${p}`, `/* ${p} v1 */`);
  files.set(`${SCOPE}js/app.js`, `export const APP_VERSION = '${version}';\n`);
  files.set(`${SCOPE}index.html`, '<!doctype html><title>cached shell</title>');
  return files;
}

/**
 * Runs sw.js in a sandbox. `network(url, request)` → Response | throws | Promise; default serves `files`.
 * Returns helpers to dispatch install / activate / fetch / message events.
 */
function loadWorker({ files = siteFiles(), network, caches = memoryCaches() } = {}) {
  const listeners = {};
  const calls = { fetch: [], skipWaiting: 0, claim: 0 };
  const serve = network || ((url) => {
    if (!files.has(url)) return new Response('not found', { status: 404 });
    return new Response(files.get(url), { status: 200 });
  });
  const sandbox = {
    registration: { scope: SCOPE },
    location: new URL(`${SCOPE}sw.js`),
    clients: { claim: async () => { calls.claim++; } },
    skipWaiting: async () => { calls.skipWaiting++; },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    caches,
    fetch: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      calls.fetch.push({ url, cache: req.cache });
      return serve(url, req);
    },
    Request,
    Response,
    Headers,
    URL,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), // NAV_TIMEOUT_MS elapses at once
    clearTimeout,
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE.replace(/^const VERSION = '[^']*';/m, `const VERSION = '${TEST_VERSION}';`), sandbox,
    { filename: 'sw.js' });

  const lifecycle = async (type) => {
    const waits = [];
    listeners[type]({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return {
    calls,
    caches,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    message: (data, ports = []) => listeners.message({ data, ports }),
    /** → Response, or undefined when the worker leaves the request to the browser. */
    async fetch(url, { mode = 'no-cors', method = 'GET', headers = {} } = {}) {
      const request = { url, mode, method, headers: new Headers(headers), cache: 'default' };
      let responded = null;
      const waits = [];
      listeners.fetch({ request, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
      if (!responded) return undefined;
      const res = await responded;
      await Promise.all(waits);
      return res;
    },
  };
}

const textOf = async (res) => (res ? res.text() : null);

test('sw install downloads every PRECACHE file, bypassing the HTTP cache, into the versioned cache', async () => {
  const sw = loadWorker();
  await sw.install();
  assert.deepEqual(await sw.caches.keys(), [CACHE]);
  const cached = sw.caches.store.get(CACHE);
  assert.deepEqual([...cached.keys()].sort(), PRECACHE.map((p) => `${SCOPE}${p}`).sort());
  assert.equal(sw.calls.fetch.length, PRECACHE.length);
  assert.ok(sw.calls.fetch.every((c) => c.cache === 'reload'));
  assert.equal(sw.calls.skipWaiting, 0, 'an update waits until the page asks for it');
});

test('sw install is all-or-nothing: one missing file, a network error or a stale app.js fails it', async () => {
  const missing = siteFiles();
  missing.delete(`${SCOPE}js/screens/editor.js`);
  let sw = loadWorker({ files: missing });
  await assert.rejects(sw.install(), /editor\.js/);
  assert.deepEqual(await sw.caches.keys(), [], 'no half-filled cache is left behind');

  const files = siteFiles();
  sw = loadWorker({
    network: (url) => {
      if (url.endsWith('css/play.css')) throw new TypeError('Failed to fetch');
      return new Response(files.get(url));
    },
  });
  await assert.rejects(sw.install());
  assert.deepEqual(await sw.caches.keys(), []);

  sw = loadWorker({ files: siteFiles('9.9.8+00000000') }); // a CDN edge still serving the previous app.js
  await assert.rejects(sw.install(), /not version/);
  assert.deepEqual(await sw.caches.keys(), []);
});

test('sw install never takes over on its own, not even next to a legacy cache (the page decides when)', async () => {
  const caches = memoryCaches();
  await (await caches.open('pk-v2')).put(`${SCOPE}js/app.js`, new Response('old'));
  const sw = loadWorker({ caches });
  await sw.install();
  assert.equal(sw.calls.skipWaiting, 0);
});

test('sw install failure never deletes an existing cache of the same name (a live worker may serve from it)',
  async () => {
    const caches = memoryCaches();
    const live = await caches.open(CACHE);
    await live.put(`${SCOPE}js/core/song.js`, new Response('/* live */'));
    const failing = { ...live, put: async () => { throw new Error('QuotaExceededError: quota'); } };
    const open = caches.open;
    caches.open = async (name) => (name === CACHE ? failing : open(name));
    const sw = loadWorker({ caches });
    await assert.rejects(sw.install(), /quota/);
    assert.deepEqual(await caches.keys(), [CACHE]);
    assert.equal(await caches.store.get(CACHE).get(`${SCOPE}js/core/song.js`).text(), '/* live */');

    // A cache this install created is removed again.
    const fresh = memoryCaches();
    const freshOpen = fresh.open;
    fresh.open = async (name) => {
      const c = await freshOpen(name);
      return { ...c, put: async () => { throw new Error('QuotaExceededError: quota'); } };
    };
    await assert.rejects(loadWorker({ caches: fresh }).install(), /quota/);
    assert.deepEqual(await fresh.keys(), []);
  });

test('sw activate deletes only this app\'s older caches and claims the page', async () => {
  const caches = memoryCaches();
  for (const name of ['piano-karaoke-1.0.0+11111111@/app/', 'piano-karaoke-1.0.0+11111111@/other-app/',
    'pk-v1', 'pk-v2', 'someone-elses-cache']) await caches.open(name);
  // Generic legacy names count as ours only when they hold this app's files at this path.
  await (await caches.open('pk-v2')).put(`${SCOPE}js/app.js`, new Response('old app'));
  await (await caches.open('pk-v1')).put('https://example.test/js/app.js', new Response('another app'));
  const sw = loadWorker({ caches });
  await sw.install();
  await sw.activate();
  assert.deepEqual((await caches.keys()).sort(),
    [CACHE, 'piano-karaoke-1.0.0+11111111@/other-app/', 'pk-v1', 'someone-elses-cache'].sort());
  assert.equal(sw.calls.claim, 1);
});

test('sw serves precached files from the active version, never mixing in newer network files', async () => {
  const files = siteFiles();
  const sw = loadWorker({ files });
  await sw.install();
  files.set(`${SCOPE}js/core/song.js`, '/* deployed later */');
  sw.calls.fetch.length = 0;
  assert.equal(await textOf(await sw.fetch(`${SCOPE}js/core/song.js`)), '/* js/core/song.js v1 */');
  assert.equal(await textOf(await sw.fetch(`${SCOPE}css/base.css`)), '/* css/base.css v1 */');
  assert.equal(sw.calls.fetch.length, 0, 'no network round trip per module');
});

test('sw: app shell navigation comes from the active version (never a newer deploy\'s markup)', async () => {
  let mode = 'online';
  const files = siteFiles();
  const sw = loadWorker({
    network: (url) => {
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      if (mode === 'stalled') return new Promise(() => {});
      if (url.startsWith(`${SCOPE}?`) || url === SCOPE) return new Response('newer deploy shell');
      return new Response(files.get(url) ?? 'nf', { status: files.has(url) ? 200 : 404 });
    },
  });
  // Before anything is cached (e.g. the cache was cleared), the network answers.
  assert.equal(await textOf(await sw.fetch(`${SCOPE}?input=sim`, { mode: 'navigate' })), 'newer deploy shell');
  await sw.install();
  sw.calls.fetch.length = 0;
  assert.match(await textOf(await sw.fetch(`${SCOPE}?input=sim`, { mode: 'navigate' })), /cached shell/);
  mode = 'offline';
  assert.match(await textOf(await sw.fetch(`${SCOPE}index.html`, { mode: 'navigate' })), /cached shell/);
  mode = 'stalled';
  assert.match(await textOf(await sw.fetch(SCOPE, { mode: 'navigate' })), /cached shell/, 'no wait on a slow network');
  assert.equal(sw.calls.fetch.length, 0);
  // Other pages are left to the browser.
  assert.equal(await sw.fetch(`${SCOPE}README.md`, { mode: 'navigate' }), undefined);
  assert.equal(await sw.fetch('https://example.test/other-app/', { mode: 'navigate' }), undefined);
});

test('sw: other same-origin files are network-first, remembered for offline; foreign requests are ignored',
  async () => {
    let online = true;
    const files = siteFiles();
    files.set(`${SCOPE}data/extra.json`, '{"a":1}');
    const sw = loadWorker({
      network: (url) => {
        if (!online) throw new TypeError('Failed to fetch');
        return new Response(files.get(url) ?? 'nf', { status: files.has(url) ? 200 : 404 });
      },
    });
    await sw.install();
    assert.equal(await textOf(await sw.fetch(`${SCOPE}data/extra.json`)), '{"a":1}');
    online = false;
    assert.equal(await textOf(await sw.fetch(`${SCOPE}data/extra.json`)), '{"a":1}');
    const unknown = await sw.fetch(`${SCOPE}data/never-seen.json`);
    assert.equal(unknown.status, 503);

    assert.equal(await sw.fetch('https://cdn.example.org/lib.js'), undefined);
    assert.equal(await sw.fetch('https://example.test/other-app/x.js'), undefined, 'outside the scope');
    assert.equal(await sw.fetch(`${SCOPE}js/app.js`, { method: 'POST' }), undefined);
    assert.equal(await sw.fetch(`${SCOPE}a.mp3`, { headers: { range: 'bytes=0-' } }), undefined);
  });

test('sw: a precached file with no cache and no network gives a 503 instead of a crash', async () => {
  const sw = loadWorker({ network: () => { throw new TypeError('Failed to fetch'); } });
  const res = await sw.fetch(`${SCOPE}js/app.js`);
  assert.equal(res.status, 503);
});

test('sw: SKIP_WAITING from the page activates the waiting worker', () => {
  const sw = loadWorker();
  sw.message({ type: 'SKIP_WAITING' });
  sw.message({ type: 'something-else' });
  sw.message(null);
  assert.equal(sw.calls.skipWaiting, 1);
});

test('sw: GET_VERSION answers with the version it serves through the given port', () => {
  const sw = loadWorker();
  const answers = [];
  sw.message({ type: 'GET_VERSION' }, [{ postMessage: (m) => answers.push(m) }]);
  sw.message({ type: 'GET_VERSION' }); // no port: ignored
  assert.deepEqual(JSON.parse(JSON.stringify(answers)), [{ type: 'VERSION', version: TEST_VERSION }]);
  assert.equal(sw.calls.skipWaiting, 0);
});

// ---------------------------------------------------------------- recovery from a version that cannot start (index.html)

const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const RECOVER_SRC = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  .find((src) => src.includes('__pkRecover'));

function loadRecover({ registration = null, online = true, cacheKeys = [], withSw = true } = {}) {
  const calls = { reloads: 0, unregistered: 0, deleted: [], timers: [], lookups: [] };
  const listeners = {};
  if (registration) registration.unregister = async () => { calls.unregistered++; return true; };
  const msg = { textContent: '', children: [], appendChild(el) { this.children.push(el); } };
  const sandbox = {
    navigator: {
      onLine: online,
      serviceWorker: withSw ? {
        getRegistration: async (url) => { calls.lookups.push(url); return registration; },
        addEventListener: (type, fn) => { listeners[type] = fn; },
      } : undefined,
    },
    location: { href: `${SCOPE}?input=sim`, reload: () => { calls.reloads++; } },
    document: { querySelector: () => msg, createElement: (tag) => ({ tag }) },
    caches: { keys: async () => [...cacheKeys], delete: async (k) => { calls.deleted.push(k); return true; } },
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    URL,
    Promise,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(RECOVER_SRC, sandbox, { filename: 'index.html' });
  return { calls, listeners, msg, sandbox, recover: () => sandbox.__pkRecover() };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

test('recovery (index.html): a fixed version that waits is activated, then the page reloads onto it', async () => {
  const posted = [];
  const r = loadRecover({ registration: { scope: SCOPE, waiting: { postMessage: (m) => posted.push(m.type) } } });
  r.recover();
  await settle();
  assert.deepEqual(posted, ['SKIP_WAITING'], 'a plain reload would not activate it');
  assert.equal(r.calls.reloads, 0, 'waits for the new worker to take over');
  assert.equal(r.calls.unregistered, 0);
  r.listeners.controllerchange();
  assert.equal(r.calls.reloads, 1);
  r.calls.timers.find((t) => t.ms === 5000).fn(); // the fallback timer does not reload twice
  assert.equal(r.calls.reloads, 1);
});

test('recovery (index.html): online without a waiting version, only this app\'s worker and caches are removed',
  async () => {
    const r = loadRecover({
      registration: { scope: SCOPE, waiting: null },
      cacheKeys: ['piano-karaoke-1.0.0+11111111@/app/', 'piano-karaoke-1.0.0+11111111@/other-app/', 'someone-else'],
    });
    r.recover();
    await settle();
    assert.equal(r.calls.unregistered, 1);
    assert.deepEqual(r.calls.deleted, ['piano-karaoke-1.0.0+11111111@/app/']);
    assert.equal(r.calls.reloads, 1);
  });

test('recovery (index.html): offline, another app\'s worker or no service worker → just reload', async () => {
  let r = loadRecover({ registration: { scope: SCOPE, waiting: null }, online: false, cacheKeys: [`piano-karaoke-x@/app/`] });
  r.recover();
  await settle();
  assert.deepEqual([r.calls.unregistered, r.calls.deleted.length, r.calls.reloads], [0, 0, 1],
    'offline, the cached version is all there is: keep it');

  r = loadRecover({ registration: { scope: 'https://example.test/', waiting: null } });
  r.recover();
  await settle();
  assert.deepEqual([r.calls.unregistered, r.calls.reloads], [0, 1], 'a parent-scope worker is not ours');

  r = loadRecover({ withSw: false });
  r.recover();
  assert.equal(r.calls.reloads, 1);
});

test('boot watchdog (index.html): after 12 s without a boot, its 새로고침 button runs the recovery', async () => {
  const r = loadRecover({ withSw: false });
  const watchdog = r.calls.timers.find((t) => t.ms === 12000);
  assert.ok(watchdog);
  watchdog.fn();
  const btn = r.msg.children.find((el) => el.tag === 'button');
  assert.equal(btn.textContent, '새로고침');
  btn.onclick();
  assert.equal(btn.disabled, true);
  assert.equal(r.calls.reloads, 1);

  const booted = loadRecover({ withSw: false });
  booted.sandbox.__pkBooted = true;
  booted.calls.timers.find((t) => t.ms === 12000).fn();
  assert.equal(booted.msg.children.length, 0, 'nothing to explain once the app booted');
});

// ---------------------------------------------------------------- reload-loop guard (js/core/storage.js)

test('claimOnce allows one claim per window and survives "reloads" through the storage', () => {
  const ss = memoryStorage();
  assert.equal(claimOnce(ss, 'k', 30000, 1000), true);
  assert.equal(claimOnce(ss, 'k', 30000, 20000), false, 'second reload within the window is refused');
  assert.equal(claimOnce(ss, 'other', 30000, 20000), true, 'keys are independent');
  assert.equal(claimOnce(ss, 'k', 30000, 31000), true, 'allowed again after the window');
  assert.equal(claimOnce(ss, 'k', 30000, 5000), true, 'a clock that went backwards does not block forever');
});

test('claimOnce refuses without a working storage (never loop unguarded)', () => {
  assert.equal(claimOnce(null, 'k', 1000), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(claimOnce(broken, 'k', 1000), false);
  const readOnly = memoryStorage();
  readOnly.setItem = () => {};
  assert.equal(claimOnce(readOnly, 'k', 1000, 50), false, 'a write that does not stick is no guard');
});

test('safeSessionStorage returns sessionStorage only when it works', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  try {
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true, writable: true });
    assert.equal(safeSessionStorage(), null);
    const ss = memoryStorage();
    globalThis.sessionStorage = ss;
    assert.equal(safeSessionStorage(), ss);
    globalThis.sessionStorage = { setItem() { throw new Error('quota'); }, removeItem() {}, getItem() { return null; } };
    assert.equal(safeSessionStorage(), null);
  } finally {
    if (had) Object.defineProperty(globalThis, 'sessionStorage', had);
    else delete globalThis.sessionStorage;
  }
});
