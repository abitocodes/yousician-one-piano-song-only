import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext, installWebAudioFakes, flush } from './helpers-webaudio.js';
import { getAudioContext, unlockAudio, audioNow, masterOut, setMasterVolume } from '../js/audio/engine.js';

installWebAudioFakes();

// performance.now() under test control (ms).
let perfMs = 1000;
const realPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
Object.defineProperty(globalThis, 'performance', { value: { now: () => perfMs }, configurable: true, writable: true });
test.after(() => Object.defineProperty(globalThis, 'performance', realPerformance));

function freshContext() {
  const old = FakeAudioContext.instances.at(-1);
  if (old) old.state = 'closed';
  return getAudioContext();
}

test('getAudioContext: lazy singleton with interactive latency, recreated after close', () => {
  assert.equal(FakeAudioContext.instances.length, 0, 'importing the module creates no context');
  const c = getAudioContext();
  assert.ok(c instanceof FakeAudioContext);
  assert.deepEqual(c.options, { latencyHint: 'interactive' });
  assert.equal(getAudioContext(), c);
  c.close();
  const c2 = getAudioContext();
  assert.notEqual(c2, c);
  assert.equal(getAudioContext(), c2);
});

test('getAudioContext: old engines without options; missing Web Audio → code unsupported', () => {
  getAudioContext().state = 'closed';
  FakeAudioContext.rejectOptions = true;
  try {
    const c = getAudioContext();
    assert.equal(c.options, undefined);
  } finally {
    FakeAudioContext.rejectOptions = false;
  }
  getAudioContext().state = 'closed';
  const saved = globalThis.AudioContext;
  globalThis.AudioContext = undefined;
  try {
    assert.throws(() => getAudioContext(), (err) => err.code === 'unsupported' && /Web Audio/.test(err.message));
    globalThis.webkitAudioContext = FakeAudioContext;
    assert.ok(getAudioContext() instanceof FakeAudioContext);
  } finally {
    globalThis.AudioContext = saved;
    delete globalThis.webkitAudioContext;
  }
});

test('unlockAudio: resume() runs synchronously in the gesture, silent buffer once, idempotent', async () => {
  const c = freshContext();
  const p = unlockAudio();
  // Synchronous part of the call (still inside the user gesture):
  assert.equal(c.resumeCalls, 1);
  const sources = c.nodesOf('bufferSource');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].buffer.length, 1);
  assert.deepEqual(sources[0].started, [0]);
  assert.equal(sources[0].outputs[0], c.destination);
  assert.equal(await p, c);
  assert.equal(c.state, 'running');
  assert.equal(await unlockAudio(), c);
  assert.equal(c.resumeCalls, 1);
  assert.equal(c.nodesOf('bufferSource').length, 1);
  // Suspended again (e.g. by the system): resumes, but the context is already primed.
  c.state = 'suspended';
  await unlockAudio();
  assert.equal(c.resumeCalls, 2);
  assert.equal(c.nodesOf('bufferSource').length, 1);
});

test('unlockAudio never hangs when resume() stays pending', async (t) => {
  const c = freshContext();
  c.resumeHangs = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let done = false;
  const p = unlockAudio().then((r) => {
    done = true;
    return r;
  });
  await flush();
  assert.equal(done, false);
  t.mock.timers.tick(800);
  assert.equal(await p, c);
  assert.equal(c.state, 'suspended');
});

// Drives audioNow() at 60 fps while currentTime advances in render bursts of `burst` seconds.
function simulate(c, { seconds, burst = 512 / 48000, rate = 1, stallFrom = Infinity, stallFor = 0, start = 0 }) {
  const out = [];
  const frame = 1000 / 60;
  const perf0 = perfMs;
  let audio = c.currentTime;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    perfMs += frame + (i % 7 === 3 ? 1.5 : 0) - (i % 7 === 4 ? 1.5 : 0); // rAF jitter
    const elapsed = (perfMs - perf0) / 1000;
    const stalled = elapsed >= stallFrom && elapsed < stallFrom + stallFor;
    const target = start + (elapsed - (elapsed >= stallFrom + stallFor ? stallFor : 0)) * rate;
    if (!stalled) {
      while (audio + burst <= target) audio += burst;
      c.currentTime = audio;
    }
    out.push({ perf: perfMs / 1000, ctx: c.currentTime, now: audioNow() });
  }
  return out;
}

test('audioNow: monotonic, smooth and close to currentTime with bursty audio clock', () => {
  for (const burst of [128 / 48000, 512 / 48000, 960 / 48000]) {
    for (const rate of [1, 1.0005, 0.9995]) {
      const c = freshContext();
      c.state = 'running';
      c.currentTime = 3;
      const s = simulate(c, { seconds: 6, burst, rate, start: 3 });
      for (let i = 1; i < s.length; i++) assert.ok(s[i].now >= s[i - 1].now, 'never backwards');
      for (let i = 60; i < s.length; i++) {
        const dNow = s[i].now - s[i - 1].now;
        const dPerf = s[i].perf - s[i - 1].perf;
        const ms = (x) => (x * 1000).toFixed(2);
        assert.ok(Math.abs(dNow - dPerf) < 0.003, `step ${ms(dNow)} ms vs ${ms(dPerf)} ms`);
        const lead = s[i].now - s[i].ctx;
        assert.ok(lead >= -0.003 && lead <= burst + 0.005, `lead ${(lead * 1000).toFixed(1)} ms (burst ${burst})`);
      }
    }
  }
});

test('audioNow: re-syncs after a stalled audio clock and never goes backwards', () => {
  const c = freshContext();
  c.state = 'running';
  c.currentTime = 1;
  const s = simulate(c, { seconds: 4, start: 1, stallFrom: 1, stallFor: 0.6 });
  for (let i = 1; i < s.length; i++) assert.ok(s[i].now >= s[i - 1].now);
  const tail = s.slice(-30);
  for (const x of tail) assert.ok(Math.abs(x.now - x.ctx) < 0.02, `after stall: ${x.now} vs ${x.ctx}`);
});

test('audioNow: suspended context → currentTime; new context → new time base', () => {
  const c = freshContext();
  c.state = 'suspended';
  c.currentTime = 2.5;
  perfMs += 100;
  assert.equal(audioNow(), 2.5);
  c.currentTime = 2.75;
  assert.equal(audioNow(), 2.75);
  c.state = 'closed';
  const t = audioNow(); // creates the next context, whose clock starts at 0
  assert.equal(t, 0);
  assert.notEqual(getAudioContext(), c);
});

test('masterOut: gain → compressor → destination, cached; setMasterVolume clamps and ramps', () => {
  const c = freshContext();
  const m = masterOut();
  assert.equal(m.type, 'gain');
  assert.equal(m.gain.value, 0.8);
  const comp = m.outputs[0];
  assert.equal(comp.type, 'compressor');
  assert.equal(comp.outputs[0], c.destination);
  assert.equal(masterOut(), m);
  setMasterVolume(2);
  assert.equal(m.gain.value, 1);
  assert.ok(m.gain.calls.some((x) => x[0] === 'target' && x[1] === 1));
  setMasterVolume(-1);
  assert.equal(m.gain.value, 0);
  setMasterVolume('loud');
  assert.equal(m.gain.value, 0);
  setMasterVolume(0.3);
  // A new context gets a new bus with the remembered volume.
  c.state = 'closed';
  const m2 = masterOut();
  assert.notEqual(m2, m);
  assert.equal(m2.gain.value, 0.3);
});
