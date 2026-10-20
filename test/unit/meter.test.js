'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const M = require('../../src/renderer/meter.js');
test('meter: any time signature, groups and click accents', () => {
  assert.deepEqual(M.parseTimeSig('13/7'), [13, 7]); assert.deepEqual(M.parseTimeSig('2+2+3/8'), [7, 8, [2, 2, 3]]); assert.equal(M.parseTimeSig('0/4'), null); assert.equal(M.parseTimeSig('abc'), null);
  assert.deepEqual(M.accents([6, 8]), [2, 0, 0, 1, 0, 0], '6/8 = 1 . . 4 . .');
  assert.deepEqual(M.accents([12, 8]), [2, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
  assert.deepEqual(M.accents([7, 8]), [2, 0, 1, 0, 1, 0, 0], '7/8 = 2+2+3');
  assert.deepEqual(M.accents([7, 8, [3, 2, 2]]), [2, 0, 0, 1, 0, 1, 0]);
  assert.deepEqual(M.accents([3, 4]), [2, 0, 0]); assert.deepEqual(M.accents([13, 7]).filter(Boolean), [2]);
  assert.equal(M.tsLabel([7, 8, [2, 2, 3]]), '2+2+3/8'); assert.deepEqual(M.normTs([4, 3]), [4, 3]); assert.deepEqual(M.normTs([7, 8, [2, 2]]), [7, 8], 'groups must add up');
});
test('meter: a part with its own tempo and time signature — bars, beats and seconds line up', () => {
  // 120 bpm 4/4 (bar 2 s); bars 5–8 (8 s → …) are a Bridge at 90 bpm in 6/8 (bar = 6 × 0.667 = 4 s), then back
  const song = { bpm: 120, timeSig: [4, 4], sections: [{ id: 'v', name: 'Verse', start: 0, end: 8 }, { id: 'b', name: 'Bridge', start: 8, end: 24, bpm: 90, timeSig: [6, 8] }] };
  const m = M.build(song);
  assert.equal(m.segs.length, 3);
  assert.equal(M.barAt(m, 8), 4); assert.equal(M.barAt(m, 12), 5); assert.equal(M.barAt(m, 24), 8); assert.equal(M.barAt(m, 26), 9);
  assert.equal(M.secAtBar(m, 4), 8); assert.equal(M.secAtBar(m, 6), 16); assert.equal(M.secAtBar(m, 9), 26);
  const p = M.posAt(m, 13.4); assert.equal(p.bar, 6); assert.equal(p.beat, 3);
  const beats = M.beatsIn(m, 7, 13); assert.deepEqual(beats.map((x) => [Math.round(x.t * 1000) / 1000, x.accent]), [[7, 0], [7.5, 0], [8, 2], [8.667, 0], [9.333, 0], [10, 1], [10.667, 0], [11.333, 0], [12, 2], [12.667, 0]]);
  assert.deepEqual(M.barsIn(m, 0, 30).map((x) => x.bar), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(M.build({ bpm: 100, timeSig: [3, 4] }).uniform);
});
