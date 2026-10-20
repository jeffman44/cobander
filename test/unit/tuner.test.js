'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../src/renderer/tuner.js');
const sig = (f, sr, n, harm = true) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) { const p = 2 * Math.PI * f * i / sr; x[i] = 0.4 * Math.sin(p) + (harm ? 0.3 * Math.sin(2 * p) + 0.15 * Math.sin(3 * p) : 0); } return x; };
test('detects guitar/bass pitches within a few cents', () => {
  const sr = 48000;
  for (const f of [30.87, 41.2, 55, 82.41, 110, 196, 329.63, 659.25]) {
    const r = T.detect(sig(f, sr, 4096), sr); assert.ok(r, `no pitch for ${f}`);
    const cents = 1200 * Math.log2(r.freq / f); assert.ok(Math.abs(cents) < 3, `${f} Hz read ${r.freq.toFixed(2)} (${cents.toFixed(1)} c)`);
  }
});
test('silence reads as nothing; note names and cents', () => {
  assert.equal(T.detect(new Float32Array(4096), 48000), null);
  assert.deepEqual(T.note(440), { midi: 69, name: 'A', octave: 4, cents: 0, target: 440 });
  const e = T.note(82.0); assert.equal(e.name, 'E'); assert.equal(e.octave, 2); assert.ok(e.cents < -5 && e.cents > -12);
});
