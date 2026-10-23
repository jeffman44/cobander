// Chord detection: reads the chords off a recording (guitar / keys / bass) or MIDI notes and drafts the chord lane.
// Chroma (12 pitch classes) per FFT frame → averaged per beat (or per chord slot of a bar) → matched against chord
// templates that include each tone's harmonics → Viterbi smoothing (chords tend to stay) → one chord per slot,
// identical neighbours merged. A bass recording (or the lowest notes) turns e.g. D over an F# bass into "D/F#".
// Pure (renderer: window.BPChordDetect; node: require).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPChordDetect = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];   // neutral spelling (no key)
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
  const PC = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  const mod = (n) => ((n % 12) + 12) % 12;

  // chord types: tones [interval, weight], name suffix, prior (simple triads are the usual answer)
  const TYPES = {
    maj: { tones: [[0, 1], [4, 0.8], [7, 0.9]], suffix: '', prior: 0.03 },
    min: { tones: [[0, 1], [3, 0.8], [7, 0.9]], suffix: 'm', prior: 0.03 },
    7: { tones: [[0, 1], [4, 0.8], [7, 0.8], [10, 0.7]], suffix: '7', prior: -0.015 },
    min7: { tones: [[0, 1], [3, 0.8], [7, 0.8], [10, 0.7]], suffix: 'm7', prior: -0.015 },
    sus4: { tones: [[0, 1], [5, 0.85], [7, 0.9]], suffix: 'sus4', prior: -0.025 },
    5: { tones: [[0, 1], [7, 0.95]], suffix: '5', prior: -0.04 },
  };
  // a tone's harmonics land on these pitch classes (2nd, 3rd, 4th, 5th, 6th harmonic), decaying
  const HARM = [[0, 1], [0, 0.6], [7, 0.36], [0, 0.22], [4, 0.13], [7, 0.08]];
  function templateFor(root, type) {
    const v = new Float64Array(12);
    for (const [iv, w] of TYPES[type].tones) for (const [h, hw] of HARM) v[mod(root + iv + h)] += w * hw;
    let n = 0; for (let i = 0; i < 12; i++) n += v[i] * v[i]; n = Math.sqrt(n);
    for (let i = 0; i < 12; i++) v[i] /= n;
    return v;
  }
  const templateCache = new Map();
  function templates(vocab = Object.keys(TYPES)) {
    const key = vocab.join(','); if (templateCache.has(key)) return templateCache.get(key);
    const out = []; for (const type of vocab) { if (!TYPES[type]) continue; for (let r = 0; r < 12; r++) out.push({ root: r, type, vec: templateFor(r, type), tones: TYPES[type].tones.map(([iv]) => mod(r + iv)) }); }
    templateCache.set(key, out); return out;
  }

  // ---- FFT (radix-2, in place) ----
  const fftCache = new Map();
  function fftPlan(n) {
    if (fftCache.has(n)) return fftCache.get(n);
    const rev = new Uint32Array(n); const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    const win = new Float64Array(n); for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const p = { rev, cos, sin, win }; fftCache.set(n, p); return p;
  }
  function fft(re, im, p) {
    const n = re.length; const { rev, cos, sin } = p;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half; const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  // cheap anti-aliased decimation (two cascaded box filters = triangle) to cut the FFT cost
  function decimate(x, d) {
    if (d <= 1) return x;
    const n = Math.floor(x.length / d); const y = new Float32Array(n);
    let acc = 0; const box = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { acc += x[i]; if (i >= d) acc -= x[i - d]; box[i] = acc / d; }
    acc = 0; for (let i = 0, j = 0; i < x.length; i++) { acc += box[i]; if (i >= d) acc -= box[i - d]; if ((i + 1) % d === 0 && j < n) y[j++] = acc / d; }
    return y;
  }
  const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

  // x: mono Float32Array; → { frames: Float32Array(12)[] (max-normalised), times: frame centres (s), energy: per frame RMS }
  function chroma(x, sr, { win = 8192, hop = 2048, fmin = 55, fmax = 2000 } = {}) {
    const d = Math.max(1, Math.floor(sr / Math.max(4 * fmax, 2000)));
    const y = decimate(x, d); const sr2 = sr / d;
    const N = nextPow2(Math.max(256, Math.round(win / d))); const H = Math.max(1, Math.round(hop / d));
    const p = fftPlan(N); const re = new Float64Array(N), im = new Float64Array(N);
    // bin → pitch class with a weight (closeness to a semitone centre)
    const kLo = Math.max(1, Math.ceil(fmin * N / sr2)), kHi = Math.min(N / 2 - 1, Math.floor(fmax * N / sr2));
    const binPc = new Int8Array(N / 2), binW = new Float32Array(N / 2);
    for (let k = kLo; k <= kHi; k++) { const f = k * sr2 / N; const m = 69 + 12 * Math.log2(f / 440); const r = Math.round(m); const dist = m - r; binPc[k] = mod(r); binW[k] = Math.exp(-(dist * dist) / (2 * 0.3 * 0.3)); }
    const frames = [], times = [], energy = [];
    for (let s = 0; s + N <= y.length || (s === 0 && y.length > 0); s += H) {
      let e = 0;
      for (let i = 0; i < N; i++) { const v = s + i < y.length ? y[s + i] : 0; e += v * v; re[i] = v * p.win[i]; im[i] = 0; }
      fft(re, im, p);
      const c = new Float32Array(12);
      for (let k = kLo; k <= kHi; k++) { const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]); c[binPc[k]] += binW[k] * mag; }
      let mx = 0; for (let i = 0; i < 12; i++) if (c[i] > mx) mx = c[i];
      if (mx > 0) for (let i = 0; i < 12; i++) c[i] /= mx;
      frames.push(c); times.push((s + N / 2) / sr2); energy.push(Math.sqrt(e / N));
      if (s + N > y.length) break;
    }
    return { frames, times, energy };
  }
  const bassChroma = (x, sr, opts = {}) => chroma(x, sr, { win: 16384, hop: 2048, fmin: 30, fmax: 250, ...opts });

  function parseKey(k) {
    const m = /^([A-G](?:#|b)?)\s*(m|min|minor)?$/i.exec(String(k || '').trim().replace(/\s*major$/i, ''));
    if (!m) return null; const r = m[1][0].toUpperCase() + (m[1][1] || ''); if (PC[r] === undefined) return null;
    return { pc: PC[r], minor: !!m[2], name: `${r}${m[2] ? 'm' : ''}` };
  }
  // diatonic chords of a key: Set of "root:type" (triads, plus the 7th / power / sus forms of those roots)
  function diatonicSet(key) {
    const k = parseKey(key); if (!k) return null;
    const relMaj = k.minor ? mod(k.pc + 3) : k.pc; const steps = [0, 2, 4, 5, 7, 9, 11]; const qual = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
    const set = new Set(); const scale = new Set(steps.map((s) => mod(relMaj + s)));
    steps.forEach((s, i) => { const r = mod(relMaj + s); if (qual[i] === 'maj') { set.add(`${r}:maj`); set.add(`${r}:5`); set.add(`${r}:sus4`); if (i === 4) set.add(`${r}:7`); } if (qual[i] === 'min') { set.add(`${r}:min`); set.add(`${r}:min7`); set.add(`${r}:5`); } });
    return { set, scale, flat: FLAT_KEYS.has(k.name) || /b/.test(k.name.slice(1)) };
  }
  const nameOf = (pc, names) => names[mod(pc)];

  // The bass line, note by note (YIN pitch on the bass track): per slot the pitch class the bass sits on most, 0–1 how
  // sure. Far more reliable than chroma for the root of a chord — on a real band recording the guitars' low strings
  // and harmonics smear the chroma, the bass player just plays the root.
  function bassRoots(x, sr, slots, { tuner = null } = {}) {
    const TU = tuner || getTuner(); if (!TU) return slots.map(() => null);
    const win = 4096, hop = Math.round(sr * 0.06); const pts = [];
    for (let i = 0; i + win <= x.length; i += hop) { const r = TU.detect(x.subarray(i, i + win), sr, { minHz: 28, maxHz: 400, threshold: 0.2, minRms: 0.0015 }); if (r && r.clarity > 0.8) pts.push({ t: (i + win / 2) / sr, pc: mod(Math.round(69 + 12 * Math.log2(r.freq / 440))), w: r.clarity }); }
    return slots.map(([a, z]) => { const h = new Float64Array(12); let n = 0; for (const p of pts) if (p.t >= a && p.t < z) { h[p.pc] += p.w; n += p.w; } if (!n) return null; let b = 0; for (let k = 1; k < 12; k++) if (h[k] > h[b]) b = k; return { pc: b, sure: h[b] / n, hist: h }; });
  }
  let _tuner = null; function getTuner() { if (_tuner) return _tuner; try { _tuner = typeof module === 'object' && module.exports ? require('./tuner.js') : (typeof BPTuner !== 'undefined' ? BPTuner : null); } catch (_) { _tuner = null; } return _tuner; }
  // The key the bass line implies: every major / minor key scored by how its degrees cover the roots the bass sits on
  // (tonic and the I-IV-V-vi set count most), mode by which tonic the bass comes home to. → {key, confidence} or null
  function keyFromRoots(units) {
    const roots = units.filter((u) => u.root && u.root.sure > 0.5); if (roots.length < 4) return null;
    const hist = new Float64Array(12); for (const u of roots) hist[u.root.pc] += u.root.sure; const total = hist.reduce((a, b) => a + b, 0) || 1;
    const W = { 0: 1.0, 7: 0.8, 5: 0.8, 9: 0.55, 2: 0.4, 4: 0.4, 11: 0.1 };   // degree → weight (major scale steps)
    let best = null;
    for (let tonic = 0; tonic < 12; tonic++) {
      let sc = 0; for (let pc = 0; pc < 12; pc++) { const d = mod(pc - tonic); sc += hist[pc] * (W[d] !== undefined ? W[d] : -0.6); }
      sc /= total;
      const minorTonic = mod(tonic + 9);   // relative minor: same notes, home on vi
      const minor = hist[minorTonic] >= hist[tonic] * 1.1;
      const cand = { key: `${NAMES[minor ? minorTonic : tonic]}${minor ? 'm' : ''}`, score: sc, tonic };
      if (!best || cand.score > best.score) best = cand;
    }
    return { key: best.key, confidence: Math.max(0, Math.min(1, best.score)) };
  }
  // units: [{ t, chroma(12), bass(12)|null, root: {pc, sure}|null, energy }] → [{time, chord, conf}] (+ .key when the bass line says the key)
  function decode(units, { key = null, vocab = Object.keys(TYPES), t0 = 0, switchCost = 0.09, quiet = null } = {}) {
    if (!units.length) return [];
    const T = templates(vocab); let dia = diatonicSet(key); let names = dia ? (dia.flat ? FLAT : SHARP) : NAMES;
    // the key the bass line implies beats a label that disagrees with it (a wrong key would steer every chord wrong)
    const heard = keyFromRoots(units); let keyUsed = key || null;
    if (heard && heard.confidence >= 0.6) { const hd = diatonicSet(heard.key); const roots = units.filter((u) => u.root && u.root.sure > 0.6); const fit = (d) => roots.filter((u) => d.scale.has(u.root.pc)).length / Math.max(1, roots.length); if (!dia || fit(hd) > fit(dia) + 0.15) { dia = hd; keyUsed = heard.key; names = dia.flat ? FLAT : SHARP; } }
    else if (dia) { const roots = units.filter((u) => u.root && u.root.sure > 0.6); if (roots.length >= 4 && roots.filter((u) => dia.scale.has(u.root.pc)).length < roots.length * 0.6) { dia = null; keyUsed = null; } }
    const emax = Math.max(...units.map((u) => u.energy)); const thr = quiet != null ? quiet : emax * 0.08;
    const S = T.length + 1;   // last state = no chord
    const scores = units.map((u) => {
      const sc = new Float64Array(S);
      let n = 0; for (let i = 0; i < 12; i++) n += u.chroma[i] * u.chroma[i]; n = Math.sqrt(n) || 1;
      // the bass root: chords on that root get a lift that grows with how sure the bass is; others are pushed down
      const br = u.root && u.root.sure > 0.5 ? u.root : null;
      // power chords: when the third is barely there (distorted guitars), a plain 5 beats a guessed major / minor
      for (let j = 0; j < T.length; j++) { const tp = T[j]; let dot = 0; for (let i = 0; i < 12; i++) dot += tp.vec[i] * u.chroma[i]; sc[j] = dot / n + TYPES[tp.type].prior + (dia && dia.set.has(`${tp.root}:${tp.type}`) ? 0.03 : 0);
        if (br) sc[j] += tp.root === br.pc ? 0.12 * br.sure : -0.08 * br.sure;
        if (dia && br && tp.root === br.pc && (tp.type === 'maj' || tp.type === 'min')) { const third = Math.max(u.chroma[mod(tp.root + 3)], u.chroma[mod(tp.root + 4)]) / (u.chroma[tp.root] || 1e-6); const third3 = u.chroma[mod(tp.root + 3)], third4 = u.chroma[mod(tp.root + 4)]; const ambiguous = third < 0.5 || Math.abs(third3 - third4) < 0.12 * Math.max(third3, third4, 1e-6); if (ambiguous && dia.set.has(`${tp.root}:${tp.type}`)) sc[j] += 0.05; }   // no clear third (power chords): the key decides major / minor
        if (tp.type === '5' && !(dia && dia.scale.has(tp.root))) { const third = Math.max(u.chroma[mod(tp.root + 3)], u.chroma[mod(tp.root + 4)]) / (Math.min(u.chroma[tp.root], u.chroma[mod(tp.root + 7)]) || 1e-6); if (third < 0.3) sc[j] += 0.06; }   // a power chord in the key is written as the key's chord (B, G#m…); a chromatic one stays a 5
        if ((tp.type === 'maj' || tp.type === 'min') && br && tp.root === br.pc && !(dia && dia.set.has(`${tp.root}:${tp.type}`))) { const third = Math.max(u.chroma[mod(tp.root + 3)], u.chroma[mod(tp.root + 4)]) / (Math.min(u.chroma[tp.root], u.chroma[mod(tp.root + 7)]) || 1e-6); if (third < 0.3) sc[j] -= 0.04; } }
      sc[S - 1] = u.energy < thr || n < 1e-6 ? 2 : -1;
      return sc;
    });
    // Viterbi: score sum minus a cost for each change
    const back = []; let prev = scores[0].slice();
    for (let i = 1; i < units.length; i++) {
      let best = -Infinity, bi = 0; for (let j = 0; j < S; j++) if (prev[j] > best) { best = prev[j]; bi = j; }
      const cur = new Float64Array(S); const bk = new Int32Array(S);
      for (let j = 0; j < S; j++) { const stay = prev[j], move = best - switchCost; if (stay >= move) { cur[j] = stay + scores[i][j]; bk[j] = j; } else { cur[j] = move + scores[i][j]; bk[j] = bi; } }
      back.push(bk); prev = cur;
    }
    let s = 0; for (let j = 1; j < S; j++) if (prev[j] > prev[s]) s = j;
    const path = new Array(units.length); path[units.length - 1] = s;
    for (let i = units.length - 1; i > 0; i--) { s = back[i - 1][s]; path[i - 1] = s; }
    const out = [];
    for (let i = 0; i < units.length; i++) {
      const st = path[i]; if (st === S - 1) { if (out.length && out[out.length - 1].chord !== null) out.push({ time: units[i].t + t0, chord: null, conf: 1 }); continue; }
      const tp = T[st]; let name = `${nameOf(tp.root, names)}${TYPES[tp.type].suffix}`;
      const u = units[i];
      if (u.root && u.root.sure > 0.75 && u.root.pc !== tp.root && tp.tones.includes(u.root.pc)) name += `/${nameOf(u.root.pc, names)}`;   // a sure bass note that's a chord tone but not the root: slash chord
      else if (!u.root && u.bass) {   // no bass line: a clearly dominant low note that's a chord tone (or in the key)
        let bp = 0; for (let k = 1; k < 12; k++) if (u.bass[k] > u.bass[bp]) bp = k;
        if (bp !== tp.root && u.bass[bp] > 1.6 * u.bass[tp.root] && (tp.tones.includes(bp) || (dia && dia.scale.has(bp)))) name += `/${nameOf(bp, names)}`;
      }
      const sorted = Array.from(scores[i].slice(0, S - 1)).sort((a, b) => b - a);
      const conf = Math.max(0, Math.min(1, (scores[i][st] - (sorted[1] === scores[i][st] ? sorted[2] : sorted[1])) * 5 + 0.35));
      const last = out[out.length - 1];
      if (last && last.chord === name) { last.conf = Math.min(last.conf, conf); continue; }
      out.push({ time: Math.round((u.t + t0) * 1000) / 1000, chord: name, conf: Math.round(conf * 100) / 100 });
    }
    const res = out.filter((x) => x.chord !== null);
    res.key = keyUsed; res.keyHeard = heard; return res;
  }

  // beats → units: one per beat, or (with barStarts) chordsPerBar slots per bar
  function slotsFrom(beats, barStarts, chordsPerBar, end) {
    const b = beats.slice().sort((x, y) => x - y); if (!b.length) return [];
    const med = b.length > 1 ? b[b.length - 1] - b[b.length - 2] : 0.5;
    const edges = b.map((t, i) => [t, i + 1 < b.length ? b[i + 1] : Math.min(end != null ? end : t + med, t + med)]);
    if (!barStarts || !barStarts.length) return edges;
    const bars = barStarts.slice().sort((x, y) => x - y); const out = [];
    for (let i = 0; i < bars.length; i++) {
      const a = bars[i], z = i + 1 < bars.length ? bars[i + 1] : edges[edges.length - 1][1];
      const inBar = edges.filter(([s]) => s >= a - 1e-6 && s < z - 1e-6); if (!inBar.length) continue;
      const per = Math.max(1, Math.ceil(inBar.length / Math.max(1, chordsPerBar)));
      for (let k = 0; k < inBar.length; k += per) out.push([inBar[k][0], inBar[Math.min(inBar.length, k + per) - 1][1]]);
    }
    return out;
  }
  function average(ch, a, z) {
    const c = new Float32Array(12); let n = 0, e = 0;
    for (let i = 0; i < ch.times.length; i++) { const t = ch.times[i]; if (t < a || t >= z) continue; for (let k = 0; k < 12; k++) c[k] += ch.frames[i][k] * ch.energy[i]; e += ch.energy[i]; n++; }
    if (!n) { let best = -1, bd = Infinity; for (let i = 0; i < ch.times.length; i++) { const dd = Math.abs(ch.times[i] - (a + z) / 2); if (dd < bd) { bd = dd; best = i; } } if (best >= 0) { for (let k = 0; k < 12; k++) c[k] = ch.frames[best][k]; e = ch.energy[best]; n = 1; } }
    if (e > 0) for (let k = 0; k < 12; k++) c[k] /= e;
    return { c, energy: n ? e / n : 0 };
  }

  // audio: mono Float32Array from t0 of the stretch (times in beats/barStarts are relative to that start)
  // slash chords only from a real bass part (bassAudio) unless slashFromMix: a guitar's own low strings fake a 'bass'
  // chordsPerBar: 1 = a chord a bar (pop / rock default; the second half of a bar only becomes its own chord when the
  // bass clearly moves there), 2 = half bars always allowed
  function detect({ audio, sr, beats, bassAudio = null, key = null, chordsPerBar = 1, barStarts = null, vocab = ['maj', 'min', '7', 'min7', 'sus4', '5'], t0 = 0, slashFromMix = false } = {}) {
    if (!audio || !audio.length || !beats || !beats.length) return [];
    let peak = 0; for (let i = 0; i < audio.length; i += 7) { const v = Math.abs(audio[i]); if (v > peak) peak = v; }
    if (peak < 1e-4) return [];
    const ch = chroma(audio, sr); const bc = !bassAudio && slashFromMix ? bassChroma(audio, sr) : null;
    const half = slotsFrom(beats, barStarts, 2, audio.length / sr);
    const roots = bassAudio ? bassRoots(bassAudio, sr, half) : half.map(() => null);
    // merge half-bar slots into bars unless the bass changes root between the halves (or chordsPerBar asks for halves)
    const slots = []; const rootOf = [];
    for (let i = 0; i < half.length; i++) {
      const sameBar = barStarts && i + 1 < half.length && !barStarts.some((b) => Math.abs(b - half[i + 1][0]) < 1e-3);
      const r0 = roots[i], r1 = roots[i + 1];
      const split = chordsPerBar >= 2 || (r0 && r1 && r0.sure > 0.6 && r1.sure > 0.6 && r0.pc !== r1.pc);
      if (sameBar && !split) { slots.push([half[i][0], half[i + 1][1]]); rootOf.push(r0 && r1 ? (r0.sure >= r1.sure ? r0 : r1) : r0 || r1); i++; }
      else { slots.push(half[i]); rootOf.push(r0); }
    }
    const units = slots.map(([a, z], i) => { const m = average(ch, a, z); const b = bc ? average(bc, a, z) : { energy: 0 }; return { t: a, chroma: m.c, bass: b.energy > 0 ? b.c : null, root: rootOf[i], energy: m.energy }; });
    return decode(units, { key, vocab, t0, quiet: Math.max(1e-4, Math.max(...units.map((u) => u.energy)) * 0.08) });
  }

  // MIDI: notes [{t, d, n, v?}] in seconds → same shape (pitch-class histogram per slot; the lowest note is the bass)
  function fromNotes(notes, { beats, key = null, chordsPerBar = 2, barStarts = null, vocab = ['maj', 'min', '7', 'min7', 'sus4', '5'] } = {}) {
    if (!notes || !notes.length || !beats || !beats.length) return [];
    const end = Math.max(...notes.map((x) => x.t + (x.d || 0)));
    const slots = slotsFrom(beats, barStarts, chordsPerBar, end);
    const units = slots.map(([a, z]) => {
      const c = new Float32Array(12); const bass = new Float32Array(12); let low = Infinity, e = 0; const lows = [];
      for (const x of notes) { const s = Math.max(a, x.t), f = Math.min(z, x.t + (x.d || 0.1)); if (f <= s) continue; const w = (f - s) * (x.v == null ? 1 : x.v); c[mod(x.n)] += w; e += w; lows.push([x.n, w]); if (x.n < low) low = x.n; }
      // the bass note is the low note that is held / repeated most, not a passing note that dips below it once
      if (lows.length) { const tot = new Map(); for (const [n, w] of lows) tot.set(n, (tot.get(n) || 0) + w); const mx = Math.max(...tot.values()); const held = [...tot].filter(([, w]) => w >= 0.3 * mx).map(([n]) => n); if (held.length) low = Math.min(...held); }
      // fold in harmonics like a real instrument so the audio templates fit
      const c2 = new Float32Array(12); for (let k = 0; k < 12; k++) if (c[k]) for (const [h, hw] of HARM) c2[mod(k + h)] += c[k] * hw;
      if (low < Infinity) bass[mod(low)] = 1;
      return { t: a, chroma: c2, bass: low < Infinity ? bass : null, energy: e };
    });
    return decode(units, { key, vocab, quiet: 1e-9 });
  }

  return { chroma, bassChroma, bassRoots, keyFromRoots, detect, fromNotes, templates, NAMES, TYPES, decode };
});
