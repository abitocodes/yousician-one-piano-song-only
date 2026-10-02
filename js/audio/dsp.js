// Pure DSP helpers (no DOM / Web Audio): windows, FFT, spectra, YIN pitch, harmonic salience.
// Importable in Node for unit tests.

export const SAL_LO = 36;
export const SAL_HI = 96;

const TWO_PI = Math.PI * 2;
const SEMI_UP = Math.pow(2, 1 / 24);
const SEMI_DOWN = 1 / SEMI_UP;
// Harmonic weights for salience; entries beyond `harmonics` are unused.
const WEIGHTS = [1, 0.8, 0.6, 0.5, 0.4, 0.35, 0.3, 0.27, 0.24, 0.22, 0.2, 0.18, 0.16, 0.15, 0.14, 0.13];

export function midiToHz(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function hzToMidi(freq, a4 = 440) {
  if (!(freq > 0) || !(a4 > 0)) return NaN;
  return 69 + 12 * Math.log2(freq / a4);
}

// ---------------------------------------------------------------------------
// Windows & FFT

const hannCache = new Map();

// Periodic Hann window (cached per length; do not mutate the result).
export function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}

function isPow2(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

const revCache = new Map();
const twiddleCache = new Map();

function bitReverse(n) {
  let rev = revCache.get(n);
  if (!rev) {
    const bits = Math.round(Math.log2(n));
    rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      let x = i;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      rev[i] = r;
    }
    revCache.set(n, rev);
  }
  return rev;
}

// cos/sin of e^{-2πik/n} for k < n/2.
function twiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    const half = n >> 1;
    const cos = new Float64Array(Math.max(1, half));
    const sin = new Float64Array(Math.max(1, half));
    for (let k = 0; k < half; k++) {
      cos[k] = Math.cos((TWO_PI * k) / n);
      sin[k] = -Math.sin((TWO_PI * k) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

// In-place forward complex FFT (unnormalized, X[k] = Σ x[n]·e^{-2πikn/N}). Length must be a power of 2.
export function fft(re, im) {
  const n = re.length;
  if (im.length !== n) throw new RangeError('fft: re/im length mismatch');
  if (n <= 1) return;
  if (!isPow2(n)) throw new RangeError('fft: length must be a power of 2');
  const rev = bitReverse(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = start, k = 0, end = start + half; j < end; j++, k += step) {
        const l = j + half;
        const c = cos[k];
        const s = sin[k];
        const tre = re[l] * c - im[l] * s;
        const tim = re[l] * s + im[l] * c;
        re[l] = re[j] - tre;
        im[l] = im[j] - tim;
        re[j] += tre;
        im[j] += tim;
      }
    }
  }
}

const specWork = new Map();

// Hann-windowed |X[k]|, k = 0..fftSize/2-1, of the LAST fftSize samples (zero-padded at the front when shorter).
// Uses the half-size complex FFT trick for real input.
export function magnitudeSpectrum(samples, fftSize, out) {
  const n = fftSize;
  if (!isPow2(n) || n < 4) throw new RangeError('magnitudeSpectrum: fftSize must be a power of 2 (≥ 4)');
  const h = n >> 1;
  const res = out && out.length >= h ? out : new Float32Array(h);
  let work = specWork.get(h);
  if (!work) {
    work = { re: new Float64Array(h), im: new Float64Array(h) };
    specWork.set(h, work);
  }
  const { re, im } = work;
  const w = hann(n);
  const off = samples.length - n;
  if (off >= 0) {
    for (let i = 0, j = off; i < h; i++, j += 2) {
      re[i] = samples[j] * w[2 * i];
      im[i] = samples[j + 1] * w[2 * i + 1];
    }
  } else {
    for (let i = 0; i < h; i++) {
      const j0 = off + 2 * i;
      const j1 = j0 + 1;
      re[i] = j0 >= 0 ? samples[j0] * w[2 * i] : 0;
      im[i] = j1 >= 0 ? samples[j1] * w[2 * i + 1] : 0;
    }
  }
  fft(re, im);
  const { cos, sin } = twiddles(n);
  res[0] = Math.abs(re[0] + im[0]);
  for (let k = 1; k < h; k++) {
    const zr = re[k];
    const zi = im[k];
    const cr = re[h - k];
    const ci = -im[h - k];
    const er = 0.5 * (zr + cr);
    const ei = 0.5 * (zi + ci);
    const or = 0.5 * (zi - ci);
    const oi = -0.5 * (zr - cr);
    const c = cos[k];
    const s = sin[k];
    const xr = er + or * c - oi * s;
    const xi = ei + or * s + oi * c;
    res[k] = Math.sqrt(xr * xr + xi * xi);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Level

export function rms(samples, start = 0, end = samples.length) {
  const a = Math.max(0, start | 0);
  const b = Math.min(samples.length, end | 0);
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) {
    const x = samples[i];
    s += x * x;
  }
  return Math.sqrt(s / (b - a));
}

export function toDb(x) {
  if (!(x > 0)) return -120;
  const db = 20 * Math.log10(x);
  return db < -120 ? -120 : db;
}

// ---------------------------------------------------------------------------
// YIN pitch estimation

let yinWork = new Float64Array(1024);

// YIN (cumulative mean normalized difference) over the last window of `samples`; lags look backwards so the
// newest audio is always analysed. Returns { freq, clarity } or null for silence / too-short input.
// When no lag dips below `threshold`, the global minimum is returned (with a low clarity).
export function yin(samples, sampleRate, { threshold = 0.15, minFreq = 70, maxFreq = 1400, window } = {}) {
  const len = samples.length;
  if (!(sampleRate > 0) || len < 16) return null;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  let tauMax = Math.ceil(sampleRate / minFreq);
  let W = window > 0 ? Math.floor(window) : Math.round(sampleRate * 0.0215);
  if (W + tauMax + 2 > len) {
    W = len - tauMax - 2;
    if (W < 64) {
      tauMax = Math.floor((len - 2) / 2);
      W = len - tauMax - 2;
    }
  }
  if (tauMax <= tauMin + 2 || W < 16) return null;
  const start = len - W;
  let energy = 0;
  for (let j = start; j < len; j++) energy += samples[j] * samples[j];
  if (energy <= 1e-12 * W) return null;

  if (yinWork.length < tauMax + 2) yinWork = new Float64Array(tauMax + 64);
  const cm = yinWork;
  cm[0] = 1;
  let running = 0;
  let found = -1;
  let computed = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let d = 0;
    for (let j = start; j < len; j++) {
      const v = samples[j] - samples[j - tau];
      d += v * v;
    }
    running += d;
    const val = running > 0 ? (d * tau) / running : 1;
    cm[tau] = val;
    computed = tau;
    if (tau < tauMin) continue;
    if (found < 0) {
      if (val < threshold && tau <= tauMax) found = tau;
    } else if (val < cm[found]) {
      found = tau;
    } else {
      break; // cm[found + 1] is available for interpolation
    }
  }
  let best = found;
  if (best > tauMax) best = tauMax;
  if (best < 0) {
    let min = Infinity;
    for (let tau = tauMin; tau <= Math.min(tauMax, computed); tau++) {
      if (cm[tau] < min) {
        min = cm[tau];
        best = tau;
      }
    }
    if (best < 0) return null;
  }
  let tauRef = best;
  let minVal = cm[best];
  if (best > 1 && best + 1 <= computed) {
    const a = cm[best - 1];
    const b = cm[best];
    const c = cm[best + 1];
    const den = a - 2 * b + c;
    if (den > 0) {
      let shift = (0.5 * (a - c)) / den;
      if (shift > 1) shift = 1;
      else if (shift < -1) shift = -1;
      tauRef = best + shift;
      minVal = b - 0.25 * (a - c) * shift;
    }
  }
  if (!(tauRef > 0)) return null;
  let clarity = 1 - minVal;
  if (clarity < 0) clarity = 0;
  else if (clarity > 1) clarity = 1;
  return { freq: sampleRate / tauRef, clarity };
}

// ---------------------------------------------------------------------------
// Harmonic salience

let peakAmp = 0;

// Best spectral peak (local maximum) near fractional bin `c`, searched within ±1/2 semitone (at least ±1 bin) and
// weighted by how close its interpolated position lies to `c`. Returns the bin index or -1; sets `peakAmp`.
function findPartial(mag, c, nb) {
  let a = Math.floor(c * SEMI_DOWN);
  let b = Math.ceil(c * SEMI_UP);
  const rc = Math.round(c);
  if (a > rc - 1) a = rc - 1;
  if (b < rc + 1) b = rc + 1;
  if (a < 1) a = 1;
  if (b > nb - 2) b = nb - 2;
  const binSemis = 12 * Math.log2((c + 1) / c);
  const sigma = Math.max(0.3, 0.5 * binSemis);
  const inv = 1 / (2 * sigma * sigma);
  let best = -1;
  let bestScore = 0;
  for (let i = a; i <= b; i++) {
    const v = mag[i];
    const l = mag[i - 1];
    const r = mag[i + 1];
    if (!(v > 0) || v < l || v < r) continue;
    let p = i;
    if (l > 0 && r > 0) {
      const la = Math.log(l);
      const lb = Math.log(v);
      const lc = Math.log(r);
      const den = la - 2 * lb + lc;
      if (den < 0) p = i + (0.5 * (la - lc)) / den;
    }
    const dev = 12 * Math.log2(p / c);
    const score = v * Math.exp(-dev * dev * inv);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  peakAmp = bestScore;
  return best;
}

function binValue(mag, c) {
  const i = Math.floor(c);
  const f = c - i;
  return mag[i] * (1 - f) + mag[i + 1] * f;
}

// Harmonic-sum pitch salience per semitone (index = midi - lo) from a linear magnitude spectrum of an
// fftSize-point FFT. Each harmonic contributes its peak-picked magnitude (weights 1, .8, .6, .5, .4, ...).
// Candidates whose own fundamental is weak relative to their harmonic sum (sub-octave ghosts) are attenuated.
export function salienceVector(mag, sampleRate, fftSize, {
  lo = SAL_LO, hi = SAL_HI, harmonics = 5, a4 = 440, out,
} = {}) {
  const count = hi - lo + 1;
  const res = out && out.length >= count ? out : new Float32Array(Math.max(0, count));
  const nb = mag.length;
  const binHz = sampleRate / fftSize;
  const H = Math.max(1, Math.min(harmonics, WEIGHTS.length));
  for (let m = lo; m <= hi; m++) {
    const f0 = midiToHz(m, a4);
    let sum = 0;
    let c1 = 0;
    for (let k = 1; k <= H; k++) {
      const c = (k * f0) / binHz;
      if (c >= nb - 2) break;
      if (c < 1) continue;
      if (findPartial(mag, c, nb) < 0) {
        // A fundamental buried in a neighbour's skirt is no peak; its level still counts for ghost suppression.
        if (k === 1) c1 = 0.5 * binValue(mag, c);
        continue;
      }
      const v = WEIGHTS[k - 1] * peakAmp;
      sum += v;
      if (k === 1) c1 = v;
    }
    if (sum > 0 && c1 < 0.2 * sum) sum *= Math.max(0.3, c1 / (0.2 * sum));
    res[m - lo] = sum;
  }
  return res;
}

// Zeroes the bins within ±max(lobe bins, 1/4 semitone) of each harmonic of `midi` (k = 1..harmonics), in place.
export function clearHarmonics(mag, midi, sampleRate, fftSize, { a4 = 440, harmonics = 12, lobe = 2 } = {}) {
  const nb = mag.length;
  const binHz = sampleRate / fftSize;
  const f0 = midiToHz(midi, a4);
  const q = Math.pow(2, 1 / 48) - 1;
  for (let k = 1; k <= harmonics; k++) {
    const c = (k * f0) / binHz;
    if (c >= nb) break;
    const w = Math.max(lobe, c * q);
    const b0 = Math.max(0, Math.floor(c - w));
    const b1 = Math.min(nb - 1, Math.ceil(c + w));
    for (let b = b0; b <= b1; b++) mag[b] = 0;
  }
  return mag;
}

const cancelIdx = new Int32Array(64);
const cancelAmp = new Float64Array(64);

// Removes the partials of `midi` from `mag` in place (iterative multi-pitch estimation). A partial is removed up to
// the level of its neighbouring harmonics, so a partial shared with another note keeps its excess.
// Returns the removed energy (Σ old² − new²).
export function cancelHarmonics(mag, midi, sampleRate, fftSize, { a4 = 440, harmonics = 12, lobe = 2 } = {}) {
  const nb = mag.length;
  const binHz = sampleRate / fftSize;
  const f0 = midiToHz(midi, a4);
  const H = Math.min(harmonics, cancelIdx.length);
  let K = 0;
  for (let k = 1; k <= H; k++) {
    const c = (k * f0) / binHz;
    if (c >= nb - 2) break;
    const i = c < 1 ? -1 : findPartial(mag, c, nb);
    cancelIdx[K] = i;
    cancelAmp[K] = i >= 0 ? mag[i] : 0;
    K++;
  }
  let removed = 0;
  for (let j = 0; j < K; j++) {
    const i = cancelIdx[j];
    const a = cancelAmp[j];
    if (i < 0 || !(a > 0)) continue;
    let r = a;
    if (j > 0) {
      const env = Math.max(cancelAmp[j - 1], j + 1 < K ? cancelAmp[j + 1] : 0);
      if (env < a) r = env;
    }
    const keep = 1 - r / a;
    const b0 = Math.max(0, i - lobe);
    const b1 = Math.min(nb - 1, i + lobe);
    for (let b = b0; b <= b1; b++) {
      const o = mag[b];
      const nv = o * keep;
      removed += o * o - nv * nv;
      mag[b] = nv;
    }
  }
  return removed;
}
