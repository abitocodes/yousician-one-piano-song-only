import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS, SETTINGS_KEY, SCORES_KEY, Settings, Library, ScoreBook, memoryStorage, validateSetting,
} from '../js/core/storage.js';
import { BUILTIN_SONGS } from '../js/data/demo-songs.js';

test('DEFAULT_SETTINGS matches the spec exactly', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, {
    inputMode: 'mic',
    latency: 0.10,
    sensitivity: 0.6,
    octaveTolerant: true,
    a4: 440,
    difficulty: 'normal',
    speed: 1,
    lookahead: 2.5,
    labelStyle: 'solfege',
    showLyrics: true,
    guideMelody: false,
    metronome: false,
    masterVolume: 0.8,
    backingVolume: 0.8,
    keepAwake: true,
    showDetected: true,
  });
});

test('validateSetting clamps, snaps and rejects', () => {
  assert.deepEqual(validateSetting('speed', 2), { ok: true, value: 1.25 });
  assert.deepEqual(validateSetting('speed', 0.93), { ok: true, value: 0.95 });
  assert.deepEqual(validateSetting('speed', '0.9'), { ok: true, value: 0.9 });
  assert.deepEqual(validateSetting('latency', -1), { ok: true, value: -0.1 });
  assert.deepEqual(validateSetting('latency', 0.1234), { ok: true, value: 0.123 });
  assert.deepEqual(validateSetting('a4', 400), { ok: true, value: 415 });
  assert.deepEqual(validateSetting('lookahead', 9), { ok: true, value: 5 });
  assert.equal(validateSetting('sensitivity', NaN).ok, false);
  assert.equal(validateSetting('sensitivity', '').ok, false);
  assert.equal(validateSetting('difficulty', 'insane').ok, false);
  assert.deepEqual(validateSetting('showLyrics', 'false'), { ok: true, value: false });
  assert.equal(validateSetting('showLyrics', 'maybe').ok, false);
  assert.equal(validateSetting('unknownKey', 1).ok, false);
});

test('Settings persists, emits change and ignores invalid values', () => {
  const storage = memoryStorage();
  const s = new Settings({}, { storage });
  assert.deepEqual(s.all(), { ...DEFAULT_SETTINGS });
  const events = [];
  s.on('change', (k, v) => events.push([k, v]));
  assert.equal(s.set('speed', 0.8), true);
  assert.equal(s.set('difficulty', 'bogus'), false);
  assert.equal(s.set('sensitivity', 5), true);
  s.set('speed', 0.8); // unchanged → no event
  assert.deepEqual(events, [['speed', 0.8], ['sensitivity', 1]]);
  assert.equal(s.get('difficulty'), 'normal');

  const again = new Settings({}, { storage });
  assert.equal(again.get('speed'), 0.8);
  assert.equal(again.get('sensitivity'), 1);
  assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).speed, 0.8);
});

test('Settings falls back to defaults on corrupt storage and drops bad stored values', () => {
  const corrupt = memoryStorage({ [SETTINGS_KEY]: '{not json' });
  assert.deepEqual(new Settings({}, { storage: corrupt }).all(), { ...DEFAULT_SETTINGS });
  const partial = memoryStorage({ [SETTINGS_KEY]: JSON.stringify({ speed: 'fast', a4: 442, extra: 1 }) });
  const s = new Settings({}, { storage: partial });
  assert.equal(s.get('speed'), 1);
  assert.equal(s.get('a4'), 442);
  assert.equal(s.get('extra'), undefined);
});

test('session overrides are returned but never persisted; set() replaces them', () => {
  const storage = memoryStorage();
  const s = new Settings({ inputMode: 'sim', bogus: 1 }, { storage });
  assert.equal(s.get('inputMode'), 'sim');
  assert.equal(s.all().inputMode, 'sim');
  assert.equal(s.isOverridden('inputMode'), true);
  s.set('speed', 0.75);
  assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).inputMode, 'mic');
  assert.equal(new Settings({}, { storage }).get('inputMode'), 'mic');
  s.set('inputMode', 'touch');
  assert.equal(s.isOverridden('inputMode'), false);
  assert.equal(s.get('inputMode'), 'touch');
  assert.equal(new Settings({}, { storage }).get('inputMode'), 'touch');
  assert.equal(new Settings({ inputMode: 'nope' }, { storage }).get('inputMode'), 'touch');
});

test('Settings.update and reset', () => {
  const s = new Settings({}, { storage: memoryStorage() });
  assert.equal(s.update({ speed: 0.5, metronome: true, nope: 3 }), 2);
  const events = [];
  s.on('change', (k) => events.push(k));
  s.reset();
  assert.deepEqual(events.sort(), ['metronome', 'speed']);
  assert.deepEqual(s.all(), { ...DEFAULT_SETTINGS });
});

const userSong = (id, title, notes = [{ t: 0, d: 0.5, m: 60 }]) => ({
  format: 'piano-karaoke-song',
  version: 1,
  id,
  title,
  artist: 'tester',
  bpm: 100,
  beatsPerBar: 4,
  offset: 0,
  notes,
  lyrics: { text: '', source: 'notes', lines: [] },
  audio: null,
});

test('Library without IndexedDB uses memory and lists builtins first', async () => {
  const lib = new Library({ indexedDB: null });
  await lib.init();
  assert.equal(lib.persistent, false);
  const list = await lib.list();
  assert.deepEqual(list.map((s) => s.id), BUILTIN_SONGS.map((s) => s.id));
  assert.equal(lib.isBuiltin('builtin:walk'), true);
  assert.equal(lib.isBuiltin('song-x'), false);
  assert.equal(await lib.get('nope'), null);
  const walk = await lib.get('builtin:walk');
  walk.notes.length = 0;
  assert.equal((await lib.get('builtin:walk')).notes.length, 50, 'get returns a copy');
});

test('Library save / override / order / remove', async () => {
  const lib = new Library({ indexedDB: null });
  const changes = [];
  lib.on('change', (e) => changes.push(e));
  const a = await lib.save(userSong('song-a', 'A'));
  assert.equal(a.builtin, false);
  assert.equal(a.template, false);
  assert.ok(a.updatedAt > 0 && a.createdAt > 0);
  await lib.save(userSong('song-b', 'B'));
  const override = await lib.save({ ...userSong('builtin:gamsa', '감사', [{ t: 1, d: 1, m: 62 }]), template: true, builtin: true });
  assert.equal(override.template, false);
  assert.equal(override.builtin, false);
  assert.equal(lib.hasOverride('builtin:gamsa'), true);

  const ids = (await lib.list()).map((s) => s.id);
  assert.deepEqual(ids, ['builtin:gamsa', 'builtin:walk', 'builtin:twinkle', 'song-b', 'song-a']);
  assert.equal((await lib.get('builtin:gamsa')).notes.length, 1);

  await lib.save(userSong('song-a', 'A2'));
  assert.deepEqual((await lib.list()).slice(3).map((s) => s.id), ['song-a', 'song-b']);
  assert.equal((await lib.get('song-a')).title, 'A2');
  assert.equal((await lib.userSongs()).length, 3);

  await lib.saveAudio('song-a', new Blob(['abc'], { type: 'audio/mpeg' }));
  const blob = await lib.getAudio('song-a');
  assert.equal(await blob.text(), 'abc');
  await lib.remove('song-a');
  assert.equal(await lib.get('song-a'), null);
  assert.equal(await lib.getAudio('song-a'), null);

  await lib.remove('builtin:gamsa');
  const g = await lib.get('builtin:gamsa');
  assert.equal(g.template, true);
  assert.equal(g.notes.length, 0);
  assert.ok(changes.length >= 5);
  assert.deepEqual(changes[0], { type: 'save', id: 'song-a' });
});

test('Library.save rejects non-songs and saveAudio rejects non-blobs', async () => {
  const lib = new Library({ indexedDB: null });
  await assert.rejects(() => lib.save({ title: 'x' }));
  await assert.rejects(() => lib.saveAudio('a', 'not a blob'));
});

test('ScoreBook records bests only in play mode', () => {
  const storage = memoryStorage();
  const book = new ScoreBook({ storage });
  assert.deepEqual(book.get('s'), { best: null, plays: 0 });
  const stats = (score, rank = 'B') => ({ score, accuracy: score / 1e6, rank, total: 10 });

  let r = book.record('s', stats(500000), 'practice');
  assert.deepEqual(r, { isBest: false, previousBest: null });
  assert.equal(book.get('s').best, null);

  r = book.record('s', stats(600000), 'play');
  assert.equal(r.isBest, true);
  assert.equal(r.previousBest, null);
  assert.equal(book.get('s').best.score, 600000);

  r = book.record('s', stats(550000), 'play');
  assert.equal(r.isBest, false);
  assert.equal(r.previousBest.score, 600000);

  r = book.record('s', stats(900000, 'A'), 'play');
  assert.equal(r.isBest, true);
  assert.equal(r.previousBest.score, 600000);
  assert.equal(book.get('s').plays, 4);

  const reloaded = new ScoreBook({ storage });
  assert.equal(reloaded.get('s').best.score, 900000);
  assert.equal(reloaded.get('s').best.rank, 'A');
  assert.ok(reloaded.get('s').best.date > 0);

  reloaded.clear();
  assert.deepEqual(reloaded.get('s'), { best: null, plays: 0 });
  assert.equal(new ScoreBook({ storage: memoryStorage({ [SCORES_KEY]: '[]' }) }).get('s').plays, 0);
});
