// Riff generator: a repeating rhythmic motif on a small pool of in-key notes (e.g. 1/8 notes for 4 measures using
// 3 different notes), optionally following the chord lane and played as power chords. Pure (unit-testable in node).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPRiff = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  function parseKey(k) { const m = /^([A-G](?:#|b)?)(m?)/.exec(String(k || '').trim()); if (!m || PC[m[1]] == null) return { pc: 0, minor: false }; return { pc: PC[m[1]], minor: !!m[2] }; }
  function chordRoot(ch) { const m = /^([A-G](?:#|b)?)/.exec(String(ch || '')); return m && PC[m[1]] != null ? PC[m[1]] : null; }
  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const mod = (n, m) => ((n % m) + m) % m;

  // rate = notes per beat: 1 = 1/4, 2 = 1/8, 4 = 1/16, 3 = 1/8 triplets, 6 = 1/16 triplets, 0.5 = 1/2
  //   opts: { seconds, bpm, timeSig, rate, notes (distinct pitches, 1–7), key, low (lowest MIDI note), density 0..1,
  //           sync 0..1 (syncopation), gate 0..1 (note length: 0.2 = chug, 1 = legato), power (bool), follow (chordAt(sec)),
  //           motifBars (1|2), seed, rhythm?, pitches? }   → { notes, rhythm, pitches, seed }
  function generate(opts) {
    const bpm = Number(opts.bpm) || 120, beat = 60 / bpm, bpb = (opts.timeSig && opts.timeSig[0]) || 4;
    const rate = Number(opts.rate) || 2, stepT = beat / rate, perBar = Math.max(1, Math.round(bpb * rate));
    const seconds = Math.max(stepT, Number(opts.seconds) || beat * bpb * 4); const total = Math.max(1, Math.floor(seconds / stepT + 1e-6));
    const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : (Math.random() * 2 ** 32) >>> 0; const r = rng(seed);
    const density = opts.density == null ? 0.7 : Math.max(0.05, Math.min(1, opts.density)), sync = Math.max(0, Math.min(1, opts.sync || 0));
    const motifLen = Math.min(total, perBar * ((opts.motifBars || (total >= perBar * 4 && r() < 0.5 ? 2 : 1))));
    // rhythm: which steps of the motif are played (repeats, with a variation on the last motif)
    let rhythm = Array.isArray(opts.rhythm) && opts.rhythm.length === total ? opts.rhythm.slice() : null;
    if (!rhythm) {
      const motif = [];
      for (let i = 0; i < motifLen; i++) {
        const inBeat = i % rate, onBeat = inBeat === 0, onBar = i % perBar === 0;
        let p = density * (onBeat ? 1.15 - 0.6 * sync : 0.75 + 0.5 * sync);
        if (onBar) p = sync > 0.6 && i > 0 ? p : 1;
        motif.push(r() < p ? 1 : 0);
      }
      motif[0] = 1;
      rhythm = []; for (let i = 0; i < total; i++) rhythm.push(motif[i % motifLen]);
      // last motif: a small variation so the loop "turns around"
      const lastStart = Math.floor((total - 1) / motifLen) * motifLen; if (lastStart > 0) for (let i = Math.max(lastStart, total - perBar); i < total; i++) if (r() < 0.25) rhythm[i] = 1 - rhythm[i];
      rhythm[0] = 1;
    }
    // pitch pool: the key's root plus N-1 other scale degrees, favouring the 5th, then 4th / 3rd / 7th
    const key = parseKey(opts.key); const scale = key.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const nNotes = Math.max(1, Math.min(7, Math.round(opts.notes || 3)));
    const pref = key.minor ? [0, 7, 3, 10, 5, 2, 8] : [0, 7, 4, 5, 9, 2, 11];   // degrees (semitones) in order of "riffiness"
    const pool = pref.filter((x) => scale.includes(x)).slice(0, nNotes);
    const low = Number.isFinite(opts.low) ? opts.low : 40;
    const base = low + mod(key.pc - low, 12);   // the key's root at/above the lowest note
    const hits = []; for (let i = 0; i < total; i++) if (rhythm[i]) hits.push(i);
    let pitches = Array.isArray(opts.pitches) && opts.pitches.length === hits.length ? opts.pitches.slice() : null;
    if (!pitches) {
      // motif of pool indexes for one motif's hits; root on bar starts; repeats with the motif
      const motifHits = hits.filter((i) => i < motifLen); const pat = motifHits.map((i, k) => (i % perBar === 0 ? 0 : k === 0 ? 0 : Math.floor(r() * pool.length)));
      pitches = hits.map((i) => { const k = motifHits.indexOf(i % motifLen); return pool[pat[k >= 0 ? k : 0] || 0]; });
      // last two hits of the riff can move (turnaround)
      for (let k = Math.max(0, hits.length - 2); k < hits.length && hits.length > 3; k++) if (r() < 0.5) pitches[k] = pool[Math.floor(r() * pool.length)];
    }
    const gate = opts.gate == null ? 0.85 : Math.max(0.1, Math.min(1, opts.gate));
    const notes = hits.map((i, k) => {
      const t = i * stepT; const next = k + 1 < hits.length ? hits[k + 1] * stepT : total * stepT;
      let n = base + pitches[k];
      if (opts.follow) { const cr = chordRoot(opts.follow(t)); if (cr != null) n += mod(cr - key.pc + 6, 12) - 6; }   // move with the chord lane (nearest direction)
      while (n < low) n += 12;
      const o = { t, d: Math.max(0.03, Math.min(next - t, stepT * (gate >= 0.95 ? 64 : 1)) * (gate >= 0.95 ? 0.98 : gate)), n, v: i % perBar === 0 ? 0.95 : i % rate === 0 ? 0.82 : 0.7 };
      if (opts.power) o.iv = [0, 7];
      return o;
    });
    return { notes, rhythm, pitches, seed, stepT, total };
  }
  return { generate, parseKey };
});
