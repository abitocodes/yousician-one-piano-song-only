import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importScreen } from './helpers-screen-stubs.js';
import { normalizeSong, isPlayable } from '../js/core/song.js';

const cal = await importScreen('../js/screens/calibrate.js');

test('makeCalibrationSong: 12 x C4, 1 s apart from t = 2, no lyrics', () => {
  const song = cal.makeCalibrationSong();
  assert.equal(song.title, '타이밍 보정');
  assert.equal(song.notes.length, 12);
  song.notes.forEach((n, i) => {
    assert.equal(n.m, 60);
    assert.equal(n.t, 2 + i);
    assert.ok(n.d > 0 && n.d < 1);
  });
  assert.equal(song.lyrics.text, '');
  assert.deepEqual(song.lyrics.lines, []);
  assert.equal(song.audio, null);

  const norm = normalizeSong(song);
  assert.equal(norm.notes.length, 12);
  assert.equal(norm.title, '타이밍 보정');
  assert.ok(isPlayable(norm));
  // fresh object every call (play screen may mutate it)
  assert.notEqual(cal.makeCalibrationSong(), song);
  assert.notEqual(cal.makeCalibrationSong().notes, song.notes);
});

test('median / quantile', () => {
  assert.equal(cal.median([3, 1, 2]), 2);
  assert.equal(cal.median([4, 1, 3, 2]), 2.5);
  assert.equal(cal.median([1, NaN, 3]), 2);
  assert.ok(Number.isNaN(cal.median([])));
  assert.equal(cal.quantile([0, 10], 0.25), 2.5);
});

test('analyzeCalibration: latency = median of raw deltas', () => {
  const r = cal.analyzeCalibration({ deltas: [0.1, 0.12, 0.11, 0.13, 0.5], total: 12 });
  assert.equal(r.ok, true);
  assert.equal(r.n, 5);
  assert.equal(r.total, 12);
  assert.equal(r.latency, 0.12);
  assert.ok(Math.abs(r.median - 0.12) < 1e-9);
  assert.equal(r.clamped, false);
  assert.ok(r.spread > 0 && r.spread < 0.05);
  assert.equal(r.unstable, false);
});

test('analyzeCalibration: needs at least 4 hits', () => {
  const r = cal.analyzeCalibration({ deltas: [0.1, 0.2, 0.15], total: 12 });
  assert.equal(r.ok, false);
  assert.equal(r.n, 3);
  assert.equal(r.minHits, 4);
  assert.equal(cal.analyzeCalibration(null).ok, false);
  assert.equal(cal.analyzeCalibration({}).n, 0);
  assert.equal(cal.analyzeCalibration({ deltas: [0.1, NaN, 0.1, Infinity, 0.1] }).n, 3);
});

test('analyzeCalibration: clamps to the latency setting range and flags spread', () => {
  const high = cal.analyzeCalibration({ deltas: [0.7, 0.72, 0.69, 0.71] });
  assert.equal(high.ok, true);
  assert.equal(high.latency, 0.5);
  assert.equal(high.clamped, true);

  const low = cal.analyzeCalibration({ deltas: [-0.3, -0.25, -0.28, -0.3] });
  assert.equal(low.latency, -0.1);
  assert.equal(low.clamped, true);

  const messy = cal.analyzeCalibration({ deltas: [0.0, 0.3, 0.05, 0.25, 0.1, 0.2] });
  assert.equal(messy.unstable, true);
});

test('estimateGateDb follows the detector gate formula', () => {
  assert.equal(cal.estimateGateDb(0.6, -90), -55);
  assert.equal(cal.estimateGateDb(0, NaN), -40);
  assert.equal(cal.estimateGateDb(1, undefined), -65);
  assert.equal(cal.estimateGateDb(0.6, -50), -42);
  assert.equal(cal.estimateGateDb(5, -200), -65); // sensitivity clamped to 1
});

test('estimateGateDb: noise-floor margin depends on sensitivity like the detector (11 − 5·s dB)', () => {
  // detector.js: gate = max(−40 − 25·s, floor + (11 − 5·s))
  const detectorGate = (s, floor) => Math.max(-40 - 25 * s, floor + (11 - 5 * s));
  for (const s of [0, 0.25, 0.6, 1]) {
    for (const floor of [-100, -70, -55, -45, -30]) {
      assert.ok(Math.abs(cal.estimateGateDb(s, floor) - detectorGate(s, floor)) < 1e-9, `s=${s} floor=${floor}`);
    }
  }
  assert.equal(cal.estimateGateDb(0, -50), -39); // margin 11 dB at the lowest sensitivity
  assert.equal(cal.estimateGateDb(1, -50), -44); // margin 6 dB at the highest sensitivity
});

test('latency slider / ±10 range matches the auto-measure range (−100..500 ms)', () => {
  assert.deepEqual({ ...cal.LATENCY_RANGE_MS }, { min: -100, max: 500 });
  const measured = cal.analyzeCalibration({ deltas: [0.45, 0.45, 0.45, 0.45] });
  assert.equal(measured.latency, 0.45);
  assert.ok(measured.latency * 1000 <= cal.LATENCY_RANGE_MS.max);
  // '+10' after a measured 450 ms raises it instead of snapping down to the old 400 ms cap
  assert.equal(cal.nudgeLatency(0.45, 10), 0.46);
  assert.equal(cal.nudgeLatency(0.495, 10), 0.5);
  assert.equal(cal.nudgeLatency(0.5, 10), 0.5);
  assert.equal(cal.nudgeLatency(0.45, -10), 0.44);
  assert.equal(cal.nudgeLatency(-0.095, -10), -0.1);
  assert.equal(cal.nudgeLatency(NaN, 10), 0.01);
  assert.equal(cal.nudgeLatency(0.1004, 0), 0.1); // rounded to 1 ms
});

test('micErrorMessage gives Korean guidance per error code', () => {
  for (const code of ['insecure', 'denied', 'unsupported', 'error']) {
    const m = cal.micErrorMessage({ code, message: 'Device busy' });
    assert.ok(m.title && m.message, code);
    assert.match(m.title + m.message, /[가-힣]/);
  }
  assert.match(cal.micErrorMessage({ code: 'insecure' }).message, /https/);
  assert.match(cal.micErrorMessage({ code: 'denied' }).message, /허용/);
  assert.match(cal.micErrorMessage({ code: 'error', message: 'Device busy' }).message, /Device busy/);
  assert.ok(cal.micErrorMessage(null).title);
});

test('screen module exports mount/unmount', () => {
  assert.equal(typeof cal.mount, 'function');
  assert.equal(typeof cal.unmount, 'function');
  cal.unmount(); // safe without a mounted screen
});
