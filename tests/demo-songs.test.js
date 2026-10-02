import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_SONGS, BUILTIN_IDS, buildBuiltinSongs } from '../js/data/demo-songs.js';
import { normalizeSong, songDuration } from '../js/core/song.js';

const byId = (id) => BUILTIN_SONGS.find((s) => s.id === id);
const lineText = (line) => line.syllables.map((s) => s.text).join('');

test('builtin songs are ordered gamsa, walk, twinkle', () => {
  assert.deepEqual(BUILTIN_SONGS.map((s) => s.id), ['builtin:gamsa', 'builtin:walk', 'builtin:twinkle']);
  assert.deepEqual([...BUILTIN_IDS], ['builtin:gamsa', 'builtin:walk', 'builtin:twinkle']);
});

test('builtin songs build with zero notation errors and zero lyric warnings', () => {
  const { songs, warnings, errors } = buildBuiltinSongs();
  assert.equal(songs.length, 3);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('note counts are 0 / 50 / 42', () => {
  assert.deepEqual(BUILTIN_SONGS.map((s) => s.notes.length), [0, 50, 42]);
});

test('common builtin fields', () => {
  for (const s of BUILTIN_SONGS) {
    assert.equal(s.format, 'piano-karaoke-song');
    assert.equal(s.version, 1);
    assert.equal(s.builtin, true);
    assert.equal(s.audio, null);
    assert.equal(s.lyrics.source, 'notes');
    assert.equal(s.createdAt, 0);
    assert.equal(s.updatedAt, 0);
    assert.equal(s.beatsPerBar, 4);
    assert.equal(s.offset, 0);
    assert.equal(typeof s.title, 'string');
    assert.equal(typeof s.artist, 'string');
    for (let i = 1; i < s.notes.length; i++) {
      const a = s.notes[i - 1];
      const b = s.notes[i];
      assert.ok(a.t < b.t || (a.t === b.t && a.m <= b.m), `${s.id} notes sorted at ${i}`);
    }
    for (const n of s.notes) {
      assert.ok(n.d > 0);
      assert.ok(Number.isInteger(n.m) && n.m >= 21 && n.m <= 108);
    }
  }
});

test('감사 is an empty template (no copyrighted content)', () => {
  const g = byId('builtin:gamsa');
  assert.equal(g.title, '감사');
  assert.equal(g.artist, '김동률');
  assert.equal(g.bpm, 80);
  assert.equal(g.template, true);
  assert.deepEqual(g.notes, []);
  assert.equal(g.lyrics.text, '');
  assert.deepEqual(g.lyrics.lines, []);
  assert.equal(
    g.description,
    '저작권 보호를 위해 악보와 가사는 포함되어 있지 않아요. 편집 화면에서 악보 파일 가져오기(MIDI·MusicXML)·악보 보고 입력·피아노로 녹음으로 멜로디를 만들고, 가사를 붙여넣으면 바로 연주할 수 있어요. 만든 곡은 이 기기에만 저장돼요.',
  );
});

test('건반 위의 산책: verse twice at 96 bpm with 8 lyric lines aligned to notes', () => {
  const w = byId('builtin:walk');
  assert.equal(w.title, '건반 위의 산책');
  assert.equal(w.artist, '피아노 노래방 (오리지널)');
  assert.equal(w.bpm, 96);
  assert.equal(w.template, false);
  const beat = 60 / 96;
  // first verse == second verse shifted by 32 beats
  for (let i = 0; i < 25; i++) {
    assert.equal(w.notes[i].m, w.notes[i + 25].m);
    assert.ok(Math.abs(w.notes[i + 25].t - w.notes[i].t - 32 * beat) < 1e-6);
  }
  assert.deepEqual(w.notes.slice(0, 4).map((n) => n.m), [60, 64, 67, 64]);
  assert.ok(Math.abs(w.notes[6].d - 2 * beat) < 1e-6, 'G4:2 lasts two beats');
  const last = w.notes[w.notes.length - 1];
  assert.equal(last.m, 60);
  assert.ok(Math.abs(last.t + last.d - 64 * beat) < 1e-6, 'song ends after 64 beats');
  assert.ok(Math.abs(songDuration(w) - 40) < 1e-6);

  const lines = w.lyrics.lines;
  assert.equal(lines.length, 8);
  assert.deepEqual(lines.map(lineText), [
    '손끝으로 톡톡 톡',
    '소리가 피어나',
    '천천히 한 걸음씩',
    '함께 걸어요',
    '높은 음 낮은 음도',
    '모두 내 친구야',
    '틀려도 괜찮아요',
    '다시 해봐요',
  ]);
  const syllables = lines.flatMap((l) => l.syllables);
  assert.equal(syllables.length, 50);
  syllables.forEach((s, i) => {
    assert.ok(Math.abs(s.t - w.notes[i].t) < 1e-6, `syllable ${i} starts on its note`);
    assert.ok(s.d > 0);
  });
});

test('작은 별: 42 notes at 100 bpm with 계이름 lyrics', () => {
  const t = byId('builtin:twinkle');
  assert.equal(t.title, '작은 별 (계이름 노래)');
  assert.equal(t.artist, '프랑스 민요');
  assert.equal(t.bpm, 100);
  const names = { 60: '도', 62: '레', 64: '미', 65: '파', 67: '솔', 69: '라' };
  const lines = t.lyrics.lines;
  assert.deepEqual(lines.map(lineText), [
    '도 도 솔 솔 라 라 솔',
    '파 파 미 미 레 레 도',
    '솔 솔 파 파 미 미 레',
    '솔 솔 파 파 미 미 레',
    '도 도 솔 솔 라 라 솔',
    '파 파 미 미 레 레 도',
  ]);
  const syllables = lines.flatMap((l) => l.syllables);
  assert.equal(syllables.length, 42);
  syllables.forEach((s, i) => {
    assert.equal(s.text.trim(), names[t.notes[i].m], `syllable ${i} names its note`);
    assert.ok(Math.abs(s.t - t.notes[i].t) < 1e-6);
  });
  assert.ok(Math.abs(songDuration(t) - 48 * 0.6) < 1e-6);
});

test('builtins survive normalizeSong unchanged in substance', () => {
  for (const s of BUILTIN_SONGS) {
    const n = normalizeSong(JSON.parse(JSON.stringify(s)));
    assert.equal(n.id, s.id);
    assert.equal(n.notes.length, s.notes.length);
    assert.equal(n.lyrics.lines.length, s.lyrics.lines.length);
    assert.equal(n.builtin, true);
    assert.equal(n.template, s.template);
  }
});

test('buildBuiltinSongs returns fresh copies', () => {
  const a = buildBuiltinSongs().songs;
  a[1].notes.length = 0;
  assert.equal(byId('builtin:walk').notes.length, 50);
  assert.ok(Object.isFrozen(BUILTIN_SONGS));
});
