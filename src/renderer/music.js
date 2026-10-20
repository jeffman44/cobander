// Small music-theory helpers for songwriting: keys, transposition, chords that fit a key, common progressions,
// and the key shift a parts-bin drop needs. Pure (renderer: window.BPMusic; node: require).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPMusic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
  const PC = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  const mod = (n, m = 12) => ((n % m) + m) % m;

  // "C#/Db", "F#m", "Bb", "Am" → {pc, minor, name}
  function parseKey(k) {
    const s = String(k || '').trim(); if (!s) return null;
    const m = /^([A-G](?:#|b)?)(?:\/[A-G](?:#|b)?)?\s*(m|min|minor)?$/i.exec(s.replace(/\s*major$/i, ''));
    if (!m) return null;
    const root = m[1][0].toUpperCase() + (m[1][1] || '');
    if (PC[root] === undefined) return null;
    return { pc: PC[root], minor: !!m[2], name: `${root}${m[2] ? 'm' : ''}` };
  }
  const relMajor = (k) => (k.minor ? mod(k.pc + 3) : k.pc);
  // Semitones to move a part from key `from` into key `to` (relative major/minor count as the same key), in -5..+6.
  function keyShift(from, to) {
    const a = parseKey(from), b = parseKey(to); if (!a || !b) return 0;
    const d = mod(relMajor(b) - relMajor(a)); return d > 6 ? d - 12 : d;
  }
  function noteName(pc, preferFlat = false) { return (preferFlat ? FLAT : SHARP)[mod(pc)]; }
  // Transpose a chord symbol ("F#m7", "Bb/D", "Gsus4") by n semitones.
  function transposeChord(ch, n, preferFlat = false) {
    const s = String(ch); if (!/^[A-G]/.test(s)) return s;   // N.C., %, -, x: not notes
    return s.replace(/(^|\/)([A-G](?:#|b)?)/g, (m, pre, r) => (PC[r] === undefined ? m : pre + noteName(PC[r] + n, preferFlat)));
  }
  const isFlatKey = (key) => { const k = parseKey(key); return !!k && (FLAT_KEYS.has(k.name) || /b/.test(k.name.slice(1))); };
  // Transpose a key name ("C#/Db" +2 → "D#"/"Eb" by flat preference, "Am" -2 → "Gm")
  function transposeKey(key, n) { const k = parseKey(key); if (!k) return key || ''; const pc = (k.pc + n + 120) % 12; const flat = FLAT_KEYS.has(`${FLAT[pc]}${k.minor ? 'm' : ''}`); return `${noteName(pc, flat)}${k.minor ? 'm' : ''}`; }
  // The seven chords that fit a key (triads), with roman numerals.
  function diatonic(key) {
    const k = parseKey(key); if (!k) return [];
    const flat = FLAT_KEYS.has(k.name);
    const steps = k.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const qual = k.minor ? ['m', 'dim', '', 'm', 'm', '', ''] : ['', 'm', 'm', '', '', 'm', 'dim'];
    const roman = k.minor ? ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'] : ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
    return steps.map((st, i) => ({ chord: `${noteName(k.pc + st, flat)}${qual[i]}`, roman: roman[i], degree: i + 1 }));
  }
  // Progressions bands actually write with (degrees 1-7 of the key's scale).
  const PROGRESSIONS = [
    { name: 'I–V–vi–IV (pop-punk / anthem)', major: [1, 5, 6, 4] },
    { name: 'vi–IV–I–V (sad anthem)', major: [6, 4, 1, 5] },
    { name: 'I–IV–V (three-chord rock)', major: [1, 4, 5, 5] },
    { name: 'I–vi–IV–V (50s / doo-wop)', major: [1, 6, 4, 5] },
    { name: 'I–IV–vi–V', major: [1, 4, 6, 5] },
    { name: 'IV–I–V–vi (emo lift)', major: [4, 1, 5, 6] },
    { name: 'ii–V–I (jazz turn)', major: [2, 5, 1, 1] },
    { name: 'i–VI–III–VII (minor epic)', minor: [1, 6, 3, 7] },
    { name: 'i–VII–VI–VII (minor rock)', minor: [1, 7, 6, 7] },
    { name: 'i–iv–v–i (minor blues-ish)', minor: [1, 4, 5, 1] },
    { name: 'i–VI–VII–i (metal gallop)', minor: [1, 6, 7, 1] },
  ];
  function progressionsFor(key) {
    const k = parseKey(key); if (!k) return [];
    const d = diatonic(key);
    return PROGRESSIONS.filter((p) => (k.minor ? p.minor : p.major)).map((p) => ({ name: p.name, chords: (k.minor ? p.minor : p.major).map((n) => d[n - 1].chord) }));
  }
  // Guess a key from chords (most chords diatonic, first chord as tie-break). Returns e.g. "G" or "Em" or ''.
  function guessKey(chords) {
    const simplify = (c) => { let x = String(c).replace(/\/.*$/, ''); if (/m7b5$/.test(x)) return x.replace(/m7b5$/, 'dim'); x = x.replace(/(maj7|maj9|add9|sus2|sus4|6|9|11|13|5)$/, ''); x = x.replace(/m7$/, 'm').replace(/(?<!m)7$/, ''); return x; };
    const list = (chords || []).map(simplify).filter((c) => /^[A-G]/.test(c));
    if (!list.length) return '';
    let best = '', bestScore = -1;
    for (const r of SHARP) for (const mi of [false, true]) {
      const norm = (c) => { const p = parseKey(c.replace(/dim$/, '')); return p ? `${noteName(p.pc)}${/dim$/.test(c) ? 'dim' : p.minor ? 'm' : ''}` : c; };
      const key = `${r}${mi ? 'm' : ''}`; const set = new Set(diatonic(key).map((x) => norm(x.chord)));
      let sc = 0; for (const c of list) if (set.has(norm(c))) sc++;
      if (norm(list[0]) === `${r}${mi ? 'm' : ''}`) sc += 0.5;
      if (sc > bestScore) { bestScore = sc; best = key; }
    }
    return best;
  }
  // ---------- key detection (Krumhansl-Schmuckler) ----------
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) { const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? num / Math.sqrt(da * db) : 0; }
  // pitch-class weights (12) → {key, confidence 0..1, runnerUp}
  function keyFromPitchClasses(w) {
    if (!w || w.reduce((x, y) => x + y, 0) <= 0) return { key: '', confidence: 0 };
    const res = [];
    for (let r = 0; r < 12; r++) for (const minor of [false, true]) { const prof = minor ? KK_MINOR : KK_MAJOR; const rot = prof.map((_, i) => prof[mod(i - r)]); res.push({ key: `${noteName(r, FLAT_KEYS.has(`${FLAT[r]}${minor ? 'm' : ''}`))}${minor ? 'm' : ''}`, r: corr(w, rot) }); }
    res.sort((a, b) => b.r - a.r);
    // relative major/minor are the same notes for shifting purposes, so the gap that matters is to the best *other* key family
    const fam = (k) => { const p = parseKey(k); return relMajor(p); };
    const other = res.find((x) => fam(x.key) !== fam(res[0].key));
    let conf = Math.max(0, Math.min(1, (res[0].r - (other ? other.r : 0)) * 4));
    // power chords / root-fifth riffs have no third: major vs minor (and so the shift) is a coin toss
    const top = parseKey(res[0].key); const root = w[top.pc] || 1e-9; const maj3 = w[mod(top.pc + 4)], min3 = w[mod(top.pc + 3)];
    if (maj3 < root * 0.15 && min3 < root * 0.15) conf *= 0.4;
    const mx = Math.max(...w); if (w.filter((x) => x > mx * 0.1).length < 4) conf = Math.min(conf * 0.3, 0.25);   // too few notes to tell
    return { key: res[0].key, confidence: conf, runnerUp: other ? other.key : '' };
  }
  // MIDI notes {n, d} → key
  function keyFromNotes(notes) { const w = new Array(12).fill(0); for (const x of notes || []) w[mod(Math.round(x.n))] += Math.max(0.05, Number(x.d) || 0.25); return keyFromPitchClasses(w); }
  // Audio → chroma (12 pitch-class energies) via a small radix-2 FFT over hops; 55 Hz – 2 kHz.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai; re[i + k] += ar; im[i + k] += ai; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } } }
  }
  function chromaFromChannels(chans, sampleRate, { maxSeconds = 90 } = {}) {
    const N = 8192, hop = 4096; const n = Math.min(chans[0].length, Math.round(maxSeconds * sampleRate));
    const w = new Array(12).fill(0); const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const binPc = new Int8Array(N / 2).fill(-1); for (let b = 1; b < N / 2; b++) { const f = (b * sampleRate) / N; if (f < 55 || f > 2000) continue; binPc[b] = mod(Math.round(12 * Math.log2(f / 440)) + 9); }
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let s = 0; s + N <= n; s += hop) {
      for (let i = 0; i < N; i++) { let x = 0; for (const c of chans) x += c[s + i]; re[i] = (x / chans.length) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 1; b < N / 2; b++) if (binPc[b] >= 0) w[binPc[b]] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    }
    return w;
  }
  function keyFromAudio(chans, sampleRate) { return keyFromPitchClasses(chromaFromChannels(chans, sampleRate)); }
  // Scale (pitch classes) of a key, root first
  function scaleOf(key) { const k = parseKey(key); if (!k) return null; const steps = k.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]; return { root: k.pc, minor: k.minor, pcs: steps.map((x) => mod(k.pc + x)) }; }
  // Chord symbol → pitch classes of its triad (plus 7th when written)
  function chordPcs(ch) {
    const m = /^([A-G](?:#|b)?)(m(?!aj))?(dim|aug|sus2|sus4)?(maj7|7)?/.exec(String(ch || '')); if (!m || PC[m[1]] === undefined) return null;
    const r = PC[m[1]]; let third = m[2] ? 3 : 4, fifth = 7;
    if (m[3] === 'dim') { third = 3; fifth = 6; } else if (m[3] === 'aug') fifth = 8; else if (m[3] === 'sus2') third = 2; else if (m[3] === 'sus4') third = 5;
    const out = [r, mod(r + third), mod(r + fifth)]; if (m[4] === '7') out.push(mod(r + 10)); if (m[4] === 'maj7') out.push(mod(r + 11)); return out;
  }

  return { keyFromPitchClasses, keyFromNotes, chromaFromChannels, keyFromAudio, scaleOf, chordPcs, parseKey, keyShift, transposeChord, transposeKey, isFlatKey, diatonic, PROGRESSIONS, progressionsFor, guessKey, noteName, FLAT_KEYS };
});
