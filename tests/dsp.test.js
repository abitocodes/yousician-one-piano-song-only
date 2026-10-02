import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hann, fft, magnitudeSpectrum, rms, toDb, yin, salienceVector, cancelHarmonics, clearHarmonics, midiToHz, hzToMidi,
  SAL_LO, SAL_HI,
} from '../js/audio/dsp.js';
import { mulberry32, sine, addNoise, addPianoTone, hz } from './helpers-signal.js';

function naiveDft(re, im) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function pianoNote(m, sampleRate, { seconds = 0.4, a4 = 440, amp = 0.2, noiseDb = -60, seed = 3 } = {}) {
  const buf = new Float32Array(Math.round(seconds * sampleRate));
  addPianoTone(buf, sampleRate, { start: 0, freq: hz(m, a4), dur: seconds, amp });
  addNoise(buf, noiseDb, seed);
  return buf;
}

test('hann: periodic window, cached', () => {
  const w = hann(8);
  assert.equal(w.length, 8);
  assert.equal(w[0], 0);
  assert.ok(Math.abs(w[4] - 1) < 1e-7);
  for (let i = 1; i < 8; i++) assert.ok(Math.abs(w[i] - w[8 - i]) < 1e-7);
  assert.equal(hann(8), w);
  assert.notEqual(hann(16), w);
});

test('fft matches a naive DFT', () => {
  const rand = mulberry32(42);
  for (const n of [1, 2, 4, 8, 64, 512]) {
    const re = new Float64Array(n).map(() => rand() * 2 - 1);
    const im = new Float64Array(n).map(() => rand() * 2 - 1);
    const ref = naiveDft(re, im);
    const r2 = Float64Array.from(re);
    const i2 = Float64Array.from(im);
    fft(r2, i2);
    let err = 0;
    for (let k = 0; k < n; k++) err = Math.max(err, Math.abs(r2[k] - ref.re[k]), Math.abs(i2[k] - ref.im[k]));
    assert.ok(err < 1e-9 * Math.max(1, n), `n=${n} err=${err}`);
  }
});

test('fft works on Float32Array and rejects bad sizes', () => {
  const re = new Float32Array([1, 0, 0, 0]);
  const im = new Float32Array(4);
  fft(re, im);
  assert.deepEqual(Array.from(re), [1, 1, 1, 1]);
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6)), RangeError);
  assert.throws(() => fft(new Float64Array(8), new Float64Array(4)), RangeError);
});

test('magnitudeSpectrum = |DFT| of the Hann-windowed last fftSize samples', () => {
  const rand = mulberry32(7);
  const samples = new Float32Array(300).map(() => rand() * 2 - 1);
  const n = 128;
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[samples.length - n + i] * w[i];
  const ref = naiveDft(re, im);
  const mag = magnitudeSpectrum(samples, n);
  assert.equal(mag.length, n / 2);
  for (let k = 0; k < n / 2; k++) {
    const expect = Math.hypot(ref.re[k], ref.im[k]);
    assert.ok(Math.abs(mag[k] - expect) < 1e-4 * Math.max(1, expect), `bin ${k}: ${mag[k]} vs ${expect}`);
  }
  // Shorter input is zero-padded at the front; output buffer is reused.
  const short = samples.subarray(0, 50);
  const out = new Float32Array(n / 2);
  const res = magnitudeSpectrum(short, n, out);
  assert.equal(res, out);
  re.fill(0);
  for (let i = 0; i < 50; i++) re[n - 50 + i] = short[i] * w[n - 50 + i];
  const ref2 = naiveDft(re, new Float64Array(n));
  for (let k = 0; k < n / 2; k++) assert.ok(Math.abs(out[k] - Math.hypot(ref2.re[k], ref2.im[k])) < 1e-4);
});

test('magnitudeSpectrum peaks at a sinusoid bin', () => {
  const sr = 48000;
  const n = 4096;
  const k0 = 100;
  const x = sine((k0 * sr) / n, 0.2, sr, 0.5);
  const mag = magnitudeSpectrum(x, n);
  let arg = 0;
  for (let k = 1; k < mag.length; k++) if (mag[k] > mag[arg]) arg = k;
  assert.equal(arg, k0);
  assert.ok(Math.abs(mag[k0] - (0.5 * n) / 4) / ((0.5 * n) / 4) < 0.01);
});

test('rms and toDb', () => {
  const x = sine(1000, 0.1, 48000, 1);
  assert.ok(Math.abs(rms(x) - Math.SQRT1_2) < 1e-3);
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(new Float32Array([3, 4]), 1, 2), 4);
  assert.equal(toDb(1), 0);
  assert.ok(Math.abs(toDb(0.1) + 20) < 1e-9);
  assert.equal(toDb(0), -120);
  assert.equal(toDb(-1), -120);
  assert.equal(toDb(1e-9), -120);
});

test('midiToHz / hzToMidi', () => {
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(60) - 261.6256) < 1e-3);
  assert.ok(Math.abs(hzToMidi(261.6256) - 60) < 1e-4);
  assert.ok(Math.abs(hzToMidi(432, 432) - 69) < 1e-9);
  assert.ok(Number.isNaN(hzToMidi(0)));
});

test('yin: sines C3..C6 within ±0.3 semitone (48 kHz and 44.1 kHz)', () => {
  for (const sr of [48000, 44100]) {
    for (let m = 48; m <= 84; m++) {
      const x = sine(hz(m), 0.06, sr, 0.3, 0.7);
      const r = yin(x, sr);
      assert.ok(r, `no pitch for ${m} @${sr}`);
      const est = hzToMidi(r.freq);
      assert.ok(Math.abs(est - m) <= 0.3, `${m} @${sr}: got ${est.toFixed(3)}`);
      assert.ok(r.clarity > 0.9, `clarity ${r.clarity} for ${m}`);
    }
  }
});

test('yin: piano-like harmonic tones C3..C6 within ±0.3 semitone', () => {
  const sr = 48000;
  for (let m = 48; m <= 84; m++) {
    const x = pianoNote(m, sr, { seconds: 0.15, seed: m });
    const r = yin(x, sr, { minFreq: 60, maxFreq: 2200 });
    assert.ok(r, `no pitch for ${m}`);
    const est = hzToMidi(r.freq);
    assert.ok(Math.abs(est - m) <= 0.3, `${m}: got ${est.toFixed(3)}`);
    assert.ok(r.clarity >= 0.85, `clarity ${r.clarity.toFixed(2)} for ${m}`);
  }
});

test('yin: silence → null, noise → low clarity, short input handled', () => {
  assert.equal(yin(new Float32Array(2048), 48000), null);
  const noise = addNoise(new Float32Array(2048), -20, 11);
  const r = yin(noise, 48000);
  assert.ok(r === null || r.clarity < 0.6, `noise clarity ${r && r.clarity}`);
  assert.equal(yin(new Float32Array(8), 48000), null);
  const shortTone = sine(440, 0.012, 48000, 0.5); // 576 samples: lag range shrinks
  const rs = yin(shortTone, 48000);
  assert.ok(rs && Math.abs(hzToMidi(rs.freq) - 69) < 0.3);
});

test('yin is fast (O(W·T0) with early exit)', () => {
  const sr = 48000;
  const x = pianoNote(48, sr, { seconds: 0.05 });
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) yin(x, sr, { minFreq: 60, maxFreq: 2200 });
  const per = (performance.now() - t0) / 200;
  assert.ok(per < 5, `yin took ${per.toFixed(2)} ms per call`);
});

test('salienceVector: argmax pitch class always, exact midi ≥ 90% for piano-like tones C3..C6', () => {
  for (const sr of [48000, 44100]) {
    const n = 4096;
    let pcOk = 0;
    let exact = 0;
    let total = 0;
    for (let m = 48; m <= 84; m++) {
      const x = pianoNote(m, sr, { seconds: 0.12, seed: 100 + m });
      const mag = magnitudeSpectrum(x, n);
      const sal = salienceVector(mag, sr, n);
      assert.equal(sal.length, SAL_HI - SAL_LO + 1);
      let arg = 0;
      for (let i = 1; i < sal.length; i++) if (sal[i] > sal[arg]) arg = i;
      const est = arg + SAL_LO;
      total++;
      if ((est - m) % 12 === 0) pcOk++;
      if (est === m) exact++;
    }
    assert.equal(pcOk, total, `pitch class @${sr}`);
    assert.ok(exact / total >= 0.9, `exact ${exact}/${total} @${sr}`);
  }
});

test('salienceVector: sub-octave ghost attenuated, custom range and out buffer', () => {
  const sr = 48000;
  const n = 4096;
  const x = pianoNote(60, sr, { seconds: 0.12 });
  const mag = magnitudeSpectrum(x, n);
  const sal = salienceVector(mag, sr, n);
  assert.ok(sal[48 - SAL_LO] < 0.35 * sal[60 - SAL_LO], 'C3 ghost of C4');
  const out = new Float32Array(13);
  const part = salienceVector(mag, sr, n, { lo: 55, hi: 67, out });
  assert.equal(part, out);
  assert.ok(Math.abs(part[60 - 55] - sal[60 - SAL_LO]) < 1e-3);
});

test('salienceVector: both notes of a dyad are local maxima; respects a4', () => {
  const sr = 48000;
  const n = 4096;
  const buf = new Float32Array(Math.round(0.12 * sr));
  addPianoTone(buf, sr, { start: 0, freq: hz(60), dur: 0.12, amp: 0.2 });
  addPianoTone(buf, sr, { start: 0, freq: hz(64), dur: 0.12, amp: 0.2, phase: 1 });
  const sal = salienceVector(magnitudeSpectrum(buf, n), sr, n);
  for (const m of [60, 64]) {
    const i = m - SAL_LO;
    assert.ok(sal[i] >= sal[i - 1] && sal[i] >= sal[i + 1], `${m} is a local max`);
  }
  const x432 = pianoNote(69, sr, { seconds: 0.12, a4: 432 });
  const sal432 = salienceVector(magnitudeSpectrum(x432, n), sr, n, { a4: 432 });
  let arg = 0;
  for (let i = 1; i < sal432.length; i++) if (sal432[i] > sal432[arg]) arg = i;
  assert.equal(arg + SAL_LO, 69);
});

test('cancelHarmonics / clearHarmonics remove one note and keep the other', () => {
  const sr = 48000;
  const n = 4096;
  const buf = new Float32Array(Math.round(0.12 * sr));
  addPianoTone(buf, sr, { start: 0, freq: hz(60), dur: 0.12, amp: 0.2 });
  addPianoTone(buf, sr, { start: 0, freq: hz(67), dur: 0.12, amp: 0.15, phase: 2 });
  const mag = magnitudeSpectrum(buf, n);
  const before = salienceVector(mag, sr, n);
  const work = Float32Array.from(mag);
  const removed = cancelHarmonics(work, 60, sr, n);
  assert.ok(removed > 0);
  const after = salienceVector(work, sr, n);
  assert.ok(after[60 - SAL_LO] < 0.25 * before[60 - SAL_LO], 'C4 removed');
  assert.ok(after[67 - SAL_LO] > 0.5 * before[67 - SAL_LO], 'G4 kept');
  const cleared = clearHarmonics(Float32Array.from(mag), 67, sr, n);
  const salC = salienceVector(cleared, sr, n);
  assert.ok(salC[67 - SAL_LO] < 0.2 * before[67 - SAL_LO]);
});
