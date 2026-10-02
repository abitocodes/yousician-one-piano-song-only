import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotation, notesToNotation } from '../js/core/notation.js';

test('parseNotation: names, beats, rests, separators (bpm 60 → 1 s per beat)', () => {
  const { notes, errors } = parseNotation('C4 D4:2 | E4:1/2, F#3:1.5\nR 도4 솔#:0.5 쉼:1/4 Bb4 rest:2 레', { bpm: 60 });
  assert.deepEqual(errors, []);
  assert.deepEqual(notes, [
    { t: 0, d: 1, m: 60 },
    { t: 1, d: 2, m: 62 },
    { t: 3, d: 0.5, m: 64 },
    { t: 3.5, d: 1.5, m: 54 },
    { t: 6, d: 1, m: 60 },
    { t: 7, d: 0.5, m: 68 },
    { t: 7.75, d: 1, m: 70 },
    { t: 10.75, d: 1, m: 62 },
  ]);
});

test('parseNotation: default octave 4, solfege names, offset and bpm', () => {
  const { notes, errors } = parseNotation('도 레 미 파 솔 라 시 도5', { bpm: 120, offset: 2 });
  assert.deepEqual(errors, []);
  assert.deepEqual(notes.map((n) => n.m), [60, 62, 64, 65, 67, 69, 71, 72]);
  assert.deepEqual(notes.map((n) => n.t), [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
  assert.ok(notes.every((n) => n.d === 0.5));
  const def = parseNotation('C4 D4');
  assert.deepEqual(def.notes, [{ t: 0, d: 0.6, m: 60 }, { t: 0.6, d: 0.6, m: 62 }]);
});

test('parseNotation: comments, blank lines and errors (bad token advances one beat)', () => {
  const { notes, errors } = parseNotation('# 제목\nC4 X9 D4:abc E4:0 F4:1/0\n\n  # 또 주석\nG4', { bpm: 60 });
  assert.deepEqual(errors, [
    '알 수 없는 음: "X9"',
    '알 수 없는 음: "D4:abc"',
    '알 수 없는 음: "E4:0"',
    '알 수 없는 음: "F4:1/0"',
  ]);
  assert.deepEqual(notes, [{ t: 0, d: 1, m: 60 }, { t: 5, d: 1, m: 67 }]);
});

test('parseNotation: notes outside the piano range are reported and keep their time', () => {
  const { notes, errors } = parseNotation('C0:2 C4', { bpm: 60 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"C0:2"/);
  assert.deepEqual(notes, [{ t: 2, d: 1, m: 60 }]);
});

test('parseNotation: empty / invalid input', () => {
  assert.deepEqual(parseNotation(''), { notes: [], errors: [] });
  assert.deepEqual(parseNotation(undefined), { notes: [], errors: [] });
  assert.deepEqual(parseNotation(' | , |'), { notes: [], errors: [] });
});

test('notesToNotation: bars, newline every 4 bars, beat formats', () => {
  const verse = 'C4 E4 G4 E4 | F4 A4 G4:2 | E4 G4 C5 B4 | A4 G4:3\nF4 F4 E4 D4 | E4 G4 F4:2 | D4 E4 F4 D4 | C4:4';
  const { notes } = parseNotation(verse, { bpm: 96 });
  assert.equal(notes.length, 25);
  assert.equal(notesToNotation(notes, { bpm: 96 }), verse);
  const odd = parseNotation('C4:1/2 D4:1/4 E4:3/4 F4:1.5 G4:0.5 A4:2.25', { bpm: 100 }).notes;
  // every token starts inside bar 1 (A4 at beat 3.5) → no separators
  assert.equal(notesToNotation(odd, { bpm: 100 }), 'C4:1/2 D4:1/4 E4:3/4 F4:1.5 G4:1/2 A4:2.25');
  assert.deepEqual(parseNotation(notesToNotation(odd, { bpm: 100 }), { bpm: 100 }).notes, odd);
  // a note crossing a bar line puts the separator before the next token
  assert.equal(notesToNotation(parseNotation('C4:3 D4:2 E4', { bpm: 60 }).notes, { bpm: 60 }), 'C4:3 D4:2 | E4');
});

test('notesToNotation: rests for gaps, leading rest, rests split at bars', () => {
  const src = 'R:2 C4 D4 | R:4 | E4:1/2 R:1/2 F4:2 R';
  const parsed = parseNotation(src, { bpm: 60 }).notes;
  const out = notesToNotation(parsed, { bpm: 60 });
  assert.equal(out, 'R:2 C4 D4 | R:4 | E4:1/2 R:1/2 F4:2');
  assert.deepEqual(parseNotation(out, { bpm: 60 }).notes, parsed);
  const gap = notesToNotation([{ t: 0, d: 1, m: 60 }, { t: 7, d: 1, m: 62 }], { bpm: 60 });
  assert.equal(gap, 'C4 R:3 | R:3 D4');
});

test('notesToNotation: staccato notes keep their positions; chords → highest', () => {
  const notes = [
    { t: 0, d: 0.3, m: 60 }, { t: 0, d: 0.9, m: 64 }, { t: 0.01, d: 0.9, m: 67 },
    { t: 1, d: 0.5, m: 62 },
    { t: 2, d: 3, m: 65 },
    { t: 3, d: 1, m: 69 }, // overlaps the previous note → previous shortened
  ];
  assert.equal(notesToNotation(notes, { bpm: 60 }), 'G4 D4:1/2 R:1/2 F4 A4');
  assert.equal(notesToNotation([]), '');
  assert.equal(notesToNotation(null), '');
});

test('notesToNotation: onsets that round to the same 1/4 beat do not delay the following notes', () => {
  // bpm 100 → 0.6 s per beat. D4 starts 50 ms after a long C4, so both round to beat 0.
  const notes = [
    { t: 0, d: 0.6, m: 60 },
    { t: 0.05, d: 0.55, m: 62 },
    { t: 0.6, d: 0.6, m: 64 },
    { t: 1.2, d: 0.6, m: 65 },
  ];
  const text = notesToNotation(notes, { bpm: 100 });
  assert.equal(text, 'C4:1/4 D4:3/4 E4 F4');
  const back = parseNotation(text, { bpm: 100 }).notes;
  assert.deepEqual(back.map((n) => n.t), [0, 0.15, 0.6, 1.2]);

  // rolled chord (overlapping long notes 40 ms apart) followed by quarter notes
  const rolled = [
    { t: 0, d: 1.2, m: 60 }, { t: 0.04, d: 1.2, m: 64 }, { t: 0.08, d: 1.2, m: 67 },
    { t: 1.2, d: 0.6, m: 69 }, { t: 1.8, d: 0.6, m: 71 }, { t: 2.4, d: 0.6, m: 72 },
  ];
  const out = parseNotation(notesToNotation(rolled, { bpm: 100 }), { bpm: 100 }).notes;
  assert.deepEqual(out.slice(-3).map((n) => [n.m, n.t]), [[69, 1.2], [71, 1.8], [72, 2.4]]);
});

test('notesToNotation ↔ parseNotation round trip for grid-aligned input (bpm, offset, 3/4)', () => {
  const opts = { bpm: 84, offset: 1.25, beatsPerBar: 3 };
  const src = parseNotation('도4 레4 미4 | 파4:2 솔#4:1/2 R:1/2 | 라4:3 | R:1 시4:1/4 C5:3/4 B4 | A4:6', opts).notes;
  const text = notesToNotation(src, opts);
  const back = parseNotation(text, opts);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.notes, src);
  assert.ok(text.includes(' | '));
});
