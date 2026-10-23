// Drums from a recording, as hits: kick, snare, hi-hat, open hat / ride, tom, crash (the drum machine's six rows).
// How it hears them: a log-frequency spectrogram (5.8 ms frames) is split into what each drum contributes with
// non-negative matrix factorisation — each drum starts from a typical spectrum (kick low thump, snare body + rattle,
// hats up top…) that then adapts to this kit, while the activations say how hard each drum is hit, frame by frame.
// A hit is a peak in a drum's activation that rises clearly above its own recent level. Then, like the tabs: hits snap
// to the song's grid, and bars that repeat vote (a hat the overheads barely caught in one bar is filled in when the
// other bars all have it and the audio shows a trace; a lone blip in one bar goes).
// Pure (renderer / worker: self.BPDrumTx; node: require).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPDrumTx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SR = 22050, N = 1024, HOP = 128, FPS = SR / HOP;
  const LAG = 0.035, LAG_HF = 0.012;   // an onset shows in the frame whose window first reaches the hit: report the hit, not the window
  const DRUMS = ['kick', 'snare', 'hat', 'ohat', 'tom', 'crash'];
  const GM = { kick: 36, snare: 38, hat: 42, ohat: 46, tom: 45, crash: 49 };

  // ---- spectrogram ----
  const plans = new Map();
  function plan(n) {
    if (plans.has(n)) return plans.get(n);
    const rev = new Uint32Array(n); const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2); for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    const win = new Float64Array(n); for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const p = { rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) }; plans.set(n, p); return p;
  }
  function fft(re, im, p) {
    const n = re.length; const { rev, cos, sin } = p;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) { const half = size >> 1, step = n / size; for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) { const a = i + j, b = a + half; const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k]; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; } }
  }
  function resample(x, from) {
    if (from === SR) return x; const ratio = SR / from; const n = Math.floor(x.length * ratio); const y = new Float32Array(n);
    // a short windowed-sinc low-pass is plenty here: drums don't need a pristine top octave
    const half = 8, cut = Math.min(1, ratio) * 0.92;
    for (let j = 0; j < n; j++) { const c = j / ratio; const i0 = Math.floor(c); let s = 0, wsum = 0; for (let k = i0 - half + 1; k <= i0 + half; k++) { if (k < 0 || k >= x.length) continue; const u = c - k; const w = (0.5 + 0.5 * Math.cos((Math.PI * u) / half)) * (u === 0 ? 1 : Math.sin(Math.PI * cut * u) / (Math.PI * cut * u)); s += x[k] * w; wsum += w; } y[j] = wsum ? s / wsum : 0; }
    return y;
  }
  // log-spaced bands from 30 Hz to 10 kHz
  const NB = 48; const EDGES = Array.from({ length: NB + 1 }, (_, i) => 30 * Math.pow(10000 / 30, i / NB)); const CENTER = EDGES.slice(0, NB).map((e, i) => Math.sqrt(e * EDGES[i + 1]));
  function spectrogram(x) {
    const p = plan(N); const T = Math.max(0, Math.floor((x.length - N) / HOP) + 1); const S = new Float32Array(T * NB); const binHz = SR / N;
    const bandOf = new Int16Array(N / 2).fill(-1); for (let k = 1; k < N / 2; k++) { const f = k * binHz; for (let b = 0; b < NB; b++) if (f >= EDGES[b] && f < EDGES[b + 1]) { bandOf[k] = b; break; } }
    // bands narrower than one bin borrow the nearest bin
    const nearest = CENTER.map((c) => Math.max(1, Math.min(N / 2 - 1, Math.round(c / binHz))));
    for (let t = 0; t < T; t++) {
      const { re, im, win } = p; const o = t * HOP; for (let i = 0; i < N; i++) { re[i] = (x[o + i] || 0) * win[i]; im[i] = 0; } fft(re, im, p);
      const row = S.subarray(t * NB, (t + 1) * NB); const cnt = new Uint16Array(NB);
      for (let k = 1; k < N / 2; k++) { const b = bandOf[k]; if (b < 0) continue; row[b] += Math.hypot(re[k], im[k]); cnt[b]++; }
      for (let b = 0; b < NB; b++) row[b] = cnt[b] ? row[b] / cnt[b] : Math.hypot(re[nearest[b]], im[nearest[b]]);
    }
    return { S, T };
  }
  // ---- starting spectra (in the log bands): each drum's typical shape ----
  const bump = (f0, w) => CENTER.map((c) => Math.exp(-0.5 * (Math.log(c / f0) / w) ** 2));
  const mix = (...parts) => CENTER.map((_, i) => parts.reduce((a, [g, v]) => a + g * v[i], 0) + 0.01);
  const INIT = {
    kick: mix([1, bump(60, 0.35)], [0.25, bump(150, 0.4)], [0.06, bump(3000, 0.6)]),
    snare: mix([0.7, bump(200, 0.3)], [0.5, bump(900, 0.5)], [0.6, bump(4000, 0.6)]),
    hat: mix([1, bump(8000, 0.35)], [0.2, bump(4000, 0.4)]),
    ohat: mix([0.8, bump(6500, 0.45)], [0.5, bump(3500, 0.45)]),
    tom: mix([1, bump(110, 0.35)], [0.35, bump(300, 0.4)], [0.05, bump(3000, 0.6)]),
    crash: mix([0.7, bump(5000, 0.6)], [0.6, bump(2500, 0.6)], [0.4, bump(9000, 0.4)]),
  };
  // ---- NMF (KL), W starts from INIT and adapts a little (pulled back toward its start so a kick stays a kick) ----
  function factor(S, T, { iters = 40, adaptFrom = 15, stick = 0.5 } = {}) {
    const K = DRUMS.length; const W = new Float64Array(NB * K); const W0 = new Float64Array(NB * K);
    DRUMS.forEach((d, k) => { const v = INIT[d]; const s = v.reduce((a, b) => a + b, 0); for (let b = 0; b < NB; b++) W0[b * K + k] = W[b * K + k] = v[b] / s; });
    const H = new Float64Array(K * T).fill(0.1); const V = S; const R = new Float64Array(NB * T);
    const recon = () => { for (let t = 0; t < T; t++) for (let b = 0; b < NB; b++) { let s = 1e-9; for (let k = 0; k < K; k++) s += W[b * K + k] * H[k * T + t]; R[b * T + t] = V[t * NB + b] / s; } };
    const colW = new Float64Array(K);
    for (let it = 0; it < iters; it++) {
      recon(); colW.fill(0); for (let b = 0; b < NB; b++) for (let k = 0; k < K; k++) colW[k] += W[b * K + k];
      for (let k = 0; k < K; k++) for (let t = 0; t < T; t++) { let num = 0; for (let b = 0; b < NB; b++) num += W[b * K + k] * R[b * T + t]; H[k * T + t] *= num / (colW[k] + 1e-9); }
      if (it >= adaptFrom) {
        recon(); const rowH = new Float64Array(K); for (let k = 0; k < K; k++) for (let t = 0; t < T; t++) rowH[k] += H[k * T + t];
        for (let b = 0; b < NB; b++) for (let k = 0; k < K; k++) { let num = 0; for (let t = 0; t < T; t++) num += H[k * T + t] * R[b * T + t]; W[b * K + k] *= (num + stick * W0[b * K + k] * rowH[k]) / (rowH[k] * (1 + stick) + 1e-9); }
        for (let k = 0; k < K; k++) { let s = 0; for (let b = 0; b < NB; b++) s += W[b * K + k]; for (let b = 0; b < NB; b++) W[b * K + k] /= s || 1; }
      }
    }
    return { W, H, K };
  }
  // ---- hits: peaks in each drum's activation that rise clearly over its recent floor ----
  function peaks(H, T, k, { delta = 0.06, ratio = 1.6, minGap = 0.035, floorWin = 0.4, minA = 0, rel = 0 } = {}) {
    const a = new Float64Array(T); let mx = 0; for (let t = 0; t < T; t++) { a[t] = Math.log1p(40 * H[k * T + t]); if (a[t] > mx) mx = a[t]; }
    if (!mx) return []; for (let t = 0; t < T; t++) a[t] /= mx;
    const onset = new Float64Array(T); for (let t = 2; t < T; t++) onset[t] = Math.max(0, a[t] - Math.min(a[t - 1], a[t - 2]));
    const out = []; const fw = Math.round(floorWin * FPS), gap = Math.round(minGap * FPS);
    for (let t = 2; t < T - 2; t++) {
      if (onset[t] < onset[t - 1] || onset[t] < onset[t + 1]) continue;
      let s = 0, n = 0; for (let u = Math.max(0, t - fw); u < t; u++) { s += onset[u]; n++; } const mean = n ? s / n : 0;
      if (onset[t] < delta || onset[t] < ratio * mean + 0.02) continue;
      let peakA = a[t]; for (let u = t; u < Math.min(T, t + 4); u++) peakA = Math.max(peakA, a[u]); if (peakA < minA) continue;
      const last = out[out.length - 1]; if (last && t - last.f < gap) { if (onset[t] > last.o) { last.f = t; last.o = onset[t]; last.a = peakA; } continue; }
      let raw = 0; for (let u = Math.max(0, t - 2); u < Math.min(T, t + 6); u++) raw = Math.max(raw, H[k * T + u]);
      out.push({ f: t, o: onset[t], a: peakA, raw });
    }
    // bleed: another drum's hit shows up faintly in this one's activation — far below this drum's own typical hit
    if (out.length >= 4 && rel > 0) { const hs = out.map((p) => p.raw).sort((x, y) => x - y); const ref = hs[Math.floor(hs.length * 0.75)]; return out.filter((p) => p.raw >= rel * ref); }
    return out;
  }
  // a cymbal that keeps ringing (crash) vs one that's cut short (open hat / ride): how long its activation stays up
  function ringFor(H, T, k, f) { const top = H[k * T + f]; let u = f; while (u < T && H[k * T + u] > 0.25 * top && u - f < FPS * 2) u++; return (u - f) / FPS; }

  // ---- grid + vote (drums repeat more than anything) ----
  function snapAndVote(hits, beats, { vote = true } = {}) {
    if (!beats || beats.length < 3) return hits;
    const len = (i) => (i + 1 < beats.length ? beats[i + 1].t - beats[i].t : beats[i].t - beats[i - 1].t);
    const slots = []; let bar = -1; beats.forEach((b, i) => { if (b.beat === 0 || bar < 0) bar++; for (let k = 0; k < 4; k++) slots.push({ t: b.t + (k * len(i)) / 4, bar }); });
    const near = (t) => { let lo = 0, hi = slots.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (slots[m].t < t) lo = m + 1; else hi = m; } if (lo > 0 && Math.abs(slots[lo - 1].t - t) <= Math.abs(slots[lo].t - t)) lo--; return lo; };
    // the take's own latency against the click
    let best = { e: Infinity, s: 0 }; for (let s = -0.05; s <= 0.0501; s += 0.004) { let e = 0; for (const h of hits) { const j = near(h.t - s); const st = j + 1 < slots.length ? slots[j + 1].t - slots[j].t : 0.1; e += Math.min(Math.abs(slots[j].t - (h.t - s)), st / 2) ** 2; } if (e < best.e) best = { e, s }; }
    const out = []; const seen = new Set();
    for (const h of hits) { const j = near(h.t - best.s); const st = j + 1 < slots.length ? slots[j + 1].t - slots[j].t : 0.1; if (Math.abs(slots[j].t - (h.t - best.s)) > 0.6 * st) { out.push(h); continue; } const k = `${j}:${h.drum}`; if (seen.has(k)) continue; seen.add(k); out.push({ ...h, t: slots[j].t, slot: j, bar: slots[j].bar }); }
    if (!vote) return out;
    // bars that repeat: what at least 75% of a group of ≥ 4 similar bars play is filled in where the audio shows a trace
    const first = new Map(); slots.forEach((s2, i) => { if (!first.has(s2.bar)) first.set(s2.bar, i); });
    const byBar = new Map(); for (const h of out) if (h.slot != null) { if (!byBar.has(h.bar)) byBar.set(h.bar, []); byBar.get(h.bar).push(h); }
    const sig = (b) => new Set((byBar.get(b) || []).map((h) => `${h.slot - first.get(b)}:${h.drum}`));
    const bars = [...byBar.keys()]; const sim = (a, b) => { const A = sig(a), B = sig(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (Math.min(A.size, B.size) || 1); };   /* a bar that lost its hats under a crash is still that groove */
    const add = []; const drop = new Set();
    for (const b of bars) {
      const group = bars.filter((o) => o === b || sim(o, b) >= 0.5); if (group.length < 4) continue;
      const cnt = new Map(); for (const o of group) for (const k of sig(o)) cnt.set(k, (cnt.get(k) || 0) + 1);
      const mine = sig(b);
      for (const [k, c] of cnt) { if (mine.has(k) || c / group.length < 0.75) continue; const [rel, drum] = k.split(':'); const j = first.get(b) + Number(rel); if (!slots[j]) continue; add.push({ t: slots[j].t, drum, vel: 0.5, slot: j, bar: b, inferred: true, needTrace: true, shift: best.s }); }
      for (const h of byBar.get(b)) { const k = `${h.slot - first.get(b)}:${h.drum}`; if ((cnt.get(k) || 0) === 1 && h.vel < 0.35 && group.length >= 5) drop.add(h); }
    }
    return out.filter((h) => !drop.has(h)).concat(add);
  }

  const PK = { delta: 0.1, ratio: 3, minA: 0.8, rel: 0.35 }; const PK_BY = { kick: { delta: 0.1, ratio: 3, minA: 0.8 }, snare: { delta: 0.1, ratio: 2, minA: 0.7 }, tom: { delta: 0.15, ratio: 4, minA: 0.9 } };   // tuned on MDB Drums
  // x: mono audio at sr. beats: [{t, beat}] in the take's own time (optional). → { hits: [{t, drum, n (GM), vel}], shift }
  function transcribe(x, sr, { beats = null, vote = true, sens = 1, pk = null, cym = null, toms = false } = {}) {
    const CY = { open: 0.2, crash: 0.9, ...(cym || {}) };
    const y = resample(x, sr); const { S, T } = spectrogram(y); if (T < 8) return { hits: [] };
    const { H, K } = factor(S, T);
    let hits = [];
    // cymbals (hats, ride, crash): sharp rises in the top bands find them far better than the factorisation does; what
    // kind they are comes from how long the top end rings after the hit
    { const lo = CENTER.findIndex((c) => c >= 7000); const o = new Float64Array(T); for (let t = 1; t < T; t++) { let s2 = 0; for (let b = lo; b < NB; b++) { const d = Math.log1p(100 * S[t * NB + b]) - Math.log1p(100 * S[(t - 1) * NB + b]); if (d > 0) s2 += d; } o[t] = s2; }
      let mx = 0; for (const v of o) mx = Math.max(mx, v); for (let t = 0; t < T; t++) o[t] /= mx || 1;
      const hfE = new Float64Array(T); const lo2 = CENTER.findIndex((c) => c >= 3500); for (let t = 0; t < T; t++) { let e = 0; for (let b = lo2; b < NB; b++) e += S[t * NB + b]; hfE[t] = e; }
      const fw = 70, thr = 0.12 / sens; let lastF = -99;
      for (let t = 2; t < T - 2; t++) { if (o[t] < o[t - 1] || o[t] < o[t + 1] || o[t] < thr) continue; let s2 = 0, n = 0; for (let u = Math.max(0, t - fw); u < t; u++) { s2 += o[u]; n++; } if (o[t] < 2 * (s2 / (n || 1)) + 0.01) continue; if (t - lastF < 0.035 * FPS) continue; lastF = t;
        let pk2 = t, top = hfE[t]; for (let u = t; u < Math.min(T, t + 6); u++) if (hfE[u] > top) { top = hfE[u]; pk2 = u; } let u = pk2; while (u < T && hfE[u] > 0.3 * top && u - pk2 < FPS * 2) u++; const ring = (u - pk2) / FPS;
        hits.push({ t: (t * HOP) / SR + LAG_HF, drum: ring > CY.crash ? 'crash' : ring > CY.open ? 'ohat' : 'hat', vel: Math.min(1, Math.max(0.2, Math.sqrt(o[t]))), f: t, k: -1 }); } }
    DRUMS.forEach((d, k) => { if (d === 'hat' || d === 'ohat' || d === 'crash' || (d === 'tom' && !toms)) return; for (const p of peaks(H, T, k, { ...PK, ...(PK_BY[d] || {}), ...(pk || {}), delta: ((pk && pk.delta) || PK.delta) / sens })) hits.push({ t: (p.f * HOP) / SR + LAG, drum: d, vel: Math.min(1, Math.max(0.15, p.a)), f: p.f, k }); });
    // a kick and a tom on the same frame: the stronger one (they share the low end)
    hits = hits.filter((h) => !(h.drum === 'tom' && hits.some((g) => g.drum === 'kick' && Math.abs(g.f - h.f) <= 3 && g.vel >= h.vel)));
    hits.sort((a, b) => a.t - b.t);
    let out = beats ? snapAndVote(hits, beats, { vote }) : hits;
    // a vote-added hit needs something in that drum's activation there (not invented from nothing)
    out = out.filter((h) => { if (!h.needTrace) return true; const k = DRUMS.indexOf(h.drum); const f0 = Math.round((h.t + (h.shift || 0)) * FPS); let m = 0, all = 0; for (let t = Math.max(0, f0 - 2); t <= Math.min(T - 1, f0 + 3); t++) m = Math.max(m, H[k * T + t]); for (let t = 0; t < T; t++) all = Math.max(all, H[k * T + t]); return all && m / all > 0.06; });
    return { hits: out.map((h) => ({ t: Math.round(h.t * 1000) / 1000, drum: h.drum, n: GM[h.drum], vel: Math.round(h.vel * 100) / 100, inferred: !!h.inferred })).sort((a, b) => a.t - b.t || a.n - b.n) };
  }
  return { transcribe, spectrogram, factor, peaks, snapAndVote, DRUMS, GM, FPS, SR };
});
