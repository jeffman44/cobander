// Timing report: how far every hit of a take sits from the grid, bar by bar — shown to the player (early / late in
// ms, the worst bars, whether the whole take is simply offset) instead of silently warping it. Pure; the caller
// finds the hits (BPTighten.onsets → song time) and supplies the grid and bar lines.
(function (root, factory) {
  const api = factory(() => (typeof module === 'object' && module.exports ? require('./tighten.js') : root.BPTighten));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPTiming = api;
})(typeof self !== 'undefined' ? self : this, function (getTG) {
  'use strict';
  const nearestOf = (grid, t) => { const TG = getTG(); if (TG && TG.nearest) return TG.nearest(grid, t); let best = null; for (const g of grid) if (best == null || Math.abs(g - t) < Math.abs(best - t)) best = g; return best; };
  const median = (v) => { if (!v.length) return 0; const s = v.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const r1 = (x) => Math.round(x * 10) / 10;

  // hits [{t, errMs}] already filtered → the report shape
  function build(hits, barStarts) {
    const bars = (barStarts || []).slice().sort((a, b) => a - b);
    const barOf = (t) => { let k = -1; for (let i = 0; i < bars.length; i++) if (bars[i] <= t + 1e-6) k = i; else break; return k; };
    const groups = new Map();
    // a hit belongs to the bar of the line it was aiming at (an early downbeat is still that bar's)
    for (const h of hits) { const k = barOf(h.g != null ? h.g : h.t); if (k < 0) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h); }
    const out = [];
    for (const [k, hs] of [...groups].sort((a, b) => a[0] - b[0])) {
      const e = hs.map((h) => h.errMs); const abs = e.map(Math.abs);
      out.push({ bar: k + 1, start: bars[k], n: hs.length, meanMs: r1(mean(e)), medianMs: r1(median(e)), absMs: r1(mean(abs)), worstMs: r1(e.reduce((w, x) => (Math.abs(x) > Math.abs(w) ? x : w), 0)), hits: hs.map((h) => ({ t: h.t, errMs: r1(h.errMs) })) });
    }
    const all = hits.map((h) => h.errMs); const med = median(all); const mad = median(all.map((x) => Math.abs(x - med)));
    const meanAbs = mean(all.map(Math.abs)); const late = all.length ? all.filter((x) => x > 0).length / all.length : 0;
    const overall = {
      n: all.length, medianMs: r1(med), meanAbsMs: r1(meanAbs), spreadMs: r1(mad), lateShare: Math.round(late * 100) / 100,
      rushDrag: Math.abs(med) < 8 ? 'even' : med > 0 ? 'late' : 'early',
      offsetLikely: all.length >= 8 && Math.abs(med) >= 12 && mad <= 10,
      worstBars: out.slice().sort((a, b) => b.absMs - a.absMs).slice(0, 3).map((b) => ({ bar: b.bar, absMs: b.absMs, meanMs: b.meanMs })),
    };
    const grade = !all.length ? 'ok' : meanAbs < 15 ? 'tight' : meanAbs < 35 ? 'ok' : 'loose';
    return { bars: out, overall, grade };
  }
  // onsets: [{t (song s), strength}], gridTimes (song s), barStarts (song s)
  function report({ onsets, gridTimes, barStarts, minStrength = 0.25, window = 0.09 } = {}) {
    const grid = (gridTimes || []).slice().sort((a, b) => a - b);
    const list = onsets || []; const maxS = list.reduce((m, o) => Math.max(m, o.strength == null ? 1 : o.strength), 0) || 1;
    const hits = [];
    for (const o of list) {
      if ((o.strength == null ? 1 : o.strength) < minStrength * maxS) continue;
      const g = grid.length ? nearestOf(grid, o.t) : null; if (g == null) continue;
      const d = o.t - g; if (Math.abs(d) > window) continue;   // fills / ghost notes far from any line don't count
      hits.push({ t: o.t, g, errMs: d * 1000 });
    }
    return build(hits, barStarts);
  }
  // MIDI: every note counts
  function reportNotes({ notes, gridTimes, barStarts, window = 0.09 } = {}) {
    return report({ onsets: (notes || []).map((n) => ({ t: n.t, strength: 1 })), gridTimes, barStarts, minStrength: 0, window });
  }
  function summaryText(rep, { fmtBar = (b) => `bar ${b}` } = {}) {
    if (!rep || !rep.overall || !rep.overall.n) return 'no hits near the grid';
    const o = rep.overall; const where = o.rushDrag === 'even' ? 'on the grid on average' : `mostly ${Math.abs(o.medianMs).toFixed(0)} ms ${o.rushDrag}`;
    const worst = o.worstBars.filter((b) => b.absMs >= 10).map((b) => `${fmtBar(b.bar)} (${b.absMs.toFixed(0)} ms)`).join(', ');
    return `${where} · ${rep.grade}${o.offsetLikely ? ' · looks like a fixed offset' : ''}${worst ? ` · worst: ${worst}` : ''}`;
  }
  // one bar per song bar: height = mean |error|, warm = late, cool = early; works with any 2D context
  function barChart(ctx, rep, { w = 300, h = 60, maxMs = 60 } = {}) {
    if (!ctx || !rep || !rep.bars) return;
    const bars = rep.bars; const n = bars.length; if (!n) return;
    if (ctx.clearRect) ctx.clearRect(0, 0, w, h);
    const bw = Math.max(1, (w - (n - 1)) / n); const base = h - 2;
    for (let i = 0; i < n; i++) {
      const b = bars[i]; const hh = Math.max(1, Math.min(base, base * Math.min(maxMs, b.absMs) / maxMs)); const x = i * (bw + 1);
      ctx.fillStyle = b.meanMs > 4 ? '#e5b04b' : b.meanMs < -4 ? '#5b8def' : '#4caf7d';
      if (typeof ctx.roundRect === 'function' && ctx.beginPath && ctx.fill) { ctx.beginPath(); ctx.roundRect(x, base - hh, bw, hh, 1); ctx.fill(); }
      else if (ctx.fillRect) ctx.fillRect(x, base - hh, bw, hh);
    }
    if (ctx.fillRect) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(0, base, w, 1); }
  }
  return { report, reportNotes, summaryText, barChart };
});
