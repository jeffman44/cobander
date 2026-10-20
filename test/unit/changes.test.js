'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/renderer/changes.js');
const base = () => ({ sections: [{ id: 's1', name: 'Verse 1', start: 0, end: 10 }, { id: 's2', name: 'Chorus', start: 10, end: 20 }], tracks: [{ id: 't1', name: 'Bass', clips: [{ id: 'c1', start: 0, takenBy: 'Dan' }] }], lyrics: [{ id: 'l1', time: 1, text: 'old words' }, { id: 'l2', time: 11, text: 'hook line' }], chords: [{ time: 10, chord: 'G' }], markers: [], activity: [{ by: 'Dan', at: '2026-10-01T00:00:00Z', items: ['recorded take 1 on Bass'] }] });
test('summarize: who did what since, new takes, words and chords per part', () => {
  const old = base(); const cur = base();
  cur.tracks[0].clips.push({ id: 'c2', start: 10, takenBy: 'Dan', name: 'take 2' }, { id: 'c3', start: 12, takenBy: 'Jeff', name: 'mine' });
  cur.lyrics[0].text = 'new words'; cur.chords.push({ time: 15, chord: 'D' });
  cur.activity.push({ by: 'Dan', at: '2026-10-10T00:00:00Z', items: ['recorded take 2 on Bass', 'edited lyrics'] }, { by: 'Jeff', at: '2026-10-11T00:00:00Z', items: ['mine'] });
  cur.markers.push({ id: 'n1', by: 'Kat', at: '2026-10-12T00:00:00Z', replies: [{ by: 'Jeff', at: '2026-10-12T01:00:00Z' }] });
  const r = C.summarize(old, cur, { since: '2026-10-05T00:00:00Z', me: 'jeff' });
  assert.deepEqual(r.people, [{ name: 'Dan', items: ['recorded take 2 on Bass', 'edited lyrics'] }]);
  assert.deepEqual(r.freshClips.map((c) => c.id), ['c2']);
  assert.deepEqual(r.lyrics, [{ part: 'Verse 1', sectionId: 's1', before: 'old words', after: 'new words' }]);
  assert.equal(r.chords.length, 1); assert.equal(r.chords[0].part, 'Chorus');
  assert.equal(r.notes, 1); assert.ok(r.any);
  assert.match(C.text(r), /Dan: recorded take 2 on Bass, edited lyrics · words changed in Verse 1 · chords changed in Chorus · 1 new note/);
});
test('nothing new → not any; no old song falls back to takenAt', () => {
  const s = base(); assert.equal(C.summarize(s, s, { since: '2026-10-05T00:00:00Z', me: 'Jeff' }).any, false);
  const cur = base(); cur.tracks[0].clips.push({ id: 'c9', start: 0, takenBy: 'Kat', takenAt: '2026-10-09T00:00:00Z' });
  assert.deepEqual(C.summarize(null, cur, { since: '2026-10-05T00:00:00Z', me: 'Jeff' }).freshClips.map((c) => c.id), ['c9']);
});
