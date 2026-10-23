// Notes from a recording, the way a player would write them down.
//  1. hear:   a small neural note tracker (nmp.js: Spotify's Basic Pitch model, Apache-2.0, run on this computer)
//             gives, every 11.6 ms, how sure it is that each of the 88 piano pitches is sounding and starting.
//  2. decode: those posteriors become notes (start, end, pitch, strength) — every string that rings, not a chord guess.
//             Ported from Basic Pitch's note_creation.py (Apache-2.0, © 2022 Spotify AB).
//  3. tidy:   the notes are cleaned up like a musician would:
//             - overtones of a louder note (its octave / twelfth) that the tracker also reported are dropped
//             - onsets snap to the song's beat grid (16ths, or triplets where the bar is played in threes)
//             - a weak note outside the key is moved to the in-key neighbour when the audio supports it
//             - bars that repeat vote: a riff heard cleanly three times fills in the pass where a note was missed,
//               and a stray note only one pass has (and that was weak) goes
//  4. fret:   events (notes struck together) are laid on the fretboard with a Viterbi pass that keeps the hand in
//             one position and prefers shapes a guitarist would actually use; chords get names from their notes.
// Pure (renderer: window.BPNotes; node: require).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPNotes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SR = 22050, HOP = 256, FPS = SR / HOP, NP = 88, MIDI0 = 21;
  const ANNOT_N_FRAMES = Math.floor(FPS) * 2, AUDIO_N_SAMPLES = SR * 2 - HOP;
  const WINDOW_OFFSET = (HOP / SR) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / HOP) + 0.0018;
  const frameTime = (f) => (f * HOP) / SR - WINDOW_OFFSET * Math.floor(f / ANNOT_N_FRAMES);
  const GUITAR = [40, 45, 50, 55, 59, 64], BASS = [28, 33, 38, 43];
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const mod = (n) => ((n % 12) + 12) % 12;
  const PCS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };

  // ---------- 2. decode ----------
  // post: { T, note: Float32Array(T*88), onset: Float32Array(T*88), contour?: Float32Array(T*264) }
  // returns [{ f0, f1, midi, amp }] (frames)
  function decode(post, { onsetThresh = 0.5, frameThresh = 0.3, minLen = 6, energyTol = 11, minMidi = 21, maxMidi = 108, inferOnsets = true, melodia = true } = {}) {
    const { T, note } = post; let onset = post.onset;
    const lo = Math.max(0, minMidi - MIDI0), hi = Math.min(NP - 1, maxMidi - MIDI0);
    const at = (a, t, p) => a[t * NP + p];
    // onsets inferred from jumps in the frame activations, rescaled to the onset map's peak (Basic Pitch's get_infered_onsets)
    if (inferOnsets) {
      const diff = new Float32Array(T * NP); let dmax = 0, omax = 0;
      for (let i = 0; i < onset.length; i++) if (onset[i] > omax) omax = onset[i];
      for (let t = 2; t < T; t++) for (let p = 0; p < NP; p++) { const v = note[t * NP + p]; const d = Math.min(v - note[(t - 1) * NP + p], v - note[(t - 2) * NP + p]); if (d > 0) { diff[t * NP + p] = d; if (d > dmax) dmax = d; } }
      const o2 = new Float32Array(T * NP); for (let i = 0; i < o2.length; i++) o2[i] = Math.max(onset[i], dmax ? (omax * diff[i]) / dmax : 0);
      onset = o2;
    }
    const remain = Float32Array.from(note); const out = [];
    for (let t = 0; t < T; t++) for (let p = 0; p < NP; p++) if (p < lo || p > hi) remain[t * NP + p] = 0;
    // peaks of the onset map in time, strongest-last order like the reference (backwards in time)
    const starts = [];
    for (let t = 1; t < T - 1; t++) for (let p = lo; p <= hi; p++) { const v = at(onset, t, p); if (v >= onsetThresh && v > at(onset, t - 1, p) && v > at(onset, t + 1, p)) starts.push([t, p]); }
    starts.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    for (const [t0, p] of starts) {
      if (t0 >= T - 1) continue;
      let i = t0 + 1, k = 0;
      while (i < T - 1 && k < energyTol) { if (remain[i * NP + p] < frameThresh) k++; else k = 0; i++; }
      i -= k; if (i - t0 <= minLen) continue;
      for (let t = t0; t < i; t++) { remain[t * NP + p] = 0; if (p < NP - 1) remain[t * NP + p + 1] = 0; if (p > 0) remain[t * NP + p - 1] = 0; }
      let s = 0; for (let t = t0; t < i; t++) s += note[t * NP + p];
      out.push({ f0: t0, f1: i, midi: p + MIDI0, amp: s / (i - t0) });
    }
    // the "melodia trick": sustained energy that never had a clear onset (legato, slides, hammer-ons) becomes notes too
    if (melodia) {
      for (let guard = 0; guard < 20000; guard++) {
        let best = frameThresh, bi = -1; for (let i = 0; i < remain.length; i++) if (remain[i] > best) { best = remain[i]; bi = i; }
        if (bi < 0) break;
        const tm = Math.floor(bi / NP), p = bi % NP; remain[bi] = 0;
        const clear = (t) => { remain[t * NP + p] = 0; if (p < NP - 1) remain[t * NP + p + 1] = 0; if (p > 0) remain[t * NP + p - 1] = 0; };
        let i = tm + 1, k = 0; while (i < T - 1 && k < energyTol) { if (remain[i * NP + p] < frameThresh) k++; else k = 0; clear(i); i++; }
        const iEnd = i - 1 - k;
        i = tm - 1; k = 0; while (i > 0 && k < energyTol) { if (remain[i * NP + p] < frameThresh) k++; else k = 0; clear(i); i--; }
        const iStart = i + 1 + k;
        if (iEnd - iStart <= minLen) continue;
        let s = 0; for (let t = iStart; t < iEnd; t++) s += note[t * NP + p];
        out.push({ f0: iStart, f1: iEnd, midi: p + MIDI0, amp: s / (iEnd - iStart), legato: true });
      }
    }
    return out.sort((a, b) => a.f0 - b.f0 || a.midi - b.midi);
  }
  // cents off the semitone, per note, from the 1/3-semitone contour map (median over the note)
  function bendsCents(post, n) {
    if (!post.contour) return 0; const C = 264; const c = Math.round((n.midi - MIDI0) * 3 + 1); const vals = [];
    for (let t = n.f0; t < Math.min(n.f1, post.T); t++) { let best = -1, bi = 0; for (let d = -2; d <= 2; d++) { const j = c + d; if (j < 0 || j >= C) continue; const v = post.contour[t * C + j]; if (v > best) { best = v; bi = d; } } vals.push(bi); }
    if (!vals.length) return 0; vals.sort((a, b) => a - b); return Math.round((vals[vals.length >> 1] * 100) / 3);
  }
  // how strongly `midi` is sounding over frames [f0, f1) (mean of the frame posterior) — the evidence check
  function evidence(post, midi, f0, f1) {
    const p = midi - MIDI0; if (p < 0 || p >= NP) return 0; let s = 0, n = 0, mx = 0;
    for (let t = Math.max(0, f0); t < Math.min(post.T, f1); t++) { const v = post.note[t * NP + p]; s += v; n++; if (v > mx) mx = v; }
    return n ? Math.max(s / n, 0.6 * mx) : 0;
  }
  const onsetEvidence = (post, midi, f0, w = 3) => { const p = midi - MIDI0; if (p < 0 || p >= NP || !post.onset) return 0; let mx = 0; for (let t = Math.max(0, f0 - w); t <= Math.min(post.T - 1, f0 + w); t++) mx = Math.max(mx, post.onset[t * NP + p]); return mx; };
  const timeToFrame = (t) => { let f = Math.round(t * FPS); for (let k = 0; k < 3; k++) f = Math.round((t + WINDOW_OFFSET * Math.floor(f / ANNOT_N_FRAMES)) * FPS); return Math.max(0, f); };

  // ---------- key ----------
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function parseKey(k) { const m = /^([A-G][b#]?)(m|min|minor)?$/.exec(String(k || '').trim()); if (!m || PCS[m[1]] == null) return null; return { tonic: PCS[m[1]], minor: !!m[2] }; }
  function scaleOf(key) { const iv = key.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]; return new Set(iv.map((i) => mod(key.tonic + i))); }   // minor includes the raised 7th (harmonic minor's leading tone is everywhere in rock)
  function keyFromNotes(notes) {
    const h = new Array(12).fill(0); for (const n of notes) h[mod(n.midi)] += (n.d || 0.1) * (n.amp || 0.5);
    let best = null; const mean = (a) => a.reduce((x, y) => x + y, 0) / 12;
    const corr = (prof, r) => { const mh = mean(h), mp = mean(prof); let num = 0, a = 0, b = 0; for (let i = 0; i < 12; i++) { const x = h[mod(i + r)] - mh, y = prof[i] - mp; num += x * y; a += x * x; b += y * y; } return num / Math.sqrt(a * b || 1); };
    for (let r = 0; r < 12; r++) for (const [prof, minor] of [[MAJ, false], [MIN, true]]) { const c = corr(prof, r); if (!best || c > best.c) best = { tonic: r, minor, c }; }
    return best && best.c > 0.3 ? best : null;
  }

  // ---------- grid ----------
  // beats: [{t, beat}] in the recording's own time. Each beat is cut in 4 (16ths) or 3 (triplet 8ths) — whichever the
  // onsets in that bar sit on better (a little bias toward 16ths, the usual case).
  function gridFor(notes, beats) {
    if (!beats || beats.length < 2) return null;
    const bars = []; let cur = null;
    for (let i = 0; i < beats.length; i++) { if (beats[i].beat === 0 || !cur) { cur = { beats: [] }; bars.push(cur); } cur.beats.push(i); }
    const slots = []; const len = (i) => (i + 1 < beats.length ? beats[i + 1].t - beats[i].t : beats[i].t - beats[i - 1].t);
    const onsetsIn = (a, b) => notes.filter((n) => n.t >= a && n.t < b).map((n) => n.t);
    bars.forEach((bar, bi) => {
      const a = beats[bar.beats[0]].t, last = bar.beats[bar.beats.length - 1]; const b = beats[last].t + len(last);
      const ons = onsetsIn(a - 0.05, b - 0.05); let best = null;
      for (const div of [4, 3]) {
        let err = 0; const cand = [];
        for (const i of bar.beats) { const L = len(i); for (let k = 0; k < div; k++) cand.push(beats[i].t + (k * L) / div); }
        for (const t of ons) { let m = Infinity; for (const c of cand) m = Math.min(m, Math.abs(t - c)); err += m * m; }
        const score = err * (div === 3 ? 1.35 : 1);
        if (!best || score < best.score) best = { score, div, cand };
      }
      for (let k = 0; k < best.cand.length; k++) slots.push({ t: best.cand[k], bar: bi, k, div: best.div });
    });
    return { slots, bars: bars.length };
  }
  // the recording's latency against the click: the shift (± a 32nd, max 60 ms) that makes onsets sit best on the grid
  function gridShift(notes, slots) {
    if (!slots || slots.length < 8 || notes.length < 8) return 0;
    const ts = slots.map((s) => s.t); const step = ts[1] - ts[0]; const lim = Math.min(0.06, step / 2);
    let best = { e: Infinity, s: 0 };
    for (let s = -lim; s <= lim + 1e-9; s += 0.004) { let e = 0; let j = 0; for (const n of notes) { const t = n.t - s; while (j + 1 < ts.length && ts[j + 1] <= t) j++; const d = Math.min(Math.abs(t - ts[j]), j + 1 < ts.length ? Math.abs(ts[j + 1] - t) : Infinity); e += Math.min(d, step / 2) ** 2; } if (e < best.e) best = { e, s }; }
    return best.s;
  }
  const nearestSlot = (slots, t) => { let lo = 0, hi = slots.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (slots[m].t < t) lo = m + 1; else hi = m; } let j = lo; if (j > 0 && Math.abs(slots[j - 1].t - t) <= Math.abs(slots[j].t - t)) j--; return j; };

  // ---------- 3. tidy ----------
  // notes: [{f0,f1,midi,amp}] → [{t, d, midi, amp, slot?}]
  function tidy(raw, post, { instrument = 'guitar', tuning = null, beats = null, key = null, minAmp = 0.3, overtone = 0.4, overtoneIv = [12, 19, 24, 28, 31], vote = true, keyFix = true } = {}) {
    const tn = tuning || (instrument === 'bass' ? BASS : GUITAR); const lowM = tn[0], highM = tn[tn.length - 1] + (instrument === 'bass' ? 21 : 22);
    let notes = raw.filter((n) => n.midi >= lowM && n.midi <= highM && n.amp >= minAmp).map((n) => ({ ...n, t: frameTime(n.f0), d: frameTime(n.f1) - frameTime(n.f0) }));
    // overtones: a note an octave / twelfth / two octaves above a louder note struck at the same time, much weaker than it
    // the tracker cut one ringing note in two: same pitch, back to back, and either the second half has no pick attack of
    // its own, or the first half is just the rising edge of the second (short, weaker, the level still climbing)
    { const on = (n) => onsetEvidence(post, n.midi, n.f0, 1); const lvl = (m, t) => (t >= 0 && t < post.T ? post.note[t * NP + m - MIDI0] : 0);
      const byP = new Map(); for (const n of notes) { if (!byP.has(n.midi)) byP.set(n.midi, []); byP.get(n.midi).push(n); }
      const gone = new Set(); for (const list of byP.values()) { list.sort((a, b) => a.f0 - b.f0); for (let i = 1; i < list.length; i++) { const a = list[i - 1], b = list[i]; if (gone.has(a) || b.f0 > a.f1 + 2) continue;
        if (on(b) < Math.max(0.35, 0.6 * on(a))) { a.f1 = Math.max(a.f1, b.f1); a.amp = Math.max(a.amp, b.amp); gone.add(b); list[i] = a; }
        else if (a.f1 - a.f0 <= 0.13 * FPS && a.amp < 0.8 * b.amp && lvl(a.midi, a.f0 + 1) < 0.6 * lvl(b.midi, b.f0 + 1)) { b.amp = Math.max(a.amp, b.amp); gone.add(a); } } }
      notes = notes.filter((n) => !gone.has(n)); }
    // overtones: a note an octave / twelfth / two octaves above another struck with it. Whether it is real depends on the
    // playing around it: inside chords (power chords, strums) the octave is usually played; in a single-note line (a riff,
    // a lead) it is the lower note's own overtone. A bass plays one note at a time anyway.
    const partnerOf = (n) => notes.find((m) => m !== n && overtoneIv.includes(n.midi - m.midi) && Math.abs(m.f0 - n.f0) <= 3 && n.f1 <= m.f1 + 6);
    const monoAround = (n) => { const w = 0.7 * FPS; const near = notes.filter((m) => Math.abs(m.f0 - n.f0) > 3 && Math.abs(m.f0 - n.f0) < w); if (near.length < 3) return 0.5; const ms = near.slice().sort((x, y) => x.f0 - y.f0); const groups = []; for (const m of ms) { const g = groups[groups.length - 1]; if (g && m.f0 - g.first <= 7) g.ms.push(m.midi); else groups.push({ first: m.f0, ms: [m.midi] }); } const chordal = (g) => { const lo = Math.min(...g.ms); return g.ms.some((x) => x !== lo && !overtoneIv.includes(x - lo)); }; return groups.filter((g) => !chordal(g)).length / groups.length; };
    { const drop = new Set();
      for (const n of notes) { const m = partnerOf(n); if (!m) continue;
        if (n.amp < overtone * m.amp) { drop.add(n); continue; }
        if (instrument === 'bass' || monoAround(n) >= 0.6) drop.add(n.amp <= 1.4 * m.amp ? n : m);   /* one of the two is the other's shadow: keep the louder (a much louder upper note means the low one was a distortion sub-tone) */ }
      notes = notes.filter((n) => !drop.has(n)); }
    // a bass is (nearly always) one note at a time: keep the strongest of notes struck together
    if (instrument === 'bass') notes = notes.filter((n) => !notes.some((m) => m !== n && Math.abs(m.f0 - n.f0) <= 3 && (m.amp > n.amp || (m.amp === n.amp && m.midi < n.midi))));
    // key: the song's, or heard from the notes
    const K = parseKey(key) || keyFromNotes(notes); const inKey = K ? scaleOf(K) : null;
    if (inKey && keyFix) notes = notes.map((n) => {
      if (inKey.has(mod(n.midi)) || n.amp >= 0.5) return n;
      const here = evidence(post, n.midi, n.f0, n.f1);
      const alt = [n.midi - 1, n.midi + 1].filter((m) => inKey.has(mod(m))).map((m) => ({ m, e: evidence(post, m, n.f0, n.f1) })).sort((a, b) => b.e - a.e)[0];
      if (alt && alt.e >= 0.55 * here) return { ...n, midi: alt.m, moved: n.midi };
      if (n.amp < 0.28 && n.d < 0.12) return null;   /* a faint blip outside the key: noise, not a note */
      return n;
    }).filter(Boolean);
    // grid
    const G = beats && beats.length > 2 ? gridFor(notes, beats) : null;
    if (G) {
      const sh = gridShift(notes, G.slots); const S = G.slots;
      for (const n of notes) {
        const j = nearestSlot(S, n.t - sh); const off = Math.abs(S[j].t - (n.t - sh)); const step = j + 1 < S.length ? S[j + 1].t - S[j].t : S[j].t - S[j - 1].t;
        if (off <= step * 0.55) { const end = n.t + n.d - sh; const je = Math.max(j + 1, nearestSlot(S, end)); n.slot = j; n.t = S[j].t; n.d = Math.max(step * 0.9, (je < S.length ? S[je].t : end) - S[j].t); }
      }
      notes.shift = sh;
      // same pitch on the same slot twice (a re-trigger the tracker split): one note
      const seen = new Map(); notes = notes.filter((n) => { if (n.slot == null) return true; const k = `${n.slot}:${n.midi}`; const o = seen.get(k); if (o) { o.amp = Math.max(o.amp, n.amp); o.d = Math.max(o.d, n.d); return false; } seen.set(k, n); return true; });
      if (vote) notes = patternVote(notes, post, G, sh);
    }
    notes.key = K; return notes.sort((a, b) => a.t - b.t || a.midi - b.midi);
  }
  // Bars that repeat agree with each other. Bars are compared by what is played on which slot; a group of at least three
  // similar bars agrees on its notes (in ≥ 60% of them). A bar missing an agreed note gets it when the audio shows that
  // pitch there at all; a note only one bar of the group has, played weakly, is dropped; an octave slip is corrected.
  function patternVote(notes, post, G, sh) {
    const byBar = new Map();
    for (const n of notes) { if (n.slot == null) continue; const s = G.slots[n.slot]; if (!byBar.has(s.bar)) byBar.set(s.bar, []); byBar.get(s.bar).push(n); }
    const first = new Map(); G.slots.forEach((s, i) => { if (!first.has(s.bar)) first.set(s.bar, i); });
    const sig = (bar) => new Set((byBar.get(bar) || []).map((n) => `${n.slot - first.get(bar)}:${n.midi}`));
    const pcsig = (bar) => new Set((byBar.get(bar) || []).map((n) => `${n.slot - first.get(bar)}:${mod(n.midi)}`));
    const barsList = [...byBar.keys()].sort((a, b) => a - b); const sim = (a, b) => { const A = pcsig(a), B = pcsig(b); if (!A.size || !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
    const slotsIn = (bar) => G.slots.filter((s) => s.bar === bar).length;
    const added = []; const drop = new Set(); const fix = new Map();
    for (const b of barsList) {
      const group = barsList.filter((o) => slotsIn(o) === slotsIn(b) && (o === b || sim(o, b) >= 0.45));
      if (group.length < 3) continue;
      const count = new Map(); for (const o of group) for (const k of sig(o)) count.set(k, (count.get(k) || 0) + 1);
      const agreed = [...count].filter(([, c]) => c / group.length >= 0.6).map(([k]) => k);
      const mine = sig(b); const notesHere = byBar.get(b) || [];
      for (const k of agreed) {
        if (mine.has(k)) continue; const [rel, midi] = k.split(':').map(Number); const j = first.get(b) + rel; const s = G.slots[j]; if (!s) continue;
        const slip = notesHere.find((n) => n.slot === j && Math.abs(n.midi - midi) === 12);
        const step = j + 1 < G.slots.length ? G.slots[j + 1].t - s.t : 0.1; const f0 = timeToFrame(s.t + sh), f1 = timeToFrame(s.t + sh + Math.max(step, 0.08));
        const ev = Math.max(evidence(post, midi, f0, f1), onsetEvidence(post, midi, f0));
        if (slip) { if (ev >= 0.12) fix.set(slip, midi); continue; }
        if (ev >= 0.12) {
          const like = group.map((o) => (byBar.get(o) || []).find((n) => n.slot - first.get(o) === rel && n.midi === midi)).filter(Boolean);
          const d = like.length ? like.map((n) => n.d).sort((x, y) => x - y)[like.length >> 1] : step;
          added.push({ t: s.t, d, midi, amp: Math.max(0.2, ev), slot: j, inferred: true });
        }
      }
      for (const n of notesHere) { const k = `${n.slot - first.get(b)}:${n.midi}`; if ((count.get(k) || 0) === 1 && n.amp < 0.4 && group.length >= 4) drop.add(n); }
    }
    for (const [n, m] of fix) { n.octaveFrom = n.midi; n.midi = m; }
    return notes.filter((n) => !drop.has(n)).concat(added);
  }

  // ---------- 4. fret ----------
  // group notes struck together into events
  function events(notes) {
    const out = []; const sorted = notes.slice().sort((a, b) => a.t - b.t || a.midi - b.midi);
    for (const n of sorted) { const e = out[out.length - 1]; if (e && (n.slot != null && e.slot != null ? n.slot === e.slot : Math.abs(n.t - e.t) < 0.03) && !e.notes.includes(n.midi)) { e.notes.push(n.midi); e.d = Math.max(e.d, n.d); e.amp = Math.max(e.amp, n.amp); e.inferred = e.inferred && n.inferred; continue; } out.push({ t: n.t, d: n.d, notes: [n.midi], slot: n.slot, amp: n.amp, inferred: !!n.inferred }); }
    for (const e of out) e.notes.sort((a, b) => a - b);
    return out;
  }
  // every playable way to fret an event: one note per string, strings in pitch order, a span a hand can hold
  function fingerings(midis, tuning, { maxFret = 22, maxSpan = 4, limit = 24 } = {}) {
    const S = tuning.length; const out = [];
    const rec = (i, s0, fr) => {
      if (out.length > 400) return;
      if (i === midis.length) { const f = fr.filter((x) => x > 0); const span = f.length ? Math.max(...f) - Math.min(...f) : 0; if (span <= maxSpan) out.push(fr.slice()); return; }
      for (let s = s0; s < S; s++) { const x = midis[i] - tuning[s]; if (x < 0 || x > maxFret) continue; fr[s] = x; rec(i + 1, s + 1, fr); fr[s] = -1; }
    };
    rec(0, 0, new Array(S).fill(-1));
    const stat = (fr) => { const f = fr.filter((x) => x > 0); const lo = f.length ? Math.min(...f) : 0, hi = f.length ? Math.max(...f) : 0; const used = fr.map((x, s) => (x >= 0 ? s : -1)).filter((s) => s >= 0); const gaps = used.length > 1 ? used[used.length - 1] - used[0] + 1 - used.length : 0; return (hi - lo) * 0.6 + lo * 0.06 + gaps * 1.2 + (hi > 15 ? 1 : 0); };
    return out.map((fr) => ({ fr, c: stat(fr) })).sort((a, b) => a.c - b.c).slice(0, limit);
  }
  // where the fretting hand can be for a fingering: the index finger anywhere from (highest fret - 3) to the lowest fret
  // (open strings don't pin it). Moving costs the distance between those windows.
  const handWin = (fr) => { const f = fr.filter((x) => x > 0); if (!f.length) return null; return [Math.max(1, Math.max(...f) - 3), Math.min(...f)]; };
  const winDist = (a, b) => (!a || !b ? 0 : Math.max(0, a[0] - b[1], b[0] - a[1]));
  const strs = (fr) => fr.map((x, s) => (x >= 0 ? s : -1)).filter((s) => s >= 0);
  function fret(evs, tuning) {
    if (!evs.length) return [];
    const cands = evs.map((e) => { let notes = e.notes.slice(); let f = fingerings(notes, tuning); while (!f.length && notes.length > 1) { notes = notes.slice(1); f = fingerings(notes, tuning); } return { notes, f }; });
    const N = evs.length; const cost = []; const back = [];
    cost[0] = cands[0].f.map((x) => x.c); back[0] = cands[0].f.map(() => -1);
    for (let i = 1; i < N; i++) {
      const gap = evs[i].t - (evs[i - 1].t + evs[i - 1].d); const relax = gap > 0.6 ? 0.3 : 1;   /* time to move between phrases */
      cost[i] = []; back[i] = [];
      const prev = cands[i - 1].f.length ? i - 1 : -1;
      cands[i].f.forEach((b) => {
        let best = Infinity, bj = 0; const wb = handWin(b.fr); const sb = strs(b.fr);
        (prev >= 0 ? cands[prev].f : [null]).forEach((a, j) => {
          if (a && !Number.isFinite(cost[prev][j])) return;
          let m = 0;
          if (a) { const d = winDist(handWin(a.fr), wb); m += d * 0.8 + (d > 3 ? 1.5 : 0); const sa = strs(a.fr); m += Math.abs(sa[0] - sb[0]) * 0.18 + Math.abs(sa[sa.length - 1] - sb[sb.length - 1]) * 0.12; }
          const c = (a ? cost[prev][j] : 0) + m * relax; if (c < best) { best = c; bj = j; }
        });
        cost[i].push(best + b.c); back[i].push(bj);
      });
      if (!cands[i].f.length) { cost[i] = cands[i - 1].f.map((_, j) => cost[i - 1][j]); back[i] = cands[i - 1].f.map((_, j) => j); cands[i].f = cands[i - 1].f.map((x) => ({ ...x, skip: true })); }
    }
    let j = 0; let bc = Infinity; (cost[N - 1] || []).forEach((c, k) => { if (c < bc) { bc = c; j = k; } });
    const pick = new Array(N);
    for (let i = N - 1; i >= 0; i--) { const c = cands[i].f[j]; pick[i] = c && !c.skip ? c.fr.slice() : null; j = back[i][j] != null && back[i][j] >= 0 ? back[i][j] : 0; }
    // the same note in the same stretch of music is played in the same place: a single note fretted differently from its
    // last appearance (within 4 s) moves there when that spot is inside the hand's reach of its neighbours
    const lastAt = new Map();
    for (let i = 0; i < N; i++) {
      const fr = pick[i]; if (!fr || cands[i].notes.length !== 1) continue; const m = cands[i].notes[0]; const L = lastAt.get(m);
      if (L && evs[i].t - L.t < 4) { const s0 = fr.findIndex((x) => x >= 0); if (s0 !== L.s) { const alt = new Array(fr.length).fill(-1); alt[L.s] = m - tuning[L.s];
        const near = [pick[i - 1], pick[i + 1]].filter(Boolean).map(handWin).filter(Boolean); const w = handWin(alt);
        if (alt[L.s] >= 0 && near.every((x) => winDist(x, w) <= 1)) pick[i] = alt; } }
      lastAt.set(m, { t: evs[i].t, s: pick[i].findIndex((x) => x >= 0) });
    }
    return pick.map((fr, i) => ({ fr, notes: cands[i].notes }));
  }
  const CHORD_TYPES = [['', [0, 4, 7]], ['m', [0, 3, 7]], ['5', [0, 7]], ['7', [0, 4, 7, 10]], ['m7', [0, 3, 7, 10]], ['maj7', [0, 4, 7, 11]], ['sus4', [0, 5, 7]], ['sus2', [0, 2, 7]], ['dim', [0, 3, 6]], ['add9', [0, 2, 4, 7]], ['6', [0, 4, 7, 9]], ['m6', [0, 3, 7, 9]], ['7sus4', [0, 5, 7, 10]], ['aug', [0, 4, 8]]];
  function chordName(midis, { flats = false } = {}) {
    const ns = [...new Set(midis)].sort((a, b) => a - b); if (ns.length < 2) return null; const pcs = new Set(ns.map(mod)); const bass = mod(ns[0]); const NM = flats ? FLAT : SHARP;
    if (pcs.size === 1) return null;
    let best = null;
    for (let r = 0; r < 12; r++) for (const [suf, iv] of CHORD_TYPES) {
      const tones = iv.map((i) => mod(r + i)); const hit = tones.filter((t) => pcs.has(t)).length; const extra = [...pcs].filter((p) => !tones.includes(p)).length;
      if (hit < Math.min(2, tones.length) || !pcs.has(r)) continue;
      const score = hit * 2 - extra * 1.6 - (tones.length - hit) * 1.2 + (r === bass ? 1.2 : 0) + (suf === '' || suf === 'm' ? 0.3 : suf === '5' ? 0.2 : 0);
      if (!best || score > best.score) best = { score, root: r, suf, tones };
    }
    if (!best) return null; const name = NM[best.root] + best.suf;
    return { name: best.root === bass ? name : `${name}/${NM[bass]}`, root: best.root, type: best.suf, tones: best.tones };
  }

  // ---------- the whole thing ----------
  // post: posteriors from nmp.js. Returns the tab events the app already understands:
  // { events: [{t, d, notes, frets, mono, conf, name?, inferred?}], notes, key, tuningCents, shift }
  function transcribe(post, { instrument = 'guitar', tuning = null, beats = null, key = null, sens = 1, tidyOpts = {} } = {}) {
    const tn = tuning || (instrument === 'bass' ? BASS : GUITAR);
    const raw = decode(post, { onsetThresh: 0.5 / sens, frameThresh: 0.3 / sens, minLen: 4, minMidi: tn[0] - 1, maxMidi: tn[tn.length - 1] + 24 });
    const cents = raw.slice(0, 400).map((n) => bendsCents(post, n)).sort((a, b) => a - b); const tuningCents = cents.length ? cents[cents.length >> 1] : 0;
    const notes = tidy(raw, post, { instrument, tuning: tn, beats, key, ...tidyOpts });
    const K = notes.key; const flats = K ? [5, 10, 3, 8, 1, 6].includes(K.minor ? mod(K.tonic + 3) : K.tonic) : false;
    const evs = events(notes); const fr = fret(evs, tn);
    const out = [];
    evs.forEach((e, i) => {
      const f = fr[i]; if (!f || !f.fr) return;
      const ev = { t: Math.round(e.t * 1000) / 1000, d: Math.round(e.d * 1000) / 1000, notes: f.notes, frets: f.fr, mono: f.notes.length === 1, conf: Math.round(Math.min(1, e.amp * 1.3) * 100) / 100 };
      { const pcs = new Set(f.notes.map(mod)); const lo = f.notes[0]; const power = pcs.size === 2 && f.notes.some((x) => mod(x - lo) === 7); if (pcs.size >= 3 || power) { const cn = chordName(f.notes, { flats }); if (cn) ev.name = cn.name; } }
      if (e.inferred) ev.inferred = true;
      out.push(ev);
    });
    return { events: out, notes: notes.map((n) => ({ t: n.t, d: n.d, n: n.midi, v: Math.round(n.amp * 100) / 100 })), key: K ? `${FLAT[K.tonic]}${K.minor ? 'm' : ''}` : null, tuningCents, shift: notes.shift || 0 };
  }
  return { decode, tidy, transcribe, events, fret, fingerings, chordName, keyFromNotes, parseKey, gridFor, frameTime, timeToFrame, evidence, FPS, SR, GUITAR, BASS };
});
