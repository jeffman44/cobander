// Offline audio re-timing for takes and parts bin drops. Pure DSP on Float32Arrays (unit-testable in node),
// plus small AudioBuffer wrappers for the renderer.
//
//   varispeed   tape-style: speed and pitch move together (tempo changes on a song)
//   stretch     WSOLA time-stretch: length changes, pitch stays (parts bin tempo match)
//   conform     tempo ratio + pitch shift in semitones, independently (parts bin: fit a part to the song's tempo AND key)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPStretch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Linear-interpolation resample: rate > 1 = faster/higher (output shorter). Good enough for sketches; the
  // browser path uses OfflineAudioContext instead (better interpolation).
  function resampleChannels(chans, rate) {
    const n = chans[0].length, m = Math.max(1, Math.round(n / rate));
    return chans.map((x) => {
      const y = new Float32Array(m);
      for (let i = 0; i < m; i++) { const p = i * rate, k = Math.floor(p), fr = p - k; const a = x[Math.min(n - 1, k)], b = x[Math.min(n - 1, k + 1)]; y[i] = a + (b - a) * fr; }
      return y;
    });
  }

  // WSOLA: output length ≈ input length × alpha, pitch unchanged. Frames of `N` samples are overlap-added at a fixed
  // synthesis hop; each next frame is taken near its nominal input position where it best continues the previous one
  // (cross-correlation on a decimated mono mix — fast enough for minutes of audio).
  function stretchChannels(chans, alpha, { sampleRate = 48000 } = {}) {
    if (!(alpha > 0)) throw new Error('bad stretch factor');
    const n = chans[0].length;
    if (Math.abs(alpha - 1) < 1e-4 || n < 4096) return alpha === 1 || n === 0 ? chans.map((c) => c.slice()) : resampleChannels(chans, 1 / alpha).map((y) => y);   // tiny clips: just resample (pitch moves a hair)
    const N = sampleRate >= 88000 ? 4096 : 2048, Hs = N >> 1, Ha = Hs / alpha, delta = N >> 2, dec = 8;
    const outLen = Math.max(1, Math.round(n * alpha));
    const out = chans.map(() => new Float32Array(outLen + N));
    const norm = new Float32Array(outLen + N);
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const mono = new Float32Array(n); for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i] / chans.length;
    let prevIn = 0;   // where the previous frame was taken from
    for (let k = 0, outPos = 0; outPos < outLen; k++, outPos += Hs) {
      const nominal = Math.round(k * Ha);
      let best = Math.min(Math.max(0, nominal), Math.max(0, n - 1));
      if (k > 0) {
        // natural continuation of the previous frame is prevIn + Hs; find the candidate around `nominal` most like it
        const ref = prevIn + Hs; let bestScore = -Infinity;
        const lo = Math.max(0, nominal - delta), hi = Math.min(n - N, nominal + delta);
        for (let cand = lo; cand <= hi; cand += 2) {
          let sc = 0; for (let j = 0; j < Hs; j += dec) { const r = ref + j < n ? mono[ref + j] : 0; sc += r * mono[cand + j]; }
          if (sc > bestScore) { bestScore = sc; best = cand; }
        }
        if (hi < lo) best = Math.min(Math.max(0, nominal), Math.max(0, n - 1));
      }
      for (let c = 0; c < chans.length; c++) { const x = chans[c], y = out[c]; for (let j = 0; j < N; j++) { const s = best + j; if (s >= n) break; y[outPos + j] += x[s] * win[j]; } }
      for (let j = 0; j < N; j++) norm[outPos + j] += win[j];
      prevIn = best;
    }
    return out.map((y) => { const z = new Float32Array(outLen); for (let i = 0; i < outLen; i++) z[i] = norm[i] > 1e-3 ? y[i] / norm[i] : y[i]; return z; });
  }

  // Fit audio to a new tempo (ratio = target bpm / source bpm, > 1 = faster) and shift its pitch by `semis`, independently.
  // Resample by the pitch factor (moves pitch and length), then WSOLA-stretch to the length the tempo wants.
  function conformChannels(chans, { ratio = 1, semis = 0, sampleRate = 48000 } = {}) {
    const p = Math.pow(2, semis / 12);
    const pitched = Math.abs(p - 1) < 1e-6 ? chans : resampleChannels(chans, p);
    const alpha = p / ratio;   // final length = n / ratio
    return stretchChannels(pitched, alpha, { sampleRate });
  }

  // ---- AudioBuffer wrappers (browser) ----
  function toChannels(buf) { const out = []; for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c).slice()); return out; }
  function toBuffer(chans, sampleRate) {
    const Ctx = typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null; if (!Ctx) throw new Error('no audio context');
    const b = new AudioBuffer({ numberOfChannels: chans.length, length: chans[0].length, sampleRate });
    chans.forEach((c, i) => b.copyToChannel(c, i)); return b;
  }
  async function varispeed(buf, rate) {
    const len = Math.max(1, Math.ceil(buf.length / rate));
    const off = new OfflineAudioContext(buf.numberOfChannels, len, buf.sampleRate);
    const src = off.createBufferSource(); src.buffer = buf.toAudioBuffer ? buf.toAudioBuffer(off) : buf;   // a store entry (16-bit take) or a real AudioBuffer src.playbackRate.value = rate; src.connect(off.destination); src.start(0);
    return off.startRendering();
  }
  async function conform(buf, { ratio = 1, semis = 0 } = {}) {
    if (Math.abs(ratio - 1) < 1e-4 && !semis) return buf;
    await new Promise((r) => setTimeout(r, 0));   // let the UI paint the progress line first
    return toBuffer(conformChannels(toChannels(buf), { ratio, semis, sampleRate: buf.sampleRate }), buf.sampleRate);
  }

  return { resampleChannels, stretchChannels, conformChannels, varispeed, conform };
});
