// Tab editing: the pure half of the tab editor. A tab is a list of events {t, d, notes, frets[string], name?, mono}
// (tab.js makes them); here a grid of columns (the song's beats split into eighths / sixteenths) is laid over them and
// edits come back as a NEW event list: a fret typed on a string, a note cleared, a chord named (an empty column gets a
// playable shape for the name), an event nudged a column. Strings are indexed low → high like tab.js (0 = low E).
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(() => (isNode ? require('./tab.js') : root.BPTab));
  if (isNode) module.exports = api;
  else root.BPTabEdit = api;
})(typeof self !== 'undefined' ? self : this, function (getTB) {
  'use strict';
  const MAXF = 24;
  const PCS = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const mod = (n) => ((n % 12) + 12) % 12;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // beats [{t, beatLen}] (BPMeter.beatsIn) → column start times, `sub` per beat, up to `end`
  function columns(beats, sub = 2, end = Infinity) {
    const out = [];
    for (const b of beats || []) { const step = b.beatLen / sub; for (let k = 0; k < sub; k++) { const t = b.t + k * step; if (t < end - 1e-6) out.push(r3(t)); } }
    return out;
  }
  // nearest column to t (binary search)
  function colOf(cols, t) {
    if (!cols.length) return -1; let lo = 0, hi = cols.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cols[m] <= t) lo = m; else hi = m; }
    return Math.abs(cols[hi] - t) < Math.abs(t - cols[lo]) ? hi : lo;
  }
  const colLen = (cols, i) => (i + 1 < cols.length ? cols[i + 1] - cols[i] : i > 0 ? cols[i] - cols[i - 1] : 0.25);
  // the event that sits in column i (the one nearest its start, within half a column), or -1
  function eventAt(events, cols, i) {
    if (i < 0 || i >= cols.length) return -1; const half = colLen(cols, i) / 2; const c = cols[i];
    let best = -1, bd = Infinity;
    (events || []).forEach((e, k) => { const d = Math.abs(e.t - c); if (d < half - 1e-6 && d < bd) { bd = d; best = k; } });
    return best;
  }
  const copy = (events) => (events || []).map((e) => ({ ...e, frets: (e.frets || []).slice(), notes: (e.notes || []).slice() }));
  // frets → notes / mono / name again (a name someone typed stays, unless the notes no longer fit it at all)
  function settle(e, tuning) {
    const notes = []; e.frets.forEach((f, s) => { if (f >= 0) notes.push(tuning[s] + f); });
    e.notes = notes.sort((a, b) => a - b); e.mono = notes.length === 1; delete e.filled;
    if (!e.nameSet) { const pcs = new Set(notes.map(mod)); const TB = getTB(); const nm = pcs.size >= 2 && TB ? TB.chordName(notes) : null; if (nm && nm.name) e.name = nm.name; else delete e.name; }
    return e;
  }
  // fret f on string s in column i: into the event already there, else a new one a column long
  function setFret(events, cols, i, s, f, tuning) {
    f = Math.round(Number(f)); if (!Number.isFinite(f) || f < 0 || f > MAXF || s < 0 || s >= tuning.length || i < 0 || i >= cols.length) return events;
    const out = copy(events); let k = eventAt(out, cols, i);
    if (k < 0) { out.push({ t: cols[i], d: r3(colLen(cols, i)), frets: tuning.map(() => -1), notes: [] }); k = out.length - 1; }
    out[k].frets[s] = f; settle(out[k], tuning);
    return out.sort((a, b) => a.t - b.t);
  }
  // clear string s in column i (s = -1: the whole column); an event with nothing left goes
  function clear(events, cols, i, s, tuning) {
    const k = eventAt(events, cols, i); if (k < 0) return events;
    const out = copy(events);
    if (s < 0) out[k].frets = out[k].frets.map(() => -1); else out[k].frets[s] = -1;
    if (out[k].frets.every((f) => f < 0)) out.splice(k, 1); else settle(out[k], tuning);
    return out;
  }
  // "G", "F#m7", "Bb5", "Dsus4", "C/G" → {root pc, quality} or null
  function parseChord(name) {
    const m = /^\s*([A-G])([#b]?)([^/\s]*)(?:\/([A-G][#b]?))?\s*$/.exec(String(name || '')); if (!m) return null;
    const root = PCS[m[1] + m[2]]; if (root == null) return null;
    const q = m[3].replace(/^maj$/i, '').replace(/^M7$/, 'maj7').replace(/^min/, 'm').replace(/^-/, 'm');
    return { root, q, bass: m[4] && PCS[m[4]] != null ? PCS[m[4]] : null };
  }
  // shapes, strings low → high, -1 = not played
  const OPEN = { C: [-1, 3, 2, 0, 1, 0], Cmaj7: [-1, 3, 2, 0, 0, 0], C7: [-1, 3, 2, 3, 1, 0], D: [-1, -1, 0, 2, 3, 2], Dm: [-1, -1, 0, 2, 3, 1], D7: [-1, -1, 0, 2, 1, 2], Dsus4: [-1, -1, 0, 2, 3, 3], Dsus2: [-1, -1, 0, 2, 3, 0], Dmaj7: [-1, -1, 0, 2, 2, 2], Dm7: [-1, -1, 0, 2, 1, 1],
    E: [0, 2, 2, 1, 0, 0], Em: [0, 2, 2, 0, 0, 0], E7: [0, 2, 0, 1, 0, 0], Em7: [0, 2, 0, 0, 0, 0], Esus4: [0, 2, 2, 2, 0, 0], E5: [0, 2, 2, -1, -1, -1], Fmaj7: [-1, -1, 3, 2, 1, 0],
    G: [3, 2, 0, 0, 0, 3], G7: [3, 2, 0, 0, 0, 1], G5: [3, 5, 5, -1, -1, -1], A: [-1, 0, 2, 2, 2, 0], Am: [-1, 0, 2, 2, 1, 0], A7: [-1, 0, 2, 0, 2, 0], Am7: [-1, 0, 2, 0, 1, 0], Asus4: [-1, 0, 2, 2, 3, 0], Asus2: [-1, 0, 2, 2, 0, 0], Amaj7: [-1, 0, 2, 1, 2, 0], A5: [-1, 0, 2, 2, -1, -1], B7: [-1, 2, 1, 2, 0, 2] };
  const ESHAPE = { '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0], 5: [0, 2, 2, -1, -1, -1], sus4: [0, 2, 2, 2, 0, 0], maj7: [0, -1, 1, 1, 0, -1], sus2: [0, 2, 4, -1, -1, -1] };
  const ASHAPE = { '': [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], 7: [-1, 0, 2, 0, 2, 0], m7: [-1, 0, 2, 0, 1, 0], 5: [-1, 0, 2, 2, -1, -1], sus4: [-1, 0, 2, 2, 3, 0], sus2: [-1, 0, 2, 2, 0, 0], maj7: [-1, 0, 2, 1, 2, 0], dim: [-1, 0, 1, 2, 1, -1] };
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // a playable shape for a chord name on standard-ish tuning: an open chord if there is one, else the lower of the
  // E-shape and A-shape barres. Bass (4 strings): the root on the lowest string that has it in the first 7 frets.
  function shapeFor(name, tuning) {
    const p = parseChord(name); if (!p) return null; const n = tuning.length;
    if (n <= 5) { for (let s = 0; s < n; s++) { const f = mod(p.root - tuning[s]); if (f <= 7) { const fr = tuning.map(() => -1); fr[s] = f; return fr; } } return null; }
    const std = [40, 45, 50, 55, 59, 64]; const shift = tuning.every((x, s) => x - std[s] === tuning[0] - std[0]) ? tuning[0] - std[0] : null;
    if (shift == null) return null;   // an open / odd tuning: no shape library for it
    const root = mod(p.root - shift); const key = SHARP[root] + p.q; const flatKey = Object.keys(PCS).find((k) => PCS[k] === root && k.length === 2 && k[1] === 'b');
    if (OPEN[key]) return OPEN[key].slice(); if (flatKey && OPEN[flatKey + p.q]) return OPEN[flatKey + p.q].slice();
    const cands = [];
    if (ESHAPE[p.q]) { const f = mod(root - 4); cands.push(ESHAPE[p.q].map((x) => (x < 0 ? -1 : x + f))); }
    if (ASHAPE[p.q]) { const f = mod(root - 9); cands.push(ASHAPE[p.q].map((x) => (x < 0 ? -1 : x + f))); }
    if (!cands.length) return null;
    const lowest = (fr) => Math.min(...fr.filter((x) => x >= 0));
    return cands.sort((a, b) => lowest(a) - lowest(b))[0];
  }
  // name the chord in column i: an event there keeps its notes and takes the name; an empty column gets the shape
  function setName(events, cols, i, name, tuning) {
    const nm = String(name || '').trim(); const out = copy(events); const k = eventAt(out, cols, i);
    if (k >= 0) { if (nm) { out[k].name = nm; out[k].nameSet = true; } else { delete out[k].nameSet; settle(out[k], tuning); } return out; }
    if (!nm) return events;
    const fr = shapeFor(nm, tuning); if (!fr) return null;
    out.push(settle({ t: cols[i], d: r3(colLen(cols, i) * 2), frets: fr, notes: [], name: nm, nameSet: true }, tuning)); out[out.length - 1].name = nm;
    return out.sort((a, b) => a.t - b.t);
  }
  // move the event in column i by `by` columns (onto an empty column only)
  function shift(events, cols, i, by) {
    const k = eventAt(events, cols, i); const j = i + by; if (k < 0 || j < 0 || j >= cols.length || eventAt(events, cols, j) >= 0) return events;
    const out = copy(events); out[k].t = cols[j]; return out.sort((a, b) => a.t - b.t);
  }
  return { columns, colOf, colLen, eventAt, setFret, clear, setName, shift, parseChord, shapeFor, settle, MAXF };
});
