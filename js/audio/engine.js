// Shared Web Audio context, unlock helper, smoothed clock and master output bus. Browser only.

let ctx = null;
let master = null;
let masterVolume = 0.8;
let primedCtx = null; // context that already played the silent unlock buffer

// audioNow() state
let clockCtx = null;
let clockOffset = null;
let lastNow = -Infinity;
let winMax = -Infinity; // highest currentTime − perf seen in the current re-sync window
let winStart = 0;

const RESUME_WAIT_MS = 800;
// audioNow(): the offset to currentTime decays by this fraction of the gap per call when currentTime lags behind...
const CLOCK_DECAY = 0.005;
// ...unless it lags by more than this (s): the audio clock stalled (device switch, system interruption) — re-sync.
const CLOCK_RESYNC = 0.15;
// A smaller lag that persists for a whole window (currentTime never caught up) is re-synced at the window's end.
const CLOCK_WINDOW = 0.5;
const CLOCK_SLACK = 0.03;

function audioError(message, cause) {
  const err = new Error(message);
  err.code = 'unsupported';
  if (cause) err.cause = cause;
  return err;
}

// Lazy singleton (recreated if it was closed). Throws Error with code 'unsupported' when Web Audio is missing or no
// context can be created.
export function getAudioContext() {
  if (ctx && ctx.state !== 'closed') return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) throw audioError('이 브라우저는 Web Audio를 지원하지 않아요.');
  let c;
  try {
    c = new AC({ latencyHint: 'interactive' });
  } catch {
    try {
      c = new AC(); // older engines reject the options object
    } catch (err) {
      throw audioError('오디오 장치를 열 수 없어요. 다른 앱이 오디오를 쓰고 있다면 종료한 뒤 다시 시도해 주세요.', err);
    }
  }
  ctx = c;
  master = null;
  primedCtx = null;
  return ctx;
}

// Call from a user gesture (tap / click), before any other await of the handler. Creates the context, starts
// resume() synchronously inside the gesture and plays a 1-sample silent buffer once per context (some mobile browsers
// only start audio output after a buffer was played from a gesture). Safe to call repeatedly; never hangs (resume()
// can stay pending when the browser refuses). Returns the context.
export async function unlockAudio() {
  const c = getAudioContext();
  if (c.state === 'running' && primedCtx === c) return c;
  if (primedCtx !== c) {
    try {
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, c.sampleRate);
      src.connect(c.destination);
      src.onended = () => {
        try {
          src.disconnect();
        } catch {
          // already disconnected
        }
      };
      src.start(0);
      primedCtx = c;
    } catch {
      // Best effort only.
    }
  }
  if (c.state !== 'running') {
    // resume() must be called synchronously here, while the gesture's activation is certainly valid.
    let resuming;
    try {
      resuming = Promise.resolve(c.resume()).catch(() => {});
    } catch {
      resuming = Promise.resolve();
    }
    let timer = 0;
    await Promise.race([
      resuming,
      new Promise((resolve) => {
        timer = setTimeout(resolve, RESUME_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }
  return c;
}

// Smoothed context time for visuals: performance.now() plus a tracked offset to ctx.currentTime. currentTime advances
// in render-quantum bursts; the offset follows increases immediately and decays slowly (~0.5 % of the gap per call)
// otherwise, so the result is smooth and stays at the upper envelope of currentTime. It never goes backwards for a
// given context. Uses the shared context (created lazily like getAudioContext()); without Web Audio it returns
// performance time.
export function audioNow() {
  const perf = performance.now() / 1000;
  let c = null;
  try {
    c = getAudioContext();
  } catch {
    c = null;
  }
  if (c !== clockCtx) {
    // New time base (first call or a recreated context).
    clockCtx = c;
    clockOffset = null;
    lastNow = -Infinity;
  }
  let t;
  if (!c) {
    t = perf;
  } else if (c.state !== 'running') {
    clockOffset = null;
    t = c.currentTime;
  } else {
    const raw = c.currentTime - perf;
    if (clockOffset === null || raw > clockOffset || clockOffset - raw > CLOCK_RESYNC) {
      if (clockOffset === null) {
        winMax = raw;
        winStart = perf;
      }
      clockOffset = raw;
    } else {
      clockOffset += (raw - clockOffset) * CLOCK_DECAY;
    }
    if (raw > winMax) winMax = raw;
    if (perf - winStart >= CLOCK_WINDOW) {
      if (clockOffset - winMax > CLOCK_SLACK) clockOffset = winMax;
      winMax = raw;
      winStart = perf;
    }
    t = perf + clockOffset;
  }
  if (t < lastNow) t = lastNow;
  lastNow = t;
  return t;
}

// Shared output bus: GainNode → DynamicsCompressor → destination. Synth voices connect to the returned GainNode.
export function masterOut() {
  const c = getAudioContext();
  if (master && master.context === c) return master;
  const compressor = c.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  compressor.connect(c.destination);
  master = c.createGain();
  master.gain.value = masterVolume;
  master.connect(compressor);
  return master;
}

// 0..1; applied with a short ramp. Remembered for a bus created later.
export function setMasterVolume(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return;
  masterVolume = Math.min(1, Math.max(0, x));
  if (!master || !ctx || master.context !== ctx) return;
  const g = master.gain;
  try {
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(masterVolume, now, 0.02);
  } catch {
    g.value = masterVolume;
  }
}
