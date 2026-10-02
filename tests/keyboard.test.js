import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whiteKeyCount, fitRange, layoutKeys } from '../js/core/keyboard.js';
import { isBlackKey } from '../js/core/notes.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('whiteKeyCount', () => {
  assert.equal(whiteKeyCount(60, 71), 7);
  assert.equal(whiteKeyCount(60, 72), 8);
  assert.equal(whiteKeyCount(48, 84), 22);
  assert.equal(whiteKeyCount(21, 108), 52);
  assert.equal(whiteKeyCount(61, 61), 0);
  assert.equal(whiteKeyCount(72, 60), 0);
});

test('fitRange: empty → C3..C6', () => {
  assert.deepEqual(fitRange([]), { lo: 48, hi: 84 });
  assert.deepEqual(fitRange(null), { lo: 48, hi: 84 });
});

test('fitRange: white bounds, padding, min white keys, alternating expansion', () => {
  const notes = [{ m: 60 }, { m: 64 }, { m: 72 }];
  const { lo, hi } = fitRange(notes);
  assert.equal(isBlackKey(lo), false);
  assert.equal(isBlackKey(hi), false);
  assert.ok(lo <= 59 && hi >= 73);
  assert.ok(whiteKeyCount(lo, hi) >= 15);
  assert.equal(whiteKeyCount(lo, hi), 15);
  // B3..D5 (10 white keys) grows down, up, down, up, down → F3..F5
  assert.deepEqual({ lo, hi }, { lo: 53, hi: 77 });
});

test('fitRange: black extremes are widened to white keys', () => {
  const { lo, hi } = fitRange([{ m: 62 }, { m: 69 }], { minWhiteKeys: 1, pad: 1 });
  // 62-1 = 61 (C#) → C4; 69+1 = 70 (A#) → B4
  assert.deepEqual({ lo, hi }, { lo: 60, hi: 71 });
});

test('fitRange: wide ranges and clamping to the piano', () => {
  const { lo, hi } = fitRange([{ m: 21 }, { m: 108 }]);
  assert.deepEqual({ lo, hi }, { lo: 21, hi: 108 });
  const r = fitRange([{ m: 22 }], { minWhiteKeys: 15 });
  assert.equal(r.lo, 21);
  assert.equal(whiteKeyCount(r.lo, r.hi), 15);
  const all = fitRange([{ m: 60 }], { minWhiteKeys: 100 });
  assert.deepEqual(all, { lo: 21, hi: 108 });
  const wide = fitRange([{ m: 36 }, { m: 96 }]);
  assert.ok(wide.lo <= 35 && wide.hi >= 97);
});

test('layoutKeys: white keys tile the width exactly', () => {
  const width = 1000;
  const { keys, whiteW, byMidi } = layoutKeys(48, 84, width);
  const whites = keys.filter((k) => !k.black);
  assert.equal(whites.length, 22);
  close(whiteW, width / 22);
  close(whites[0].x, 0);
  for (let i = 1; i < whites.length; i++) close(whites[i].x, whites[i - 1].x + whites[i - 1].w, 1e-9);
  const last = whites[whites.length - 1];
  close(last.x + last.w, width, 1e-9);
  assert.equal(keys.length, 37);
  assert.equal(byMidi.size, 37);
  assert.equal(byMidi.get(60).black, false);
  assert.deepEqual(keys.map((k) => k.m), Array.from({ length: 37 }, (_, i) => 48 + i));
});

test('layoutKeys: black keys straddle the boundary between their neighbours', () => {
  const { keys, whiteW, byMidi } = layoutKeys(60, 72, 800);
  const blacks = keys.filter((k) => k.black);
  assert.equal(blacks.length, 5);
  for (const b of blacks) {
    const left = byMidi.get(b.m - 1);
    const right = byMidi.get(b.m + 1);
    assert.equal(left.black, false);
    assert.equal(right.black, false);
    close(b.w, whiteW * 0.58);
    const boundary = right.x;
    const center = b.x + b.w / 2;
    assert.ok(b.x > left.x && b.x + b.w < right.x + right.w);
    assert.ok(Math.abs(center - boundary) <= 0.08 * whiteW + 1e-9);
  }
  const center = (m) => byMidi.get(m).x + byMidi.get(m).w / 2;
  close(center(61), byMidi.get(62).x - 0.08 * whiteW); // C# left
  close(center(63), byMidi.get(64).x + 0.08 * whiteW); // D# right
  close(center(66), byMidi.get(67).x - 0.08 * whiteW); // F# left
  close(center(68), byMidi.get(69).x); // G# centred
  close(center(70), byMidi.get(71).x + 0.08 * whiteW); // A# right
});

test('layoutKeys: black bounds widened, invalid input safe', () => {
  const r = layoutKeys(61, 70, 100);
  assert.equal(r.keys[0].m, 60);
  assert.equal(r.keys[r.keys.length - 1].m, 71);
  const z = layoutKeys(60, 72, 0);
  assert.equal(z.whiteW, 0);
  assert.equal(z.keys.length, 13);
  const bad = layoutKeys(NaN, 72, 100);
  assert.equal(bad.keys.length, 0);
});
