import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKaraokeTimeline, karaokeViewAt, createKaraokeView, syllableProgress,
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
