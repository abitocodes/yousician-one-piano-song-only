import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameClock } from '../js/game/clock.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

test('before start the clock is stopped at 0', () => {
  const c = new GameClock();
  assert.equal(c.running, false);
  assert.equal(c.held, false);
  assert.equal(c.speed, 1);
  assert.equal(c.time(123), 0);
});

test('start runs from the given song time', () => {
  const c = new GameClock();
  c.start(10, -3.5);
  assert.equal(c.running, true);
  close(c.time(10), -3.5);
  close(c.time(11), -2.5);
  close(c.time(15.25), 1.75);
});

test('pause freezes and resume continues without a jump', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.pause(2);
  assert.equal(c.running, false);
  assert.equal(c.paused, true);
  close(c.time(5), 2);
  close(c.time(100), 2);
  c.resume(50);
  assert.equal(c.running, true);
  close(c.time(50), 2);
  close(c.time(51), 3);
});

test('pause/resume are idempotent', () => {
  const c = new GameClock();
  c.pause(1); // not started: no-op
  assert.equal(c.paused, false);
  c.start(0, 0);
  c.pause(1);
  c.pause(3); // second pause must not move the frozen time
  close(c.time(10), 1);
  c.resume(10);
  c.resume(12); // second resume must not re-anchor
  close(c.time(12), 3);
});

test('hold freezes at an explicit song time; release continues from it', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.hold(5.02, 5);
  assert.equal(c.held, true);
  assert.equal(c.running, false);
  close(c.time(5.02), 5);
  close(c.time(9), 5);
  c.release(9);
  assert.equal(c.held, false);
  assert.equal(c.running, true);
  close(c.time(9), 5);
  close(c.time(9.5), 5.5);
});

test('hold without a song time freezes at the current time', () => {
  const c = new GameClock();
  c.start(0, 1);
  c.hold(2);
  close(c.time(10), 3);
});

test('pause while held keeps the hold; resume returns to held state', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.hold(4, 4);
  c.pause(6);
  assert.equal(c.paused, true);
  assert.equal(c.held, true);
  close(c.time(7), 4);
  c.resume(8);
  assert.equal(c.held, true);
  assert.equal(c.running, false);
  close(c.time(9), 4);
  c.release(10);
  close(c.time(11), 5);
});

test('release while paused stays frozen until resume', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.hold(2, 2);
  c.pause(3);
  c.release(4);
  assert.equal(c.running, false);
  close(c.time(6), 2);
  c.resume(10);
  close(c.time(11), 3);
});

test('speed scales song time progression', () => {
  const c = new GameClock({ speed: 0.5 });
  assert.equal(c.speed, 0.5);
  c.start(100, 0);
  close(c.time(102), 1);
});

test('setSpeed re-anchors so time is continuous', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.setSpeed(0.5, 4);
  assert.equal(c.speed, 0.5);
  close(c.time(4), 4);
  close(c.time(6), 5);
  c.setSpeed(1.25, 6);
  close(c.time(6), 5);
  close(c.time(8), 7.5);
});

test('setSpeed while paused keeps the frozen time and applies after resume', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.pause(2);
  c.setSpeed(2, 3);
  close(c.time(5), 2);
  c.resume(10);
  close(c.time(11), 4);
});

test('invalid speeds are rejected', () => {
  const c = new GameClock({ speed: -1 });
  assert.equal(c.speed, 1);
  c.setSpeed(0, 0);
  assert.equal(c.speed, 1);
  c.setSpeed(NaN, 0);
  assert.equal(c.speed, 1);
  c.setSpeed('0.75', 0);
  assert.equal(c.speed, 0.75);
});

test('toSong and toCtx are inverse mappings of the current anchor', () => {
  const c = new GameClock({ speed: 0.8 });
  c.start(20, -2);
  close(c.toSong(20), -2);
  close(c.toSong(25), 2);
  close(c.toCtx(2), 25);
  for (const s of [-2, 0, 1.234, 10]) close(c.toSong(c.toCtx(s)), s, 1e-9);
  // Times before the anchor map to earlier song times (used for latency-compensated events).
  close(c.toSong(19), -2.8);
});

test('toSong returns the frozen time when paused or held; toCtx projects from the anchor', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.pause(3);
  close(c.toSong(1), 3);
  close(c.toSong(10), 3);
  close(c.toCtx(5), 5); // anchored at ctx 3 / song 3 → song 5 at ctx 5 if resumed now
  c.resume(7);
  close(c.toCtx(5), 9);
  c.hold(8, 4);
  close(c.toSong(100), 4);
});

test('start again restarts and clears pause/hold', () => {
  const c = new GameClock();
  c.start(0, 0);
  c.pause(1);
  c.hold(1, 1);
  c.start(10, -1);
  assert.equal(c.running, true);
  assert.equal(c.paused, false);
  assert.equal(c.held, false);
  close(c.time(11), 0);
});
