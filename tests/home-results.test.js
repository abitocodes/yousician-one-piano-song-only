// Home card badge and results labels for two-hand accompaniment songs (pure helpers of the screens).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importScreen } from './helpers-screen-stubs.js';
import { normalizeSong } from '../js/core/song.js';

const home = await importScreen('../js/screens/home.js');
const results = await importScreen('../js/screens/results.js');

const accompaniment = normalizeSong({
  title: '연습곡',
  arrangement: 'accompaniment',
  notes: [{ t: 0, d: 1, m: 64, h: 'R' }, { t: 0, d: 1, m: 48, h: 'L' }],
  vocal: [{ t: 0, d: 0.5, m: 67 }],
});
const melody = normalizeSong({ title: '멜로디', notes: [{ t: 0, d: 1, m: 60 }] });

test('home: the 양손 badge is shown only for accompaniment songs', () => {
  assert.equal(home.isAccompanimentSong(accompaniment), true);
  assert.equal(home.isAccompanimentSong(melody), false);
  assert.equal(home.isAccompanimentSong({ arrangement: 'chords' }), false);
  assert.equal(home.isAccompanimentSong(null), false);
});

test('results: accompaniment counts are labelled per chord, other songs per note', () => {
  const a = results.judgeUnit(accompaniment);
  assert.equal(a.unit, '화음');
  assert.equal(a.subject, '화음이');
  assert.match(a.title, /화음 단위/);
  const m = results.judgeUnit(melody);
  assert.deepEqual(m, { unit: '노트', subject: '노트가', title: '판정' });
  assert.equal(results.judgeUnit(undefined).unit, '노트');
});
