// Comping: build one performance from several takes on a track. comp(clips, keepId, a, b) makes the kept take the only
// one heard between a and b; outside that range everything plays exactly as before. Takes are split (sharing their
// audio file), never re-rendered, so a comp can be undone or re-done from any take at any time.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPComp = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // c: {id, start, trimStart, trimEnd, src?, kind?, notes?}; full: the audio file's length; returns [left, right]
  function split(c, at, { full, newId, audioId }) {
    const leftLen = at - c.start;
    const left = { ...c, trimEnd: Math.max(0, full - c.trimStart - leftLen), fadeOut: 0 };
    const right = { ...JSON.parse(JSON.stringify(c)), id: newId(), start: at, trimStart: c.trimStart + leftLen, fadeIn: 0 };
    if (c.kind === 'midi') { left.notes = (c.notes || []).filter((n) => n.t - c.trimStart < leftLen); right.notes = (c.notes || []).filter((n) => n.t - c.trimStart >= leftLen); delete right.src; }
    else right.src = audioId ? audioId(c) : (c.src || c.id);
    return [left, right];
  }
  // clips: one track's clips (linked mirrors — c.link — are left alone: they follow their room)
  // opts: len(c) audible length, full(c) file length, newId(), audioId(c), xfade (s) short fades at the comp edges
  function comp(clips, keepId, a, b, { len, full, newId, audioId, xfade = 0.008 } = {}) {
    if (!(b > a)) return { clips, changed: 0 };
    const out = []; let changed = 0; const eps = 0.02;
    for (const c0 of clips) {
      if (c0.link || c0.deleted) { out.push(c0); continue; }
      const s = c0.start, e = c0.start + len(c0);
      if (e <= a + eps || s >= b - eps) { out.push(c0); continue; }   // doesn't reach the range
      const keep = c0.id === keepId || (keepId && String(c0.compOf || '') === String(keepId));
      const inRange = keep ? false : true;   // what the middle piece should be: muted (others) / playing (keeper)
      if (keep === false && c0.mute) { out.push(c0); continue; }      // already silent there
      let pieces = [c0]; const f = full(c0);
      if (s < a - eps) { const [l, r] = split(pieces.pop(), a, { full: f, newId, audioId }); pieces.push(l, r); }
      const last = pieces[pieces.length - 1];
      if (last.start + len(last) > b + eps) { const [l, r] = split(pieces.pop(), b, { full: f, newId, audioId }); pieces.push(l, r); }
      for (const p of pieces) {
        const ps = p.start, pe = p.start + len(p);
        if (ps >= a - eps && pe <= b + eps) {
          if (keep) { if (p.mute) changed++; p.mute = false; p.fadeIn = Math.max(p.fadeIn || 0, ps > a - eps && s < a - eps ? xfade : 0); p.fadeOut = Math.max(p.fadeOut || 0, pe < b + eps && e > b + eps ? xfade : 0); }
          else if (inRange) { if (!p.mute) changed++; p.mute = true; }
        } else if (!keep) {   // the parts of other takes either side of the range: tiny fade where the keeper takes over
          if (pe <= a + eps) p.fadeOut = Math.max(p.fadeOut || 0, xfade);
          if (ps >= b - eps) p.fadeIn = Math.max(p.fadeIn || 0, xfade);
        }
      }
      if (pieces.length > 1) changed++;
      out.push(...pieces);
    }
    return { clips: out, changed };
  }
  // the punch-in window as trims of a take recorded from rawStart (the whole capture stays in the file as handles)
  function punchTrim(clip, fileLen, a, b, xfade = 0.008) {
    const rawStart = clip.start - (clip.trimStart || 0);
    const ts = Math.max(0, a - rawStart), te = Math.max(0, rawStart + fileLen - b);
    if (ts + te >= fileLen - 0.02) return null;   // stopped before the punch-in: nothing in the window
    return { ...clip, start: rawStart + ts, trimStart: ts, trimEnd: te, fadeIn: xfade, fadeOut: xfade };
  }
  return { split, comp, punchTrim };
});
