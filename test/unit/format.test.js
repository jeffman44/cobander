'use strict';
// Format freeze (FORMAT.md): what a newer Cobander adds to a song survives a load + save by this one.
const test = require('node:test'); const assert = require('node:assert/strict');
globalThis.window = globalThis.window || globalThis;
window.BPSynth = window.BPSynth || { SYNTHS: { voice: {}, bassgtr: {}, pad: {}, distgtr: {} }, KITS: { rock: {} } };
window.BPPresets = window.BPPresets || { DRUM_PATTERNS: { 'Rock 4/4': {} } };
require('../../src/renderer/engine.js');
const { normalizeTrack, normalizeMaster } = window.BPEngine;
const C = require('../../src/renderer/collab');
const clone = (x) => JSON.parse(JSON.stringify(x));

test('format: unknown track, fx, clip and master fields ride through untouched', () => {
  const t = normalizeTrack({ id: 'trk1', name: 'Gtr', futureLane: { a: 1 }, fx: { futureFx: { on: true, amount: 0.3 } }, clips: [{ id: 'aaaaaaaaaaaa', start: 1, duration: 2, futureClip: ['x', 2] }] });
  assert.deepEqual(t.futureLane, { a: 1 }); assert.deepEqual(t.fx.futureFx, { on: true, amount: 0.3 }); assert.deepEqual(t.clips[0].futureClip, ['x', 2]);
  assert.equal(t.name, 'Gtr'); assert.equal(t.fx.comp.on, false, 'known fields still normalized');
  assert.deepEqual(normalizeMaster({ gainDb: 3, futureBus: 'glue' }).futureBus, 'glue');
  const again = normalizeTrack(clone(t)); assert.deepEqual(again, t, 'load → save → load is stable');
});

test('format: known fields keep their limits (unknown ones cannot overwrite them)', () => {
  const t = normalizeTrack({ id: 'trk1', gainDb: 99, pan: -7, clips: [] });
  assert.equal(t.gainDb, 12); assert.equal(t.pan, -1);
});

test('format: a collection this version does not know merges like the known ones', () => {
  const base = { tracks: [{ id: 't1' }], setlists: [{ id: 'a', name: 'Fri' }] };
  const mine = clone(base); mine.setlists.push({ id: 'b', name: 'Sat' });
  const theirs = clone(base); theirs.setlists[0].name = 'Friday'; theirs.setlists.push({ id: 'c', name: 'Sun' });
  C.mergeCollections(mine, theirs, base);
  assert.deepEqual(mine.setlists.map((x) => [x.id, x.name]), [['a', 'Friday'], ['b', 'Sat'], ['c', 'Sun']]);
  assert.deepEqual(mine.tracks, [{ id: 't1' }], 'tracks are not merged as a collection');
});
