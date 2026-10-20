// Tuner: YIN pitch detection on the live input (works down to a 5-string bass's low B, ~31 Hz) and note naming.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPTuner = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // x: Float32Array (≥ 2 periods of the lowest note), sr → {freq, clarity} or null (silence / noise)
  function detect(x, sr, { minHz = 28, maxHz = 1400, threshold = 0.12, minRms = 0.004 } = {}) {
    const n = x.length; let rms = 0; for (let i = 0; i < n; i++) rms += x[i] * x[i]; rms = Math.sqrt(rms / n);
    if (rms < minRms) return null;
    const maxLag = Math.min(Math.floor(sr / minHz), Math.floor(n / 2)), minLag = Math.max(2, Math.floor(sr / maxHz));
    const W = n - maxLag; if (W < 64) return null;
    const d = new Float32Array(maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau++) { let s = 0; for (let i = 0; i < W; i++) { const v = x[i] - x[i + tau]; s += v * v; } d[tau] = s; }
    // cumulative mean normalised difference
    const cm = new Float32Array(maxLag + 1); cm[0] = 1; let run = 0;
    for (let tau = 1; tau <= maxLag; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
    let tau = -1;
    for (let t = minLag; t <= maxLag; t++) if (cm[t] < threshold) { while (t + 1 <= maxLag && cm[t + 1] < cm[t]) t++; tau = t; break; }
    if (tau < 0) { let best = minLag; for (let t = minLag; t <= maxLag; t++) if (cm[t] < cm[best]) best = t; if (cm[best] > 0.35) return null; tau = best; }
    // parabolic interpolation for sub-sample accuracy
    let bt = tau; if (tau > 1 && tau < maxLag) { const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1]; const den = a - 2 * b + c; if (den) bt = tau + 0.5 * (a - c) / den; }
    return { freq: sr / bt, clarity: 1 - cm[tau] };
  }
  function note(freq, a4 = 440) {
    if (!(freq > 0)) return null;
    const m = 69 + 12 * Math.log2(freq / a4); const midi = Math.round(m); const cents = Math.round((m - midi) * 100);
    return { midi, name: NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents, target: a4 * 2 ** ((midi - 69) / 12) };
  }
  return { detect, note, NAMES };
});
