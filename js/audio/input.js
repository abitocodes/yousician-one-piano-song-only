// Microphone / simulation input → NoteDetector. Browser only.
// Events: 'note' (NoteEvent), 'analysis' (Analysis, at most 30/s), 'state' (state string).
// Event times are in the shared AudioContext's time base (engine.getAudioContext()).

import { Emitter } from '../core/emitter.js';
import { getAudioContext } from './engine.js';
import { NoteDetector } from './detector.js';

const CONSTRAINTS = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
};
const BLOCK = 1024;
const ANALYSIS_INTERVAL = 1 / 30; // s of audio between emitted 'analysis' events
const RESUME_WAIT_MS = 800;
const WORKLET_WAIT_MS = 4000; // addModule() taking longer than this → ScriptProcessor fallback

const MESSAGES = {
  insecure: '마이크는 보안 연결(HTTPS)에서만 사용할 수 있어요. https:// 주소로 접속해 주세요.',
  unsupported: '이 브라우저에서는 마이크 입력을 사용할 수 없어요. 최신 Chrome 또는 삼성 인터넷을 사용해 주세요.',
  denied: '마이크 권한이 거부되었어요. 주소창 옆 사이트 설정에서 마이크를 허용한 뒤 다시 시도해 주세요.',
  notFound: '마이크를 찾을 수 없어요. 기기에 마이크가 연결되어 있는지 확인해 주세요.',
  busy: '마이크를 열 수 없어요. 통화·녹음 앱 등 다른 앱이 마이크를 쓰고 있다면 종료한 뒤 다시 시도해 주세요.',
  failed: '마이크를 시작하지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
  ended: '마이크 연결이 끊어졌어요. 다른 앱이 마이크를 가져갔거나 권한이 바뀌었을 수 있어요. 다시 시작해 주세요.',
};

function initialAnalysis() {
  return { time: 0, db: -120, gateOpen: false, pitch: null, topNotes: [], onset: false };
}

function inputError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// getUserMedia DOMException → { code, state, message }
function classify(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { code: 'denied', state: 'denied', message: MESSAGES.denied };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { code: 'error', state: 'error', message: MESSAGES.notFound };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { code: 'error', state: 'error', message: MESSAGES.busy };
    case 'NotSupportedError':
      return { code: 'error', state: 'error', message: MESSAGES.unsupported };
    default:
      return { code: 'error', state: 'error', message: MESSAGES.failed };
  }
}

async function requestStream(md) {
  try {
    return await md.getUserMedia(CONSTRAINTS);
  } catch (err) {
    // Some devices reject the processing / channel constraints; any microphone is better than none.
    const name = err && err.name;
    if (name !== 'OverconstrainedError' && name !== 'ConstraintNotSatisfiedError') throw err;
    return md.getUserMedia({ audio: true });
  }
}

function stopStream(stream) {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      // already stopped
    }
  }
}

const workletLoads = new WeakMap(); // AudioContext → Promise (addModule once per context)

function loadCaptureWorklet(ctx) {
  let p = workletLoads.get(ctx);
  if (!p) {
    const url = new URL('./capture-worklet.js', import.meta.url).href;
    p = Promise.resolve().then(() => ctx.audioWorklet.addModule(url));
    workletLoads.set(ctx, p);
    p.catch(() => {
      if (workletLoads.get(ctx) === p) workletLoads.delete(ctx); // allow a retry later
    });
  }
  return p;
}

// Resolves with `promise`, or rejects / resolves (`onTimeout`) after `ms`.
function withTimeout(promise, ms, onTimeout) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => (onTimeout ? reject(onTimeout()) : resolve()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Promise whose settle functions are exposed (lets a start claim its slot before any listener runs).
function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

export class AudioInput extends Emitter {
  constructor({ sensitivity = 0.6, a4 = 440 } = {}) {
    super();
    this._sensitivity = sensitivity;
    this._a4 = a4;
    this._state = 'idle';
    this._mode = null;
    this._ctx = null;
    this._detector = null;
    this._stream = null;
    this._source = null;
    this._capture = null;
    this._mute = null;
    this._sim = null;
    this._session = 0; // bumped on every start/stop; stale async work and callbacks compare against it
    this._starting = null; // pending startMic() promise
    this._simStarting = null; // pending startSimulation() promise
    this._trackEnded = null;
    this._lastError = null;
    this._analysis = initialAnalysis();
    this._lastAnalysisEmit = -Infinity;
    this._pendingOnset = false;
  }

  get state() {
    return this._state;
  }

  get mode() {
    return this._mode;
  }

  get simInput() {
    return this._sim;
  }

  get analysis() {
    return this._analysis;
  }

  get sampleRate() {
    return this._ctx ? this._ctx.sampleRate : null;
  }

  // Error (with .code) of the last failed start or of a lost microphone; null after a successful start.
  get lastError() {
    return this._lastError;
  }

  setSensitivity(s) {
    this._sensitivity = s;
    if (this._detector) this._detector.setSensitivity(s);
  }

  setA4(hz) {
    this._a4 = hz;
    if (this._detector) this._detector.setA4(hz);
  }

  // Idempotent: resolves immediately when the mic is already running and joins a start in progress. Stops a running
  // simulation. Rejects with Error .code 'insecure' | 'unsupported' | 'denied' | 'error'. A start superseded by stop()
  // or startSimulation() resolves without starting.
  startMic() {
    if (this._mode === 'mic' && this._state === 'running') return Promise.resolve();
    if (this._starting) return this._starting;
    const d = deferred();
    this._starting = d.promise;
    this._simStarting = null;
    // The slot is freed before the caller resumes, so an immediate retry starts a new attempt.
    const done = () => {
      if (this._starting === d.promise) this._starting = null;
    };
    this._startMic().then((v) => {
      done();
      d.resolve(v);
    }, (err) => {
      done();
      d.reject(err);
    });
    return d.promise;
  }

  // Analyses audio routed into `simInput` (e.g. the synth playing the chart). Stops the mic if it is running.
  startSimulation() {
    if (this._mode === 'sim' && this._state === 'running') return Promise.resolve();
    if (this._simStarting) return this._simStarting;
    const d = deferred();
    this._simStarting = d.promise;
    this._starting = null;
    const done = () => {
      if (this._simStarting === d.promise) this._simStarting = null;
    };
    this._startSimulation().then((v) => {
      done();
      d.resolve(v);
    }, (err) => {
      done();
      d.reject(err);
    });
    return d.promise;
  }

  // Stops tracks, disconnects everything; state 'idle'. Pending starts resolve without starting.
  stop() {
    this._session++;
    this._starting = null;
    this._simStarting = null;
    this._teardown();
    this._setState('idle');
  }

  // ---------------------------------------------------------------------------

  async _startMic() {
    const token = ++this._session;
    this._teardown();
    this._lastError = null;
    if (globalThis.isSecureContext === false) throw this._fail('insecure', 'unsupported', MESSAGES.insecure);
    const nav = globalThis.navigator;
    const md = nav && nav.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      throw this._fail('unsupported', 'unsupported', MESSAGES.unsupported);
    }
    let ctx;
    try {
      ctx = getAudioContext();
    } catch (err) {
      throw this._fail('unsupported', 'unsupported', MESSAGES.unsupported, err);
    }
    this._setState('requesting');
    if (token !== this._session) return; // a 'state' listener stopped or restarted the input

    let stream;
    try {
      stream = await requestStream(md);
    } catch (err) {
      if (token !== this._session) return; // superseded by stop() / another start
      const { code, state, message } = classify(err);
      throw this._fail(code, state, message, err);
    }
    if (token !== this._session) {
      stopStream(stream);
      return;
    }
    this._stream = stream;
    const tracks = stream.getAudioTracks();
    this._trackEnded = () => this._onTrackEnded(token);
    for (const t of tracks) t.addEventListener('ended', this._trackEnded);

    try {
      if (ctx.state !== 'running') {
        let resuming;
        try {
          resuming = Promise.resolve(ctx.resume()).catch(() => {});
        } catch {
          resuming = Promise.resolve();
        }
        await withTimeout(resuming, RESUME_WAIT_MS);
        if (token !== this._session) return;
      }
      const source = ctx.createMediaStreamSource(stream);
      this._source = source;
      await this._connect(ctx, source, token);
    } catch (err) {
      if (token !== this._session) return;
      throw err && err.code
        ? this._fail(err.code, err.code === 'unsupported' ? 'unsupported' : 'error', err.message, err.cause)
        : this._fail('error', 'error', MESSAGES.failed, err);
    }
    if (token !== this._session) return;
    if (!tracks.length || tracks.every((t) => t.readyState === 'ended')) {
      throw this._fail('error', 'error', MESSAGES.ended); // the device went away during setup
    }
    this._mode = 'mic';
    this._setState('running');
  }

  async _startSimulation() {
    const token = ++this._session;
    this._teardown();
    this._lastError = null;
    if (this._state === 'running') this._setState('idle');
    if (token !== this._session) return; // a 'state' listener stopped or restarted the input
    let ctx;
    try {
      ctx = getAudioContext();
    } catch (err) {
      throw this._fail('unsupported', 'unsupported', MESSAGES.unsupported, err);
    }
    let sim;
    try {
      sim = ctx.createGain();
      sim.gain.value = 1;
      this._sim = sim;
      this._source = sim;
      await this._connect(ctx, sim, token);
    } catch (err) {
      if (token !== this._session) return;
      throw err && err.code
        ? this._fail(err.code, err.code === 'unsupported' ? 'unsupported' : 'error', err.message, err.cause)
        : this._fail('error', 'error', MESSAGES.failed, err);
    }
    if (token !== this._session) return;
    this._mode = 'sim';
    this._setState('running');
  }

  // Tears down the current session and records the error. Returns the Error (with .code) to throw.
  _fail(code, state, message, cause) {
    this._session++;
    this._teardown();
    const err = inputError(code, message, cause);
    this._lastError = err;
    this._setState(state);
    return err;
  }

  // The microphone track ended on its own: unplugged, taken by another app, permission revoked.
  _onTrackEnded(token) {
    if (token !== this._session || this._mode !== 'mic') return; // during setup _startMic checks the tracks itself
    console.warn('[AudioInput]', MESSAGES.ended);
    this._fail('error', 'error', MESSAGES.ended);
  }

  // Builds source → capture node → muted gain → destination. The muted path keeps the capture node pulled.
  async _connect(ctx, source, token) {
    this._ctx = ctx;
    if (!this._detector || this._detector.sampleRate !== ctx.sampleRate) {
      this._detector = new NoteDetector({ sampleRate: ctx.sampleRate, sensitivity: this._sensitivity, a4: this._a4 });
    } else {
      this._detector.setSensitivity(this._sensitivity);
      this._detector.setA4(this._a4);
      this._detector.reset();
    }
    this._analysis = initialAnalysis();
    this._lastAnalysisEmit = -Infinity;
    this._pendingOnset = false;

    let node = null;
    if (ctx.audioWorklet && typeof globalThis.AudioWorkletNode === 'function') {
      try {
        await withTimeout(loadCaptureWorklet(ctx), WORKLET_WAIT_MS, () => new Error('AudioWorklet load timeout'));
        if (token !== this._session) return;
        node = new globalThis.AudioWorkletNode(ctx, 'capture-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        node.port.onmessage = (e) => {
          const d = e.data;
          if (d && d.samples) this._onBlock(d.samples, d.time, token);
        };
      } catch (err) {
        if (token !== this._session) return;
        console.warn('[AudioInput] AudioWorklet을 사용할 수 없어 ScriptProcessor로 대체합니다.', err);
        node = null;
      }
    }
    if (!node) {
      if (typeof ctx.createScriptProcessor !== 'function') throw inputError('unsupported', MESSAGES.unsupported);
      node = ctx.createScriptProcessor(BLOCK, 1, 1);
      const dur = BLOCK / ctx.sampleRate;
      node.onaudioprocess = (e) => {
        // The event fires when the input buffer is full; its output plays one buffer later at playbackTime, so the
        // input started two buffers before playbackTime (an approximation where playbackTime is missing).
        const pt = e.playbackTime;
        const t = Number.isFinite(pt) && pt > 0 ? pt - 2 * dur : ctx.currentTime - dur;
        this._onBlock(e.inputBuffer.getChannelData(0), t, token);
      };
    }
    this._capture = node;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this._mute = mute;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  _onBlock(samples, time, token) {
    if (token !== this._session || !this._detector) return;
    let events;
    try {
      events = this._detector.push(samples, time);
    } catch (err) {
      console.error('[AudioInput] 분석 오류', err);
      return;
    }
    for (const ev of events) {
      this.emit('note', ev);
      if (token !== this._session) return; // a listener stopped the input
    }
    const a = this._detector.analysis;
    if (a === this._analysis) return;
    this._analysis = a;
    if (a.onset) this._pendingOnset = true;
    if (a.time - this._lastAnalysisEmit >= ANALYSIS_INTERVAL - 1e-6 || a.time < this._lastAnalysisEmit) {
      this._lastAnalysisEmit = a.time;
      // An onset flagged in a skipped snapshot is carried into the next emitted one.
      const out = this._pendingOnset && !a.onset ? { ...a, onset: true } : a;
      this._pendingOnset = false;
      this.emit('analysis', out);
    }
  }

  _teardown() {
    const cap = this._capture;
    if (cap) {
      if (cap.port) {
        try {
          cap.port.onmessage = null;
          cap.port.postMessage('stop');
        } catch {
          // port already closed
        }
      }
      if ('onaudioprocess' in cap) cap.onaudioprocess = null;
    }
    for (const n of [this._source, cap, this._mute, this._sim]) {
      if (!n) continue;
      try {
        n.disconnect();
      } catch {
        // not connected
      }
    }
    if (this._stream) {
      if (this._trackEnded) {
        for (const t of this._stream.getTracks()) t.removeEventListener('ended', this._trackEnded);
      }
      stopStream(this._stream);
    }
    this._stream = null;
    this._trackEnded = null;
    this._source = null;
    this._capture = null;
    this._mute = null;
    this._sim = null;
    this._mode = null;
    this._analysis = initialAnalysis();
    this._pendingOnset = false;
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
    this.emit('state', s);
  }
}
