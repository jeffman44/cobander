// Note-highway "what to play" for Practice mode: chord shapes for guitar (capo-aware), the bass line or a
// MIDI part as a tab (string / fret chosen to keep the hand still), a scrolling highway of those events toward a hit
// line (canvas), and plain-text tab for the chart. Pure data + drawing on a context that's passed in.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPHighway = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const mod = (n) => ((n % 12) + 12) % 12;
  const PC = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'], FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const GUITAR = [40, 45, 50, 55, 59, 64], BASS = [28, 33, 38, 43];

  // "F#m7/A" → { root: 6, type: 'm7', bass: 9, name }
  function parseChord(name) {
    const m = /^\s*([A-G](?:#|b)?)\s*([^/\s]*)\s*(?:\/([A-G](?:#|b)?))?\s*$/.exec(String(name || ''));
    if (!m || PC[m[1]] === undefined) return null;
    let q = m[2].toLowerCase().replace(/maj$/, '').replace(/major/, '').replace(/^min(or)?/, 'm').replace(/^-/, 'm');
    const map = { '': 'maj', m: 'm', min: 'm', '7': '7', m7: 'm7', min7: 'm7', maj7: 'maj7', ma7: 'maj7', 'm7': 'm7', sus4: 'sus4', sus: 'sus4', sus2: 'sus2', '5': '5', dim: 'dim', '°': 'dim', o: 'dim', add9: 'add9', '2': 'sus2', '9': '7', m9: 'm7', '6': 'maj', m6: 'm', aug: 'maj', '+': 'maj', dim7: 'dim', m7b5: 'dim', 'ø': 'dim' };
    const type = map[q] !== undefined ? map[q] : (q.startsWith('m') && !q.startsWith('maj') ? 'm' : 'maj');
    return { root: PC[m[1]], type, bass: m[3] && PC[m[3]] !== undefined ? PC[m[3]] : null, name: String(name).trim() };
  }
  const nameOf = (pc, flat) => (flat ? FLAT : SHARP)[mod(pc)];
  const TYPE_SUFFIX = { maj: '', m: 'm', 7: '7', m7: 'm7', maj7: 'maj7', sus4: 'sus4', sus2: 'sus2', 5: '5', dim: 'dim', add9: 'add9' };

  // open shapes: root pitch class → type → frets low E first (-1 muted, 0 open)
  const OPEN = {
    4: { maj: [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0], maj7: [0, 2, 1, 1, 0, 0], sus4: [0, 2, 2, 2, 0, 0], sus2: [0, 2, 4, 4, 0, 0], add9: [0, 2, 4, 1, 0, 0] },
    9: { maj: [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], 7: [-1, 0, 2, 0, 2, 0], m7: [-1, 0, 2, 0, 1, 0], maj7: [-1, 0, 2, 1, 2, 0], sus4: [-1, 0, 2, 2, 3, 0], sus2: [-1, 0, 2, 2, 0, 0], add9: [-1, 0, 2, 4, 2, 0], dim: [-1, 0, 1, 2, 1, -1] },
    2: { maj: [-1, -1, 0, 2, 3, 2], m: [-1, -1, 0, 2, 3, 1], 7: [-1, -1, 0, 2, 1, 2], m7: [-1, -1, 0, 2, 1, 1], maj7: [-1, -1, 0, 2, 2, 2], sus4: [-1, -1, 0, 2, 3, 3], sus2: [-1, -1, 0, 2, 3, 0], add9: [-1, -1, 0, 2, 3, 0], dim: [-1, -1, 0, 1, 3, 1] },
    7: { maj: [3, 2, 0, 0, 0, 3], 7: [3, 2, 0, 0, 0, 1], maj7: [3, 2, 0, 0, 0, 2], sus4: [3, 3, 0, 0, 1, 3], add9: [3, 0, 0, 0, 0, 3] },
    0: { maj: [-1, 3, 2, 0, 1, 0], 7: [-1, 3, 2, 3, 1, 0], maj7: [-1, 3, 2, 0, 0, 0], add9: [-1, 3, 2, 0, 3, 0], sus4: [-1, 3, 3, 0, 1, 1], sus2: [-1, 3, 0, 0, 1, 3] },
    11: { 7: [-1, 2, 1, 2, 0, 2] },
    5: { maj: [1, 3, 3, 2, 1, 1], maj7: [-1, -1, 3, 2, 1, 0] },
  };
  OPEN[5].maj = undefined;   // F is the E-shape barre at 1, not an open chord
  // moveable shapes relative to a barre at fret f on the E string (root = E string pc + f) and the A string
  const E_SHAPE = { maj: [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0], maj7: [0, -1, 1, 1, 0, -1], sus4: [0, 2, 2, 2, 0, 0], sus2: [0, 2, 4, 4, 0, 0], dim: [0, 1, 2, 0, -1, -1], add9: [0, 2, 2, 1, 0, 2], 5: [0, 2, 2, -1, -1, -1] };
  const A_SHAPE = { maj: [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], 7: [-1, 0, 2, 0, 2, 0], m7: [-1, 0, 2, 0, 1, 0], maj7: [-1, 0, 2, 1, 2, 0], sus4: [-1, 0, 2, 2, 3, 0], sus2: [-1, 0, 2, 2, 0, 0], dim: [-1, 0, 1, 2, 1, -1], add9: [-1, 0, 2, 4, 2, 0], 5: [-1, 0, 2, 2, -1, -1] };

  // the shape to play for a SOUNDING chord with a capo: shape pitch = sounding − capo
  function shape(chordName, { capo = 0, instrument = 'guitar' } = {}) {
    const p = parseChord(chordName); if (!p) return null;
    const type = TYPE_SUFFIX[p.type] !== undefined ? p.type : 'maj';
    const r = mod(p.root - capo);   // root as fingered behind the capo
    const flat = /b/.test(String(chordName).slice(1, 2));
    const name = `${nameOf(p.root, flat)}${TYPE_SUFFIX[type]}`;
    const fingeredName = `${nameOf(r, flat)}${TYPE_SUFFIX[type]}`;
    if (type !== '5' && OPEN[r] && OPEN[r][type]) return { name, fingered: fingeredName, frets: OPEN[r][type].slice(), position: 0, capo, barre: null };
    // barre on the E string (fret = r - 4) or the A string (fret = r - 9): the lower one that's ≥ 1
    const fe = mod(r - 4) || 12, fa = mod(r - 9) || 12;
    const useE = type === '5' ? fe <= fa + 2 : fe <= fa;
    const base = (useE ? E_SHAPE : A_SHAPE)[type] || (useE ? E_SHAPE : A_SHAPE).maj; const f = useE ? fe : fa;
    const frets = base.map((x) => (x < 0 ? -1 : x + f));
    return { name, fingered: fingeredName, frets, position: f, capo, barre: type === '5' ? null : f };
  }
  function chordAt(chords, t) { let cur = null; for (const c of chords || []) { if (c.deleted) continue; if (c.time <= t + 1e-3) { if (!cur || c.time >= cur.time) cur = c; } } return cur; }

  // ---- tab: string / fret choices that keep the hand still (DP over candidates) ----
  function tab(notes, tuning, { maxFret = 17 } = {}) {
    const ns = (notes || []).filter((n) => Number.isFinite(n.midi) || Number.isFinite(n.n)).map((n) => ({ ...n, midi: Math.round(Number.isFinite(n.midi) ? n.midi : n.n) })).sort((a, b) => (a.t ?? a.t0 ?? 0) - (b.t ?? b.t0 ?? 0));
    const low = tuning[0]; const out = [];
    const cands = ns.map((n) => { let m = n.midi, oct = 0; while (m < low) { m += 12; oct++; } while (m > tuning[tuning.length - 1] + maxFret) { m -= 12; oct--; } const c = []; tuning.forEach((open, s) => { const fr = m - open; if (fr >= 0 && fr <= maxFret) c.push({ string: s, fret: fr }); }); if (!c.length) c.push({ string: tuning.length - 1, fret: Math.max(0, m - tuning[tuning.length - 1]) }); return { m, oct, c }; });
    if (!cands.length) return [];
    const cost = (a, b) => Math.abs(a.fret - b.fret) + 2 * Math.abs(a.string - b.string);
    const solo = (c) => (c.fret > 12 ? 3 : 0) + (c.fret === 0 ? 0 : 0.1 * c.fret);
    let prev = cands[0].c.map((c) => ({ c, total: solo(c), back: -1 }));
    const layers = [prev];
    for (let i = 1; i < cands.length; i++) {
      const cur = cands[i].c.map((c) => { let best = Infinity, bi = 0; prev.forEach((p, j) => { const v = p.total + cost(p.c, c); if (v < best) { best = v; bi = j; } }); return { c, total: best + solo(c), back: bi }; });
      layers.push(cur); prev = cur;
    }
    let bi = 0; prev.forEach((p, j) => { if (p.total < prev[bi].total) bi = j; });
    for (let i = layers.length - 1; i >= 0; i--) { const e = layers[i][bi]; const n = ns[i]; out[i] = { t: n.t ?? n.t0 ?? 0, d: n.d ?? ((n.t1 ?? 0) - (n.t0 ?? 0)) ?? 0.25, midi: cands[i].m, string: e.c.string, fret: e.c.fret, ...(cands[i].oct ? { octave: cands[i].oct } : {}) }; bi = e.back; }
    return out;
  }
  const bassTab = (notes, { tuning = BASS, maxFret = 17 } = {}) => tab(notes, tuning, { maxFret });
  const guitarTab = (notes, { tuning = GUITAR, maxFret = 17 } = {}) => tab(notes, tuning, { maxFret });

  let _pc = null; function pitchcheck() { if (_pc !== null) return _pc; try { _pc = typeof module === 'object' && module.exports ? require('./pitchcheck.js') : (typeof BPPitchCheck !== 'undefined' ? BPPitchCheck : false); } catch (_) { _pc = false; } return _pc; }
  // a pitch track [{t, midi|NaN}] → notes [{t, d, midi}] (pitchcheck's segmenter when it's there, else a plain one)
  function notesFromPitchTrack(pts, { minDur = 0.08 } = {}) {
    const P = pitchcheck();
    if (P && P.notes) return P.notes(pts, { minDur }).map((n) => ({ t: n.t0, d: n.t1 - n.t0, midi: Math.round(n.midi) }));
    const out = []; let cur = null;
    for (const p of pts || []) {
      const v = Number.isFinite(p.midi);
      if (!v) { if (cur) { out.push(cur); cur = null; } continue; }
      if (cur && Math.abs(p.midi - cur.sum / cur.n) < 0.6) { cur.sum += p.midi; cur.n++; cur.end = p.t; continue; }
      if (cur) out.push(cur); cur = { t: p.t, end: p.t, sum: p.midi, n: 1 };
    }
    if (cur) out.push(cur);
    return out.map((c) => ({ t: c.t, d: Math.max(0.01, c.end - c.t), midi: Math.round(c.sum / c.n) })).filter((n) => n.d >= minDur);
  }

  // ---- highway events ----
  // mode chords: one lane, the chord name + its shape; bass / guitar / midi: one lane per string, label = fret
  function events({ mode = 'chords', chords = [], notes = [], from = -Infinity, to = Infinity, capo = 0, tuning = null } = {}) {
    const out = [];
    if (mode === 'chords') {
      const cs = (chords || []).filter((c) => c && !c.deleted && typeof c.time === 'number').sort((a, b) => a.time - b.time);
      cs.forEach((c, i) => { if (c.time < from || c.time >= to) return; const sh = shape(c.chord, { capo }); const next = cs[i + 1]; out.push({ t: c.time, d: Math.max(0.25, (next ? next.time : c.time + 2) - c.time), lane: 0, label: sh ? sh.name : String(c.chord), sub: sh && sh.capo && sh.fingered !== sh.name ? `${sh.fingered} shape` : (sh && sh.position ? `fret ${sh.position}` : ''), frets: sh ? sh.frets : null }); });
      return out;
    }
    const tn = tuning || (mode === 'bass' ? BASS : GUITAR);
    const tb = tab(notes, tn).filter((n) => n.t >= from && n.t < to);
    for (const n of tb) out.push({ t: n.t, d: n.d, lane: n.string, label: String(n.fret), sub: n.octave ? `8va${n.octave > 0 ? '' : 'b'}` : '', midi: n.midi });
    return out.sort((a, b) => a.t - b.t || a.lane - b.lane);
  }

  // ---- drawing (allocation-light: no arrays or strings built per frame beyond the labels) ----
  const DEF_COLORS = { bg: '#15171c', lane: '#30353f', hit: '#e5b04b', block: '#5b8def', blockHit: '#e5b04b', text: '#ffffff', muted: '#8b91a0', fret: '#262a33' };
  function rrect(ctx, x, y, w, h, r) { if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); } else ctx.fillRect(x, y, w, h); }
  function textW(ctx, s) { if (typeof ctx.measureText === 'function') { const m = ctx.measureText(s); if (m && Number.isFinite(m.width)) return m.width; } return String(s).length * 7; }
  function drawShape(ctx, frets, x, y, w, h, colors) {   // mini fretboard: 6 columns × 5 frets, dots, X / O on top
    const cols = frets.length, cw = w / (cols + 1), rows = 5; let base = 0, hi = 0; for (const f of frets) { if (f > 0 && (base === 0 || f < base)) base = f; if (f > hi) hi = f; } if (base <= 1 || hi <= rows) base = 1;   // open-position grips show the nut; only shapes up the neck get a base-fret number
    const top = y + 14, rh = (h - 18) / rows;
    ctx.strokeStyle = colors.muted; ctx.lineWidth = 1;
    for (let c = 0; c < cols; c++) { const cx = x + cw * (c + 1); ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + rh * rows); ctx.stroke(); }
    for (let r = 0; r <= rows; r++) { const yy = top + rh * r; ctx.beginPath(); ctx.moveTo(x + cw, yy); ctx.lineTo(x + cw * cols, yy); ctx.stroke(); }
    if (base === 1) { ctx.fillStyle = colors.text; ctx.fillRect(x + cw, top - 2, cw * (cols - 1), 3); } else { ctx.fillStyle = colors.muted; ctx.fillText(String(base), x + 1, top + rh * 0.8); }
    ctx.fillStyle = colors.text;
    for (let c = 0; c < cols; c++) { const f = frets[c], cx = x + cw * (c + 1); if (f < 0) ctx.fillText('x', cx - 3, top - 4); else if (f === 0) ctx.fillText('o', cx - 3, top - 4); else { const yy = top + rh * (f - base + 0.5); ctx.beginPath(); ctx.arc(cx, yy, Math.min(cw, rh) * 0.32, 0, 6.2832); ctx.fill(); } }
  }
  const autoLA = new WeakMap();
  function draw(ctx, { w, h, now = 0, events: evs = [], lookahead = 4, lanes = 1, hitY = null, labels = null, colors = null, lookback = 0.6 } = {}) {
    const C = colors ? { ...DEF_COLORS, ...colors } : DEF_COLORS; const HY = hitY == null ? h * 0.8 : hitY;
    const laneW = w / Math.max(1, lanes);
    ctx.save();
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = C.lane; ctx.lineWidth = 1;
    for (let l = 1; l < lanes; l++) { const x = laneW * l; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    if (labels) { ctx.fillStyle = C.muted; ctx.font = '12px ui-monospace, Menlo, monospace'; for (let l = 0; l < lanes; l++) ctx.fillText(String(labels[l] || ''), laneW * l + 4, h - 6); }
    ctx.strokeStyle = C.hit; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, HY); ctx.lineTo(w, HY); ctx.stroke();
    // 'auto': as far ahead as keeps the part's busy stretches readable — consecutive notes at least ~34 px apart
    // (a 16th-note riff spreads out and moves faster; a slow strum shows more of what's coming)
    if ((lookahead === 'auto' || lookahead == null) && autoLA.has(evs) && autoLA.get(evs).hy === HY) lookahead = autoLA.get(evs).la;
    if (lookahead === 'auto' || lookahead == null) {
      const ts = evs.map((e) => e.t);   /* the whole part, so the speed stays put through the song */
      const gaps = []; const u = [...new Set(ts.map((t) => Math.round(t * 1000)))].sort((a, b) => a - b); for (let i = 1; i < u.length; i++) gaps.push((u[i] - u[i - 1]) / 1000);
      gaps.sort((a, b) => a - b); const g = gaps.length ? gaps[Math.floor(gaps.length * 0.25)] : 0.5;
      lookahead = Math.max(1.1, Math.min(4, (HY * g) / 34)); autoLA.set(evs, { la: lookahead, hy: HY });
    }
    const pxPerSec = HY / lookahead;
    // each note's block runs only until the next note on its lane (a ringing note doesn't paint over the next one)
    const nextOn = new Map(); { const byLane = new Map(); evs.forEach((e, i) => { const l = e.lane || 0; if (!byLane.has(l)) byLane.set(l, []); byLane.get(l).push(i); }); for (const list of byLane.values()) { list.sort((a, b) => evs[a].t - evs[b].t); for (let k = 0; k + 1 < list.length; k++) nextOn.set(list[k], evs[list[k + 1]].t); } }
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]; const dt = e.t - now; if (dt > lookahead || dt + (e.d || 0.25) < -lookback) continue;
      const room = nextOn.has(i) ? nextOn.get(i) - e.t : Infinity; const d = Math.min(e.d || 0.25, lookahead, room * 0.85);
      const y1 = HY - dt * pxPerSec, len = Math.max(14, Math.min(d * pxPerSec, Math.max(14, room * pxPerSec - 6))), y0 = y1 - len;
      const hit = Math.abs(dt) <= 0.08 || (dt < 0 && dt + (e.d || 0.25) > 0);
      const lx = laneW * (e.lane || 0) + 4, lw = laneW - 8;
      ctx.fillStyle = hit ? C.blockHit : C.block; ctx.globalAlpha = dt < 0 ? 0.55 : 1;
      if (lanes === 1 && e.frets) {   // chord: a card with the name and its shape
        const cw = Math.min(lw, 260), cx = (w - cw) / 2; rrect(ctx, cx, y0, cw, len, 8);
        ctx.fillStyle = C.text; ctx.font = 'bold 22px system-ui, sans-serif'; ctx.fillText(e.label, cx + 10, y0 + 26);
        if (e.sub) { ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = hit ? '#1b1b1b' : C.muted; ctx.fillText(e.sub, cx + 10, y0 + 42); }
        if (len >= 70) drawShape(ctx, e.frets, cx + cw - 100, y0 + 6, 90, Math.min(len - 10, 90), { text: hit ? '#1b1b1b' : C.text, muted: hit ? '#3a3a3a' : C.muted });
      } else {
        rrect(ctx, lx, y0, lw, len, 6);
        ctx.fillStyle = hit ? '#1b1b1b' : C.text; ctx.font = 'bold 18px ui-monospace, Menlo, monospace';
        ctx.fillText(e.label, lx + lw / 2 - textW(ctx, e.label) / 2, y1 - 6);
        if (e.sub) { ctx.font = '10px system-ui, sans-serif'; ctx.fillText(e.sub, lx + 4, y0 + 11); }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ---- text tab ----
  function tabText(notes, { tuning = null, labels = null, barLen = null, charsPerBeat = 4, beatLen = 0.5 } = {}) {
    const tn = tuning || (notes && notes.length && notes.some((n) => (n.midi ?? n.n) < 40) ? BASS : GUITAR);
    const lab = labels || tn.map((m) => SHARP[mod(m)]);
    const tb = tab(notes, tn); if (!tb.length) return '';
    const t0 = Math.min(...tb.map((n) => n.t)); const end = Math.max(...tb.map((n) => n.t + (n.d || 0.25)));
    const cols = Math.ceil((end - t0) / beatLen * charsPerBeat) + 2;
    const lines = tn.map(() => new Array(cols).fill('-'));
    for (const n of tb) { const c = Math.round((n.t - t0) / beatLen * charsPerBeat); const s = String(n.fret); for (let k = 0; k < s.length && c + k < cols; k++) lines[n.string][c + k] = s[k]; }
    const bar = barLen ? Math.round(barLen / beatLen * charsPerBeat) : null;
    const rows = lines.map((l, i) => { let s = ''; for (let c = 0; c < cols; c++) { if (bar && c > 0 && c % bar === 0) s += '|'; s += l[c]; } return `${String(lab[i]).padEnd(2)}|${s}|`; });
    return rows.reverse().join('\n');
  }
  return { parseChord, shape, chordAt, tab, bassTab, guitarTab, notesFromPitchTrack, events, draw, tabText, drawShape, GUITAR, BASS };
});
