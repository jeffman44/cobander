const test = require('node:test'); const assert = require('node:assert/strict');
const K = require('../../src/renderer/karaoke.js'); const T = require('../../src/renderer/templates.js');
test('karaoke: word timings kept, typed lines spread, chords on words, linked choruses show the room words', () => {
  const song = {
    sections: [{ id: 'c1', name: 'Chorus', start: 0, end: 8 }, { id: 'v', name: 'Verse', start: 8, end: 16 }, { id: 'c2', name: 'Chorus 2', start: 16, end: 24 }],
    linkGroups: { chorus: true },
    lyrics: [{ id: 'a', time: 1, text: 'hey ho', words: [{ w: 'hey', t: 0, e: 0.5 }, { w: 'ho', t: 0.6, e: 1 }] }, { id: 'b', time: 9, text: 'typed by hand line' }, { id: 'u', time: null, text: 'unpinned' }],
    chords: [{ id: 'x', time: 1.6, chord: 'G' }, { id: 'y', time: 9, chord: 'D' }],
  };
  const ls = K.lines(song, { linkInfo: T.linkInfo });
  assert.deepEqual(ls.map((l) => [l.time, l.text, l.ghost]), [[1, 'hey ho', false], [9, 'typed by hand line', false], [17, 'hey ho', true]]);
  assert.equal(ls[0].chords[0].chord, 'G'); assert.equal(ls[0].chords[0].wi, 1, 'G lands on "ho"');
  assert.equal(ls[1].words.length, 4); assert.ok(ls[1].spread); assert.ok(ls[1].words[3].e <= 16);
  assert.equal(ls[2].words[0].t, 17); assert.equal(ls[2].section, 'Chorus 2');
  const a = K.at(ls, 1.7); assert.equal(a.cur.text, 'hey ho'); assert.equal(a.wi, 1); assert.equal(a.next.time, 9);
  assert.equal(K.at(ls, 5).cur, null, 'nothing sung between lines');
});
