import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKaraokeTimeline, karaokeViewAt, createKaraokeView, syllableProgress, fitLineSize, Karaoke,
} from '../js/game/karaoke.js';

// Line with syllables of 0.5 s each starting at `t`.
function line(t, texts, d = 0.5) {
  return { syllables: texts.map((text, i) => ({ text, t: t + i * d, d })) };
}

test('timeline drops empty lines, sorts by start and computes gaps', () => {
  const tl = buildKaraokeTimeline([
    line(10, ['다', '시']),
    { syllables: [] },
    null,
    line(0, ['하 ', '나']),
    { syllables: [{ text: '  ', t: 4, d: 1 }] },
    line(2, ['둘']),
  ]);
  assert.equal(tl.lines.length, 3);
  assert.deepEqual(Array.from(tl.starts), [0, 2, 10]);
  assert.deepEqual(Array.from(tl.ends), [1, 2.5, 11]);
  assert.equal(tl.gapBefore[0], Infinity);
  assert.equal(tl.gapBefore[1], 1);
  assert.equal(tl.gapBefore[2], 7.5);
});

test('timeline sanitises bad syllable durations', () => {
  const tl = buildKaraokeTimeline([{ syllables: [{ text: '가', t: 1, d: -2 }, { text: '나', t: 1.2, d: NaN }] }]);
  assert.equal(tl.lines[0][0].d, 0.05);
  assert.equal(tl.lines[0][1].d, 0.05);
});

test('consecutive lines alternate between the two slots', () => {
  const tl = buildKaraokeTimeline([
    line(1, ['a', 'b', 'c', 'd']), // 1..3
    line(3.2, ['e', 'f', 'g', 'h']), // 3.2..5.2
    line(5.4, ['i', 'j']), // 5.4..6.4
  ]);
  const v = createKaraokeView();
  karaokeViewAt(tl, 1.5, 0.5, v);
  assert.equal(v.current, 0);
  assert.deepEqual(v.slots, [0, 1]);
  assert.deepEqual(v.dots, [0, 0]);

  // Between line 0 and 1 (short gap): line 0 stays current, line 1 stays visible.
  karaokeViewAt(tl, 3.1, 0.5, v);
  assert.equal(v.current, 0);
  assert.deepEqual(v.slots, [0, 1]);

  // Singing line 1: the top slot moves on to line 2.
  karaokeViewAt(tl, 4, 0.5, v);
  assert.equal(v.current, 1);
  assert.deepEqual(v.slots, [2, 1]);
  assert.equal(v.idle, null);

  // Last line, then the end.
  karaokeViewAt(tl, 6, 0.5, v);
  assert.deepEqual(v.slots, [2, -1]);
  karaokeViewAt(tl, 6.4 + 1.01, 0.5, v);
  assert.deepEqual(v.slots, [-1, -1]);
  assert.equal(v.idle, 'end');
});

test('intro: first line appears ahead of time with ready dots counting down per beat', () => {
  const tl = buildKaraokeTimeline([line(10, ['하', '나']), line(11.2, ['둘'])]);
  const beat = 0.5; // lead = max(3, 4 * 0.5) + 1.5 = 4.5 s
  const v = createKaraokeView();

  karaokeViewAt(tl, 0, beat, v);
  assert.deepEqual(v.slots, [-1, -1]);
  assert.equal(v.idle, 'intro');

  karaokeViewAt(tl, 6, beat, v);
  assert.deepEqual(v.slots, [0, 1], 'next line and the one after it are shown together');
  assert.deepEqual(v.dots, [4, 0]);
  assert.equal(v.idle, null);

  karaokeViewAt(tl, 8.6, beat, v); // 1.4 s left → 3 beats
  assert.equal(v.dots[0], 3);
  karaokeViewAt(tl, 9.4, beat, v); // 0.6 s left → 2
  assert.equal(v.dots[0], 2);
  karaokeViewAt(tl, 9.9, beat, v); // 0.1 s left → 1
  assert.equal(v.dots[0], 1);
  karaokeViewAt(tl, 10, beat, v);
  assert.equal(v.current, 0);
  assert.deepEqual(v.dots, [0, 0]);
});

test('long gap clears the screen, then the next line returns with dots in its own slot', () => {
  const tl = buildKaraokeTimeline([line(0, ['a', 'b', 'c', 'd']), line(12, ['e', 'f'])]); // 0..2, 12..13
  const beat = 0.75; // lead = 4.5 s
  const v = createKaraokeView();

  karaokeViewAt(tl, 2.5, beat, v); // finished line lingers for 1 s
  assert.equal(v.current, 0);
  assert.deepEqual(v.slots, [0, -1]);

  karaokeViewAt(tl, 4, beat, v);
  assert.deepEqual(v.slots, [-1, -1]);
  assert.equal(v.idle, 'gap');

  karaokeViewAt(tl, 8, beat, v); // 4 s left
  assert.deepEqual(v.slots, [-1, 1]);
  assert.deepEqual(v.dots, [0, 4]);

  karaokeViewAt(tl, 11.5, beat, v); // 0.5 s left → 1 dot
  assert.deepEqual(v.dots, [0, 1]);
});

test('lines after a short gap never get ready dots', () => {
  const tl = buildKaraokeTimeline([line(0, ['a', 'b']), line(2.5, ['c'])]); // gap 1.5 s
  const v = karaokeViewAt(tl, 1.5, 0.5);
  assert.deepEqual(v.slots, [0, 1]);
  assert.deepEqual(v.dots, [0, 0]);
});

test('empty timeline reports idle none', () => {
  const v = karaokeViewAt(buildKaraokeTimeline([]), 3, 0.5);
  assert.deepEqual(v.slots, [-1, -1]);
  assert.equal(v.idle, 'none');
});

test('syllable progress is clamped, quantised and stable', () => {
  assert.equal(syllableProgress(1, 0.5, 0.9), 0);
  assert.equal(syllableProgress(1, 0.5, 1), 0);
  assert.equal(syllableProgress(1, 0.5, 1.25), 0.5);
  assert.equal(syllableProgress(1, 0.5, 2), 1);
  assert.equal(syllableProgress(1, 0, 1.025), 0.5, 'zero duration falls back to 50 ms');
  const a = syllableProgress(0, 1, 0.33331);
  const b = syllableProgress(0, 1, 0.33349);
  assert.equal(a, b, 'tiny time changes do not change the quantised value');
});

test('fitLineSize: fits, shrinks, and wraps only below the minimum scale', () => {
  assert.deepEqual(fitLineSize(50, 500, 400), { size: 50, wrap: false });
  assert.deepEqual(fitLineSize(50, 0, 400), { size: 50, wrap: false }, 'unmeasured slot keeps the base size');
  const shrunk = fitLineSize(50, 500, 1000);
  assert.equal(shrunk.size, 24); // floor(50 * 0.5 * 0.98)
  assert.equal(shrunk.wrap, false);
  // 3x the slot: the 0.4 floor (20 px) is still 1.2x too wide, so the line wraps instead of being clipped.
  assert.deepEqual(fitLineSize(50, 500, 1500), { size: 20, wrap: true });
  // Exactly at the floor it still fits on one row.
  assert.deepEqual(fitLineSize(50, 500, 1250), { size: 20, wrap: false });
});

// ---------------------------------------------------------------- Karaoke with a minimal fake DOM

class FakeClassList {
  constructor(el) { this.el = el; }
  get set() { return this.el._classes; }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this._classes = new Set();
    this.classList = new FakeClassList(this);
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.hidden = false;
    this.textContent = '';
    this.clientWidth = 0;
    this.clientHeight = 0;
    const props = {};
    this.style = {
      setProperty: (k, v) => { props[k] = String(v); },
      getPropertyValue: (k) => props[k] ?? '',
    };
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }

  // Width of a one-row line: 10 px per character at 10 px font size, scaled linearly.
  get offsetWidth() {
    if (!this._classes.has('pk-kara-line')) return 0;
    const size = parseFloat(this.style.fontSize) || 0;
    return textOf(this).length * size;
  }

  append(...nodes) {
    for (const n of nodes) {
      if (n instanceof FakeEl) {
        n.remove();
        n.parent = this;
      }
      this.children.push(n);
    }
  }

  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
    this.parent = null;
  }

  replaceChildren(...nodes) {
    for (const c of this.children) if (c instanceof FakeEl) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }
}

function textOf(el) {
  if (!(el instanceof FakeEl)) return el && typeof el.text === 'string' ? el.text : '';
  if (el._classes.has('fill') || el._classes.has('pk-kara-dots')) return '';
  return el.children.length ? el.children.map(textOf).join('') : el.textContent;
}

function withFakeDom(fn) {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => ({ text }),
  };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  }
}

function makeKaraoke({ width = 800, height = 200, slotWidth = 700 } = {}) {
  const root = new FakeEl('div');
  root.clientWidth = width;
  root.clientHeight = height;
  const k = new Karaoke(root);
  for (const slot of k.slots) slot.el.clientWidth = slotWidth;
  k.refit();
  return k;
}

test('Karaoke wipe: --p sweeps the glyph; outline margins open only once started / when complete', () => {
  withFakeDom(() => {
    const k = makeKaraoke();
    k.setLines([line(10, ['하', '나'], 1)]); // syllables 10..11, 11..12
    k.update(9);
    const fills = k.slots[0].fills;
    assert.equal(fills.length, 2);
    const state = (f) => [f.style.getPropertyValue('--p'), f.classList.contains('is-on'), f.classList.contains('is-done')];
    assert.deepEqual(state(fills[0]), ['0', false, false], 'not started: nothing revealed, not even the outline');

    k.update(10.25);
    assert.deepEqual(state(fills[0]), ['0.25', true, false], 'progress is linear over the whole duration');
    assert.deepEqual(state(fills[1]), ['0', false, false]);

    k.update(11.5);
    assert.deepEqual(state(fills[0]), ['1', true, true]);
    assert.deepEqual(state(fills[1]), ['0.5', true, false]);

    // Going back (e.g. a seek) closes the margins again.
    k.update(10.5);
    assert.deepEqual(state(fills[0]), ['0.5', true, false]);
    assert.deepEqual(state(fills[1]), ['0', false, false]);
  });
});

test('Karaoke fit: long lines shrink, and wrap instead of overflowing at the smallest size', () => {
  withFakeDom(() => {
    const k = makeKaraoke(); // base font = round(min(66, 200 * 0.29, 800 * 0.065)) = 52 px
    assert.equal(k._fontBase, 52);
    const short = Array.from({ length: 10 }, () => '가'); // 520 px at 52 px: fits in 700
    const mid = Array.from({ length: 20 }, () => '가'); // 1040 px: shrinks
    const long = Array.from({ length: 40 }, () => '가'); // 2080 px: 0.4 x 52 = 20.8 px → 832 px > 700
    k.setLines([line(0, short), line(5.5, mid), line(16, long), line(36.5, short)]); // 0..5, 5.5..15.5, 16..36

    k.update(0);
    const l0 = k.slots[0].lineEl;
    const l1 = k.slots[1].lineEl;
    assert.equal(l0.style.fontSize, '52px');
    assert.equal(l0.classList.contains('is-wrap'), false);
    assert.equal(l1.style.fontSize, `${Math.floor(52 * (700 / 1040) * 0.98)}px`);
    assert.equal(l1.classList.contains('is-wrap'), false);

    k.update(6); // line 1 current, line 2 (the long one) enters the top slot
    const l2 = k.slots[0].lineEl;
    assert.equal(textOf(l2).length, 40);
    assert.equal(parseFloat(l2.style.fontSize), 52 * 0.4);
    assert.equal(l2.classList.contains('is-wrap'), true);

    // A wider panel re-measures the single-row width and drops the wrap when it now fits.
    for (const slot of k.slots) slot.el.clientWidth = 2200;
    k.refit();
    assert.equal(l2.classList.contains('is-wrap'), false);
    assert.equal(l2.style.fontSize, '52px');
  });
});
