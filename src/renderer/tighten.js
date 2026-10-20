// Tighten a take to the grid: find the hits (spectral-flux onsets, refined to the sample), decide how far each one
// moves toward the nearest grid line (strength, a capture window), then re-time the audio piecewise between hits
// with WSOLA so every transient lands where it should and stays sharp. Pure DSP on Float32Arrays (node-testable).
(function (root, factory) {
  const api = factory(() => (typeof module === 'object' && module.exports ? require('./stretch.js') : root.BPStretch));   // looked up on use
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPTighten = api;
})(typeof self !== 'undefined' ? self : this, function (getStretch) {
  'use strict';

  // in-place radix-2 FFT (re, im of length 2^k)
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half; const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // ---- onsets: spectral flux (log magnitude, half-wave rectified) → adaptive threshold → peaks → sample-accurate ----
  function onsets(mono, sr, { hop = 256, win = 1024, sensitivity = 1 } = {}) {
    const n = mono.length; if (n < win) return [];
    const frames = Math.floor((n - win) / hop) + 1; const bins = win >> 1;
    const w = new Float32Array(win); for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win);
    const re = new Float64Array(win), im = new Float64Array(win);
    let prev = new Float32Array(bins), cur = new Float32Array(bins); const flux = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const o = f * hop; for (let i = 0; i < win; i++) { re[i] = mono[o + i] * w[i]; im[i] = 0; }
      fft(re, im);
      let s = 0; for (let k = 1; k < bins; k++) { const m = Math.log1p(1000 * Math.sqrt(re[k] * re[k] + im[k] * im[k])); cur[k] = m; const d = m - prev[k]; if (d > 0) s += d; }
      flux[f] = f ? s : 0; const t = prev; prev = cur; cur = t;
    }
    // adaptive threshold: local median (±8 frames) × factor + a delta from the overall flux level
    let mean = 0; for (let f = 0; f < frames; f++) mean += flux[f]; mean /= frames;
    const delta = mean * 0.6 / sensitivity, M = 8, out = [];
    const minGap = Math.round(0.05 * sr / hop); let last = -Infinity;
    const tmp = [];
    for (let f = 1; f < frames - 1; f++) {
      if (!(flux[f] >= flux[f - 1] && flux[f] > flux[f + 1])) continue;
      tmp.length = 0; for (let k = Math.max(0, f - M); k <= Math.min(frames - 1, f + M); k++) tmp.push(flux[k]); tmp.sort((a, b) => a - b);
      const thr = tmp[tmp.length >> 1] * 1.4 + delta;
      if (flux[f] < thr) continue;
      if (f - last < minGap) { if (out.length && flux[f] > out[out.length - 1].flux) { out[out.length - 1] = { f, flux: flux[f] }; last = f; } continue; }
      out.push({ f, flux: flux[f] }); last = f;
    }
    // refine: the frame says "somewhere in this window"; the energy envelope says where the hit really starts
    const env = envelope(mono, Math.max(1, Math.round(sr * 0.0005)));
    const maxFlux = out.reduce((m, x) => Math.max(m, x.flux), 0) || 1;
    const res = [];
    for (const { f, flux: fl } of out) {
      const centre = f * hop + (win >> 1);
      const a = Math.max(0, centre - Math.round(0.03 * sr)), b = Math.min(n - 1, centre + Math.round(0.02 * sr));
      let p = a; for (let i = a; i <= b; i++) if (env[i] > env[p]) p = i;
      let fl0 = env[p], q = a; for (let i = a; i <= p; i++) if (env[i] < fl0) { fl0 = env[i]; q = i; }
      const lvl = fl0 + 0.15 * (env[p] - fl0); let t = p; for (let i = q; i <= p; i++) if (env[i] >= lvl) { t = i; break; }
      res.push({ t: t / sr, strength: fl / maxFlux });
    }
    // two flux peaks that refined onto the same hit: keep the stronger
    const ded = []; for (const x of res) { const l = ded[ded.length - 1]; if (l && x.t - l.t < 0.05) { if (x.strength > l.strength) ded[ded.length - 1] = x; } else ded.push(x); }
    return ded;
  }
  function envelope(x, w) {   // moving mean of |x| over w samples, centred-ish (causal window ending at i)
    const n = x.length, e = new Float32Array(n); let s = 0;
    for (let i = 0; i < n; i++) { s += Math.abs(x[i]); if (i >= w) s -= Math.abs(x[i - w]); e[i] = s / Math.min(i + 1, w); }
    return e;
  }

  const nearest = (grid, t) => { let lo = 0, hi = grid.length - 1; if (hi < 0) return null; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (grid[m] <= t) lo = m; else hi = m; } return Math.abs(grid[lo] - t) <= Math.abs(grid[hi] - t) ? grid[lo] : grid[hi]; };

  // ---- plan: onsets → anchors {src, dst} (seconds, monotonic) ----
  function plan(onsetList, gridTimes, { strength = 0.6, window = 0.07, minStrength = 0.15, keepEnds = true, length = null, minGap = 0.012 } = {}) {
    const grid = (gridTimes || []).slice().sort((a, b) => a - b);
    const maxS = (onsetList || []).reduce((m, o) => Math.max(m, o.strength == null ? 1 : o.strength), 0) || 1;
    const cand = [];
    for (const o of (onsetList || []).slice().sort((a, b) => a.t - b.t)) {
      if ((o.strength == null ? 1 : o.strength) < minStrength * maxS) continue;
      const g = nearest(grid, o.t); const d = g == null ? Infinity : g - o.t;
      cand.push({ src: o.t, dst: Math.abs(d) <= window ? o.t + strength * d : o.t, err: Math.abs(d) <= window ? Math.abs(d) : null, off: Math.abs(d) <= window ? -d : null });   // off: how late (+) / early (−) the hit is
    }
    const out = []; if (keepEnds) out.push({ src: 0, dst: 0, end: true });
    for (const a of cand) {
      const p = out[out.length - 1];
      if (p && (a.src - p.src < minGap || a.dst - p.dst < minGap)) continue;   // would cross / squeeze to nothing
      out.push(a);
    }
    if (keepEnds && length != null) { while (out.length > 1 && length - out[out.length - 1].dst < minGap) out.pop(); out.push({ src: length, dst: length, end: true }); }
    return out;
  }

  // Is the take simply late / early as a whole (a latency offset) rather than loose? → { ms, spreadMs, n } or null
  function offsetOf(anchors, { minN = 8 } = {}) {
    const v = (anchors || []).filter((a) => a.off != null).map((a) => a.off).sort((x, y) => x - y); if (v.length < minN) return null;
    const med = v[Math.floor(v.length / 2)]; const dev = v.map((x) => Math.abs(x - med)).sort((x, y) => x - y); const mad = dev[Math.floor(dev.length / 2)];
    return { ms: med * 1000, spreadMs: mad * 1000, n: v.length };
  }
  // ---- warp: piecewise re-time so each anchor.src lands at anchor.dst ----
  function warp(channels, sr, anchors, { maxRatio = 1.25, pre = 0.003, xfade = 48, holdSec = 0.04 } = {}) {
    const S = getStretch(); const n = channels[0].length; const nch = channels.length;
    // boundaries a hair before each hit, so a whole transient starts each piece (and WSOLA's first frame is exact)
    const pts = [{ s: 0, d: 0 }];
    for (const a of (anchors || []).slice().sort((x, y) => x.src - y.src)) {
      if (a.end) continue;
      const s = Math.round((a.src - pre) * sr), d = Math.round((a.dst - pre) * sr);
      const p = pts[pts.length - 1]; if (s <= p.s + 16 || d <= p.d + 16 || s >= n) continue;
      pts.push({ s, d });
    }
    pts.push({ s: n, d: n });
    const out = channels.map(() => new Float32Array(n + 4 * xfade));
    let pos = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i].s, b = pts[i + 1].s; const srcLen = b - a; if (srcLen <= 0) continue;
      let want = pts[i + 1].d - pos;   // carries any earlier clamp error forward, so later hits still land
      const r = Math.min(maxRatio, Math.max(1 / maxRatio, want / srcLen)); want = Math.max(1, Math.round(srcLen * r));
      const ext = Math.min(xfade, n - b);   // a little extra to crossfade into the next piece
      // the hit itself (first `hold` s) is copied untouched; only the ring / decay after it is stretched or squeezed
      const hold = Math.min(Math.round(holdSec * sr), Math.floor(srcLen * 0.5), Math.max(0, want - 64));
      const tailSrc = srcLen - hold, tailWant = want - hold;
      let y;
      if (Math.abs(want / srcLen - 1) < 1e-4 || tailSrc < 64) y = channels.map((c) => c.slice(a, b + ext));
      else {
        void S;
        const t = splice(channels.map((c) => c.subarray(a + hold, b)), tailWant - tailSrc, sr);
        y = channels.map((c, k) => { const z = new Float32Array(hold + t[k].length + ext); z.set(c.subarray(a, a + hold), 0); z.set(t[k], hold); z.set(c.subarray(b, b + ext), hold + t[k].length); return z; });
      }
      const tail = y[0].length - want;   // ≈ ext × ratio
      for (let c = 0; c < nch; c++) {
        const o = out[c], s = y[c];
        for (let j = 0; j < s.length; j++) {
          const k = pos + j; if (k >= o.length) break;
          if (i > 0 && j < xfade) { const g = j / xfade; o[k] = o[k] * (1 - g) + s[j] * g; }   // fade in over the previous piece's tail
          else o[k] = s[j];
        }
      }
      void tail; pos += want;
    }
    return out.map((o) => o.slice(0, n));
  }

  // Lengthen (delta > 0) or shorten (delta < 0) a stretch of ring / decay by |delta| samples with crossfaded splices
  // where the audio best matches itself (cut a bit out / repeat a bit), so levels and pitch never jump.
  function splice(chs, delta, sr) {
    let cur = chs.map((c) => Float32Array.from(c));
    const X0 = Math.round(0.01 * sr);
    let left = Math.round(delta), guard = 0;
    while (left !== 0 && guard++ < 16) {
      const n = cur[0].length; const X = Math.min(X0, Math.floor(n / 4)); if (X < 16) break;
      const room = n - 2 * X; if (room < 16) break;
      const D = Math.max(1, Math.min(Math.abs(left), Math.floor(room * 0.6)));
      // splice point p: join x[p] onto x[p + D] (shorten) or x[p + D] back onto x[p] (lengthen) — same match either way
      const mono = new Float32Array(n); for (const c of cur) for (let i = 0; i < n; i++) mono[i] += c[i];
      const lo = Math.max(0, Math.floor((n - D - X) * 0.35)), hi = n - D - X; let best = hi, bs = -Infinity;
      for (let q = lo; q <= hi; q += 8) {
        let xy = 0, xx = 1e-12, yy = 1e-12;
        for (let j = 0; j < X; j += 4) { const u = mono[q + j], v = mono[q + D + j]; xy += u * v; xx += u * u; yy += v * v; }
        const sc = xy / Math.sqrt(xx * yy) - 0.15 * Math.abs(Math.log(xx / yy));   // similar shape AND similar level
        if (sc > bs) { bs = sc; best = q; }
      }
      const pq = best;
      cur = cur.map((c) => {
        if (left < 0) {   // c[0..pq+X) crossfaded into c[pq+D..): D samples gone
          const z = new Float32Array(n - D); z.set(c.subarray(0, pq), 0);
          for (let j = 0; j < X; j++) { const g = j / X; z[pq + j] = c[pq + j] * (1 - g) + c[pq + D + j] * g; }
          z.set(c.subarray(pq + D + X), pq + X); return z;
        }
        // lengthen: c[0..pq+D+X) then again from c[pq+X..): the stretch [pq, pq+D) plays twice
        const z = new Float32Array(n + D); z.set(c.subarray(0, pq + D), 0);
        for (let j = 0; j < X; j++) { const g = j / X; z[pq + D + j] = c[pq + D + j] * (1 - g) + c[pq + j] * g; }
        z.set(c.subarray(pq + X), pq + D + X); return z;
      });
      left += left < 0 ? D : -D;
    }
    return cur;
  }

  // song-time convenience: grid(fromSec, toSec) gives grid lines in song seconds
  function tightenClip({ channels, sr, clipStartInSong = 0, trimStart = 0, grid, strength = 0.6, window = 0.07, sensitivity = 1, maxRatio = 1.25 } = {}) {
    const n = channels[0].length, len = n / sr;
    const mono = new Float32Array(n); for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
    const toSong = (ft) => clipStartInSong + (ft - trimStart), toFile = (st) => st - clipStartInSong + trimStart;
    const on = onsets(mono, sr, { sensitivity });
    const g = (grid ? grid(toSong(0), toSong(len)) : []).map(toFile);
    const anchors = plan(on, g, { strength, window, length: len });
    const moved = anchors.filter((a) => !a.end && Math.abs(a.dst - a.src) > 0.0005);
    const errs = anchors.filter((a) => a.err != null); const gs = g.slice().sort((a, b) => a - b);
    const meanErrBefore = errs.length ? errs.reduce((s, a) => s + a.err, 0) / errs.length : 0;
    const meanErrAfter = errs.length ? errs.reduce((s, a) => s + Math.abs(nearest(gs, a.dst) - a.dst), 0) / errs.length : 0;
    const out = moved.length ? warp(channels, sr, anchors, { maxRatio }) : channels.map((c) => c.slice());
    return { channels: out, anchors, onsets: on, moved: moved.length, meanErrBefore, meanErrAfter };
  }

  // MIDI: move each note `strength` of the way to the nearest grid line, length kept
  function quantizeNotes(notes, gridTimes, { strength = 1 } = {}) {
    const g = (gridTimes || []).slice().sort((a, b) => a - b);
    return (notes || []).map((x) => { const q = nearest(g, x.t); return q == null ? { ...x } : { ...x, t: Math.max(0, x.t + strength * (q - x.t)) }; });
  }

  return { onsets, plan, warp, tightenClip, quantizeNotes, offsetOf, fft, nearest };
});
