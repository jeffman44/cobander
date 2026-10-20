// "What changed since I last opened this": who did what (the song's activity log), which takes are new, and which
// parts' words / chords changed (a diff against the save that was current when I last had the song open).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPChanges = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const live = (a) => (Array.isArray(a) ? a.filter((x) => x && !x.deleted) : []);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const secAt = (song, t) => live(song && song.sections).find((s) => t >= s.start - 1e-6 && t < s.end - 1e-6) || null;
  // words per part, keyed by section id (lines outside any part: '')
  function wordsByPart(song) {
    const out = new Map();
    for (const l of live(song && song.lyrics)) { if (typeof l.time !== 'number' || !String(l.text || '').trim()) continue; const s = secAt(song, l.time); const k = s ? s.id : ''; if (!out.has(k)) out.set(k, { name: s ? s.name : 'Lyrics', lines: [] }); out.get(k).lines.push([l.time, String(l.text).trim()]); }
    for (const v of out.values()) v.text = v.lines.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' / ');
    return out;
  }
  function chordsByPart(song) {
    const out = new Map();
    for (const c of live(song && song.chords)) { const s = secAt(song, c.time); const k = s ? s.id : ''; if (!out.has(k)) out.set(k, { name: s ? s.name : 'song', seq: [] }); out.get(k).seq.push([c.time, c.chord]); }
    for (const v of out.values()) v.text = v.seq.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ');
    return out;
  }
  // old: the song as I last saw it (or null); cur: now; since: ISO time I last had it open; me: my name
  function summarize(old, cur, { since, me } = {}) {
    const res = { since, people: [], freshClips: [], lyrics: [], chords: [], notes: 0, any: false };
    if (!since || !cur) return res;
    const mine = (n) => same(n, me);
    const by = new Map();
    for (const a of live(cur.activity)) { if (!a.at || String(a.at) <= since || mine(a.by)) continue; const k = a.by || 'Someone'; if (!by.has(k)) by.set(k, []); for (const it of a.items || []) if (!by.get(k).includes(it)) by.get(k).push(it); }
    res.people = [...by].map(([name, items]) => ({ name, items }));
    const oldIds = old ? new Set(live(old.tracks).flatMap((t) => live(t.clips).map((c) => c.id))) : null;
    for (const t of live(cur.tracks)) for (const c of live(t.clips)) {
      if (c.link) continue;
      const fresh = oldIds ? !oldIds.has(c.id) && !mine(c.takenBy) : (c.takenAt && String(c.takenAt) > since && !mine(c.takenBy));
      if (fresh) res.freshClips.push({ id: c.id, trackId: t.id, track: t.name, name: c.name, by: c.takenBy || null, start: c.start });
    }
    res.freshClips.sort((a, b) => a.start - b.start);
    if (old) {
      const wo = wordsByPart(old), wn = wordsByPart(cur);
      for (const [k, v] of wn) { const o = wo.get(k); if (!o || o.text !== v.text) res.lyrics.push({ part: v.name, sectionId: k || null, before: o ? o.text : '', after: v.text }); }
      for (const [k, o] of wo) if (!wn.has(k)) res.lyrics.push({ part: o.name, sectionId: k || null, before: o.text, after: '' });
      const co = chordsByPart(old), cn = chordsByPart(cur);
      for (const [k, v] of cn) { const o = co.get(k); if (!o || o.text !== v.text) res.chords.push({ part: v.name, before: o ? o.text : '', after: v.text }); }
    }
    for (const n of live(cur.markers)) {   // timeline notes live in song.markers (song.notes is the free-text pad)
      if (!mine(n.by) && n.at && String(n.at) > since) res.notes++; for (const r of live(n.replies)) if (!mine(r.by) && r.at && String(r.at) > since) res.notes++; }
    res.any = !!(res.people.length || res.freshClips.length || res.lyrics.length || res.chords.length || res.notes);
    return res;
  }
  // one short paragraph for a toast
  function text(r, { max = 5 } = {}) {
    if (!r || !r.any) return '';
    const bits = r.people.map((p) => `${p.name}: ${p.items.slice(0, max).join(', ')}${p.items.length > max ? ` +${p.items.length - max} more` : ''}`);
    if (!bits.length && r.freshClips.length) bits.push(`${r.freshClips.length} new take${r.freshClips.length > 1 ? 's' : ''}`);
    if (r.lyrics.length) bits.push(`words changed in ${[...new Set(r.lyrics.map((x) => x.part))].join(', ')}`);
    if (r.chords.length) bits.push(`chords changed in ${[...new Set(r.chords.map((x) => x.part))].join(', ')}`);
    if (r.notes) bits.push(`${r.notes} new note${r.notes > 1 ? 's' : ''}/repl${r.notes > 1 ? 'ies' : 'y'}`);
    return bits.join(' · ');
  }
  return { summarize, text, wordsByPart };
});
