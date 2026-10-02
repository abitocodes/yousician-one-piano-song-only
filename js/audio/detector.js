// Piano note detector: onset detection + pitch / multi-pitch estimation on a mono sample stream.
// Pure and stateful (no Web Audio); fed by AudioInput, unit-tested in Node.

import {
  magnitudeSpectrum, toDb, yin, salienceVector, cancelHarmonics, clearHarmonics, hzToMidi, midiToHz, SAL_LO, SAL_HI,
} from './dsp.js';

const SAL_N = SAL_HI - SAL_LO + 1;
const FRAME_RING = 16; // analysis frames kept (≈ 340 ms)
const SUB_RING = 128; // 128-sample sub-block energies kept (≈ 340 ms)
const HOP_RING = 32;
const FLUX_MEDIAN = 15;

const EVIDENCE = 0.055; // s of audio collected after an onset before deciding its notes
const REFRACTORY = 0.07; // min s between onsets
const PC_GUARD = 0.12; // pitch-change events need no onset within this many s
const PC_FRAMES = 3; // frames a YIN pitch must be stable for a pitch-change event
const PC_MIN_SAL = 0.3; // a stable YIN pitch needs this fraction of the frame's top salience to count as a note
const PC_HOLD = 0.2; // s after a pitch-change event during which an onset does not report the same pitch again
// A re-strike's onset flux on odd partials (1, 3, 5) relative to the even ones (2, 4, 6): at least RESTRIKE_ODD_MIN,
// and RESTRIKE_ODD when a note 1-2 octaves up has UP_PROMINENT of the top salience after the onset.
const RESTRIKE_ODD_MIN = 0.05;
const RESTRIKE_ODD = 0.3;
const UP_PROMINENT = 0.35;
const MAX_ITER = 5; // iterative multi-pitch estimation depth
// While the gate is closed, frames are still analysed when the level is this far above the noise floor: a note that
// rang out below the gate must not look like silence to the next onset (it would be taken for the new note).
const RESIDUAL_DB = 6;
const YIN_OPTIONS = { threshold: 0.15, minFreq: 60, maxFreq: 2200 };
// Energy share the strongest harmonic series must explain on its own: noise (knocks, rustle) spreads a similar total
// over many weak "series" (< 0.1 each), while a note or a chord's main note explains far more (> 0.3).
const MIN_TOP_SHARE = 0.15;

// Intervals (semitones) at which partials 3, 5, 6, 7, 9, 10, 12 of a note fall: candidates there may be ghosts.
const PARTIAL_INTERVALS = [19, 28, 31, 34, 38, 40, 43];

const pcOf = (m) => ((m % 12) + 12) % 12;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function makeFrame(bins) {
  return {
    time: -Infinity, db: -120, silent: true, mag: new Float32Array(bins), sal: new Float32Array(SAL_N), cands: [],
    harm: 0, yin: null, lazy: false,
  };
}

export class NoteDetector {
  constructor({ sampleRate, sensitivity = 0.6, a4 = 440 } = {}) {
    if (!(sampleRate > 0)) throw new RangeError('NoteDetector: sampleRate is required');
    this.sampleRate = sampleRate;
    const scale = Math.pow(2, Math.round(Math.log2(sampleRate / 48000)));
    this.hop = Math.max(64, Math.round(512 * scale));
    this.sub = this.hop / 4;
    this.fftSize = Math.max(1024, Math.round(4096 * scale));
    this.fluxSize = this.fftSize / 2;
    this.yinSize = this.fftSize / 2;
    this._hopSec = this.hop / sampleRate;
    this._dcR = 1 - (2 * Math.PI * 25) / sampleRate; // DC / rumble blocker pole

    this._buf = new Float32Array(this.fftSize);
    this._hopBuf = new Float32Array(this.hop);
    this._work = new Float32Array(this.fftSize / 2);
    this._tmpSal = new Float32Array(SAL_N);
    const binHz = sampleRate / this.fluxSize;
    this._fluxLo = Math.max(1, Math.round(60 / binHz));
    this._fluxHi = Math.min(this.fluxSize / 2 - 2, Math.round(5000 / binHz));
    this._fluxS = [0, 1, 2].map(() => new Float32Array(this.fluxSize / 2));
    this._fluxM = [0, 1, 2].map(() => new Float32Array(this.fluxSize / 2));
    this._fluxD = [0, 1, 2].map(() => new Float32Array(this.fluxSize / 2));
    this._onsetAcc = new Float32Array(this.fluxSize / 2);
    this._onsetSal = new Float32Array(SAL_N);
    this._bandLo = Math.max(1, Math.round(55 / (sampleRate / this.fftSize)));

    this._subE = new Float64Array(SUB_RING);
    this._subP = new Float64Array(SUB_RING);
    this._subT = new Float64Array(SUB_RING);
    this._e2Db = new Float64Array(HOP_RING);
    this._p2Db = new Float64Array(HOP_RING);
    this._p1Db = new Float64Array(HOP_RING);
    this._fluxHist = new Float64Array(HOP_RING);
    this._medScratch = new Float64Array(FLUX_MEDIAN);
    this._frames = Array.from({ length: FRAME_RING }, () => makeFrame(this.fftSize / 2));
    this._rise = new Float32Array(this.fftSize / 2);
    this._riseSal = new Float32Array(SAL_N);

    this.a4 = 440;
    this.sensitivity = 0.6;
    this.setSensitivity(sensitivity);
    this.setA4(a4);
    this.reset();
  }

  setSensitivity(s) {
    const v = clamp(Number.isFinite(+s) ? +s : 0.6, 0, 1);
    this.sensitivity = v;
    this._absGate = -40 - 25 * v; // dBFS
    this._floorMargin = 11 - 5 * v; // dB above noise floor
    this._riseDb = 9 - 4 * v; // energy rise for an onset
    this._fluxDelta = 150 - 100 * v; // dB·bins
    this._minHarm = 0.4 - 0.15 * v; // fraction of spectral energy explained by harmonic candidates
  }

  setA4(hz) {
    const v = +hz;
    this.a4 = Number.isFinite(v) && v >= 300 && v <= 600 ? v : 440;
  }

  reset() {
    this._buf.fill(0);
    this._hopFill = 0;
    this._hopCount = 0;
    this._prevSample = 0;
    this._dcX = 0;
    this._dcY = 0;
    this._lastHopE = 0;
    this._lastHopP = 0;
    this._subCount = 0;
    this._floor = null;
    this._gateOpen = false;
    this._gateDb = this._absGate;
    this._lastDb = -120;
    this._fluxCount = 0;
    for (const s of this._fluxS) s.fill(0);
    for (const d of this._fluxD) d.fill(0);
    for (const m of this._fluxM) m.fill(0);
    this._onsetAcc.fill(0);
    this._riseArmed = true;
    this._fluxArmed = true;
    this._lastOnset = -Infinity;
    this._pending = null;
    this._unresolved = null;
    this._onsetFlag = false;
    this._frameCount = 0;
    for (const f of this._frames) {
      f.time = -Infinity;
      f.silent = true;
      f.sal.fill(0);
      f.cands = [];
      f.harm = 0;
      f.yin = null;
      f.lazy = false;
    }
    this._run = { m: null, count: 0, start: 0 };
    this._curPitch = null;
    this._lastEmitted = [];
    this._pcEmit = null;
    this._time = 0;
    this._analysis = { time: 0, db: -120, gateOpen: false, pitch: null, topNotes: [], onset: false };
  }

  get analysis() {
    return this._analysis;
  }

  // Feeds mono samples; startTime is the time (s) of samples[0]. Returns the NoteEvents finalized during this call.
  push(samples, startTime) {
    const out = [];
    if (!samples || !samples.length) return out;
    const data = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    const sr = this.sampleRate;
    const t0 = Number.isFinite(startTime) ? startTime : this._time;
    const hb = this._hopBuf;
    const hop = this.hop;
    let i = 0;
    while (i < data.length) {
      const take = Math.min(hop - this._hopFill, data.length - i);
      hb.set(data.subarray(i, i + take), this._hopFill);
      this._hopFill += take;
      i += take;
      if (this._hopFill === hop) {
        this._hopFill = 0;
        this._processHop(t0 + i / sr, out);
      }
    }
    this._time = t0 + data.length / sr;
    return out;
  }

  // ---------------------------------------------------------------------------

  _processHop(endTime, out) {
    const { hop, sub } = this;
    const sr = this.sampleRate;
    const hb = this._hopBuf;
    const buf = this._buf;
    // Sanitize (NaN / absurd values would poison the trackers) and remove DC / sub-sonic rumble.
    const R = this._dcR;
    let xp = this._dcX;
    let yp = this._dcY;
    for (let j = 0; j < hop; j++) {
      let x = hb[j];
      if (!(x > -8 && x < 8)) x = 0;
      const y = x - xp + R * yp;
      xp = x;
      yp = y;
      hb[j] = y;
    }
    this._dcX = xp;
    this._dcY = yp;
    buf.copyWithin(0, hop);
    buf.set(hb, buf.length - hop);

    // Sub-block energies (plain and pre-emphasized) for onset detection / refinement.
    const start = endTime - hop / sr;
    let prev = this._prevSample;
    let hopE = 0;
    let hopP = 0;
    for (let s = 0; s < 4; s++) {
      let e = 0;
      let p = 0;
      for (let j = s * sub, end = j + sub; j < end; j++) {
        const x = hb[j];
        const y = x - 0.97 * prev;
        e += x * x;
        p += y * y;
        prev = x;
      }
      e /= sub;
      p /= sub;
      const k = this._subCount % SUB_RING;
      this._subE[k] = e;
      this._subP[k] = p;
      this._subT[k] = start + (s * sub) / sr;
      this._subCount++;
      hopE += e;
      hopP += p;
    }
    this._prevSample = prev;
    hopE /= 4;
    hopP /= 4;
    const db = toDb(Math.sqrt(hopE));
    this._lastDb = db;

    // Noise floor (fast down, slow up) and gate with hysteresis.
    const hs = this._hopSec / (512 / 48000);
    if (this._floor === null) this._floor = db;
    else if (db < this._floor) this._floor += (db - this._floor) * Math.min(1, 0.3 * hs);
    else {
      const gap = db - this._floor;
      this._floor += Math.min(gap, (gap < 6 ? 0.05 : 0.01) * hs);
    }
    if (this._floor < -110) this._floor = -110;
    const gateDb = Math.max(this._absGate, this._floor + this._floorMargin);
    this._gateDb = gateDb;
    if (!this._gateOpen && db >= gateDb) this._gateOpen = true;
    else if (this._gateOpen && db < gateDb - 3) this._closeGate();

    // Energy rise vs. the minimum of the preceding hops: 2-hop windows (robust to low-note ripple) and the
    // pre-emphasized single hop (fast, little low-frequency ripple).
    const hc = this._hopCount;
    const e2 = toDb(Math.sqrt(0.5 * (hopE + this._lastHopE)));
    const p2 = toDb(Math.sqrt(0.5 * (hopP + this._lastHopP)));
    const p1 = toDb(Math.sqrt(hopP));
    this._lastHopE = hopE;
    this._lastHopP = hopP;
    let minE = Infinity;
    let minP = Infinity;
    let minP1 = Infinity;
    for (let k = 1; k <= 6 && k <= hc; k++) {
      const idx = (hc - k) % HOP_RING;
      if (this._p1Db[idx] < minP1) minP1 = this._p1Db[idx];
      if (k < 2) continue;
      if (this._e2Db[idx] < minE) minE = this._e2Db[idx];
      if (this._p2Db[idx] < minP) minP = this._p2Db[idx];
    }
    this._e2Db[hc % HOP_RING] = e2;
    this._p2Db[hc % HOP_RING] = p2;
    this._p1Db[hc % HOP_RING] = p1;
    const rise = minE === Infinity ? e2 + 120 : Math.max(e2 - minE, p2 - minP, p1 - minP1 - 1);

    // Log-spectral flux (lag 2 hops, max-filtered reference) with adaptive threshold.
    const flux = this._flux(gateDb);
    let fluxThr = this._fluxDelta;
    const nHist = Math.min(FLUX_MEDIAN, this._fluxCount);
    if (nHist >= 3) {
      const ms = this._medScratch;
      for (let k = 0; k < nHist; k++) ms[k] = this._fluxHist[(this._fluxCount - 1 - k) % HOP_RING];
      const arr = ms.subarray(0, nHist).sort();
      fluxThr += 1.5 * arr[nHist >> 1];
    }
    this._fluxHist[this._fluxCount % HOP_RING] = flux;
    const curD = this._fluxD[this._fluxCount % 3];
    this._fluxCount++;

    // Onset detection.
    let onsetTime = null;
    if (this._gateOpen && endTime - this._lastOnset >= REFRACTORY) {
      let back = 0;
      if (rise >= this._riseDb && this._riseArmed) back = 3;
      else if (flux > fluxThr && this._fluxArmed) back = 4;
      if (back) {
        onsetTime = this._refine(endTime - back * this._hopSec, endTime, this._lastOnset + 0.035);
        this._riseArmed = false;
        this._fluxArmed = false;
      }
    }
    if (rise < this._riseDb * 0.5) this._riseArmed = true;
    if (flux < fluxThr * 0.6) this._fluxArmed = true;

    this._hopCount++;
    if (onsetTime !== null) {
      if (this._pending) {
        const f = this._analyze(endTime, true);
        this._decide(this._pending, f, out);
        this._pending = null;
      }
      this._lastOnset = onsetTime;
      this._onsetFlag = true;
      this._unresolved = null;
      this._pending = { time: onsetTime };
      // Spectral rise around the onset (this hop and the two before) for attributing it to pitches.
      const acc = this._onsetAcc;
      const [d0, d1, d2] = this._fluxD;
      for (let b = 0; b < acc.length; b++) acc[b] = d0[b] + d1[b] + d2[b];
    } else if (this._pending) {
      const acc = this._onsetAcc;
      for (let b = 0; b < acc.length; b++) acc[b] += curD[b];
    }

    let frame = null;
    const due = this._pending && endTime >= this._pending.time + EVIDENCE;
    if (due) frame = this._analyze(endTime, true);
    else if (this._hopCount % 2 === 0) frame = this._analyze(endTime, false);
    if (due) {
      this._decide(this._pending, frame, out);
      this._pending = null;
    }
    if (frame) {
      this._trackPitch(frame, out);
      this._publish(frame);
    }
  }

  _closeGate() {
    this._gateOpen = false;
    this._curPitch = null;
    this._run.m = null;
    this._run.count = 0;
    this._lastEmitted = [];
    this._pcEmit = null;
  }

  // Log-spectral flux (dB above a gate-relative reference, lag 2 hops, max-filtered reference). Also stores the
  // linear magnitude rise per bin (used to attribute an onset to pitches).
  _flux(gateDb) {
    const slot = this._fluxCount % 3;
    const refSlot = (this._fluxCount + 1) % 3; // two hops ago
    const cur = this._fluxS[slot];
    const ref = this._fluxS[refSlot];
    const mag = magnitudeSpectrum(this._buf, this.fluxSize, this._fluxM[slot]);
    const refMag = this._fluxM[refSlot];
    const D = this._fluxD[slot];
    const norm = 4 / this.fluxSize;
    const refDb = gateDb - 25;
    const lo = this._fluxLo;
    const hi = this._fluxHi;
    for (let b = lo - 1; b <= hi + 1; b++) {
      const L = 20 * Math.log10(mag[b] * norm + 1e-12) - refDb;
      cur[b] = L > 0 ? L : 0;
    }
    if (this._fluxCount < 2) {
      D.fill(0);
      return 0;
    }
    let flux = 0;
    for (let b = lo; b <= hi; b++) {
      let r = ref[b];
      if (ref[b - 1] > r) r = ref[b - 1];
      if (ref[b + 1] > r) r = ref[b + 1];
      const d = cur[b] - r;
      if (d > 0) flux += d;
      let rm = refMag[b];
      if (refMag[b - 1] > rm) rm = refMag[b - 1];
      if (refMag[b + 1] > rm) rm = refMag[b + 1];
      const dl = mag[b] - rm;
      D[b] = dl > 0 ? dl : 0;
    }
    return flux;
  }

  // Time of the 128-sample sub-block with the largest energy jump within [from, to).
  _refine(from, to, notBefore) {
    const n = this._subCount;
    const sub = this.sub / this.sampleRate;
    const eps = Math.pow(10, (this._absGate - 30) / 10);
    let best = -1;
    let bestJ = -Infinity;
    const first = Math.max(4, n - SUB_RING + 4);
    for (let j = n - 1; j >= first; j--) {
      const t = this._subT[j % SUB_RING];
      if (t >= to) continue;
      if (t < from - 1e-9 || t < notBefore) break;
      let aE = 0;
      let aP = 0;
      let cnt = 0;
      for (let k = j; k < j + 4 && k < n; k++, cnt++) {
        aE += this._subE[k % SUB_RING];
        aP += this._subP[k % SUB_RING];
      }
      let bE = 0;
      let bP = 0;
      for (let k = j - 4; k < j; k++) {
        bE += this._subE[k % SUB_RING];
        bP += this._subP[k % SUB_RING];
      }
      const J = Math.log((aE / cnt + eps) / (bE / 4 + eps)) + Math.log((aP / cnt + eps) / (bP / 4 + eps));
      if (J > bestJ) {
        bestJ = J;
        best = j;
      }
    }
    if (best < 0) return Math.max(notBefore, to - sub);
    return this._subT[best % SUB_RING];
  }

  _analyze(endTime, force) {
    const fr = this._frames[this._frameCount % FRAME_RING];
    this._frameCount++;
    fr.time = endTime;
    fr.db = this._lastDb;
    fr.cands = [];
    fr.harm = 0;
    fr.yin = null;
    fr.lazy = false;
    const live = this._gateOpen || force;
    if (!live && !(this._lastDb >= this._floor + RESIDUAL_DB)) {
      fr.silent = true;
      fr.sal.fill(0);
      return fr;
    }
    fr.silent = false;
    magnitudeSpectrum(this._buf, this.fftSize, fr.mag);
    fr.lazy = true;
    // Residual sound below the gate only serves as the spectral reference of a possible next onset: keep the
    // spectrum, derive salience / candidates on demand (_complete), no pitch tracking.
    if (!live) return fr;
    this._complete(fr);
    fr.yin = yin(this._buf.subarray(this.fftSize - this.yinSize), this.sampleRate, YIN_OPTIONS);
    return fr;
  }

  // Salience vector and multi-pitch candidates of a frame whose spectrum is stored. Returns the frame.
  _complete(fr) {
    if (!fr.lazy) return fr;
    salienceVector(fr.mag, this.sampleRate, this.fftSize, { a4: this.a4, out: fr.sal });
    fr.cands = [];
    fr.harm = this._estimate(fr.mag, fr.cands);
    fr.lazy = false;
    return fr;
  }

  // Iterative multi-pitch estimation & cancellation on a magnitude spectrum: strongest harmonic series first, then
  // the residual. Fills `cands` with { m, v (salience at pick time), e (energy share removed) }; returns Σe.
  _estimate(mag, cands) {
    const sr = this.sampleRate;
    const a4 = this.a4;
    const work = this._work;
    work.set(mag);
    let total = 0;
    for (let b = this._bandLo; b < mag.length; b++) total += mag[b] * mag[b];
    if (!(total > 0)) return 0;
    let explained = 0;
    let v0 = 0;
    for (let it = 0; it < MAX_ITER; it++) {
      const s = salienceVector(work, sr, this.fftSize, { a4, out: this._tmpSal });
      let bi = -1;
      let bv = 0;
      for (let i = 0; i < SAL_N; i++) {
        if (s[i] > bv && !cands.some((c) => c.m === i + SAL_LO)) {
          bv = s[i];
          bi = i;
        }
      }
      if (bi < 0) break;
      if (it === 0) v0 = bv;
      else if (bv < 0.15 * v0) break;
      const e = cancelHarmonics(work, bi + SAL_LO, sr, this.fftSize, { a4 }) / total;
      explained += e;
      cands.push({ m: bi + SAL_LO, v: bv, e });
    }
    return Math.min(1, explained);
  }

  // Latest stored frame (other than `except`) whose window ends at or before `t`.
  _frameBefore(t, except) {
    for (let k = 1; k <= FRAME_RING; k++) {
      const idx = this._frameCount - k;
      if (idx < 0) break;
      const f = this._frames[idx % FRAME_RING];
      if (f === except) continue;
      if (f.time <= t + 1e-6) return this._complete(f);
    }
    return null;
  }

  _yinMidi(fr, minClarity) {
    const y = fr.yin;
    if (!y || y.clarity < minClarity) return null;
    const m = Math.round(hzToMidi(y.freq, this.a4));
    return m >= SAL_LO && m <= SAL_HI ? m : null;
  }

  // Decides which notes started at `onset` using the frame computed ≈ EVIDENCE s later. From silence the current
  // spectrum is analysed. Over sounding notes, notes present before and after ("carried") are judged as possible
  // re-strikes, and new notes are searched in the rise spectrum (now − pre-onset) with the carried partials removed.
  _decide(onset, fr, out) {
    const sal = fr.sal;
    let maxNow = 0;
    for (let i = 0; i < SAL_N; i++) if (sal[i] > maxNow) maxNow = sal[i];
    const pre = this._frameBefore(onset.time + 0.003, fr);
    const preSilent = !pre || pre.silent;
    const ym = this._yinMidi(fr, 0.7);
    // A confident YIN pitch that is also salient (not a chord's common sub-harmonic) can veto ghosts.
    const yConf = ym !== null && fr.yin.clarity >= 0.85 && sal[ym - SAL_LO] >= 0.5 * maxNow;
    const accepted = [];
    const carried = []; // notes sounding before and after the onset
    const restruck = []; // carried notes judged as struck again
    // A note that just appeared without an onset (pitch-change event) and keeps swelling is not struck again.
    const pc = this._pcEmit;
    const accept = (m) => {
      if (pc && pc.m === m && onset.time - pc.time < PC_HOLD) return;
      const i = accepted.findIndex((a) => pcOf(a) === pcOf(m));
      if (i < 0) accepted.push(m);
    };

    if (maxNow > 0 && preSilent) {
      if (this._harmonic(fr.harm, fr.cands) || ym !== null) {
        const c = fr.cands;
        const v0 = c.length ? c[0].v : 0;
        for (let k = 0; k < c.length && accepted.length < 3; k++) {
          if (k > 0 && (c[k].v < 0.45 * v0 || c[k].e < 0.04)) continue;
          accept(c[k].m);
        }
      }
    } else if (maxNow > 0) {
      // Rise spectrum and its salience (before removing carried notes).
      const D = this._rise;
      const now = fr.mag;
      const before = pre.mag;
      for (let b = 0; b < D.length; b++) {
        const d = now[b] - before[b];
        D[b] = d > 0 ? d : 0;
      }
      const riseSal = salienceVector(D, this.sampleRate, this.fftSize, { a4: this.a4, out: this._riseSal });
      let riseMax = 0;
      for (let i = 0; i < SAL_N; i++) if (riseSal[i] > riseMax) riseMax = riseSal[i];

      const topOf = (f) => f.cands.filter((c) => c.v >= 0.3 * f.cands[0].v).slice(0, 3).map((c) => c.m);
      // Only tonal frames carry or gain notes: "candidates" of noise (e.g. a knock's tail) are not ringing strings,
      // and the positive difference of two noise spectra is sparse enough to look harmonic.
      const tonalNow = this._harmonic(fr.harm, fr.cands);
      const preTop = this._harmonic(pre.harm, pre.cands) ? topOf(pre) : [];
      if (preTop.length && tonalNow) {
        for (const m of topOf(fr)) if (preTop.includes(m)) carried.push(m);
      }
      for (const m of carried) {
        const i = m - SAL_LO;
        // A new note an octave up raises only the even partials, one an octave down raises all of m's partials as
        // its even ones (and its own odd ones): neither is a re-strike of m.
        const octaveUp = i + 12 < SAL_N ? riseSal[i + 12] : 0;
        const octaveDown = i >= 12 ? riseSal[i - 12] : 0;
        const reEnergized = riseSal[i] >= 0.35 * sal[i] && riseSal[i] >= 0.35 * riseMax
          && riseSal[i] >= 0.8 * octaveUp && riseSal[i] >= 0.8 * octaveDown;
        const yinSays = yConf && ym === m;
        if (reEnergized || (yinSays && this._restruck(m, fr))) {
          accept(m);
          restruck.push(m);
          // Interference between the old and new strike distorts the rise around m's partials.
          clearHarmonics(D, m, this.sampleRate, this.fftSize, { a4: this.a4 });
        }
      }

      const cands = [];
      const harm = this._estimate(D, cands);
      // A merely ringing YIN pitch must not veto new notes on its partials; a new or re-struck one may.
      const veto = yConf && (!carried.includes(ym) || restruck.includes(ym));
      if ((tonalNow && this._harmonic(harm, cands)) || ym !== null) {
        const v0 = cands.length ? cands[0].v : 0;
        const curV0 = fr.cands.length ? fr.cands[0].v : 0;
        for (let k = 0; k < cands.length && accepted.length < 3; k++) {
          const c = cands[k];
          if (c.v < 0.15 * maxNow) continue;
          // Rise right next to a ringing note is usually interference from re-striking that note; a genuinely new
          // neighbour must be corroborated by the current-spectrum estimate or by YIN.
          let near = null;
          for (const m of carried) {
            if (m === c.m || restruck.includes(m) || Math.abs(m - c.m) > 2) continue;
            if (near === null || Math.abs(m - c.m) < Math.abs(near - c.m)) near = m;
          }
          if (near !== null && c.m !== ym && !fr.cands.some((x) => x.m === c.m && x.v >= 0.2 * curV0)) {
            if (k === 0 && this._restruck(near, fr)) {
              accept(near);
              restruck.push(near);
            }
            continue;
          }
          if (k > 0 && (c.v < 0.45 * v0 || c.e < 0.04)) continue;
          if (sal[c.m - SAL_LO] < 0.12 * maxNow) continue;
          // Partial-like ghosts of the YIN pitch or semitone neighbours of it need the YIN pitch's agreement.
          if (veto && c.m !== ym) {
            const iv = c.m - ym;
            if (Math.abs(iv) <= 2) continue;
            if (PARTIAL_INTERVALS.includes(iv) && c.v < 0.8 * v0) continue;
          }
          accept(c.m);
        }
      }
      if (ym !== null && !accepted.some((m) => pcOf(m) === pcOf(ym)) && accepted.length < 3
        && sal[ym - SAL_LO] >= 0.35 * maxNow && !carried.includes(ym)
        && (riseSal[ym - SAL_LO] >= 0.35 * riseMax || this._restruck(ym, fr))) {
        accept(ym);
      }
    }

    // YIN refines the octave / neighbour choice of a matching candidate. Over notes that still ring, YIN tends to
    // lock onto the period of the mixture (e.g. an older note an octave below a new one), so a pitch that was
    // already sounding and was not struck again does not override the estimate.
    if (ym !== null) {
      const i = accepted.findIndex((m) => pcOf(m) === pcOf(ym));
      const yinRang = !preSilent && !restruck.includes(ym)
        && (carried.includes(ym) || pre.cands.some((c) => c.m === ym));
      if (i >= 0) {
        if (accepted[i] !== ym && !yinRang && sal[ym - SAL_LO] >= 0.6 * sal[accepted[i] - SAL_LO]) accepted[i] = ym;
      } else if (preSilent && accepted.length < 3 && sal[ym - SAL_LO] >= 0.35 * maxNow) {
        const j = yConf ? accepted.findIndex((m) => Math.abs(m - ym) === 1) : -1;
        if (j >= 0) accepted[j] = ym;
        else accepted.push(ym);
      }
    }

    if (!accepted.length) {
      this._unresolved = { time: onset.time };
      return;
    }
    accepted.sort((a, b) => a - b);
    const level = clamp((fr.db - this._gateDb + 6) / 36, 0.05, 1);
    for (const m of accepted) {
      const rel = maxNow > 0 ? Math.sqrt(clamp(sal[m - SAL_LO] / maxNow, 0, 1)) : 1;
      const freq = ym === m && fr.yin ? fr.yin.freq : midiToHz(m, this.a4);
      out.push({ time: onset.time, midi: m, freq, strength: clamp(level * (0.4 + 0.6 * rel), 0, 1), source: 'onset' });
    }
    this._lastEmitted = accepted.slice();
    if (ym !== null && accepted.includes(ym)) this._curPitch = ym;
  }

  // Whether an estimate (`_estimate` result and candidates) describes tonal sound rather than noise.
  _harmonic(harm, cands) {
    return harm >= this._minHarm && cands.length > 0 && cands[0].e >= MIN_TOP_SHARE;
  }

  // Re-struck pitch whose magnitude did not grow (the previous strike still rings, phases may cancel): its partials
  // must carry most of the onset's accumulated spectral rise, the odd ones included — a new note one or two octaves
  // up feeds only m's even partials (stricter when such a note is prominent in the frame `fr` after the onset).
  _restruck(m, fr) {
    const acc = this._onsetAcc;
    let total = 0;
    for (let b = this._fluxLo; b <= this._fluxHi; b++) total += acc[b];
    if (!(total > 0)) return false;
    const os = salienceVector(acc, this.sampleRate, this.fluxSize, { a4: this.a4, out: this._onsetSal });
    let mx = 0;
    for (let i = 0; i < SAL_N; i++) if (os[i] > mx) mx = os[i];
    // The coarse flux bins blur octaves and (low) semitone neighbours, so the strongest of those counts.
    let own = 0;
    for (let o = m - 25; o <= m + 25; o++) {
      const d = ((o - m) % 12 + 12) % 12;
      if ((d === 0 || d === 1 || d === 11) && o >= SAL_LO && o <= SAL_HI && os[o - SAL_LO] > own) own = os[o - SAL_LO];
    }
    if (own < 0.6 * mx || this._fluxShare(m) < 0.3 * total) return false;
    const top = fr && fr.cands.length ? fr.cands[0].v : 0;
    const upNow = top > 0 && fr.cands.some((c) => (c.m === m + 12 || c.m === m + 24) && c.v >= UP_PROMINENT * top);
    return this._fluxShare(m, 1) >= (upNow ? RESTRIKE_ODD : RESTRIKE_ODD_MIN) * this._fluxShare(m, 2);
  }

  // Onset spectral rise found at the first six partials of `m` (flux-FFT bins, ±1 bin each): all of them
  // (parity 0), only the odd ones (1) or only the even ones (2).
  _fluxShare(m, parity = 0) {
    const acc = this._onsetAcc;
    const binHz = this.sampleRate / this.fluxSize;
    const f0 = midiToHz(m, this.a4);
    let sum = 0;
    let lastHi = -1;
    for (let k = parity === 2 ? 2 : 1; k <= 6; k += parity ? 2 : 1) {
      const c = Math.round((k * f0) / binHz);
      if (c > this._fluxHi) break;
      const b0 = Math.max(this._fluxLo, c - 1, lastHi + 1);
      const b1 = Math.min(this._fluxHi, c + 1);
      for (let b = b0; b <= b1; b++) sum += acc[b];
      lastHi = b1;
    }
    return sum;
  }

  // Pitch-change events: a new stable YIN pitch without a nearby onset (e.g. soft legato notes).
  _trackPitch(fr, out) {
    if (!this._gateOpen) return;
    const run = this._run;
    const m = this._yinMidi(fr, 0.85);
    if (m === null) {
      run.m = null;
      run.count = 0;
      return;
    }
    if (m === run.m) run.count++;
    else {
      run.m = m;
      run.count = 1;
      run.start = fr.time - (0.6 * this.yinSize) / this.sampleRate;
    }
    if (run.count !== PC_FRAMES) return;
    let maxNow = 0;
    for (let i = 0; i < SAL_N; i++) if (fr.sal[i] > maxNow) maxNow = fr.sal[i];
    // A periodicity without a salient harmonic series is a common sub-harmonic of a mixture (e.g. A2 while E4 fades
    // into A4): it is not a note and must not become the current pitch (it would mask the real one as an octave).
    if (fr.sal[m - SAL_LO] < PC_MIN_SAL * maxNow) return;
    const prevPitch = this._curPitch;
    this._curPitch = m;
    if (this._lastEmitted.includes(m)) return;
    if (prevPitch !== null && pcOf(prevPitch) === pcOf(m)) return;
    if (this._pending) return;
    const un = this._unresolved;
    if (un && run.start >= un.time - 0.06 && run.start - un.time <= 0.2) {
      this._unresolved = null;
      this._emitSingle(out, un.time, m, fr, 'onset');
      return;
    }
    if (Math.abs(run.start - this._lastOnset) < PC_GUARD) return;
    // The new pitch must have gained salience (rules out decaying notes changing their apparent pitch).
    const before = this._frameBefore(run.start - 0.04, fr);
    if (before && !before.silent) {
      const i = m - SAL_LO;
      if (fr.sal[i] < 1.3 * Math.max(before.sal[i], 0.05 * maxNow)) return;
    }
    const t = this._refine(run.start - 0.03, run.start + 0.02, this._lastOnset + 0.035);
    this._emitSingle(out, t, m, fr, 'pitch-change');
  }

  _emitSingle(out, time, m, fr, source) {
    const level = clamp((fr.db - this._gateDb + 6) / 36, 0.05, 1);
    out.push({ time, midi: m, freq: fr.yin ? fr.yin.freq : midiToHz(m, this.a4), strength: level, source });
    this._lastEmitted = [m];
    this._pcEmit = source === 'pitch-change' ? { m, time } : null;
    this._curPitch = m;
  }

  _publish(fr) {
    const y = fr.yin;
    const pitch = this._gateOpen && y && y.clarity >= 0.5
      ? { midi: hzToMidi(y.freq, this.a4), freq: y.freq, clarity: y.clarity }
      : null;
    const top = [];
    if (this._gateOpen && fr.cands.length) {
      const v0 = fr.cands[0].v;
      for (const c of fr.cands) {
        if (top.length >= 3) break;
        if (c.v >= 0.3 * v0) top.push(c.m);
      }
    }
    this._analysis = {
      time: fr.time, db: this._lastDb, gateOpen: this._gateOpen, pitch, topNotes: top, onset: this._onsetFlag,
    };
    this._onsetFlag = false;
  }
}
