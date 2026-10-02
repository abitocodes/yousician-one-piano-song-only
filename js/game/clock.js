// Song clock: maps an external monotonic time base (AudioContext seconds) to song seconds.
// Pure module (no browser APIs) so it can be unit-tested in Node.

const MIN_SPEED = 0.05;
const MAX_SPEED = 4;

function sanitizeSpeed(speed, fallback = 1) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return fallback;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, s));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class GameClock {
  constructor({ speed = 1 } = {}) {
    this._speed = sanitizeSpeed(speed);
    this._started = false;
    this._paused = false;
    this._held = false;
    // While running: song = anchorSong + (ctx - anchorCtx) * speed. While frozen: song = anchorSong.
    this._anchorCtx = 0;
    this._anchorSong = 0;
  }

  get speed() { return this._speed; }
  get started() { return this._started; }
  get paused() { return this._paused; }
  get held() { return this._held; }
  get running() { return this._started && !this._paused && !this._held; }

  start(nowCtx, songTime = 0) {
    this._started = true;
    this._paused = false;
    this._held = false;
    this._anchorCtx = finiteOr(nowCtx, 0);
    this._anchorSong = finiteOr(songTime, 0);
  }

  pause(nowCtx) {
    if (!this._started || this._paused) return;
    this._freezeAt(nowCtx);
    this._paused = true;
  }

  resume(nowCtx) {
    if (!this._paused) return;
    this._paused = false;
    // Re-anchor at the frozen song time so time continues without a jump.
    this._anchorCtx = finiteOr(nowCtx, this._anchorCtx);
  }

  // Freeze at an explicit song time (practice/wait mode). Works while paused too.
  hold(nowCtx, songTime) {
    if (!this._held) this._freezeAt(nowCtx);
    this._held = true;
    this._started = true;
    if (songTime !== undefined && Number.isFinite(Number(songTime))) this._anchorSong = Number(songTime);
    this._anchorCtx = finiteOr(nowCtx, this._anchorCtx);
  }

  release(nowCtx) {
    if (!this._held) return;
    this._held = false;
    this._anchorCtx = finiteOr(nowCtx, this._anchorCtx);
  }

  time(nowCtx) {
    return this.toSong(nowCtx);
  }

  toSong(ctxTime) {
    if (!this.running) return this._anchorSong;
    const c = Number(ctxTime);
    if (!Number.isFinite(c)) return this._anchorSong;
    return this._anchorSong + (c - this._anchorCtx) * this._speed;
  }

  // Context time at which songTime will be reached if the clock runs from its current anchor.
  toCtx(songTime) {
    return this._anchorCtx + (Number(songTime) - this._anchorSong) / this._speed;
  }

  setSpeed(speed, nowCtx) {
    const s = sanitizeSpeed(speed, this._speed);
    if (s === this._speed) return;
    if (this.running) {
      const c = finiteOr(nowCtx, this._anchorCtx);
      this._anchorSong = this.toSong(c);
      this._anchorCtx = c;
    }
    this._speed = s;
  }

  _freezeAt(nowCtx) {
    const c = finiteOr(nowCtx, this._anchorCtx);
    this._anchorSong = this.toSong(c);
    this._anchorCtx = c;
  }
}
