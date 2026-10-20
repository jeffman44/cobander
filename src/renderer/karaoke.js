// Karaoke / practice view model: every sung line of the song with word timings and the chords over it.
// Lines come from the timed lyrics; a line typed by hand (no word timings) gets its words spread across the line.
// Linked copies of a part (Chorus 2, 3 …) with no lyrics of their own show the room's lines at their own time.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPKaraoke = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const live = (a) => (Array.isArray(a) ? a.filter((x) => x && !x.deleted) : []);
  // song: {lyrics, sections, chords, linkGroups}; linkInfo: TPL.linkInfo; end: song length
  function lines(song, { linkInfo = null, end = null } = {}) {
    const own = live(song.lyrics).filter((l) => typeof l.time === 'number' && String(l.text || '').trim()).map((l) => ({ id: l.id, time: l.time, text: String(l.text), words: Array.isArray(l.words) && l.words.length ? l.words.map((w) => ({ w: w.w, t: l.time + Number(w.t), e: l.time + Number(w.e) })) : null, ghost: false }));   // stored relative to the line
    const out = own.slice();
    if (linkInfo) {
      for (const g of Object.values(linkInfo(song) || {})) {
        const room = g.room; const inRoom = own.filter((l) => l.time >= room.start - 1e-6 && l.time < room.end - 1e-6);
        if (!inRoom.length) continue;
        for (const f of g.followers) {
          if (own.some((l) => l.time >= f.start - 1e-6 && l.time < f.end - 1e-6)) continue;   // that copy has its own words
          const d = f.start - room.start;
          for (const l of inRoom) if (l.time - room.start < f.end - f.start) out.push({ id: `${l.id}@${f.id}`, time: l.time + d, text: l.text, words: l.words ? l.words.map((w) => ({ w: w.w, t: w.t + d, e: w.e + d })) : null, ghost: true });
        }
      }
    }
    out.sort((a, b) => a.time - b.time);
    const chords = live(song.chords).filter((c) => typeof c.time === 'number').sort((a, b) => a.time - b.time);
    const secs = live(song.sections).slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length; i++) {
      const l = out[i]; const next = out[i + 1];
      const sec = secs.find((s) => l.time >= s.start - 1e-6 && l.time < s.end - 1e-6) || null;
      const lineEnd = Math.min(next ? next.time : Infinity, sec ? sec.end : Infinity, end != null ? end : Infinity, l.time + 8);
      if (!l.words || !l.words.length) {   // spread the words over the line (longer words get more time)
        const ws = l.text.split(/\s+/).filter(Boolean); const span = Math.max(0.6, (Number.isFinite(lineEnd) ? lineEnd : l.time + 3) - l.time) * 0.9;
        const weights = ws.map((w) => 1 + w.replace(/[^a-z]/gi, '').length * 0.15); const tot = weights.reduce((a, b) => a + b, 0) || 1; let t = l.time;
        l.words = ws.map((w, k) => { const d = span * weights[k] / tot; const x = { w, t, e: t + d }; t += d; return x; });
        l.spread = true;
      }
      l.end = Math.max(l.words[l.words.length - 1].e, l.time + 0.3);
      l.section = sec ? sec.name : null; l.sectionId = sec ? sec.id : null;
      // chords that start inside the line, attached to the word sung at that moment (or the first word for a chord just before it)
      const from = i === 0 ? -Infinity : l.time - 0.25;
      l.chords = chords.filter((c) => c.time >= from && c.time < (next ? next.time - 0.25 : l.end + 0.5)).map((c) => {
        let wi = l.words.findIndex((w) => w.t > c.time + 0.05) - 1; if (wi < 0) wi = c.time < l.words[0].t ? 0 : l.words.length - 1;
        return { chord: c.chord, t: c.time, wi };
      });
    }
    return out;
  }
  // which line / word is being sung at t (and the next line, and seconds until it)
  function at(ls, t) {
    let i = -1; for (let k = 0; k < ls.length; k++) { if (ls[k].time <= t + 1e-3) i = k; else break; }
    const cur = i >= 0 ? ls[i] : null; const next = ls[i + 1] || null;
    let wi = -1; if (cur) for (let k = 0; k < cur.words.length; k++) if (cur.words[k].t <= t + 1e-3) wi = k;
    const active = cur && t <= cur.end + 1.2;
    return { i, cur: active ? cur : null, wi: active ? wi : -1, next, untilNext: next ? next.time - t : null };
  }
  return { lines, at };
});
