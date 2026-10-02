// AudioWorkletProcessor 'capture-processor': forwards mono input to the main thread in 1024-sample blocks as
// { samples: Float32Array(1024), time } where `time` is the context time of samples[0] (the buffer is transferred).
// The output stays silent; it exists so the node can be connected (through a muted gain) to the destination, which
// keeps it pulled on every browser. Post 'stop' to the port to end processing.

const BLOCK = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.fill = 0;
    this.t0 = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.alive = false;
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const input = inputs[0];
    const ch = input && input.length ? input[0] : null;
    // An input without channels is silent (e.g. the simulation bus while nothing plays): keep the stream continuous
    // so the analysis sees the silence and its timestamps stay contiguous.
    const out = outputs[0] && outputs[0][0];
    const n = ch ? ch.length : out ? out.length : 128;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.t0 = currentTime + i / sampleRate;
      this.buf[this.fill++] = ch ? ch[i] : 0;
      if (this.fill === BLOCK) {
        const samples = this.buf;
        this.port.postMessage({ samples, time: this.t0 }, [samples.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
