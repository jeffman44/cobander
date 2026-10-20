'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/renderer/collab');

const clone = (x) => JSON.parse(JSON.stringify(x));

test('merge: their new entries come in, mine stay', () => {
  const base = { sections: [{ id: 's1', name: 'Intro', start: 0, end: 8 }] };
  const mine = clone(base); mine.sections.push({ id: 's2', name: 'Verse', start: 8, end: 24 });
  const theirs = clone(base); theirs.sections.push({ id: 's3', name: 'Chorus', start: 24, end: 40 });
  const kept = C.mergeCollections(mine, theirs, base);
  assert.deepEqual(mine.sections.map((s) => s.id), ['s1', 's2', 's3']);
  assert.deepEqual(kept, ['1 section']);
});

test('merge: field-level — they rename, I move: both survive', () => {
  const base = { sections: [{ id: 's1', name: 'Verse', start: 8, end: 24 }] };
  const mine = clone(base); mine.sections[0].start = 10;
  const theirs = clone(base); theirs.sections[0].name = 'Verse 1';
  C.mergeCollections(mine, theirs, base);
  assert.deepEqual(mine.sections[0], { id: 's1', name: 'Verse 1', start: 10, end: 24 });
});

test('merge: same field changed on both sides keeps mine', () => {
  const base = { chords: [{ id: 'c1', time: 0, chord: 'G' }] };
  const mine = clone(base); mine.chords[0].chord = 'G7';
  const theirs = clone(base); theirs.chords[0].chord = 'Gmaj7';
  C.mergeCollections(mine, theirs, base);
  assert.equal(mine.chords[0].chord, 'G7');
});

test('merge: a delete on either side wins', () => {
  const base = { needs: [{ id: 'n1', text: 'needs bass' }, { id: 'n2', text: 'needs harmony' }] };
  const mine = clone(base); mine.needs[0].text = 'needs a bass line';
  const theirs = clone(base); theirs.needs[0].deleted = true; theirs.needs[0].deletedBy = 'Kat';
  mine.needs[1].deleted = true;
  C.mergeCollections(mine, theirs, base);
  assert.equal(mine.needs[0].deleted, true); assert.equal(mine.needs[0].deletedBy, 'Kat');
  assert.equal(mine.needs[1].deleted, true);
});

test('merge: two people replying to the same note at once both keep their reply', () => {
  const base = { markers: [{ id: 'm1', time: 3, text: 'too fast here?', by: 'Jeff', replies: [] }] };
  const mine = clone(base); mine.markers[0].replies.push({ id: 'r1', text: 'yeah', by: 'Jeff' });
  const theirs = clone(base); theirs.markers[0].replies.push({ id: 'r2', text: 'no, fine', by: 'Kat' }); theirs.markers[0].resolved = { by: 'Kat', at: 'x' };
  C.mergeCollections(mine, theirs, base);
  assert.deepEqual(mine.markers[0].replies.map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(mine.markers[0].resolved, { by: 'Kat', at: 'x' }, 'their resolve comes along: I did not touch that field');
});

test('merge: un-resolve by them after a resolve in the baseline', () => {
  const base = { markers: [{ id: 'm1', text: 'x', resolved: { by: 'Jeff' } }] };
  const mine = clone(base);
  const theirs = clone(base); delete theirs.markers[0].resolved;
  C.mergeCollections(mine, theirs, base);
  assert.equal(mine.markers[0].resolved, undefined);
});

test('merge: no baseline (older client) keeps mine and fills gaps', () => {
  const mine = { lyrics: [{ id: 'l1', time: 1, text: 'mine' }] };
  const theirs = { lyrics: [{ id: 'l1', time: 2, text: 'theirs', by: 'Kat' }, { id: 'l2', time: 5, text: 'new' }] };
  C.mergeCollections(mine, theirs, null);
  assert.deepEqual(mine.lyrics[0], { id: 'l1', time: 1, text: 'mine', by: 'Kat' });
  assert.equal(mine.lyrics.length, 2);
});

test('merge: activity is unioned, time-ordered and capped', () => {
  const mine = { activity: [{ id: 'a2', at: '2026-01-02', items: ['x'] }] };
  const theirs = { activity: [{ id: 'a1', at: '2026-01-01', items: ['y'] }, { id: 'a3', at: '2026-01-03', items: ['z'] }] };
  C.mergeCollections(mine, theirs, { activity: [] });
  assert.deepEqual(mine.activity.map((a) => a.id), ['a1', 'a2', 'a3']);
  const big = { activity: Array.from({ length: C.ACTIVITY_CAP + 20 }, (_, i) => ({ id: `x${i}`, at: String(i).padStart(5, '0') })) };
  const m2 = { activity: [] }; C.mergeCollections(m2, big, null);
  assert.equal(m2.activity.length, C.ACTIVITY_CAP); assert.equal(m2.activity[m2.activity.length - 1].id, `x${C.ACTIVITY_CAP + 19}`);
});

test('activity entries dedupe, drop the generic label and cap items', () => {
  assert.equal(C.activityEntry(['change', ''], 'Jeff', 't', 'id'), null);
  const e = C.activityEntry(['mute take 3', 'mute take 3', 'add note', ...Array.from({ length: 20 }, (_, i) => `x${i}`)], 'Jeff', 't', 'id');
  assert.equal(e.items[0], 'mute take 3'); assert.equal(e.items[1], 'add note'); assert.equal(e.items.length, 13); assert.match(e.items[12], /^\+10 more$/);
  const song = {}; C.pushActivity(song, e); assert.equal(song.activity.length, 1);
  assert.equal(C.feed({ activity: [{ id: 1, at: 'a' }, { id: 2, at: 'b' }] })[0].id, 2);
});

test('mentions: single and known two-word names, emails ignored', () => {
  assert.deepEqual(C.mentionsIn('hey @Kat can you take this'), ['Kat']);
  assert.deepEqual(C.mentionsIn('@Logan Furer redo', ['Logan Furer']), ['Logan Furer']);
  assert.deepEqual(C.mentionsIn('@Logan redo', ['Logan Furer']), ['Logan']);
  assert.deepEqual(C.mentionsIn('mail daniel@crabshell.com'), []);
  assert.deepEqual(C.mentionsIn('@zach.'), ['zach']);
});

test('mentionsFor skips my own notes, resolved notes and old ones', () => {
  const song = { markers: [
    { id: 'a', text: '@Jeff 1', by: 'Kat', at: '2026-10-10' },
    { id: 'b', text: '@Jeff 2', by: 'Jeff', at: '2026-10-10' },
    { id: 'c', text: '@jeff 3', by: 'Kat', at: '2026-10-10', resolved: { by: 'Kat' } },
    { id: 'd', text: '@Jeff 4', by: 'Kat', at: '2026-09-01' },
    { id: 'e', text: 'x', by: 'Kat', at: '2026-09-01', deleted: true, replies: [{ id: 'r', text: '@Jeff', by: 'Kat', at: '2026-10-10' }] },
  ] };
  assert.equal(C.mentionsFor(song, 'Jeff', { since: '2026-10-01' }).length, 1);
  assert.equal(C.mentionsFor(song, 'Jeff').length, 2);
});

test('votes: top voted take, ties give no winner', () => {
  const song = { votes: [{ id: 1, clipId: 'a', by: 'Jeff' }, { id: 2, clipId: 'a', by: 'Kat' }, { id: 3, clipId: 'b', by: 'Zach' }, { id: 4, clipId: 'b', by: 'Logan', deleted: true }] };
  assert.equal(C.topVoted(song, ['a', 'b']), 'a');
  song.votes.push({ id: 5, clipId: 'b', by: 'Daniel' });
  assert.equal(C.topVoted(song, ['a', 'b']), null);
  assert.equal(C.topVoted(song, ['c']), null);
});

test('time lookups: section, chord and lyric at a time', () => {
  const song = {
    sections: [{ id: 1, name: 'Verse', start: 0, end: 10 }, { id: 2, name: 'Chorus', start: 10, end: 20 }],
    chords: [{ id: 1, time: 0, chord: 'G' }, { id: 2, time: 4, chord: 'D' }, { id: 3, time: 2, chord: 'X', deleted: true }],
    lyrics: [{ id: 1, time: 1, text: 'one' }, { id: 2, time: null, text: 'unpinned' }, { id: 3, time: 6, text: 'two' }],
  };
  assert.equal(C.sectionAt(song, 10).name, 'Chorus');
  assert.equal(C.sectionAt(song, 25), null);
  assert.equal(C.chordAt(song, 3).chord, 'G');
  assert.equal(C.chordAt(song, 4).chord, 'D');
  assert.equal(C.lyricAt(song, 0.5), null);
  assert.equal(C.lyricAt(song, 7).text, 'two');
  assert.equal(C.nextSectionName(song, 'Verse'), 'Verse 2');
  assert.equal(C.nextSectionName(song, 'Bridge'), 'Bridge');
});

test('chord bar parsing', () => {
  assert.deepEqual(C.parseChordBars('G D Em C').map((x) => [x.bar, x.chord]), [[0, 'G'], [1, 'D'], [2, 'Em'], [3, 'C']]);
  assert.deepEqual(C.parseChordBars('G | D A | Em').map((x) => [x.bar, x.frac, x.chord]), [[0, 0, 'G'], [1, 0, 'D'], [1, 0.5, 'A'], [2, 0, 'Em']]);
  assert.deepEqual(C.parseChordBars('hello G'), [{ bar: 1, frac: 0, chord: 'G' }]);
});

test('presence line', () => {
  const me = { user: 'Jeff', host: 'jeffpc' };
  assert.equal(C.presenceLine([{ user: 'Kat', host: 'm', mode: 'listening', playing: true }, { user: 'Jeff', host: 'jeffpc', mode: 'editing' }, { user: 'Zach', mode: 'listening', stale: true }], me), 'Kat is listening now');
  assert.equal(C.presenceLine([{ user: 'Logan', mode: 'recording' }], me), 'Logan is recording');
  assert.equal(C.presenceLine([], me), '');
});

test('knownPeople collects names from takes and collections', () => {
  const song = { savedBy: 'Kat', tracks: [{ clips: [{ takenBy: 'Zach' }] }], markers: [{ by: 'Logan', replies: [{ by: 'Daniel' }] }] };
  assert.deepEqual(C.knownPeople(song, ['Jeff']), ['Daniel', 'Jeff', 'Kat', 'Logan', 'Zach']);
});
