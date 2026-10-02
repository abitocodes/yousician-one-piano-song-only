// Build stamp: a short SHA-256 content hash over every runtime file listed in sw.js PRECACHE and over sw.js itself,
// written into sw.js (const VERSION) and js/app.js (APP_VERSION) as '<package.json version>+<hash>'.
//
//   npm run stamp            → rewrite the stamp when any runtime file changed (run before every commit/deploy)
//   node tools/stamp-version.mjs --check   → exit code 1 when the stamp is stale (writes nothing)
//
// Why: a new deploy must change sw.js's bytes, or browsers never install the new worker and keep serving the old
// cached files. Hashing the content (instead of bumping a number by hand) makes the stamp change exactly when a
// file changed. sw.js is hashed too, so a deploy that changes only the worker still gets a new cache name and never
// writes into the cache the running worker serves from. Line endings are normalised (a Windows checkout with CRLF
// hashes the same as the LF files the server sends), and sw.js and app.js are hashed with their own stamp blanked
// out. tests/version.test.js fails while it is stale.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.webmanifest', '.json', '.svg', '.txt']);
const SW_VERSION_RE = /^const VERSION = '([^']*)';/m;
const APP_VERSION_RE = /^export const APP_VERSION = '([^']*)';/m;
const HASH_LEN = 8;

/** Paths in sw.js's PRECACHE array (in order), without directory URLs such as './'. */
export function precacheList(swSource) {
  const m = /const PRECACHE = \[([\s\S]*?)\];/.exec(swSource);
  if (!m) throw new Error('sw.js: PRECACHE array not found');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((p) => !p.endsWith('/') && p !== 'sw.js');
}

/** Bytes that go into the hash: text with LF line endings and no BOM; sw.js and js/app.js with their stamp blanked. */
export function hashInput(relPath, buf) {
  if (!TEXT_EXT.has(path.extname(relPath).toLowerCase())) return buf;
  let text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (relPath === 'js/app.js') text = text.replace(APP_VERSION_RE, "export const APP_VERSION = '';");
  else if (relPath === 'sw.js') text = text.replace(SW_VERSION_RE, "const VERSION = '';");
  return Buffer.from(text, 'utf8');
}

export function readStamps(root = ROOT) {
  const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');
  const app = readFileSync(path.join(root, 'js/app.js'), 'utf8');
  return { sw: SW_VERSION_RE.exec(sw)?.[1] ?? null, app: APP_VERSION_RE.exec(app)?.[1] ?? null };
}

/** → { version, hash, files } for the files currently on disk (the precached files, then sw.js). */
export function computeStamp(root = ROOT) {
  const files = [...precacheList(readFileSync(path.join(root, 'sw.js'), 'utf8')), 'sw.js'];
  const h = createHash('sha256');
  for (const rel of files) {
    const data = hashInput(rel, readFileSync(path.join(root, rel)));
    h.update(`${rel}\n${data.length}\n`);
    h.update(data);
  }
  const hash = h.digest('hex').slice(0, HASH_LEN);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  return { version: `${pkg.version || '0.0.0'}+${hash}`, hash, files };
}

function rewrite(file, re, line) {
  const src = readFileSync(file, 'utf8');
  if (!re.test(src)) throw new Error(`${path.basename(file)}: version line not found`);
  const out = src.replace(re, line);
  if (out !== src) writeFileSync(file, out);
  return out !== src;
}

/** Writes the current stamp into sw.js and js/app.js. → { version, changed } */
export function stamp(root = ROOT) {
  const { version } = computeStamp(root);
  const a = rewrite(path.join(root, 'sw.js'), SW_VERSION_RE, `const VERSION = '${version}';`);
  const b = rewrite(path.join(root, 'js/app.js'), APP_VERSION_RE, `export const APP_VERSION = '${version}';`);
  return { version, changed: a || b };
}

function main(argv) {
  if (argv.includes('--check')) {
    const { version } = computeStamp();
    const cur = readStamps();
    if (cur.sw === version && cur.app === version) {
      console.log(`stamp ok: ${version}`);
      return 0;
    }
    console.error(`stamp is stale: sw.js=${cur.sw} app.js=${cur.app}, expected ${version}. Run: npm run stamp`);
    return 1;
  }
  const { version, changed } = stamp();
  console.log(changed ? `stamped ${version} → sw.js, js/app.js` : `stamp already current: ${version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
