// Lyric + chord chart (plain text, chords over the words they land on), from the timed lyrics and chords.
// Used for "Share this part", the DAW export README and the Lyrics tab's copy/print.
(function (root, factory) {
  const api = factory(() => (typeof module === 'object' && module.exports ? require('./karaoke.js') : root.BPKaraoke));   // looked up on use: script order doesn't matter
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPChart = api;
})(typeof self !== 'undefined' ? self : this, function (getK) {
  'use strict';
  const live = (a) => (Array.isArray(a) ? a.filter((x) => x && !x.deleted) : []);
  // a chord row above a word row: each chord starts over the first letter of its word
  function overUnder(line) {
    let words = '', chords = '';
    line.words.forEach((w, i) => {
      const at = words.length; const cs = line.chords.filter((c) => c.wi === i).map((c) => c.chord);
      if (cs.length) { const label = cs.join(' '); if (chords.length > at) chords += ' '; chords = chords.padEnd(Math.max(at, chords.length), ' ') + label; }
      words += (i ? ' ' : '') + w.w;
      if (chords.length > words.length) words = words.padEnd(chords.length, ' ');   // keep a long chord name from overrunning the next one
    });
    return [chords.trimEnd(), words.trimEnd()].filter((x, i) => i === 1 || x);
  }
  // song: {sections, lyrics, chords, notes}; from/to (s) limit it to a stretch; linkInfo: TPL.linkInfo (copies' words)
  function chart(song, { from = -Infinity, to = Infinity, linkInfo = null, title = null, notes = true, fmtTime = null } = {}) {
    const ls = getK().lines(song, { linkInfo }).filter((l) => l.time >= from - 1e-6 && l.time < to - 1e-6);
    const secs = live(song.sections).filter((s) => s.end > from + 1e-6 && s.start < to - 1e-6).sort((a, b) => a.start - b.start);
    const chords = live(song.chords).filter((c) => typeof c.time === 'number' && c.time >= from - 1e-6 && c.time < to - 1e-6).sort((a, b) => a.time - b.time);
    const out = []; if (title) out.push(title, '='.repeat(Math.min(60, title.length)), '');
    const blocks = secs.length ? secs.map((s) => ({ name: s.name, a: Math.max(s.start, from), z: Math.min(s.end, to), s })) : [{ name: null, a: from, z: to }];
    for (const b of blocks) {
      if (b.name) out.push(`[${b.name}]${b.s && b.s.key ? ` (key ${b.s.key})` : ''}${b.s && b.s.bpm ? ` ${b.s.bpm} bpm` : ''}`);
      const mine = ls.filter((l) => l.time >= b.a - 1e-6 && l.time < b.z - 1e-6);
      if (mine.length) for (const l of mine) out.push(...overUnder(l));
      else { const cs = chords.filter((c) => c.time >= b.a - 1e-6 && c.time < b.z - 1e-6).map((c) => c.chord); out.push(cs.length ? `| ${cs.join(' | ')} |` : '(instrumental)'); }
      out.push('');
    }
    if (notes) {
      const ns = live(song.markers).filter((n) => !n.resolved && n.time >= from - 1e-6 && n.time < to - 1e-6);
      if (ns.length) { out.push('Notes'); for (const n of ns) out.push(`- ${fmtTime ? `${fmtTime(n.time)} ` : ''}${n.by ? `${n.by}: ` : ''}${n.text}`); out.push(''); }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  return { chart, overUnder };
});
