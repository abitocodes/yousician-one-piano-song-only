import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  midiToFreq, freqToMidi, pitchClass, octaveOf, isBlackKey, noteName, parseNoteName, samePitch, centsOff,
} from '../js/core/notes.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('midiToFreq / freqToMidi', () => {
  close(midiToFreq(69), 440);
  close(midiToFreq(60), 261.6255653005986, 1e-9);
  close(midiToFreq(81), 880);
  close(midiToFreq(69, 442), 442);
  close(freqToMidi(440), 69);
  close(freqToMidi(261.6255653005986), 60, 1e-9);
  close(freqToMidi(442, 442), 69);
  for (let m = 21; m <= 108; m++) close(freqToMidi(midiToFreq(m)), m, 1e-9);
  assert.ok(Number.isNaN(freqToMidi(0)));
  assert.ok(Number.isNaN(freqToMidi(-5)));
});

test('pitchClass and octaveOf (incl. negatives)', () => {
  assert.equal(pitchClass(60), 0);
  assert.equal(pitchClass(61), 1);
  assert.equal(pitchClass(71), 11);
  assert.equal(pitchClass(-1), 11);
  assert.equal(pitchClass(-12), 0);
  assert.equal(pitchClass(-13), 11);
  assert.equal(octaveOf(60), 4);
  assert.equal(octaveOf(59), 3);
  assert.equal(octaveOf(21), 0);
  assert.equal(octaveOf(0), -1);
  assert.equal(octaveOf(108), 8);
});

test('isBlackKey', () => {
  const black = [61, 63, 66, 68, 70];
  for (let m = 60; m < 72; m++) assert.equal(isBlackKey(m), black.includes(m), `midi ${m}`);
  assert.equal(isBlackKey(22), true);
  assert.equal(isBlackKey(21), false);
});

test('noteName styles', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61, 'en'), 'C#4');
  assert.equal(noteName(21), 'A0');
  assert.equal(noteName(108), 'C8');
  const sol = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
  for (let i = 0; i < 12; i++) assert.equal(noteName(60 + i, 'solfege'), sol[i]);
  assert.equal(noteName(72, 'solfege'), '도');
  assert.equal(noteName(60, 'solfege-octave'), '도4');
  assert.equal(noteName(66, 'solfege-octave'), '파#4');
  assert.equal(noteName(60, 'none'), '');
  assert.equal(noteName(60.4), 'C4');
  assert.equal(noteName(60.6), 'C#4');
  assert.equal(noteName(NaN), '');
});

test('parseNoteName: spec examples', () => {
  assert.equal(parseNoteName('C4'), 60);
  assert.equal(parseNoteName('c#4'), 61);
  assert.equal(parseNoteName('Db3'), 49);
  assert.equal(parseNoteName('Bb'), 70);
  assert.equal(parseNoteName('도4'), 60);
  assert.equal(parseNoteName('솔#3'), 56);
  assert.equal(parseNoteName('시'), 71);
});

test('parseNoteName: more forms and invalid input', () => {
  assert.equal(parseNoteName('  A4  '), 69);
  assert.equal(parseNoteName('C'), 60);
  assert.equal(parseNoteName('bb4'), 70);
  assert.equal(parseNoteName('b'), 71);
  assert.equal(parseNoteName('F♯2'), 42);
  assert.equal(parseNoteName('E♭5'), 75);
  assert.equal(parseNoteName('레b'), 61);
  assert.equal(parseNoteName('라4'), 69);
  assert.equal(parseNoteName('미'), 64);
  assert.equal(parseNoteName('파'), 65);
  assert.equal(parseNoteName('C-1'), 0);
  assert.equal(parseNoteName('G9'), 127);
  assert.equal(parseNoteName('A0'), 21);
  assert.equal(parseNoteName('C8'), 108);
  assert.equal(parseNoteName('Cb-1'), null); // -1
  assert.equal(parseNoteName('G#9'), null); // 128
  assert.equal(parseNoteName('C10'), null);
  assert.equal(parseNoteName('C##4'), null);
  assert.equal(parseNoteName('H4'), null);
  assert.equal(parseNoteName(''), null);
  assert.equal(parseNoteName('   '), null);
  assert.equal(parseNoteName('C 4'), null);
  assert.equal(parseNoteName('도레'), null);
  assert.equal(parseNoteName(null), null);
  assert.equal(parseNoteName(60), null);
  for (let m = 0; m <= 127; m++) assert.equal(parseNoteName(noteName(m)), m);
  for (let m = 12; m <= 119; m++) assert.equal(parseNoteName(noteName(m, 'solfege-octave')), m);
});

test('samePitch', () => {
  assert.equal(samePitch(60, 60, false), true);
  assert.equal(samePitch(60.3, 59.7, false), true);
  assert.equal(samePitch(60, 72, false), false);
  assert.equal(samePitch(60, 72, true), true);
  assert.equal(samePitch(60, 48, true), true);
  assert.equal(samePitch(60, 61, true), false);
  assert.equal(samePitch(60, NaN, true), false);
});

test('centsOff', () => {
  close(centsOff(440, 69), 0);
  close(centsOff(midiToFreq(69.5), 69), 50, 1e-9);
  close(centsOff(midiToFreq(68.9), 69), -10, 1e-9);
  close(centsOff(442, 69, 442), 0);
});
