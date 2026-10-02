// Game session: owns the clock, the judge, audio scheduling (guide melody / metronome / simulated
// input), the optional backing track and practice-mode holds. DOM-free; the play screen drives it by
// calling tick() every animation frame.
import { Emitter } from '../core/emitter.js';
import { pitchClass } from '../core/notes.js';
import { songDuration } from '../core/song.js';
import { getAudioContext, audioNow, setMasterVolume } from '../audio/engine.js';
import { Synth } from '../audio/synth.js';
import { BackingTrack } from '../audio/backing.js';
import { GameClock } from './clock.js';
import { Judge, GROUP_EPS } from './judge.js';

const MODES = ['play', 'practice', 'listen', 'calibrate'];
const SCHEDULE_AHEAD = 0.3;       // real seconds of audio scheduled ahead
const SYNC_INTERVAL = 0.5;        // backing-track drift check interval (real s)
const RESUME_COUNTDOWN = 1.5;     // real s, 3 ticks
const COUNTDOWN = 3;              // real s before the first note
const CALIBRATE_WINDOWS = { perfect: 0.45, great: 0.45, good: 0.45 };
const EXPECT_BEFORE = 0.12;
const EXPECT_MIN_LEN = 0.15;
const HINT_DELAY_MIC = 0.5;       // practice hint waits this long with a mic so on-time strikes can land first
const HINT_ECHO_GUARD = 0.4;      // ignore mic detections of the hint itself for this long (+ latency)
const SAME_STRIKE = 0.012;        // detections this close (raw ctx s) belong to one strike
const LATE_TOLERANCE = 0.05;      // audio events at most this late are still played
const SUSPEND_PAUSE_MS = 700;     // auto-pause when the audio context stays suspended this long
const SIM_RETRY_MS = 1200;        // practice + sim: replay the held notes if the detector missed them
const EMPTY = Object.freeze([]);
const EPS = 1e-6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function isSortedByTime(notes) {
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1];
    const b = notes[i];
    if (b.t < a.t || (b.t === a.t && b.m < a.m)) return false;
  }
  return true;
}

// First index with notes[i].t >= x.
function lowerBound(notes, x) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[mid].t < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class GameSession extends Emitter {
  constructor({ song, settings = {}, mode = 'play', input = null, audioBlob = null } = {}) {
    super();
    if (!song || typeof song !== 'object') throw new Error('곡 정보가 없어요.');
    this.song = song;
    this.settings = settings || {};
    this.mode = MODES.includes(mode) ? mode : 'play';
    this.input = input || null;
    this.audioBlob = audioBlob || null;

    const raw = Array.isArray(song.notes) ? song.notes.filter((n) => n && Number.isFinite(n.t) && Number.isFinite(n.m)) : [];
    this.notes = isSortedByTime(raw) ? raw : raw.slice().sort((a, b) => (a.t - b.t) || (a.m - b.m));
    this.duration = songDuration(song);
    this.firstNoteT = this.notes.length ? this.notes[0].t : null;
    let span = EXPECT_MIN_LEN;
    for (const n of this.notes) span = Math.max(span, Number(n.d) || 0);
    this._maxSpan = span;

    this._speedOverride = null;
    this.ctx = null;
    this.synth = null;
    this.backing = null;
    this.backingError = null;
    this.clock = new GameClock({ speed: this._readSpeed() });
    this._speed = this.clock.speed;
    this.judge = null;
    this._judgeUnsub = null;
    this._buildJudge();

    const n = this.notes.length;
    this._autoStates = this.mode === 'listen' ? new Array(n).fill('pending') : null;
    this._autoJudgedAt = this.mode === 'listen' ? new Float64Array(n).fill(NaN) : null;
    this._autoCursor = 0;
    this._simPlayed = new Uint8Array(n);
    this._simRetryAt = 0;
    this._simDestCache = null;

    this._state = 'ready';
    this._pressed = new Set();
    this._expected = new Set();
    this._touchVoices = new Map();
    this._voices = [];            // scheduled chart-audio voices { h, songT, end }
    this._unsubs = [];
    this._inputSubscribed = false;
    this._preparePromise = null;
    this._destroyed = false;
    this._finishEmitted = false;

    this._schedFrom = 0;
    this._schedNote = 0;
    this._lastSync = 0;
    this._acceptFrom = -Infinity;
    this._releaseStrikeRaw = -Infinity;
    this._holdT = 0;
    this._holdMidis = EMPTY;
    this._hint = null;
    this._echo = null;
    this._pausedFrom = 'playing';
    this._resumeAtPerf = 0;
    this._lastCountdown = null;
    this._suspendedSince = 0;
    this._lastSongTime = 0;
    this._lastSnapshot = null;

    this._onNote = (evt) => this._handleInputNote(evt);
    this._startSongTime = this._computeStartTime();
  }

  get state() { return this._state; }
  get stats() { return this.judge.stats; }
  get speed() { return this._speed; }
  get startSongTime() { return this._startSongTime; }

  // ---------------------------------------------------------------- lifecycle

  prepare() {
    if (this._destroyed) return Promise.resolve();
    if (!this._preparePromise) this._preparePromise = this._prepare();
    return this._preparePromise;
  }

  async _prepare() {
    this._ensureAudio();
    if (this.audioBlob && this.song.audio) {
      const bt = new BackingTrack();
      try {
        await bt.load(this.audioBlob);
        if (this._destroyed) {
          bt.dispose();
          return;
        }
        this.backing = bt;
        this._applyBackingVolume();
        bt.setRate(this._speed);
        // start() was called before loading finished: join in at the current position.
        if (this._state === 'playing') bt.play(this.clock.time(this._now()), this._speed, this._audioOffset());
      } catch (err) {
        bt.dispose();
        this.backingError = err;
        this.emit('warning', (err && err.message) || '반주 음원을 불러오지 못했어요.');
      }
    }
    if (this._state === 'ready') this._startSongTime = this._computeStartTime();
  }

  start() {
    if (this._destroyed) return;
    this._ensureAudio();
    this._resumeContext();
    this._stopAllAudio();
    if (this.backing) this.backing.pause();

    this._speed = this._readSpeed();
    this.clock = new GameClock({ speed: this._speed });
    this._buildJudge();
    if (this._autoStates) {
      this._autoStates.fill('pending');
      this._autoJudgedAt.fill(NaN);
    }
    this._autoCursor = 0;
    this._simPlayed.fill(0);
    this._finishEmitted = false;
    this._hint = null;
    this._echo = null;
    this._holdMidis = EMPTY;
    this._releaseStrikeRaw = -Infinity;
    this._lastCountdown = null;
    this._suspendedSince = 0;

    this._startSongTime = this._computeStartTime();
    const now = this._now();
    this.clock.start(now, this._startSongTime);
    this._acceptFrom = now;
    this._lastSync = now;
    this._resetScheduler(this._startSongTime);
    if (this.backing) this.backing.play(this._startSongTime, this._speed, this._audioOffset());
    if (this.mode !== 'calibrate') this.synth.sfx('start');
    this._setState('playing');
  }

  restart() {
    this.start();
  }

  pause() {
    const st = this._state;
    if (st !== 'playing' && st !== 'holding' && st !== 'resuming') return;
    if (st !== 'resuming') {
      this._pausedFrom = st;
      this.clock.pause(this._now());
    }
    this._stopAllAudio();
    if (this.backing) this.backing.pause();
    if (this._hint && !this._hint.done) this._hint.atPerf = null;
    this._setState('paused');
  }

  resume() {
    if (this._state !== 'paused') return;
    this._resumeContext();
    this._resumeAtPerf = perfNow() + RESUME_COUNTDOWN * 1000;
    this._lastCountdown = null;
    this._setState('resuming');
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const u of this._unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    this._unsubs = [];
    this._inputSubscribed = false;
    if (this._judgeUnsub) this._judgeUnsub();
    this._judgeUnsub = null;
    if (this.synth) this.synth.dispose();
    if (this.backing) this.backing.dispose();
    this.backing = null;
    this._voices = [];
    this._touchVoices.clear();
    this._pressed.clear();
    if (typeof this.removeAll === 'function') this.removeAll();
  }

  // Extra (not required by the screen): change speed mid-session; re-anchors clock, judge and audio.
  setSpeed(speed) {
    if (this.mode === 'calibrate' || this._destroyed) return;
    const s = clamp(Number(speed) || 1, 0.25, 2);
    this._speedOverride = s;
    if (s === this._speed) return;
    const running = this._state === 'playing';
    const now = this._state === 'ready' ? 0 : this._now();
    const songTime = this.clock.time(now);
    this.clock.setSpeed(s, now);
    this._speed = this.clock.speed;
    this.judge.setSpeed(this._speed);
    if (this.backing) this.backing.setRate(this._speed);
    if (running) {
      this._cancelAfter(songTime);
      this._resetScheduler(songTime);
      if (this.backing) this.backing.play(songTime, this._speed, this._audioOffset());
    }
  }

  // Extra: merge new setting values (speed, guideMelody, metronome, latency, volumes, ...).
  updateSettings(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    if (typeof this.settings.get === 'function') {
      this.settings = { ...this.settings.all?.(), ...partial };
    } else {
      this.settings = { ...this.settings, ...partial };
    }
    if ('speed' in partial) this.setSpeed(partial.speed);
    if ('backingVolume' in partial) this._applyBackingVolume();
    if ('a4' in partial && this.synth) this.synth.setA4(this._opt('a4', 440));
    if ('masterVolume' in partial) this._applyMasterVolume();
  }

  // ---------------------------------------------------------------- input

  touchDown(midi) {
    if (this._destroyed) return;
    const m = Math.round(Number(midi));
    if (!Number.isFinite(m)) return;
    this._pressed.add(m);
    if (this._shouldSoundTouch()) {
      const prev = this._touchVoices.get(m);
      if (prev) prev.stop(this.ctx.currentTime);
      this._touchVoices.set(m, this.synth.playNote(m, this.ctx.currentTime, 8, { velocity: 0.75 }));
    }
    if (this.mode === 'listen') return;
    if (this._state === 'playing') {
      this.judge.input({ time: this.clock.time(this._now()), midi: m });
    } else if (this._state === 'holding') {
      this._hitHeld(m, null);
    }
  }

  touchUp(midi) {
    const m = Math.round(Number(midi));
    if (!Number.isFinite(m)) return;
    this._pressed.delete(m);
    const v = this._touchVoices.get(m);
    if (v) {
      this._touchVoices.delete(m);
      if (this.ctx) v.stop(this.ctx.currentTime);
    }
  }

  _handleInputNote(evt) {
    if (this._destroyed || !evt || this.mode === 'listen') return;
    if (this._opt('inputMode', 'mic') === 'touch') return;
    const st = this._state;
    if (st !== 'playing' && st !== 'holding') return;
    const raw = Number(evt.time);
    const midi = Number(evt.midi);
    if (!Number.isFinite(raw) || !Number.isFinite(midi)) return;
    const tc = raw - this._latency();
    if (tc < this._acceptFrom - 0.05) return;                         // from before (re)start
    if (Math.abs(raw - this._releaseStrikeRaw) <= SAME_STRIKE) return; // rest of the strike that released a hold
    const echo = this._echo;
    if (echo && raw >= echo.from && raw <= echo.until && echo.pcs.has(pitchClass(midi))) return;
    if (st === 'holding') {
      this._hitHeld(midi, raw);
    } else {
      this.judge.input({ time: this.clock.toSong(tc), midi });
    }
  }

  _hitHeld(midi, rawTime) {
    const results = this.judge.hitHeld(midi);
    if (!results.length) return;
    const fp = this.judge.firstPending();
    if (fp < 0 || this.notes[fp].t > this._holdT + GROUP_EPS + EPS) {
      if (rawTime !== null) this._releaseStrikeRaw = rawTime;
      this._releaseHold();
    } else {
      this._holdMidis = this.judge.pendingGroup().map((i) => this.notes[i].m);
    }
  }

  // ---------------------------------------------------------------- frame update

  tick() {
    if (this._destroyed) return this._lastSnapshot || this._snapshot(this._lastSongTime, null);
    if (this._state === 'ready') return this._snapshot(this._startSongTime, null);

    const now = this._now();
    this._watchSuspend();
    let countdown = null;

    if (this._state === 'resuming') {
      const remain = (this._resumeAtPerf - perfNow()) / 1000;
      if (remain <= 0) {
        this._finishResume(now);
      } else {
        countdown = clamp(Math.ceil(remain / (RESUME_COUNTDOWN / 3) - EPS), 1, 3);
        if (countdown !== this._lastCountdown && this.mode !== 'calibrate' && this.synth) this.synth.sfx('count');
        this._lastCountdown = countdown;
      }
    }

    let songTime = this.clock.time(now);

    if (this._state === 'playing') {
      if (this.mode === 'practice') {
        const fp = this.judge.firstPending();
        if (fp >= 0 && songTime >= this.notes[fp].t) {
          this._enterHold(now, fp);
          songTime = this.clock.time(now);
        }
      }
    }

    if (this._state === 'playing') {
      if (this.mode === 'listen') this._advanceAuto(songTime);
      else this.judge.update(songTime);
      this._scheduleAudio(songTime);
      if (this.backing && now - this._lastSync >= SYNC_INTERVAL) {
        this._lastSync = now;
        this.backing.sync(songTime);
      }
      if (this.firstNoteT !== null) {
        const rem = (this.firstNoteT - songTime) / this._speed;
        if (rem > 0 && rem <= COUNTDOWN) countdown = clamp(Math.ceil(rem - EPS), 1, COUNTDOWN);
      }
      this._checkFinish(songTime, now);
    } else if (this._state === 'holding') {
      this._updateHint();
      if (this._simActive() && perfNow() >= this._simRetryAt) this._replayHeldSim();
    }

    this._lastSongTime = songTime;
    const snap = this._snapshot(songTime, countdown);
    this._lastSnapshot = snap;
    return snap;
  }

  _snapshot(songTime, countdown) {
    this._computeExpected(songTime);
    const listen = this.mode === 'listen';
    const input = this.input;
    const inputMode = this._opt('inputMode', 'mic');
    const detected = input && inputMode !== 'touch' ? input.analysis || null : null;
    return {
      songTime,
      state: this._state,
      mode: this.mode,
      speed: this._speed,
      countdown,
      notes: this.notes,
      states: listen ? this._autoStates : this.judge.states,
      judgedAt: listen ? this._autoJudgedAt : this.judge.judgedAt,
      expectedKeys: this._expected,
      pressedKeys: this._pressed,
      detected,
      stats: this.judge.stats,
      progress: this.duration > 0 ? clamp(songTime / this.duration, 0, 1) : 0,
      holdingNotes: this._state === 'holding' || (this._state !== 'playing' && this.clock.held) ? this._holdMidis : EMPTY,
    };
  }

  _computeExpected(songTime) {
    const set = this._expected;
    set.clear();
    const notes = this.notes;
    if (!notes.length) return;
    if (this.mode === 'listen') {
      for (let i = lowerBound(notes, songTime - this._maxSpan); i < notes.length; i++) {
        const n = notes[i];
        if (n.t > songTime + 0.02) break;
        if (songTime >= n.t - 0.02 && songTime < n.t + n.d) set.add(n.m);
      }
    } else {
      const states = this.judge.states;
      for (let i = lowerBound(notes, songTime - this._maxSpan); i < notes.length; i++) {
        const n = notes[i];
        if (n.t - EXPECT_BEFORE > songTime) break;
        if (states[i] === 'pending' && songTime <= n.t + Math.max(n.d, EXPECT_MIN_LEN)) set.add(n.m);
      }
    }
    if (this._state === 'holding' || this.clock.held) for (const m of this._holdMidis) set.add(m);
  }

  _advanceAuto(songTime) {
    const notes = this.notes;
    while (this._autoCursor < notes.length && notes[this._autoCursor].t <= songTime) {
      const i = this._autoCursor++;
      this._autoStates[i] = 'auto';
      this._autoJudgedAt[i] = notes[i].t;
    }
  }

  _checkFinish(songTime, now) {
    if (this._finishEmitted) return;
    if (songTime <= this.duration + 1) return;
    if (this.mode !== 'listen' && this.judge.firstPending() !== -1) return;
    this._finishEmitted = true;
    this.clock.pause(now);
    this._cancelAfter(songTime);
    if (this.backing) this.backing.pause();
    if (this.mode !== 'calibrate' && this.synth) this.synth.sfx('finish');
    this._setState('finished');
    this.emit('finish', this.judge.stats);
  }

  // ---------------------------------------------------------------- practice holds

  _enterHold(now, index) {
    const t = this.notes[index].t;
    this._holdT = t;
    this.clock.hold(now, t);
    this._cancelAfter(t + GROUP_EPS);
    if (this.backing) this.backing.pause();
    this._holdMidis = this.judge.pendingGroup().map((i) => this.notes[i].m);
    this._hint = this._opt('guideMelody', false)
      ? { atPerf: perfNow() + (this._micActive() ? HINT_DELAY_MIC * 1000 : 0), done: false }
      : null;
    this._setState('holding');
    this._updateHint();
    if (this._simActive()) {
      // Normally the held notes were already played into the detector; replay any that were skipped.
      const missing = this.judge.pendingGroup().some((i) => !this._simPlayed[i]);
      if (missing) this._replayHeldSim();
      else this._simRetryAt = perfNow() + SIM_RETRY_MS;
    }
  }

  _replayHeldSim() {
    this._simRetryAt = perfNow() + SIM_RETRY_MS;
    if (!this.synth) return;
    const ctxNow = this.ctx.currentTime;
    const dest = this._simDest();
    for (const i of this.judge.pendingGroup()) {
      const n = this.notes[i];
      this._simPlayed[i] = 1;
      const h = this.synth.playNote(n.m, ctxNow + 0.02, clamp(n.d / this._speed, 0.2, 1), { velocity: 0.8, destination: dest });
      this._voices.push({ h, songT: this._holdT, end: h.end });
    }
  }

  _updateHint() {
    const hint = this._hint;
    if (!hint || hint.done || hint.atPerf === null || perfNow() < hint.atPerf || !this.synth) return;
    hint.done = true;
    const ctxNow = this.ctx.currentTime;
    const pcs = new Set();
    for (const i of this.judge.pendingGroup()) {
      const n = this.notes[i];
      pcs.add(pitchClass(n.m));
      const h = this.synth.playNote(n.m, ctxNow, clamp(n.d / this._speed, 0.25, 1.5), { velocity: n.v ?? 0.75 });
      this._voices.push({ h, songT: this._holdT, end: h.end });
    }
    if (this._micActive() && pcs.size) {
      this._echo = { from: ctxNow, until: ctxNow + HINT_ECHO_GUARD + Math.max(0, this._latency()), pcs };
    }
  }

  _releaseHold() {
    const now = this._now();
    this.clock.release(now);
    this._hint = null;
    this._holdMidis = EMPTY;
    if (this._state === 'holding') {
      this._resetScheduler(this._holdT + GROUP_EPS + EPS);
      if (this.backing) this.backing.play(this._holdT, this._speed, this._audioOffset());
      this._lastSync = now;
      this._setState('playing');
    }
  }

  _finishResume(now) {
    this.clock.resume(now);
    this._acceptFrom = now;
    this._lastCountdown = null;
    if (this.clock.held) {
      if (this._hint && !this._hint.done) {
        this._hint.atPerf = perfNow() + (this._micActive() ? HINT_DELAY_MIC * 1000 : 0);
      }
      this._setState('holding');
      if (this._simActive()) this._replayHeldSim(); // the pause cut the held notes' sound
      return;
    }
    const songTime = this.clock.time(now);
    this._resetScheduler(songTime);
    if (this.backing) this.backing.play(songTime, this._speed, this._audioOffset());
    this._lastSync = now;
    this._setState('playing');
  }

  // ---------------------------------------------------------------- audio scheduling

  _resetScheduler(fromSong) {
    this._schedFrom = fromSong;
    this._schedNote = lowerBound(this.notes, fromSong - EPS);
  }

  _scheduleAudio(songTime) {
    if (!this.synth) return;
    const horizon = songTime + SCHEDULE_AHEAD * this._speed;
    const from = this._schedFrom;
    if (horizon <= from) return;
    const ctxNow = this.ctx.currentTime;
    this._pruneVoices(ctxNow);

    const notes = this.notes;
    const sim = this._simActive();
    const guide = this._guideActive();
    let i = this._schedNote;
    if (sim || guide) {
      const dest = sim ? this._simDest() : undefined;
      for (; i < notes.length && notes[i].t < horizon; i++) {
        const n = notes[i];
        if (n.t < from - EPS) continue;
        const when = this.clock.toCtx(n.t);
        if (when < ctxNow - LATE_TOLERANCE) continue;
        const vel = Number.isFinite(n.v) ? clamp(n.v, 0.4, 1) : 0.8;
        const h = this.synth.playNote(n.m, when, Math.max(0.05, n.d / this._speed), { velocity: vel, destination: dest });
        this._voices.push({ h, songT: n.t, end: h.end });
        if (sim) this._simPlayed[i] = 1;
      }
    } else {
      while (i < notes.length && notes[i].t < horizon) i++;
    }
    this._schedNote = i;

    if (this.mode !== 'calibrate') {
      if (this._opt('metronome', false)) this._scheduleBeats(from, horizon, ctxNow);
      this._scheduleCountIn(from, horizon, ctxNow);
    }
    this._schedFrom = horizon;
  }

  _scheduleBeats(from, horizon, ctxNow) {
    const bpm = clamp(Number(this.song.bpm) || 100, 20, 400);
    const beat = 60 / bpm;
    const offset = Number(this.song.offset) || 0;
    const perBar = Math.max(1, Math.round(Number(this.song.beatsPerBar) || 4));
    // Half-open windows [from, horizon) chained exactly, so a beat on a boundary is scheduled once.
    for (let k = Math.ceil((from - offset) / beat) - 1; ; k++) {
      const t = offset + k * beat;
      if (t >= horizon) break;
      if (t < from) continue;
      const when = this.clock.toCtx(t);
      if (when < ctxNow - LATE_TOLERANCE) continue;
      const h = this.synth.click(when, ((k % perBar) + perBar) % perBar === 0);
      this._voices.push({ h, songT: t, end: h.end });
    }
  }

  _scheduleCountIn(from, horizon, ctxNow) {
    if (this.firstNoteT === null) return;
    for (let k = COUNTDOWN; k >= 1; k--) {
      const t = this.firstNoteT - k * this._speed;
      if (t < from || t >= horizon || t < this._startSongTime - EPS) continue;
      const when = this.clock.toCtx(t);
      if (when < ctxNow - LATE_TOLERANCE) continue;
      this.synth.sfx('count', when);
    }
  }

  // Stop scheduled chart audio belonging to song times after `songCut` (not-yet-started voices are
  // dropped silently; anything already sounding fades out quickly).
  _cancelAfter(songCut) {
    const keep = [];
    for (const v of this._voices) {
      if (v.songT > songCut + EPS) v.h.stop();
      else keep.push(v);
    }
    this._voices = keep;
  }

  _pruneVoices(ctxNow) {
    const list = this._voices;
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      if (list[r].end >= ctxNow) list[w++] = list[r];
    }
    list.length = w;
  }

  _stopAllAudio() {
    if (this.synth) this.synth.stopAll();
    this._voices.length = 0;
    this._touchVoices.clear();
  }

  // ---------------------------------------------------------------- helpers

  _ensureAudio() {
    if (!this.synth) {
      this.ctx = getAudioContext();
      this.synth = new Synth(this.ctx);
      this.synth.setA4(this._opt('a4', 440));
      this._applyMasterVolume();
    }
    if (this.input && !this._inputSubscribed && typeof this.input.on === 'function') {
      this._unsubs.push(this.input.on('note', this._onNote));
      this._inputSubscribed = true;
    }
  }

  _resumeContext() {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => { /* needs a user gesture; the screen unlocks audio on start */ });
    }
  }

  // Auto-pause if the audio context gets suspended/interrupted while playing (e.g. backgrounded).
  _watchSuspend() {
    const st = this._state;
    const ctx = this.ctx;
    if (!ctx || (st !== 'playing' && st !== 'holding') || ctx.state === 'running') {
      this._suspendedSince = 0;
      return;
    }
    const p = perfNow();
    if (!this._suspendedSince) {
      this._suspendedSince = p;
      this._resumeContext();
    } else if (p - this._suspendedSince > SUSPEND_PAUSE_MS) {
      this._suspendedSince = 0;
      this.pause();
    }
  }

  // Visual/scheduling time base: smoothed AudioContext time; falls back to the raw context time when
  // the smoothed value has drifted (e.g. right after the context was suspended).
  _now() {
    const ctx = this.ctx || getAudioContext();
    if (!this.ctx) this.ctx = ctx;
    let a;
    try { a = audioNow(); } catch { a = NaN; }
    const c = ctx.currentTime;
    if (!Number.isFinite(a) || (ctx.state === 'running' && Math.abs(a - c) > 0.25)) return c;
    return a;
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }

  _opt(key, fallback) {
    const s = this.settings;
    if (!s) return fallback;
    let v;
    if (Object.prototype.hasOwnProperty.call(s, key)) v = s[key];
    else if (typeof s.get === 'function') v = s.get(key);
    return v === undefined || v === null ? fallback : v;
  }

  _readSpeed() {
    if (this.mode === 'calibrate') return 1;
    if (this._speedOverride !== null && this._speedOverride !== undefined) return this._speedOverride;
    return clamp(Number(this._opt('speed', 1)) || 1, 0.25, 2);
  }

  _latency() {
    if (this.mode === 'calibrate' || !this._micActive()) return 0;
    return clamp(Number(this._opt('latency', 0.1)) || 0, -0.2, 0.6);
  }

  _micActive() {
    if (this._opt('inputMode', 'mic') !== 'mic') return false;
    return !this.input || this.input.mode !== 'sim';
  }

  _simActive() {
    return this.mode !== 'calibrate' && this._opt('inputMode', 'mic') === 'sim' && !!this.input && !!this.input.simInput;
  }

  _guideActive() {
    if (this.mode === 'listen') return true;
    return this.mode === 'play' && !!this._opt('guideMelody', false);
  }

  // Simulated input: audible through the synth bus and fed into the detector's input node.
  _simDest() {
    const node = this.input.simInput;
    if (!this._simDestCache || this._simDestCache[1] !== node) this._simDestCache = [this.synth.output, node];
    return this._simDestCache;
  }

  _shouldSoundTouch() {
    return !!this.synth && this._opt('inputMode', 'mic') !== 'mic';
  }

  _audioOffset() {
    const o = this.song.audio ? Number(this.song.audio.offset) : 0;
    return Number.isFinite(o) ? o : 0;
  }

  _applyBackingVolume() {
    if (!this.backing) return;
    const songVol = this.song.audio && Number.isFinite(Number(this.song.audio.volume)) ? Number(this.song.audio.volume) : 1;
    this.backing.setVolume(clamp(songVol, 0, 1) * clamp(Number(this._opt('backingVolume', 0.8)), 0, 1));
  }

  _applyMasterVolume() {
    try {
      setMasterVolume(clamp(Number(this._opt('masterVolume', 0.8)), 0, 1));
    } catch (err) {
      console.warn('[GameSession] setMasterVolume failed', err);
    }
  }

  _computeStartTime() {
    let first = this.firstNoteT;
    if (first === null) {
      const lines = this.song.lyrics && Array.isArray(this.song.lyrics.lines) ? this.song.lyrics.lines : [];
      first = Infinity;
      for (const line of lines) {
        const syl = line && line.syllables && line.syllables[0];
        if (syl && Number.isFinite(syl.t)) first = Math.min(first, syl.t);
      }
      if (!Number.isFinite(first)) first = 0;
    }
    const lead = Math.max(3, Number(this._opt('lookahead', 2.5)) || 2.5) + 0.5;
    const hasBacking = !!(this.backing && this.backing.loaded);
    if (!hasBacking && first > 4) return first - lead;
    return Math.min(0, first - lead);
  }

  _buildJudge() {
    if (this._judgeUnsub) this._judgeUnsub();
    const opts = {
      difficulty: this._opt('difficulty', 'normal'),
      octaveTolerant: !!this._opt('octaveTolerant', true),
      speed: this._speed,
      // Mic detections arrive late by the input latency on top of the analysis delay.
      grace: 0.15 + Math.max(0, this._latency()),
    };
    if (this.mode === 'practice') opts.noMiss = true;
    if (this.mode === 'calibrate') {
      opts.anyPitch = true;
      opts.windows = CALIBRATE_WINDOWS;
    }
    this.judge = new Judge(this.notes, opts);
    this._judgeUnsub = this.judge.on('judge', (r) => this.emit('judge', r));
  }
}
