'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../src/renderer/chordsdetect.js');

const SR = 48000, BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT;
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
// guitar-ish: each tone with 5 decaying harmonics, strummed (re-attacked) every beat, a little noise
function strum(chords, { bassNotes = null, seed = 1 } = {}) {
  const n = Math.round(chords.length * BAR * SR); const x = new Float32Array(n); const b = new Float32Array(n);
  let r = seed; const rnd = () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff - 0.5; };
  chords.forEach((tones, bi) => {
    for (let beat = 0; beat < 4; beat++) {
      const s0 = Math.round((bi * BAR + beat * BEAT) * SR), len = Math.round(BEAT * SR);
      tones.forEach((m, ti) => { const f = midiHz(m); const off = ti * 0.008; for (let h = 1; h <= 5; h++) { const a = 0.12 * 0.6 ** (h - 1), w = 2 * Math.PI * f * h / SR; for (let i = Math.round(off * SR); i < len; i++) x[s0 + i] += a * Math.sin(w * i) * Math.exp(-3 * i / SR); } });
      if (bassNotes) { const f = midiHz(bassNotes[bi]); for (let h = 1; h <= 4; h++) { const a = 0.25 * 0.5 ** (h - 1), w = 2 * Math.PI * f * h / SR; for (let i = 0; i < len; i++) b[s0 + i] += a * Math.sin(w * i) * Math.exp(-2 * i / SR); } }
    }
  });
  for (let i = 0; i < n; i++) x[i] += 0.003 * rnd();
  return { x, b };
}
const grid = (bars) => ({ beats: Array.from({ length: bars * 4 }, (_, i) => i * BEAT), barStarts: Array.from({ length: bars }, (_, i) => i * BAR) });
// G D Em C, guitar voicings
const G = [43, 47, 50, 55, 59, 67], Dch = [50, 57, 62, 66], Em = [40, 47, 52, 55, 59, 64], C = [48, 52, 55, 60, 64];

test('G | D | Em | C read off a strummed guitar + bass, one chord per bar at the bar line', () => {
  const { x, b } = strum([G, Dch, Em, C], { bassNotes: [31, 38, 28, 36] });
  const mix = new Float32Array(x.length); for (let i = 0; i < x.length; i++) mix[i] = x[i] + b[i];
  const r = D.detect({ audio: mix, sr: SR, ...grid(4), key: 'G' });
  assert.deepEqual(r.map((c) => c.chord), ['G', 'D', 'Em', 'C'], JSON.stringify(r));
  r.forEach((c, i) => assert.ok(Math.abs(c.time - i * BAR) < 0.05, `${c.chord} at ${c.time}`));
  // same without a key, and with a separate bass track
  assert.deepEqual(D.detect({ audio: x, sr: SR, bassAudio: b, ...grid(4) }).map((c) => c.chord), ['G', 'D', 'Em', 'C']);
  // t0 shifts the times
  assert.equal(D.detect({ audio: x, sr: SR, ...grid(4), t0: 10 })[1].time, 12);
});

test('D over an F# bass is D/F#', () => {
  const { x, b } = strum([Dch, Dch], { bassNotes: [42, 42] });
  const r = D.detect({ audio: x, sr: SR, bassAudio: b, ...grid(2), key: 'G' });
  assert.deepEqual(r.map((c) => c.chord), ['D/F#'], JSON.stringify(r));
});

test('fromNotes: MIDI triads, sevenths, minor', () => {
  const notes = []; const add = (t, ms) => ms.forEach((n) => notes.push({ t, d: BAR * 0.95, n }));
  add(0, [57, 60, 64]); add(BAR, [50, 53, 57, 60]); add(2 * BAR, [55, 59, 62, 65]); add(3 * BAR, [48, 52, 55]);
  assert.deepEqual(D.fromNotes(notes, { ...grid(4) }).map((c) => c.chord), ['Am', 'Dm7', 'G7', 'C']);
});

test('silence → no chords', () => {
  assert.deepEqual(D.detect({ audio: new Float32Array(SR * 4), sr: SR, ...grid(2) }), []);
  assert.deepEqual(D.fromNotes([], { beats: [0, 0.5] }), []);
});

test('3 minutes of audio in under 4 s', () => {
  const bars = 90; const one = strum([G, Dch, Em, C]).x; const x = new Float32Array(bars * BAR * SR);
  for (let o = 0; o < x.length; o += one.length) x.set(one.subarray(0, Math.min(one.length, x.length - o)), o);
  const t = Date.now(); const r = D.detect({ audio: x, sr: SR, ...grid(bars) }); const ms = Date.now() - t;
  assert.ok(ms < 4000, `${ms} ms`); assert.equal(r.length, bars);
  console.log(`# 3 min detect: ${ms} ms`);
});

test('pop-punk power chords + bass: the bass names the roots, the key it implies names major / minor, a wrong key label is overruled', () => {
  // B5 B5 G#5 E5 | B5 B5 G#5 F#5 (no thirds anywhere) over a bass on the roots — I vi IV / I vi V in B
  const P = (r) => [r, r + 7, r + 12]; const prog = [P(47), P(47), P(44), P(40), P(47), P(47), P(44), P(42)];
  const { x, b } = strum(prog, { bassNotes: [35, 35, 32, 28, 35, 35, 32, 30] });
  const r = D.detect({ audio: x, sr: SR, bassAudio: b, ...grid(8), key: 'Gm' });   // Gm is wrong on purpose
  assert.deepEqual(r.map((c) => c.chord), ['B', 'G#m', 'E', 'B', 'G#m', 'F#'], JSON.stringify(r));
  assert.equal(r.key, 'B'); assert.ok(r.keyHeard && r.keyHeard.key === 'B' && r.keyHeard.confidence >= 0.6, JSON.stringify(r.keyHeard));
  // one chord a bar by default: no half-bar flicker
  r.forEach((c) => assert.ok(Math.abs(c.time / BAR - Math.round(c.time / BAR)) < 0.01, `${c.chord} at ${c.time}`));
});
