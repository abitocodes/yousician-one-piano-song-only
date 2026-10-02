// Synthetic test signals for the DSP / detector tests (original content only; no real songs).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hz(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function sine(freq, seconds, sampleRate, amp = 0.5, phase = 0) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(w * i + phase);
  return out;
}

// Adds white Gaussian noise with the given RMS level (dBFS) into `buf`.
export function addNoise(buf, dbfs, seed = 7) {
  if (!Number.isFinite(dbfs)) return buf;
  const rand = mulberry32(seed);
  const sigma = Math.pow(10, dbfs / 20);
  for (let i = 0; i < buf.length; i += 2) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1)) * sigma;
    buf[i] += r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < buf.length) buf[i + 1] += r * Math.sin(2 * Math.PI * u2);
  }
  return buf;
}

// Adds one piano-like tone into `buf`:
//   Σ_{k=1..partials} k^-1.2 · sin(2π·k·f0·sqrt(1+B·k²)·t) · e^{-t/τ_k},  τ_k = tau1/k,
// with a linear attack, and an exponential release (damper) after `dur` seconds.
export function addPianoTone(buf, sampleRate, {
  start, freq, dur = 0.5, amp = 0.1, B = 4e-4, partials = 8, attack = 0.005, release = 0.06, tau1 = 0.8,
  phase = 0,
}) {
  const s0 = Math.round(start * sampleRate);
  const total = Math.min(buf.length - s0, Math.round((dur + release * 7) * sampleRate));
  if (total <= 0) return buf;
  const attackN = Math.max(1, Math.round(attack * sampleRate));
  const durN = Math.round(dur * sampleRate);
  const relK = Math.exp(-1 / (release * sampleRate));
  const env = new Float32Array(total);
  let rel = 1;
  for (let i = 0; i < total; i++) {
    const a = i < attackN ? i / attackN : 1;
    if (i >= durN) rel *= relK;
    env[i] = a * rel;
  }
  for (let k = 1; k <= partials; k++) {
    const fk = k * freq * Math.sqrt(1 + B * k * k);
    if (fk >= sampleRate * 0.45) break;
    const w = (2 * Math.PI * fk) / sampleRate;
    const decay = Math.exp(-k / (tau1 * sampleRate));
    // Phasor recurrence (cheap and accurate for a few seconds).
    const cr = Math.cos(w);
    const ci = Math.sin(w);
    let pr = Math.cos(phase * k);
    let pi = Math.sin(phase * k);
    let g = amp * Math.pow(k, -1.2);
    for (let i = 0; i < total; i++) {
      buf[s0 + i] += g * pi * env[i];
      const nr = pr * cr - pi * ci;
      pi = pr * ci + pi * cr;
      pr = nr;
      g *= decay;
    }
  }
  return buf;
}

// Adds a harmonic tone (partial k at k^-1.2, inharmonicity B) whose overall level follows `envelopeDb(t)` (dB, t in
// seconds from `start`). Used for swells / crossfades that a struck piano note cannot produce.
export function addEnvelopedTone(buf, sampleRate, {
  start, seconds, freq, envelopeDb, partials = 8, B = 4e-4, phase = 0,
}) {
  const s0 = Math.round(start * sampleRate);
  const n = Math.min(buf.length - s0, Math.round(seconds * sampleRate));
  if (n <= 0) return buf;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.pow(10, envelopeDb(i / sampleRate) / 20);
  for (let k = 1; k <= partials; k++) {
    const fk = k * freq * Math.sqrt(1 + B * k * k);
    if (fk >= sampleRate * 0.45) break;
    const w = (2 * Math.PI * fk) / sampleRate;
    const g = Math.pow(k, -1.2);
    for (let i = 0; i < n; i++) buf[s0 + i] += g * env[i] * Math.sin(w * i + phase * k);
  }
  return buf;
}

// Piecewise-linear function through [[t, value], ...] (sorted by t), constant outside.
export function ramp(points) {
  return (t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [t1, v1] = points[i];
      if (t <= t1) {
        const [t0, v0] = points[i - 1];
        return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
      }
    }
    return points[points.length - 1][1];
  };
}

// Feeds `buf` in pseudo-random chunk sizes drawn from `sizes`; returns all NoteEvents.
export function runDetectorChunked(det, buf, sampleRate, {
  sizes = [1, 7, 128, 300, 1024, 2048, 4096, 9999], seed = 5, t0 = 0,
} = {}) {
  const rand = mulberry32(seed);
  const events = [];
  let i = 0;
  while (i < buf.length) {
    const n = Math.min(buf.length - i, sizes[Math.floor(rand() * sizes.length)]);
    for (const e of det.push(buf.subarray(i, i + n), t0 + i / sampleRate)) events.push(e);
    i += n;
  }
  return events;
}

// Renders notes [{ t, m, d, amp? }] into a new buffer with background noise.
export function renderNotes(notes, {
  sampleRate = 48000, duration, noiseDb = -60, seed = 1, a4 = 440, B = 4e-4, release = 0.06, amp = 0.1, tau1 = 0.8,
} = {}) {
  const end = notes.reduce((mx, n) => Math.max(mx, n.t + n.d), 0);
  const len = Math.round((duration ?? end + 0.6) * sampleRate);
  const buf = new Float32Array(len);
  const rand = mulberry32(seed * 7919 + 13);
  for (const n of notes) {
    addPianoTone(buf, sampleRate, {
      start: n.t, freq: hz(n.m, a4), dur: n.d, amp: n.amp ?? amp, B, release, tau1,
      phase: n.phase ?? rand() * 2 * Math.PI,
    });
  }
  addNoise(buf, noiseDb, seed);
  return buf;
}

// Feeds `buf` to the detector in chunks; returns all NoteEvents.
export function runDetector(det, buf, sampleRate, { chunk = 1024, t0 = 0 } = {}) {
  const events = [];
  for (let i = 0; i < buf.length; i += chunk) {
    const part = buf.subarray(i, Math.min(buf.length, i + chunk));
    const ev = det.push(part, t0 + i / sampleRate);
    for (const e of ev) events.push(e);
  }
  return events;
}

const pc = (m) => ((Math.round(m) % 12) + 12) % 12;

// Matches detected events against expected notes. An expected note is "found" when an unused event of the same pitch
// class lies within ±tol seconds. Events matching no expected note (same pitch class within ±spuriousTol) are spurious.
export function evaluate(events, expected, { tol = 0.025, spuriousTol = 0.06 } = {}) {
  const used = new Array(events.length).fill(false);
  let found = 0;
  let exact = 0;
  const errors = [];
  const missed = [];
  for (const n of expected) {
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < events.length; i++) {
      if (used[i]) continue;
      const e = events[i];
      const err = Math.abs(e.time - n.t);
      if (err <= tol && pc(e.midi) === pc(n.m) && err < bestErr) {
        best = i;
        bestErr = err;
      }
    }
    if (best >= 0) {
      used[best] = true;
      found++;
      errors.push(events[best].time - n.t);
      if (events[best].midi === n.m) exact++;
    } else {
      missed.push(n);
    }
  }
  const spurious = events.filter((e) => !expected.some(
    (n) => Math.abs(e.time - n.t) <= spuriousTol && pc(e.midi) === pc(n.m),
  ));
  return {
    found, exact, total: expected.length, events: events.length, spurious: spurious.length, spuriousList: spurious,
    missed, maxErr: errors.reduce((m, e) => Math.max(m, Math.abs(e)), 0),
    meanErr: errors.length ? errors.reduce((s, e) => s + e, 0) / errors.length : 0,
  };
}
