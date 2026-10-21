const test = require('node:test'); const assert = require('node:assert/strict');
const Q = require('../../src/renderer/quest.js');
const f = (user, fields) => ({ user, fields: Object.fromEntries(Object.entries(fields).map(([k, [v, at]]) => [k, { v, at, by: user }])) });
const clip = (id, by, start, len, extra = {}) => ({ id, start, duration: len, trimStart: 0, trimEnd: 0, takenBy: by, takenAt: '2026-10-14T03:30:00', ...extra });
function song() {
  return {
    tracks: [
      { id: 'g', type: 'guitar', clips: [clip('a1', 'Dan', 0, 16), clip('a2', 'Dan', 16, 8)] },
      { id: 'd', type: 'drums', instrument: 'drumkit', clips: [clip('m1', 'FossTheBoss', 0, 8, { kind: 'midi', notes: [] })] },
      { id: 'v', type: 'vocals', clips: [clip('v1', 'Jeff', 8, 8, { link: { from: 'x', section: 'y' } })] },   // a linked copy: not a take
    ],
    sections: [{ id: 's1', name: 'Intro', start: 0, end: 8, by: 'Dan' }, { id: 's2', name: 'Verse', start: 8, end: 16, by: 'Dan' }, { id: 's3', name: 'Chorus', start: 16, end: 24, by: 'Jeff' }, { id: 's4', name: 'Outro', start: 24, end: 32, by: 'Jeff' }],
    chords: [{ id: 'c1', chord: 'G', by: 'Jeff', time: 0 }, { id: 'c2', chord: 'D', by: 'Jeff', time: 2, deleted: true }, { id: 'c3', chord: 'Em', by: 'Jeff', time: 4, link: {} }],
    lyrics: [{ id: 'l1', text: 'a', by: 'Jeff' }, { id: 'l2', text: 'b', by: 'Jeff' }],
    markers: [{ id: 'n1', text: 'tighten', by: 'Dan', replies: [{ id: 'r1', by: 'Jeff', text: 'ok' }] }],
    needs: [{ id: 'q1', text: 'harmony', by: 'Jeff', done: { by: 'Dan', at: 'x' } }],
    trash: { t9: { clip: clip('t9', 'Jeff', 0, 4), takenBy: 'Jeff' } },
    activity: [{ by: 'Dan', at: 'x', items: ['a'] }, { by: 'Jeff', at: 'y', items: ['b'] }],
    stage: 'writing',
  };
}
test('quest: who did what in a song, straight from song.json', () => {
  const { stats, by } = Q.songStats(song());
  assert.equal(stats.sections, 4); assert.equal(stats.chords, 1); assert.equal(stats.lyrics, 2); assert.equal(stats.takesTotal, 4);
  assert.equal(by.Dan.takes, 2); assert.equal(by.Dan.sections, 2); assert.equal(by.Dan.notes, 1); assert.equal(by.Dan.needsDone, 1); assert.equal(by.Dan.saves, 1);
  assert.equal(by.Dan.pct, 75, 'Dan\'s takes reach Intro, Verse, Chorus — 3 of 4 parts');
  assert.equal(by.FossTheBoss.midi, 1); assert.equal(by.FossTheBoss.pct, 25); assert.equal(by.FossTheBoss.nightTakes, 1); assert.deepEqual(by.FossTheBoss.kinds, ['drums']); assert.equal(by.Dan.days.length, 1);
  assert.equal(by.Jeff.takes, 1, 'the deleted take still counts (it was recorded); the linked copy does not');
  assert.equal(by.Jeff.pct, 25, 'the linked copy plays his part in the Verse; a trashed take covers nothing'); assert.equal(by.Jeff.chords, 1, 'deleted and mirrored chords are not his work'); assert.equal(by.Jeff.replies, 1); assert.equal(by.Jeff.lyrics, 2);
  assert.equal(Q.memberXp(by.Dan), 2 * 25 + 2 * 5 + 5 + 5 + 1);
});
test('quest: a song with no sections scores coverage by length', () => {
  const s = { tracks: [{ id: 'g', clips: [clip('a', 'Dan', 0, 10), clip('b', 'Dan', 5, 10), clip('c', 'Jeff', 30, 10)] }] };
  const { by } = Q.songStats(s); assert.equal(by.Dan.pct, Math.round(100 * 15 / 40)); assert.equal(by.Jeff.pct, 25);
});
test('quest: the board — members from the shared file (aliases), levels, achievements, song XP with goals/tasks/milestones', () => {
  const bp = [{ folder: 'Tremors', name: 'Tremors', quest: Q.songStats(song()), bounced: true }, { folder: 'Noodle pad - Dan', name: 'Noodle pad - Dan', quest: Q.songStats({ sandbox: true, tracks: [] }) }];
  const b = Q.board(Q.merge([f('Dan', { 'song:f:Tremors:goal:title': [true, 'a'], 'song:f:Tremors:task:t1': [{ text: 'practice', done: true }, 'a'], 'song:f:Tremors:task:t2': [{ text: 'gone', done: true, deleted: true }, 'a'] })]), bp, { me: 'FossTheBoss' });
  assert.deepEqual(b.songs.map((s) => s.name), ['Tremors'], 'noodle pads stay out');
  const zach = b.members.find((m) => m.name === 'Zach'); assert.ok(zach.isMe, 'FossTheBoss is Zach'); assert.equal(zach.midi, 1); assert.equal(zach.achievements.map((a) => a.id).join(','), 'first-take,night-owl');
  const dan = b.members.find((m) => m.name === 'Dan'); assert.equal(dan.xp, 71 + Math.round(0.75 * 15)); assert.equal(dan.level.title, 'Roadie'); assert.equal(dan.level.n, 1); assert.equal(Q.levelXp(10), Math.round(25 * Math.pow(10, 1.75))); assert.equal(Q.MEMBER_LEVELS.length, 100); assert.equal(Q.MEMBER_LEVELS[99][1], 'Never a Doubt'); assert.equal(dan.perSong[0].pct, 75);
  const s = b.songs[0]; assert.equal(s.prog.find((p) => p.member === 'Dan').pct, 75); assert.equal(s.prog.find((p) => p.member === 'Logan').pct, 0);
  assert.ok(s.milestones.find((x) => x.id === 'laidout').done && s.milestones.find((x) => x.id === 'bounce').done && !s.milestones.find((x) => x.id === 'chords').done && !s.milestones.find((x) => x.id === 'fullband').done);
  assert.equal(s.xp, 15 + 10 + Math.round(0.75 * 15 + 0.25 * 15 + 0.25 * 15) + 10 + 10, 'goal + task + coverage (Dan, Zach, Jeff via the linked copy) + laid out + bounced');
  assert.equal(s.max, 45 + 4 * 20 + 10 + (10 + 10 + 10 + 20 + 10 + 15 + 25));
});
test('quest: parts-written by hand only fills in for someone with no takes; setlist-only songs; same-name folding', () => {
  const bp = [{ folder: 'The Highwayman (cover)', name: 'The Highwayman (cover)', quest: Q.songStats(song()) }];
  const b = Q.board(Q.merge([f('Dan', { 'song:q:hw:meta': [{ name: 'The Highwayman (Official Cover)' }, 'a'], 'song:q:hw:m:Logan:manual': [90, 'a'], 'song:q:hw:m:Dan:manual': [10, 'a'], 'song:q:sk:meta': [{ name: 'Skeptic (Cover)' }, 'a'], 'song:q:sk:m:Logan:pct': [100, 'a'] })]), bp);
  const hw = b.songs.find((s) => s.folder); assert.equal(hw.prog.find((p) => p.member === 'Logan').pct, 90); assert.equal(hw.prog.find((p) => p.member === 'Logan').manual, true);
  assert.equal(hw.prog.find((p) => p.member === 'Dan').pct, 75, 'Dan has takes: counted, the hand value is ignored');
  const sk = b.songs.find((s) => !s.folder); assert.equal(sk.qid, 'q:sk'); assert.equal(sk.prog.find((p) => p.member === 'Logan').written, true); assert.equal(sk.milestones.length, 0);
});
test('quest: XP for an activity label', () => {
  assert.deepEqual(Q.xpForLabel('recorded take 3 on Gtr'), { xp: 25, what: 'take recorded' });
  assert.equal(Q.xpForLabel('recorded 4 loop passes on Vox').xp, 100);
  assert.equal(Q.xpForLabel('note at bar 3: "hi"').xp, 5); assert.equal(Q.xpForLabel('done: harmony').xp, 5); assert.equal(Q.xpForLabel('move take 2'), null);
});
test('quest: days and track kinds are counted once across songs (no "On a Roll" from one busy day)', () => {
  const s = () => ({ tracks: [{ id: 'g', type: 'guitar', clips: [clip('a', 'Dan', 0, 4)] }] });
  const bp = [1, 2, 3, 4, 5].map((i) => ({ folder: `S${i}`, name: `S${i}`, quest: Q.songStats(s()) }));
  const dan = Q.board(new Map(), bp).members.find((m) => m.name === 'Dan');
  assert.equal(dan.takeDays, 1); assert.equal(dan.trackKinds, 1); assert.equal(dan.takes, 5); assert.ok(!dan.achievements.some((a) => a.id === 'on-a-roll'));
});

test('practice minutes from each player\'s own file: totals, this week, top songs, XP capped at 60 a day', () => {
  const Q = require('../../src/renderer/quest.js');
  const today = new Date().toISOString().slice(0, 10);
  const files = [{ user: 'Jeff', fields: { [`practice:Jeff:${today}:f:Song A`]: { v: 90, at: '2026-10-20T10:00:00Z', by: 'Jeff' }, ['practice:Jeff:2020-01-01:f:Song B']: { v: 20, at: '2020-01-01T10:00:00Z', by: 'Jeff' } } }];
  const b = Q.board(Q.merge(files), [{ folder: 'Song A', name: 'Song A', quest: { stats: {}, by: {} } }], { me: 'Jeff' });
  const p = b.practice.members.find((x) => x.name === 'Jeff');
  assert.equal(p.total, 110); assert.equal(p.week, 90); assert.equal(p.top[0].song, 'Song A');
  const j = b.members.find((x) => x.name === 'Jeff'); assert.equal(j.practiceXp, 80);
});

test('two bandmates picking characters at once: neither wipes the other (own-file layer + per-member fields)', () => {
  const Q = require('../../src/renderer/quest.js');
  const roster = (jeffChar, loganChar) => [{ name: 'Jeff', role: 'Vocals', icon: '🎤', aliases: [], character: jeffChar }, { name: 'Logan', role: 'Guitar', icon: '🎸', aliases: [], character: loganChar }];
  // the 0.15.7 race: Jeff saves his pick, Logan (with a board loaded before Jeff's save) saves his a minute later
  const files = [f('Jeff', { 'band:members': [roster('howler', null), '2026-10-21T03:00:00Z'] }), f('Logan', { 'band:members': [roster(null, 'shredder'), '2026-10-21T03:01:00Z'] })];
  let b = Q.board(Q.merge(files), []);
  assert.equal(b.members.find((x) => x.name === 'Jeff').character, 'howler', "Jeff's pick survives Logan's later roster save");
  assert.equal(b.members.find((x) => x.name === 'Logan').character, 'shredder');
  assert.equal(b.members.find((x) => x.name === 'Logan').role, 'Guitar');
  // 0.15.8 writes: per-member fields win over both rosters, and only touch their own keys
  files[0].fields[Q.memberKey('Jeff')] = { v: { character: 'thumper' }, at: '2026-10-21T04:00:00Z', by: 'Jeff' };
  files[1].fields[Q.memberKey('Jeff')] = undefined; delete files[1].fields[Q.memberKey('Jeff')];
  files[1].fields[Q.memberKey('Logan')] = { v: { role: 'Lead guitar' }, at: '2026-10-21T04:00:01Z', by: 'Logan' };
  b = Q.board(Q.merge(files), []);
  const j = b.members.find((x) => x.name === 'Jeff'), l = b.members.find((x) => x.name === 'Logan');
  assert.equal(j.character, 'thumper'); assert.equal(j.role, 'Vocals');
  assert.equal(l.character, 'shredder'); assert.equal(l.role, 'Lead guitar');
  // someone else's copy of the roster can't change my character
  files[1].fields['band:members'] = { v: roster('noodle', 'shredder'), at: '2026-10-21T05:00:00Z', by: 'Logan' };
  assert.equal(Q.board(Q.merge(files), []).members.find((x) => x.name === 'Jeff').character, 'thumper');
});
