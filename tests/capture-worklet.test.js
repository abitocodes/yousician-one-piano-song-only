import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal AudioWorkletGlobalScope for loading the processor module in Node.
const registered = new Map();
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    const posted = [];
    this.port = {
      onmessage: null,
      posted,
      postMessage(msg, transfer = []) {
        posted.push({ msg, transfer });
      },
    };
  }
};
globalThis.registerProcessor = (name, cls) => registered.set(name, cls);
await import('../js/audio/capture-worklet.js');

const Q = 128;

function quantum(start) {
  const ch = new Float32Array(Q);
  for (let i = 0; i < Q; i++) ch[i] = (start + i) / 100000;
  return ch;
}

test('registers capture-processor', () => {
  assert.equal(typeof registered.get('capture-processor'), 'function');
});

test('posts 1024-sample blocks stamped with the context time of their first sample (transferred)', () => {
  const P = registered.get('capture-processor');
  const p = new P();
  const out = [[new Float32Array(Q)]];
  globalThis.currentTime = 10;
  let n = 0;
  for (let q = 0; q < 20; q++) {
    assert.equal(p.process([[quantum(n)]], out), true);
    n += Q;
    globalThis.currentTime += Q / sampleRate;
  }
  const posted = p.port.posted;
  assert.equal(posted.length, 2); // 2560 samples → two full blocks, 512 pending
  posted.forEach(({ msg, transfer }, k) => {
    assert.ok(msg.samples instanceof Float32Array);
    assert.equal(msg.samples.length, 1024);
    assert.deepEqual(transfer, [msg.samples.buffer]);
    assert.ok(Math.abs(msg.time - (10 + (k * 1024) / sampleRate)) < 1e-9);
    for (const i of [0, 1, 511, 1023]) assert.ok(Math.abs(msg.samples[i] - (k * 1024 + i) / 100000) < 1e-9);
  });
  assert.notEqual(posted[0].msg.samples, posted[1].msg.samples, 'a fresh buffer per block');
  assert.equal(out[0][0].every((x) => x === 0), true, 'output stays silent');
});

test('an input without channels counts as silence (continuous stream); stop ends processing', () => {
  const P = registered.get('capture-processor');
  const p = new P();
  const out = [[new Float32Array(Q)]];
  globalThis.currentTime = 3;
  for (let q = 0; q < 8; q++) {
    p.process(q < 4 ? [[quantum(q * Q)]] : [[]], out);
    globalThis.currentTime += Q / sampleRate;
  }
  assert.equal(p.port.posted.length, 1);
  const { samples, time } = p.port.posted[0].msg;
  assert.ok(Math.abs(time - 3) < 1e-9);
  assert.ok(samples[100] > 0);
  assert.equal(samples.subarray(512).every((x) => x === 0), true);
  p.port.onmessage({ data: 'stop' });
  assert.equal(p.process([[quantum(0)]], out), false);
});
