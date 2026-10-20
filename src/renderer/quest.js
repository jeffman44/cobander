// Cobander's game layer (after Dan's "Never a Doubt — Quest Board"). Everything is DERIVED from the songs themselves:
// a take you recorded, a note, a reply, a chord, a lyric line, a section, a need you closed — every piece of a song
// carries who made it (takenBy / by), so XP is counted from the song files on the Drive, the same for everyone,
// retroactively, with nothing to keep in sync. "Parts written %" = how much of the song's sections a member's takes cover.
// The only things people SET are band decisions: goals (Final Title / Final Structure / Show Ready), tasks, the next
// boss battle, members' roles — those live in <Shared>/_quest/<who>.json (each bandmate writes only their own file,
// newest value per key wins).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPQuest = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // what a piece of work is worth to the person who did it
  const WORTH = {
    takes: [25, 'take recorded'], midi: [15, 'MIDI / drum part written'], notes: [5, 'note'], replies: [3, 'reply'], chords: [2, 'chord'],
    lyrics: [3, 'lyric line'], heard: [1, 'lyric line from speech-to-text'], sections: [5, 'part laid out'], needsDone: [5, 'need closed'], needs: [2, 'need added'], ideas: [5, 'idea'],
    votes: [1, 'star'], versions: [10, 'version tagged'], saves: [1, 'save'], parts: [10, 'part saved to the bin'],
  };
  // song milestones (the song's own XP, nobody's in particular)
  const MILESTONES = [
    ['laidout', 10, 'Structure laid out', (s) => s.sections >= 3],
    ['chords', 10, 'Chords charted', (s) => s.chords >= 4],
    ['lyrics', 10, 'Lyrics in', (s) => s.lyrics >= 4],
    ['fullband', 20, 'Everyone has taken a pass', (s, b) => b.members.length > 0 && b.members.every((m) => (s.member(m).takes + s.member(m).midi) > 0)],
    ['bounce', 10, 'Bounced', (s) => !!s.bounced],
    ['demo', 15, 'Demo stage', (s) => s.stage === 'demo' || s.stage === 'done'],
    ['done', 25, 'Done', (s) => s.stage === 'done'],
  ];
  const GOALS = [['title', 'Final Title'], ['structure', 'Final Structure'], ['show', 'Show Ready']];
  const GOAL_XP = 15, PCT_XP = 15, WRITTEN_XP = 5, TASK_XP = 10;
  const DEFAULT_MEMBERS = [
    { name: 'Jeff', role: 'Bass & Vox', icon: '🎤', aliases: [] },
    { name: 'Logan', role: 'Lead Guitar', icon: '🎸', aliases: [] },
    { name: 'Zach', role: 'Drums', icon: '🥁', aliases: ['FossTheBoss'] },
    { name: 'Dan', role: 'Rhythm Guitar', icon: '🎸', aliases: ['Daniel'] },
  ];
  // band level by share of the setlist's possible XP; member level by their own XP
  // band levels: a pot of noodles coming together (the band's whole-catalog progress)
  const BAND_LEVELS = [[0, 'Dry Noodles'], [0.1, 'Water\'s Boiling'], [0.3, 'Al Dente'], [0.5, 'Saucy'], [0.7, 'Chef\'s Kiss'], [0.9, 'Never a Doubt']];
  // 100 levels; a new name every ten (the tier). XP for level n = 25·n^1.75 (lv 2 = 84, lv 10 ≈ 1.4k, lv 50 ≈ 23k, lv 100 ≈ 79k):
  // a band that records every week spends a year or two getting to the top names instead of a night.
  const TIERS = ['Roadie', 'Open Mic', 'Garage Hero', 'Basement Star', 'Local Legend', 'Headliner', 'Touring Act', 'Rock Star', 'Hall of Famer', 'Never a Doubt'];
  const TIER_BADGE = [null, 'gi-star', 'gi-trophy', 'gi-curtains', 'gi-bus', 'gi-crown', 'gi-skull', 'gi-laurel', 'gi-fire', 'gi-dragon'];   // what sits on your sprite at each tier
  const levelXp = (n) => (n <= 1 ? 0 : Math.round(25 * Math.pow(n, 1.75)));
  const MEMBER_LEVELS = Array.from({ length: 100 }, (_, i) => { const n = i + 1; const tier = Math.min(9, Math.floor((n - 1) / 10)); return [levelXp(n), TIERS[tier], TIER_BADGE[tier], tier + 1]; });
  // Bodies: Kenney's Toon Characters 1 (CC0) — the little person on the Band page; the pose changes with the tier
  const BODIES = [['madv', 'Adventurer'], ['fadv', 'Adventurer (she)'], ['mper', 'Regular guy'], ['fper', 'Regular gal'], ['robot', 'Robot'], ['zombie', 'Zombie']];
  const TIER_POSE = ['idle', 'walk0', 'talk', 'show', 'cheer0', 'jump', 'attack0', 'cheer1', 'wide', 'cheer1'];
  // Characters: pick yours on the Band page. The sprite stays; the badge, ring and glow grow with the tier.
  const CHARACTERS = [
    ['shredder', 'Shredder', 'gi-guitar', 'six strings, too loud'], ['lowend', 'Low End', 'gi-bass', 'holds it all together'], ['thumper', 'Thumper', 'gi-drum', 'hits things on purpose'],
    ['howler', 'Howler', 'gi-howl', 'sings, screams, both'], ['frontman', 'Frontman', 'gi-mic', 'owns the mic'], ['wizard', 'Keys Wizard', 'gi-keys', 'eighty-eight spells'],
    ['horn', 'Horn', 'gi-sax', 'brings the brass'], ['noodle', 'Noodle', 'gi-noodles', 'the house mascot'], ['dumpling', 'Dumpling', 'gi-dumpling', 'small, dense, delicious'],
    ['picker', 'Picker', 'gi-banjo', 'faster than you'], ['booth', 'The Booth', 'gi-boombox', 'presses the buttons'], ['volt', 'Volt', 'gi-bolt', 'pure energy'],
  ];
  const ACHIEVEMENTS = [
    ['first-take', '🎙', 'First Take', 'recorded a take', (m) => m.takes + m.midi >= 1],
    ['ten-takes', '🔟', 'Double Digits', '10 takes', (m) => m.takes >= 10],
    ['fifty-takes', '💯', 'Tape Hog', '50 takes', (m) => m.takes >= 50],
    ['scribe', '✍️', 'Scribe', '25 lyric lines', (m) => m.lyrics >= 25],
    ['woodshed', '🪵', 'Woodshed', '5 hours in Practice', (m) => (m.practiceMins || 0) >= 300],
    ['setlist-run', '🎤', 'Run It Down', 'a whole setlist rehearsed back to back', (m) => (m.setlistRuns || 0) >= 1],
    ['chord-nerd', '🎼', 'Chord Nerd', '50 chords charted', (m) => m.chords >= 50],
    ['architect', '🧱', 'Architect', '10 parts laid out', (m) => m.sections >= 10],
    ['note-taker', '📝', 'Note Taker', '25 notes', (m) => m.notes >= 25],
    ['good-listener', '👂', 'Good Listener', '25 replies', (m) => m.replies >= 25],
    ['finisher', '✅', 'Finisher', 'closed 10 needs', (m) => m.needsDone >= 10],
    ['full-coverage', '🧩', 'Parts Written', 'covered every part of a song', (m) => m.fullSongs >= 1],
    ['triple-threat', '🔱', 'Triple Threat', 'takes, lyrics and chords on one song', (m) => m.tripleSongs >= 1],
    ['night-owl', '🦉', 'Night Owl', 'a take between midnight and 5 am', (m) => m.nightTakes >= 1],
    ['early-bird', '🐦', 'Early Bird', 'a take before 7 am', (m) => m.earlyTakes >= 1],
    ['on-a-roll', '🔥', 'On a Roll', 'takes on 5 different days', (m) => m.takeDays >= 5],
    ['multi', '🎹', 'Multi-Instrumentalist', 'takes on 3 kinds of track', (m) => m.trackKinds >= 3],
    ['everywhere', '🌐', 'Everywhere', 'took part in every song', (m, b) => b.songs.filter((s) => s.folder).length >= 3 && m.songsTouched >= b.songs.filter((s) => s.folder).length],
    ['idea-machine', '💡', 'Idea Machine', '10 ideas', (m) => m.ideas >= 10],
    ['noodler', '🍜', 'Noodler', '10 parts saved from the Noodle pad', (m) => (m.parts || 0) >= 10],
    ['loose-ends', '🧶', 'Tied Up', '10 loose ends done', (m) => (m.todos || 0) >= 10],
  ];
  const EMPTY = () => ({ takes: 0, midi: 0, notes: 0, replies: 0, chords: 0, lyrics: 0, heard: 0, sections: 0, needs: 0, needsDone: 0, ideas: 0, votes: 0, versions: 0, saves: 0, parts: 0, pct: 0, nightTakes: 0, earlyTakes: 0, days: [], kinds: [] });
  const uniq = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  const live = (a) => (Array.isArray(a) ? a.filter((x) => x && !x.deleted) : []);
  const EPS = 1e-6;

  // ---- per song, straight from song.json (runs in the main process while listing songs, and in the renderer) ----
  // → { stats: {sections, chords, lyrics, takesTotal, stage}, by: { name: counters + pct } }
  function songStats(raw, { sandbox = false } = {}) {
    const by = new Map(); const who = (n) => { const k = String(n || '').trim().slice(0, 40); if (!k) return null; if (!by.has(k)) by.set(k, EMPTY()); return by.get(k); };
    const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
    const sections = live(raw.sections).filter((s) => Number.isFinite(Number(s.start)) && Number.isFinite(Number(s.end)) && s.end > s.start).sort((a, b) => a.start - b.start);
    const takesOf = new Map();   // member → [{a, b}] (spans of their takes, live ones)
    const seenTake = new Set();
    const span = (c) => { const len = Math.max(0, (Number(c.duration) || 0) - (c.trimStart || 0) - (c.trimEnd || 0)); if (len > 0.05) { if (!takesOf.has(c.takenBy)) takesOf.set(c.takenBy, []); takesOf.get(c.takenBy).push({ a: Number(c.start) || 0, b: (Number(c.start) || 0) + len }); } };
    const countTake = (c, t, isLive) => {
      if (!c || !c.takenBy) return;
      if (c.link) { if (isLive) span(c); return; }   // a linked copy: not a new take, but it does play their part there (counts for coverage)
      if (seenTake.has(c.id)) return; seenTake.add(c.id);
      const m = who(c.takenBy); if (!m) return;
      if (c.kind === 'midi') m.midi++; else m.takes++;
      if (c.takenAt) { const d = new Date(c.takenAt); if (!Number.isNaN(d.getTime())) { const h = d.getHours(); if (h < 5) m.nightTakes++; else if (h < 7) m.earlyTakes++; const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; if (!m.days.includes(day)) m.days.push(day); } }
      const kind = t ? (t.instrument === 'drumkit' || t.type === 'drums' || t.type === 'drumsMic' ? 'drums' : String(t.instrument || '').startsWith('synth:') ? 'midi' : t.type || 'other') : 'other';
      if (!m.kinds.includes(kind)) m.kinds.push(kind);
      if (isLive) span(c);
    };
    for (const t of tracks) for (const c of Array.isArray(t.clips) ? t.clips : []) countTake(c, t, true);
    for (const tr of Object.values(raw.trash || {})) if (tr && tr.clip) countTake(tr.clip, tracks.find((t) => t.id === tr.trackId) || null, false);
    for (const m of live(raw.markers)) { const w = who(m.by); if (w) w.notes++; for (const r of live(m.replies)) { const x = who(r.by); if (x) x.replies++; } }
    for (const c of live(raw.chords)) if (!c.link) { const w = who(c.by); if (w) w.chords++; }
    for (const l of live(raw.lyrics)) { const w = who(l.by); if (w) { if (l.asr && !l.edited) w.heard++; else w.lyrics++; } }   // heard by speech-to-text: worth less than lines you wrote (fixing one makes it yours)
    for (const s of sections) { const w = who(s.by); if (w) w.sections++; }
    for (const n of live(raw.needs)) { const w = who(n.by); if (w) w.needs++; if (n.done && n.done.by) { const x = who(n.done.by); if (x) x.needsDone++; } }
    for (const i of live(raw.ideas)) { const w = who(i.by); if (w) w.ideas++; }
    for (const v of live(raw.votes)) { const w = who(v.by); if (w) w.votes++; }
    for (const v of live(raw.versions)) { const w = who(v.by); if (w) w.versions++; }
    for (const a of Array.isArray(raw.activity) ? raw.activity : []) { const w = who(a && a.by); if (w) w.saves++; }
    // parts written: share of the sections a member's takes reach into (no sections: share of the song's length)
    const songEnd = Math.max(...sections.map((s) => s.end), ...[...takesOf.values()].flat().map((x) => x.b), 0);
    for (const [name, spans] of takesOf) {
      const m = who(name); if (!m) continue;
      if (sections.length) { let n = 0; for (const s of sections) if (spans.some((x) => Math.min(x.b, s.end) - Math.max(x.a, s.start) > 0.25)) n++; m.pct = Math.round(100 * n / sections.length); }
      else if (songEnd > 0) { const merged = spans.slice().sort((x, y) => x.a - y.a).reduce((acc, x) => { const l = acc[acc.length - 1]; if (l && x.a <= l.b + EPS) l.b = Math.max(l.b, x.b); else acc.push({ a: x.a, b: x.b }); return acc; }, []); m.pct = Math.round(100 * merged.reduce((n, x) => n + (x.b - x.a), 0) / songEnd); }
    }
    const out = {};
    for (const [k, v] of by) out[k] = v;
    return { stats: { sections: sections.length, chords: live(raw.chords).filter((c) => !c.link).length, lyrics: live(raw.lyrics).length, takesTotal: seenTake.size, stage: typeof raw.stage === 'string' ? raw.stage : null, sandbox: !!raw.sandbox || sandbox }, by: out };
  }
  const memberXp = (m) => Object.entries(WORTH).reduce((n, [k, [xp]]) => n + (m[k] || 0) * xp, 0);

  // ---- the shared _quest files ----
  function merge(files) {
    const out = new Map();
    for (const f of files || []) {
      if (!f || !f.fields || typeof f.fields !== 'object') continue;
      for (const [k, e] of Object.entries(f.fields)) {
        if (!e || typeof e !== 'object' || !('v' in e)) continue;
        const cur = out.get(k); const at = String(e.at || '');
        if (!cur || at > String(cur.at || '') || (at === String(cur.at || '') && String(e.by || '') > String(cur.by || ''))) out.set(k, { v: e.v, at, by: e.by || f.user || '?' });
      }
    }
    return out;
  }
  const val = (m, k, d) => (m.has(k) ? m.get(k).v : d);
  const norm = (s) => String(s || '').toLowerCase().replace(/\((official\s+)?cover\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const isCover = (s) => /\((official\s+)?cover\)/i.test(String(s || ''));
  const clampPct = (x) => Math.max(0, Math.min(100, Math.round(Number(x) || 0)));
  function memberFor(members, user) { const u = String(user || '').trim().toLowerCase(); if (!u) return null; return (members || []).find((mb) => mb.name.toLowerCase() === u || (mb.aliases || []).some((a) => String(a).toLowerCase() === u)) || null; }
  function levelOf(xp, levels) { let i = 0; for (let k = 0; k < levels.length; k++) if (xp >= levels[k][0]) i = k; const hi = i + 1 < levels.length ? levels[i + 1][0] : null; return { n: i + 1, title: levels[i][1], badge: levels[i][2] || null, tier: levels[i][3] || 1, next: hi != null ? levels[i + 1][1] : null, lo: levels[i][0], hi, toNext: hi != null ? Math.max(0, Math.ceil(hi - xp)) : 0, frac: hi != null ? Math.max(0, Math.min(1, (xp - levels[i][0]) / (hi - levels[i][0]))) : 1 };
  }

  // ---- the board: songs from Cobander (each with .quest = songStats output, from listSongs) + the shared fields ----
  function board(fields, bpSongs = [], { me = null } = {}) {
    const m = fields instanceof Map ? fields : merge(fields);
    const configured = (Array.isArray(val(m, 'band:members')) ? val(m, 'band:members') : DEFAULT_MEMBERS).filter((x) => x && x.name).map((x) => ({ name: String(x.name).slice(0, 30), role: String(x.role || '').slice(0, 30), icon: String(x.icon || '🎵').slice(0, 4), aliases: Array.isArray(x.aliases) ? x.aliases.map(String) : [], character: CHARACTERS.some(([id]) => id === x.character) ? x.character : null, body: BODIES.some(([id]) => id === x.body) ? x.body : null }));
    const members = configured.slice();
    const songsIn = (bpSongs || []).filter((s) => s && s.folder && !(s.quest && s.quest.stats && s.quest.stats.sandbox) && !/^noodle pad\b/i.test(s.folder));
    // anyone who did work in a song but isn't configured joins as a member (a new bandmate, or a test user)
    // anyone who did work in a song but isn't configured joins as a member (a new bandmate, or a test user) — work means
    // takes, parts, words or notes; an assistant that only saved a mix through the API is not a bandmate
    const played = (st) => !!st && ((st.takes || 0) + (st.midi || 0) + (st.lyrics || 0) + (st.chords || 0) + (st.notes || 0) + (st.replies || 0) + (st.sections || 0) + (st.ideas || 0)) > 0;
    for (const s of songsIn) for (const [who, st] of Object.entries((s.quest && s.quest.by) || {})) if (!memberFor(members, who) && played(st)) members.push({ name: who, role: '', icon: '🎵', aliases: [], auto: true });
    if (me && !memberFor(members, me)) members.push({ name: String(me), role: '', icon: '🎵', aliases: [], auto: true });
    const quests = new Map();
    for (const s of songsIn) quests.set(`f:${s.folder}`, { qid: `f:${s.folder}`, name: s.name || s.folder, folder: s.folder, bp: s, cover: isCover(s.name || s.folder) });
    const byNorm = new Map([...quests.values()].map((q) => [norm(q.name), q]));
    const alias = new Map();
    for (const [k, e] of m) {
      const mm = /^song:(.+):meta$/.exec(k); if (!mm || !e.v || typeof e.v !== 'object') continue;
      const qid = mm[1], meta = e.v;
      if (qid.startsWith('f:')) { const q = quests.get(qid); if (q) q.meta = meta; continue; }
      const twin = byNorm.get(norm(meta.name));
      if (twin && !meta.deleted) { alias.set(qid, twin.qid); continue; }
      quests.set(qid, { qid, name: String(meta.name || 'untitled').slice(0, 80), folder: null, meta, cover: meta.cover != null ? !!meta.cover : isCover(meta.name) });
    }
    const idsOf = (q) => [q.qid, ...[...alias].filter(([, b]) => b === q.qid).map(([a]) => a)];
    const read = (q, suffix, d) => { let best = null; for (const id of idsOf(q)) { const e = m.get(`song:${id}:${suffix}`); if (e && (!best || e.at > best.at)) best = e; } return best ? best.v : d; };
    const songs = [];
    const perMemberTotals = new Map(members.map((mb) => [mb.name, { ...EMPTY(), xp: 0, songsTouched: 0, fullSongs: 0, tripleSongs: 0, achievements: [], perSong: [] }]));
    const statOf = (q, mb) => { const by = (q.bp && q.bp.quest && q.bp.quest.by) || {}; const acc = EMPTY(); for (const [who, v] of Object.entries(by)) if (memberFor([mb], who)) for (const k of Object.keys(acc)) acc[k] = k === 'pct' ? Math.max(acc[k], v[k] || 0) : Array.isArray(acc[k]) ? uniq(acc[k], v[k]) : (acc[k] || 0) + (v[k] || 0); return acc; };
    for (const q of quests.values()) {
      const meta = q.meta || {};
      if (meta.deleted || meta.hidden) continue;
      const st = (q.bp && q.bp.quest && q.bp.quest.stats) || { sections: 0, chords: 0, lyrics: 0, takesTotal: 0, stage: null };
      const goals = GOALS.map(([id, label]) => ({ id, label, done: !!read(q, `goal:${id}`, false) }));
      const prog = members.map((mb) => {
        const s = statOf(q, mb); const manual = read(q, `m:${mb.name}:manual`, null);
        const pct = q.folder ? (manual != null && s.pct === 0 ? clampPct(manual) : s.pct) : clampPct(read(q, `m:${mb.name}:pct`, manual != null ? manual : 0));
        return { member: mb.name, pct, written: pct >= 100, manual: manual != null && (!q.folder || s.pct === 0), takes: s.takes, midi: s.midi, xp: memberXp(s), stat: s };
      });
      const tasks = [];
      const ids = new Set(idsOf(q));
      for (const [k, e] of m) { const tm = /^song:(.+):task:([\w-]+)$/.exec(k); if (!tm || !ids.has(tm[1]) || !e.v || typeof e.v !== 'object' || e.v.deleted) continue; tasks.push({ id: tm[2], qid: tm[1], text: String(e.v.text || '').slice(0, 200), done: !!e.v.done, who: e.v.who || null, by: e.by, at: e.at }); }
      tasks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const sView = { ...st, bounced: !!(q.bp && q.bp.bounced), member: (mb) => prog.find((p) => p.member === mb.name).stat };
      const milestones = q.folder ? MILESTONES.map(([id, xp, label, test]) => ({ id, xp, label, done: !!test(sView, { members }) })) : [];
      const xp = goals.filter((g) => g.done).length * GOAL_XP + prog.reduce((n, p) => n + (p.pct / 100) * PCT_XP + (p.written ? WRITTEN_XP : 0), 0) + tasks.filter((t) => t.done).length * TASK_XP + milestones.filter((x) => x.done).reduce((n, x) => n + x.xp, 0);
      const max = GOALS.length * GOAL_XP + members.length * (PCT_XP + WRITTEN_XP) + tasks.length * TASK_XP + milestones.reduce((n, x) => n + x.xp, 0);
      const song = { qid: q.qid, name: q.name, folder: q.folder, cover: q.cover, meta, stats: st, bounced: sView.bounced, goals, prog, tasks, milestones, xp: Math.round(xp), max, order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : null };
      songs.push(song);
      for (const p of prog) {
        const t = perMemberTotals.get(p.member); if (!t) continue;
        for (const k of Object.keys(EMPTY())) if (k !== 'pct') t[k] = Array.isArray(t[k]) ? uniq(t[k], p.stat[k]) : t[k] + (p.stat[k] || 0);
        const sx = memberXp(p.stat) + Math.round((p.pct / 100) * PCT_XP + (p.written ? WRITTEN_XP : 0));
        t.xp += sx; if (sx > 0 || p.pct > 0) { t.songsTouched++; t.perSong.push({ qid: q.qid, name: q.name, folder: q.folder, xp: sx, pct: p.pct }); }
        if (p.written) t.fullSongs++; if ((p.stat.takes + p.stat.midi) > 0 && p.stat.lyrics > 0 && p.stat.chords > 0) t.tripleSongs++;
      }
    }
    songs.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (b.xp / Math.max(1, b.max)) - (a.xp / Math.max(1, a.max)) || a.name.localeCompare(b.name));
    // parts bin saves count for their author
    const partsBy = val(m, 'band:partsBy', null);
    const out = { name: String(val(m, 'band:name', 'Never a Doubt')).slice(0, 60), members: [], songs, boss: null, next: String(val(m, 'band:next', '') || '').slice(0, 200), aliasOf: alias };
    // practice: minutes in Practice mode, logged by each player in their own file as practice:<who>:<YYYY-MM-DD>:<qid>
    // 1 XP a minute, at most 60 a day
    const songName = (qid) => { const q = quests.get(qid) || quests.get(alias.get(qid)); return q ? q.name : String(qid).replace(/^f:/, ''); };
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const prac = new Map();
    const runs = new Map();
    for (const [k, e] of m) { const sm = /^setlist:([^:]+):/.exec(k); if (!sm) continue; const mb = memberFor(members, sm[1]); if (mb) runs.set(mb.name, (runs.get(mb.name) || 0) + Math.max(0, Number(e.v) || 0)); }
    for (const [k, e] of m) {
      const pm = /^practice:([^:]+):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(k); if (!pm) continue; const mins = Math.max(0, Math.min(600, Number(e.v) || 0)); if (!mins) continue;
      const mb = memberFor(members, pm[1]); if (!mb) continue;
      if (!prac.has(mb.name)) prac.set(mb.name, { days: new Map(), songs: new Map(), week: 0, total: 0 });
      const p = prac.get(mb.name); p.days.set(pm[2], (p.days.get(pm[2]) || 0) + mins); p.songs.set(pm[3], (p.songs.get(pm[3]) || 0) + mins); p.total += mins; if (pm[2] >= weekAgo) p.week += mins;
    }
    out.practice = { members: [...prac].map(([name, p]) => ({ name, total: p.total, week: p.week, days: p.days.size, top: [...p.songs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([qid, mins]) => ({ qid, song: songName(qid), mins })) })).sort((a, b) => b.week - a.week || b.total - a.total) };
    // band to-dos: `band:todo:<id>` = { text, who, done, doneBy, deleted } — things that aren't a song (book the gig, fix the PA, buy PBR); TASK_XP to whoever checks one off
    out.todos = [];
    for (const [k, e] of m) { const tm = /^band:todo:([\w-]+)$/.exec(k); if (!tm || !e.v || typeof e.v !== 'object' || e.v.deleted) continue; out.todos.push({ id: tm[1], text: String(e.v.text || '').slice(0, 200), who: e.v.who ? String(e.v.who).slice(0, 30) : null, done: !!e.v.done, doneBy: e.v.doneBy ? String(e.v.doneBy) : null, by: e.by, at: e.at }); }
    out.todos.sort((a, b) => Number(a.done) - Number(b.done) || String(a.id).localeCompare(String(b.id)));
    for (const td of out.todos) if (td.done) { const mb = memberFor(members, td.doneBy || td.by); if (mb) { const t = perMemberTotals.get(mb.name); if (t) { t.todos = (t.todos || 0) + 1; t.xp += TASK_XP; } } }
    for (const mb of members) {
      const t = perMemberTotals.get(mb.name);
      { const p = prac.get(mb.name); t.practiceMins = p ? p.total : 0; t.setlistRuns = runs.get(mb.name) || 0; t.practiceXp = p ? [...p.days.values()].reduce((n, d) => n + Math.min(60, Math.round(d)), 0) : 0; t.xp += t.practiceXp; }
      if (partsBy && typeof partsBy === 'object') for (const [who, n] of Object.entries(partsBy)) if (memberFor([mb], who)) { t.parts += Number(n) || 0; t.xp += (Number(n) || 0) * WORTH.parts[0]; }
      t.perSong.sort((a, b) => b.xp - a.xp); t.takeDays = t.days.length; t.trackKinds = t.kinds.length;
      t.achievements = ACHIEVEMENTS.filter(([, , , , test]) => test(t, out)).map(([id, icon, title, desc]) => ({ id, icon, title, desc }));
      out.members.push({ ...mb, ...t, level: levelOf(t.xp, MEMBER_LEVELS), isMe: !!(me && memberFor([mb], me)) });
    }
    out.xp = songs.reduce((n, s) => n + s.xp, 0); out.max = songs.reduce((n, s) => n + s.max, 0);
    out.level = bandLevel(out.xp, out.max);
    const boss = val(m, 'band:boss', null); out.boss = boss && typeof boss === 'object' && boss.title ? { title: String(boss.title).slice(0, 80), date: String(boss.date || ''), songs: Array.isArray(boss.songs) ? boss.songs : [] } : null;
    return out;
  }
  function bandLevel(xp, max) {
    const f = max > 0 ? xp / max : 0; let i = 0; for (let k = 0; k < BAND_LEVELS.length; k++) if (f >= BAND_LEVELS[k][0]) i = k;
    const lo = BAND_LEVELS[i][0] * max, hi = i + 1 < BAND_LEVELS.length ? BAND_LEVELS[i + 1][0] * max : max;
    return { n: i + 1, title: BAND_LEVELS[i][1], next: i + 1 < BAND_LEVELS.length ? BAND_LEVELS[i + 1][1] : null, toNext: Math.max(0, Math.ceil(hi - xp)), frac: f, lo, hi };
  }
  // XP an activity label is worth (for the "+25 XP" pop and the band feed): by the kind of thing it is
  function xpForLabel(label) {
    const s = String(label || '');
    if (/^(recorded|record take|loop record)/i.test(s)) { const n = Number((/recorded (\d+) /.exec(s) || [])[1]) || 1; return { xp: n * WORTH.takes[0], what: n > 1 ? `${n} takes recorded` : WORTH.takes[1] }; }
    if (/^imported/i.test(s)) return { xp: WORTH.takes[0], what: 'take imported' };
    if (/^drums for|^melody for|^edited notes of|drum part|riff/i.test(s)) return { xp: WORTH.midi[0], what: WORTH.midi[1] };
    if (/^repl/i.test(s)) return { xp: WORTH.replies[0], what: WORTH.replies[1] };
    if (/^note at/i.test(s)) return { xp: WORTH.notes[0], what: WORTH.notes[1] };
    if (/^chords bars/i.test(s)) return { xp: 4 * WORTH.chords[0], what: 'chords laid in' };
    if (/^chord /i.test(s)) return { xp: WORTH.chords[0], what: WORTH.chords[1] };
    if (/speech-to-text/i.test(s)) { const n = Number((/(\d+) lines?\)/.exec(s) || [])[1]) || 1; return { xp: n * WORTH.heard[0], what: n > 1 ? `${n} lyric lines heard` : WORTH.heard[1] }; }
    if (/^pin lyric|^lyrics placed|lyric/i.test(s)) return { xp: WORTH.lyrics[0], what: WORTH.lyrics[1] };
    if (/^section .* at bar|^split |^duplicated |^added .* at bar/i.test(s)) return { xp: WORTH.sections[0], what: WORTH.sections[1] };
    if (/^done:/i.test(s)) return { xp: WORTH.needsDone[0], what: WORTH.needsDone[1] };
    if (/^needs?:/i.test(s)) return { xp: WORTH.needs[0], what: WORTH.needs[1] };
    if (/^idea /i.test(s)) return { xp: WORTH.ideas[0], what: WORTH.ideas[1] };
    if (/^tagged version/i.test(s)) return { xp: WORTH.versions[0], what: WORTH.versions[1] };
    if (/★|^star/i.test(s)) return { xp: WORTH.votes[0], what: WORTH.votes[1] };
    return null;
  }
  // feed rows from the quest fields (goals, tasks, boss)
  function events(fields, b, limit = 30) {
    const m = fields instanceof Map ? fields : merge(fields); const out = [];
    const nameOf = (qid) => { const s = b.songs.find((x) => x.qid === qid || (b.aliasOf && b.aliasOf.get(qid) === x.qid)); return s ? s.name : null; };
    for (const [k, e] of m) {
      if (!e.at || !e.by || /imported/.test(e.by)) continue; let mm;
      if ((mm = /^song:(.+):goal:(\w+)$/.exec(k)) && e.v) { const g = GOALS.find((x) => x[0] === mm[2]); out.push({ at: e.at, by: e.by, song: nameOf(mm[1]), what: `${g ? g[1] : mm[2]} ✓`, xp: GOAL_XP }); }
      else if ((mm = /^song:(.+):task:/.exec(k)) && e.v && !e.v.deleted) out.push({ at: e.at, by: e.by, song: nameOf(mm[1]), what: `task ${e.v.done ? '✓' : '+'} ${String(e.v.text || '').slice(0, 60)}`, xp: e.v.done ? TASK_XP : 0 });
      else if ((mm = /^band:todo:/.exec(k)) && e.v && !e.v.deleted) out.push({ at: e.at, by: e.by, song: null, what: `band to-do ${e.v.done ? '✓' : '+'} ${String(e.v.text || '').slice(0, 60)}`, xp: e.v.done ? TASK_XP : 0 });
      else if (k === 'band:boss' && e.v) out.push({ at: e.at, by: e.by, song: null, what: `next boss battle: ${e.v.title || ''}${e.v.date ? ` (${e.v.date})` : ''}`, xp: 0 });
    }
    return out.filter((x) => x.song !== undefined).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  }
  return { WORTH, MILESTONES, GOALS, GOAL_XP, PCT_XP, WRITTEN_XP, TASK_XP, DEFAULT_MEMBERS, BAND_LEVELS, MEMBER_LEVELS, TIERS, TIER_BADGE, CHARACTERS, BODIES, TIER_POSE, levelXp, ACHIEVEMENTS, songStats, memberXp, merge, board, bandLevel, levelOf, memberFor, xpForLabel, events, norm, clampPct };
});
