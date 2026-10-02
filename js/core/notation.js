// Simple text notation for melodies: "C4 D4 E4:2 | 도4 레4 미4:1/2 | R:1".

import { noteName, parseNoteName } from './notes.js';

const REST_RE = /^(r|rest|쉼|쉼표)$/i;
const DECIMAL_RE = /^(\d+(\.\d*)?|\.\d+)$/;
const FRACTION_RE = /^(\d+)\/(\d+)$/;
const SPLIT_RE = /[\s|,，]+/u;
const MAX_BEATS = 64;
const PIANO_LO = 21;
const PIANO_HI = 108;
const CHORD_EPS = 0.03;

const r3 = (x) => Math.round(x * 1000) / 1000;

function parseBeats(s) {
  let v = NaN;
  if (DECIMAL_RE.test(s)) {
    v = Number(s);
  } else {
    const f = FRACTION_RE.exec(s);
    if (f && Number(f[2]) > 0) v = Number(f[1]) / Number(f[2]);
  }
  return Number.isFinite(v) && v > 0 && v <= MAX_BEATS ? v : null;
}

function parseToken(tok) {
  const i = tok.search(/[:：]/u);
  const head = i < 0 ? tok : tok.slice(0, i);
  let beats = 1;
  if (i >= 0) {
    beats = parseBeats(tok.slice(i + 1));
    if (beats === null) return null;
  }
  if (REST_RE.test(head)) return { rest: true, beats };
  const m = parseNoteName(head);
  if (m === null) return null;
  return { rest: false, m, beats };
}

/**
 * Parses notation text → { notes, errors }. Tokens are separated by whitespace, '|' and ','.
 * Unknown tokens are reported and count as one beat so the following notes keep their position.
 */
export function parseNotation(text, { bpm = 100, offset = 0 } = {}) {
  const notes = [];
  const errors = [];
  const spb = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 100);
  const start = Number.isFinite(offset) ? offset : 0;
  let beat = 0;
  const src = typeof text === 'string' ? text : '';
  for (const line of src.split(/\r\n|\r|\n/)) {
    if (line.trim().startsWith('#')) continue;
    for (const tok of line.split(SPLIT_RE)) {
      if (!tok) continue;
      const parsed = parseToken(tok);
      if (!parsed) {
        errors.push(`알 수 없는 음: "${tok}"`);
        beat += 1;
        continue;
      }
      if (!parsed.rest) {
        if (parsed.m < PIANO_LO || parsed.m > PIANO_HI) {
          errors.push(`피아노 음역(A0~C8)을 벗어난 음: "${tok}"`);
        } else {
          notes.push({ t: r3(start + beat * spb), d: r3(parsed.beats * spb), m: parsed.m });
        }
      }
      beat += parsed.beats;
    }
  }
  return { notes, errors };
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

function formatBeats(beats) {
  if (Number.isInteger(beats)) return String(beats);
  if (beats < 1) {
    const q = Math.round(beats * 4);
    const g = gcd(q, 4);
    return `${q / g}/${4 / g}`;
  }
  return String(beats);
}

function tokenText(name, beats) {
  return beats === 1 ? name : `${name}:${formatBeats(beats)}`;
}

// Keeps the highest note of each onset group (chords → top note), sorted by time.
function topLine(notes) {
  const src = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && Number.isFinite(n.t) && Number.isFinite(n.m))
    .slice()
    .sort((a, b) => a.t - b.t || b.m - a.m);
  const out = [];
  let groupT = -Infinity;
  for (const n of src) {
    if (out.length && n.t - groupT <= CHORD_EPS + 1e-9) {
      if (n.m > out[out.length - 1].m) out[out.length - 1] = n;
    } else {
      out.push(n);
      groupT = n.t;
    }
  }
  return out;
}

/**
 * Best-effort inverse of parseNotation: positions/lengths rounded to 1/4 beat, rests for gaps,
 * ' | ' between bars and a newline every 4 bars.
 */
export function notesToNotation(notes, { bpm = 100, offset = 0, beatsPerBar = 4 } = {}) {
  const mel = topLine(notes);
  if (!mel.length) return '';
  const spb = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 100);
  const off = Number.isFinite(offset) ? offset : 0;
  const bpb = Number.isFinite(beatsPerBar) && beatsPerBar >= 1 ? beatsPerBar : 4;
  const q = (x) => Math.round(x * 4) / 4;
  const beatOf = (n) => q((n.t - off) / spb);

  const items = [];
  const pushRest = (from, len) => {
    while (len > 1e-9) {
      const barEnd = (Math.floor(from / bpb + 1e-9) + 1) * bpb;
      const chunk = Math.min(len, barEnd - from);
      items.push({ text: tokenText('R', chunk), start: from });
      from += chunk;
      len -= chunk;
    }
  };

  let cursor = 0;
  for (let i = 0; i < mel.length; i++) {
    const n = mel[i];
    const s = Math.max(beatOf(n), cursor);
    if (s - cursor >= 0.125) pushRest(cursor, s - cursor);
    let len = Math.max(0.25, q((Number.isFinite(n.d) ? n.d : 0) / spb));
    const next = mel[i + 1];
    if (next) {
      const ns = beatOf(next);
      // The next onset rounds to this slot (or earlier): take one 1/4-beat slot so the delay never cascades.
      len = ns > s ? Math.min(len, ns - s) : 0.25;
    }
    items.push({ text: tokenText(noteName(n.m, 'en'), len), start: s });
    cursor = s + len;
  }

  let out = '';
  let lastBar = 0;
  for (const it of items) {
    const bar = Math.floor(it.start / bpb + 1e-9);
    if (out) {
      if (bar > lastBar) out += Math.floor(bar / 4) > Math.floor(lastBar / 4) ? '\n' : ' | ';
      else out += ' ';
    }
    if (bar > lastBar) lastBar = bar;
    out += it.text;
  }
  return out;
}
