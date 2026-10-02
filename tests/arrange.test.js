import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGE_FLOOR, GROUP_EPS, groupOnsets, tagHand, splitHands, mergeTracks, simplifyHand, simplifyAccompaniment,
  accompanimentStats,
} from '../js/core/arrange.js';
import { GROUP_EPS as JUDGE_GROUP_EPS } from '../js/game/judge.js';

// Original material only: plain C / F / G chords.
const n = (t, m, d = 0.5, extra = {}) => ({ t, d, m, ...extra });
const pitches = (list) => list.map((x) => x.m);

test('constants', () => {
  assert.equal(JUDGE_FLOOR, 41);
  assert.equal(GROUP_EPS, 0.03);
  assert.equal(GROUP_EPS, JUDGE_GROUP_EPS);
});

test('groupOnsets groups onsets within eps of the first onset; skips invalid entries', () => {
  const notes = [n(0, 60), n(0.02, 64), n(0.03, 67), n(0.031, 72), n(1, 48), null, { t: NaN, m: 1 }, n(0.5, 50)];
  assert.deepEqual(groupOnsets(notes), [
    { t: 0, idx: [0, 1, 2] },
    { t: 0.031, idx: [3] },
    { t: 0.5, idx: [7] },
    { t: 1, idx: [4] },
  ]);
  assert.deepEqual(groupOnsets(notes, 0.5).map((g) => g.idx), [[0, 1, 2, 3, 7], [4]]);
  assert.deepEqual(groupOnsets([]), []);
  assert.deepEqual(groupOnsets(null), []);
});

test('tagHand / splitHands return sorted copies with hand tags', () => {
  const src = [n(1, 48), n(0, 72, 0.5, { v: 0.8 }), n(0, 60), n(0, 59, 0.5, { h: 'R' })];
  const right = tagHand(src, 'R');
  assert.deepEqual(right.map((x) => [x.t, x.m, x.h]), [[0, 59, 'R'], [0, 60, 'R'], [0, 72, 'R'], [1, 48, 'R']]);
  assert.equal(right[2].v, 0.8);
  assert.equal('h' in src[0], false, 'input untouched');
  assert.notEqual(right[0], src[3]);
  assert.equal(tagHand(src, 'L').every((x) => x.h === 'L'), true);
  assert.equal(tagHand(src, 'x').some((x) => 'h' in x), false);

  const split = splitHands(src);
  assert.deepEqual(split.map((x) => [x.m, x.h]), [[59, 'R'], [60, 'R'], [72, 'R'], [48, 'L']]);
  assert.deepEqual(splitHands(src, 65).map((x) => [x.m, x.h]), [[59, 'R'], [60, 'L'], [72, 'R'], [48, 'L']]);
  assert.deepEqual(splitHands(null), []);
});

test('mergeTracks: sorted copies; same onset (±1 ms) and pitch → one note (longer, right hand wins)', () => {
  const rh = [n(0, 60, 0.5, { h: 'R' }), n(1, 67, 0.5, { h: 'R' })];
  const lh = [n(0.001, 60, 1, { h: 'L' }), n(0, 48, 1, { h: 'L' }), n(1.01, 67, 0.25, { h: 'L' })];
  const merged = mergeTracks(rh, lh, null);
  assert.deepEqual(merged, [
    { t: 0, d: 1, m: 48, h: 'L' },
    { t: 0, d: 1.001, m: 60, h: 'R' },
    { t: 1, d: 0.5, m: 67, h: 'R' },
    { t: 1.01, d: 0.25, m: 67, h: 'L' },
  ]);
  assert.equal(rh[0].d, 0.5, 'inputs untouched');
  assert.deepEqual(mergeTracks([n(0, 60, 0.5, { h: 'L' })], [n(0, 60, 0.2, { h: 'R' })]), [{ t: 0, d: 0.5, m: 60, h: 'R' }]);
  assert.deepEqual(mergeTracks([n(0, 60)], [n(0, 60, 0.5, { h: 'L' })]), [{ t: 0, d: 0.5, m: 60, h: 'L' }]);
  assert.deepEqual(mergeTracks(), []);
});

test('simplifyHand keeps the top (or bottom) distinct pitches of every onset group', () => {
  const chords = [
    n(0, 60), n(0, 64), n(0, 67), n(0.01, 72), // C chord with a slightly late top note
    n(1, 65), n(1, 69), n(1, 72),
    n(2, 67),
  ];
  assert.deepEqual(pitches(simplifyHand(chords, { keep: 'top', max: 2 })), [67, 72, 69, 72, 67]);
  assert.deepEqual(pitches(simplifyHand(chords, { keep: 'top', max: 1 })), [72, 72, 67]);
  assert.deepEqual(pitches(simplifyHand(chords, { keep: 'bottom', max: 1 })), [60, 65, 67]);
  assert.deepEqual(pitches(simplifyHand(chords)), [64, 67, 72, 65, 69, 72, 67]); // default: top 3
  assert.equal(simplifyHand(chords, { max: Infinity }).length, 8);
  assert.equal(simplifyHand(chords, { max: 0 }).length, 3, 'at least one note per group');
  // duplicate pitches in one group count once
  assert.deepEqual(simplifyHand([n(0, 48, 1), n(0.01, 48, 2), n(0, 36)], { keep: 'bottom', max: 2 })
    .map((x) => [x.m, x.d]), [[36, 0.5], [48, 2]]);
});

test('simplifyAccompaniment simplifies each hand; untagged notes are split at middle C first', () => {
  const notes = [
    n(0, 64, 1, { h: 'R' }), n(0, 67, 1, { h: 'R' }), n(0, 72, 1, { h: 'R' }),
    n(0, 36, 1, { h: 'L' }), n(0, 48, 1, { h: 'L' }), n(0, 55, 1, { h: 'L' }),
    n(1, 62), n(1, 65), n(1, 43), n(1, 50),
  ];
  const all = simplifyAccompaniment(notes);
  assert.equal(all.length, 10);
  assert.equal(all.every((x) => x.h === 'R' || x.h === 'L'), true);
  const simple = simplifyAccompaniment(notes, { right: 1, left: 1 });
  assert.deepEqual(simple.map((x) => [x.t, x.m, x.h]), [[0, 36, 'L'], [0, 72, 'R'], [1, 43, 'L'], [1, 65, 'R']]);
  const two = simplifyAccompaniment(notes, { right: 2, left: 2 });
  assert.deepEqual(two.map((x) => x.m), [36, 48, 67, 72, 43, 50, 62, 65]);
  assert.equal('h' in notes[6], false, 'input untouched');
});

test('accompanimentStats counts hands, onset groups, the biggest chord and notes below the judge floor', () => {
  const notes = [
    n(0, 64, 1, { h: 'R' }), n(0, 67, 1, { h: 'R' }), n(0, 36, 1, { h: 'L' }),
    n(1, 38, 1, { h: 'L' }), n(1, 40, 1, { h: 'L' }),
    n(2, 70), n(2, 50), n(2, 41),
  ];
  assert.deepEqual(accompanimentStats(notes), {
    right: 3, left: 5, groups: 3, maxChord: 3, belowFloor: 3, judgeGroups: 2,
  });
  assert.deepEqual(accompanimentStats([]), { right: 0, left: 0, groups: 0, maxChord: 0, belowFloor: 0, judgeGroups: 0 });
  assert.equal(accompanimentStats(null).groups, 0);
});
