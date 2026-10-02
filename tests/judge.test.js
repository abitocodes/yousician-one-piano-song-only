import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Judge, WINDOWS, GRADE_FACTOR, rankFor, GROUP_EPS } from '../js/game/judge.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
const N = (t, m, d = 0.4) => ({ t, d, m });

test('exports match the spec', () => {
  assert.deepEqual(WINDOWS.easy, { perfect: 0.10, great: 0.18, good: 0.30 });
  assert.deepEqual(WINDOWS.normal, { perfect: 0.07, great: 0.14, good: 0.23 });
  assert.deepEqual(WINDOWS.hard, { perfect: 0.045, great: 0.09, good: 0.15 });
  assert.deepEqual(GRADE_FACTOR, { perfect: 1, great: 0.7, good: 0.4, miss: 0 });
});

test('rankFor thresholds', () => {
  assert.equal(rankFor(1), 'S');
  assert.equal(rankFor(0.95), 'S');
  assert.equal(rankFor(0.9499), 'A');
  assert.equal(rankFor(0.85), 'A');
  assert.equal(rankFor(0.8499), 'B');
  assert.equal(rankFor(0.70), 'B');
  assert.equal(rankFor(0.6999), 'C');
  assert.equal(rankFor(0.50), 'C');
  assert.equal(rankFor(0.4999), 'D');
  assert.equal(rankFor(0), 'D');
  assert.equal(rankFor(NaN), 'D');
});

test('grades by window (normal), including boundaries and late/early sign', () => {
  const cases = [
    [0, 'perfect'], [0.07, 'perfect'], [-0.07, 'perfect'],
    [0.071, 'great'], [-0.14, 'great'],
    [0.141, 'good'], [-0.23, 'good'],
  ];
  for (const [dt, grade] of cases) {
    const j = new Judge([N(1, 60)]);
    const r = j.input({ time: 1 + dt, midi: 60 });
    assert.ok(r, `hit expected for dt=${dt}`);
    assert.equal(r.grade, grade, `dt=${dt}`);
    assert.equal(r.index, 0);
    close(r.delta, dt);
    close(r.deltaReal, dt);
    assert.equal(j.stateOf(0), grade);
  }
});

test('outside the good window is a stray, note stays pending', () => {
  const j = new Judge([N(1, 60)]);
  assert.equal(j.input({ time: 1.24, midi: 60 }), null);
  assert.equal(j.input({ time: 0.76, midi: 60 }), null);
  assert.equal(j.stateOf(0), 'pending');
  assert.equal(j.stats.stray, 2);
  assert.equal(j.stats.judged, 0);
});

test('difficulty windows and overrides', () => {
  const hard = new Judge([N(1, 60)], { difficulty: 'hard' });
  assert.equal(hard.input({ time: 1.05, midi: 60 }).grade, 'great');
  const hardMiss = new Judge([N(1, 60)], { difficulty: 'hard' });
  assert.equal(hardMiss.input({ time: 1.2, midi: 60 }), null);
  const easy = new Judge([N(1, 60)], { difficulty: 'easy' });
  assert.equal(easy.input({ time: 1.29, midi: 60 }).grade, 'good');
  const unknown = new Judge([N(1, 60)], { difficulty: 'nope' });
  assert.deepEqual(unknown.windows, WINDOWS.normal);
  const custom = new Judge([N(1, 60)], { windows: { perfect: 0.45, great: 0.45, good: 0.45 } });
  assert.equal(custom.input({ time: 1.44, midi: 60 }).grade, 'perfect');
});

test('wrong pitch does not match; octave tolerance', () => {
  const strict = new Judge([N(1, 60)], { octaveTolerant: false });
  assert.equal(strict.input({ time: 1, midi: 61 }), null);
  assert.equal(strict.input({ time: 1.1, midi: 72 }), null);
  assert.equal(strict.stats.stray, 2);
  assert.equal(strict.stateOf(0), 'pending');

  const tolerant = new Judge([N(1, 60)], { octaveTolerant: true });
  assert.equal(tolerant.input({ time: 1, midi: 61 }), null);
  const r = tolerant.input({ time: 1.1, midi: 48 });
  assert.equal(r.grade, 'great');
});

test('anyPitch accepts any key', () => {
  const j = new Judge([N(1, 60), N(2, 64)], { anyPitch: true });
  assert.equal(j.input({ time: 1.01, midi: 30 }).index, 0);
  assert.equal(j.input({ time: 2.2, midi: 100 }).index, 1);
});

test('nearest pending note is chosen; ties go to the earliest', () => {
  const notes = [N(1, 60), N(1.2, 60), N(1.4, 60)];
  const j = new Judge(notes);
  // 1.15 is closer to 1.2 than to 1.0
  assert.equal(j.input({ time: 1.15, midi: 60 }).index, 1);
  // 1.0 is pending and nearest
  assert.equal(j.input({ time: 0.98, midi: 60 }).index, 0);

  const t = new Judge([N(1, 60), N(1.2, 60)]);
  assert.equal(t.input({ time: 1.1, midi: 60 }).index, 0, 'tie → earliest');
});

test('a consistently late player keeps their own notes on a run of repeated pitches', () => {
  // A few different pitches struck 80 ms late, then four C4 16ths (0.1 s apart) struck 80 ms late too.
  // Plain nearest-onset matching would hand each late strike to the NEXT C4 (miss + stray).
  const notes = [N(0.5, 60), N(1, 62), N(1.5, 64), N(2, 65), N(2.5, 60), N(2.6, 60), N(2.7, 60), N(2.8, 60)];
  const j = new Judge(notes);
  const late = 0.08;
  notes.forEach((n, i) => {
    const r = j.input({ time: n.t + late, midi: n.m });
    assert.ok(r, `strike ${i} hits`);
    assert.equal(r.index, i, `strike ${i} takes its own note`);
    close(r.deltaReal, late, 1e-9);
    assert.equal(r.grade, 'great');
  });
  j.update(10);
  const s = j.stats;
  assert.equal(s.counts.miss, 0);
  assert.equal(s.stray, 0);
  assert.equal(s.counts.great, notes.length);
});

test('16ths struck 55 ms late (inside PERFECT) keep their notes once the offset is known', () => {
  // One lead-in note establishes the offset; without the bias every C4 strike would take the next C4.
  const notes = [N(0.6, 67), N(1, 60), N(1.1, 60), N(1.2, 60), N(1.3, 60)];
  const j = new Judge(notes);
  for (const n of notes) j.input({ time: n.t + 0.055, midi: n.m });
  j.update(10);
  assert.deepEqual(j.states, ['perfect', 'perfect', 'perfect', 'perfect', 'perfect']);
  assert.equal(j.stats.stray, 0);
  assert.equal(j.stats.score, 1000000);
});

test('a skipped note is the one missed, with or without a late bias', () => {
  // On time: skip the second of four C4 16ths.
  const notes = [N(1, 60), N(1.1, 60), N(1.2, 60), N(1.3, 60)];
  const j = new Judge(notes);
  assert.equal(j.input({ time: 1.0, midi: 60 }).index, 0);
  assert.equal(j.input({ time: 1.2, midi: 60 }).index, 2);
  assert.equal(j.input({ time: 1.3, midi: 60 }).index, 3);
  j.update(10);
  assert.deepEqual(j.states, ['perfect', 'miss', 'perfect', 'perfect']);
  assert.equal(j.stats.stray, 0);
  assert.equal(j.stats.score, 750000);

  // Consistently 60 ms late (bias established on earlier notes), skipping the second C4.
  const late = [N(0.5, 62), N(0.8, 64), N(1, 60), N(1.1, 60), N(1.2, 60), N(1.3, 60)];
  const k = new Judge(late);
  for (const i of [0, 1, 2, 4, 5]) assert.equal(k.input({ time: late[i].t + 0.06, midi: late[i].m }).index, i);
  k.update(10);
  assert.deepEqual(k.states, ['perfect', 'perfect', 'perfect', 'miss', 'perfect', 'perfect']);
  assert.equal(k.stats.stray, 0);
});

test('early history never biases the ranking (bias is clamped at 0)', () => {
  const notes = [N(0.5, 62), N(0.8, 64), N(1, 60), N(1.2, 60)];
  const j = new Judge(notes);
  j.input({ time: 0.4, midi: 62 });
  j.input({ time: 0.7, midi: 64 });
  // 1.09 is nearer 1.0 than 1.2; a negative (early) bias would push it onto the later note.
  assert.equal(j.input({ time: 1.09, midi: 60 }).index, 2);
});

test('fresh judge, repeated-pitch pairs struck 130 ms late: a stray shifts the early hit back', () => {
  // 8ths 0.25 s apart in pairs (original pattern), every strike 130 ms late (inside GREAT), no lead-in.
  // The first strike is nearer the SECOND note; the second strike then finds nothing → it proves the
  // first was late for note 0, so both are re-assigned and the offset is known from then on.
  const pitches = [64, 64, 67, 67, 62, 62, 65];
  const notes = pitches.map((m, i) => N(i * 0.25, m));
  const j = new Judge(notes);
  const events = [];
  j.on('judge', (r) => events.push(r));
  const first = j.input({ time: 0.13, midi: 64 });
  assert.equal(first.index, 1, 'nearest-onset guess');
  close(first.deltaReal, -0.12);
  const second = j.input({ time: 0.38, midi: 64 });
  assert.ok(second, 'the second strike is not a stray');
  assert.equal(second.index, 1);
  close(second.deltaReal, 0.13);
  assert.equal(second.grade, 'great');
  assert.equal(j.stateOf(0), 'great');
  // Events: the guess, then the moved hit (marked retro), then the new strike.
  assert.deepEqual(events.map((r) => [r.index, r.grade, !!r.retro]), [[1, 'great', false], [0, 'great', true], [1, 'great', false]]);
  close(events[1].deltaReal, 0.13);
  for (let i = 2; i < notes.length; i++) assert.equal(j.input({ time: notes[i].t + 0.13, midi: notes[i].m }).index, i);
  j.update(10);
  const s = j.stats;
  assert.deepEqual(j.states, new Array(7).fill('great'));
  assert.deepEqual(s.counts, { perfect: 0, great: 7, good: 0, miss: 0 });
  assert.equal(s.stray, 0);
  assert.equal(s.score, 700000);
  assert.equal(s.combo, 7);
  assert.equal(s.maxCombo, 7);
  assert.equal(s.deltas.length, 7, 'one timing sample per strike');
  for (const d of s.deltas) close(d, 0.13);
  close(s.meanDelta, 0.13);
});

test('fresh judge, four 16ths struck 55 ms late: a run of early guesses is shifted back as a whole', () => {
  const notes = [N(1, 60), N(1.1, 60), N(1.2, 60), N(1.3, 60)];
  const j = new Judge(notes);
  const got = notes.map((n) => j.input({ time: n.t + 0.055, midi: 60 }));
  // Strikes 1-3 guessed the next note each; the 4th found nothing and shifted all three back.
  assert.deepEqual(got.map((r) => r && r.index), [1, 2, 3, 3]);
  j.update(10);
  assert.deepEqual(j.states, ['perfect', 'perfect', 'perfect', 'perfect']);
  assert.equal(j.stats.stray, 0);
  assert.equal(j.stats.score, 1000000);
  for (const d of j.stats.deltas) close(d, 0.055);
  assert.equal(j.stats.combo, 4);
});

test('the shift also works when the detection arrives after the older note\'s deadline', () => {
  // Mic-like: each strike is processed `arrive` s after its (latency-corrected) time, with update() frames
  // in between. Note 0's deadline (0.23 + 0.25 grace) passes before the second strike is processed.
  const pitches = [64, 64, 67, 67, 62, 62, 65];
  const notes = pitches.map((m, i) => N(i * 0.25, m));
  const j = new Judge(notes, { grace: 0.25 });
  const arrive = 0.175;
  const strikes = notes.map((n) => ({ time: n.t + 0.13, midi: n.m }));
  let s = 0;
  for (let f = 0; f <= 180; f++) {
    const now = f / 60;
    while (s < strikes.length && strikes[s].time + arrive <= now) j.input(strikes[s++]);
    j.update(now);
  }
  assert.deepEqual(j.states, new Array(7).fill('great'));
  assert.equal(j.stats.stray, 0);
});

test('a skipped note next to an early hit is missed late, once the later note can no longer be struck', () => {
  // On time, note 0 skipped; the strike for note 1 is 10 ms early (also inside note 0's window).
  const j = new Judge([N(1, 60), N(1.2, 60), N(3, 62)]);
  assert.equal(j.input({ time: 1.19, midi: 60 }).index, 1);
  assert.deepEqual(j.update(1.39), [], 'note 0 is kept pending while note 1\'s strike may still arrive');
  assert.equal(j.stateOf(0), 'pending');
  const misses = j.update(1.59);
  assert.deepEqual(misses.map((r) => r.index), [0]);
  assert.equal(j.stateOf(1), 'perfect');
  // An unrelated stray never moves hits.
  assert.equal(j.input({ time: 2.5, midi: 60 }), null);
  assert.equal(j.stats.stray, 1);
  assert.equal(j.stateOf(1), 'perfect');
});

test('no shift when the earlier hits were late or the stray is outside the vacated note\'s window', () => {
  const j = new Judge([N(1, 60), N(1.2, 60), N(1.4, 60)]);
  assert.equal(j.input({ time: 1.25, midi: 60 }).index, 1);       // +0.05: not an early guess
  assert.equal(j.input({ time: 1.45, midi: 60 }).index, 2);
  assert.equal(j.input({ time: 1.5, midi: 60 }), null);
  assert.equal(j.stateOf(0), 'pending');
  assert.equal(j.stats.stray, 1);

  const k = new Judge([N(1, 60), N(1.2, 60)]);
  assert.equal(k.input({ time: 1.15, midi: 60 }).index, 1);       // early guess
  assert.equal(k.input({ time: 1.45, midi: 60 }), null, '0.25 s after note 1: outside its window');
  assert.equal(k.stateOf(0), 'pending');
  assert.equal(k.input({ time: 1.17, midi: 62 }), null, 'other pitch');
  assert.equal(k.stateOf(0), 'pending');
});

test('ambiguous picks (another onset in the window) do not train the bias', () => {
  const notes = [N(1, 60), N(1.2, 60), N(2, 60), N(2.1, 60)];
  const j = new Judge(notes);
  // 1.09 takes note 0 (+0.09), but note 1 was a candidate too: a guess, not a timing sample for the bias.
  assert.equal(j.input({ time: 1.09, midi: 60 }).index, 0);
  assert.equal(j.input({ time: 1.2, midi: 60 }).index, 1);
  // With a 0.09 bias, 2.06 would rank note 2 first; without it note 3 (|−0.04|) is nearest.
  assert.equal(j.input({ time: 2.06, midi: 60 }).index, 3);
  // The stats still record every timed hit.
  assert.equal(j.stats.deltas.length, 3);
});

test('octaves: a detector strike also hits octave copies in its onset group; touch hits one note', () => {
  const notes = [N(1, 60), N(1, 72), N(1.01, 48), N(1, 64), N(2, 62), N(2, 74)];
  const j = new Judge(notes);
  const events = [];
  j.on('judge', (r) => events.push(r.index));
  const r = j.input({ time: 1.0, midi: 60, octaves: true });
  assert.equal(r.index, 0);
  assert.deepEqual(events.sort(), [0, 1, 2]);
  assert.equal(j.stateOf(3), 'pending', 'other pitch class untouched');
  assert.equal(j.stats.counts.perfect, 3);
  assert.equal(j.stats.combo, 3);
  assert.equal(j.stats.deltas.length, 1, 'one strike, one timing sample');
  assert.equal(j.input({ time: 1.0, midi: 64 }).index, 3, 'the same onset can still complete the chord');
  assert.equal(j.input({ time: 2, midi: 62 }).index, 4);
  assert.equal(j.stateOf(5), 'pending', 'without octaves: one note per strike');

  const strict = new Judge([N(1, 60), N(1, 72)], { octaveTolerant: false });
  strict.input({ time: 1, midi: 60, octaves: true });
  assert.deepEqual(strict.states, ['perfect', 'pending'], 'octave copies need octave tolerance');
});

test('hitHeld with octaves hits the octave copies of the target pitch', () => {
  const j = new Judge([N(1, 48), N(1, 60), N(1, 64)], { noMiss: true });
  const r = j.hitHeld(60, 0.02, undefined, { octaves: true });
  assert.deepEqual(r.map((x) => x.index), [0, 1]);
  assert.equal(r[0].grade, 'perfect');
  assert.equal(r[1].grade, 'perfect');
  assert.deepEqual(j.pendingGroup(), [2]);
  assert.equal(j.stats.deltas.length, 1, 'one strike, one timing sample');
});

test('the late bias is capped at the great window', () => {
  // History 220 ms late (good) on normal: the ranking offset is capped at 140 ms.
  const notes = [N(0.5, 62), N(1, 64), N(2, 60), N(2.1, 60)];
  const j = new Judge(notes);
  j.input({ time: 0.72, midi: 62 });
  j.input({ time: 1.22, midi: 64 });
  // 2.2 - 0.14 = 2.06 → nearer 2.1 (an uncapped 0.22 offset would give 1.98 → 2.0).
  assert.equal(j.input({ time: 2.2, midi: 60 }).index, 3);
});

test('already-judged notes are not candidates; next same pitch is taken', () => {
  const j = new Judge([N(1, 60), N(1.2, 60)]);
  assert.equal(j.input({ time: 1.0, midi: 60 }).index, 0);
  // Different strike (well apart in time) near the first note → takes the second note if in window.
  const r = j.input({ time: 1.06, midi: 60 });
  assert.equal(r.index, 1);
  assert.equal(r.grade, 'great');
});

test('octave-tolerant tie prefers the exact pitch', () => {
  const j = new Judge([N(1, 48), N(1, 60)]);
  assert.equal(j.input({ time: 1, midi: 60 }).index, 1);
  assert.equal(j.input({ time: 1.0, midi: 48 }).index, 0);
});

test('chord notes are each hit by their own pitch at the same strike', () => {
  const j = new Judge([N(2, 60), N(2, 64), N(2, 67)], { octaveTolerant: false });
  assert.equal(j.input({ time: 2.01, midi: 64 }).index, 1);
  assert.equal(j.input({ time: 2.01, midi: 60 }).index, 0);
  assert.equal(j.input({ time: 2.01, midi: 67 }).index, 2);
  assert.equal(j.stats.counts.perfect, 3);
  assert.equal(j.stats.combo, 3);
});

test('duplicate detections of one strike cannot steal the next note and are not strays', () => {
  // Repeated C, 0.2 s apart; detector reports C4 and its octave C5 at the same onset.
  const j = new Judge([N(1, 60), N(1.2, 60)]);
  assert.equal(j.input({ time: 1.0, midi: 60 }).index, 0);
  assert.equal(j.input({ time: 1.0, midi: 72 }), null);
  assert.equal(j.stateOf(1), 'pending');
  assert.equal(j.stats.stray, 0);
  // The real second strike still hits.
  assert.equal(j.input({ time: 1.21, midi: 60 }).index, 1);
});

test('same-strike detections may still complete the same onset group', () => {
  const j = new Judge([N(1, 60), N(1 + GROUP_EPS / 2, 67)]);
  assert.equal(j.input({ time: 1.0, midi: 60 }).index, 0);
  assert.equal(j.input({ time: 1.0, midi: 67 }).index, 1);
});

test('update declares misses only after good + grace', () => {
  const j = new Judge([N(1, 60), N(3, 62)]);
  const events = [];
  j.on('judge', (r) => events.push(r));
  assert.deepEqual(j.update(1.3), []); // 1 + 0.23 + 0.15 = 1.38
  assert.deepEqual(j.update(1.38), []);
  const misses = j.update(1.39);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].grade, 'miss');
  assert.equal(misses[0].index, 0);
  close(misses[0].delta, 0.39);
  assert.equal(j.stateOf(0), 'miss');
  assert.equal(j.stateOf(1), 'pending');
  assert.equal(events.length, 1);
  assert.equal(j.judgedAt[0], 1.39);
  assert.ok(Number.isNaN(j.judgedAt[1]));
  // A late detection still inside the good window before the miss deadline counts as a hit.
  const k = new Judge([N(1, 60)]);
  k.update(1.3);
  assert.equal(k.input({ time: 1.2, midi: 60 }).grade, 'good');
  assert.deepEqual(k.update(5), []);
});

test('a missed note cannot be hit afterwards', () => {
  const j = new Judge([N(1, 60)]);
  j.update(2);
  assert.equal(j.input({ time: 1.0, midi: 60 }), null);
  assert.equal(j.stats.stray, 1);
});

test('noMiss never declares misses', () => {
  const j = new Judge([N(1, 60)], { noMiss: true });
  assert.deepEqual(j.update(100), []);
  assert.equal(j.stateOf(0), 'pending');
  assert.equal(j.firstPending(), 0);
});

test('speed scales the windows and grace in song time; deltaReal is in real seconds', () => {
  const j = new Judge([N(1, 60)], { speed: 0.5 });
  // 0.1 song s at 0.5x = 0.2 real s → great (≤ 0.14? no) → good
  const r = j.input({ time: 1.1, midi: 60 });
  close(r.deltaReal, 0.2);
  assert.equal(r.grade, 'good');

  const k = new Judge([N(1, 60)], { speed: 0.5 });
  close(k.input({ time: 1.03, midi: 60 }).deltaReal, 0.06);
  assert.equal(k.stateOf(0), 'perfect');

  const fast = new Judge([N(1, 60)], { speed: 1.25 });
  // window in song time = 0.23 * 1.25 = 0.2875
  assert.equal(fast.input({ time: 1.28, midi: 60 }).grade, 'good');

  const m = new Judge([N(1, 60)], { speed: 0.5 });
  assert.deepEqual(m.update(1 + 0.38 * 0.5), []);
  assert.equal(m.update(1 + 0.38 * 0.5 + 0.001).length, 1);

  const s = new Judge([N(1, 60)]);
  s.setSpeed(0.5);
  assert.equal(s.speed, 0.5);
  assert.equal(s.input({ time: 1.4, midi: 60 }), null); // 0.4 song s → 0.8 real s, outside
});

test('hitHeld hits the earliest pending group with grade good and delta 0', () => {
  const notes = [N(1, 60), N(2, 64), N(2, 67), N(3, 65)];
  const j = new Judge(notes, { noMiss: true, octaveTolerant: false });
  assert.deepEqual(j.hitHeld(64), [], 'not in the earliest group');
  let r = j.hitHeld(60);
  assert.equal(r.length, 1);
  assert.equal(r[0].grade, 'good');
  assert.equal(r[0].delta, 0);
  assert.equal(r[0].deltaReal, 0);
  assert.equal(r[0].index, 0);
  assert.equal(j.judgedAt[0], 1);
  assert.deepEqual(j.pendingGroup(), [1, 2]);
  r = j.hitHeld(67);
  assert.deepEqual(r.map((x) => x.index), [2]);
  assert.equal(j.firstPending(), 1);
  assert.deepEqual(j.pendingGroup(), [1]);
  r = j.hitHeld(64);
  assert.deepEqual(r.map((x) => x.index), [1]);
  assert.equal(j.firstPending(), 3);
  assert.deepEqual(j.hitHeld(77), [], 'octave not accepted when strict');
  const st = j.stats;
  assert.equal(st.counts.good, 3);
  assert.equal(st.combo, 3);
  assert.deepEqual(st.deltas, [], 'held hits are not timing measurements');
});

test('hitHeld with a delta grades by timing inside the good window', () => {
  const notes = [N(1, 60), N(2, 62), N(3, 64), N(4, 65), N(5, 67), N(6, 69)];
  const j = new Judge(notes, { noMiss: true });
  const cases = [[0, 'perfect'], [-0.05, 'perfect'], [-0.1, 'great'], [0.12, 'great'], [-0.2, 'good']];
  cases.forEach(([d, grade], i) => {
    const r = j.hitHeld(notes[i].m, d);
    assert.equal(r.length, 1);
    assert.equal(r[0].index, i);
    assert.equal(r[0].grade, grade, `delta ${d}`);
    close(r[0].delta, d);
    close(r[0].deltaReal, d);
    assert.equal(j.judgedAt[i], notes[i].t, 'default judgedAt is the onset');
  });
  // Outside the good window: the fixed untimed 'good'.
  const r = j.hitHeld(69, -0.5, 6.2);
  assert.equal(r[0].grade, 'good');
  assert.equal(r[0].delta, 0);
  assert.equal(j.judgedAt[5], 6.2, 'explicit judgedAt');
  const s = j.stats;
  assert.deepEqual(s.counts, { perfect: 2, great: 2, good: 2, miss: 0 });
  assert.equal(s.deltas.length, 5, 'timed held hits are timing measurements');
  close(s.deltas[2], -0.1);
});

test('hitHeld delta is in song seconds and scaled by speed; null/NaN keep the fixed good', () => {
  const j = new Judge([N(1, 60), N(2, 62), N(3, 64)], { noMiss: true, speed: 0.5 });
  // -0.05 song s at 0.5x = -0.1 real s → great
  const r = j.hitHeld(60, -0.05);
  assert.equal(r[0].grade, 'great');
  close(r[0].deltaReal, -0.1);
  assert.equal(j.hitHeld(62, null)[0].grade, 'good');
  assert.equal(j.hitHeld(64, NaN)[0].grade, 'good');
  assert.equal(j.stats.deltas.length, 1);
});

test('hitHeld respects octave tolerance and prefers exact pitch', () => {
  const j = new Judge([N(1, 48), N(1, 60)], { noMiss: true, octaveTolerant: true });
  const r = j.hitHeld(60);
  assert.deepEqual(r.map((x) => x.index), [1]);
  const r2 = j.hitHeld(72);
  assert.deepEqual(r2.map((x) => x.index), [0]);
  assert.equal(j.firstPending(), -1);
  assert.deepEqual(j.hitHeld(60), []);
});

test('stats: score, accuracy, combo, mean delta, rank', () => {
  const notes = [N(1, 60), N(2, 60), N(3, 60), N(4, 60)];
  const j = new Judge(notes);
  let s = j.stats;
  assert.equal(s.score, 0);
  assert.equal(s.maxScore, 1000000);
  assert.equal(s.accuracy, 0);
  assert.equal(s.total, 4);
  assert.equal(s.judged, 0);
  assert.equal(s.rank, 'D');

  j.input({ time: 1.0, midi: 60 });   // perfect, delta 0
  j.input({ time: 2.1, midi: 60 });   // great, +0.1
  s = j.stats;
  assert.equal(s.combo, 2);
  assert.equal(s.judged, 2);
  close(s.accuracy, (1 + 0.7) / 2);
  assert.equal(s.score, Math.round(1.7 * 250000));
  assert.equal(s.rank, rankFor(0.85));

  j.update(3.5);                       // note 3 missed
  s = j.stats;
  assert.equal(s.combo, 0);
  assert.equal(s.maxCombo, 2);
  assert.equal(s.counts.miss, 1);

  j.input({ time: 3.8, midi: 60 });    // good, -0.2
  s = j.stats;
  assert.equal(s.judged, 4);
  assert.equal(s.combo, 1);
  assert.equal(s.maxCombo, 2);
  assert.deepEqual(s.counts, { perfect: 1, great: 1, good: 1, miss: 1 });
  assert.equal(s.score, Math.round((1 + 0.7 + 0 + 0.4) * 250000));
  close(s.accuracy, 2.1 / 4);
  assert.equal(s.rank, 'C');
  assert.equal(s.deltas.length, 3);
  close(s.meanDelta, (0 + 0.1 - 0.2) / 3);
  assert.equal(j.firstPending(), -1);
});

test('perfect run scores exactly 1,000,000 and rank S', () => {
  const notes = [N(0.5, 60), N(1, 62), N(1.5, 64)];
  const j = new Judge(notes);
  for (const n of notes) j.input({ time: n.t, midi: n.m });
  const s = j.stats;
  assert.equal(s.score, 1000000);
  assert.equal(s.accuracy, 1);
  assert.equal(s.rank, 'S');
  assert.equal(s.maxCombo, 3);
});

test('stats object is cached until something changes', () => {
  const j = new Judge([N(1, 60), N(2, 62)]);
  const a = j.stats;
  assert.equal(j.stats, a);
  j.input({ time: 1, midi: 60 });
  assert.notEqual(j.stats, a);
});

test('judge events are emitted for hits, misses and held hits', () => {
  const j = new Judge([N(1, 60), N(2, 62), N(3, 64)]);
  const grades = [];
  j.on('judge', (r) => grades.push(`${r.index}:${r.grade}`));
  j.input({ time: 1, midi: 60 });
  j.update(10);
  assert.deepEqual(grades, ['0:perfect', '1:miss', '2:miss']);
});

test('judgedAt uses the later of event time and last update time', () => {
  const j = new Judge([N(1, 60), N(2, 62)]);
  j.input({ time: 1.05, midi: 60 });
  assert.equal(j.judgedAt[0], 1.05);
  j.update(2.1);
  j.input({ time: 1.95, midi: 62 });
  assert.equal(j.judgedAt[1], 2.1);
});

test('reset restores everything', () => {
  const j = new Judge([N(1, 60), N(2, 62)]);
  j.input({ time: 1, midi: 60 });
  j.input({ time: 5, midi: 70 });
  j.update(10);
  j.reset();
  assert.deepEqual(j.states, ['pending', 'pending']);
  assert.ok(Number.isNaN(j.judgedAt[0]));
  const s = j.stats;
  assert.equal(s.judged, 0);
  assert.equal(s.stray, 0);
  assert.equal(s.combo, 0);
  assert.equal(s.maxCombo, 0);
  assert.equal(j.firstPending(), 0);
  assert.equal(j.input({ time: 1, midi: 60 }).grade, 'perfect');
});

test('unsorted input arrays are judged in time order with caller indices', () => {
  const notes = [N(3, 64), N(1, 60), N(2, 62)];
  const j = new Judge(notes);
  assert.equal(j.firstPending(), 1);
  assert.equal(j.input({ time: 2, midi: 62 }).index, 2);
  j.update(1.5);
  assert.equal(j.stateOf(1), 'miss');
  assert.equal(j.firstPending(), 0);
});

test('empty chart and invalid input are handled', () => {
  const j = new Judge([]);
  assert.equal(j.firstPending(), -1);
  assert.deepEqual(j.update(5), []);
  assert.deepEqual(j.hitHeld(60), []);
  assert.equal(j.input({ time: 1, midi: 60 }), null);
  const s = j.stats;
  assert.equal(s.total, 0);
  assert.equal(s.score, 0);
  assert.equal(s.stray, 1);
  const k = new Judge([N(1, 60)]);
  assert.equal(k.input({ time: NaN, midi: 60 }), null);
  assert.equal(k.input({}), null);
  assert.equal(k.stats.stray, 0);
});

test('states array is a live reference', () => {
  const j = new Judge([N(1, 60)]);
  const states = j.states;
  j.input({ time: 1, midi: 60 });
  assert.equal(states[0], 'perfect');
});
