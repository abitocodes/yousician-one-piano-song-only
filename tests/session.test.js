// GameSession in Node: the Web Audio engine, synth and backing track are replaced by recording stubs
// (module resolution hook), and the test drives the audio clock frame by frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Emitter } from '../js/core/emitter.js';

const env = {
  ctx: null,
  synths: [],
  backings: [],
};
globalThis.__sessionTestEnv = env;

const STUBS = {
  '/js/audio/engine.js': `
    const env = () => globalThis.__sessionTestEnv;
    export const getAudioContext = () => env().ctx;
    export const unlockAudio = async () => env().ctx;
    export const audioNow = () => env().ctx.currentTime;
    export const masterOut = () => null;
    export const setMasterVolume = () => {};
  `,
  '/js/audio/synth.js': `
    const env = () => globalThis.__sessionTestEnv;
    const handle = (when, dur) => ({ end: when + dur, stopped: false, stop() { this.stopped = true; } });
    export class Synth {
      constructor(ctx) {
        this.ctx = ctx;
        this.output = { name: 'synth-out' };
        this.notes = [];
        this.clicks = [];
        this.sfxs = [];
        env().synths.push(this);
      }
      setA4() {}
      setVolume() {}
      playNote(midi, when, duration, opts = {}) {
        const h = handle(when, duration);
        this.notes.push({ midi, when, duration, opts, at: this.ctx.currentTime, h });
        return h;
      }
      click(when, accent) {
        const h = handle(when, 0.05);
        this.clicks.push({ when, accent, at: this.ctx.currentTime, h });
        return h;
      }
      sfx(name, when) { this.sfxs.push({ name, when, at: this.ctx.currentTime }); }
      stopAll() {}
      dispose() {}
    }
  `,
  '/js/audio/backing.js': `
    const env = () => globalThis.__sessionTestEnv;
    export class BackingTrack {
      constructor() {
        this.calls = [];
        this._loaded = false;
        env().backings.push(this);
      }
      get loaded() { return this._loaded; }
      async load() { this._loaded = true; }
      play(songTime, speed, offset) { this.calls.push({ op: 'play', songTime, speed, offset, at: env().ctx.currentTime }); }
      pause() { this.calls.push({ op: 'pause', at: env().ctx.currentTime }); }
      sync() {}
      seek() {}
      setRate() {}
      setVolume() {}
      dispose() {}
    }
  `,
};

const hooks = `
const STUBS = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  if (context.parentURL && (specifier.startsWith('.') || specifier.startsWith('/'))) {
    let url;
    try { url = new URL(specifier, context.parentURL); } catch { url = null; }
    if (url && url.protocol === 'file:') {
      for (const [suffix, src] of Object.entries(STUBS)) {
        if (url.pathname.endsWith(suffix)) {
          return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
        }
      }
    }
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
const { GameSession } = await import('../js/game/session.js');

const FPS = 60;
const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b}`);

function freshCtx(extra = {}) {
  env.synths.length = 0;
  env.backings.length = 0;
  env.ctx = {
    currentTime: 0,
    state: 'running',
    resume() { this.state = 'running'; return Promise.resolve(); },
    ...extra,
  };
  return env.ctx;
}

class FakeInput extends Emitter {
  constructor(mode = 'mic') {
    super();
    this.mode = mode;
    this.analysis = null;
    this.simInput = mode === 'sim' ? { name: 'sim-in' } : null;
  }
}

// Drives a session: frames every 1/60 s plus input events delivered at their own context times.
class Driver {
  constructor(session, input = null) {
    this.s = session;
    this.input = input;
    this.frame = 0;
    this.events = [];   // { at, fn }
    this.snap = null;
  }

  at(time, fn) {
    this.events.push({ at: time, fn });
    this.events.sort((a, b) => a.at - b.at);
  }

  // A mic detection: struck at `strike` (ctx s), heard by the mic `latency` later, reported `delay` after that.
  strike(strike, midi, { latency = 0.12, delay = 0.075 } = {}) {
    this.at(strike + latency + delay, () => this.input.emit('note', { time: strike + latency, midi }));
  }

  runTo(t) {
    const ctx = env.ctx;
    for (;;) {
      const nextFrame = (this.frame + 1) / FPS;
      const ev = this.events[0];
      if (ev && ev.at <= nextFrame && ev.at <= t) {
        this.events.shift();
        ctx.currentTime = Math.max(ctx.currentTime, ev.at);
        ev.fn();
        continue;
      }
      if (nextFrame > t + 1e-9) break;
      this.frame++;
      ctx.currentTime = nextFrame;
      this.snap = this.s.tick();
    }
    return this.snap;
  }
}

const N = (t, m, d = 0.3) => ({ t, d, m });

// ------------------------------------------------------------------ practice holds (mic)

test('practice + mic: on-time strikes grade PERFECT and the song loses no time at the holds', () => {
  freshCtx();
  const notes = [];
  for (let i = 0; i < 12; i++) notes.push(N(1 + i * 0.5, 60 + (i % 5)));
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', bpm: 120, notes },
    settings: { inputMode: 'mic', latency: 0.12, difficulty: 'normal' },
    mode: 'practice',
    input,
  });
  s.start();
  assert.equal(s.startSongTime, -2.5);
  const d = new Driver(s, input);
  // The song should never stall: note i reaches the line at ctx t + 2.5 every time.
  for (const n of notes) d.strike(n.t + 2.5, n.m);
  let holds = 0;
  s.on('state', (st) => { if (st === 'holding') holds++; });
  d.runTo(notes[notes.length - 1].t + 2.5 + 0.5);
  const st = s.stats;
  assert.equal(holds, 12, 'each note is still held until its detection arrives');
  assert.deepEqual(st.counts, { perfect: 12, great: 0, good: 0, miss: 0 });
  assert.equal(st.accuracy, 1);
  assert.equal(st.deltas.length, 12);
  for (const x of st.deltas) close(x, 0, 1e-9);
  // Song time is exactly where it would be without any hold.
  close(s.clock.time(env.ctx.currentTime), env.ctx.currentTime - 2.5, 1e-9);
  // The flash of a held hit starts when the detection is processed (not 0.2 s in the past).
  close(s.judge.judgedAt[0], notes[0].t + 0.195, 1e-6);
  s.destroy();
});

test('practice + mic: early/late strikes are graded by timing; very late ones keep the fixed good', () => {
  freshCtx();
  const notes = [N(1, 60), N(2, 62), N(3, 64), N(4, 65)];
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', notes },
    settings: { inputMode: 'mic', latency: 0.12, difficulty: 'normal' },
    mode: 'practice',
    input,
  });
  s.start();
  const d = new Driver(s, input);
  // Crossings with no lost time: t + 2.5. Strike 1: 100 ms early (detected during the hold) → great,
  // song continues as if never held. Strike 2: 50 ms late → perfect, the song waited 50 ms.
  // Strike 3: 1 s late → fixed good (untimed), the song waited 1 s. Strike 4: on time.
  d.strike(3.5 - 0.1, 60);
  d.strike(4.5 + 0.05, 62);
  d.strike(5.55 + 1.0, 64);
  d.strike(7.55, 65);
  const grades = [];
  s.on('judge', (r) => grades.push([r.index, r.grade]));
  d.runTo(8.5);
  assert.deepEqual(grades, [[0, 'great'], [1, 'perfect'], [2, 'good'], [3, 'perfect']]);
  const st = s.stats;
  assert.equal(st.deltas.length, 3, 'the untimed held hit is not a timing measurement');
  close(st.deltas[0], -0.1, 1e-9);
  close(st.deltas[1], 0.05, 1e-9);
  close(st.deltas[2], 0, 1e-9);
  // Total time the song waited = 0.05 + 1.0 (the player was late), nothing for detection delay.
  close(s.clock.time(env.ctx.currentTime), env.ctx.currentTime - 2.5 - 1.05, 1e-9);
  s.destroy();
});

test('practice + backing: the backing restarts at the caught-up song time, not at the hold point', async () => {
  freshCtx();
  const notes = [N(1, 60), N(2, 62)];
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', notes, audio: { name: 'a', offset: 0, volume: 1 } },
    settings: { inputMode: 'mic', latency: 0.12 },
    mode: 'practice',
    input,
    audioBlob: { size: 1 },
  });
  await s.prepare();
  assert.equal(env.backings.length, 1);
  const bt = env.backings[0];
  s.start();
  const d = new Driver(s, input);
  d.strike(3.5, 60);
  d.runTo(3.6);
  assert.equal(s.state, 'holding');
  assert.equal(bt.calls[bt.calls.length - 1].op, 'pause');
  d.runTo(3.8);
  assert.equal(s.state, 'playing');
  const play = bt.calls[bt.calls.length - 1];
  assert.equal(play.op, 'play');
  close(play.at, 3.695, 1e-9);
  close(play.songTime, 1 + 0.195, 1e-6);
  s.destroy();
});

test('practice + touch: held taps keep the fixed good and resume from the tap', () => {
  freshCtx();
  const notes = [N(1, 60), N(2, 62)];
  const s = new GameSession({
    song: { title: 't', notes },
    settings: { inputMode: 'touch' },
    mode: 'practice',
  });
  s.start();
  const d = new Driver(s);
  d.at(3.6, () => { s.touchDown(60); s.touchUp(60); });
  d.runTo(3.7);
  assert.equal(s.judge.stateOf(0), 'good');
  assert.deepEqual(s.stats.deltas, []);
  // Held from the first frame at/after 3.5 until the tap at 3.6.
  close(s.clock.time(3.7), 1.1, 1e-9);
  s.destroy();
});

// ------------------------------------------------------------------ duplicate notes

test('same-time same-pitch duplicates are merged into one hittable note (copy, longest duration)', () => {
  freshCtx();
  const notes = [
    { t: 2, d: 0.5, m: 74 },
    { t: 1, d: 0.3, m: 60 },
    { t: 1, d: 0.6, m: 60 },
    { t: 1, d: 0.4, m: 64 },
    { t: 1.02, d: 0.2, m: 60.2 },
    { t: 2, d: 0.5, m: 62 },
  ];
  const song = { title: 't', notes };
  const before = JSON.stringify(notes);
  const s = new GameSession({ song, settings: { inputMode: 'touch' }, mode: 'play' });
  assert.equal(JSON.stringify(notes), before, 'song notes are not mutated or reordered');
  assert.deepEqual(s.notes.map((n) => [n.t, n.m, n.d]), [[1, 60, 0.6], [1, 64, 0.4], [2, 62, 0.5], [2, 74, 0.5]]);
  assert.equal(s.judge.notes, s.notes);
  assert.equal(s.judge.states.length, 4);
  assert.equal(s.duration, 2.5);

  let finished = null;
  s.on('finish', (st) => { finished = st; });
  s.start();
  const first = s.tick();
  assert.equal(first.notes, s.notes, 'the snapshot carries the deduped notes');
  assert.equal(first.states.length, s.notes.length);
  const d = new Driver(s);
  d.at(3.5, () => { s.touchDown(60); s.touchDown(64); s.touchUp(60); s.touchUp(64); });
  d.at(4.5, () => { s.touchDown(62); s.touchDown(74); s.touchUp(62); s.touchUp(74); });
  const snap = d.runTo(7);
  assert.ok(finished, 'the session finishes');
  assert.deepEqual(finished.counts, { perfect: 4, great: 0, good: 0, miss: 0 });
  assert.equal(finished.score, 1000000);
  assert.equal(finished.rank, 'S');
  assert.equal(snap.progress, 1);
  s.destroy();
});

test('a sorted chart without duplicates keeps its note objects', () => {
  freshCtx();
  const notes = [N(1, 60), N(1, 64), N(1.5, 60)];
  const s = new GameSession({ song: { title: 't', notes }, settings: { inputMode: 'touch' } });
  assert.equal(s.notes.length, 3);
  s.notes.forEach((n, i) => assert.equal(n, notes[i]));
  s.destroy();
});

test('a single mic detection hits a doubled melody note', () => {
  freshCtx();
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', notes: [N(1, 60), N(1, 60), N(2, 62)] },
    settings: { inputMode: 'mic', latency: 0.12 },
    mode: 'play',
    input,
  });
  s.start();
  const d = new Driver(s, input);
  d.strike(3.5, 60);
  d.strike(4.5, 62);
  d.runTo(7);
  assert.deepEqual(s.stats.counts, { perfect: 2, great: 0, good: 0, miss: 0 });
  s.destroy();
});

test('octave-doubled chart: one mic detection per onset hits both octaves', () => {
  freshCtx();
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', notes: [N(1, 60), N(1, 72), N(2, 62), N(2, 74)] },
    settings: { inputMode: 'mic', latency: 0.12 },
    mode: 'play',
    input,
  });
  s.start();
  const d = new Driver(s, input);
  // The detector reports at most one note per pitch class per onset.
  d.strike(3.5, 60);
  d.strike(4.5, 74);
  d.runTo(7);
  assert.deepEqual(s.stats.counts, { perfect: 4, great: 0, good: 0, miss: 0 });
  assert.equal(s.stats.score, 1000000);
  assert.equal(s.stats.deltas.length, 2, 'one timing sample per strike');
  s.destroy();
});

test('octave-doubled chart: a touch key still hits only its own note', () => {
  freshCtx();
  const s = new GameSession({
    song: { title: 't', notes: [N(1, 60), N(1, 72)] },
    settings: { inputMode: 'touch' },
    mode: 'play',
  });
  s.start();
  const d = new Driver(s);
  d.at(3.5, () => { s.touchDown(60); s.touchUp(60); });
  d.runTo(5);
  assert.deepEqual(s.stats.counts, { perfect: 1, great: 0, good: 0, miss: 1 });
  s.destroy();
});

test('practice + mic: one detection releases an octave-doubled hold', () => {
  freshCtx();
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', notes: [N(1, 60), N(1, 72), N(2, 64)] },
    settings: { inputMode: 'mic', latency: 0.12 },
    mode: 'practice',
    input,
  });
  s.start();
  const d = new Driver(s, input);
  d.strike(3.5, 72);
  d.runTo(3.8);
  assert.equal(s.state, 'playing');
  assert.equal(s.judge.stateOf(0), 'perfect');
  assert.equal(s.judge.stateOf(1), 'perfect');
  s.destroy();
});

// ------------------------------------------------------------------ late player on repeated pitches

test('mic set 0.1 s but really 0.23 s late: repeated-pitch pairs are all hit, no strays', () => {
  freshCtx();
  // 32 notes in same-pitch pairs, 8ths 0.25 s apart (original pattern).
  const notes = [];
  for (let k = 0; k < 16; k++) {
    const m = 60 + ((k * 5) % 12);
    notes.push(N(1 + k * 0.5, m, 0.2), N(1.25 + k * 0.5, m, 0.2));
  }
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', bpm: 120, notes },
    settings: { inputMode: 'mic', latency: 0.1, difficulty: 'normal' },
    mode: 'play',
    input,
  });
  s.start();
  const lead = -s.startSongTime;
  const d = new Driver(s, input);
  // Every key is struck exactly when its note reaches the line; the mic hears it 0.23 s later.
  for (const n of notes) d.strike(n.t + lead, n.m, { latency: 0.23 });
  let finished = null;
  s.on('finish', (st) => { finished = st; });
  d.runTo(notes[notes.length - 1].t + lead + 2);
  assert.ok(finished);
  assert.deepEqual(finished.counts, { perfect: 0, great: 32, good: 0, miss: 0 });
  assert.equal(finished.stray, 0);
  for (const x of finished.deltas) close(x, 0.13, 1e-6);
  s.destroy();
});

// ------------------------------------------------------------------ calibration

test('calibrate: screen/keyboard taps are not judged; mic detections are', () => {
  freshCtx();
  const input = new FakeInput('mic');
  const notes = [];
  for (let i = 0; i < 4; i++) notes.push({ t: 2 + i, d: 0.5, m: 60, v: 0.8 });
  const s = new GameSession({
    song: { title: 'cal', notes },
    settings: { inputMode: 'mic', latency: 0.3 },
    mode: 'calibrate',
    input,
  });
  s.start();
  const d = new Driver(s, input);
  const cross = 2 - s.startSongTime;
  d.at(cross, () => { s.touchDown(60); s.touchUp(60); });
  d.runTo(cross + 0.1);
  assert.equal(s.judge.stateOf(0), 'pending', 'tap ignored');
  assert.equal(s.stats.judged, 0);
  assert.equal(s.stats.stray, 0);
  // A mic detection 150 ms after the crossing (calibration ignores the latency setting).
  d.at(cross + 0.2, () => input.emit('note', { time: cross + 0.15, midi: 60 }));
  d.runTo(cross + 0.3);
  assert.equal(s.judge.stateOf(0), 'perfect');
  assert.equal(s.stats.deltas.length, 1);
  close(s.stats.deltas[0], 0.15, 1e-9);
  s.destroy();
});

// ------------------------------------------------------------------ output latency

function scheduledTimes(ctxExtra, settings, { mode = 'play', input = null } = {}) {
  freshCtx(ctxExtra);
  const notes = [N(1, 60), N(1.5, 62), N(2, 64)];
  const s = new GameSession({
    song: { title: 't', bpm: 120, offset: 0, beatsPerBar: 4, notes },
    settings,
    mode,
    input,
  });
  s.start();
  const lead = -s.startSongTime;   // song time 0 is at ctx `lead`
  new Driver(s, input).runTo(5);
  const synth = env.synths[0];
  s.destroy();
  return { synth, lead, notes };
}

test('guide melody, metronome and count-in are started early by the device output latency', () => {
  const { synth, lead, notes } = scheduledTimes(
    { baseLatency: 0.02, outputLatency: 0.18 },
    { inputMode: 'touch', guideMelody: true, metronome: true },
  );
  const out = 0.2;
  assert.equal(synth.notes.length, notes.length);
  synth.notes.forEach((x, i) => {
    close(x.when, notes[i].t + lead - out, 1e-9, `note ${i}`);
    assert.ok(x.when >= x.at + 0.2, 'scheduled far enough ahead to start early');
  });
  // The beat on the start time itself (song -2.5 = ctx 0) cannot start 0.2 s early: it plays at once.
  const [startBeat, ...clicks] = synth.clicks;
  close(startBeat.when, startBeat.at, 1e-9, 'start beat plays immediately');
  close(startBeat.at, 1 / FPS, 1e-9, 'scheduled on the first frame');
  // Then beats every 0.5 song s up to the end of the run, each exactly once.
  assert.ok(clicks.length > 6);
  const beatTimes = clicks.map((c) => c.when + out - lead);
  close(beatTimes[0], -2, 1e-9, 'next beat');
  beatTimes.forEach((t, i) => {
    close(t, Math.round(t * 2) / 2, 1e-9, `beat ${i} on the grid`);
    if (i) close(t - beatTimes[i - 1], 0.5, 1e-9, `beat ${i} spacing`);
  });
  const counts = synth.sfxs.filter((x) => x.name === 'count');
  assert.equal(counts.length, 3);
  counts.forEach((x, i) => close(x.when, (1 - (3 - i)) + lead - out, 1e-9, `count ${i}`));
});

test('output latency is clamped to 0..0.5 s and missing values mean no compensation', () => {
  const cases = [
    [{}, 0],
    [{ baseLatency: NaN, outputLatency: undefined }, 0],
    [{ baseLatency: -0.3, outputLatency: 0.1 }, 0],
    [{ baseLatency: 0.01, outputLatency: 2 }, 0.5],
  ];
  for (const [extra, out] of cases) {
    const { synth, lead, notes } = scheduledTimes(extra, { inputMode: 'touch', guideMelody: true });
    assert.equal(synth.notes.length, notes.length);
    synth.notes.forEach((x, i) => close(x.when, notes[i].t + lead - out, 1e-9, `${JSON.stringify(extra)} note ${i}`));
  }
});

test('resume just before a crossing: its guide note and beat play at once instead of being dropped', (t) => {
  let perf = 0;
  t.mock.method(performance, 'now', () => perf);
  freshCtx({ baseLatency: 0.02, outputLatency: 0.23 });
  const notes = [N(1, 60), N(1.5, 62), N(2, 64)];
  const s = new GameSession({
    song: { title: 't', bpm: 120, offset: 0, beatsPerBar: 4, notes },
    settings: { inputMode: 'touch', guideMelody: true, metronome: true },
    mode: 'play',
  });
  s.start();
  const lead = -s.startSongTime;
  const d = new Driver(s);
  // Note 62 (and the beat at song 1.5) reach the line at ctx lead + 1.5; pause 0.1 s before that.
  d.runTo(lead + 1.4);
  s.pause();
  const synth = env.synths[0];
  const pausedAt = env.ctx.currentTime;
  s.resume();
  d.runTo(lead + 2);                // still counting down (perf time has not moved)
  assert.equal(s.state, 'resuming');
  perf += 2000;
  d.runTo(lead + 4);
  assert.equal(s.state, 'finished');
  const resumedAt = lead + 2 + 1 / FPS;
  const after = synth.notes.filter((x) => x.at > pausedAt);
  assert.deepEqual(after.map((x) => x.midi), [62, 64]);
  // 62 now crosses 0.1 s after the resume: started right away (heard 0.15 s late, not silent).
  close(after[0].when, resumedAt, 1e-6, '62 starts now');
  // 64 is far enough ahead to keep its full output-latency lead.
  close(after[1].when, resumedAt + 0.6 - 0.25, 1e-6, '64 early by the output latency');
  const clicks = synth.clicks.filter((c) => c.at > pausedAt);
  close(clicks[0].when, resumedAt, 1e-6, 'beat at song 1.5 starts now');
  close(clicks[1].when, resumedAt + 0.6 - 0.25, 1e-6, 'beat at song 2.0 keeps its lead');
  // Long past moments are still dropped.
  assert.ok(synth.notes.filter((x) => x.midi === 60 && x.at > pausedAt).length === 0);
  s.destroy();
});

// ------------------------------------------------------------------ two-hand accompaniment + sung melody

// Original made-up material: C / F / G chords with bass notes and a placeholder melody line.
const H = (t, m, h, d = 0.3) => ({ t, d, m, h });
const ACC = [
  H(1, 36, 'L'), H(1, 48, 'L'), H(1, 60, 'R'), H(1, 64, 'R'), H(1, 67, 'R'),
  H(1.5, 33, 'L'),
  H(2, 41, 'L'), H(2, 65, 'R'), H(2, 69, 'R'),
  H(3, 43, 'L'), H(3, 67, 'R'), H(3, 71, 'R'),
];
const VOCAL = [N(1, 72, 0.4), N(1.5, 74, 0.4), N(2, 76, 0.8), N(3, 79, 0.8)];
const accSong = (extra = {}) => ({ title: 't', bpm: 120, notes: ACC, vocal: VOCAL, arrangement: 'accompaniment', ...extra });

test('accompaniment: chords are judged per group, low notes are display-only, snapshot carries the vocal', () => {
  freshCtx();
  const song = accSong();
  const s = new GameSession({ song, settings: { inputMode: 'touch' }, mode: 'play' });
  assert.equal(s.judge.groupMode, true);
  assert.equal(s.judge.floor, 41);
  assert.equal(s.stats.total, 3, 'three chords; the lone low A1 is no group');
  assert.equal(s.vocal, VOCAL, 'the song\'s own sorted vocal array');
  assert.equal(s.arrangement, 'accompaniment');
  let finished = null;
  s.on('finish', (st) => { finished = st; });
  const events = [];
  s.on('judge', (r) => events.push(r));
  s.start();
  const first = s.tick();
  assert.equal(first.vocal, VOCAL);
  assert.equal(first.arrangement, 'accompaniment');
  const lead = -s.startSongTime;
  const d = new Driver(s);
  // One key per chord: the right hand's top, then the left hand's bass F2 (= the floor), then a middle note.
  d.at(1 + lead, () => { s.touchDown(67); s.touchUp(67); });
  d.at(2 + lead, () => { s.touchDown(41); s.touchUp(41); });
  d.at(3 + lead, () => { s.touchDown(67); s.touchUp(67); });
  d.runTo(1 + lead + 0.05);
  assert.equal(s.judge.stateOf(0), 'auto', 'C2 below the floor');
  assert.equal(s.judge.stateOf(1), 'perfect', 'C3 is part of the chord');
  const snap = d.runTo(6 + lead);
  assert.ok(finished);
  assert.deepEqual(finished.counts, { perfect: 3, great: 0, good: 0, miss: 0 });
  assert.equal(finished.score, 1000000);
  assert.equal(finished.stray, 0);
  assert.equal(events.length, 3, 'one judge event per chord');
  assert.deepEqual(events[0].indices, [1, 2, 3, 4], 'the judgeable notes of the chord');
  assert.equal(snap.states[5], 'auto');
  close(s.duration, 3.8, 1e-9, 'duration includes the sung melody');
  s.destroy();

  freshCtx();
  const plain = new GameSession({ song: { title: 't', notes: [N(1, 60)] }, settings: { inputMode: 'touch' } });
  assert.equal(plain.judge.groupMode, false);
  const ps = plain.tick();
  assert.deepEqual(ps.vocal, []);
  assert.equal(ps.arrangement, 'melody');
  plain.destroy();
});

test('accompaniment: expected keys carry the hand (left-hand keys in their own set)', () => {
  freshCtx();
  const s = new GameSession({ song: accSong(), settings: { inputMode: 'touch' }, mode: 'play' });
  s.start();
  const lead = -s.startSongTime;
  const snap = new Driver(s).runTo(1 + lead - 0.05);
  assert.deepEqual([...snap.expectedKeys].sort((a, b) => a - b), [36, 48, 60, 64, 67]);
  assert.deepEqual([...snap.expectedLeft].sort((a, b) => a - b), [36, 48]);
  s.destroy();
});

test('accompaniment guide: play mode plays the sung melody, not the chords', () => {
  freshCtx();
  const s = new GameSession({ song: accSong(), settings: { inputMode: 'touch', guideMelody: true }, mode: 'play' });
  s.start();
  new Driver(s).runTo(8);
  const synth = env.synths[0];
  assert.deepEqual(synth.notes.map((x) => x.midi), VOCAL.map((n) => n.m));
  for (const x of synth.notes) {
    assert.equal(x.opts.velocity, 0.9);
    assert.equal(x.opts.destination, undefined);
  }
  s.destroy();

  // Without the guide setting nothing is played.
  freshCtx();
  const quiet = new GameSession({ song: accSong(), settings: { inputMode: 'touch' }, mode: 'play' });
  quiet.start();
  new Driver(quiet).runTo(8);
  assert.equal(env.synths[0].notes.length, 0);
  quiet.destroy();
});

test('accompaniment listen: plays the accompaniment softly and the sung melody on top', () => {
  freshCtx();
  const s = new GameSession({ song: accSong(), settings: { inputMode: 'touch' }, mode: 'listen' });
  s.start();
  const lead = -s.startSongTime;
  const snap = new Driver(s).runTo(8);
  const synth = env.synths[0];
  const acc = synth.notes.filter((x) => x.opts.velocity === 0.6);
  const voc = synth.notes.filter((x) => x.opts.velocity === 0.9);
  assert.equal(acc.length, ACC.length);
  assert.deepEqual(voc.map((x) => x.midi), VOCAL.map((n) => n.m));
  assert.equal(synth.notes.length, ACC.length + VOCAL.length);
  close(voc[2].when, 2 + lead, 1e-9, 'on the beat');
  assert.ok(snap.states.every((x) => x === 'auto'));
  s.destroy();
});

test('accompaniment practice: holds wait for the group, any note releases it, low notes never hold', () => {
  freshCtx();
  const s = new GameSession({ song: accSong(), settings: { inputMode: 'touch' }, mode: 'practice' });
  s.start();
  const lead = -s.startSongTime;
  const d = new Driver(s);
  let holds = 0;
  s.on('state', (st) => { if (st === 'holding') holds++; });
  let snap = d.runTo(1 + lead + 0.05);
  assert.equal(s.state, 'holding');
  assert.deepEqual(snap.holdingNotes, [48, 60, 64, 67], 'the judgeable notes of the group');
  d.at(1 + lead + 0.1, () => { s.touchDown(48); s.touchUp(48); });
  d.runTo(1 + lead + 0.15);
  assert.equal(s.state, 'playing', 'one note of the chord releases the hold');
  assert.deepEqual(s.judge.states.slice(0, 5), ['auto', 'good', 'good', 'good', 'good']);
  // The low A1 at 1.5 passes without a hold.
  snap = d.runTo(1 + lead + 0.1 + 0.6);
  assert.equal(s.state, 'playing');
  assert.equal(snap.states[5], 'auto');
  d.runTo(2 + lead + 0.2);
  assert.equal(s.state, 'holding');
  d.at(2 + lead + 0.3, () => { s.touchDown(69); s.touchUp(69); });
  d.runTo(3 + lead + 0.6);
  assert.equal(s.state, 'holding');
  d.at(3 + lead + 0.7, () => { s.touchDown(43); s.touchUp(43); });
  let finished = null;
  s.on('finish', (st) => { finished = st; });
  d.runTo(10);
  assert.equal(holds, 3);
  assert.ok(finished);
  assert.deepEqual(finished.counts, { perfect: 0, great: 0, good: 3, miss: 0 });
  s.destroy();
});

test('accompaniment practice + guide: the sung melody is scheduled (cut at holds), no chord hint', (t) => {
  let perf = 0;
  t.mock.method(performance, 'now', () => perf);
  freshCtx();
  const s = new GameSession({ song: accSong(), settings: { inputMode: 'touch', guideMelody: true }, mode: 'practice' });
  s.start();
  const lead = -s.startSongTime;
  const d = new Driver(s);
  d.runTo(1 + lead + 0.05);
  assert.equal(s.state, 'holding');
  perf += 5000;
  d.runTo(1 + lead + 1);
  const synth = env.synths[0];
  assert.deepEqual(synth.notes.map((x) => x.midi), [72], 'the melody note at the hold; no chord hint, later notes cut');
  assert.ok(synth.notes.every((x) => x.opts.velocity === 0.9));
  d.at(1 + lead + 1.1, () => { s.touchDown(60); s.touchUp(60); });
  d.runTo(1 + lead + 1.1 + 1.2);
  assert.deepEqual(synth.notes.filter((x) => !x.h.stopped).map((x) => x.midi), [72, 74, 76]);
  s.destroy();
});

test('accompaniment practice + mic + guide: the sung note at the hold does not release it through the mic', () => {
  freshCtx();
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: accSong(),
    settings: { inputMode: 'mic', latency: 0.12, guideMelody: true },
    mode: 'practice',
    input,
  });
  s.start();
  const cross = 1 - s.startSongTime;
  const d = new Driver(s, input);
  const judged = [];
  s.on('judge', (r) => judged.push(r.grade));
  // The speaker plays the sung C5 as the C major chord reaches the line; the mic hears it (a chord tone).
  d.runTo(cross + 0.05);
  assert.equal(s.state, 'holding');
  assert.ok(env.synths[0].notes.some((x) => x.midi === 72 && !x.h.stopped), 'the melody note at the hold sounds');
  d.strike(cross, 72);
  d.runTo(cross + 0.5);
  assert.equal(s.state, 'holding', 'the melody\'s own sound does not release the hold');
  assert.deepEqual(judged, []);
  assert.equal(s.stats.stray, 0);
  // Once the melody note has sounded (+ latency) the same pitch class from the player releases it.
  d.strike(cross + 0.6, 60);
  d.runTo(cross + 0.9);
  assert.equal(s.state, 'playing');
  assert.deepEqual(judged, ['good']);
  s.destroy();

  // Without the guide nothing is guarded: the same detection releases the hold (it is the player's strike).
  freshCtx();
  const input2 = new FakeInput('mic');
  const q = new GameSession({ song: accSong(), settings: { inputMode: 'mic', latency: 0.12 }, mode: 'practice', input: input2 });
  q.start();
  const d2 = new Driver(q, input2);
  d2.strike(cross, 72);
  d2.runTo(cross + 0.5);
  assert.equal(q.state, 'playing');
  assert.equal(q.judge.stateOf(1), 'perfect');
  q.destroy();
});

test('accompaniment practice + touch: the other fingers of a held chord do not take the next chord', () => {
  freshCtx();
  const notes = [];
  const ts = [1, 1.25, 1.5, 1.75];
  for (const t of ts) notes.push(H(t, 60, 'R'), H(t, 64, 'R'), H(t, 67, 'R'));
  const s = new GameSession({
    song: { title: 't', bpm: 120, notes, arrangement: 'accompaniment' }, settings: { inputMode: 'touch' }, mode: 'practice',
  });
  s.start();
  const d = new Driver(s);
  let holds = 0;
  const tap = (m) => { s.touchDown(m); s.touchUp(m); };
  // Each time the song waits, three fingers land 0 / 40 / 60 ms apart.
  s.on('state', (st) => {
    if (st !== 'holding') return;
    holds++;
    const at = env.ctx.currentTime + 0.05;
    d.at(at, () => tap(60));
    d.at(at + 0.04, () => tap(64));
    d.at(at + 0.06, () => tap(67));
  });
  let finished = null;
  s.on('finish', (st) => { finished = st; });
  d.runTo(12);
  assert.equal(holds, 4, 'every chord is held once');
  assert.ok(finished);
  assert.deepEqual(finished.counts, { perfect: 0, great: 0, good: 4, miss: 0 });
  assert.equal(finished.stray, 0);
  s.destroy();
});

test('accompaniment play + mic: the left hand 80 ms after the right hand stays with its chord', () => {
  freshCtx();
  const notes = [];
  const ts = [1, 1.25, 1.5, 1.75];
  for (const t of ts) notes.push(H(t, 48, 'L'), H(t, 60, 'R'), H(t, 64, 'R'), H(t, 67, 'R'));
  const input = new FakeInput('mic');
  const s = new GameSession({
    song: { title: 't', bpm: 120, notes, arrangement: 'accompaniment' },
    settings: { inputMode: 'mic', latency: 0.12 },
    mode: 'play',
    input,
  });
  s.start();
  const lead = -s.startSongTime;
  const d = new Driver(s, input);
  for (const t of ts) {
    for (const m of [60, 64, 67]) d.strike(t + lead, m);
    d.strike(t + lead + 0.08, 48);
  }
  let finished = null;
  s.on('finish', (st) => { finished = st; });
  d.runTo(ts[3] + lead + 3);
  assert.ok(finished);
  assert.deepEqual(finished.counts, { perfect: 4, great: 0, good: 0, miss: 0 });
  assert.equal(finished.stray, 0);
  assert.equal(finished.score, 1000000);
  s.destroy();
});

test('accompaniment + simulated input: every note feeds the detector, the melody only the speakers', () => {
  freshCtx();
  const input = new FakeInput('sim');
  const s = new GameSession({
    song: accSong(),
    settings: { inputMode: 'sim', guideMelody: true },
    mode: 'play',
    input,
  });
  s.start();
  new Driver(s, input).runTo(8);
  const synth = env.synths[0];
  const fed = synth.notes.filter((x) => Array.isArray(x.opts.destination));
  assert.equal(fed.length, ACC.length);
  for (const x of fed) assert.deepEqual(x.opts.destination, [synth.output, input.simInput]);
  const sung = synth.notes.filter((x) => !Array.isArray(x.opts.destination));
  assert.deepEqual(sung.map((x) => x.midi), VOCAL.map((n) => n.m));
  s.destroy();
});

test('accompaniment: a melody pickup before the first chord gets the lead-in', () => {
  freshCtx();
  const s = new GameSession({
    song: { title: 't', notes: [H(10, 60, 'R'), H(10, 48, 'L')], vocal: [N(6, 72)], arrangement: 'accompaniment' },
    settings: { inputMode: 'touch' },
  });
  assert.equal(s.startSongTime, 6 - 3.5);
  assert.equal(s.firstNoteT, 10, 'the count-in still counts to the first chord');
  s.destroy();
});

test('dedupe keeps the hand tag: a right-hand copy wins over a left-hand one', () => {
  freshCtx();
  const notes = [H(1, 60, 'L', 0.5), H(1, 60, 'R', 0.2), H(2, 55, 'L', 0.2), H(2.01, 55, 'L', 0.4), H(3, 50, 'R'), H(3, 50, 'L')];
  const before = JSON.stringify(notes);
  const s = new GameSession({ song: { title: 't', notes }, settings: { inputMode: 'touch' } });
  assert.equal(JSON.stringify(notes), before, 'song notes are not mutated');
  assert.deepEqual(s.notes.map((n) => [n.t, n.m, n.d, n.h]), [[1, 60, 0.5, 'R'], [2, 55, 0.4, 'L'], [3, 50, 0.3, 'R']]);
  assert.equal(s.notes[2], notes[4], 'an unchanged kept note is the song\'s own object');
  s.destroy();
});

test('simulated input is not shifted (it reaches the detector without output delay)', () => {
  const input = new FakeInput('sim');
  const { synth, lead, notes } = scheduledTimes(
    { baseLatency: 0.02, outputLatency: 0.18 },
    { inputMode: 'sim' },
    { input },
  );
  assert.equal(synth.notes.length, notes.length);
  synth.notes.forEach((x, i) => {
    close(x.when, notes[i].t + lead, 1e-9, `sim note ${i}`);
    assert.deepEqual(x.opts.destination, [synth.output, input.simInput]);
  });
});
