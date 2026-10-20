'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const D = require('../../src/renderer/drums.js');
test('fills: quarter, 8th, 16th, triplets, backbeat, bar, off-beats', () => {
  const o = { seconds: 2, beatSec: 0.5, beatsPerBar: 4 };   // one bar of 4/4 at 120
  assert.equal(D.fillTimes('q', o).length, 4); assert.equal(D.fillTimes('e', o).length, 8); assert.equal(D.fillTimes('s', o).length, 16);
  assert.equal(D.fillTimes('t8', o).length, 12); assert.equal(D.fillTimes('t16', o).length, 24); assert.equal(D.fillTimes('half', o).length, 2);
  assert.deepEqual(D.fillTimes('back', o), [0.5, 1.5]); assert.deepEqual(D.fillTimes('bar', { ...o, seconds: 4 }), [0, 2]);
  assert.deepEqual(D.fillTimes('off', o), [0.25, 0.75, 1.25, 1.75]); assert.deepEqual(D.fillTimes('clear', o), []);
  assert.deepEqual(D.fillTimes('back', { seconds: 3, beatSec: 0.5, beatsPerBar: 3 }), [0.5, 2], '3/4 backbeat = beat 2');
});
test('generate: full part, backbeat, crash on 1, fill at the end, deterministic by seed, inside the part', () => {
  const opts = { seconds: 16, bpm: 120, timeSig: [4, 4], style: 'rock', sectionType: 'verse', intensity: 'normal', seed: 42 };
  const h = D.generate(opts); assert.ok(h.length > 60);
  assert.deepEqual(D.generate(opts), h, 'same seed, same groove');
  assert.ok(h.every((x) => x.t >= 0 && x.t < 16 && x.vel > 0 && x.vel <= 1));
  assert.ok(h.some((x) => x.voice === 'crash' && x.t === 0));
  assert.ok(h.some((x) => x.voice === 'snare' && Math.abs(x.t - 0.5) < 1e-9), 'snare on 2');
  const lastBeat = h.filter((x) => x.t >= 15.5); assert.ok(lastBeat.filter((x) => x.voice === 'snare' || x.voice === 'tom').length >= 2, 'fill in the last beat');
  const notes = D.toNotes(h); assert.deepEqual(D.fromNotes(notes).map((x) => x.voice), h.map((x) => x.voice));
  const c = D.generate({ ...opts, sectionType: 'chorus' }); assert.ok(c.some((x) => x.voice === 'ohat'), 'chorus opens up');
  const w = D.generate({ ...opts, timeSig: [3, 4], seconds: 12, style: 'shuffle' }); assert.ok(w.length > 20 && w.every((x) => x.t < 12));
  assert.equal(D.styleFor('Pop-punk'), 'punk'); assert.equal(D.styleFor('Metalcore'), 'metal'); assert.equal(D.styleFor(''), 'rock');
});
