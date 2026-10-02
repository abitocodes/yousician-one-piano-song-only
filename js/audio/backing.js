// Optional backing track (user-supplied audio file) played through an HTMLAudioElement and kept in
// sync with the game clock.

const DRIFT_LIMIT = 0.08;
const LOAD_TIMEOUT_MS = 10000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setPreservesPitch(el, on) {
  try {
    if ('preservesPitch' in el) el.preservesPitch = on;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = on;
    if ('mozPreservesPitch' in el) el.mozPreservesPitch = on;
  } catch { /* not supported */ }
}

function safeRate(speed) {
  const s = Number(speed);
  return Number.isFinite(s) && s > 0 ? clamp(s, 0.25, 4) : 1;
}

export class BackingTrack {
  constructor() {
    this.el = null;
    this._url = null;
    this._loaded = false;
    this._timer = 0;
    this._active = false;   // play() requested and not paused
    this._speed = 1;
    this._offset = 0;
    this._volume = 1;
  }

  get loaded() { return this._loaded; }

  get duration() {
    const d = this.el ? this.el.duration : NaN;
    return Number.isFinite(d) ? d : NaN;
  }

  async load(blob) {
    this._teardown();
    if (!blob || typeof blob.size !== 'number') throw new Error('반주 음원 파일이 없어요.');
    if (typeof Audio === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      throw new Error('이 브라우저에서는 반주 음원을 재생할 수 없어요.');
    }
    const el = new Audio();
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    setPreservesPitch(el, true);
    el.volume = this._volume;
    const url = URL.createObjectURL(blob);
    this.el = el;
    this._url = url;

    await new Promise((resolve, reject) => {
      let timer = 0;
      const done = (fn, arg) => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('canplay', onReady);
        el.removeEventListener('error', onError);
        fn(arg);
      };
      const onReady = () => done(resolve);
      const onError = () => done(reject, new Error('반주 음원을 불러오지 못했어요. 지원하지 않는 파일 형식일 수 있어요.'));
      el.addEventListener('loadedmetadata', onReady);
      el.addEventListener('canplay', onReady);
      el.addEventListener('error', onError);
      // Some mobile browsers defer loading until playback; don't block the game forever.
      timer = setTimeout(() => done(resolve), LOAD_TIMEOUT_MS);
      el.src = url;
      try { el.load(); } catch { /* ignore */ }
    }).catch((err) => {
      if (this.el === el) this._teardown();
      throw err;
    });

    if (this.el !== el) throw new Error('반주 음원 불러오기가 취소되었어요.');
    this._loaded = true;
  }

  // Start playback so that the audio position matches songTime. audioTime = songTime − offset; when it
  // is negative, playback starts from 0 after (−audioTime / speed) seconds of real time.
  play(songTime, speed = 1, offset = 0) {
    const el = this.el;
    if (!el || !this._loaded) return;
    this._speed = safeRate(speed);
    this._offset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    this._active = true;
    this._clearTimer();
    this._applyRate();
    const audioTime = Number(songTime) - this._offset;
    if (!Number.isFinite(audioTime)) return;
    if (audioTime < 0) {
      if (!el.paused) el.pause();
      this._setTime(0);
      this._armTimer(-audioTime / this._speed);
    } else {
      this._startAt(audioTime);
    }
  }

  pause() {
    this._active = false;
    this._clearTimer();
    if (this.el && !this.el.paused) {
      try { this.el.pause(); } catch { /* ignore */ }
    }
  }

  seek(songTime) {
    const el = this.el;
    if (!el) return;
    const audioTime = Number(songTime) - this._offset;
    if (!Number.isFinite(audioTime)) return;
    this._clearTimer();
    if (audioTime < 0) {
      if (!el.paused) el.pause();
      this._setTime(0);
      if (this._active) this._armTimer(-audioTime / this._speed);
    } else if (this._active) {
      this._startAt(audioTime);
    } else {
      this._setTime(audioTime);
    }
  }

  // Drift correction; call periodically with the current song time while playing.
  sync(songTime) {
    const el = this.el;
    if (!el || !this._active) return;
    const expected = Number(songTime) - this._offset;
    if (!Number.isFinite(expected)) return;
    if (expected < 0) {
      if (!el.paused) {
        el.pause();
        this._setTime(0);
      }
      if (!this._timer) this._armTimer(-expected / this._speed);
      return;
    }
    const dur = this.duration;
    if (Number.isFinite(dur) && expected >= dur) {
      if (!el.paused) el.pause();
      return;
    }
    if (el.paused) {
      if (!this._timer) this._startAt(expected);
      return;
    }
    if (el.seeking) return;
    if (Math.abs(el.currentTime - expected) > DRIFT_LIMIT) this._setTime(expected);
  }

  setRate(speed) {
    this._speed = safeRate(speed);
    this._applyRate();
  }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (this.el) {
      try { this.el.volume = this._volume; } catch { /* read-only on some platforms */ }
    }
  }

  dispose() {
    this._teardown();
  }

  _teardown() {
    this.pause();
    const el = this.el;
    if (el) {
      try {
        el.removeAttribute('src');
        el.load();
      } catch { /* ignore */ }
    }
    if (this._url) {
      try { URL.revokeObjectURL(this._url); } catch { /* ignore */ }
    }
    this.el = null;
    this._url = null;
    this._loaded = false;
  }

  _startAt(audioTime) {
    const el = this.el;
    if (!el) return;
    const dur = this.duration;
    if (Number.isFinite(dur) && audioTime >= dur) {
      if (!el.paused) el.pause();
      return;
    }
    if (Math.abs(el.currentTime - audioTime) > 0.02) this._setTime(audioTime);
    this._applyRate();
    let p;
    try {
      p = el.play();
    } catch (err) {
      console.warn('[BackingTrack] play failed', err);
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err && err.name !== 'AbortError') console.warn('[BackingTrack] play failed', err);
      });
    }
  }

  _armTimer(delaySec) {
    this._clearTimer();
    const ms = Math.max(0, delaySec * 1000);
    this._timer = setTimeout(() => {
      this._timer = 0;
      if (this._active) this._startAt(0);
    }, ms);
  }

  _clearTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0;
  }

  _setTime(t) {
    try { this.el.currentTime = Math.max(0, t); } catch { /* not seekable yet */ }
  }

  _applyRate() {
    if (!this.el) return;
    try {
      this.el.defaultPlaybackRate = this._speed;
      this.el.playbackRate = this._speed;
    } catch { /* unsupported rate */ }
    setPreservesPitch(this.el, true);
  }
}
