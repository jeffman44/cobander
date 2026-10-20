'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const R = require('../../src/renderer/riff.js');
test('riff: 1/8 notes for 4 measures with 3 different notes, in key, repeating motif', () => {
  const o = { seconds: 8, bpm: 120, timeSig: [4, 4], rate: 2, notes: 3, key: 'E', low: 40, density: 0.8, seed: 9, motifBars: 1 };
  const g = R.generate(o);
  assert.equal(g.total, 32); assert.equal(g.rhythm.length, 32);
  assert.ok(g.notes.length > 10 && g.notes.every((n) => n.t >= 0 && n.t < 8 && n.d > 0));
  const pcs = new Set(g.notes.map((n) => n.n % 12)); assert.ok(pcs.size <= 3, `at most 3 pitches: ${[...pcs]}`);
  const E = [4, 6, 8, 9, 11, 1, 3]; assert.ok(g.notes.every((n) => E.includes(n.n % 12)), 'in E major');
  assert.equal(g.notes[0].t, 0); assert.equal(g.notes[0].n % 12, 4, 'starts on the root');
  assert.deepEqual(g.rhythm.slice(0, 8), g.rhythm.slice(8, 16), 'motif repeats');
  assert.deepEqual(R.generate(o), g, 'deterministic');
  // keep the rhythm, new notes / keep the notes, power chords, chug gate, follow chords
  const g2 = R.generate({ ...o, seed: 10, rhythm: g.rhythm }); assert.deepEqual(g2.rhythm, g.rhythm);
  const p = R.generate({ ...o, power: true, gate: 0.2 }); assert.ok(p.notes.every((n) => n.iv && n.iv[1] === 7 && n.d <= 0.25 * 0.2 + 1e-9));
  const f = R.generate({ ...o, notes: 1, follow: (t) => (t < 4 ? 'E' : 'A') }); assert.ok(f.notes.filter((n) => n.t >= 4).every((n) => n.n % 12 === 9), 'second half follows A');
  const t = R.generate({ ...o, rate: 3, seconds: 4 }); assert.equal(t.total, 24, 'triplets');
});
