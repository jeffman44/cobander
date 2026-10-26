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
  function decode(post, { onsetThresh = 0.5, frameThresh = 0.3, minLen = 6, energyTol = 11, minMidi = 21, maxMidi = 108, inferOnsets = true, melodia = false } = {}) {
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
  // how far the whole recording sits off A=440, in cents (-50..50): the circular mean of where the pitch contour's energy
  // falls between the three 1/3-semitone bins of each semitone. A band tuned to itself 30-40 cents off makes the tracker
  // split every note between two keys; the reader re-runs it on audio declared at a corrected rate.
  function tuningOffset(post) {
    if (!post.contour) return 0; const C = 264; let sx = 0, sy = 0;
    for (let t = 0; t < post.T; t++) for (let b = 0; b < C; b++) { const v = post.contour[t * C + b]; if (v < 0.3) continue; const a = (2 * Math.PI * ((((b - 1) % 3) + 3) % 3)) / 3; sx += v * Math.cos(a); sy += v * Math.sin(a); }
    return sx || sy ? Math.round((Math.atan2(sy, sx) / (2 * Math.PI)) * 100) : 0;
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
        const score = err * (div === 3 ? (ons.length < 6 ? 2.2 : 1.35) : 1);   /* a few loose notes are not a triplet bar */
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
  function tidy(raw, post, { instrument = 'guitar', tuning = null, beats = null, key = null, minAmp = 0.3, overtone = 0.5, overtoneIv = [12, 19, 24, 28, 31], vote = true, keyFix = true, ghost = 0, magnet = false, chords = null, mag = null } = {}) {
    const tn = tuning || (instrument === 'bass' ? BASS : GUITAR); const voice = instrument === 'voice'; const lowM = voice ? 36 : tn[0], highM = voice ? 84 : tn[tn.length - 1] + (instrument === 'bass' ? 21 : 22);
    let notes = raw.filter((n) => n.midi >= lowM && n.midi <= highM && (n.amp >= minAmp || (n.weak && n.amp >= 0.12))).map((n) => ({ ...n, t: frameTime(n.f0), d: frameTime(n.f1) - frameTime(n.f0) }));
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
    const monoAround = (n) => { const w = 0.7 * FPS; let near = notes.filter((m) => Math.abs(m.f0 - n.f0) > 3 && Math.abs(m.f0 - n.f0) < w); if (near.length < 3) near = notes.filter((m) => Math.abs(m.f0 - n.f0) > 3 && Math.abs(m.f0 - n.f0) < 4 * w); if (near.length < 2) return 0.5; const ms = near.slice().sort((x, y) => x.f0 - y.f0); const groups = []; for (const m of ms) { const g = groups[groups.length - 1]; if (g && m.f0 - g.first <= 7) g.ms.push(m.midi); else groups.push({ first: m.f0, ms: [m.midi] }); } const chordal = (g) => { const lo = Math.min(...g.ms); return g.ms.some((x) => x !== lo && !overtoneIv.includes(x - lo)); }; return groups.filter((g) => !chordal(g)).length / groups.length; };
    // a weaker note at an overtone of a note that is still ringing (it started earlier) in a single-note line: the string's
    // own overtone, picked up late
    const ringingUnder = (n) => notes.find((m) => m !== n && overtoneIv.includes(n.midi - m.midi) && m.f0 < n.f0 - 3 && m.f1 >= n.f0 + 2 && n.amp < ghost * m.amp);
    { const drop = new Set();
      for (const n of notes) { if (ghost && instrument !== 'bass' && ringingUnder(n) && monoAround(n) >= 0.5) { drop.add(n); continue; } const m = partnerOf(n); if (!m) continue;
        if (n.amp < overtone * m.amp) { drop.add(n); continue; }
        if (instrument === 'bass' || voice || monoAround(n) >= 0.6) drop.add(n.amp <= 1.4 * m.amp ? n : m);   /* one of the two is the other's shadow: keep the louder (a much louder upper note means the low one was a distortion sub-tone) */ }
      notes = notes.filter((n) => !drop.has(n)); }
    // a bass is (nearly always) one note at a time: keep the strongest of notes struck together
    if (instrument === 'bass') notes = notes.filter((n) => !notes.some((m) => m !== n && Math.abs(m.f0 - n.f0) <= 3 && (m.amp > n.amp || (m.amp === n.amp && m.midi < n.midi))));
    // a voice sings one note at a time: where two overlap, the stronger one holds that stretch
    if (voice) { notes.sort((a, b) => b.amp - a.amp); const kept = []; for (const n of notes) { if (kept.some((m) => Math.min(m.f1, n.f1) - Math.max(m.f0, n.f0) > 0.5 * Math.min(m.f1 - m.f0, n.f1 - n.f0))) continue; kept.push(n); } notes = kept.sort((a, b) => a.f0 - b.f0); }
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
    const G = beats && beats.length > 2 ? gridFor(notes, beats) : null; let sh = 0;
    if (G) {
      sh = gridShift(notes, G.slots); const S = G.slots;
      // notes struck together (a strum, a chord the tracker heard a few ms apart) snap as one: to the slot nearest their mean
      const byT = notes.slice().sort((a, b) => a.t - b.t); const at = new Map(); const gw = Math.min(0.07, 0.8 * (S.length > 1 ? S[1].t - S[0].t : 0.1));
      for (let i = 0; i < byT.length;) { let k = i + 1; while (k < byT.length && byT[k].t - byT[i].t < gw && (byT[k].t - byT[i].t < 0.035 || byT.slice(i, k).every((o) => o.t + o.d > byT[k].t + 0.03 && o.midi !== byT[k].midi))) k++; const g = byT.slice(i, k); const m = g.reduce((x, n) => x + n.t, 0) / g.length; for (const n of g) at.set(n, m); i = k; }
      for (const n of notes) {
        const tn = at.get(n); const j = nearestSlot(S, tn - sh); const off = Math.abs(S[j].t - (tn - sh)); const step = j + 1 < S.length ? S[j + 1].t - S[j].t : S[j].t - S[j - 1].t;
        if (off <= step * 0.55) { const end = n.t + n.d - sh; const je = Math.max(j + 1, nearestSlot(S, end)); n.slot = j; n.t = S[j].t; n.d = Math.max(step * 0.9, (je < S.length ? S[je].t : end) - S[j].t); }
      }
      notes.shift = sh;
      // same pitch on the same slot twice (a re-trigger the tracker split): one note
      const seen = new Map(); notes = notes.filter((n) => { if (n.slot == null) return true; const k = `${n.slot}:${n.midi}`; const o = seen.get(k); if (o) { o.amp = Math.max(o.amp, n.amp); o.d = Math.max(o.d, n.d); return false; } seen.set(k, n); return true; });
      if (vote) notes = patternVote(notes, post, G, sh);
    }
    if (magnet) notes = magnetize(notes, post, { instrument, key: K, inKey, chords, G, sh, W: { ...(MAG[instrument] || MAG.guitar), ...(mag || {}) }, lowM, highM });
    notes.key = K; notes.shift = sh; return notes.sort((a, b) => a.t - b.t || a.midi - b.midi);
  }
  // ---------- the magnet ----------
  // Every note is re-decided by one score: how strongly the audio shows each candidate pitch (the note as heard, the
  // semitone either side, the octave either side), plus pulls toward what the music makes likely — in the key, a tone of
  // the chord sounding there, the pitch the other passes of a repeated bar put on that beat. A confident note outside
  // the key keeps its pitch (the audio outweighs the pulls); a shaky one goes where the music points, or goes away when
  // nothing backs it. The pull strengths differ per part: a bass leans on chord roots, a voice on the key.
  const MAG = {
    guitar: { key: 0.1, chord: 0.05, root: 0.3, pattern: 1.15, octave: 1.35, keep: -2.35, keepWeak: 0.13 },   // tuned on GuitarSet run through an amp
    bass: { key: 0.35, chord: 0.5, root: 0.45, pattern: 0.6, octave: 0.6, keep: -1.45, keepWeak: -0.6 },
    voice: { key: 0.8, chord: 0.25, root: 0, pattern: 0.6, octave: 0.9, keep: -1.7, keepWeak: -0.6 },
  };
  const SUF = { '': [0, 4, 7], m: [0, 3, 7], 5: [0, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus2: [0, 2, 7], sus: [0, 5, 7], dim: [0, 3, 6], aug: [0, 4, 8], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], add9: [0, 2, 4, 7], 9: [0, 2, 4, 7, 10], m9: [0, 2, 3, 7, 10], '7sus4': [0, 5, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9] };
  function chordTones(name) {
    const m = /^([A-G][b#]?)([^/]*)(?:\/([A-G][b#]?))?$/.exec(String(name || '').trim()); if (!m || PCS[m[1]] == null) return null;
    const r = PCS[m[1]]; const iv = SUF[m[2]] || SUF[m[2].replace(/^min/, 'm').replace(/^maj$/, '')] || (/^m(?!aj)/.test(m[2]) ? SUF.m : SUF['']);
    return { root: r, tones: new Set(iv.map((i) => mod(r + i))), bass: m[3] && PCS[m[3]] != null ? PCS[m[3]] : r };
  }
  function magnetize(notes, post, { instrument, key, inKey, chords, G, sh, W, lowM, highM }) {
    if (!notes.length) return notes;
    const shift = sh || 0; const fr = (n) => [timeToFrame(n.t + shift), Math.max(timeToFrame(n.t + shift) + 2, timeToFrame(n.t + n.d + shift))];
    const evOf = (m, n) => { if (m < lowM || m > highM) return 0; const [a, b] = n.slot != null ? fr(n) : [n.f0, n.f1]; return Math.max(evidence(post, m, a, b), 0.8 * onsetEvidence(post, m, a)); };
    // the harmony at a time: the song's chord lane when given, else the pitch classes the other notes ring around it
    const lane = (chords || []).map((c) => ({ t: c.time != null ? c.time : c.t, ...chordTones(c.chord || c.name) })).filter((c) => c.tones).sort((a, b) => a.t - b.t);
    const laneAt = (t) => { let c = null; for (const x of lane) { if (x.t <= t + 0.02) c = x; else break; } return c; };
    const heardAt = (n) => { const w = new Array(12).fill(0); for (const m of notes) { if (m === n) continue; const o = Math.min(n.t + n.d, m.t + m.d) - Math.max(n.t - 0.25, m.t); if (o > 0) w[mod(m.midi)] += o * (m.amp || 0.5); } const tot = w.reduce((x, y) => x + y, 0); if (!tot) return null; const top = w.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).filter(([v]) => v >= 0.18 * tot).slice(0, 4).map(([, i]) => i); return { tones: new Set(top), root: null }; };
    // what the repeated bars agree on, per relative slot
    let agreed = null;
    if (G) {
      const first = new Map(); G.slots.forEach((s2, i) => { if (!first.has(s2.bar)) first.set(s2.bar, i); });
      const byBar = new Map(); for (const n of notes) if (n.slot != null) { const b = G.slots[n.slot].bar; if (!byBar.has(b)) byBar.set(b, []); byBar.get(b).push(n); }
      const rel = (n) => n.slot - first.get(G.slots[n.slot].bar);
      const bars = [...byBar.keys()]; const sig = (b) => new Set(byBar.get(b).map((n) => `${rel(n)}:${mod(n.midi)}`));
      const sim = (a, b) => { const A = sig(a), B = sig(b); let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i || 1); };
      agreed = new Map();
      for (const b of bars) { const group = bars.filter((o) => o === b || sim(o, b) >= 0.4); if (group.length < 3) continue; const cnt = new Map(); for (const o of group) for (const n of byBar.get(o)) { const k = `${rel(n)}:${n.midi}`; cnt.set(k, (cnt.get(k) || 0) + 1); } for (const n of byBar.get(b)) agreed.set(n, (m) => (cnt.get(`${rel(n)}:${m}`) || 0) / group.length); }
    }
    const out = [];
    for (const n of notes) {
      const h = lane.length ? laneAt(n.t) : heardAt(n);
      const pat = agreed && agreed.get(n);
      const cands = [n.midi, n.midi - 1, n.midi + 1, n.midi - 12, n.midi + 12];
      let best = null;
      for (const c of cands) {
        const ev = c === n.midi ? Math.max(n.amp, evOf(c, n)) : evOf(c, n); if (ev <= 0.02) continue;
        let sc = Math.log(ev);
        if (inKey) sc += inKey.has(mod(c)) ? W.key : 0;
        if (h) { if (h.tones.has(mod(c))) sc += W.chord; if (h.root != null && mod(c) === h.root) sc += W.root; }
        if (pat) sc += W.pattern * pat(c);
        if (Math.abs(c - n.midi) === 12) sc -= W.octave;   /* an octave move needs the music clearly behind it */
        if (!best || sc > best.sc) best = { c, sc, ev };
      }
      if (!best || (best.sc < (n.weak ? W.keepWeak : W.keep) && !n.inferred)) continue;   /* nothing the music or the audio stands behind (a faint note needs the music clearly behind it) */
      out.push(best.c === n.midi ? n : { ...n, midi: best.c, movedFrom: n.midi });
    }
    // two notes landing on the same pitch at the same moment: one
    const seen = new Map(); return out.filter((n) => { const k = `${n.slot != null ? n.slot : Math.round(n.t * 50)}:${n.midi}`; if (seen.has(k)) { const o = seen.get(k); o.amp = Math.max(o.amp, n.amp); return false; } seen.set(k, n); return true; });
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
    for (const n of sorted) { const e = out[out.length - 1]; if (e && (n.slot != null && e.slot != null ? n.slot === e.slot : Math.abs(n.t - e.t) < 0.03) && !e.notes.includes(n.midi)) { e.notes.push(n.midi); e.amps[n.midi] = n.amp; e.d = Math.max(e.d, n.d); e.amp = Math.max(e.amp, n.amp); e.inferred = e.inferred && n.inferred; continue; } out.push({ t: n.t, d: n.d, notes: [n.midi], amps: { [n.midi]: n.amp }, slot: n.slot, amp: n.amp, inferred: !!n.inferred }); }
    for (const e of out) e.notes.sort((a, b) => a - b);
    return out;
  }
  // Through distortion the tracker loses parts of a power chord: the root under its fifth and octave, or the fifth and
  // octave over a loud root. In a part built on power chords (a third of its events hold a fifth or a fourth), an event
  // of one or two notes that is part of one is completed — root, fifth, octave — wherever the recording backs the missing
  // note (its note evidence over the event and an attack at its start). A fourth on top stays as played when the root
  // under it isn't there: it may be an inverted fifth.
  // how distorted the guitar sounds, as the tracker hears it: while a note is clearly sounding, how many other keys sit just
  // above the posterior floor (0.1-0.3). Clean / mic'd guitar ~30, crunch and high gain ~38-46 (GuitarSet through amps,
  // real band takes).
  function haze(post) {
    let act = 0, h = 0;
    for (let t = 0; t < post.T; t++) { let strong = 0, mid = 0; for (let p = 15; p < 70; p++) { const v = post.note[t * NP + p]; if (v > 0.3) strong++; else if (v > 0.1) mid++; } if (strong) { act++; h += mid; } }
    return act ? h / act : 0;
  }
  function powerRoots(evs, post, lo, { ev = 0.22, on = 0.15, fill = 0.12, fillOn = 0.08 } = {}) {
    const pc = (e) => e.notes.some((x, i) => e.notes.slice(i + 1).some((y) => y - x === 7 || y - x === 5));
    const share = evs.length ? evs.filter(pc).length / evs.length : 0; let n = 0;
    const add = (e, m) => { if (e.notes.includes(m)) return; e.notes.push(m); e.notes.sort((x, y) => x - y); e.amps = e.amps || {}; e.amps[m] = Math.min(...Object.values(e.amps).concat([0.5])); e.rooted = true; n++; };
    for (const e of evs) {
      if (e.notes.length > 3) continue; const f0 = timeToFrame(e.t), f1 = Math.max(f0 + 2, timeToFrame(e.t + e.d));
      const backed = (m, a, b) => m >= lo && evidence(post, m, f0, f1) >= a && onsetEvidence(post, m, f0) >= b;
      const [x, y] = e.notes;
      if (y != null && y - x === 5) { if (backed(x - 7, ev, on)) add(e, x - 7); continue; }
      if (share < 0.33) continue;
      let r = null; if (y == null && backed(x - 7, ev, on)) { add(e, x - 7); r = x - 7; } else if (y == null && x < 52) r = x; else if (y != null && (y - x === 7 || y - x === 12)) r = x;
      if (r == null) continue;
      for (const m of [r + 7, r + 12]) if (backed(m, fill, fillOn)) add(e, m);
    }
    return n;
  }
  // every playable way to fret an event: one note per string, strings in pitch order, a span a hand can hold
  const FW = { low: 0.04, move: 1.5, jump: 3, strLo: 0.15, strHi: 0.1, span: 0.3, high: 0.3, relax: 0.3 };
  function fingerings(midis, tuning, { maxFret = 22, maxSpan = 4, limit = 24 } = {}) {
    const S = tuning.length; const out = [];
    const rec = (i, s0, fr) => {
      if (out.length > 400) return;
      if (i === midis.length) { const f = fr.filter((x) => x > 0); const span = f.length ? Math.max(...f) - Math.min(...f) : 0; if (span <= maxSpan) out.push(fr.slice()); return; }
      for (let s = s0; s < S; s++) { const x = midis[i] - tuning[s]; if (x < 0 || x > maxFret) continue; fr[s] = x; rec(i + 1, s + 1, fr); fr[s] = -1; }
    };
    rec(0, 0, new Array(S).fill(-1));
    const stat = (fr) => { const f = fr.filter((x) => x > 0); const lo = f.length ? Math.min(...f) : 0, hi = f.length ? Math.max(...f) : 0; const used = fr.map((x, s) => (x >= 0 ? s : -1)).filter((s) => s >= 0); const gaps = used.length > 1 ? used[used.length - 1] - used[0] + 1 - used.length : 0; return (hi - lo) * FW.span + lo * FW.low + gaps * 1.2 + (hi > 15 ? FW.high : 0); };
    return out.map((fr) => ({ fr, c: stat(fr) })).sort((a, b) => a.c - b.c).slice(0, limit);
  }
  // where the fretting hand can be for a fingering: the index finger anywhere from (highest fret - 3) to the lowest fret
  // (open strings don't pin it). Moving costs the distance between those windows.
  const handWin = (fr) => { const f = fr.filter((x) => x > 0); if (!f.length) return null; return [Math.max(1, Math.max(...f) - 3), Math.min(...f)]; };
  const winDist = (a, b) => (!a || !b ? 0 : Math.max(0, a[0] - b[1], b[0] - a[1]));
  const strs = (fr) => fr.map((x, s) => (x >= 0 ? s : -1)).filter((s) => s >= 0);
  // ---------- chord shapes ----------
  // Strummed chords are nearly always one of a short list of shapes: the open chords, power chords, and the E- and
  // A-string barre shapes moved up the neck. A strum is matched against every shape (and the low or high part of it —
  // nobody hits all six strings every time) by how strongly the audio shows each of the shape's notes; when one fits
  // well, the strum is written as that shape: missing strings filled in, stray overtones gone.
  const OPEN_SHAPES = ['x32010', 'x02220', '320003', '320033', '022100', 'xx0232', 'x02210', '022000', 'xx0231', '020100', 'x02020', 'xx0212', '320001', 'x32310', 'x21202', 'x32000', 'xx3210', 'x02200', 'x02230', 'xx0230', 'xx0233', 'x32033', '022030', 'x02010', '133211', '022xxx', 'x022xx', 'xx023x', '002xxx', 'x002xx'];
  const MOVE_SHAPES = [[0, 2, 2, 1, 0, 0], [0, 2, 2, 0, 0, 0], [0, 2, 0, 1, 0, 0], [0, 2, 0, 0, 0, 0], [-1, 0, 2, 2, 2, 0], [-1, 0, 2, 2, 1, 0], [-1, 0, 2, 0, 2, 0], [-1, 0, 2, 0, 1, 0], [0, 2, 2, -1, -1, -1], [0, 2, -1, -1, -1, -1], [-1, 0, 2, 2, -1, -1], [-1, 0, 2, -1, -1, -1], [-1, -1, 0, 2, 3, -1], [-1, -1, 0, 2, -1, -1]];
  let SHAPES = null;
  function shapeList(tuning) {
    if (SHAPES && SHAPES.tn === tuning.join()) return SHAPES;
    const base = OPEN_SHAPES.map((s2) => [...s2].map((c) => (c === 'x' ? -1 : Number(c))));
    for (let r = 1; r <= 12; r++) for (const m of MOVE_SHAPES) base.push(m.map((f) => (f < 0 ? -1 : f + r)));
    const out = []; const seen = new Set();
    const add = (fr) => { const k = fr.join(','); if (seen.has(k)) return; const notes = fr.map((f, i) => (f >= 0 ? tuning[i] + f : null)).filter((x) => x != null); if (notes.length < 2) return; seen.add(k); out.push({ fr, notes, lo: Math.min(...fr.filter((f) => f > 0).concat([99])) }); };
    for (const fr of base) { add(fr); const used = fr.map((f, i) => (f >= 0 ? i : -1)).filter((i) => i >= 0);
      for (let k = 3; k < used.length; k++) { add(fr.map((f, i) => (used.slice(0, k).includes(i) ? f : -1))); add(fr.map((f, i) => (used.slice(-k).includes(i) ? f : -1))); } }
    SHAPES = out; SHAPES.tn = tuning.join(); return out;
  }
  function snapShapes(evs, post, { tuning, shift = 0, minFit = 0.32 } = {}) {
    const L = shapeList(tuning);
    for (const e of evs) {
      if (e.notes.length < 3) continue;
      const f0 = timeToFrame(e.t + shift), f1 = f0 + Math.max(4, Math.round(Math.min(e.d, 0.4) * FPS));
      const cache = new Map(); const ev = (m) => { if (!cache.has(m)) cache.set(m, evidence(post, m, f0, f1)); return cache.get(m); };
      const heard = e.notes; const pcs = new Set(heard.map(mod)); const bass = heard[0];
      const asHeard = heard.reduce((a, m) => a + ev(m), 0) / heard.length;
      let best = null;
      for (const sh of L) {
        if (sh.notes[0] !== bass && sh.notes[0] !== bass - 12 && sh.notes[0] !== bass + 12) continue;   /* the bass note decides the shape family */
        const spc = new Set(sh.notes.map(mod)); let cover = 0; for (const p of pcs) if (spc.has(p)) cover++; if (cover < pcs.size - 1 || cover < 2) continue;
        let sum = 0, weak = 0; for (const m of sh.notes) { const v = ev(m); sum += v; if (v < 0.12) weak++; }
        const fit = sum / sh.notes.length - weak * 0.08 - (pcs.size - cover) * 0.1 + Math.min(sh.notes.length, 5) * 0.012 - (sh.lo < 99 ? sh.lo * 0.004 : 0);
        if (!best || fit > best.fit) best = { sh, fit };
      }
      if (best && best.fit >= minFit && best.fit >= asHeard - 0.08) { e.notes = best.sh.notes.slice().sort((a, b) => a - b); e.shape = best.sh.fr.slice(); e.shaped = true; }
    }
    return evs;
  }
  function fret(evs, tuning) {
    if (!evs.length) return [];
    // more notes than a hand can fret (or than there are strings): let go of the weakest first — a doubled pitch class
    // before a chord's only copy of a tone, the bass note last
    const cands = evs.map((e) => {
      if (e.shape) return { notes: e.notes.slice(), f: [{ fr: e.shape.slice(), c: 0 }] };   /* a chord shape the strum was matched to */
      let notes = e.notes.slice(); const amp = (m) => (e.amps && e.amps[m] != null ? e.amps[m] : 0.5);
      let f = notes.length <= tuning.length ? fingerings(notes, tuning) : [];
      while (!f.length && notes.length > 1) {
        const pcCount = (m) => notes.filter((x) => mod(x) === mod(m)).length;
        const shadow = (m) => notes.some((x) => [12, 19, 24, 28, 31].includes(m - x)); const keep = (m) => amp(m) + (pcCount(m) > 1 ? 0 : 0.12) - (shadow(m) && m - notes[0] > 24 ? 0.3 : 0); const order = notes.slice(1).sort((a, b) => keep(a) - keep(b) || b - a);
        notes = notes.filter((x) => x !== order[0]); f = notes.length <= tuning.length ? fingerings(notes, tuning) : [];
      }
      return { notes, f };
    });
    // The hand is tracked along each path as the range of index-finger positions that still reach every note since its
    // last shift (an open string fits anywhere); a note outside that range is a shift, costed by how far it is.
    const N = evs.length; const cost = []; const back = []; const win = [];
    cost[0] = cands[0].f.map((x) => x.c); back[0] = cands[0].f.map(() => -1); win[0] = cands[0].f.map((x) => handWin(x.fr));
    for (let i = 1; i < N; i++) {
      const gap = evs[i].t - (evs[i - 1].t + evs[i - 1].d); const relax = gap > 0.6 ? FW.relax : 1;   /* time to move between phrases */
      cost[i] = []; back[i] = []; win[i] = [];
      const prev = cands[i - 1].f.length ? i - 1 : -1;
      cands[i].f.forEach((b) => {
        let best = Infinity, bj = 0, bw = null; const wb = handWin(b.fr); const sb = strs(b.fr);
        (prev >= 0 ? cands[prev].f : [null]).forEach((a, j) => {
          if (a && !Number.isFinite(cost[prev][j])) return;
          let m = 0; let w = wb;
          if (a) {
            const wa = win[prev][j];
            if (!wa) w = wb; else if (!wb) w = wa;
            else { const lo = Math.max(wa[0], wb[0]), hi = Math.min(wa[1], wb[1]); if (lo <= hi) w = [lo, hi]; else { const d = winDist(wa, wb); m += d * FW.move + (d > 3 ? FW.jump : 0); w = wb; } }
            const sa = strs(a.fr); m += Math.abs(sa[0] - sb[0]) * FW.strLo + Math.abs(sa[sa.length - 1] - sb[sb.length - 1]) * FW.strHi;
          }
          const c = (a ? cost[prev][j] : 0) + m * relax; if (c < best) { best = c; bj = j; bw = gap > 0.6 ? wb : w; }
        });
        cost[i].push(best + b.c); back[i].push(bj); win[i].push(bw);
      });
      if (!cands[i].f.length) { cost[i] = cands[i - 1].f.map((_, j) => cost[i - 1][j]); back[i] = cands[i - 1].f.map((_, j) => j); win[i] = win[i - 1].slice(); cands[i].f = cands[i - 1].f.map((x) => ({ ...x, skip: true })); }
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

  // ---------- singing ----------
  // A voice is one note at a time, so its ears are the single-pitch tracker (pitchcheck.js), not the note model. What a
  // singer meant is then decided the same way: the held pitch (vibrato and the scoop into a note averaged out), pulled to
  // the nearest note in the key when it sits between two, and onto the beat grid. A note broken by a breath-catch or a
  // vibrato dip is joined back up.
  // pitch-track points [{t, midi (NaN = unvoiced), rms}] → sung segments, by a Viterbi pass over semitones: each 10 ms
  // frame is scored by how far its pitch is from each semitone (a wide tolerance, so vibrato and scoops stay inside one
  // note), plus a pull to the key; changing note costs a little, so a note changes only when the singer moves and stays.
  function sungSegments(pts, { key = null, sw = 10, keyPull = 0.35 } = {}) {
    const K = parseKey(key); const inKey = K ? scaleOf(K) : null; const out = []; let run = [];
    const flush = () => {
      if (run.length < 4) { run = []; return; }
      const ms = run.map((p) => p.midi); const lo = Math.floor(Math.min(...ms)) - 1, hi = Math.ceil(Math.max(...ms)) + 1; const S = hi - lo + 1;
      const cost = (p, s2) => { const d = p.midi - (lo + s2); return (d * d) / 1.5 - (inKey && inKey.has(mod(lo + s2)) ? keyPull : 0); };
      let prev = new Float64Array(S); for (let s2 = 0; s2 < S; s2++) prev[s2] = cost(run[0], s2); const back = [];
      for (let i = 1; i < run.length; i++) { const cur = new Float64Array(S), bk = new Int16Array(S); let bi = 0; for (let s2 = 1; s2 < S; s2++) if (prev[s2] < prev[bi]) bi = s2; for (let s2 = 0; s2 < S; s2++) { const stay = prev[s2], move = prev[bi] + sw; cur[s2] = Math.min(stay, move) + cost(run[i], s2); bk[s2] = stay <= move ? s2 : bi; } back.push(bk); prev = cur; }
      let s2 = 0; for (let k = 1; k < S; k++) if (prev[k] < prev[s2]) s2 = k; const path = new Array(run.length); path[run.length - 1] = s2; for (let i = run.length - 1; i > 0; i--) { s2 = back[i - 1][s2]; path[i - 1] = s2; }
      let a = 0; for (let i = 1; i <= run.length; i++) if (i === run.length || path[i] !== path[a]) { const seg = run.slice(a, i); const hop = run.length > 1 ? run[1].t - run[0].t : 0.01; const vals = seg.map((p) => p.midi).sort((x, y) => x - y); out.push({ t0: seg[0].t - hop / 2, t1: seg[seg.length - 1].t + hop / 2, midi: vals[vals.length >> 1], q: lo + path[a] }); a = i; }
      run = [];
    };
    for (const p of pts) { if (Number.isFinite(p.midi)) run.push(p); else flush(); }
    flush(); return out;
  }
  function fromSung(sung, { beats = null, key = null, chords = null, minDur = 0.08 } = {}) {
    if (sung && sung.length && sung[0].t != null && sung[0].t0 == null) sung = sungSegments(sung, { key });   /* raw pitch-track points */
    const K = parseKey(key); const inKey = K ? scaleOf(K) : null;
    const lane = (chords || []).map((c) => ({ t: c.time != null ? c.time : c.t, ...chordTones(c.chord || c.name) })).filter((c) => c.tones).sort((a, b) => a.t - b.t);
    const chordAt = (t) => { let c = null; for (const x of lane) { if (x.t <= t + 0.02) c = x; else break; } return c; };
    const segs = (sung || []).filter((x) => Number.isFinite(x.midi)).map((x) => ({ t0: x.t0, t1: x.t1, midi: x.midi, q: x.q })).sort((a, b) => a.t0 - b.t0);
    const joined = []; for (const x of segs) { const p = joined[joined.length - 1]; if (p && x.t0 - p.t1 < 0.09 && (x.q != null ? x.q === p.q : Math.abs(x.midi - p.midi) < 0.6)) { const w0 = p.t1 - p.t0, w1 = x.t1 - x.t0; p.midi = (p.midi * w0 + x.midi * w1) / (w0 + w1); p.t1 = x.t1; } else joined.push({ ...x }); }
    let notes = joined.filter((x) => x.t1 - x.t0 >= minDur).map((x) => {
      const c0 = Math.floor(x.midi), c1 = c0 + 1; const h = chordAt((x.t0 + x.t1) / 2);
      const sc = (c) => -Math.abs(x.midi - c) * 2.2 + (inKey && inKey.has(mod(c)) ? 0.6 : 0) + (h && h.tones.has(mod(c)) ? 0.25 : 0);
      const n = x.q != null ? x.q : sc(c0) >= sc(c1) ? c0 : c1;
      return { t: x.t0, d: x.t1 - x.t0, midi: n, amp: 0.8, cents: Math.round((x.midi - n) * 100) };
    });
    if (beats && beats.length > 2) {
      const G = gridFor(notes, beats); const S = G.slots; const sh = gridShift(notes, S);
      for (const n of notes) { const j = nearestSlot(S, n.t - sh); const step = j + 1 < S.length ? S[j + 1].t - S[j].t : S[j].t - S[j - 1].t; if (Math.abs(S[j].t - (n.t - sh)) > 0.55 * step) continue; const je = Math.max(j + 1, nearestSlot(S, n.t + n.d - sh)); n.t = S[j].t; n.d = Math.max(step, (je < S.length ? S[je].t : n.t + n.d) - S[j].t); n.slot = j; }
      const seen = new Map(); notes = notes.filter((n) => { if (n.slot == null) return true; const o = seen.get(n.slot); if (o) { if (n.d > o.d) Object.assign(o, n); return false; } seen.set(n.slot, n); return true; });
      for (let i = 0; i + 1 < notes.length; i++) if (notes[i].t + notes[i].d > notes[i + 1].t) notes[i].d = Math.max(0.05, notes[i + 1].t - notes[i].t);
    }
    return { notes: notes.map((n) => ({ t: Math.round(n.t * 1000) / 1000, d: Math.round(n.d * 1000) / 1000, n: n.midi, v: 0.8, cents: n.cents })), key: K ? `${FLAT[K.tonic]}${K.minor ? 'm' : ''}` : null };
  }

  // ---------- the whole thing ----------
  // post: posteriors from nmp.js. Returns the tab events the app already understands:
  // { events: [{t, d, notes, frets, mono, conf, name?, inferred?}], notes, key, tuningCents, shift }
  function transcribe(post, { instrument = 'guitar', tuning = null, beats = null, key = null, chords = null, sens = 1, tidyOpts = {}, decodeOpts = {}, shapes = false, loose = null } = {}) {
    const tn = tuning || (instrument === 'bass' ? BASS : GUITAR);
    const dopt = instrument === 'voice' ? { onsetThresh: 0.45 / sens, frameThresh: 0.3 / sens, minLen: 7, minMidi: 36, maxMidi: 84, ...decodeOpts } : { onsetThresh: 0.6 / sens, frameThresh: 0.3 / sens, minLen: 4, minMidi: tn[0] - 1, maxMidi: tn[tn.length - 1] + 24, ...decodeOpts };
    const raw = decode(post, dopt);
    // the faint notes too (a strum through distortion buries the inner strings): they only survive if the music backs them
    if (loose) { const L = decode(post, { ...dopt, onsetThresh: loose.onset, frameThresh: loose.frame }); for (const n of L) if (!raw.some((m) => m.midi === n.midi && Math.abs(m.f0 - n.f0) <= 4)) raw.push({ ...n, weak: true }); }
    const cents = raw.slice(0, 400).map((n) => bendsCents(post, n)).sort((a, b) => a - b); const tuningCents = cents.length ? cents[cents.length >> 1] : 0;
    const notes = tidy(raw, post, { instrument, tuning: tn, beats, key, chords, ...tidyOpts });
    const K = notes.key; const flats = K ? [5, 10, 3, 8, 1, 6].includes(K.minor ? mod(K.tonic + 3) : K.tonic) : false;
    const evs = events(notes); const hz = haze(post); if (instrument !== 'bass' && instrument !== 'voice' && tidyOpts.powerRoots !== false && (hz >= 37 || tidyOpts.powerRoots === true)) powerRoots(evs, post, tn[0]); if (shapes && instrument !== 'bass' && instrument !== 'voice') snapShapes(evs, post, { tuning: tn, shift: notes.shift || 0 }); const fr = fret(evs, tn);
    const out = [];
    evs.forEach((e, i) => {
      const f = fr[i]; if (!f || !f.fr) return;
      const ev = { t: Math.round(e.t * 1000) / 1000, d: Math.round(e.d * 1000) / 1000, notes: f.notes, frets: f.fr, mono: f.notes.length === 1, conf: Math.round(Math.min(1, e.amp * 1.3) * 100) / 100 };
      { const pcs = new Set(f.notes.map(mod)); const lo = f.notes[0]; const power = pcs.size === 2 && f.notes.some((x) => mod(x - lo) === 7); if (pcs.size >= 3 || power) { const cn = chordName(f.notes, { flats }); if (cn) ev.name = cn.name; } }
      if (e.inferred) ev.inferred = true;
      out.push(ev);
    });
    const flat = evs.some((e) => e.shaped) ? [] : notes.map((n) => ({ t: n.t, d: n.d, n: n.midi, v: Math.round(n.amp * 100) / 100 })); if (!flat.length) evs.forEach((e) => { for (const m of e.notes) flat.push({ t: e.t, d: e.d, n: m, v: Math.round(((e.amps && e.amps[m]) || e.amp || 0.5) * 100) / 100 }); });
    return { events: out, notes: flat, key: K ? `${FLAT[K.tonic]}${K.minor ? 'm' : ''}` : null, tuningCents, shift: notes.shift || 0 };
  }
  return { FW, MAG, tuningOffset, haze, powerRoots, chordTones, magnetize, fromSung, sungSegments, decode, tidy, transcribe, events, fret, fingerings, chordName, keyFromNotes, parseKey, gridFor, frameTime, timeToFrame, evidence, FPS, SR, GUITAR, BASS };
});
