// Pitch helpers: MIDI <-> frequency, note names (English and 도레미 solfege), parsing.

const EN_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE_NAMES = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
const BASE_PC = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  도: 0, 레: 2, 미: 4, 파: 5, 솔: 7, 라: 9, 시: 11,
};
const ACCIDENTAL = { '#': 1, '♯': 1, '＃': 1, b: -1, '♭': -1 };
const NOTE_RE = /^([A-Ga-g]|도|레|미|파|솔|라|시)([#♯＃b♭])?(-?\d+)?$/u;

export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

// Float MIDI number; NaN for non-positive / invalid input.
export function freqToMidi(freq, a4 = 440) {
  if (!(freq > 0) || !(a4 > 0) || !Number.isFinite(freq)) return NaN;
  return 69 + 12 * Math.log2(freq / a4);
}

export function pitchClass(midi) {
  const r = Math.round(midi);
  return ((r % 12) + 12) % 12;
}

export function octaveOf(midi) {
  return Math.floor(Math.round(midi) / 12) - 1;
}

export function isBlackKey(midi) {
  const pc = pitchClass(midi);
  return Number.isInteger(pc) ? BLACK[pc] : false;
}

export function noteName(midi, style = 'en') {
  if (!Number.isFinite(midi) || style === 'none') return '';
  const m = Math.round(midi);
  const pc = pitchClass(m);
  switch (style) {
    case 'solfege':
      return SOLFEGE_NAMES[pc];
    case 'solfege-octave':
      return SOLFEGE_NAMES[pc] + octaveOf(m);
    default:
      return EN_NAMES[pc] + octaveOf(m);
  }
}

// 'C4' → 60, 'c#4' → 61, 'Db3' → 49, 'Bb' → 70, '도4' → 60, '솔#3' → 56, '시' → 71. Invalid → null.
export function parseNoteName(str) {
  if (typeof str !== 'string') return null;
  const match = NOTE_RE.exec(str.trim());
  if (!match) return null;
  const [, letter, acc, oct] = match;
  const base = BASE_PC[letter.toUpperCase()];
  const octave = oct === undefined ? 4 : Number(oct);
  if (!Number.isInteger(octave) || octave < -1 || octave > 9) return null;
  const midi = (octave + 1) * 12 + base + (acc ? ACCIDENTAL[acc] : 0);
  return midi >= 0 && midi <= 127 ? midi : null;
}

export function samePitch(a, b, octaveTolerant) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const ra = Math.round(a);
  const rb = Math.round(b);
  if (ra === rb) return true;
  return Boolean(octaveTolerant) && pitchClass(ra) === pitchClass(rb);
}

export function centsOff(freq, midi, a4 = 440) {
  if (!(freq > 0)) return NaN;
  return 1200 * Math.log2(freq / midiToFreq(midi, a4));
}
