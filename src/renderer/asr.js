// Speech-to-text for lyrics: Whisper (via transformers.js + ONNX Runtime WASM, vendored in ./vendor) runs on this
// computer, offline after a one-time model download (cached in userData/models by the main process).
// Pure helpers (word cleanup, grouping words into lyric lines) are unit-tested; the loader runs only in the app.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPAsr = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MODELS = {
    'base.en': { id: 'Xenova/whisper-base.en', label: 'fast (base, ~80 MB)' },
    'small.en': { id: 'Xenova/whisper-small.en', label: 'better (small, ~250 MB)' },
    'medium.en': { id: 'Xenova/whisper-medium.en', label: 'best (medium, ~800 MB, slow)' },
  };
  // Whisper fills silence / instruments with things like "(mumbling)", "[Music]", "♪": not lyrics
  const NOISE = /^[\s([{♪*.\-–—]*(music|mumbling|instrumental|inaudible|silence|applause|laughter|guitar|drums|singing|humming|blank_audio|sound|noise)[\s)\]}♪*.!]*$/i;
  function cleanWords(chunks) {
    const out = [];
    for (const c of chunks || []) {
      if (!c || !Array.isArray(c.timestamp)) continue;
      let w = String(c.text || '').trim(); if (!w) continue;
      if (/^[([{].*[)\]}]$/.test(w) || NOISE.test(w) || /^♪+$/.test(w)) continue;
      w = w.replace(/♪/g, '').trim(); if (!w) continue;
      const t0 = Number(c.timestamp[0]), t1 = Number(c.timestamp[1] == null ? t0 + 0.3 : c.timestamp[1]);
      if (!Number.isFinite(t0)) continue;
      out.push({ w, t: t0, e: Number.isFinite(t1) && t1 > t0 ? t1 : t0 + 0.3 });
    }
    // drop a word repeated 4+ times in a row (Whisper loops on held notes)
    const res = []; for (const x of out) { const n = res.length; if (n >= 3 && [1, 2, 3].every((k) => res[n - k].w.toLowerCase() === x.w.toLowerCase())) continue; res.push(x); }
    return res;
  }
  // words → lines: a new line at a breath (gap), at sentence punctuation, or when a line gets long
  function groupLines(words, { gap = 0.55, maxWords = 12, maxSec = 7 } = {}) {
    const lines = []; let cur = null;
    for (const x of words || []) {
      const brk = !cur || x.t - cur.last > gap || cur.words.length >= maxWords || x.t - cur.start > maxSec || /[.!?]$/.test(cur.words[cur.words.length - 1].w);
      if (brk) { cur = { start: x.t, last: x.e, words: [] }; lines.push(cur); }
      cur.words.push(x); cur.last = x.e;
    }
    return lines.map((l) => ({ time: l.start, end: l.last, text: tidy(l.words.map((x) => x.w).join(' ')), words: l.words.map((x) => ({ w: x.w, t: Math.round(x.t * 1000) / 1000, e: Math.round(x.e * 1000) / 1000 })) })).filter((l) => l.text);
  }
  function tidy(s) { let t = String(s).replace(/\s+([,.!?;:])/g, '$1').replace(/\s+/g, ' ').trim(); t = t.replace(/[,;:]$/, ''); return t ? t.charAt(0).toUpperCase() + t.slice(1) : t; }
  // AudioBuffer slice → mono Float32 at 16 kHz (what Whisper wants)
  async function toMono16k(buf, from = 0, to = null) {
    const sr = buf.sampleRate; const a = Math.max(0, Math.floor(from * sr)), b = Math.min(buf.length, Math.floor((to == null ? buf.duration : to) * sr));
    const n = Math.max(0, b - a); const mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[a + i] / buf.numberOfChannels; }
    if (sr === 16000) return mono;
    if (typeof OfflineAudioContext !== 'undefined' && n > 0) {
      const len = Math.ceil(n * 16000 / sr); const oc = new OfflineAudioContext(1, len, 16000); const src = oc.createBufferSource();
      const ib = oc.createBuffer(1, n, sr); ib.copyToChannel(mono, 0); src.buffer = ib; src.connect(oc.destination); src.start(); const r = await oc.startRendering(); return r.getChannelData(0);
    }
    const ratio = sr / 16000, m = Math.floor(n / ratio), y = new Float32Array(m); for (let i = 0; i < m; i++) { const p = i * ratio, k = Math.floor(p), f = p - k; y[i] = mono[k] * (1 - f) + (mono[k + 1] || 0) * f; } return y;
  }
  // ---- word timing from the voice itself ----
  // Whisper's word times come from where the model was "looking" (cross-attention), not from the sound: on singing they
  // land up to a few hundred ms off, often in the breath before the word or glued to the end of the word before. This
  // moves each word's start onto the vocal's own onset near it (energy jumping up out of a gap or a sharp rise), and its
  // end onto where the voice actually stops. Legato lines with no onset to find keep Whisper's time.
  // x: mono samples, word times in seconds from x[0]; returns new {w, t, e} (input untouched).
  function envelopeDb(x, sr, hop = 0.01) {
    const H = Math.max(1, Math.round(sr * hop)), W = H * 2; const n = Math.max(0, Math.floor((x.length - W) / H) + 1); const db = new Float32Array(n);
    // one-pole high-pass ~150 Hz first: rumble, hum and kick bleed mustn't read as singing
    const a = Math.exp(-2 * Math.PI * 150 / sr); const y = new Float32Array(x.length); let py = 0, px = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i]; py = a * (py + v - px); px = v; y[i] = py; }
    for (let f = 0; f < n; f++) { let s = 0; const o = f * H; for (let i = 0; i < W; i++) { const v = y[o + i]; s += v * v; } db[f] = 10 * Math.log10(s / W + 1e-12); }
    return { db, hop: H / sr, win: W / sr };
  }
  const pctl = (arr, q) => { const a = Array.from(arr).sort((p, r) => p - r); return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))] : -120; };
  function refineWordTimes(words, x, sr, { reach = 0.4, minRise = 4 } = {}) {
    const ws = (words || []).map((w) => ({ ...w })); if (!ws.length || !x || x.length < sr * 0.2) return ws;
    const { db, hop, win } = envelopeDb(x, sr); const n = db.length; if (n < 10) return ws;
    const floor = pctl(db, 0.1), peak = pctl(db, 0.98); if (peak - floor < 10) return ws;   // no dynamics to read (a pad, a wash)
    const thr = Math.max(floor + 0.35 * (peak - floor), peak - 30);
    const voiced = (f) => f >= 0 && f < n && db[f] > thr;
    const rise = (f) => { let lo = Infinity; for (let k = 1; k <= 4; k++) if (f - k >= 0) lo = Math.min(lo, db[f - k]); return lo === Infinity ? 0 : Math.max(0, db[f] - lo); };
    const fr = (t) => Math.max(0, Math.min(n - 1, Math.round(t / hop)));
    const tm = (f) => f * hop + win * 0.25;   // a frame's time: a quarter in, where a rise inside it shows up
    const orig = ws.map((w) => ({ t: w.t, e: w.e }));
    let prev = -Infinity;
    for (let i = 0; i < ws.length; i++) {
      const t = orig[i].t; const nextT = i + 1 < ws.length ? orig[i + 1].t : Infinity;
      const lo = Math.max(0, t - reach, prev + 0.08), hi = Math.min(t + reach, Math.max(t + 0.1, nextT - 0.02), tm(n - 1));
      let best = -1, bs = -Infinity;
      for (let f = fr(lo); f <= fr(hi); f++) {
        if (!voiced(f) && !voiced(f + 1)) continue;
        const r = rise(f); const gap = !voiced(f - 1) || !voiced(f - 2);
        if (r < minRise && !(gap && voiced(f) && voiced(f + 1))) continue;
        const sc = r + (gap ? 4 : 0) - 9 * Math.abs(tm(f) - t);
        if (sc > bs) { bs = sc; best = f; }
      }
      let nt = t;
      if (best >= 0) { let g = best; while (g > fr(lo) && db[g - 1] < db[g] - 0.5 && db[g - 1] > thr - 12) g--; nt = tm(g); }
      else if (!voiced(fr(t))) { for (let f = fr(t); f <= fr(hi); f++) if (voiced(f)) { nt = tm(f); break; } }   // Whisper's start sits in a gap: the word starts when the voice does
      nt = Math.max(nt, prev + 0.05, 0); ws[i].t = Math.round(nt * 1000) / 1000; prev = nt;
    }
    for (let i = 0; i < ws.length; i++) {   // ends: where the voice stops (a gap of 80 ms), no later than the next word, at most a second past Whisper's
      const t = ws[i].t; const nextT = i + 1 < ws.length ? ws[i + 1].t : Infinity; const cap = Math.min(nextT - 0.01, Math.max(orig[i].e, t + 0.15) + 1.0, t + 6);
      let e = null, run = 0;
      for (let f = fr(t + 0.05); f < n && tm(f) < cap; f++) { if (voiced(f)) run = 0; else if (++run >= 8) { e = (f - run) * hop + win * 0.75; break; } }   /* the last voiced frame's window, most of the way in */
      if (e == null) e = Number.isFinite(cap) ? cap : Math.max(orig[i].e, t + 0.15);
      ws[i].e = Math.round(Math.max(t + 0.08, Math.min(e, Number.isFinite(nextT) ? nextT - 0.01 : e)) * 1000) / 1000;
    }
    return ws;
  }
  // ---- aligning what was heard with words someone typed ----
  const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9']/g, '').replace(/'/g, '');
  const toks = (text) => String(text || '').split(/\s+/).filter(Boolean);
  function lev(a, b) { if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n); let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; }
  const close = (a, b) => a === b || (a.length > 2 && b.length > 2 && lev(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 4)));
  // heard: [{w, t, e}] (any time base); text: the words as they should read → [{w, t, e}] one per typed word, timed
  // from the heard word it lines up with (edit-distance alignment); typed words with no partner share the gap around them
  function alignWords(heard, text) {
    const T = toks(text); const H = heard || []; if (!T.length) return [];
    if (!H.length) return null;
    const a = T.map(norm), b = H.map((x) => norm(x.w)); const m = a.length, n = b.length;
    const D = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
    for (let i = 0; i <= m; i++) D[i][0] = i; for (let j = 0; j <= n; j++) D[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : close(a[i - 1], b[j - 1]) ? 0.4 : 1));
    const pair = new Array(m).fill(-1);
    for (let i = m, j = n; i > 0 && j > 0;) {
      const sub = D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : close(a[i - 1], b[j - 1]) ? 0.4 : 1);
      if (Math.abs(D[i][j] - sub) < 1e-9) { pair[i - 1] = j - 1; i--; j--; } else if (Math.abs(D[i][j] - (D[i - 1][j] + 1)) < 1e-9) i--; else j--;
    }
    const out = T.map((w, i) => (pair[i] >= 0 ? { w, t: H[pair[i]].t, e: H[pair[i]].e } : { w, t: null, e: null }));
    const t0 = H[0].t, t1 = H[n - 1].e;
    for (let i = 0; i < m;) {   // runs of unpartnered words: spread across the gap between their timed neighbours
      if (out[i].t != null) { i++; continue; }
      let k = i; while (k < m && out[k].t == null) k++;
      const from = i > 0 ? out[i - 1].e : t0, to = k < m ? out[k].t : t1; const span = Math.max(0.05 * (k - i), to - from); const step = span / (k - i);
      for (let q = i; q < k; q++) { out[q].t = from + (q - i) * step; out[q].e = out[q].t + step * 0.9; }
      i = k;
    }
    for (let i = 1; i < m; i++) if (out[i].t < out[i - 1].t) out[i].t = out[i - 1].t;   // never backwards
    return out.map((x) => ({ w: x.w, t: Math.round(x.t * 1000) / 1000, e: Math.round(Math.max(x.e, x.t + 0.05) * 1000) / 1000 }));
  }
  // word-overlap similarity of two lines, 0…1
  function similarity(x, y) { const a = toks(x).map(norm).filter(Boolean), b = toks(y).map(norm).filter(Boolean); if (!a.length || !b.length) return 0; let hit = 0; const used = new Array(b.length).fill(false); for (const w of a) { const j = b.findIndex((v, k) => !used[k] && close(w, v)); if (j >= 0) { used[j] = true; hit++; } } return 2 * hit / (a.length + b.length); }
  // typed: [{id, text}] in song order (lines someone typed, unpinned or without word timings); heard: lines from
  // groupLines (absolute times). → {matches: [{id, time, words(absolute)}], extra: heard lines nothing typed matched}
  function alignToTyped(typed, heard, { minSim = 0.4, look = 4 } = {}) {
    const matches = [], used = new Set(); let p = 0;
    for (const ty of typed || []) {
      let best = -1, bs = 0;
      for (let j = p; j < Math.min((heard || []).length, p + look); j++) {
        // a typed line may be split over two heard lines (or the other way round): try j alone and j + j+1
        const s1 = similarity(ty.text, heard[j].text); if (s1 > bs) { bs = s1; best = j; }
      }
      if (best < 0 || bs < minSim) continue;
      let ws = heard[best].words; let end = best;
      if (best + 1 < heard.length && !used.has(best + 1)) { const both = similarity(ty.text, `${heard[best].text} ${heard[best + 1].text}`); if (both > bs + 0.1) { ws = ws.concat(heard[best + 1].words); end = best + 1; } }
      const words = alignWords(ws, ty.text);
      matches.push({ id: ty.id, time: words && words.length ? words[0].t : heard[best].time, words: words || [] });
      for (let j = best; j <= end; j++) used.add(j); p = end + 1;
    }
    return { matches, extra: (heard || []).filter((_, j) => !used.has(j)) };
  }
  // ---- loader (app only) ----
  let tx = null, pipes = new Map();
  async function load(modelKey, { bridge, onProgress } = {}) {
    const m = MODELS[modelKey] || MODELS['small.en'];
    if (pipes.has(m.id)) return pipes.get(m.id);
    if (!tx) {
      tx = await import('./vendor/transformers.min.js');
      tx.env.allowLocalModels = false; tx.env.useBrowserCache = false;
      if (bridge) { tx.env.useCustomCache = true; tx.env.customCache = { async match(req) { const url = typeof req === 'string' ? req : req.url; const b = await bridge.cacheGet(url); return b ? new Response(b) : undefined; }, async put(req, res) { const url = typeof req === 'string' ? req : req.url; try { await bridge.cachePut(url, await res.arrayBuffer()); } catch (_) {} } }; }
      const ow = tx.env.backends.onnx.wasm; ow.wasmPaths = new URL('./vendor/', location.href).href; ow.proxy = false;
      ow.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
    }
    const p = tx.pipeline('automatic-speech-recognition', m.id, { dtype: 'q8', progress_callback: (e) => { if (onProgress && e && e.status === 'progress') onProgress({ file: e.file, pct: e.progress, loaded: e.loaded, total: e.total }); } });
    pipes.set(m.id, p); p.catch(() => pipes.delete(m.id));
    return p;
  }
  // worker first (UI stays responsive); the page thread only if the worker can't start
  let worker = null, wseq = 0; const wjobs = new Map(); const state = { lastRun: null };
  function getWorker(bridge) {
    if (worker || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker('asr-worker.js');
      worker.onmessage = async (e) => {
        const d = e.data || {};
        if (d.cache) { let buf = null; try { if (d.cache === 'get') buf = bridge ? await bridge.cacheGet(d.url) : null; else if (bridge) await bridge.cachePut(d.url, d.buf); } catch (_) {} worker.postMessage({ cacheReply: true, key: d.key, buf }, buf ? [buf] : []); return; }
        const j = wjobs.get(d.id); if (!j) return;
        if (d.progress) { if (j.onProgress) j.onProgress(d.progress); return; }
        wjobs.delete(d.id); if (d.ok) j.resolve(d.result); else j.reject(new Error(d.error));
      };
      worker.onerror = (ev) => { const err = new Error(`speech worker: ${ev.message || 'failed to start'}`); for (const j of wjobs.values()) j.reject(err); wjobs.clear(); worker = null; };
    } catch (_) { worker = null; }
    return worker;
  }
  const threads = () => (typeof SharedArrayBuffer !== 'undefined' ? Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1)) : 1);
  async function runAsr(audio, { model, bridge, onProgress }) {
    const m = (MODELS[model] || MODELS['small.en']).id;
    const w = getWorker(bridge);
    if (w) {
      try { const r = await new Promise((resolve, reject) => { const id = ++wseq; wjobs.set(id, { resolve, reject, onProgress }); w.postMessage({ id, op: 'run', model: m, audio, threads: threads() }); }); state.lastRun = 'worker'; return r; }
      catch (err) { if (!/speech worker/.test(err.message)) throw err; /* fall through to the page thread */ }
    }
    const asr = await load(model, { bridge, onProgress }); state.lastRun = 'page';
    return asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
  }
  // AudioBuffer (+ region) → { lines, words, text }
  async function transcribe(buf, { from = 0, to = null, model = 'small.en', bridge, onProgress } = {}) {
    const x = await toMono16k(buf, from, to);
    if (x.length < 16000 * 0.5) return { lines: [], words: [], text: '' };
    const r = await runAsr(x, { model, bridge, onProgress });
    let words = cleanWords(r.chunks);
    try { words = refineWordTimes(words, x, 16000); } catch (_) { /* keep Whisper's times */ }
    return { lines: groupLines(words), words, text: String(r.text || '').trim() };
  }
  return { state, MODELS, cleanWords, groupLines, tidy, toMono16k, load, transcribe, alignWords, similarity, alignToTyped, refineWordTimes, envelopeDb };
});
