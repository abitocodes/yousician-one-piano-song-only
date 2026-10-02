// Piano keyboard geometry: visible range selection and key layout.

import { isBlackKey } from './notes.js';

const PIANO_LO = 21; // A0
const PIANO_HI = 108; // C8
const BLACK_W = 0.58;
// Horizontal shift of black keys (in white-key widths) by pitch class, like a real keyboard.
const BLACK_SHIFT = { 1: -0.08, 3: 0.08, 6: -0.08, 8: 0, 10: 0.08 };

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function prevWhite(m) {
  do m -= 1; while (isBlackKey(m));
  return m;
}

function nextWhite(m) {
  do m += 1; while (isBlackKey(m));
  return m;
}

export function whiteKeyCount(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  const a = Math.round(lo);
  const b = Math.round(hi);
  let n = 0;
  for (let m = a; m <= b; m++) if (!isBlackKey(m)) n++;
  return n;
}

export function fitRange(notes, { minWhiteKeys = 15, pad = 1 } = {}) {
  let min = Infinity;
  let max = -Infinity;
  if (Array.isArray(notes)) {
    for (const n of notes) {
      const m = n && Number(n.m);
      if (!Number.isFinite(m)) continue;
      if (m < min) min = m;
      if (m > max) max = m;
    }
  }
  if (min === Infinity) return { lo: 48, hi: 84 };

  const p = Number.isFinite(pad) && pad >= 0 ? Math.round(pad) : 1;
  let lo = clamp(Math.round(min), PIANO_LO, PIANO_HI) - p;
  let hi = clamp(Math.round(max), PIANO_LO, PIANO_HI) + p;
  if (isBlackKey(lo)) lo -= 1;
  if (isBlackKey(hi)) hi += 1;
  lo = clamp(lo, PIANO_LO, PIANO_HI);
  hi = clamp(hi, PIANO_LO, PIANO_HI);

  const target = Number.isFinite(minWhiteKeys) ? minWhiteKeys : 15;
  let down = true;
  while (whiteKeyCount(lo, hi) < target) {
    const canDown = lo > PIANO_LO;
    const canUp = hi < PIANO_HI;
    if (!canDown && !canUp) break;
    if ((down && canDown) || !canUp) lo = prevWhite(lo);
    else hi = nextWhite(hi);
    down = !down;
  }
  return { lo, hi };
}

// White keys tile [0, width]; black keys straddle the boundary to their right-hand white neighbour.
// A black `lo`/`hi` is widened to the adjacent white key so every black key has both neighbours.
export function layoutKeys(lo, hi, width) {
  const keys = [];
  const byMidi = new Map();
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { keys, whiteW: 0, byMidi, lo, hi, whiteCount: 0 };
  }
  let a = Math.round(Math.min(lo, hi));
  let b = Math.round(Math.max(lo, hi));
  if (isBlackKey(a)) a -= 1;
  if (isBlackKey(b)) b += 1;
  const total = Number.isFinite(width) && width > 0 ? width : 0;
  const whiteCount = whiteKeyCount(a, b);
  const whiteW = whiteCount ? total / whiteCount : 0;
  const blackW = whiteW * BLACK_W;

  let wi = 0;
  for (let m = a; m <= b; m++) {
    let key;
    if (isBlackKey(m)) {
      const boundary = wi * whiteW;
      const shift = BLACK_SHIFT[((m % 12) + 12) % 12] || 0;
      key = { m, black: true, x: boundary - blackW / 2 + shift * whiteW, w: blackW };
    } else {
      key = { m, black: false, x: wi * whiteW, w: whiteW };
      wi++;
    }
    keys.push(key);
    byMidi.set(m, key);
  }
  return { keys, whiteW, byMidi, lo: a, hi: b, whiteCount };
}
