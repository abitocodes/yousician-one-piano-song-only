// Minimal event emitter shared by stateful modules (Settings, Library, Judge, AudioInput, ...).

export class Emitter {
  #listeners = new Map();

  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    let list = this.#listeners.get(type);
    if (!list) {
      list = [];
      this.#listeners.set(type, list);
    }
    list.push(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const list = this.#listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l === fn || l._orig === fn);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.#listeners.delete(type);
  }

  once(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const wrapper = (...args) => {
      this.off(type, wrapper);
      return fn.apply(this, args);
    };
    wrapper._orig = fn;
    return this.on(type, wrapper);
  }

  // Removes every listener of `type`, or every listener when called without arguments.
  removeAll(type) {
    if (type === undefined) this.#listeners.clear();
    else this.#listeners.delete(type);
  }

  listenerCount(type) {
    const list = this.#listeners.get(type);
    return list ? list.length : 0;
  }

  emit(type, ...args) {
    const list = this.#listeners.get(type);
    if (!list || !list.length) return false;
    // Snapshot so listeners may subscribe/unsubscribe while we iterate.
    for (const fn of list.slice()) {
      try {
        fn.apply(this, args);
      } catch (err) {
        console.error(`[Emitter] '${String(type)}' listener failed:`, err);
      }
    }
    return true;
  }
}
