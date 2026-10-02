// Minimal Web Audio / media-capture fakes for unit-testing engine.js and input.js in Node.

export class FakeParam {
  constructor(value) {
    this.value = value;
    this.calls = [];
  }

  cancelScheduledValues(t) {
    this.calls.push(['cancel', t]);
  }

  setValueAtTime(v, t) {
    this.calls.push(['set', v, t]);
    this.value = v;
  }

  setTargetAtTime(v, t, tc) {
    this.calls.push(['target', v, t, tc]);
    this.value = v;
  }
}

export class FakeNode {
  constructor(ctx, type) {
    this.context = ctx;
    this.type = type;
    this.outputs = [];
    this.disconnects = 0;
    ctx.nodes.push(this);
  }

  connect(dest) {
    this.outputs.push(dest);
    return dest;
  }

  disconnect() {
    this.outputs = [];
    this.disconnects++;
  }
}

export class FakeAudioContext {
  constructor(options) {
    FakeAudioContext.instances.push(this);
    if (FakeAudioContext.rejectOptions && options !== undefined) throw new TypeError('options not supported');
    this.options = options;
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = FakeAudioContext.sampleRate;
    this.nodes = [];
    this.destination = new FakeNode(this, 'destination');
    this.resumeCalls = 0;
    this.resumeHangs = false;
    this.modules = [];
    this.addModuleCalls = [];
    this.addModuleImpl = null; // (url) => Promise; default: registers immediately
    this.audioWorklet = {
      addModule: (url) => {
        this.addModuleCalls.push(url);
        if (this.addModuleImpl) return this.addModuleImpl(url);
        this.modules.push(url);
        return Promise.resolve();
      },
    };
  }

  resume() {
    this.resumeCalls++;
    if (this.resumeHangs) return new Promise(() => {});
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    this.state = 'closed';
    return Promise.resolve();
  }

  createGain() {
    const n = new FakeNode(this, 'gain');
    n.gain = new FakeParam(1);
    return n;
  }

  createDynamicsCompressor() {
    const n = new FakeNode(this, 'compressor');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new FakeParam(0);
    return n;
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    return { numberOfChannels, length, sampleRate };
  }

  createBufferSource() {
    const n = new FakeNode(this, 'bufferSource');
    n.buffer = null;
    n.started = [];
    n.start = (t) => n.started.push(t);
    return n;
  }

  createMediaStreamSource(stream) {
    const n = new FakeNode(this, 'mediaStreamSource');
    n.mediaStream = stream;
    return n;
  }

  createScriptProcessor(bufferSize, inputs, outputs) {
    const n = new FakeNode(this, 'scriptProcessor');
    n.bufferSize = bufferSize;
    n.channels = [inputs, outputs];
    n.onaudioprocess = null;
    return n;
  }

  nodesOf(type) {
    return this.nodes.filter((n) => n.type === type);
  }
}
FakeAudioContext.instances = [];
FakeAudioContext.sampleRate = 48000;
FakeAudioContext.rejectOptions = false;

export class FakeAudioWorkletNode extends FakeNode {
  constructor(ctx, name, options) {
    if (!ctx.modules.length) throw new DOMException(`processor '${name}' is not registered`, 'InvalidStateError');
    super(ctx, 'worklet');
    this.name = name;
    this.options = options;
    const sent = [];
    this.port = {
      onmessage: null,
      sent,
      postMessage(msg) {
        sent.push(msg);
      },
    };
  }
}

export class FakeTrack extends EventTarget {
  constructor() {
    super();
    this.kind = 'audio';
    this.readyState = 'live';
    this.stopped = false;
  }

  stop() {
    this.readyState = 'ended';
    this.stopped = true;
  }

  // Simulates the browser ending the track (device lost, permission revoked, taken by another app).
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeStream {
  constructor() {
    this.tracks = [new FakeTrack()];
  }

  getTracks() {
    return this.tracks.slice();
  }

  getAudioTracks() {
    return this.tracks.slice();
  }
}

// getUserMedia fake: records constraints; `impl(constraints)` decides the outcome (default: a new FakeStream).
export class FakeMediaDevices {
  constructor() {
    this.calls = [];
    this.streams = [];
    this.impl = null;
  }

  getUserMedia(constraints) {
    this.calls.push(constraints);
    if (this.impl) return this.impl(constraints);
    const s = new FakeStream();
    this.streams.push(s);
    return Promise.resolve(s);
  }
}

// A getUserMedia implementation that waits until `release()` / `fail(err)` is called.
export function pendingUserMedia(md) {
  const ctl = {};
  md.impl = () => new Promise((resolve, reject) => {
    ctl.release = () => {
      const s = new FakeStream();
      md.streams.push(s);
      resolve(s);
      return s;
    };
    ctl.fail = reject;
  });
  return ctl;
}

export function domError(name, message = name) {
  return new DOMException(message, name);
}

// Installs the fakes on globalThis. Returns { mediaDevices, restore }.
export function installWebAudioFakes({ secure = true, mediaDevices = true, worklet = true } = {}) {
  const saved = {};
  const set = (key, value) => {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const md = new FakeMediaDevices();
  set('AudioContext', FakeAudioContext);
  set('AudioWorkletNode', worklet ? FakeAudioWorkletNode : undefined);
  set('isSecureContext', secure);
  set('navigator', mediaDevices ? { mediaDevices: md, userAgent: 'test' } : { userAgent: 'test' });
  return {
    mediaDevices: md,
    restore() {
      for (const [key, desc] of Object.entries(saved)) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    },
  };
}

// Lets pending promise callbacks (several hops deep) run.
export async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
