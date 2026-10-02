import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi, extractMelody, midiTracksSummary } from '../js/core/midi.js';

// ---------------------------------------------------------------- SMF builders

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u16 = (n) => [(n >> 8) & 255, n & 255];
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function vlq(n) {
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
}
const header = (format, ntrks, division) => [...ascii('MThd'), ...u32(6), ...u16(format), ...u16(ntrks), ...u16(division)];
// events: [deltaTicks, ...rawBytes]
function track(events) {
  const body = [];
  for (const [delta, ...bytes] of events) body.push(...vlq(delta), ...bytes);
  return [...ascii('MTrk'), ...u32(body.length), ...body];
}
const smf = (format, division, tracks) => Uint8Array.from([...header(format, tracks.length, division), ...tracks.flat()]);
function tempo(bpm) {
  const us = Math.round(60e6 / bpm);
  return [0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255];
}
const timeSig = (num, den) => [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8];
const EOT = [0xff, 0x2f, 0x00];
function trackName(s) {
  const b = [...new TextEncoder().encode(s)];
  return [0xff, 0x03, ...vlq(b.length), ...b];
}

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const strip = (notes) => notes.map(({ t, d, m }) => ({ t, d, m }));

// ---------------------------------------------------------------- tests

test('vlq helper sanity', () => {
  assert.deepEqual(vlq(0), [0]);
  assert.deepEqual(vlq(127), [0x7f]);
  assert.deepEqual(vlq(128), [0x81, 0x00]);
  assert.deepEqual(vlq(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
});

test('format 1: tempo map across tracks, running status, vel-0 off, sysex, meta', () => {
  const conductor = track([
    [0, ...trackName('Conductor')],
    [0, ...tempo(120)],
    [0, ...timeSig(3, 4)],
    [1920, ...tempo(60)], // 4 beats at 120 → 2 s
    [0, ...EOT],
  ]);
  const melody = track([
    [0, ...trackName('멜로디')],
    [0, 0xc0, 5], // program 5
    [0, 0x90, 60, 100], // C4 on
    [480, 60, 0], // running status, vel 0 = off
    [0, 64, 80], // running status E4 on
    [0, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7], // sysex
    [0, 0xff, 0x01, 0x02, 0x68, 0x69], // text meta
    [480, 0x80, 64, 64], // E4 off
    [960, 0x90, 67, 127], // G4 on at tick 1920 = 2 s
    [0, 0xb0, 7, 100], // CC
    [0, 0xe0, 0, 64], // pitch bend
    [480, 0x90, 67, 0], // 480 ticks at 60 BPM = 1 s
    [0, ...EOT],
  ]);
  const drums = track([
    [0, 0x99, 36, 90],
    [240, 0x89, 36, 0],
    [0, ...EOT],
  ]);
  const parsed = parseMidi(smf(1, 480, [conductor, melody, drums]));
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ticksPerBeat, 480);
  assert.equal(parsed.bpm, 120);
  assert.deepEqual(parsed.timeSignature, { num: 3, den: 4 });
  assert.equal(parsed.tracks.length, 2); // note-less conductor track omitted
  const [mel, dr] = parsed.tracks;
  assert.equal(mel.index, 0);
  assert.equal(mel.sourceIndex, 1);
  assert.equal(mel.name, '멜로디');
  assert.equal(mel.channel, 1);
  assert.equal(mel.program, 5);
  assert.equal(mel.isDrum, false);
  assert.deepEqual(strip(mel.notes), [
    { t: 0, d: 0.5, m: 60 },
    { t: 0.5, d: 0.5, m: 64 },
    { t: 2, d: 1, m: 67 },
  ]);
  close(mel.notes[0].v, 100 / 127, 0.001);
  assert.equal(mel.notes[2].v, 1);
  assert.equal(dr.index, 1);
  assert.equal(dr.channel, 10);
  assert.equal(dr.isDrum, true);
  assert.equal(dr.name, '트랙 3');
  assert.deepEqual(strip(dr.notes), [{ t: 0, d: 0.25, m: 36 }]);
  assert.equal(parsed.duration, 3);

  assert.deepEqual(midiTracksSummary(parsed), [
    { index: 0, name: '멜로디', count: 3, min: 60, max: 67, channel: 1, isDrum: false },
    { index: 1, name: '트랙 3', count: 1, min: 36, max: 36, channel: 10, isDrum: true },
  ]);
});

test('defaults: 120 BPM and 4/4 without tempo/time signature events', () => {
  const parsed = parseMidi(smf(1, 96, [track([[0, 0x90, 72, 64], [96, 0x80, 72, 0], [0, ...EOT]])]));
  assert.equal(parsed.bpm, 120);
  assert.deepEqual(parsed.timeSignature, { num: 4, den: 4 });
  assert.deepEqual(strip(parsed.tracks[0].notes), [{ t: 0, d: 0.5, m: 72 }]);
});

test('overlapping same-pitch notes pair FIFO; unreleased notes end at track end', () => {
  const tr = track([
    [0, 0x90, 60, 100], // A on @0
    [240, 0x90, 60, 100], // B on @240
    [240, 0x80, 60, 0], // off @480 → A
    [240, 0x80, 60, 0], // off @720 → B
    [0, 0x90, 62, 100], // never released
    [0, 0x80, 65, 0], // stray off: ignored
    [240, ...EOT], // @960
  ]);
  const parsed = parseMidi(smf(1, 480, [track([[0, ...tempo(120)], [0, ...EOT]]), tr]));
  assert.deepEqual(strip(parsed.tracks[0].notes), [
    { t: 0, d: 0.5, m: 60 },
    { t: 0.25, d: 0.5, m: 60 },
    { t: 0.75, d: 0.25, m: 62 },
  ]);
});

test('tempo changes mid-note and in a later track still apply globally', () => {
  const notes = track([[0, 0x90, 60, 100], [960, 0x80, 60, 0], [0, 0x90, 62, 100], [480, 0x80, 62, 0], [0, ...EOT]]);
  const tempos = track([[0, ...tempo(120)], [480, ...tempo(240)], [0, ...EOT]]);
  const parsed = parseMidi(smf(1, 480, [notes, tempos]));
  // 0..480 @120 = 0.5 s, 480..960 @240 = 0.25 s → C4 lasts 0.75 s; D4 0.75..1.0
  assert.deepEqual(strip(parsed.tracks[0].notes), [
    { t: 0, d: 0.75, m: 60 },
    { t: 0.75, d: 0.25, m: 62 },
  ]);
  assert.equal(parsed.bpm, 120);
});

test('format 0 with several channels is split into per-channel pseudo-tracks', () => {
  const tr = track([
    [0, ...trackName('All')],
    [0, 0xc1, 40],
    [0, 0x90, 72, 100],
    [0, 0x91, 48, 100],
    [0, 0x99, 42, 100],
    [480, 0x80, 72, 0],
    [0, 0x81, 48, 0],
    [0, 0x89, 42, 0],
    [0, 0x90, 74, 100],
    [480, 74, 0],
    [0, ...EOT],
  ]);
  const parsed = parseMidi(smf(0, 480, [tr]));
  assert.equal(parsed.format, 0);
  assert.deepEqual(parsed.tracks.map((t) => [t.index, t.name, t.channel, t.isDrum, t.notes.length]), [
    [0, 'Channel 1', 1, false, 2],
    [1, 'Channel 2', 2, false, 1],
    [2, 'Channel 10', 10, true, 1],
  ]);
  assert.equal(parsed.tracks[1].program, 40);
  assert.deepEqual(strip(parsed.tracks[0].notes), [{ t: 0, d: 0.5, m: 72 }, { t: 0.5, d: 0.5, m: 74 }]);
});

test('format 0 single channel keeps one track with its name', () => {
  const parsed = parseMidi(smf(0, 480, [track([[0, ...trackName('Solo')], [0, 0x92, 60, 1], [480, 0x82, 60, 0], [0, ...EOT]])]));
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.tracks[0].name, 'Solo');
  assert.equal(parsed.tracks[0].channel, 3);
  close(parsed.tracks[0].notes[0].v, 1 / 127, 0.001);
});

test('format 2 tracks use their own tempo', () => {
  const a = track([[0, ...tempo(60)], [0, 0x90, 60, 100], [480, 0x80, 60, 0], [0, ...EOT]]);
  const b = track([[0, 0x90, 62, 100], [480, 0x80, 62, 0], [0, ...EOT]]);
  const parsed = parseMidi(smf(2, 480, [a, b]));
  assert.equal(parsed.tracks[0].notes[0].d, 1);
  assert.equal(parsed.tracks[1].notes[0].d, 0.5);
  assert.equal(parsed.bpm, 60);
});

test('zero-length notes get a minimum duration; unknown chunks skipped', () => {
  const junk = [...ascii('XFIH'), ...u32(3), 1, 2, 3];
  const tr = track([[0, 0x90, 60, 100], [0, 0x80, 60, 0], [0, ...EOT]]);
  const parsed = parseMidi(Uint8Array.from([...header(1, 1, 480), ...junk, ...tr]));
  assert.deepEqual(strip(parsed.tracks[0].notes), [{ t: 0, d: 0.05, m: 60 }]);
});

test('accepts ArrayBuffer and offset views; truncated tracks keep parsed notes', () => {
  const bytes = smf(1, 480, [track([[0, 0x90, 60, 100], [480, 0x80, 60, 0], [0, 0x90, 64, 100], [480, 0x80, 64, 0], [0, ...EOT]])]);
  assert.equal(parseMidi(bytes.buffer.slice(0)).tracks[0].notes.length, 2);
  const padded = new Uint8Array(bytes.length + 7);
  padded.set(bytes, 7);
  assert.equal(parseMidi(padded.subarray(7)).tracks[0].notes.length, 2);
  assert.equal(parseMidi(new DataView(padded.buffer, 7)).tracks[0].notes.length, 2);
  const truncated = bytes.slice(0, bytes.length - 8); // cut inside the second note
  const p = parseMidi(truncated);
  assert.ok(p.tracks[0].notes.length >= 1);
  assert.deepEqual(strip(p.tracks[0].notes).slice(0, 1), [{ t: 0, d: 0.5, m: 60 }]);
});

test('RIFF RMID wrapper is unwrapped', () => {
  const inner = smf(0, 480, [track([[0, 0x90, 60, 100], [480, 0x80, 60, 0], [0, ...EOT]])]);
  const data = [...ascii('data'), ...u32(inner.length).reverse(), ...inner];
  const riff = Uint8Array.from([...ascii('RIFF'), ...u32(4 + data.length).reverse(), ...ascii('RMID'), ...data]);
  assert.equal(parseMidi(riff).tracks[0].notes.length, 1);
});

test('SMPTE division throws', () => {
  const bytes = smf(1, 0xe728, [track([[0, ...EOT]])]);
  assert.throws(() => parseMidi(bytes), { message: '지원하지 않는 MIDI 시간 형식이에요.' });
});

test('bad header throws', () => {
  const msg = { message: 'MIDI 파일이 아니에요.' };
  assert.throws(() => parseMidi(new Uint8Array(0)), msg);
  assert.throws(() => parseMidi(Uint8Array.from(ascii('MThd'))), msg);
  assert.throws(() => parseMidi(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVEfmt '), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), msg);
  assert.throws(() => parseMidi(new TextEncoder().encode('hello world, not a midi file')), msg);
  assert.throws(() => parseMidi(Uint8Array.from([...ascii('MThd'), ...u32(2), 0, 1])), msg);
  assert.throws(() => parseMidi(Uint8Array.from(header(1, 0, 0))), msg);
  assert.throws(() => parseMidi('MThd'), msg);
  assert.throws(() => parseMidi(null), msg);
});

test('empty file with no notes', () => {
  const parsed = parseMidi(smf(1, 480, [track([[0, ...tempo(100)], [960, ...EOT]])]));
  assert.deepEqual(parsed.tracks, []);
  assert.equal(parsed.bpm, 100);
  close(parsed.duration, 1.2, 0.001);
  assert.deepEqual(midiTracksSummary(parsed), []);
  assert.deepEqual(midiTracksSummary(null), []);
});

test('extractMelody: skyline then monophonic', () => {
  const notes = [
    { t: 0, d: 1, m: 60 },
    { t: 0.01, d: 1, m: 67 },
    { t: 0.02, d: 0.4, m: 64 },
    { t: 0.5, d: 0.6, m: 65 },
    { t: 0.52, d: 0.6, m: 72 },
    { t: 1.5, d: 0.5, m: 62 },
    { t: 1.52, d: 0.2, m: 50 },
    { t: 1.53, d: 0.3, m: 70, v: 0.5 },
  ];
  const mel = extractMelody(notes);
  assert.deepEqual(mel, [
    { t: 0.01, d: 0.51, m: 67 },
    { t: 0.52, d: 0.6, m: 72 },
    { t: 1.53, d: 0.3, m: 70, v: 0.5 },
  ]);
  assert.equal(notes[1].d, 1); // input untouched
});

test('extractMelody: minimum truncated duration 0.05 s, unsorted input, custom eps', () => {
  const mel = extractMelody([{ t: 0.04, d: 1, m: 60 }, { t: 0, d: 1, m: 62 }]);
  assert.deepEqual(mel, [{ t: 0, d: 0.05, m: 62 }, { t: 0.04, d: 1, m: 60 }]);
  const wide = extractMelody([{ t: 0.04, d: 1, m: 60 }, { t: 0, d: 1, m: 62 }], { eps: 0.05 });
  assert.deepEqual(wide, [{ t: 0, d: 1, m: 62 }]);
  assert.deepEqual(extractMelody([]), []);
});
