// Collaboration data that lives in song.json next to the tracks. Pure functions, no DOM, no Electron:
// loaded by the renderer (window.BPCollab) and by the main process / unit tests (require).
//
// Every collection is an array of entries keyed by `id`. Entries are never removed, only soft-deleted
// (`deleted: true`), so two bandmates' saves merge cleanly:
//   markers   timeline notes          {id, trackId|null, time, text, by, at, replies[], resolved?:{by,at}, deleted?}
//   reactions emoji on a target       {id, target:'song'|trackId|clipId, emoji, by, at, deleted?}
//   sections  song structure blocks   {id, name, start, end, color?, by, at, deleted?}         (seconds)
//   chords    chord lane              {id, time, chord, by, at, deleted?}
//   lyrics    timed lyric lines       {id, time|null, text, by, at, deleted?}                  (null = not pinned yet)
//   needs     "needs ..." checklist   {id, text, by, at, done?:{by,at}|null, deleted?}
//   votes     take stars              {id, clipId, by, at, deleted?}
//   ideas     scratchpad sketches     {id, title, kind:'audio'|'text', audioId?, seconds?, text?, by, at, deleted?}
//   versions  named snapshots         {id, name, by, at, rev, deleted?}   (body in <song>/versions/<id>.json)
//   activity  who did what            {id, by, at, items:[string]}       (newest last, capped)
//   stages    where each part is at    {id:'stg-<trackId>', trackId, stage, redo?:{text,by,at}|null, by, at}   (one per track;
//             anyone in the band can set it — it goes through the mailbox like notes, no lock needed)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPCollab = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLLECTIONS = ['markers', 'reactions', 'sections', 'chords', 'lyrics', 'needs', 'votes', 'ideas', 'versions', 'activity', 'tabs', 'stages'];
  const NESTED = { markers: 'replies' };   // entry arrays inside entries, merged the same way
  const ACTIVITY_CAP = 400;
  const SECTION_NAMES = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Post-chorus', 'Bridge', 'Solo', 'Breakdown', 'Hook', 'Build', 'Drop', 'Outro'];
  const SECTION_COLORS = { intro: '#7c8597', verse: '#4f8cd6', 'pre-chorus': '#8a6fd6', chorus: '#e07a3e', bridge: '#3fae8c', solo: '#d6b13f', breakdown: '#c2504f', outro: '#7c8597', 'post-chorus': '#c9683a', 'half chorus': '#e07a3e', 'double chorus': '#e07a3e', hook: '#e07a3e', build: '#8a6fd6', drop: '#c2504f' };

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const live = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && !x.deleted) : []);
  const list = (song, key) => (song && Array.isArray(song[key]) ? song[key] : []);

  // ---------- merge ----------
  // Three-way merge of one entry, field by field: a field I did not change since `base` takes their value;
  // a field we both changed keeps mine. `deleted` is sticky (either side deleting wins). Nested entry arrays
  // (note replies) are merged recursively, so two people replying at once both keep their reply.
  let conflicts = null;   // filled during mergeCollections: fields both people changed differently (mine was kept)
  function mergeEntry(mine, theirs, base, nestedKey) {
    const out = clone(mine);
    const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
    for (const k of keys) {
      if (k === 'id') continue;
      if (k === nestedKey) { out[k] = mergeList(mine[k], theirs[k], base && base[k], null); continue; }
      if (k === 'deleted') { if (mine.deleted || theirs.deleted) out.deleted = true; continue; }
      const mineChanged = !base ? false : !same(mine[k], base[k]);
      if (!base) { if (mine[k] === undefined) out[k] = clone(theirs[k]); continue; }   // no common ancestor: keep mine, fill gaps from theirs
      if (mineChanged && conflicts && !same(theirs[k], base[k]) && !same(theirs[k], mine[k]) && !/^(at|by|deletedBy|deletedAt)$/.test(k)) conflicts.push({ k, mine: mine[k], theirs: theirs[k], text: mine.text || mine.name || mine.chord || theirs.text || theirs.name || '' });
      if (!mineChanged && !same(theirs[k], base[k])) { if (theirs[k] === undefined) delete out[k]; else out[k] = clone(theirs[k]); }
    }
    if (out.deleted) {
      for (const k of ['deletedBy', 'deletedAt']) if (out[k] === undefined && theirs[k] !== undefined) out[k] = theirs[k];
    }
    return out;
  }
  function mergeList(mineArr, theirArr, baseArr, nestedKey) {
    const mine = Array.isArray(mineArr) ? mineArr : [];
    const theirs = Array.isArray(theirArr) ? theirArr : [];
    const base = new Map((Array.isArray(baseArr) ? baseArr : []).map((x) => [x.id, x]));
    const out = mine.map(clone);
    const at = new Map(out.map((x, i) => [x.id, i]));
    for (const t of theirs) {
      if (!t || !t.id) continue;
      if (!at.has(t.id)) {
        if (base.has(t.id)) continue;   // was in the common ancestor and I no longer have it at all: I removed it outright; stays removed
        at.set(t.id, out.length); out.push(clone(t)); continue;
      }
      const i = at.get(t.id);
      out[i] = mergeEntry(out[i], t, base.get(t.id), nestedKey);
    }
    return out;
  }
  // Merge every collaboration collection of `theirs` into `mine` (in place). Returns human strings for what came from them.
  function mergeCollections(mine, theirs, baseline) {
    const kept = []; const clash = [];
    for (const key of COLLECTIONS) {
      conflicts = key === 'activity' ? null : [];
      const before = new Set(list(mine, key).map((x) => x.id));
      const merged = mergeList(list(mine, key), list(theirs, key), list(baseline, key), NESTED[key] || null);
      if (key === 'activity') merged.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      mine[key] = key === 'activity' ? merged.slice(-ACTIVITY_CAP) : merged;
      // someone replied after the note was resolved (we did both at once): the thread is open again, so the reply's @mention shows
      if (key === 'markers') for (const m of mine[key]) if (m && m.resolved && live(m.replies).some((r) => String(r.at) > String(m.resolved.at))) delete m.resolved;
      if (conflicts && conflicts.length) for (const c of conflicts) clash.push(`${key.replace(/s$/, '')}${c.text ? ` "${String(c.text).slice(0, 24)}"` : ''} (${c.k})`);
      conflicts = null;
      const added = merged.filter((x) => !before.has(x.id) && !x.deleted);
      if (!added.length) continue;
      if (key === 'markers') for (const m of added) kept.push(`note "${String(m.text).slice(0, 30)}"`);
      else if (key === 'sections') kept.push(`${added.length} section${added.length > 1 ? 's' : ''}`);
      else if (key === 'chords') kept.push(`${added.length} chord${added.length > 1 ? 's' : ''}`);
      else if (key === 'lyrics') kept.push(`${added.length} lyric line${added.length > 1 ? 's' : ''}`);
      else if (key === 'needs') kept.push(`${added.length} "needs" item${added.length > 1 ? 's' : ''}`);
      else if (key === 'ideas') kept.push(`${added.length} idea${added.length > 1 ? 's' : ''}`);
      else if (key === 'stages') kept.push(`${added.length} part stage${added.length > 1 ? 's' : ''}`);
      else if (key === 'versions') kept.push(`version ${added.map((v) => `"${v.name}"`).join(', ')}`);
    }
    if (clash.length) kept.push(`⚠ you both changed the same thing — yours was kept: ${clash.slice(0, 4).join(', ')}${clash.length > 4 ? ` +${clash.length - 4} more` : ''}`);
    return kept;
  }

  // ---------- activity ----------
  // Typed events: every activity line is also counted by kind, so stats / XP / levels can be computed later
  // from song.json alone (no free-text parsing at read time). Order matters: first match wins.
  const EVENT_KINDS = [
    ['undo', /^(undid|redo)/i], ['rollback', /^rolled back|^restored version/i], ['version', /^tagged version/i],
    ['take', /^(recorded|imported|record take|loop record)/i], ['idea', /^idea\b|sketch/i],
    ['reply', /^repl(y|ied)/i], ['resolve', /resolved|reopened/i], ['note', /\bnote\b/i], ['reaction', /^react|emoji/i],
    ['vote', /★|^unstarred|\bstar/i], ['section', /section/i], ['chord', /chord/i], ['lyric', /lyric/i], ['need', /^needs?\b|^done:|^not done:/i],
    ['track', /track/i], ['mix', /\b(fader|pan|gain|fx|preset|eq|comp|reverb|delay|amp|cab|limiter|mute|solo)\b/i], ['tempo', /tempo|time signature/i],
    ['edit', /./],
  ];
  function eventKind(label) { const s = String(label || ''); for (const [k, re] of EVENT_KINDS) if (re.test(s)) return k; return 'edit'; }
  function eventKinds(items) { const out = {}; for (const it of items || []) { const k = eventKind(it); out[k] = (out[k] || 0) + 1; } return out; }

  function activityEntry(items, by, at, id) {
    const seen = new Set(); const clean = [];
    for (const it of items || []) { const s = String(it || '').trim(); if (!s || s === 'change' || seen.has(s)) continue; seen.add(s); clean.push(s.slice(0, 120)); }
    if (!clean.length) return null;
    const shown = clean.slice(0, 12); if (clean.length > 12) shown.push(`+${clean.length - 12} more`);
    return { id, by: by || 'someone', at: at || new Date().toISOString(), items: shown, kinds: eventKinds(clean) };
  }
  function pushActivity(song, entry) {
    if (!entry) return;
    const a = song.activity = list(song, 'activity');
    a.push(entry); if (a.length > ACTIVITY_CAP) a.splice(0, a.length - ACTIVITY_CAP);
  }
  const feed = (song) => list(song, 'activity').slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // ---------- @mentions ----------
  // "@Kat" or "@Kat Smith" (a name with a space only matches when that full name is known).
  function mentionsIn(text, knownNames = []) {
    const out = new Set(); const t = String(text || '');
    const known = [...new Set(knownNames.filter(Boolean))].sort((a, b) => b.length - a.length);
    const re = /(^|[^\w@])@([\p{L}\p{N}_.'-]+(?: [\p{L}\p{N}_.'-]+)?)/gu;
    let m;
    while ((m = re.exec(t))) {
      const raw = m[2].replace(/[.'-]+$/, '');
      const hit = known.find((n) => raw.toLowerCase().startsWith(n.toLowerCase()) && (raw.length === n.length || raw[n.length] === ' '));
      out.add(hit || raw.split(' ')[0]);
    }
    return [...out];
  }
  const nameMatch = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  // Unresolved notes (or replies) that mention `user`, written by someone else, optionally newer than `since`.
  function mentionsFor(song, user, { since = null, knownNames = [] } = {}) {
    if (!user) return [];
    const out = [];
    for (const m of live(list(song, 'markers'))) {
      if (m.resolved) continue;
      const items = [{ text: m.text, by: m.by, at: m.at, note: m }, ...live(m.replies).map((r) => ({ text: r.text, by: r.by, at: r.at, note: m, reply: r }))];
      for (const it of items) {
        if (nameMatch(it.by, user)) continue;
        if (since && String(it.at || '') <= String(since)) continue;
        if (mentionsIn(it.text, knownNames).some((n) => nameMatch(n, user))) out.push(it);
      }
    }
    return out;
  }
  // Everyone this song knows about (for @-completion and matching multi-word names).
  // Open "needs" items assigned to a person (who field, or an @mention of them in the text).
  function needsFor(song, me, knownNames = []) {
    return needsOpen(song).filter((n) => (n.who && nameMatch(n.who, me)) || mentionsIn(n.text, knownNames).some((x) => nameMatch(x, me)));
  }
  function knownPeople(song, extra = []) {
    const s = new Set(extra.filter(Boolean));
    const add = (x) => { if (x) s.add(String(x)); };
    add(song && song.savedBy);
    for (const t of list(song, 'tracks')) for (const c of t.clips || []) add(c.takenBy);
    for (const k of COLLECTIONS) for (const e of list(song, k)) { add(e.by); for (const r of e.replies || []) add(r.by); }
    return [...s].sort((a, b) => a.localeCompare(b));
  }

  // ---------- needs ----------
  const needsOpen = (song) => live(list(song, 'needs')).filter((n) => !n.done);

  // ---------- part stages ----------
  // How far along each part (track) is. Order matters: the rollup counts 'approved' as done.
  const PART_STAGES = [
    { k: 'idea', icon: '💡', label: 'Idea', tip: 'A riff or a line exists — nothing committed yet' },
    { k: 'writing', icon: '✍️', label: 'Writing', tip: 'Working the part out; scratch takes are fine' },
    { k: 'demo', icon: '🎙', label: "Demo'd", tip: 'A rough take good enough for the others to write against' },
    { k: 'tracking', icon: '⏺', label: 'Tracking', tip: 'Recording the keeper takes' },
    { k: 'editing', icon: '✂️', label: 'Editing', tip: 'Comping the best bits, tightening timing and tuning' },
    { k: 'mixing', icon: '🎚', label: 'Mixing', tip: 'Level, tone and FX for this part' },
    { k: 'review', icon: '👂', label: 'Ready for review', tip: 'Done from your side — the band listens and leaves notes' },
    { k: 'approved', icon: '✅', label: 'Approved', tip: 'The band signed off. Changing the takes sends it back to review' },
  ];
  const STAGE_KEYS = PART_STAGES.map((x) => x.k);
  const stageInfo = (k) => PART_STAGES.find((x) => x.k === k) || null;
  const stageId = (trackId) => `stg-${trackId}`;
  const partStage = (song, trackId) => live(list(song, 'stages')).find((x) => x.trackId === trackId) || null;
  // set (or clear) a part's stage in place; returns the entry. `redo`: string = flag it, null = clear the flag, undefined = leave it.
  function setPartStage(song, trackId, { stage, redo, by, at } = {}) {
    if (stage !== undefined && stage !== null && !STAGE_KEYS.includes(stage)) throw new Error(`stage must be one of ${STAGE_KEYS.join(' | ')}`);
    const arr = song.stages = list(song, 'stages');
    const id = stageId(trackId); let e = arr.find((x) => x.id === id);
    const now = at || new Date().toISOString();
    if (!e) { e = { id, trackId, stage: null, redo: null, by, at: now }; arr.push(e); }
    delete e.deleted;
    if (stage !== undefined) e.stage = stage || null;
    if (redo !== undefined) e.redo = redo ? { text: String(redo).slice(0, 200), by, at: now } : null;
    e.by = by; e.at = now;
    return e;
  }
  // song-list rollup over the tracks that exist: {total, approved, staged, redo, counts:{stage:n}}
  function stageRollup(song) {
    const ids = new Set(list(song, 'tracks').map((t) => t && t.id).filter(Boolean));
    const out = { total: ids.size, approved: 0, staged: 0, redo: 0, counts: {} };
    for (const e of live(list(song, 'stages'))) {
      if (!ids.has(e.trackId)) continue;
      if (e.redo) out.redo++;
      if (!e.stage) continue;
      out.staged++; out.counts[e.stage] = (out.counts[e.stage] || 0) + 1;
      if (e.stage === 'approved') out.approved++;
    }
    return out;
  }

  // ---------- votes ----------
  const votesFor = (song, clipId) => live(list(song, 'votes')).filter((v) => v.clipId === clipId);
  // Among `clipIds` (one overlap group), the take with the most stars, or null on a tie / no votes.
  function topVoted(song, clipIds) {
    let best = null, bestN = 0, tie = false;
    for (const id of clipIds) { const n = votesFor(song, id).length; if (n > bestN) { best = id; bestN = n; tie = false; } else if (n === bestN && n > 0) tie = true; }
    return tie || !bestN ? null : best;
  }

  // ---------- time lookups ----------
  const byTime = (arr) => live(arr).filter((x) => typeof x.time === 'number').sort((a, b) => a.time - b.time);
  function sectionAt(song, t) { const s = live(list(song, 'sections')).filter((x) => t >= x.start - 1e-6 && t < x.end - 1e-6).sort((a, b) => b.start - a.start); return s[0] || null; }
  function lastAtOrBefore(arr, t) { let hit = null; for (const x of arr) { if (x.time <= t + 1e-6) hit = x; else break; } return hit; }
  const chordAt = (song, t) => lastAtOrBefore(byTime(list(song, 'chords')), t);
  const lyricAt = (song, t) => lastAtOrBefore(byTime(list(song, 'lyrics')), t);
  const sectionColor = (name) => { const n = String(name || '').toLowerCase().replace(/\s*\d+$/, ''); return SECTION_COLORS[n] || SECTION_COLORS[n.replace(/^(half|double|big|last|final|quiet|loud)\s+/, '')] || '#6b7a99'; };
  // "Verse" → "Verse 2" if a Verse already exists.
  function nextSectionName(song, base) {
    const taken = new Set(live(list(song, 'sections')).map((s) => s.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 100; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
    return base;
  }

  // ---------- chords ----------
  // "G D Em C" or "G | D | Em C" → one chord per bar (a bar with two chords splits it evenly).
  function parseChordBars(text) {
    const bars = String(text || '').split('|').map((b) => b.trim()).filter(Boolean);
    const out = [];
    if (bars.length > 1) bars.forEach((b, i) => { const cs = b.split(/\s+/).filter(Boolean); cs.forEach((c, j) => out.push({ bar: i, frac: j / cs.length, chord: c })); });
    else String(text || '').split(/[\s,]+/).filter(Boolean).forEach((c, i) => out.push({ bar: i, frac: 0, chord: c }));
    return out.filter((x) => /^[A-G][#b]?[^\s]{0,10}$|^N\.?C\.?$|^%$/.test(x.chord));
  }

  // ---------- presence ----------
  const PRESENCE_WORDS = { editing: 'editing', listening: 'listening', recording: 'recording', playing: 'listening' };
  function presenceLine(people, me) {
    const others = (people || []).filter((p) => !p.stale && !(me && nameMatch(p.user, me.user) && p.host === me.host));
    if (!others.length) return '';
    return others.map((p) => `${p.user} is ${p.mode === 'waiting' ? 'waiting to edit' : p.mode === 'recording' ? 'recording' : p.mode === 'editing' ? (p.playing ? 'playing it back' : 'editing') : p.playing ? 'listening now' : 'looking at it'}`).join(' · ');
  }

  return {
    COLLECTIONS, ACTIVITY_CAP, SECTION_NAMES, PRESENCE_WORDS,
    clone, live, list,
    mergeEntry, mergeList, mergeCollections,
    activityEntry, pushActivity, feed, eventKind, eventKinds, EVENT_KINDS,
    mentionsIn, mentionsFor, knownPeople, nameMatch,
    needsOpen, needsFor, votesFor, topVoted,
    PART_STAGES, STAGE_KEYS, stageInfo, stageId, partStage, setPartStage, stageRollup,
    sectionAt, chordAt, lyricAt, byTime, sectionColor, nextSectionName,
    parseChordBars, presenceLine,
  };
});
