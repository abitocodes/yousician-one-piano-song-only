import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteDetector } from '../js/audio/detector.js';
import { hzToMidi } from '../js/audio/dsp.js';
import {
  mulberry32, hz, addNoise, addPianoTone, addEnvelopedTone, ramp, renderNotes, runDetector, runDetectorChunked,
  evaluate,
} from './helpers-signal.js';

// All material below is original exercise content (scales, arpeggios, repeated tones) — no real songs.

const RATES = [48000, 44100];
const ONSET_TOL = 0.025; // s
const SOURCES = ['onset', 'pitch-change'];
const INITIAL_ANALYSIS = { time: 0, db: -120, gateOpen: false, pitch: null, topNotes: [], onset: false };

// Stepwise phrase over C4..C5 with a few leaps.
const PHRASE = [60, 62, 64, 65, 67, 69, 67, 65, 64, 62, 60, 64, 67, 72, 71, 69, 67, 65, 64, 62, 59, 60];

function seq(pitches, { t0 = 0.3, ioi = 0.4, dur = 0.3, amp } = {}) {
  return pitches.map((m, i) => ({ t: t0 + i * ioi, m, d: dur, ...(amp === undefined ? {} : { amp }) }));
}

function byTime(notes) {
  return notes.slice().sort((a, b) => a.t - b.t || a.m - b.m);
}

function detect(notes, { sampleRate = 48000, sensitivity = 0.6, a4 = 440, render = {}, chunk = 1024 } = {}) {
  const buf = renderNotes(notes, { sampleRate, a4, ...render });
  const det = new NoteDetector({ sampleRate, sensitivity, a4 });
  const events = runDetector(det, buf, sampleRate, { chunk });
  return { events, r: evaluate(events, notes, { tol: ONSET_TOL }), det, buf };
}

const fmtNotes = (list) => list.map((n) => `${n.m}@${n.t.toFixed(3)}`).join(' ') || '-';
const fmtEvents = (list) => list.map((e) => `${e.midi}@${e.time.toFixed(3)}(${e.source})`).join(' ') || '-';

function assertEventShape(e) {
  assert.ok(Number.isFinite(e.time), `time ${e.time}`);
  assert.ok(Number.isInteger(e.midi) && e.midi >= 21 && e.midi <= 108, `midi ${e.midi}`);
  assert.ok(e.freq > 0 && Math.abs(hzToMidi(e.freq) - e.midi) < 0.6, `freq ${e.freq} for midi ${e.midi}`);
  assert.ok(e.strength >= 0 && e.strength <= 1, `strength ${e.strength}`);
  assert.ok(SOURCES.includes(e.source), `source ${e.source}`);
}

// Spec §8: onsets within ±25 ms, ≥ 90 % of the notes found with the correct pitch class, ≤ 5 % spurious events.
function assertQuality(label, { r, events }, { minFound = 0.9, minExact = 0.9 } = {}) {
  for (const e of events) assertEventShape(e);
  const ctx = `${label}: missed ${fmtNotes(r.missed)} | spurious ${fmtEvents(r.spuriousList)}`;
  assert.ok(r.found >= minFound * r.total, `found ${r.found}/${r.total} — ${ctx}`);
  assert.ok(r.spurious <= 0.05 * r.events, `spurious ${r.spurious}/${r.events} — ${ctx}`);
  assert.ok(r.maxErr <= ONSET_TOL, `max onset error ${(r.maxErr * 1000).toFixed(1)} ms — ${ctx}`);
  assert.ok(r.exact >= minExact * r.found, `exact octave ${r.exact}/${r.found} — ${ctx}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Construction & API

test('constructor requires a sample rate; initial analysis; empty pushes', () => {
  assert.throws(() => new NoteDetector({}), RangeError);
  assert.throws(() => new NoteDetector(), RangeError);
  assert.throws(() => new NoteDetector({ sampleRate: 0 }), RangeError);
  const det = new NoteDetector({ sampleRate: 48000 });
  assert.deepEqual(det.analysis, INITIAL_ANALYSIS);
  assert.deepEqual(det.push(new Float32Array(0), 0), []);
  assert.deepEqual(det.push(null, 0), []);
  assert.deepEqual(det.analysis, INITIAL_ANALYSIS);
});

test('hop (~10.7 ms) and FFT window scale with the sample rate', () => {
  for (const sr of [22050, 32000, 44100, 48000, 88200, 96000]) {
    const det = new NoteDetector({ sampleRate: sr });
    const hopMs = (1000 * det.hop) / sr;
    assert.ok(hopMs > 7 && hopMs < 15, `${sr}: hop ${det.hop} = ${hopMs.toFixed(1)} ms`);
    const fftMs = (1000 * det.fftSize) / sr;
    assert.ok(fftMs > 60 && fftMs < 120, `${sr}: fft ${det.fftSize} = ${fftMs.toFixed(1)} ms`);
    assert.equal(det.fftSize & (det.fftSize - 1), 0, 'power of two');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Note sequences (spec §8), at 48 kHz and 44.1 kHz

test('melody: every note found with the right pitch within ±25 ms', () => {
  for (const sampleRate of RATES) {
    assertQuality(`melody @${sampleRate}`, detect(seq(PHRASE), { sampleRate }), { minFound: 1 });
    const part = PHRASE.slice(0, 14);
    assertQuality(`staccato @${sampleRate}`, detect(seq(part, { ioi: 0.3, dur: 0.12 }), { sampleRate }));
    assertQuality(`low register @${sampleRate}`, detect(seq(part.map((m) => m - 12), { ioi: 0.35 }), { sampleRate }));
    assertQuality(`high register @${sampleRate}`, detect(seq(part.map((m) => m + 12), { ioi: 0.35 }), { sampleRate }));
  }
});

test('melody with uneven dynamics and timing (seeded)', () => {
  const rand = mulberry32(2024);
  const notes = [];
  let t = 0.3;
  let m = 62;
  for (let i = 0; i < 40; i++) {
    m = Math.max(50, Math.min(81, m + Math.round((rand() - 0.5) * 8)));
    const ioi = 0.18 + rand() * 0.35;
    notes.push({ t, m, d: ioi * (0.5 + rand() * 0.6), amp: 0.1 * Math.pow(10, ((rand() - 0.5) * 12) / 20) });
    t += ioi;
  }
  for (const sampleRate of RATES) assertQuality(`varied @${sampleRate}`, detect(notes, { sampleRate }));
});

test('repeated notes 250 ms apart (detached, held to the next strike, overlapping)', () => {
  const pitches = [];
  for (const m of [67, 60, 72, 55]) for (let i = 0; i < 5; i++) pitches.push(m);
  for (const sampleRate of RATES) {
    for (const dur of [0.15, 0.25, 0.3]) {
      const res = detect(seq(pitches, { ioi: 0.25, dur }), { sampleRate });
      assertQuality(`repeated d=${dur} @${sampleRate}`, res);
    }
  }
});

test('2-note chords (dyads): both notes found', () => {
  const dyads = [[60, 64], [62, 65], [64, 67], [65, 69], [67, 71], [60, 67], [57, 60], [55, 59], [64, 69], [62, 69],
    [53, 57], [59, 62]];
  const notes = [];
  dyads.forEach((pair, i) => pair.forEach((m, k) => notes.push({ t: 0.3 + i * 0.55, m, d: 0.4, amp: k ? 0.09 : 0.1 })));
  for (const sampleRate of RATES) assertQuality(`dyads @${sampleRate}`, detect(notes, { sampleRate }));
});

test('melody over a held accompaniment (bass note / open fifth)', () => {
  const melody = seq([64, 67, 72, 71, 69, 67, 65, 64, 62, 60, 62, 64], { t0: 0.6, ioi: 0.36, dur: 0.3 });
  const bass = [{ t: 0.3, m: 48, d: 2.4, amp: 0.07 }, { t: 2.7, m: 43, d: 2.4, amp: 0.07 }];
  const fifth = [{ t: 0.3, m: 48, d: 4.6, amp: 0.06 }, { t: 0.3, m: 55, d: 4.6, amp: 0.05 }];
  for (const sampleRate of RATES) {
    for (const [label, acc] of [['bass', bass], ['fifth', fifth]]) {
      const notes = byTime([...acc, ...melody]);
      assertQuality(`over ${label} @${sampleRate}`, detect(notes, { sampleRate, render: { tau1: 2 } }));
    }
  }
});

test('legato: each note starts while the previous one still sounds', () => {
  for (const sampleRate of RATES) {
    assertQuality(`legato @${sampleRate}`, detect(seq(PHRASE, { ioi: 0.3, dur: 0.33 }), { sampleRate }));
    assertQuality(`legato, long release @${sampleRate}`,
      detect(seq(PHRASE.slice(4), { ioi: 0.3, dur: 0.36 }), { sampleRate, render: { tau1: 2, release: 0.15 } }));
  }
});

test('octave leaps over a ringing note keep their octave (new note vs. re-strike)', () => {
  // A note one or two octaves above a ringing one only feeds its even partials, and the mixture's period is the lower
  // note's; one an octave below feeds all its partials. Neither may be taken for a re-strike of the ringing note.
  const pairs = [[[60, 64], 72], [[57], 69], [[57], 81], [[72], 60], [[67, 71], 55], [[62], 74], [[65], 77]];
  const pianoLike = (buf, sampleRate, m, start) => addPianoTone(buf, sampleRate, {
    start, freq: hz(m), dur: 1.2, amp: 0.12, tau1: 1.6,
  });
  // Equal decay of all partials (like oscillator-based synths, e.g. the simulation input).
  const envelopeDb = (t) => (t < 0.005 ? 20 * Math.log10(Math.max(1e-4, 200 * t)) - 18.4 : -18.4 - (8.686 * t) / 0.8);
  const equalDecay = (buf, sampleRate, m, start) => addEnvelopedTone(buf, sampleRate, {
    start, seconds: 1.2, freq: hz(m), envelopeDb,
  });
  const runs = [[48000, pianoLike], [48000, equalDecay], [44100, pianoLike]];
  for (const [sampleRate, tone] of runs) {
    for (const [ringing, next] of pairs) {
      const buf = new Float32Array(Math.round(1.5 * sampleRate));
      for (const m of ringing) tone(buf, sampleRate, m, 0.3);
      const t1 = 0.65 + 0.25 / hz(Math.min(...ringing, next));
      tone(buf, sampleRate, next, t1);
      addNoise(buf, -70, next);
      const events = runDetector(new NoteDetector({ sampleRate }), buf, sampleRate);
      const label = `${ringing} → ${next} (${tone === pianoLike ? 'piano' : 'equal'}) @${sampleRate}: ${fmtEvents(events)}`;
      const atNext = events.filter((e) => Math.abs(e.time - t1) <= ONSET_TOL);
      assert.deepEqual(atNext.map((e) => e.midi), [next], label);
      assert.equal(events.length, ringing.length + 1, label);
    }
  }
});

test('slow crossfade between pitches → one pitch-change event for the new pitch', () => {
  // Tone A sounds from 0.3 s; from 1.2 s it fades out (−40 dB) while tone B, present 40 dB down, fades in over the
  // same time. There is no attack, so the change has to come from the pitch tracker. Fourths (64→69, 57→62) share a
  // sub-harmonic that YIN briefly locks onto during the mix.
  const fade = 0.8;
  const fadeStart = 1.2;
  for (const sampleRate of RATES) {
    for (const [a, b] of [[60, 64], [67, 65], [64, 69], [57, 62]]) {
      const buf = new Float32Array(Math.round(2.6 * sampleRate));
      const attack = (t) => (t < 0.005 ? -20 + 20 * Math.log10(Math.max(1e-3, t / 0.005)) : -20);
      const fadeA = ramp([[0.9, -20], [0.9 + fade, -60]]);
      addEnvelopedTone(buf, sampleRate, {
        start: 0.3, seconds: 2.3, freq: hz(a), phase: 1, envelopeDb: (t) => Math.min(attack(t), fadeA(t)),
      });
      addEnvelopedTone(buf, sampleRate, {
        start: 0.3, seconds: 2.3, freq: hz(b), phase: 2, envelopeDb: ramp([[0.9, -60], [0.9 + fade, -20]]),
      });
      addNoise(buf, -60, 5);
      const det = new NoteDetector({ sampleRate });
      const events = runDetector(det, buf, sampleRate);
      const label = `${a}→${b} @${sampleRate}: ${fmtEvents(events)}`;
      for (const e of events) assertEventShape(e);
      assert.equal(events.length, 2, label);
      assert.equal(events[0].midi, a, label);
      assert.equal(events[0].source, 'onset', label);
      assert.ok(Math.abs(events[0].time - 0.3) <= ONSET_TOL, label);
      assert.equal(events[1].midi, b, label);
      assert.equal(events[1].source, 'pitch-change', label);
      assert.ok(events[1].time >= fadeStart && events[1].time <= fadeStart + fade, label);
    }
  }
});

test('faster swell: the new pitch is reported once (no duplicate onset)', () => {
  for (const sampleRate of RATES) {
    for (const [a, b] of [[60, 64], [67, 65], [57, 62]]) {
      const buf = new Float32Array(Math.round(2.6 * sampleRate));
      addEnvelopedTone(buf, sampleRate, {
        start: 0.3, seconds: 2.2, freq: hz(a), phase: 1,
        envelopeDb: ramp([[0, -60], [0.005, -20], [0.9, -20], [1.3, -60]]),
      });
      addEnvelopedTone(buf, sampleRate, {
        start: 0.3, seconds: 2.2, freq: hz(b), phase: 2, envelopeDb: ramp([[0.9, -60], [1.3, -20]]),
      });
      addNoise(buf, -60, 6);
      const events = runDetector(new NoteDetector({ sampleRate }), buf, sampleRate);
      const label = `${a}→${b} @${sampleRate}: ${fmtEvents(events)}`;
      assert.deepEqual(events.map((e) => e.midi), [a, b], label);
      assert.ok(events[1].time >= 1.2 && events[1].time <= 1.6, label);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Non-musical input

test('silence and steady noise produce no events at any sensitivity', () => {
  const sampleRate = 48000;
  for (const sensitivity of [0, 0.6, 1]) {
    const silent = new NoteDetector({ sampleRate, sensitivity });
    assert.deepEqual(runDetector(silent, new Float32Array(sampleRate * 2), sampleRate), []);
    assert.equal(silent.analysis.gateOpen, false);
    assert.equal(silent.analysis.pitch, null);
    assert.equal(silent.analysis.db, -120);
    for (const db of [-90, -60, -45, -30, -15]) {
      const det = new NoteDetector({ sampleRate, sensitivity });
      const events = runDetector(det, addNoise(new Float32Array(sampleRate * 2), db, 9 + db), sampleRate);
      assert.deepEqual(events, [], `noise ${db} dBFS, sensitivity ${sensitivity}: ${fmtEvents(events)}`);
    }
  }
});

test('knocks, noise bursts and clicks produce no events at any sensitivity', () => {
  for (const sampleRate of RATES) {
    for (let seed = 1; seed <= 3; seed++) {
      const rand = mulberry32(seed);
      const buf = new Float32Array(sampleRate * 3);
      for (let k = 0; k < 4; k++) {
        const amp = 0.02 + rand() * 0.4;
        const decay = 0.005 + rand() * 0.08;
        const s0 = Math.round((0.3 + k * 0.6) * sampleRate);
        for (let i = 0; i < 0.4 * sampleRate && s0 + i < buf.length; i++) {
          buf[s0 + i] += (rand() * 2 - 1) * amp * Math.exp(-i / (decay * sampleRate));
        }
      }
      for (let k = 0; k < 4; k++) {
        const s0 = Math.round((0.6 + k * 0.6) * sampleRate);
        buf[s0] += 0.8;
        buf[s0 + 1] -= 0.5;
      }
      addNoise(buf, -60, seed);
      for (const sensitivity of [0, 0.6, 1]) {
        const events = runDetector(new NoteDetector({ sampleRate, sensitivity }), buf, sampleRate);
        assert.deepEqual(events, [], `seed ${seed} @${sampleRate} sensitivity ${sensitivity}: ${fmtEvents(events)}`);
      }
    }
  }
});

test('garbage samples (NaN, ±Infinity, huge values) are tolerated', () => {
  const sampleRate = 48000;
  const notes = seq([60, 64, 67], { ioi: 0.5 });
  const buf = renderNotes(notes, { sampleRate });
  for (let i = 1000; i < buf.length; i += 7919) buf[i] = [NaN, Infinity, -Infinity, 1e9][i % 4];
  const det = new NoteDetector({ sampleRate });
  const events = runDetector(det, buf, sampleRate);
  for (const e of events) assertEventShape(e);
  const r = evaluate(events, notes, { tol: ONSET_TOL });
  assert.equal(r.found, 3, fmtEvents(events));
  const a = det.analysis;
  assert.ok(Number.isFinite(a.db) && Number.isFinite(a.time));
});

// ---------------------------------------------------------------------------------------------------------------
// Sensitivity & tuning

test('very quiet notes: found only with enough sensitivity', () => {
  const sampleRate = 48000;
  const notes = seq([60, 62, 64, 65, 67, 69, 67, 65, 64, 62], { ioi: 0.4, dur: 0.3 });
  const render = { noiseDb: -80 };
  // amp 0.004 peaks near −49 dBFS, amp 0.001 near −61 dBFS.
  const quiet = { ...render, amp: 0.004 };
  const veryQuiet = { ...render, amp: 0.001 };
  assert.equal(detect(notes, { sampleRate, sensitivity: 0, render: quiet }).events.length, 0);
  assertQuality('quiet @0.6', detect(notes, { sampleRate, sensitivity: 0.6, render: quiet }));
  assert.equal(detect(notes, { sampleRate, sensitivity: 0.6, render: veryQuiet }).events.length, 0);
  assertQuality('very quiet @1', detect(notes, { sampleRate, sensitivity: 1, render: veryQuiet }));
});

test('sensitivity is monotonic: higher sensitivity never finds fewer notes', () => {
  const sampleRate = 48000;
  // Loud to very quiet: about −21 dBFS down to −61 dBFS peak (the max-sensitivity gate is −65 dBFS).
  const pitches = [60, 64, 67, 72, 71, 67, 65, 62, 64, 67, 69, 65, 62, 59];
  const notes = pitches.map((m, i) => ({
    t: 0.3 + i * 0.35, m, d: 0.3, amp: 0.1 * Math.pow(0.01, i / (pitches.length - 1)),
  }));
  const buf = renderNotes(notes, { sampleRate, noiseDb: -80 });
  let prev = -1;
  const found = [];
  for (const sensitivity of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const events = runDetector(new NoteDetector({ sampleRate, sensitivity }), buf, sampleRate);
    const r = evaluate(events, notes, { tol: ONSET_TOL });
    assert.ok(r.spurious <= 0.05 * r.events, `sensitivity ${sensitivity}: spurious ${fmtEvents(r.spuriousList)}`);
    assert.ok(r.found >= prev, `sensitivity ${sensitivity}: found ${r.found} < ${prev}`);
    prev = r.found;
    found.push(r.found);
  }
  assert.ok(found[0] < found[found.length - 1], `sensitivity must matter: ${found}`);
  assert.ok(found[found.length - 1] >= 0.9 * notes.length, `max sensitivity finds ${found.at(-1)}/${notes.length}`);
});

test('setSensitivity clamps and behaves like the constructor option', () => {
  const sampleRate = 48000;
  const notes = seq([60, 64, 67, 72], { amp: 0.002 });
  const buf = renderNotes(notes, { sampleRate, noiseDb: -80 });
  const run = (det) => runDetector(det, buf, sampleRate).map((e) => `${e.midi}@${e.time}`);
  const hi = run(new NoteDetector({ sampleRate, sensitivity: 1 }));
  const lo = run(new NoteDetector({ sampleRate, sensitivity: 0 }));
  assert.equal(hi.length, 4);
  assert.equal(lo.length, 0);
  const det = new NoteDetector({ sampleRate, sensitivity: 0 });
  det.setSensitivity(7);
  assert.deepEqual(run(det), hi);
  det.reset();
  det.setSensitivity(-3);
  assert.deepEqual(run(det), lo);
  det.reset();
  det.setSensitivity('x'); // invalid → default 0.6 (same as a fresh detector)
  assert.deepEqual(run(det), run(new NoteDetector({ sampleRate })));
});

test('a4 tuning: detector follows setA4 / the a4 option', () => {
  const sampleRate = 48000;
  const notes = seq([60, 62, 64, 67, 69, 72]);
  // Rendered with A4 = 415 Hz (about a semitone flat of 440).
  const buf = renderNotes(notes, { sampleRate, a4: 415 });
  const tuned = runDetector(new NoteDetector({ sampleRate, a4: 415 }), buf, sampleRate);
  assert.deepEqual(tuned.map((e) => e.midi), notes.map((n) => n.m));
  const det = new NoteDetector({ sampleRate });
  const at440 = runDetector(det, buf, sampleRate);
  assert.deepEqual(at440.map((e) => e.midi), notes.map((n) => n.m - 1));
  det.reset();
  det.setA4(415);
  assert.deepEqual(runDetector(det, buf, sampleRate).map((e) => e.midi), notes.map((n) => n.m));
  det.setA4(5000); // out of range → 440
  assert.equal(det.a4, 440);
  det.setA4(432);
  assert.equal(det.a4, 432);
});

// ---------------------------------------------------------------------------------------------------------------
// Streaming behaviour

test('chunk-size independence: random chunk sizes give identical events and analysis', () => {
  const notes = byTime([
    ...seq([60, 64, 67, 72, 67, 64], { ioi: 0.3, dur: 0.28 }),
    { t: 2.2, m: 55, d: 0.5 }, { t: 2.2, m: 59, d: 0.5 },
    ...seq([62, 62, 62, 65], { t0: 2.9, ioi: 0.25, dur: 0.25 }),
  ]);
  for (const sampleRate of RATES) {
    const buf = renderNotes(notes, { sampleRate });
    const ref = new NoteDetector({ sampleRate });
    const expected = runDetector(ref, buf, sampleRate, { chunk: 1024, t0: 10 });
    assert.ok(expected.length >= notes.length - 1);
    for (const seed of [1, 2]) {
      const det = new NoteDetector({ sampleRate });
      const got = runDetectorChunked(det, buf, sampleRate, { seed, t0: 10 });
      assert.equal(got.length, expected.length, `seed ${seed}: ${fmtEvents(got)} vs ${fmtEvents(expected)}`);
      got.forEach((e, i) => {
        const x = expected[i];
        assert.equal(e.midi, x.midi);
        assert.equal(e.source, x.source);
        assert.ok(Math.abs(e.time - x.time) < 1e-9, `time ${e.time} vs ${x.time}`);
        assert.ok(Math.abs(e.strength - x.strength) < 1e-9);
        assert.ok(Math.abs(e.freq - x.freq) < 1e-6);
      });
      assert.ok(Math.abs(det.analysis.time - ref.analysis.time) < 1e-9);
      assert.equal(det.analysis.db, ref.analysis.db);
    }
  }
});

test('timestamps: absolute start times, implicit continuation, plain arrays', () => {
  const sampleRate = 48000;
  const notes = seq([60, 67, 64], { ioi: 0.5 });
  const buf = renderNotes(notes, { sampleRate });
  const base = runDetector(new NoteDetector({ sampleRate }), buf, sampleRate, { t0: 0 });
  assert.equal(base.length, 3);
  // Offset time base (e.g. AudioContext time when the mic started).
  const shifted = runDetector(new NoteDetector({ sampleRate }), buf, sampleRate, { t0: 123.25 });
  shifted.forEach((e, i) => assert.ok(Math.abs(e.time - 123.25 - base[i].time) < 1e-6));
  // Without startTime the detector continues from the end of the previous push.
  const det = new NoteDetector({ sampleRate });
  const cont = [];
  for (let i = 0; i < buf.length; i += 1000) {
    const part = buf.subarray(i, i + 1000);
    for (const e of i === 0 ? det.push(part, 0) : det.push(part)) cont.push(e);
  }
  assert.equal(cont.length, base.length);
  cont.forEach((e, i) => assert.ok(Math.abs(e.time - base[i].time) < 1e-6));
  // Plain arrays are accepted.
  const det2 = new NoteDetector({ sampleRate });
  const arr = [];
  for (let i = 0; i < buf.length; i += 2048) {
    for (const e of det2.push(Array.from(buf.subarray(i, i + 2048)), i / sampleRate)) arr.push(e);
  }
  assert.deepEqual(arr.map((e) => e.midi), base.map((e) => e.midi));
});

test('events are causal and reported promptly (≤ 150 ms after the onset)', () => {
  const sampleRate = 48000;
  const notes = byTime([...seq(PHRASE, { ioi: 0.3, dur: 0.25 }), { t: 7, m: 60, d: 0.4 }, { t: 7, m: 64, d: 0.4 }]);
  const buf = renderNotes(notes, { sampleRate });
  const det = new NoteDetector({ sampleRate });
  const block = 128;
  let count = 0;
  for (let i = 0; i < buf.length; i += block) {
    const part = buf.subarray(i, i + block);
    const end = (i + part.length) / sampleRate;
    for (const e of det.push(part, i / sampleRate)) {
      count++;
      assert.ok(e.time <= end, `event at ${e.time} reported at ${end}`);
      const late = end - e.time;
      assert.ok(late <= 0.15, `event at ${e.time.toFixed(3)} reported ${(late * 1000).toFixed(0)} ms late`);
    }
  }
  assert.ok(count >= notes.length - 1);
});

test('reset() restores the initial state', () => {
  const sampleRate = 48000;
  const a = renderNotes(seq([72, 76, 79, 84], { ioi: 0.3, dur: 0.6 }), { sampleRate, tau1: 2 });
  const bNotes = seq([60, 62, 64], { ioi: 0.4 });
  const b = renderNotes(bNotes, { sampleRate });
  const fresh = runDetector(new NoteDetector({ sampleRate }), b, sampleRate);
  const det = new NoteDetector({ sampleRate });
  // Stop in the middle of a ringing note, then start over with a new time base.
  runDetector(det, a.subarray(0, Math.round(1.1 * sampleRate)), sampleRate, { t0: 50 });
  assert.equal(det.analysis.gateOpen, true);
  det.reset();
  assert.deepEqual(det.analysis, INITIAL_ANALYSIS);
  const again = runDetector(det, b, sampleRate);
  assert.deepEqual(again, fresh);
});

test('analysis snapshot: shape, live pitch and gate, onset flag', () => {
  for (const sampleRate of RATES) {
    const det = new NoteDetector({ sampleRate });
    const notes = [{ t: 0.3, m: 64, d: 0.8 }, { t: 1.6, m: 57, d: 0.3 }, { t: 1.6, m: 60, d: 0.3 }];
    const buf = renderNotes(notes, { sampleRate, duration: 3 });
    const snaps = [];
    let last = null;
    const block = 1024;
    for (let i = 0; i < buf.length; i += block) {
      det.push(buf.subarray(i, i + block), i / sampleRate);
      const a = det.analysis;
      if (a !== last) snaps.push({ end: (i + block) / sampleRate, a });
      last = a;
    }
    assert.ok(snaps.length > 50, `analysis updates: ${snaps.length}`);
    let prevTime = -Infinity;
    for (const { end, a } of snaps) {
      assert.deepEqual(Object.keys(a).sort(), ['db', 'gateOpen', 'onset', 'pitch', 'time', 'topNotes']);
      assert.ok(a.time >= prevTime && a.time <= end + 1e-9);
      prevTime = a.time;
      assert.ok(a.db >= -120 && a.db <= 0);
      assert.equal(typeof a.gateOpen, 'boolean');
      assert.equal(typeof a.onset, 'boolean');
      assert.ok(Array.isArray(a.topNotes) && a.topNotes.length <= 3);
      for (const m of a.topNotes) assert.ok(Number.isInteger(m));
      if (a.pitch !== null) {
        assert.deepEqual(Object.keys(a.pitch).sort(), ['clarity', 'freq', 'midi']);
        assert.ok(a.pitch.clarity >= 0 && a.pitch.clarity <= 1);
        assert.ok(Math.abs(hzToMidi(a.pitch.freq) - a.pitch.midi) < 1e-6);
      }
      if (!a.gateOpen) {
        assert.equal(a.pitch, null);
        assert.deepEqual(a.topNotes, []);
      }
    }
    const at = (t) => snaps.find((s) => s.a.time >= t).a;
    // Before the first note: closed gate.
    assert.equal(at(0.2).gateOpen, false);
    // While E4 rings: open gate, pitch ≈ 64, E4 among the top notes, onset flag only right after the strike.
    const mid = at(0.7);
    assert.equal(mid.gateOpen, true);
    assert.ok(mid.pitch && Math.abs(mid.pitch.midi - 64) < 0.3, JSON.stringify(mid.pitch));
    assert.ok(Math.abs(mid.pitch.freq - hz(64)) < 3);
    assert.equal(mid.topNotes[0], 64);
    assert.equal(mid.onset, false);
    const flagged = snaps.filter((s) => s.a.onset).map((s) => s.a.time);
    assert.ok(flagged.some((t) => t >= 0.3 && t <= 0.4), `onset flags ${flagged}`);
    assert.ok(flagged.some((t) => t >= 1.6 && t <= 1.7), `onset flags ${flagged}`);
    assert.ok(flagged.length <= 4, `onset flags ${flagged}`);
    // During the dyad both notes are listed.
    const dyad = at(1.75);
    assert.ok(dyad.topNotes.includes(57) && dyad.topNotes.includes(60), `topNotes ${dyad.topNotes}`);
    assert.ok(dyad.db > mid.db - 20);
    // After everything decayed: closed gate again.
    const end = snaps[snaps.length - 1].a;
    assert.equal(end.gateOpen, false);
    assert.equal(end.pitch, null);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Performance

test('performance: 1 s of busy 48 kHz audio is processed in < 400 ms', () => {
  const sampleRate = 48000;
  const notes = [];
  for (let i = 0; i < 8; i++) {
    const t = 0.02 + i * 0.12;
    notes.push({ t, m: 60 + ((i * 5) % 14), d: 0.2 }, { t, m: 48 + ((i * 3) % 7), d: 0.4, amp: 0.07 });
  }
  const buf = renderNotes(notes, { sampleRate, duration: 1, tau1: 2 });
  assert.equal(buf.length, sampleRate);
  const det = new NoteDetector({ sampleRate });
  const t0 = performance.now();
  runDetector(det, buf, sampleRate);
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `took ${ms.toFixed(0)} ms`);
});
