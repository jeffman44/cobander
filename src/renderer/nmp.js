// The note tracker's ears: Spotify's Basic Pitch model (models/nmp.onnx, Apache-2.0, ~230 KB) run with ONNX Runtime on
// this computer. Audio in (any rate, mono) → per-frame posteriors for the 88 piano pitches (note on / note starting)
// plus a 1/3-semitone pitch contour. notes.js turns those into notes.
// Windows of 2 s overlap by 30 frames; the overlap halves are cut so each frame comes from the middle of a window
// (the same framing as Basic Pitch's own inference code).
// Works in a worker or in node: run(ort, session, audio, sr) where ort is onnxruntime-web and session its loaded model.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPNmp = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SR = 22050, HOP = 256, N = SR * 2 - HOP, OVF = 30, OV = OVF * HOP, STEP = N - OV, FPW = 172, NP = 88, NC = 264;
  // band-limited resampling (windowed sinc, 16 zero crossings) — a guitar's top end must not alias into fake notes
  function resample(x, from, to = SR) {
    if (from === to) return x;
    const ratio = to / from; const n = Math.floor(x.length * ratio); const y = new Float32Array(n);
    const cut = Math.min(1, ratio) * 0.95; const Z = 16; const half = Math.ceil(Z / cut);
    const TAB = 512; const tab = new Float32Array(half * TAB + 1);
    for (let i = 0; i <= half * TAB; i++) { const u = i / TAB; const w = u >= half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * u) / half); tab[i] = (u === 0 ? 1 : Math.sin(Math.PI * cut * u) / (Math.PI * cut * u)) * w * cut; }
    for (let j = 0; j < n; j++) {
      const c = j / ratio; const i0 = Math.floor(c); let s = 0;
      for (let k = i0 - half + 1; k <= i0 + half; k++) { if (k < 0 || k >= x.length) continue; const u = Math.abs(c - k) * cut / cut; const ti = Math.round(u * TAB); if (ti < tab.length) s += x[k] * tab[ti]; }
      y[j] = s;
    }
    return y;
  }
  // audio (mono, any sr) → { T, note, onset, contour }
  async function run(ort, session, audio, sr, { onProgress = null } = {}) {
    const x = resample(audio, sr, SR);
    const pad = new Float32Array(OV / 2 + x.length); pad.set(x, OV / 2);
    const want = Math.floor(x.length * (Math.floor(SR / HOP) / SR));   // frames the original length covers (Basic Pitch's own count)
    const keep = FPW - OVF; const wins = Math.max(1, Math.ceil(pad.length / STEP));
    const T = Math.min(want, wins * keep);
    const note = new Float32Array(T * NP), onset = new Float32Array(T * NP), contour = new Float32Array(T * NC);
    const inName = session.inputNames[0]; const outs = session.outputNames;
    // outputs: …:0 contour (264 bins), …:1 note, …:2 onset — matched by width and name order, not hard-wired names
    const byW = (w) => outs.filter((k) => true).map((k) => k);
    let t = 0; const w = new Float32Array(N);
    for (let k = 0; k < wins && t < T; k++) {
      w.fill(0); w.set(pad.subarray(k * STEP, k * STEP + N));
      const r = await session.run({ [inName]: new ort.Tensor('float32', w, [1, N, 1]) });
      const list = outs.map((name) => r[name]); const C = list.find((o) => o.dims[2] === NC); const nb = list.filter((o) => o.dims[2] === NP);
      const nameOf = (o) => outs[list.indexOf(o)]; nb.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const [NOTE, ONSET] = nb;   // StatefulPartitionedCall:1 = note, :2 = onset
      const n = Math.min(keep, T - t);
      note.set(NOTE.data.subarray((OVF / 2) * NP, (OVF / 2 + n) * NP), t * NP);
      onset.set(ONSET.data.subarray((OVF / 2) * NP, (OVF / 2 + n) * NP), t * NP);
      contour.set(C.data.subarray((OVF / 2) * NC, (OVF / 2 + n) * NC), t * NC);
      t += n; if (onProgress) onProgress(Math.min(1, (k + 1) / wins));
    }
    void byW;
    return { T: t, note: note.subarray(0, t * NP), onset: onset.subarray(0, t * NP), contour: contour.subarray(0, t * NC) };
  }
  return { run, resample, SR };
});
