// Meter + tempo map. Time signatures can be anything (13/7, 2+2+3/8 …); every part (section) can have its own tempo
// and time signature. Song positions stay in SECONDS everywhere; this turns seconds ⇄ bars/beats.
//   tempo = beats per minute of the bottom note (6/8 at 180 = 180 eighths a minute — two dotted-quarter pulses per bar)
//   groups = how the beats bunch up for the click accents: 6/8 → 3+3, 7/8 → 2+2+3 (or typed "3+2+2/8")
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPMeter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const EPS = 1e-6;
  const int = (x, lo, hi, d) => { const n = Math.round(Number(x)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  function defaultGroups(n, d) {
    if (d >= 8 && n > 3 && n % 3 === 0) return Array(n / 3).fill(3);                 // compound: 6/8, 9/8, 12/8, 12/16 …
    if (d >= 8 && n >= 5 && n % 2 === 1) return [...Array((n - 3) / 2).fill(2), 3];   // 5/8 = 2+3, 7/8 = 2+2+3, 11/8 = 2+2+2+2+3
    return null;                                                                      // simple: every beat its own (accent on 1)
  }
  // [n, d] or [n, d, groups] → a safe copy (n 1–64, d 1–64; groups only if they add up to n)
  function normTs(ts) {
    if (!Array.isArray(ts) || ts.length < 2) return [4, 4];
    const n = int(ts[0], 1, 64, null), d = int(ts[1], 1, 64, null); if (!n || !d) return [4, 4];
    const g = Array.isArray(ts[2]) ? ts[2].map((x) => int(x, 1, 64, 0)) : null;
    return g && g.every(Boolean) && g.reduce((a, b) => a + b, 0) === n && g.length > 1 ? [n, d, g] : [n, d];
  }
  // "7/8", "13/7", "2+2+3/8", "6 / 8" → [n, d(, groups)] or null
  function parseTimeSig(s) {
    const m = /^\s*([\d+\s]+?)\s*\/\s*(\d+)\s*$/.exec(String(s || '')); if (!m) return null;
    const parts = m[1].split('+').map((x) => Number(x.trim())); if (parts.some((x) => !Number.isFinite(x) || x < 1)) return null;
    const n = parts.reduce((a, b) => a + b, 0), d = Number(m[2]);
    if (n < 1 || n > 64 || d < 1 || d > 64) return null;
    return parts.length > 1 ? [n, d, parts] : [n, d];
  }
  const tsLabel = (ts) => { const t = normTs(ts); return `${t[2] ? t[2].join('+') : t[0]}/${t[1]}`; };
  // per beat of a bar: 2 = the one, 1 = start of a group (the 4 in 6/8), 0 = the rest
  function accents(ts) {
    const t = normTs(ts); const g = t[2] || defaultGroups(t[0], t[1]); const out = Array(t[0]).fill(0);
    if (g) { let k = 0; for (const x of g) { out[k] = 1; k += x; } }
    out[0] = 2; return out;
  }
  const beatLenOf = (bpm) => 60 / Math.max(1, Number(bpm) || 120);
  const barLenOf = (bpm, ts) => beatLenOf(bpm) * normTs(ts)[0];
  // song: { bpm, timeSig, sections:[{start, end, bpm?, timeSig?, deleted?}] } → map
  function build(song) {
    const dBpm = Number(song && song.bpm) || 120, dTs = normTs(song && song.timeSig);
    const ov = ((song && song.sections) || []).filter((s) => s && !s.deleted && (Number(s.bpm) > 0 || Array.isArray(s.timeSig)) && s.end > s.start + EPS).slice().sort((a, b) => a.start - b.start);
    const segs = []; let cur = 0, bar = 0;
    const push = (t0, t1, bpm, ts, part) => { if (t1 - t0 <= EPS) return; segs.push({ t0, t1, bpm, ts, bar0: bar, part: part || null }); if (Number.isFinite(t1)) bar += (t1 - t0) / barLenOf(bpm, ts); };
    for (const s of ov) {
      if (s.start < cur - EPS) continue;   // overlapping overrides: the first one wins
      push(cur, s.start, dBpm, dTs);
      push(s.start, s.end, Number(s.bpm) > 0 ? Number(s.bpm) : dBpm, Array.isArray(s.timeSig) ? normTs(s.timeSig) : dTs, s.id || true);
      cur = s.end;
    }
    push(cur, Infinity, dBpm, dTs);
    return { segs, bpm: dBpm, ts: dTs, uniform: segs.length === 1 };
  }
  function segAt(map, t) { const s = map.segs; for (let i = s.length - 1; i >= 0; i--) if (t >= s[i].t0 - EPS) return s[i]; return s[0]; }
  const segBarLen = (sg) => barLenOf(sg.bpm, sg.ts);
  const segBeatLen = (sg) => beatLenOf(sg.bpm);
  // fractional bar index (0 = start of bar 1)
  function barAt(map, t) { const sg = segAt(map, Math.max(0, t)); return sg.bar0 + (Math.max(0, t) - sg.t0) / segBarLen(sg); }
  function secAtBar(map, b) {
    for (let i = map.segs.length - 1; i >= 0; i--) { const sg = map.segs[i]; if (b >= sg.bar0 - EPS) return sg.t0 + (b - sg.bar0) * segBarLen(sg); }
    return 0;
  }
  // bar number (1-based) and beat (1-based) at t; bars restart at every part with its own meter
  function posAt(map, t) {
    const sg = segAt(map, Math.max(0, t)); const bl = segBarLen(sg); const rel = Math.max(0, t) - sg.t0;
    const inSeg = Math.floor(rel / bl + EPS); const into = rel - inSeg * bl;
    return { bar: Math.floor(sg.bar0 + EPS) + inSeg + 1, beat: Math.floor(into / segBeatLen(sg) + EPS) + 1, seg: sg, barStart: sg.t0 + inSeg * bl, barLen: bl, beatLen: segBeatLen(sg) };
  }
  // every beat in [a, b): { t, beat (0-based in bar), accent 0/1/2, beatLen }
  function beatsIn(map, a, b, limit = 20000) {
    const out = [];
    for (const sg of map.segs) {
      if (sg.t1 <= a + EPS || sg.t0 >= b - EPS) continue;
      const bt = segBeatLen(sg), n = normTs(sg.ts)[0], acc = accents(sg.ts);
      let k = Math.ceil((Math.max(a, sg.t0) - sg.t0) / bt - EPS);
      for (; out.length < limit; k++) { const t = sg.t0 + k * bt; if (t >= Math.min(b, sg.t1) - EPS) break; const beat = ((k % n) + n) % n; out.push({ t, beat, accent: acc[beat], beatLen: bt }); }
    }
    return out;
  }
  // every bar line in [a, b): { t, bar (1-based), len }
  function barsIn(map, a, b, limit = 20000) {
    const out = [];
    for (const sg of map.segs) {
      if (sg.t1 <= a + EPS || sg.t0 >= b - EPS) continue;
      const bl = segBarLen(sg); let k = Math.ceil((Math.max(a, sg.t0) - sg.t0) / bl - EPS);
      for (; out.length < limit; k++) { const t = sg.t0 + k * bl; if (t >= Math.min(b, sg.t1) - EPS) break; out.push({ t, bar: Math.floor(sg.bar0 + EPS) + k + 1, len: Math.min(bl, sg.t1 - t), seg: sg }); }
    }
    return out;
  }
  return { normTs, parseTimeSig, tsLabel, defaultGroups, accents, beatLenOf, barLenOf, build, segAt, barAt, secAtBar, posAt, beatsIn, barsIn };
});
