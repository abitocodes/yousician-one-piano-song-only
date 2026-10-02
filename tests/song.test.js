import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SONG_FORMAT, SONG_VERSION, createSong, normalizeSong, songDuration, noteRange, isPlayable,
  transposeNotes, shiftNotes, quantizeNotes, serializeSong, cloneSong,
} from '../js/core/song.js';

const ERR = { message: '곡 파일 형식이 올바르지 않아요.' };

test('constants', () => {
  assert.equal(SONG_FORMAT, 'piano-karaoke-song');
  assert.equal(SONG_VERSION, 1);
});

test('createSong fills defaults, id and timestamps', () => {
  const before = Date.now();
  const s = createSong();
  assert.equal(s.format, SONG_FORMAT);
  assert.equal(s.version, 1);
  assert.match(s.id, /^song-[0-9a-z]+$/);
  assert.ok(s.id.length >= 'song-'.length + 8 + 4);
  assert.equal(s.title, '새 곡');
  assert.equal(s.artist, '');
  assert.equal(s.bpm, 100);
  assert.equal(s.beatsPerBar, 4);
  assert.equal(s.offset, 0);
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.lyrics, { text: '', source: 'notes', lines: [] });
  assert.equal(s.audio, null);
  assert.ok(s.createdAt >= before && s.updatedAt >= before);
  assert.notEqual(createSong().id, createSong().id);
});

test('createSong applies a partial', () => {
  const s = createSong({ title: '감사', artist: '김동률', bpm: 80, notes: [{ t: 1, d: 0.5, m: 60 }], id: 'builtin:x', title2: 1 });
  assert.equal(s.title, '감사');
  assert.equal(s.artist, '김동률');
  assert.equal(s.bpm, 80);
  assert.equal(s.id, 'builtin:x');
  assert.deepEqual(s.notes, [{ t: 1, d: 0.5, m: 60 }]);
  assert.equal('title2' in s, false);
  assert.equal(createSong({ title: undefined }).title, '새 곡');
});

test('normalizeSong rejects non-objects and missing notes', () => {
  for (const bad of [null, undefined, 42, 'x', [], { title: 'a' }, { notes: 'x' }, { notes: {} }]) {
    assert.throws(() => normalizeSong(bad), ERR);
  }
  assert.throws(() => normalizeSong({ format: 'other', notes: [] }), ERR);
});

test('normalizeSong drops/coerces notes, rounds to 1 ms and sorts', () => {
  const s = normalizeSong({
    notes: [
      { t: 2.00049, d: 0.5004, m: 64 },
      { t: 1, d: 0, m: 62 },
      { t: 1, d: -3, m: 60 },
      { t: '0.5', d: '0.25', m: '67' },
      { t: NaN, d: 1, m: 60 },
      { t: 1, d: 1, m: 128 },
      { t: 1, d: 1, m: -1 },
      { t: Infinity, d: 1, m: 60 },
      { t: 3, d: Infinity, m: 61.4, v: 1.7 },
      null,
      'C4',
      { t: 4, m: 60, v: 0.5 },
    ],
  });
  assert.deepEqual(s.notes, [
    { t: 0.5, d: 0.25, m: 67 },
    { t: 1, d: 0.1, m: 60 },
    { t: 1, d: 0.1, m: 62 },
    { t: 2, d: 0.5, m: 64 },
    { t: 3, d: 0.1, m: 61, v: 1 },
    { t: 4, d: 0.1, m: 60, v: 0.5 },
  ]);
});

test('normalizeSong fills/clamps fields and keeps only known ones', () => {
  const s = normalizeSong({
    format: SONG_FORMAT,
    id: '  song-abc  ',
    title: '   ',
    artist: 5,
    bpm: 1000,
    beatsPerBar: 3.6,
    offset: 'x',
    notes: [],
    lyrics: { text: 'a', source: 'weird', lines: 'bad' },
    audio: { name: 'track.mp3', offset: 0.25, volume: 3 },
    builtin: true,
    template: 'yes',
    evil: () => 1,
    __proto__x: 1,
    createdAt: 5,
  });
  assert.equal(s.id, 'song-abc');
  assert.equal(s.title, '제목 없음');
  assert.equal(s.artist, '5');
  assert.equal(s.bpm, 300);
  assert.equal(s.beatsPerBar, 4);
  assert.equal(s.offset, 0);
  assert.deepEqual(s.lyrics, { text: 'a', source: 'notes', lines: [] });
  assert.deepEqual(s.audio, { name: 'track.mp3', offset: 0.25, volume: 1 });
  assert.equal(s.builtin, true);
  assert.equal('template' in s, false);
  assert.equal('evil' in s, false);
  assert.equal('__proto__x' in s, false);
  assert.equal(s.createdAt, 5);
  assert.ok(s.updatedAt > 1e12);
  assert.equal(normalizeSong({ notes: [], bpm: 10 }).bpm, 30);
  assert.equal(normalizeSong({ notes: [], bpm: -5 }).bpm, 100);
  assert.equal(normalizeSong({ notes: [], beatsPerBar: 3 }).beatsPerBar, 3);
  assert.equal(normalizeSong({ notes: [], audio: 'x' }).audio, null);
  assert.deepEqual(normalizeSong({ notes: [], audio: {} }).audio, { name: '반주 음원', offset: 0, volume: 1 });
  assert.match(normalizeSong({ notes: [] }).id, /^song-/);
});

test('normalizeSong sanitizes lyric lines', () => {
  const s = normalizeSong({
    notes: [],
    lyrics: {
      text: '하나',
      source: 'lrc',
      lines: [
        { syllables: [{ text: '하', t: 1, d: 0.5 }, { text: 7, t: '2', d: -1 }, { text: null, t: NaN, d: 1 }, 'x'] },
        { syllables: [] },
        { nope: true },
        null,
        { syllables: [{ t: 3, d: 0.2 }] },
      ],
    },
  });
  assert.equal(s.lyrics.source, 'lrc');
  assert.deepEqual(s.lyrics.lines, [
    { syllables: [{ text: '하', t: 1, d: 0.5 }, { text: '7', t: 2, d: 0.05 }] },
    { syllables: [{ text: '', t: 3, d: 0.2 }] },
  ]);
  assert.deepEqual(normalizeSong({ notes: [], lyrics: '그냥 가사' }).lyrics, { text: '그냥 가사', source: 'notes', lines: [] });
});

test('normalizeSong computes missing lyric lines from text (source notes only)', () => {
  const notes = [{ t: 0, d: 0.5, m: 60 }, { t: 0.5, d: 0.5, m: 62 }];
  const s = normalizeSong({ notes, lyrics: { text: '도레', source: 'notes' } });
  assert.deepEqual(s.lyrics.lines, [{ syllables: [{ text: '도', t: 0, d: 0.5 }, { text: '레', t: 0.5, d: 0.5 }] }]);
  assert.deepEqual(normalizeSong({ notes, lyrics: { text: '도레', source: 'lrc' } }).lyrics.lines, []);
  assert.deepEqual(normalizeSong({ notes: [], lyrics: { text: '도레' } }).lyrics.lines, []);
  const kept = [{ syllables: [{ text: 'x', t: 9, d: 1 }] }];
  assert.deepEqual(normalizeSong({ notes, lyrics: { text: '도레', lines: kept } }).lyrics.lines, kept);
});

test('normalizeSong round-trips through serializeSong', () => {
  const s = createSong({ title: 'x', notes: [{ t: 0, d: 1, m: 60, v: 0.8 }] });
  assert.deepEqual(normalizeSong(JSON.parse(serializeSong(s))), s);
  assert.equal(serializeSong(s), JSON.stringify(s, null, 2));
});

test('songDuration / noteRange / isPlayable', () => {
  const s = createSong({ notes: [{ t: 1, d: 2, m: 60 }, { t: 2, d: 0.5, m: 72 }] });
  assert.equal(songDuration(s), 3);
  s.lyrics.lines = [{ syllables: [{ text: 'a', t: 3.5, d: 1 }] }];
  assert.equal(songDuration(s), 4.5);
  assert.equal(songDuration(createSong()), 0);
  assert.equal(songDuration(null), 0);
  assert.deepEqual(noteRange(s.notes), { min: 60, max: 72 });
  assert.equal(noteRange([]), null);
  assert.equal(isPlayable(s), true);
  assert.equal(isPlayable(createSong()), false);
  assert.equal(isPlayable(null), false);
});

test('transposeNotes clamps and returns new objects', () => {
  const src = [{ t: 0, d: 1, m: 60 }, { t: 1, d: 1, m: 105 }, { t: 2, d: 1, m: 22 }];
  const up = transposeNotes(src, 5);
  assert.deepEqual(up.map((n) => n.m), [65, 108, 27]);
  assert.deepEqual(transposeNotes(src, -12).map((n) => n.m), [48, 93, 21]);
  assert.equal(src[0].m, 60);
  assert.notEqual(up[0], src[0]);
});

test('shiftNotes drops notes ending before 0 and clamps starts', () => {
  const src = [{ t: 0.5, d: 0.2, m: 60 }, { t: 1, d: 1, m: 62 }, { t: 3, d: 0.5, m: 64 }];
  assert.deepEqual(shiftNotes(src, -1.2), [
    { t: 0, d: 0.8, m: 62 },
    { t: 1.8, d: 0.5, m: 64 },
  ]);
  assert.deepEqual(shiftNotes(src, 0.25).map((n) => n.t), [0.75, 1.25, 3.25]);
  // first note ends exactly at 0 → dropped
  assert.deepEqual(shiftNotes(src, -0.7), [
    { t: 0.3, d: 1, m: 62 },
    { t: 2.3, d: 0.5, m: 64 },
  ]);
  assert.deepEqual(shiftNotes([], 1), []);
  assert.equal(src[0].t, 0.5);
});

test('quantizeNotes snaps to the grid from offset', () => {
  // bpm 120 → beat 0.5 s; division 2 → 0.25 s grid; offset 0.1
  const src = [
    { t: 0.12, d: 0.2, m: 60 },
    { t: 0.62, d: 0.01, m: 62 },
    { t: 0.83, d: 0.6, m: 64, v: 0.5 },
    { t: 0.84, d: 0.3, m: 64 },
  ];
  const q = quantizeNotes(src, 120, 0.1, 2);
  assert.deepEqual(q, [
    { t: 0.1, d: 0.25, m: 60 },
    { t: 0.6, d: 0.25, m: 62 },
    { t: 0.85, d: 0.5, m: 64, v: 0.5 },
  ]);
  const q4 = quantizeNotes([{ t: 0.07, d: 0.4, m: 60 }], 60, 0, 4);
  assert.deepEqual(q4, [{ t: 0, d: 0.5, m: 60 }]);
});

test('cloneSong deep clones', () => {
  const s = createSong({ notes: [{ t: 0, d: 1, m: 60 }] });
  const c = cloneSong(s);
  assert.deepEqual(c, s);
  c.notes[0].m = 61;
  c.lyrics.text = 'x';
  assert.equal(s.notes[0].m, 60);
  assert.equal(s.lyrics.text, '');
});
