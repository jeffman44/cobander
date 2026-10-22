'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
globalThis.window = globalThis.window || globalThis;
window.BPSynth = window.BPSynth || { SYNTHS: { voice: {}, bassgtr: {}, pad: {}, distgtr: {} }, KITS: { rock: {} } };
window.BPPresets = window.BPPresets || { DRUM_PATTERNS: { 'Rock 4/4': {} } };
require('../../src/renderer/engine.js');
const { foldChannels } = window.BPEngine;
const sig = (n, g, seed = 1) => { let s = seed; return Float32Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; return g * (s / 2147483647 * 2 - 1); }); };

test('record channels: auto folds a dead side or a mirrored input, keeps a real stereo pair', () => {
  const L = sig(4000, 0.5), dead = sig(4000, 0.0005, 9), R = sig(4000, 0.5, 7);
  assert.equal(foldChannels([L, dead]).length, 1); assert.equal(foldChannels([L, dead])[0], L);
  assert.equal(foldChannels([dead, R])[0], R, 'input 2 live, input 1 dead');
  assert.equal(foldChannels([L, Float32Array.from(L)]).length, 1, 'mirrored mono');
  assert.equal(foldChannels([L, R]).length, 2, 'two different signals stay stereo');
  const noisy = sig(4000, 0.01, 3); assert.equal(foldChannels([L, noisy]).length, 2, 'a −40 dB second input is a signal, not a dead jack');
});
test('record channels: left / right / stereo are explicit', () => {
  const L = sig(100, 0.5), R = sig(100, 0.5, 2);
  assert.equal(foldChannels([L, R], 'left')[0], L); assert.equal(foldChannels([L, R], 'right')[0], R); assert.equal(foldChannels([L, R], 'stereo').length, 2);
  assert.equal(foldChannels([L], 'right').length, 1, 'mono input stays as it is');
});
