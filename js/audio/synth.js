// Lightweight piano-like synthesizer (guide melody, simulated input, metronome, UI sounds).
// The voice is additive (strong fundamental + decaying harmonics) so that it is both pleasant and
// reliably recognised by the harmonic-salience pitch detector.
import { getAudioContext, masterOut } from './engine.js';

const MAX_VOICES = 28;
const ATTACK = 0.004;
const RELEASE_TAU = 0.07;   // note-off release time constant
const KILL_TAU = 0.012;     // fast fade for stop()/stopAll()
const KILL_TAIL = 0.09;     // how long after a kill the sources are stopped

// Harmonic amplitudes (k = 1..12): fundamental-dominant, roughly k^-1.3 with a slightly weaker 3rd.
const HARMONICS = [1, 0.6, 0.36, 0.27, 0.18, 0.13, 0.09, 0.065, 0.045, 0.032, 0.022, 0.015];

const waveCache = new WeakMap();
const noiseCache = new WeakMap();

function pianoWave(ctx) {
  let wave = waveCache.get(ctx);
  if (!wave) {
    const n = HARMONICS.length + 1;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) imag[k] = HARMONICS[k - 1];
    wave = ctx.createPeriodicWave(real, imag);
    waveCache.set(ctx, wave);
  }
  return wave;
}

function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = Math.max(1, Math.round(ctx.sampleRate * 0.05));
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const white = ((seed >>> 0) / 4294967296) * 2 - 1;
      data[i] = white * Math.exp(-i / (ctx.sampleRate * 0.007));
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function toDestinations(dest, fallback) {
  if (Array.isArray(dest)) {
    const list = dest.filter(Boolean);
    return list.length ? list : [fallback];
  }
  return [dest || fallback];
}

export class Synth {
  constructor(ctx, destination) {
    this.ctx = ctx || getAudioContext();
    this.a4 = 440;
    this._voices = new Set();
    this._volume = 1;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(destination || masterOut());
    this._disposed = false;
  }

  // Output bus of this synth (pass it, together with another node, as `destination` to tee a voice).
  get output() { return this.out; }
  get voiceCount() { return this._voices.size; }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1.5);
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(this._volume, now, 0.02);
  }

  setA4(hz) {
    const v = Number(hz);
    if (Number.isFinite(v) && v >= 380 && v <= 500) this.a4 = v;
  }

  freqOf(midi) {
    return this.a4 * Math.pow(2, (midi - 69) / 12);
  }

  // Piano-ish voice. `destination` may be a node or an array of nodes (e.g. [synth.output, input.simInput]).
  // Returns a handle { stop(when), start, end }.
  playNote(midi, when, duration, { velocity = 0.8, destination } = {}) {
    if (this._disposed) return dummyHandle();
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const m = Number(midi);
    if (!Number.isFinite(m)) return dummyHandle();
    const t0 = Math.max(now, Number.isFinite(when) ? when : now);
    const dur = Math.max(0.03, Number.isFinite(duration) ? duration : 0.5);
    const vel = clamp(Number.isFinite(velocity) ? velocity : 0.8, 0.05, 1);
    const f = this.freqOf(m);
    const nyq = ctx.sampleRate / 2;

    const peak = 0.26 * (0.3 + 0.7 * vel);
    // Lower notes ring longer, like a real piano.
    const decayTau = clamp(1.5 * Math.pow(2, (60 - m) / 24), 0.35, 3.2);
    const tEnd = t0 + dur;
    const stage2 = t0 + ATTACK + 0.2;
    const stopAt = Math.max(t0 + 0.06, Math.min(tEnd + RELEASE_TAU * 6, Math.max(stage2, t0) + decayTau * 7));

    this._makeRoom();

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const wave = pianoWave(ctx);
    osc1.setPeriodicWave(wave);
    osc2.setPeriodicWave(wave);
    osc1.frequency.value = f;
    osc2.frequency.value = f;
    // Two slightly detuned "strings" give a gentle, slow chorus.
    osc1.detune.value = -1;
    osc2.detune.value = 1.5;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0;
    const fcStart = clamp(f * (5 + 9 * vel), 1500, nyq * 0.9);
    const fcEnd = clamp(f * 4, 900, fcStart);
    filter.frequency.setValueAtTime(fcStart, t0);
    filter.frequency.setTargetAtTime(fcEnd, t0 + ATTACK, 0.35);

    const env = ctx.createGain();
    const eg = env.gain;
    eg.value = 0;
    eg.setValueAtTime(0, t0);
    eg.linearRampToValueAtTime(peak, t0 + ATTACK);
    eg.setTargetAtTime(peak * 0.5, t0 + ATTACK, 0.09);
    if (stage2 < tEnd) eg.setTargetAtTime(0, stage2, decayTau);
    eg.setTargetAtTime(0, tEnd, RELEASE_TAU);

    const kill = ctx.createGain();
    kill.gain.value = 1;

    osc1.connect(filter);
    osc2.connect(g2);
    g2.connect(filter);
    filter.connect(env);
    env.connect(kill);
    for (const d of toDestinations(destination, this.out)) {
      try { kill.connect(d); } catch (err) { console.warn('[Synth] connect failed', err); }
    }

    osc1.start(t0);
    osc2.start(t0);
    osc1.stop(stopAt);
    osc2.stop(stopAt);

    return this._register({
      start: t0,
      end: stopAt,
      sources: [osc1, osc2],
      nodes: [osc1, osc2, g2, filter, env, kill],
      kill,
    });
  }

  // Metronome tick: band-passed noise burst (unpitched, so the pitch detector mostly ignores it).
  click(when, accent = false) {
    if (this._disposed) return dummyHandle();
    const ctx = this.ctx;
    const t0 = Math.max(ctx.currentTime, Number.isFinite(when) ? when : ctx.currentTime);
    this._makeRoom();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = accent ? 2700 : 1900;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.value = accent ? 0.9 : 0.55;
    const kill = ctx.createGain();
    src.connect(bp);
    bp.connect(g);
    g.connect(kill);
    kill.connect(this.out);
    const end = t0 + src.buffer.duration;
    src.start(t0);
    src.stop(end);
    return this._register({ start: t0, end, sources: [src], nodes: [src, bp, g, kill], kill });
  }

  // Short, quiet UI sounds: 'start' | 'finish' | 'count'. Optional `when` (ctx time).
  sfx(name, when) {
    if (this._disposed) return;
    const ctx = this.ctx;
    const t = Math.max(ctx.currentTime, Number.isFinite(when) ? when : ctx.currentTime);
    switch (name) {
      case 'count':
        this._tone(1318.5, t, 0.09, 0.09, 'sine');
        break;
      case 'start':
        this._tone(659.25, t, 0.12, 0.07, 'triangle');
        this._tone(987.77, t + 0.09, 0.22, 0.07, 'triangle');
        break;
      case 'finish': {
        const seq = [523.25, 659.25, 783.99, 1046.5];
        seq.forEach((fr, i) => this._tone(fr, t + i * 0.09, i === seq.length - 1 ? 0.7 : 0.25, 0.07, 'triangle'));
        break;
      }
      default:
        break;
    }
  }

  // Stop everything (scheduled or sounding) with a fast fade to avoid clicks.
  stopAll() {
    const now = this.ctx.currentTime;
    for (const v of Array.from(this._voices)) this._stopVoice(v, now);
  }

  dispose() {
    if (this._disposed) return;
    this.stopAll();
    this._disposed = true;
    const out = this.out;
    setTimeout(() => {
      try { out.disconnect(); } catch { /* already disconnected */ }
    }, 200);
  }

  _tone(freq, t0, dur, gain, type) {
    const ctx = this.ctx;
    this._makeRoom();
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    const g = env.gain;
    g.value = 0;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(gain, t0 + 0.005);
    g.setTargetAtTime(0, t0 + 0.005, dur / 4);
    const kill = ctx.createGain();
    osc.connect(env);
    env.connect(kill);
    kill.connect(this.out);
    const end = t0 + dur + 0.05;
    osc.start(t0);
    osc.stop(end);
    this._register({ start: t0, end, sources: [osc], nodes: [osc, env, kill], kill });
  }

  _register(v) {
    v.stopped = false;
    v.cleaned = false;
    this._voices.add(v);
    v.sources[0].onended = () => this._cleanup(v);
    const handle = {
      start: v.start,
      end: v.end,
      stop: (when) => this._stopVoice(v, when),
    };
    return handle;
  }

  _stopVoice(v, when) {
    if (v.stopped || v.cleaned) return;
    v.stopped = true;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = Math.max(now, Number.isFinite(when) ? when : now);
    // Not started yet at `t`: mute and stop at t (a stop before the start time never sounds).
    const notStarted = t < v.start - 0.001;
    try {
      if (notStarted) v.kill.gain.setValueAtTime(0, t);
      else v.kill.gain.setTargetAtTime(0, t, KILL_TAU);
    } catch { /* ignore */ }
    const stopAt = notStarted ? t : Math.min(v.end, t + KILL_TAIL);
    try {
      for (const s of v.sources) s.stop(stopAt);
      v.end = stopAt;
    } catch {
      // Older engines refuse a second stop(); the original stop time still applies and the fade silences it.
    }
    // onended does not fire on a suspended/closed context; make sure we never leak voices.
    if (ctx.state !== 'running') this._cleanup(v);
  }

  _cleanup(v) {
    if (v.cleaned) return;
    v.cleaned = true;
    this._voices.delete(v);
    for (const n of v.nodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  }

  _makeRoom() {
    const now = this.ctx.currentTime;
    // Drop bookkeeping for voices that should long be over (e.g. onended missed while suspended).
    if (this._voices.size >= MAX_VOICES / 2) {
      for (const v of this._voices) if (v.end < now - 1) this._cleanup(v);
    }
    if (this._voices.size < MAX_VOICES) return;
    // Steal the oldest still-active voice.
    let oldest = null;
    for (const v of this._voices) {
      if (v.stopped) continue;
      if (!oldest || v.start < oldest.start) oldest = v;
    }
    if (oldest) this._stopVoice(oldest, now);
    // Voices that were stopped but are still fading count too; hard-limit bookkeeping size.
    if (this._voices.size >= MAX_VOICES * 2) {
      let first = null;
      for (const v of this._voices) { first = v; break; }
      if (first) {
        try { for (const s of first.sources) s.stop(now); } catch { /* ignore */ }
        this._cleanup(first);
      }
    }
  }
}

function dummyHandle() {
  return { start: 0, end: 0, stop() {} };
}
