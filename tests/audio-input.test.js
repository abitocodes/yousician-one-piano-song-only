import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeAudioContext, FakeStream, installWebAudioFakes, pendingUserMedia, domError, flush,
} from './helpers-webaudio.js';
import { renderNotes } from './helpers-signal.js';
import { getAudioContext } from '../js/audio/engine.js';
import { AudioInput } from '../js/audio/input.js';

const SPEC_CONSTRAINTS = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
};

let fakes = null;
let md = null;

beforeEach(() => {
  if (fakes) fakes.restore();
  fakes = installWebAudioFakes();
  md = fakes.mediaDevices;
  // Every test starts with a fresh, running AudioContext (as after unlockAudio()).
  const old = FakeAudioContext.instances.at(-1);
  if (old) old.state = 'closed';
  getAudioContext().state = 'running';
});

function ctx() {
  return getAudioContext();
}

function track(input) {
  const states = [];
  input.on('state', (s) => states.push(s));
  return states;
}

const capture = (c) => c.nodesOf('worklet').at(-1);

// Sends `buf` through the worklet port in 1024-sample blocks starting at context time `t0`.
function feedWorklet(node, buf, sampleRate, t0) {
  for (let i = 0; i + 1024 <= buf.length; i += 1024) {
    const samples = buf.slice(i, i + 1024);
    node.port.onmessage({ data: { samples, time: t0 + i / sampleRate } });
  }
}

test('startMic: spec constraints, worklet capture graph, states, sample rate', async () => {
  const input = new AudioInput();
  const states = track(input);
  assert.equal(input.state, 'idle');
  assert.equal(input.mode, null);
  assert.equal(input.sampleRate, null);
  assert.deepEqual(input.analysis, { time: 0, db: -120, gateOpen: false, pitch: null, topNotes: [], onset: false });
  await input.startMic();
  assert.deepEqual(md.calls, [SPEC_CONSTRAINTS]);
  assert.deepEqual(states, ['requesting', 'running']);
  assert.equal(input.state, 'running');
  assert.equal(input.mode, 'mic');
  assert.equal(input.simInput, null);
  assert.equal(input.sampleRate, 48000);
  assert.equal(input.lastError, null);
  const c = ctx();
  assert.equal(c.addModuleCalls.length, 1);
  assert.match(c.addModuleCalls[0], /^file:.*\/js\/audio\/capture-worklet\.js$/);
  const node = capture(c);
  assert.equal(node.name, 'capture-processor');
  assert.equal(node.options.numberOfInputs, 1);
  assert.equal(node.options.numberOfOutputs, 1);
  assert.equal(node.options.channelCount, 1);
  const source = c.nodesOf('mediaStreamSource')[0];
  assert.equal(source.mediaStream, md.streams[0]);
  assert.deepEqual(source.outputs, [node]);
  const mute = node.outputs[0];
  assert.equal(mute.type, 'gain');
  assert.equal(mute.gain.value, 0);
  assert.deepEqual(mute.outputs, [c.destination]);
  input.stop();
});

test('startMic is idempotent: concurrent and repeated calls share one request', async () => {
  const input = new AudioInput();
  const gate = pendingUserMedia(md);
  const p1 = input.startMic();
  const p2 = input.startMic();
  assert.equal(p1, p2);
  await flush();
  assert.equal(md.calls.length, 1);
  assert.equal(input.state, 'requesting');
  gate.release();
  await Promise.all([p1, p2]);
  assert.equal(input.state, 'running');
  await input.startMic();
  assert.equal(md.calls.length, 1);
  assert.equal(ctx().nodesOf('worklet').length, 1);
  input.stop();
});

test('a state listener calling startMic() re-entrantly does not request twice', async () => {
  const input = new AudioInput();
  const joined = [];
  input.on('state', (s) => {
    if (s === 'requesting') joined.push(input.startMic());
  });
  await input.startMic();
  await Promise.all(joined);
  assert.equal(md.calls.length, 1);
  assert.equal(input.state, 'running');
  input.stop();
});

test('stop() during the permission request; a new start afterwards works', async () => {
  const input = new AudioInput();
  const states = track(input);
  const gate = pendingUserMedia(md);
  const p = input.startMic();
  await flush();
  input.stop();
  assert.equal(input.state, 'idle');
  const late = gate.release();
  await p; // superseded: resolves without starting
  assert.equal(late.tracks[0].stopped, true, 'late stream is released');
  assert.equal(input.state, 'idle');
  assert.equal(input.mode, null);
  md.impl = null;
  await input.startMic();
  assert.equal(input.state, 'running');
  assert.equal(input.mode, 'mic');
  assert.deepEqual(states, ['requesting', 'idle', 'requesting', 'running']);
  // Failure, then an immediate retry from the catch handler.
  input.stop();
  md.impl = () => Promise.reject(domError('NotReadableError'));
  await assert.rejects(input.startMic());
  md.impl = null;
  await input.startMic();
  assert.equal(input.state, 'running');
  input.stop();
});

test('AudioWorklet module is added once per context', async () => {
  const input = new AudioInput();
  await input.startMic();
  input.stop();
  await input.startMic();
  input.stop();
  await input.startSimulation();
  input.stop();
  assert.equal(ctx().addModuleCalls.length, 1);
  assert.equal(ctx().nodesOf('worklet').length, 3);
  // A new context needs its own module.
  ctx().state = 'closed';
  getAudioContext().state = 'running';
  await input.startMic();
  assert.equal(ctx().addModuleCalls.length, 1);
  input.stop();
});

test('worklet failure → ScriptProcessor fallback; the module load is retried later', async () => {
  const input = new AudioInput();
  const c = ctx();
  c.addModuleImpl = () => Promise.reject(new Error('blocked'));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await input.startMic();
  } finally {
    console.warn = warn;
  }
  assert.equal(input.state, 'running');
  assert.equal(c.nodesOf('worklet').length, 0);
  const sp = c.nodesOf('scriptProcessor')[0];
  assert.equal(sp.bufferSize, 1024);
  assert.deepEqual(sp.channels, [1, 1]);
  assert.equal(typeof sp.onaudioprocess, 'function');
  assert.equal(sp.outputs[0].gain.value, 0);
  assert.deepEqual(sp.outputs[0].outputs, [c.destination]);
  input.stop();
  assert.equal(sp.onaudioprocess, null);
  c.addModuleImpl = null;
  await input.startMic();
  assert.equal(c.addModuleCalls.length, 2);
  assert.equal(c.nodesOf('worklet').length, 1);
  input.stop();
});

test('no AudioWorklet support → ScriptProcessor; a hanging addModule falls back after a timeout', async (t) => {
  globalThis.AudioWorkletNode = undefined;
  const input = new AudioInput();
  await input.startMic();
  assert.equal(ctx().nodesOf('scriptProcessor').length, 1);
  input.stop();

  fakes.restore();
  fakes = installWebAudioFakes();
  md = fakes.mediaDevices;
  const c = ctx();
  c.addModuleImpl = () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const p = input.startMic();
    await flush();
    assert.equal(input.state, 'requesting');
    t.mock.timers.tick(4000);
    await p;
  } finally {
    console.warn = warn;
  }
  assert.equal(input.state, 'running');
  assert.equal(c.nodesOf('scriptProcessor').length, 2);
  input.stop();
});

test('ScriptProcessor blocks are timed two buffers before playbackTime', async () => {
  globalThis.AudioWorkletNode = undefined;
  const input = new AudioInput();
  await input.startMic();
  const sp = ctx().nodesOf('scriptProcessor')[0];
  const sr = 48000;
  const buf = renderNotes([{ t: 0.5, m: 67, d: 0.4 }], { sampleRate: sr, duration: 1.5 });
  const notes = [];
  input.on('note', (e) => notes.push(e));
  const t0 = 20;
  for (let i = 0; i + 1024 <= buf.length; i += 1024) {
    const data = buf.slice(i, i + 1024);
    // The input buffer starting at t0 + i/sr is delivered with playbackTime two buffers later.
    sp.onaudioprocess({ playbackTime: t0 + (i + 2048) / sr, inputBuffer: { getChannelData: () => data } });
  }
  assert.equal(notes.length, 1);
  assert.equal(notes[0].midi, 67);
  assert.ok(Math.abs(notes[0].time - (t0 + 0.5)) < 0.025, `time ${notes[0].time}`);
  input.stop();
});

test('notes and throttled analysis in the context time base', async () => {
  const input = new AudioInput();
  await input.startMic();
  const sr = 48000;
  const melody = [{ t: 0.4, m: 60, d: 0.3 }, { t: 0.9, m: 64, d: 0.3 }, { t: 1.4, m: 67, d: 0.5 }];
  const buf = renderNotes(melody, { sampleRate: sr, duration: 3 });
  const notes = [];
  const analyses = [];
  input.on('note', (e) => notes.push(e));
  input.on('analysis', (a) => analyses.push(a));
  const t0 = 12.5; // context time of the first captured sample
  feedWorklet(capture(ctx()), buf, sr, t0);
  assert.deepEqual(notes.map((e) => e.midi), [60, 64, 67]);
  notes.forEach((e, i) => {
    assert.ok(Math.abs(e.time - (t0 + melody[i].t)) < 0.025, `note ${i} at ${e.time}`);
    assert.equal(e.source, 'onset');
  });
  const seconds = buf.length / sr;
  assert.ok(analyses.length >= 15 * seconds, `analysis events: ${analyses.length}`);
  assert.ok(analyses.length <= 30 * seconds + 1, `analysis events: ${analyses.length}`);
  for (let i = 1; i < analyses.length; i++) {
    assert.ok(analyses[i].time - analyses[i - 1].time >= 1 / 30 - 1e-6, 'at most 30 per second of audio');
  }
  // Every onset shows up in an emitted snapshot even when its own frame was skipped.
  const flagged = analyses.filter((a) => a.onset).map((a) => a.time - t0);
  for (const n of melody) {
    assert.ok(flagged.some((t) => t >= n.t && t <= n.t + 0.12), `onset flag near ${n.t}: ${flagged}`);
  }
  // input.analysis is always the latest snapshot (possibly newer than the last emitted one).
  assert.ok(input.analysis.time >= analyses.at(-1).time);
  assert.ok(input.analysis.time - analyses.at(-1).time < 1 / 30);
  assert.ok(input.analysis.time > t0 + 2.8);
  input.stop();
});

test('setSensitivity / setA4 reach the running detector and survive restarts', async () => {
  const input = new AudioInput({ sensitivity: 0.3, a4: 442 });
  await input.startMic();
  assert.equal(input._detector.sensitivity, 0.3);
  assert.equal(input._detector.a4, 442);
  input.setSensitivity(0.9);
  input.setA4(432);
  assert.equal(input._detector.sensitivity, 0.9);
  assert.equal(input._detector.a4, 432);
  input.stop();
  input.setSensitivity(0.1);
  await input.startSimulation();
  assert.equal(input._detector.sensitivity, 0.1);
  assert.equal(input._detector.a4, 432);
  input.stop();
});

test('error codes: insecure, unsupported, denied, error', async () => {
  const cases = [
    [() => { globalThis.isSecureContext = false; }, 'insecure', 'unsupported'],
    [() => { globalThis.navigator = { userAgent: 'x' }; }, 'unsupported', 'unsupported'],
    [() => { md.getUserMedia = undefined; }, 'unsupported', 'unsupported'],
    [() => { md.impl = () => Promise.reject(domError('NotAllowedError')); }, 'denied', 'denied'],
    [() => { md.impl = () => Promise.reject(domError('SecurityError')); }, 'denied', 'denied'],
    [() => { md.impl = () => Promise.reject(domError('PermissionDeniedError')); }, 'denied', 'denied'],
    [() => { md.impl = () => Promise.reject(domError('NotFoundError')); }, 'error', 'error', /찾을 수 없어요/],
    [() => { md.impl = () => Promise.reject(domError('NotReadableError')); }, 'error', 'error', /다른 앱/],
    [() => { md.impl = () => Promise.reject(domError('AbortError')); }, 'error', 'error', /다른 앱/],
    [() => { md.impl = () => Promise.reject(new TypeError('bad')); }, 'error', 'error', /시작하지 못했어요/],
  ];
  for (const [setup, code, state, message] of cases) {
    fakes.restore();
    fakes = installWebAudioFakes();
    md = fakes.mediaDevices;
    setup();
    const input = new AudioInput();
    const states = track(input);
    await assert.rejects(input.startMic(), (err) => {
      assert.equal(err.code, code);
      assert.ok(err instanceof Error && err.message.length > 10);
      if (message) assert.match(err.message, message);
      return true;
    });
    assert.equal(input.state, state);
    assert.equal(input.mode, null);
    assert.equal(input.lastError.code, code);
    assert.equal(states.at(-1), state);
    // A later successful start clears the error.
    if (code === 'denied') {
      md.impl = null;
      await input.startMic();
      assert.equal(input.state, 'running');
      assert.equal(input.lastError, null);
      input.stop();
    }
  }
});

test('OverconstrainedError → retried once with plain audio', async () => {
  let n = 0;
  md.impl = (constraints) => {
    n++;
    if (constraints.audio !== true) return Promise.reject(domError('OverconstrainedError'));
    return Promise.resolve({ getTracks: () => [], getAudioTracks: () => [] });
  };
  const input = new AudioInput();
  // A stream without a live audio track is not a running microphone.
  await assert.rejects(input.startMic(), (err) => err.code === 'error');
  assert.deepEqual(md.calls, [SPEC_CONSTRAINTS, { audio: true }]);
  assert.equal(n, 2);
  md.impl = (constraints) => (constraints.audio === true
    ? Promise.resolve(new FakeStream())
    : Promise.reject(domError('OverconstrainedError')));
  await input.startMic();
  assert.equal(input.state, 'running');
  assert.deepEqual(md.calls.slice(2), [SPEC_CONSTRAINTS, { audio: true }]);
  input.stop();
});

test('microphone track ending (taken by another app / permission revoked) → state error', async () => {
  const input = new AudioInput();
  await input.startMic();
  const states = track(input);
  const node = capture(ctx());
  const stream = md.streams[0];
  const warn = console.warn;
  console.warn = () => {};
  try {
    stream.tracks[0].end();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(states, ['error']);
  assert.equal(input.state, 'error');
  assert.equal(input.mode, null);
  assert.equal(input.lastError.code, 'error');
  assert.match(input.lastError.message, /끊어졌어요/);
  assert.ok(node.disconnects > 0);
  assert.deepEqual(node.port.sent, ['stop']);
  // Restart works, also right away in the same tick.
  await input.startMic();
  assert.equal(input.state, 'running');
  assert.equal(md.calls.length, 2);
  input.stop();
});

test('stop() tears everything down and ignores late audio', async () => {
  const input = new AudioInput();
  await input.startMic();
  const c = ctx();
  const node = capture(c);
  const port = node.port;
  const handler = port.onmessage;
  const source = c.nodesOf('mediaStreamSource')[0];
  const mute = node.outputs[0];
  const stream = md.streams[0];
  const states = track(input);
  input.stop();
  assert.deepEqual(states, ['idle']);
  assert.equal(input.state, 'idle');
  assert.equal(input.mode, null);
  assert.equal(stream.tracks[0].stopped, true);
  assert.deepEqual(port.sent, ['stop']);
  assert.equal(port.onmessage, null);
  for (const n of [source, node, mute]) assert.ok(n.disconnects > 0, `${n.type} disconnected`);
  assert.deepEqual(input.analysis, { time: 0, db: -120, gateOpen: false, pitch: null, topNotes: [], onset: false });
  const notes = [];
  input.on('note', (e) => notes.push(e));
  const buf = renderNotes([{ t: 0.2, m: 60, d: 0.3 }], { sampleRate: 48000, duration: 1 });
  for (let i = 0; i + 1024 <= buf.length; i += 1024) {
    handler({ data: { samples: buf.slice(i, i + 1024), time: i / 48000 } });
  }
  assert.equal(notes.length, 0);
  input.stop(); // idempotent, no extra event
  assert.deepEqual(states, ['idle']);
});

test('startSimulation: analysis on simInput; switching between mic and simulation', async () => {
  const input = new AudioInput();
  await input.startMic();
  const micStream = md.streams[0];
  await input.startSimulation();
  assert.equal(micStream.tracks[0].stopped, true, 'simulation stops the mic');
  assert.equal(input.mode, 'sim');
  assert.equal(input.state, 'running');
  const sim = input.simInput;
  assert.equal(sim.type, 'gain');
  const node = capture(ctx());
  assert.deepEqual(sim.outputs, [node]);
  // Audio routed into simInput is analysed in the context time base.
  const notes = [];
  input.on('note', (e) => notes.push(e));
  feedWorklet(node, renderNotes([{ t: 0.3, m: 72, d: 0.3 }], { sampleRate: 48000, duration: 1 }), 48000, 4);
  assert.deepEqual(notes.map((e) => e.midi), [72]);
  assert.ok(Math.abs(notes[0].time - 4.3) < 0.025);
  await input.startSimulation(); // idempotent
  assert.equal(input.simInput, sim);
  await input.startMic();
  assert.equal(input.mode, 'mic');
  assert.equal(input.simInput, null);
  assert.ok(sim.disconnects > 0);
  input.stop();
});

test('a failed mic start does not leave a simulation running', async () => {
  const input = new AudioInput();
  await input.startSimulation();
  md.impl = () => Promise.reject(domError('NotAllowedError'));
  await assert.rejects(input.startMic(), (err) => err.code === 'denied');
  assert.equal(input.mode, null);
  assert.equal(input.simInput, null);
  assert.equal(input.state, 'denied');
});

test('startSimulation supersedes a pending mic request', async () => {
  const input = new AudioInput();
  const gate = pendingUserMedia(md);
  const mic = input.startMic();
  await flush();
  await input.startSimulation();
  assert.equal(input.mode, 'sim');
  const late = gate.release();
  await mic;
  assert.equal(late.tracks[0].stopped, true);
  assert.equal(input.mode, 'sim');
  assert.equal(input.state, 'running');
  input.stop();
});

test('state listeners may stop or switch the input synchronously', async () => {
  const input = new AudioInput();
  const off = input.on('state', (st) => {
    if (st === 'requesting') input.stop();
  });
  await input.startMic();
  off();
  assert.equal(md.calls.length, 0, 'no permission prompt after stop()');
  assert.equal(input.state, 'idle');

  await input.startMic();
  const off2 = input.on('state', (st) => {
    if (st === 'idle') input.startMic(); // e.g. a screen that insists on the microphone
  });
  await input.startSimulation(); // superseded by the listener's startMic()
  off2();
  await flush();
  assert.equal(input.mode, 'mic');
  assert.equal(input.state, 'running');
  assert.equal(input.simInput, null);
  input.stop();
});
