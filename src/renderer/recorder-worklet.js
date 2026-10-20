// Captures raw input frames and posts them to the main thread in ~100 ms chunks.
// On 'start' it reports the exact context frame at which capture began so the engine
// can align the take to the sample.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.chunks = [];
    this.frames = 0;
    this.channels = 0;
    this.pendingStart = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.pendingStart = true; this.chunks = []; this.frames = 0; this.channels = 0; }
      else if (e.data === 'stop') { this.flush(); this.active = false; this.pendingStart = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.chunks.length) return;
    const n = this.channels;
    const out = [];
    for (let c = 0; c < n; c++) {
      const buf = new Float32Array(this.frames);
      let o = 0;
      for (const ch of this.chunks) { const src = ch[c] || new Float32Array(ch[0].length); buf.set(src, o); o += ch[0].length; }
      out.push(buf);
    }
    this.port.postMessage({ chunk: out }, out.map((b) => b.buffer));
    this.chunks = []; this.frames = 0;
  }
  process(inputs) {
    if (this.pendingStart) {
      this.pendingStart = false; this.active = true;
      this.port.postMessage({ started: currentFrame, sampleRate });
    }
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || !input.length) return true;
    if (!this.channels) this.channels = input.length;
    const copy = [];
    for (let c = 0; c < this.channels; c++) copy.push(Float32Array.from(input[c] || new Float32Array(128)));
    this.chunks.push(copy);
    this.frames += copy[0].length;
    if (this.frames >= 4800) this.flush();
    return true;
  }
}
registerProcessor('bp-recorder', RecorderProcessor);
