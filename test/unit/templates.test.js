'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../src/renderer/templates');
const C = require('../../src/renderer/collab');

let n = 0; const newId = () => (++n).toString(16).padStart(12, '0');

test('every built-in template and arrangement is well formed', () => {
  for (const t of T.BUILTIN) { assert.ok(T.normalize(t), t.id); assert.ok(t.bpm >= t.bpmRange[0] && t.bpm <= t.bpmRange[1], `${t.id} bpm in range`); for (const k of t.tracks) assert.match(k, /^(guitar|bass|vocals|drumsMic|drums|keys|other)$/); }
  const ids = new Set(); for (const a of T.ARRANGEMENTS) { assert.ok(!ids.has(a.id), `dup ${a.id}`); ids.add(a.id); assert.ok(a.structure.length); assert.ok(T.BUILTIN.some((t) => t.id === a.genre), `${a.id} genre`); }
  assert.ok(T.arrangementsFor('pop-punk').length >= 5);
  assert.ok(T.arrangementsFor('pop-punk').some((a) => a.structure.some(([n]) => n === 'Half chorus')));
});

test('bar length matches the engine (beat = 60/bpm, bar = numerator beats)', () => {
  assert.equal(T.barSeconds(120, [4, 4]), 2); assert.equal(T.barSeconds(120, [6, 8]), 3); assert.equal(T.barSeconds(120, [3, 4]), 1.5);
});

test('layout numbers repeats and lays sections back to back', () => {
  const s = T.layoutSections([['Intro', 2], ['Verse', 4], ['Chorus', 4], ['Verse', 4]], 120, [4, 4]);
  assert.deepEqual(s.map((x) => x.name), ['Intro', 'Verse 1', 'Chorus', 'Verse 2']);
  assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 4], [4, 12], [12, 20], [20, 28]]);
});

test('section types', () => {
  for (const [n, t] of [['Verse 2', 'verse'], ['Half chorus', 'chorus'], ['Double Chorus', 'chorus'], ['Pre-chorus', 'pre-chorus'], ['Middle 8', 'bridge'], ['Refrain', 'chorus'], ['chorus #3', 'chorus']]) assert.equal(T.sectionType(n), t, n);
});

// A song at 120 bpm 4/4 (bar = 2 s): Verse 1 bars 1-4 (0-8 s), Chorus bars 5-8 (8-16 s), Verse 2 bars 9-12 (16-24 s), Outro 13-14.
function song() {
  const clip = (id, start, len, extra = {}) => ({ id, start, duration: len, trimStart: 0, trimEnd: 0, fadeIn: 0, fadeOut: 0, gainDb: 0, name: id, ...extra });
  return {
    bpm: 120, timeSig: [4, 4],
    tracks: [
      { id: 'gtr', clips: [clip('aaaaaaaaaaaa', 0, 28)] },                              // one long take across everything
      { id: 'vox', clips: [clip('bbbbbbbbbbbb', 8, 8), clip('cccccccccccc', 30, 2)] },   // chorus vocal; a scrap after the outro
      { id: 'keys', clips: [clip('dddddddddddd', 8, 8, { kind: 'midi', notes: [{ t: 0, d: 1, note: 60 }, { t: 5, d: 1, note: 64 }] })] },
    ],
    sections: [{ id: 's1', name: 'Verse 1', start: 0, end: 8 }, { id: 's2', name: 'Chorus', start: 8, end: 16 }, { id: 's3', name: 'Verse 2', start: 16, end: 24 }, { id: 's4', name: 'Outro', start: 24, end: 28 }, { id: 'sx', name: 'Gone', start: 40, end: 44, deleted: true }],
    chords: [{ id: 'c1', time: 8, chord: 'G' }, { id: 'c2', time: 12, chord: 'D' }],
    lyrics: [{ id: 'l1', time: 9, text: 'chorus line' }, { id: 'l2', time: 1, text: 'verse line' }],
    markers: [{ id: 'm1', time: 10, text: 'tighten', replies: [] }],
  };
}

test('restructure: verse, half chorus, verse, chorus, outro (the pop-punk tease)', () => {
  const r = T.restructure(song(), [['Verse', 4], ['Half chorus', 2, 'Chorus'], ['Verse', 4], ['Chorus', 4], ['Outro', 2]], { newId });
  assert.deepEqual(r.sections.map((s) => [s.name, s.start, s.end]), [['Verse 1', 0, 8], ['Half chorus', 8, 12], ['Verse 2', 12, 20], ['Chorus', 20, 28], ['Outro', 28, 32]]);
  assert.equal(r.length, 32);
  // guitar: one piece per slot, each pointing at the original audio with the right trims
  const g = r.tracks[0].clips;
  assert.equal(g.length, 5);
  assert.ok(g.every((c) => c.src === 'aaaaaaaaaaaa' && c.id !== 'aaaaaaaaaaaa'));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // pieces start 30 ms early (lead-in, faded) except at the very top of the song
  assert.deepEqual(g.map((c) => [r3(c.start), r3(c.trimStart), r3(28 - c.trimStart - c.trimEnd)]), [[0, 0, 8], [7.97, 7.97, 4.03], [11.97, 15.97, 8.03], [19.97, 7.97, 8.03], [27.97, 23.97, 4.03]]);
  assert.ok(Math.abs(g[1].fadeIn - 0.03) < 1e-9, 'lead-in is faded');
  assert.deepEqual(r.idMap.get('aaaaaaaaaaaa').length, 5);
  assert.notStrictEqual(r.tracks[2].clips[0].notes[0], r.tracks[2].clips[1].notes[0], 'MIDI pieces own their notes');
  assert.equal(g[1].fadeOut, 0.004, 'cut edges get a tiny fade');
  // vocal: chorus take appears in the half chorus (first half) and the full chorus; the scrap outside sections is dropped
  const v = r.tracks[1].clips; assert.deepEqual(v.map((c) => [c.start, c.trimStart]), [[8, 0], [20, 0]]);
  assert.equal(v[0].trimEnd, 4);
  assert.equal(r.report.droppedClips, 1);
  // MIDI notes are filtered to the piece
  const k = r.tracks[2].clips; assert.equal(k[0].notes.length, 1); assert.equal(k[1].notes.length, 2);
  // chords copied into each chorus slot (only the first half for the half chorus); lyric/notes move to the first use
  assert.deepEqual(r.chords.map((c) => [c.chord, c.time]), [['G', 8], ['G', 20], ['D', 24]]);
  assert.equal(r.lyricsMoved.get('l1'), 9); assert.equal(r.lyricsMoved.get('l2'), 1); assert.equal(r.markersMoved.get('m1'), 10);
  assert.deepEqual(r.report.shortened, ['Half chorus']);
  assert.deepEqual(r.report.missing, []);
});

test('restructure: missing parts become empty slots, longer slots repeat the source', () => {
  const r = T.restructure(song(), [['Chorus', 4], ['Bridge', 4], ['Double chorus', 8, 'Chorus']], { newId });
  assert.deepEqual(r.report.missing, ['Bridge']);
  assert.equal(r.report.slots[1].from, null);
  assert.deepEqual(r.report.padded, ['Double chorus']);
  assert.deepEqual(r.tracks[1].clips.map((c) => c.start), [0, 16, 24], 'chorus vocal once, then twice in the double chorus');
  assert.deepEqual(r.report.unusedSections, ['Verse 1', 'Verse 2', 'Outro']);
});

test('restructure: a third verse reuses the recorded verses in turn', () => {
  const r = T.restructure(song(), [['Verse', 4], ['Verse', 4], ['Verse', 4]], { newId });
  assert.deepEqual(r.report.slots.map((s) => s.from), ['Verse 1', 'Verse 2', 'Verse 1']);
});

test('template from a song keeps structure, tempo and track setups', () => {
  const s = { name: 'Can\'t Argue', bpm: 180, timeSig: [4, 4], key: 'E', sections: [{ name: 'Intro', start: 0, end: 2.6667 }, { name: 'Verse 1', start: 2.6667, end: 13.3333 }], tracks: [{ name: 'Gtr', type: 'guitar', instrument: 'audio', gainDb: -6, pan: 0, fx: { amp: { on: true } }, clips: [{ id: 'x' }] }] };
  const t = T.fromSong(s, 'Our shape', 'Jeff');
  assert.equal(t.id, 'band-our-shape'); assert.deepEqual(t.structure, [['Intro', 2], ['Verse', 8]]); assert.equal(t.key, 'E');
  assert.equal(t.trackSetups[0].name, 'Gtr'); assert.equal(t.trackSetups[0].clips, undefined);
});

test('typed activity events for stats / XP', () => {
  const e = C.activityEntry(['recorded take 3 on Gtr', 'replied to "intro"', 'resolved note "x"', '★ riff A', 'section Chorus at bar 9', 'tempo 120 → 180 (takes sped up, +7.0 semitones)', 'rolled back to before Kat\'s change', 'Gtr fader'], 'Jeff', 'now', 'id');
  assert.deepEqual(e.kinds, { take: 1, reply: 1, resolve: 1, vote: 1, section: 1, tempo: 1, rollback: 1, mix: 1 });
});


test('structure normalisation keeps each source with its own slot, caps size, rejects junk', () => {
  assert.deepEqual(T.normalizeStructure([['Verse', 0], ['Intro', 4], ['Bridge', 8, 'Chorus'], ['', 4], 'x']), [['Intro', 4], ['Bridge', 8, 'Chorus']]);
  assert.equal(T.normalizeStructure(Array.from({ length: 100 }, () => ['Verse', 8])).length, 64);
  const bad = T.normalize({ name: 'x', trackSetups: [null, { name: 'Gtr' }, 5], tracks: ['piano', 'bass'] });
  assert.deepEqual(bad.trackSetups.map((x) => x.name), ['Gtr']); assert.deepEqual(bad.tracks, ['bass']);
  assert.equal(T.normalize({ name: 'y', trackSetups: [] }).trackSetups, null);
  assert.deepEqual(T.validSig([12, 8]), [12, 8]); assert.deepEqual(T.validSig([13, 7]), [13, 7]); assert.deepEqual(T.validSig([7, 8, [2, 2, 3]]), [7, 8, [2, 2, 3]]); assert.deepEqual(T.validSig([12, 99]), [4, 4]); assert.deepEqual(T.validSig([7, 8, [3, 3]]), [7, 8]);
});

test('restructure reports notes from parts that are not used', () => {
  const r = T.restructure(song(), [['Verse', 4]], { newId });
  assert.deepEqual(r.report.notesLeft, [{ id: 'm1', from: 'Chorus' }]);
});

test('linked sections: followers mirror the room with deterministic ids; unlinked sections are left alone', () => {
  const s = song(); s.sections.push({ id: 's5', name: 'Chorus', start: 28, end: 36 });
  assert.equal(T.linkMirrors(s).changed, false, 'no link groups → nothing');
  s.linkGroups = { chorus: true };
  const r = T.linkMirrors(s);
  assert.equal(r.changed, true); assert.equal(r.info.chorus.room.id, 's2'); assert.deepEqual(r.info.chorus.followers.map((f) => f.id), ['s5']);
  const vox = r.tracks[1].clips.filter((c) => c.link); assert.equal(vox.length, 1);
  assert.equal(vox[0].start, 28); assert.equal(vox[0].src, 'bbbbbbbbbbbb'); assert.deepEqual(vox[0].link, { from: 'bbbbbbbbbbbb', section: 's5' });
  assert.equal(vox[0].id, T.hash12('bbbbbbbbbbbb|s5'));
  const midi = r.tracks[2].clips.find((c) => c.link); assert.equal(midi.notes.length, 2); assert.equal(midi.src, undefined);
  // applying the result again is stable
  const s2 = { ...s, tracks: s.tracks.map((t, i) => ({ ...t, clips: r.tracks[i].clips })) };
  assert.equal(T.linkMirrors(s2).changed, false);
  // room edit (move the vocal) → mirror follows
  s2.tracks[1].clips.find((c) => c.id === 'bbbbbbbbbbbb').start = 10;
  const r3 = T.linkMirrors(s2); assert.equal(r3.changed, true); assert.equal(r3.tracks[1].clips.find((c) => c.link).start, 30);
  // unlink the follower → no mirrors
  s2.sections.find((x) => x.id === 's5').unlinked = true;
  assert.equal(T.linkMirrors(s2).tracks[1].clips.filter((c) => c.link).length, 0);
});

test('linked copies: a copy that lost its mark is dropped, not doubled; own takes reaching into a copy are carved', () => {
  const s = song(); s.sections.push({ id: 's5', name: 'Chorus', start: 28, end: 36 }); s.linkGroups = { chorus: true };
  const r = T.linkMirrors(s); const s2 = { ...s, tracks: s.tracks.map((t, i) => ({ ...t, clips: r.tracks[i].clips.map((c) => { const x = { ...c }; delete x.link; return x; }) })) };   // what an older loader did
  const r2 = T.linkMirrors(s2);
  const ids = r2.tracks[1].clips.map((c) => c.id); assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  assert.equal(r2.tracks[1].clips.filter((c) => c.start === 28).length, 1, 'one copy, not two');
  // a take that STARTS inside a copy (recorded there) moves to the room: the vocal scrap at 30 s → 8 + 2 = 10 s in the first Chorus
  const cv0 = T.carveFollowers(s, { newId });
  assert.equal(cv0.changed, true); assert.equal(cv0.removed.length, 0); assert.deepEqual(cv0.unlinked, []);
  assert.deepEqual(cv0.moved.map((m) => [m.trackId, m.clip.start]), [['vox', 10]]);
  assert.ok(!cv0.tracks[1].clips.some((c) => c.start === 30), 'gone from the copy');
  // a take that runs INTO a copy from before (a run-through) keeps its own performance: that copy unlinks, nothing is cut
  s.tracks[0].clips.push({ id: 'eeeeeeeeeeee', start: 24, duration: 10, trimStart: 0, trimEnd: 0, name: 'long' });
  const cv = T.carveFollowers(s, { newId });
  assert.deepEqual(cv.unlinked, ['s5']); assert.equal(cv.moved.length, 0); assert.equal(cv.removed.length, 0);
  assert.ok(cv.tracks[0].clips.some((c) => c.id === 'eeeeeeeeeeee' && c.start === 24 && c.duration === 10));
});

test('restructure with a linked type: only the first slot gets pieces', () => {
  const s = song(); s.linkGroups = { chorus: true };
  const r = T.restructure(s, [['Chorus', 4], ['Verse', 4], ['Chorus', 4]], { newId, linkGroups: s.linkGroups });
  assert.equal(r.tracks[1].clips.length, 1, 'chorus vocal only in the room slot');
  assert.match(r.report.slots[2].from, /linked/);
});

test('restructure carries "unlinked on purpose" by role (counted from the end), and slot 0 always comes from the room', () => {
  // C1 (room) · C2 (linked) · C3 (unlinked, its own take). Drop C2 → the LAST chorus must still be the different one.
  const s = { bpm: 120, timeSig: [4, 4], linkGroups: { chorus: true },
    sections: [{ id: 'c1', name: 'Chorus', start: 0, end: 8 }, { id: 'c2', name: 'Chorus', start: 8, end: 16 }, { id: 'c3', name: 'Chorus', start: 16, end: 24, unlinked: true }],
    tracks: [{ id: 't', clips: [{ id: 'room', start: 0, duration: 8 }, { id: 'last', start: 16, duration: 8 }] }] };
  const r = T.restructure(s, [['Chorus', 4], ['Chorus', 4]], { newId, linkGroups: s.linkGroups });
  assert.ok(!r.sections[0].unlinked && r.sections[1].unlinked, JSON.stringify(r.sections));
  assert.deepEqual(r.tracks[0].clips.map((c) => c.src), ['room', 'last']);
  // first chorus unlinked: the room is the first LINKED one, and slot 0 is filled from it
  const s2 = { ...s, sections: [{ id: 'c1', name: 'Chorus', start: 0, end: 8, unlinked: true }, { id: 'c2', name: 'Chorus', start: 8, end: 16 }], tracks: [{ id: 't', clips: [{ id: 'odd', start: 0, duration: 8 }, { id: 'room', start: 8, duration: 8 }] }] };
  const r2 = T.restructure(s2, [['Chorus', 4], ['Chorus', 4]], { newId, linkGroups: s2.linkGroups });
  assert.ok(!r2.sections[0].unlinked); assert.equal(r2.tracks[0].clips[0].src, 'room');
});

test('a post-chorus is its own part type in every spelling (not a chorus)', () => {
  for (const n of ['Post-chorus', 'Post Chorus', 'postchorus', 'Post-chorus 3']) assert.equal(T.sectionType(n), 'post-chorus', n);
  for (const n of ['Chorus', 'Chorus 2', 'Big Chorus', 'Refrain', 'Hook']) assert.equal(T.sectionType(n), 'chorus', n);
});

test('part tails & pickups: a take that rings past its part / starts a beat early is copied and moved whole', () => {
  const s = { sections: [{ id: 'v1', name: 'Verse', start: 0, end: 8 }, { id: 'c1', name: 'Chorus', start: 8, end: 16 }, { id: 'v2', name: 'Verse 2', start: 16, end: 24 }, { id: 'c2', name: 'Chorus 2', start: 24, end: 32 }],
    linkGroups: { verse: true, chorus: true },
    tracks: [{ id: 'g', clips: [{ id: 'aaaaaaaaaaaa', start: 7.5, duration: 9.5, trimStart: 0, trimEnd: 0, name: 'chorus take with pickup + ring-out' }, { id: 'bbbbbbbbbbbb', start: 0, duration: 8.6, trimStart: 0, trimEnd: 0, name: 'verse take ringing into the chorus' }] }] };
  const edge = () => 2;
  const r = T.linkMirrors(s, { edge });
  const m = r.tracks[0].clips.filter((c) => c.link).map((c) => [c.link.from, c.start, Math.round((c.duration - c.trimStart - c.trimEnd) * 100) / 100]).sort();
  assert.deepEqual(m, [['aaaaaaaaaaaa', 23.5, 9.5], ['bbbbbbbbbbbb', 16, 8.6]], 'Chorus 2 gets the pickup at 23.5 and the ring-out; Verse 2 rings into Chorus 2 like Verse 1 does');
  // recorded into Chorus 2 with a pickup and a ring-out: moves to the room whole (not cut at the barlines)
  const s2 = { ...s, tracks: [{ id: 'g', clips: [{ id: 'cccccccccccc', start: 23.4, duration: 9.4, trimStart: 0, trimEnd: 0 }] }] };
  const cv = T.carveFollowers(s2, { edge, newId: () => 'dddddddddddd' });
  assert.deepEqual(cv.moved.map((x) => [x.clip.id, Math.round(x.clip.start * 100) / 100, x.clip.duration]), [['cccccccccccc', 7.4, 9.4]]); assert.deepEqual(cv.unlinked, []);
});

test('a straight-through vocal take neither unlinks the chorus copies nor gets mirrored into them', () => {
  const T = require('../../src/renderer/templates.js');
  const song = { linkGroups: { chorus: true }, sections: [{ id: 'v1', name: 'Verse 1', start: 0, end: 8 }, { id: 'c1', name: 'Chorus 1', start: 8, end: 16 }, { id: 'v2', name: 'Verse 2', start: 16, end: 24 }, { id: 'c2', name: 'Chorus 2', start: 24, end: 32 }],
    tracks: [{ id: 'vox', name: 'Lead vox', type: 'vocals', clips: [{ id: 'full', start: 0, duration: 32, trimStart: 0, trimEnd: 0 }] }, { id: 'gtr', name: 'Gtr', clips: [{ id: 'g', start: 8, duration: 8, trimStart: 0, trimEnd: 0 }] }] };
  const through = (t) => t.type === 'vocals';
  const carved = T.carveFollowers(song, { through });
  assert.deepEqual(carved.unlinked, []);
  assert.equal(carved.tracks[0].clips.length, 1);
  const m = T.linkMirrors(song, { through });
  assert.equal(m.tracks[0].clips.filter((c) => c.link).length, 0);
  assert.equal(m.tracks[1].clips.filter((c) => c.link).length, 1);
  // without the rule the full take would unlink Chorus 2
  assert.ok(T.carveFollowers(song, {}).unlinked.includes('c2'));
});
