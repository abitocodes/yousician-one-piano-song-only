import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../js/core/emitter.js';

test('on/emit in insertion order with arguments', () => {
  const e = new Emitter();
  const calls = [];
  e.on('x', (a, b) => calls.push(['1', a, b]));
  e.on('x', (a, b) => calls.push(['2', a, b]));
  assert.equal(e.emit('x', 1, 2), true);
  assert.deepEqual(calls, [['1', 1, 2], ['2', 1, 2]]);
  assert.equal(e.emit('nothing'), false);
});

test('on returns an unsubscribe function; off removes', () => {
  const e = new Emitter();
  let n = 0;
  const fn = () => n++;
  const unsub = e.on('x', fn);
  e.emit('x');
  unsub();
  e.emit('x');
  assert.equal(n, 1);
  e.on('x', fn);
  e.off('x', fn);
  e.emit('x');
  assert.equal(n, 1);
  e.off('unknown', fn); // no throw
});

test('once fires a single time and can be cancelled', () => {
  const e = new Emitter();
  let n = 0;
  e.once('x', () => n++);
  e.emit('x');
  e.emit('x');
  assert.equal(n, 1);
  const unsub = e.once('y', () => n++);
  unsub();
  e.emit('y');
  assert.equal(n, 1);
  const fn = () => n++;
  e.once('z', fn);
  e.off('z', fn);
  e.emit('z');
  assert.equal(n, 1);
});

test('a throwing listener does not stop the others', () => {
  const e = new Emitter();
  const orig = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    let reached = false;
    e.on('x', () => {
      throw new Error('boom');
    });
    e.on('x', () => {
      reached = true;
    });
    e.emit('x');
    assert.equal(reached, true);
    assert.equal(logged.length, 1);
  } finally {
    console.error = orig;
  }
});

test('listeners may unsubscribe during emit; subclasses work', () => {
  class Thing extends Emitter {
    constructor() {
      super();
      this.value = 1;
    }
  }
  const t = new Thing();
  const calls = [];
  const a = () => {
    calls.push('a');
    t.off('x', a);
  };
  t.on('x', a);
  t.on('x', () => calls.push('b'));
  t.emit('x');
  t.emit('x');
  assert.deepEqual(calls, ['a', 'b', 'b']);
  assert.equal(t.listenerCount('x'), 1);
  t.removeAll();
  assert.equal(t.listenerCount('x'), 0);
});
