// Smoke/geometry tests for HighwayRenderer with a recording mock 2D context (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HighwayRenderer } from '../js/game/renderer.js';

function mockContext(log) {
  const state = {};
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'measureText') return (s) => ({ width: String(s).length * 8 });
      return (...args) => {
        log.count[k] = (log.count[k] || 0) + 1;
        if (k === 'fillText') log.text.push(args[0]);
        if (k === 'drawImage' && !(args[0] && args[0].__layer)) throw new Error('drawImage needs a layer canvas');
        for (const a of args) {
          if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`non-finite argument to ${String(k)}`);
        }
      };
    },
    set(t, k, v) {
      if (k === 'globalAlpha' && !(v >= 0 && v <= 1)) throw new Error(`bad globalAlpha ${v}`);
      t[k] = v;
      return true;
    },
  });
}

function mockCanvas(w, h, log) {
  const ctx = mockContext(log);
  return {
    __layer: true,
    clientWidth: w,
    clientHeight: h,
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
  };
}

function setup(w = 1280, h = 560) {
  const log = { count: {}, text: [] };
  globalThis.window = { devicePixelRatio: 2 };
  globalThis.document = { createElement: () => mockCanvas(0, 0, { count: {}, text: [] }) };
  const canvas = mockCanvas(w, h, log);
  return { canvas, log };
}

const SONG = {
  bpm: 96,
  beatsPerBar: 4,
  offset: 0,
  notes: [
    { t: 1, d: 0.5, m: 60 },
    { t: 1.5, d: 0.5, m: 64 },
    { t: 2, d: 1.2, m: 67 },
    { t: 3.2, d: 0.4, m: 61 },
    { t: 3.6, d: 0.4, m: 72 },
  ],
};

function snap(extra = {}) {
  return {
    songTime: 0,
    state: 'playing',
    mode: 'play',
    speed: 1,
    countdown: null,
    notes: SONG.notes,
    states: SONG.notes.map(() => 'pending'),
    judgedAt: new Float64Array(SONG.notes.length).fill(NaN),
    expectedKeys: new Set(),
    pressedKeys: new Set(),
    detected: null,
    stats: null,
    progress: 0,
    holdingNotes: [],
    ...extra,
  };
}

test('resize sizes the backing store with DPR ≤ 2 and clamps the keyboard height', () => {
  const { canvas } = setup(1280, 560);
  globalThis.window.devicePixelRatio = 3;
  const r = new HighwayRenderer(canvas);
  r.setSong(SONG);
  assert.equal(canvas.width, 2560);
  assert.equal(canvas.height, 1120);
  assert.equal(r.keyboardTop, 560 - 112); // 20% of 560
  assert.equal(r.resize(), false, 'unchanged size is a no-op');

  canvas.clientHeight = 1200;
  assert.equal(r.resize(), true);
  assert.equal(r.keyboardTop, 1200 - 190, 'keyboard height is capped at 190');
  canvas.clientHeight = 300;
  r.resize();
  assert.equal(r.keyboardTop, 300 - 90, 'keyboard height is at least 90');
});

test('keyAt hits black keys first, white keys below them, and ignores the highway', () => {
  const { canvas } = setup(1280, 560);
  const r = new HighwayRenderer(canvas);
  r.setSong(SONG);
  const top = r.keyboardTop;
  const c4 = r.layout.byMidi.get(60);
  const cs4 = r.layout.byMidi.get(61);
  assert.ok(c4 && cs4);
  assert.equal(r.keyAt(cs4.x + cs4.w / 2, top + 10), 61);
  assert.equal(r.keyAt(cs4.x + cs4.w / 2, top + r.keyboardHeight - 5), cs4.x + cs4.w / 2 < c4.x + c4.w ? 60 : 62);
  assert.equal(r.keyAt(c4.x + 3, top + r.keyboardHeight - 5), 60);
  assert.equal(r.keyAt(c4.x + 3, top - 5), null, 'highway area is not a key');
  assert.equal(r.keyAt(-5, top + 20), null);
});

test('render draws pending notes with labels and survives every note state', () => {
  const { canvas, log } = setup();
  const r = new HighwayRenderer(canvas, { labelStyle: 'solfege' });
  r.setSong(SONG);
  r.render(snap({ songTime: 0.2, expectedKeys: new Set([60]), pressedKeys: new Set([64, 61]) }), 2.5);
  assert.ok(log.count.fill >= 3, 'visible notes were filled');
  assert.ok(log.text.includes('도'), 'solfege label drawn');

  const states = ['perfect', 'great', 'miss', 'good', 'pending'];
  const judgedAt = new Float64Array([1.02, 1.45, NaN, 3.2, NaN]);
  r.addJudgeEffect({ index: 0, note: SONG.notes[0], grade: 'perfect', delta: 0.02, deltaReal: 0.02 });
  r.addJudgeEffect({ index: 1, note: SONG.notes[1], grade: 'great', delta: -0.05, deltaReal: -0.05 });
  r.addJudgeEffect({ index: 2, note: SONG.notes[2], grade: 'miss', delta: 0, deltaReal: 0 });
  assert.equal(r.animating, true);
  r.render(snap({
    songTime: 2.1,
    states,
    judgedAt,
    detected: { time: 0, db: -20, gateOpen: true, pitch: { midi: 84.2, freq: 1046, clarity: 0.95 }, topNotes: [84], onset: false },
  }), 2.5);
  assert.ok(log.text.includes('PERFECT'));
  assert.ok(log.text.includes('GREAT'));
  assert.ok(log.text.includes('빠름'), 'early hint for a GREAT hit before the note');
  assert.ok(log.text.includes('MISS'));

  // listen mode: 'auto' states without judgedAt, holding state with pulse.
  r.render(snap({ songTime: 2.05, mode: 'listen', states: ['auto', 'auto', 'auto', 'pending', 'pending'], judgedAt: null }), 2.5);
  r.render(snap({ songTime: 3.2, state: 'holding', expectedKeys: new Set([61]), holdingNotes: [61] }), 2.5);
  r.render(snap({ songTime: -4, state: 'paused' }), 5);
  r.clearEffects();
  assert.equal(r.animating, false);
});

test('labelStyle none draws no note labels; en uses English names', () => {
  const a = setup();
  const r1 = new HighwayRenderer(a.canvas, { labelStyle: 'none' });
  r1.setSong(SONG);
  a.log.text.length = 0;
  r1.render(snap({ songTime: 0.5 }), 2.5);
  assert.equal(a.log.text.length, 0);

  const b = setup();
  const r2 = new HighwayRenderer(b.canvas, { labelStyle: 'en' });
  r2.setSong(SONG);
  r2.render(snap({ songTime: 0.5 }), 2.5);
  assert.ok(b.log.text.includes('C4'));
});

test('empty song and zero-size canvas do not throw', () => {
  const { canvas } = setup(0, 0);
  const r = new HighwayRenderer(canvas);
  r.setSong({ notes: [] });
  r.render(snap({ notes: [], states: [] }), 2.5);
  assert.equal(r.keyAt(10, 10), null);
  canvas.clientWidth = 800;
  canvas.clientHeight = 900;
  assert.equal(r.resize(), true);
  assert.equal(r.lo, 48);
  assert.equal(r.hi, 84);
  r.render(snap({ notes: [], states: [] }), 2.5);
});
