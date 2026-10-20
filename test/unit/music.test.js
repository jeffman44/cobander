'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/renderer/music');
const S = require('../../src/renderer/stretch');

test('keys, shifts and transposition', () => {
  assert.deepEqual(M.parseKey('C#/Db'), { pc: 1, minor: false, name: 'C#' });
  assert.equal(M.parseKey('F#m').minor, true);
  assert.equal(M.keyShift('G', 'A'), 2); assert.equal(M.keyShift('A', 'G'), -2);
  assert.equal(M.keyShift('Em', 'G'), 0, 'relative minor = same key'); assert.equal(M.keyShift('E', 'Bb'), 6); assert.equal(M.keyShift('', 'G'), 0);
  assert.equal(M.transposeChord('F#m7/C#', 2), 'G#m7/D#'); assert.equal(M.transposeChord('Bb', 2, true), 'C');
});

test('chords that fit a key, progressions, key guess', () => {
  assert.deepEqual(M.diatonic('G').map((x) => x.chord), ['G', 'Am', 'Bm', 'C', 'D', 'Em', 'F#dim']);
  assert.deepEqual(M.diatonic('Dm').map((x) => x.chord), ['Dm', 'Edim', 'F', 'Gm', 'Am', 'Bb', 'C']);
  assert.deepEqual(M.progressionsFor('C')[0].chords, ['C', 'G', 'Am', 'F']);
  assert.equal(M.guessKey(['G', 'D', 'Em', 'C']), 'G');
  assert.equal(M.guessKey(['Am', 'F', 'C', 'G']), 'Am');
});

const sine = (sec, f, sr = 48000) => { const n = Math.round(sec * sr); const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * f * i) / sr); return x; };
function freq(x, sr = 48000) { let z = 0; for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 && x[i] > 0) z++; return z / (x.length / sr); }

test('WSOLA stretch changes length, keeps pitch; conform shifts pitch independently', () => {
  const x = sine(2, 220);
  const y = S.stretchChannels([x], 1.25)[0];
  assert.ok(Math.abs(y.length - x.length * 1.25) < 2);
  assert.ok(Math.abs(freq(y.subarray(4800, y.length - 4800)) - 220) < 4, `pitch kept: ${freq(y)}`);
  const z = S.conformChannels([x], { ratio: 1.2, semis: 2 })[0];
  assert.ok(Math.abs(z.length - x.length / 1.2) < 4, `length ${z.length}`);
  assert.ok(Math.abs(freq(z.subarray(4800, z.length - 4800)) - 220 * Math.pow(2, 2 / 12)) < 5, `pitch up 2: ${freq(z)}`);
  const v = S.resampleChannels([x], 1.5)[0]; assert.ok(Math.abs(freq(v) - 330) < 3);
});
