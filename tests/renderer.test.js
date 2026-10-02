// Smoke/geometry tests for HighwayRenderer with a recording mock 2D context (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { HighwayRenderer } from '../js/game/renderer.js';

function mockContext(log) {
  const state = {};
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ stops: [], addColorStop(o, c) { this.stops.push(c); } });
      }
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
      if ((k === 'fillStyle' || k === 'strokeStyle') && log.styles) log.styles.push(v);
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
  const log = { count: {}, text: [], styles: [] };
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

// ------------------------------------------------------------------ two-hand accompaniment + sung melody

// Original made-up material: a C chord over a C3 bass, a low G1, a black-key left-hand note and a short melody.
const ACC = {
  bpm: 96,
  beatsPerBar: 4,
  offset: 0,
  notes: [
    { t: 1, d: 0.5, m: 48, h: 'L' },
    { t: 1, d: 0.5, m: 60, h: 'R' },
    { t: 1, d: 0.5, m: 64 },
    { t: 1.5, d: 0.5, m: 31, h: 'L' },
    { t: 2, d: 0.5, m: 49, h: 'L' },
  ],
  vocal: [
    { t: 1, d: 0.5, m: 72 },
    { t: 1.5, d: 1, m: 79 },
  ],
  arrangement: 'accompaniment',
};

const accSnap = (extra = {}) => snap({
  notes: ACC.notes,
  vocal: ACC.vocal,
  states: ACC.notes.map(() => 'pending'),
  judgedAt: new Float64Array(ACC.notes.length).fill(NaN),
  ...extra,
});

const usesColor = (log, color) => log.styles.some((s) => s && Array.isArray(s.stops) && s.stops.includes(color));

test('the keyboard range covers the notes and the sung melody', () => {
  const { canvas } = setup();
  const r = new HighwayRenderer(canvas);
  r.setSong(ACC);
  assert.ok(r.lo <= 31, `lo ${r.lo}`);
  assert.ok(r.hi >= 79, `hi ${r.hi}`);
  assert.ok(r.layout.byMidi.has(79));
  r.setSong(SONG);
  assert.ok(r.hi < 79, 'a song without vocal fits its notes only');
});

test('left-hand notes and expected keys use the amber colours; right-hand and untagged ones stay cyan/violet', () => {
  const { canvas, log } = setup();
  const r = new HighwayRenderer(canvas);
  r.setSong(ACC);
  log.styles.length = 0;
  r.render(accSnap({ songTime: 0.5 }), 2.5);
  assert.ok(usesColor(log, '#fbbf24'), 'left-hand white-key gradient');
  assert.ok(usesColor(log, '#f97316'), 'left-hand black-key gradient');
  assert.ok(usesColor(log, '#22d3ee'), 'right-hand gradient');
  assert.ok(log.text.includes('도'), 'labels still drawn');

  // Melody songs never use the left-hand colours.
  log.styles.length = 0;
  r.setSong(SONG);
  r.render(snap({ songTime: 0.5, expectedKeys: new Set([60]) }), 2.5);
  assert.ok(!usesColor(log, '#fbbf24'));
  assert.ok(!log.styles.includes('#fbbf24'));

  // Expected keys: a left-hand key gets the amber / orange tint.
  r.setSong(ACC);
  log.styles.length = 0;
  r.render(accSnap({ songTime: 0.95, expectedKeys: new Set([48, 49, 60]), expectedLeft: new Set([48, 49]) }), 2.5);
  assert.ok(log.styles.includes('#fbbf24'), 'white key tint');
  assert.ok(log.styles.includes('#f97316'), 'black key tint');
  assert.ok(log.styles.includes('#22d3ee'), 'right-hand key tint');
});

test('the sung melody is drawn as outlines behind the notes, and can be hidden', () => {
  const a = setup();
  const r = new HighwayRenderer(a.canvas);
  r.setSong(ACC);
  a.log.styles.length = 0;
  r.render(accSnap({ songTime: 1.2 }), 2.5);
  assert.ok(a.log.styles.includes('rgba(255,255,255,0.7)'), 'the note being sung is brighter');
  assert.ok(a.log.styles.includes('rgba(255,255,255,0.35)'), 'upcoming melody outline');
  const vocalIdx = a.log.styles.indexOf('rgba(255,255,255,0.35)');
  const noteIdx = a.log.styles.findIndex((s) => s && Array.isArray(s.stops));
  assert.ok(vocalIdx >= 0 && noteIdx > vocalIdx, 'outlines are drawn before (behind) the notes');

  const b = setup();
  const hidden = new HighwayRenderer(b.canvas, { showVocal: false });
  hidden.setSong(ACC);
  b.log.styles.length = 0;
  hidden.render(accSnap({ songTime: 1.2 }), 2.5);
  assert.ok(!b.log.styles.includes('rgba(255,255,255,0.35)'));
  assert.ok(!b.log.styles.includes('rgba(255,255,255,0.7)'));
  hidden.setOptions({ showVocal: true });
  hidden.render(accSnap({ songTime: 1.2 }), 2.5);
  assert.ok(b.log.styles.includes('rgba(255,255,255,0.35)'));

  // A snapshot with its own (new) vocal array is laid out on the fly; vocal-only charts still draw it.
  const c = setup();
  const v = new HighwayRenderer(c.canvas);
  v.setSong({ notes: [], vocal: ACC.vocal });
  v.render(snap({ songTime: 1.2, notes: [], states: [], vocal: ACC.vocal.map((n) => ({ ...n })) }), 2.5);
  assert.ok(c.log.styles.includes('rgba(255,255,255,0.7)'));
});

test('auto notes (display-only) fade neutrally in a judged run and keep the listen look in listen mode', () => {
  const { canvas, log } = setup();
  const r = new HighwayRenderer(canvas);
  r.setSong(ACC);
  const states = ['pending', 'pending', 'pending', 'auto', 'pending'];
  const judgedAt = new Float64Array([NaN, NaN, NaN, 1.5, NaN]);
  log.styles.length = 0;
  r.render(accSnap({ songTime: 1.55, states, judgedAt }), 2.5);
  assert.ok(!log.styles.includes('#ffd84d'), 'no PERFECT-coloured flash for a note nobody judged');
  assert.ok(log.styles.includes('#ffffff'), 'neutral flash');
  log.styles.length = 0;
  r.render(accSnap({ songTime: 1.55, mode: 'listen', states, judgedAt }), 2.5);
  assert.ok(log.styles.includes('#ffd84d'), 'listen mode keeps its flash colour');
});

test('a chord result flashes every key of the chord with one popup', () => {
  const { canvas, log } = setup();
  const r = new HighwayRenderer(canvas);
  r.setSong(ACC);
  r.render(accSnap({ songTime: 0.9 }), 2.5);
  r.addJudgeEffect({ index: 1, indices: [0, 1, 2], note: ACC.notes[1], grade: 'great', delta: 0.08, deltaReal: 0.08 });
  assert.equal(r._bN, 3, 'a burst per chord key');
  assert.equal(r._popN, 1, 'one popup');
  log.text.length = 0;
  r.render(accSnap({ songTime: 1.05 }), 2.5);
  assert.equal(log.text.filter((x) => x === 'GREAT').length, 1);
  // Indices that do not belong to the renderer's notes are ignored.
  r.clearEffects();
  r.addJudgeEffect({ index: 0, indices: [0, 1, 2], note: { t: 1, d: 0.5, m: 60 }, grade: 'miss', delta: 0, deltaReal: 0 });
  assert.equal(r._bN, 1);
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
