// Noise gate: envelope follower → hard-ish gate with hysteresis, attack/hold/release.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -90, maxValue: 0 },   // dBFS
      { name: 'on', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }
  constructor() { super(); this.env = 0; this.gain = 1; this.hold = 0; this.isOpen = false; }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const on = params.on[0] > 0.5;
    const thr = Math.pow(10, params.threshold[0] / 20);
    const open = thr, close = thr * 0.5;              // 6 dB hysteresis
    const attack = Math.exp(-1 / (0.001 * sampleRate)), release = Math.exp(-1 / (0.08 * sampleRate));
    const envA = Math.exp(-1 / (0.002 * sampleRate)), envR = Math.exp(-1 / (0.05 * sampleRate));
    const holdSamples = 0.05 * sampleRate;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) { const a = Math.abs(input[c][i]); if (a > peak) peak = a; }
      this.env = peak > this.env ? envA * this.env + (1 - envA) * peak : envR * this.env + (1 - envR) * peak;
      let target;
      if (!on) target = 1;
      else {
        if (this.isOpen) { if (this.env < close) { if (this.hold > 0) this.hold--; else this.isOpen = false; } else this.hold = holdSamples; }
        else if (this.env > open) { this.isOpen = true; this.hold = holdSamples; }
        target = this.isOpen ? 1 : 0;
      }
      this.gain = target > this.gain ? attack * this.gain + (1 - attack) * target : release * this.gain + (1 - release) * target;
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain;
    }
    return true;
  }
}
registerProcessor('bp-gate', GateProcessor);
