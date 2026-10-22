// Tab transcription: a guitar or bass recording → the notes and chord voicings that were actually played, as
// string / fret events, plus a plain-text tab. Onsets come from spectral flux; between onsets a high-resolution
// spectrum is averaged and read with an iterative harmonic-sum salience (pick the strongest fundamental, take its
// harmonics out of the spectrum, repeat), so a strummed chord yields every note in it, not just a chord name. The
// notes of a chord are then laid on the fretboard (one note per string, ascending, smallest hand span wins) and
// named from their pitch classes. Tuning drift (a guitar a few cents flat) is measured and compensated.
// Pure (renderer: window.BPTab; node: require for tests).
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(() => { try { return isNode ? require('./pitchcheck.js') : root.BPPitchCheck; } catch (_) { return null; } });   // looked up on use: script order does not matter
  if (isNode) module.exports = api;
  else root.BPTab = api;
})(typeof self !== 'undefined' ? self : this, function (getPC) {
  'use strict';
  const GUITAR = [40, 45, 50, 55, 59, 64], BASS = [28, 33, 38, 43], BASS5 = [23, 28, 33, 38, 43];
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const mod = (n) => ((n % 12) + 12) % 12;
  const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---- FFT (radix-2, real input via complex arrays) ----
  const plans = new Map();
  function plan(n) {
    if (plans.has(n)) return plans.get(n);
    const rev = new Uint32Array(n); const bits = Math.round(Math.log2(n));
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    const win = new Float64Array(n); for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const p = { rev, cos, sin, win, re: new Float64Array(n), im: new Float64Array(n) }; plans.set(n, p); return p;
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
  // magnitude spectrum of x[at .. at+n) (zero-padded past the end), Hann window
  const hanns = new Map(); const hann = (L) => { if (!hanns.has(L)) { const w = new Float64Array(L); for (let i = 0; i < L; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)); hanns.set(L, w); } return hanns.get(L); };
  // limit: samples at or past this index are not part of the note — the window shrinks to fit (zero-padded to n)
  function mag(x, at, n, out, limit = Infinity) {
    const p = plan(n); const { re, im } = p; const L = Math.max(64, Math.min(n, limit - at)); const win = L === n ? p.win : hann(L);
    for (let i = 0; i < n; i++) { const k = at + i; re[i] = i < L && k < x.length && k >= 0 ? x[k] * win[i] : 0; im[i] = 0; }
    fft(re, im, p);
    const half = n / 2; const o = out || new Float32Array(half);
    for (let i = 0; i < half; i++) o[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return o;
  }
  // anti-aliased decimation (two box passes = triangle filter)
  function decimate(x, d) {
    if (d <= 1) return x;
    const n = Math.floor(x.length / d); const y = new Float32Array(n);
    let acc = 0; const box = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { acc += x[i]; if (i >= d) acc -= x[i - d]; box[i] = acc / d; }
    acc = 0; for (let i = 0, j = 0; i < x.length; i++) { acc += box[i]; if (i >= d) acc -= box[i - d]; if ((i + 1) % d === 0 && j < n) y[j++] = acc / d; }
    return y;
  }

  // ---- onsets: spectral flux (log-compressed, half-wave rectified), adaptive threshold, local maxima ----
  function onsets(x, sr, { win = 1024, hop = 256, minGap = 0.1 } = {}) {
    const n = Math.max(1, Math.floor((x.length - win) / hop) + 1); const half = win / 2;
    let prev = new Float32Array(half), cur = new Float32Array(half); const flux = new Float32Array(n), energy = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      mag(x, f * hop, win, cur); let s = 0, e = 0;
      for (let i = 1; i < half; i++) { const a = Math.log1p(40 * cur[i]), b = Math.log1p(40 * prev[i]); const d = a - b; if (d > 0) s += d; e += cur[i] * cur[i]; }
      flux[f] = s; energy[f] = Math.sqrt(e / half); const t = prev; prev = cur; cur = t;
    }
    // a fine energy envelope pins the onset to where the level actually jumps inside the flux frame
    const B = 256; const nb = Math.floor(x.length / B); const env = new Float32Array(nb);   // 16 ms blocks: a whole cycle even of a low E, so the level does not wobble within a note
    for (let b = 0; b < nb; b++) { let e = 0; for (let i = b * B; i < (b + 1) * B; i++) e += x[i] * x[i]; env[b] = Math.sqrt(e / B); }
    // the onset is where the level starts to climb: the first block in the frame's reach that is 30% of the way
    // from the level before to the peak after (so a strum is timed from its first string, not its loudest one)
    const refine = (f) => {
      const b0 = Math.max(1, Math.floor((f * hop - hop) / B)), b1 = Math.min(nb - 2, Math.floor((f * hop + win + 2 * hop) / B));
      let pk = 0, bp = b0; for (let b = b0; b <= b1; b++) if (env[b] > pk) { pk = env[b]; bp = b; }
      let base = Infinity, bb = b0; for (let b = b0; b <= bp; b++) if (env[b] < base) { base = env[b]; bb = b; }
      let pre = 0; for (let b = Math.max(0, b0 - 4); b <= b0; b++) if (env[b] > pre) pre = env[b];
      if (bp <= bb || pk < 1.3 * pre + 1e-4) return { t: bp * B / sr, rise: 0, lvl: pk };   // nothing really climbs: a note ending (or its tail wobbling), not starting
      const thr = base + 0.3 * (pk - base); let on = bp; for (let b = bb; b <= bp; b++) if (env[b] >= thr) { on = b; break; }
      return { t: on * B / sr, rise: pk - base, lvl: pk };
    };
    // only frames that get LOUDER count (a note ending or being muted splashes the spectrum too, but the level drops)
    const gated = new Float32Array(n);
    for (let f = 0; f < n; f++) { const eAfter = Math.max(energy[Math.min(n - 1, f + 2)], energy[Math.min(n - 1, f + 4)]), eBefore = energy[Math.max(0, f - 3)]; gated[f] = eAfter > eBefore * 1.25 ? flux[f] : 0; }
    const cands = []; const W = 8;
    for (let f = 1; f < n - 1; f++) {
      if (!gated[f]) continue;
      // above the local MEDIAN flux (a mean would be dragged up by the splash of a note being cut off nearby) and above a floor
      const lo = Math.max(0, f - W), hi = Math.min(n - 1, f + W); const w = []; for (let k = lo; k <= hi; k++) w.push(flux[k]); w.sort((a, b) => a - b); const m = w[w.length >> 1];
      const thr = m * 1.5 + 0.02 * half;
      if (gated[f] >= thr && gated[f] >= gated[f - 1] && gated[f] >= gated[f + 1]) { const r = refine(f); if (r.rise > 0) cands.push({ t: r.t, f, strength: flux[f], rise: r.rise }); }
    }
    // several flux frames can point at the same jump in level (a note cut off right before the next one): one onset each
    cands.sort((a, b) => a.t - b.t); const out = [];
    for (const c of cands) { const last = out[out.length - 1]; if (last && c.t - last.t < minGap) { if (c.rise > last.rise) { last.t = c.t; last.f = c.f; last.strength = Math.max(last.strength, c.strength); last.rise = c.rise; } continue; } out.push(c); }
    return { onsets: out, energy, hop, frames: n, flux };
  }

  // ---- spectral peaks with parabolic interpolation: [{hz, amp}] ----
  function peaks(spec, sr, n, { floor = 0.02, maxHz = 6000 } = {}) {
    const binHz = sr / n; let top = 0; for (let i = 1; i < spec.length; i++) if (spec[i] > top) top = spec[i];
    const out = []; const thr = top * floor; const hiBin = Math.min(spec.length - 2, Math.floor(maxHz / binHz));
    for (let i = 2; i < hiBin; i++) {
      const v = spec[i]; if (v < thr || v < spec[i - 1] || v < spec[i + 1]) continue;
      const a = spec[i - 1], b = v, c = spec[i + 1]; const d = (a - c) / (2 * (a - 2 * b + c) || 1); const off = Number.isFinite(d) && Math.abs(d) < 1 ? d : 0;
      out.push({ hz: (i + off) * binHz, amp: b - (a - c) * off / 4 });
    }
    return out;
  }
  // amplitude of the strongest peak within ±tol (ratio) of hz, from a peak list sorted by hz
  function peakAt(pk, hz, tol) {
    let lo = 0, hi = pk.length - 1, best = 0, bi = -1; const a = hz * (1 - tol), b = hz * (1 + tol);
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pk[mid].hz < a) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < pk.length && pk[i].hz <= b; i++) if (pk[i].amp > best) { best = pk[i].amp; bi = i; }
    return { amp: best, i: bi };
  }
  const ENV = [0, 1, 0.7, 0.5, 0.4, 0.32, 0.26, 0.22, 0.19, 0.16, 0.14, 0.12, 0.1, 0.09, 0.08];   // a plucked string's harmonic amplitudes relative to its fundamental (generous: octave doublings are filled back in by shape)
  const HARMW = [0, 1, 0.75, 0.6, 0.45, 0.35, 0.28, 0.22, 0.18, 0.14, 0.1];   // weight per harmonic number (index 1 = fundamental)

  // ---- multi-pitch per segment: iterative harmonic-sum salience with spectral cancellation ----
  // pk: peaks sorted by hz. Returns notes [{midi, hz, sal, cents}] strongest first.
  function multiPitch(pk, { lowMidi = 28, highMidi = 88, maxNotes = 6, tuningCents = 0, minRel = 0.22 } = {}) {
    const live = pk.map((p) => ({ hz: p.hz, amp: p.amp })); const notes = []; let first = 0;
    const cands = []; for (let m = lowMidi * 10; m <= highMidi * 10; m += 2) cands.push(m / 10);   // 20-cent grid
    for (let k = 0; k < maxNotes; k++) {
      let best = null;
      for (const mc of cands) {
        const f0 = midiToHz(mc + tuningCents / 100); const fund = peakAt(live, f0, 0.025); if (fund.amp <= 0) continue;
        let s = 0, nh = 0;
        for (let h = 1; h <= 10; h++) { const r = peakAt(live, f0 * h, h === 1 ? 0.025 : 0.018 + 0.004 * h); if (r.amp > 0) { s += HARMW[h] * r.amp; nh++; } }
        if (nh < 2) continue;
        // a fundamental that is weak next to the even harmonic above it is usually that octave's note played alone
        const oct = peakAt(live, f0 * 2, 0.025).amp; if (fund.amp < 0.12 * oct) s *= 0.4;
        if (!best || s > best.s) best = { s, mc, f0, fund: fund.amp };
      }
      if (!best) break;
      if (k === 0) first = best.s; else if (best.s < minRel * first) break;
      // refine: the fundamental from every harmonic peak that is there (f_h / h), amplitude-weighted — the upper
      // harmonics pin a low note's pitch far better than its own (wide, low) fundamental bin
      const fp = peakAt(live, best.f0, 0.03); let num = 0, den = 0;
      for (let h = 1; h <= 6; h++) { const r = peakAt(live, best.f0 * h, h === 1 ? 0.03 : 0.018 + 0.004 * h); if (r.i >= 0) { const w = r.amp * Math.sqrt(h); num += w * (live[r.i].hz / h); den += w; } }
      const hz = den ? num / den : (fp.i >= 0 ? live[fp.i].hz : best.f0); const midiF = hzToMidi(hz) - tuningCents / 100;
      const midi = Math.round(midiF); const fundAmp = fp.i >= 0 ? live[fp.i].amp : best.fund;
      if (notes.some((n) => n.midi === midi)) { cancel(live, hz, fundAmp); continue; }
      // an octave above an accepted note must stand on its own fundamental, not on that note's 2nd harmonic
      const below = notes.find((n) => n.midi === midi - 12); if (below && fundAmp < 0.3 * below.fund) { cancel(live, hz, fundAmp); continue; }
      notes.push({ midi, hz, sal: best.s, cents: Math.round((midiF - midi) * 100), fund: fundAmp, midiF });
      cancel(live, hz, fundAmp);
    }
    return notes;
  }
  // take a note's harmonics out of the live peak list: each harmonic loses what a plucked string of that fundamental
  // would put there (a generous 1/h envelope), so a real note sitting on a harmonic keeps its surplus
  function cancel(live, f0, fundAmp) {
    for (let h = 1; h <= 14; h++) {
      const r = peakAt(live, f0 * h, h === 1 ? 0.025 : 0.018 + 0.004 * h); if (r.i < 0) continue;
      const predicted = h === 1 ? fundAmp : fundAmp * ENV[Math.min(h, ENV.length - 1)];
      live[r.i].amp = Math.max(0, live[r.i].amp - predicted);
    }
  }

  // the pitch of a single note by the time-domain tracker (YIN): precise on short low notes where a spectrum is not
  function yinMidi(y, sr, t0, dur, lowMidi, highMidi) {
    const PC = getPC(); if (!PC || !PC.track) return NaN;
    const a = Math.floor((t0 + 0.015) * sr), z = Math.min(y.length, Math.floor((t0 + dur) * sr)); if (z - a < 512) return NaN;
    const pts = PC.track(y.subarray(a, z), sr, { hop: 0.01, win: Math.min(2048, z - a), minHz: midiToHz(lowMidi), maxHz: midiToHz(highMidi) }).filter((p) => Number.isFinite(p.midi));
    if (pts.length < 2) return NaN; const ms = pts.map((p) => p.midi).sort((x, w) => x - w); return ms[Math.floor(ms.length / 2)];
  }
  // ---- tuning: median cents offset of the strongest fundamentals across the take ----
  function tuningEstimate(frames) {
    const cs = []; for (const n of frames) for (const x of n.slice(0, 2)) cs.push(x.cents);
    if (cs.length < 4) return 0; cs.sort((a, b) => a - b); const m = cs[Math.floor(cs.length / 2)]; return Math.abs(m) <= 45 ? m : 0;
  }

  // ---- fretboard: lay a set of midi notes on strings (ascending, one per string, smallest span) ----
  function voicing(midis, tuning, { maxFret = 19 } = {}) {
    const ns = [...new Set(midis)].sort((a, b) => a - b); const S = tuning.length;
    let best = null;
    const rec = (i, s0, frets, used) => {
      if (i === ns.length) {
        const f = frets.filter((x) => x > 0); const lo = f.length ? Math.min(...f) : 0, hi = f.length ? Math.max(...f) : 0;
        const span = f.length ? hi - lo : 0; if (span > 5) return;
        const cost = span * 2 + lo * 0.35 + (frets.filter((x) => x === 0).length ? -0.5 : 0) + (S - used) * 0.1;
        if (!best || cost < best.cost) best = { cost, frets: frets.slice() };
        return;
      }
      for (let s = s0; s < S; s++) { const fr = ns[i] - tuning[s]; if (fr < 0 || fr > maxFret) continue; frets[s] = fr; rec(i + 1, s + 1, frets, used + 1); frets[s] = -1; }
    };
    rec(0, 0, new Array(S).fill(-1), 0);
    return best ? best.frets : null;
  }
  // chord name from pitch classes (bass note = lowest): best template by overlap, simple triads first
  const CHORD_TYPES = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['5', [0, 7]], ['7', [0, 4, 7, 10]], ['m7', [0, 3, 7, 10]], ['maj7', [0, 4, 7, 11]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['dim', [0, 3, 6]], ['add9', [0, 2, 4, 7]], ['m9', [0, 2, 3, 7, 10]], ['9', [0, 2, 4, 7, 10]], ['aug', [0, 4, 8]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['7sus4', [0, 5, 7, 10]]];
  function chordName(midis) {
    const ns = [...new Set(midis)].sort((a, b) => a - b); if (!ns.length) return null; const pcs = new Set(ns.map(mod)); const bass = mod(ns[0]);
    let best = null;
    for (let r = 0; r < 12; r++) for (const [suf, iv] of CHORD_TYPES) {
      const tones = iv.map((i) => mod(r + i)); const hit = tones.filter((t) => pcs.has(t)).length; const extra = [...pcs].filter((p) => !tones.includes(p)).length;
      if (hit < Math.min(2, tones.length)) continue;
      const score = hit * 2 - extra * 1.6 - (tones.length - hit) * 1.2 + (r === bass ? 0.9 : 0) + (suf === '' || suf === 'm' ? 0.3 : suf === '5' ? 0.1 : 0);
      if (!best || score > best.score) best = { score, root: r, suf, tones };
    }
    if (!best) return null;
    const name = SHARP[best.root] + best.suf; return { name: best.root === bass ? name : `${name}/${SHARP[bass]}`, root: best.root, type: best.suf, tones: best.tones };
  }

  // A strummed chord usually rings on more strings than the analysis can pull apart (octave doublings hide under the
  // lower strings' harmonics). Once the chord is named, muted strings inside and above the hand position that would
  // sound a chord tone at an open fret or within the span are filled in — the shape a guitarist would actually hold.
  function fillShape(frets, tuning, chord) {
    if (!chord) return { frets, filled: [] };
    const tones = new Set(chord.tones); const sounding = frets.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
    if (sounding.length < 2) return { frets, filled: [] };
    const fretted = frets.filter((f) => f > 0); const lo = fretted.length ? Math.min(...fretted) : 1, hi = fretted.length ? Math.max(...fretted) : 0;
    const out = frets.slice(); const filled = [];
    for (let s = sounding[0] + 1; s < tuning.length; s++) {
      if (out[s] >= 0) continue;
      const opts = []; if (tones.has(mod(tuning[s]))) opts.push(0);
      for (let f = Math.max(1, lo); f <= Math.max(hi, lo + 2) && f <= hi + 1; f++) if (tones.has(mod(tuning[s] + f))) opts.push(f);
      if (!opts.length) continue;
      out[s] = opts[0]; filled.push(s);
    }
    return { frets: out, filled };
  }
  // ---- the transcription ----
  // x: mono Float32Array, sr: its sample rate. Returns { events: [{t, d, notes:[midi], frets:[...], name?, mono}], tuningCents, tuning }
  function transcribe(x, sr, { instrument = 'guitar', tuning = null, minNote = 0.05 } = {}) {
    const tn = tuning || (instrument === 'bass' ? BASS : GUITAR); const isBass = instrument === 'bass';
    const d = Math.max(1, Math.floor(sr / 16000)); const y = decimate(x, d); const sr2 = sr / d;
    const O = onsets(y, sr2); const ons = O.onsets; const N = isBass ? 8192 * 2 : 8192;   // bass needs the finer bins (low E = 41 Hz; a semitone there is 2.4 Hz)
    const lowMidi = tn[0] - 1, highMidi = tn[tn.length - 1] + 20;
    const spec = new Float32Array(N / 2); const avg = new Float32Array(N / 2);
    const segs = [];
    for (let k = 0; k < ons.length; k++) {
      const t0 = ons[k].t, t1 = k + 1 < ons.length ? ons[k + 1].t : y.length / sr2;
      // how long the note really rings: until the energy falls 24 dB under the segment's peak (or the next onset)
      const f0 = ons[k].f, f1 = k + 1 < ons.length ? ons[k + 1].f : O.frames; let pk = 0; for (let f = f0; f < f1; f++) if (O.energy[f] > pk) pk = O.energy[f];
      let fEnd = f1; for (let f = f0 + 2; f < f1; f++) if (O.energy[f] < pk * 0.063) { fEnd = f; break; }
      const dur = Math.max(minNote, (fEnd - f0) * O.hop / sr2);
      if (dur < minNote || pk < 1e-4) continue;
      // average the spectrum over the steady part of the note (skip the pluck, use up to 0.6 s)
      const a = Math.floor((t0 + 0.02) * sr2), z = Math.min(y.length, Math.floor(Math.min(t1, t0 + 0.65) * sr2));
      // frames never reach into the next note: the window shrinks to the note (zero-padded to N); same length for the
      // "before" spectrum so the two line up lobe for lobe when one is taken from the other
      const L = Math.max(256, Math.min(N, z - a));
      avg.fill(0); let cnt = 0; const hop = Math.max(512, Math.floor(L / 4));
      for (let at = a; at + L <= z || cnt === 0; at += hop) { mag(y, at, N, spec, at + L); for (let i = 0; i < spec.length; i++) avg[i] += spec[i]; cnt++; if (at + hop + L > z) break; }
      if (!cnt) continue; for (let i = 0; i < avg.length; i++) avg[i] /= cnt;
      // what was still ringing from before this onset is not part of this note: take the spectrum just before it out
      if (k > 0) { const on = Math.floor(t0 * sr2); const pre = mag(y, Math.max(0, on - L), N, undefined, on); for (let i = 0; i < avg.length; i++) { avg[i] -= 0.8 * pre[i]; if (avg[i] < 0) avg[i] = 0; } }
      const pk2 = peaks(avg, sr2, N, { floor: 0.015, maxHz: Math.min(6000, sr2 / 2 - 100) }); if (!pk2.length) continue;
      segs.push({ t: t0, d: dur, pk: pk2, peakE: pk });
    }
    // first pass to learn the tuning, second to read the notes with it compensated
    const first = segs.map((s) => multiPitch(s.pk, { lowMidi, highMidi, maxNotes: isBass ? 2 : 6 }));
    const tuningCents = tuningEstimate(first);
    const events = [];
    segs.forEach((s, i) => {
      const notes = tuningCents ? multiPitch(s.pk, { lowMidi, highMidi, maxNotes: isBass ? 2 : 6, tuningCents }) : first[i];
      if (!notes.length) return;
      const mono = isBass || notes.length === 1 || notes[1].sal < 0.42 * notes[0].sal;
      let use = mono ? [notes[0]] : notes;
      // a single note: the spectrum (harmonic-weighted) is the pitch; the time-domain tracker (YIN) only settles a
      // reading that sits near the half-way point between two semitones
      if (mono && Math.abs(notes[0].midiF - notes[0].midi) > 0.3) { const guess = notes[0].midiF + tuningCents / 100; const yin = yinMidi(y, sr2, s.t, Math.min(s.d, 0.6), guess - 1.2, guess + 1.2); if (Number.isFinite(yin) && Math.abs(yin - guess) < 0.75) { const m = Math.round(yin - tuningCents / 100); use = [{ ...notes[0], midi: m }]; } }
      let frets = voicing(use.map((n) => n.midi), tn); while (!frets && use.length > 1) { use = use.slice(0, -1); frets = voicing(use.map((n) => n.midi), tn); }
      if (!frets) return;
      const ev = { t: Math.round(s.t * 1000) / 1000, d: Math.round(s.d * 1000) / 1000, notes: use.map((n) => n.midi), frets, mono: use.length === 1, conf: Math.min(1, Math.round(100 * Math.min(1, use[0].sal / (use[0].sal + 1e-9)) * (use.length > 1 ? 0.8 : 0.9)) / 100) };
      if (use.length > 2) { const cn = chordName(use.map((n) => n.midi)); if (cn) { ev.name = cn.name; const fs = fillShape(frets, tn, cn); if (fs.filled.length) { ev.frets = fs.frets; ev.filled = fs.filled; } } }
      events.push(ev);
    });
    return { events, tuningCents, tuning: tn, instrument };
  }

  // ---- text tab: events on string lines; chords stack vertically; bars from the beat length ----
  function tabText(events, { tuning = GUITAR, beatLen = 0.5, charsPerBeat = 4, beatsPerBar = 4, lineBeats = 16, t0 = 0, names = true } = {}) {
    const S = tuning.length; const seen = new Set(); const lab = tuning.map((m) => { const n = SHARP[mod(m)]; const l = seen.has(n) ? n.toLowerCase() : n; seen.add(n); return l; });   // E A D G B e
    if (!events.length) return '';
    const end = Math.max(...events.map((e) => e.t + e.d)); const totalCols = Math.ceil((end - t0) / beatLen) * charsPerBeat + charsPerBeat;
    const lines = tuning.map(() => new Array(totalCols).fill('-')); const nameRow = new Array(totalCols).fill(' ');
    for (const e of events) {
      const c = Math.max(0, Math.round((e.t - t0) / beatLen * charsPerBeat)); if (c >= totalCols) continue;
      const width = Math.max(...e.frets.filter((f) => f >= 0).map((f) => String(f).length));
      for (let s = 0; s < S; s++) { const f = e.frets[s]; if (f < 0) continue; const str = String(f).padStart(width, '-'); for (let k = 0; k < str.length && c + k < totalCols; k++) lines[s][c + k] = str[k]; }
      if (names && e.name) for (let k = 0; k < e.name.length && c + k < totalCols; k++) nameRow[c + k] = e.name[k];
    }
    const barCols = beatsPerBar * charsPerBeat, lineCols = lineBeats * charsPerBeat; const out = [];
    for (let start = 0; start < totalCols; start += lineCols) {
      const seg = (arr) => { let s = ''; for (let c = start; c < Math.min(totalCols, start + lineCols); c++) { if (c > start && (c - start) % barCols === 0) s += '|'; s += arr[c]; } return s; };
      if (names && nameRow.slice(start, start + lineCols).some((ch) => ch !== ' ')) out.push('   ' + seg(nameRow).replace(/\|/g, ' '));
      for (let s = S - 1; s >= 0; s--) out.push(`${lab[s].padEnd(2)}|${seg(lines[s])}|`);
      out.push('');
    }
    return out.join('\n').trimEnd();
  }
  // highway-style per-string events from tab events: {t, d, lane: string, label: fret}
  function laneEvents(events, { from = -Infinity, to = Infinity } = {}) {
    const out = [];
    for (const e of events) { if (e.t < from || e.t >= to) continue; e.frets.forEach((f, s) => { if (f >= 0) out.push({ t: e.t, d: e.d, lane: s, label: String(f), sub: e.name && s === e.frets.findIndex((x) => x >= 0) ? e.name : '', midi: e.notes[Math.min(e.notes.length - 1, out.length)] }); }); }
    return out.sort((a, b) => a.t - b.t || a.lane - b.lane);
  }
  return { transcribe, onsets, peaks, multiPitch, voicing, chordName, tabText, laneEvents, tuningEstimate, GUITAR, BASS, BASS5, decimate };
});
