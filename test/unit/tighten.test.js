'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../src/renderer/tighten.js');

const SR = 48000;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
// noise-burst "hits" on 1/8 notes at 120 bpm with ±15–30 ms timing errors; returns {x, hits (true times), grid}
function drums(seconds, seed = 7) {
  const r = rng(seed); const n = Math.round(seconds * SR); const x = new Float32Array(n); const hits = [], grid = [];
  for (let g = 0.25; g < seconds - 0.3; g += 0.25) {
    grid.push(g); const err = (0.015 + r() * 0.015) * (r() < 0.5 ? -1 : 1); const t = g + err; hits.push(t);
    const s0 = Math.round(t * SR); const amp = 0.4 + r() * 0.4;
    for (let i = 0; i < 0.12 * SR && s0 + i < n; i++) x[s0 + i] += amp * (r() * 2 - 1) * Math.exp(-i / (0.02 * SR));
  }
  return { x, hits, grid };
}
const meanErr = (found, grid) => found.reduce((s, t) => s + Math.abs(T.nearest(grid, t) - t), 0) / found.length;

test('onsets: ≥ 95 % of the hits found within 3 ms', () => {
  const { x, hits } = drums(8);
  const on = T.onsets(x, SR).map((o) => o.t);
  const ok = hits.filter((h) => on.some((t) => Math.abs(t - h) <= 0.003)).length;
  assert.ok(ok / hits.length >= 0.95, `${ok}/${hits.length}`);
  assert.ok(on.length <= hits.length + 2, `no extras: ${on.length} vs ${hits.length}`);
});

test('plan: moves within the window by strength, leaves far hits alone, stays monotonic', () => {
  const a = T.plan([{ t: 1.02, strength: 1 }, { t: 1.4, strength: 1 }, { t: 1.49, strength: 0.05 }, { t: 2.03, strength: 1 }], [1, 1.5, 2], { strength: 0.5, window: 0.07, length: 3 });
  assert.deepEqual(a.map((x) => [x.src, +x.dst.toFixed(4)]), [[0, 0], [1.02, 1.01], [1.4, 1.4], [2.03, 2.015], [3, 3]]);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].dst > a[i - 1].dst && a[i].src > a[i - 1].src);
});

test('warp: strength 1 lands the hits on the grid, 0.5 about halves the error, length kept, steady tone untouched', () => {
  const { x, grid } = drums(8);
  const before = meanErr(T.onsets(x, SR).map((o) => o.t), grid);
  const full = T.tightenClip({ channels: [x], sr: SR, grid: () => grid, strength: 1 });
  assert.ok(Math.abs(full.channels[0].length - x.length) / x.length < 0.01);
  const after = meanErr(T.onsets(full.channels[0], SR).map((o) => o.t), grid);
  assert.ok(after < 0.003, `after ${(after * 1000).toFixed(2)} ms (before ${(before * 1000).toFixed(1)})`);
  const half = T.tightenClip({ channels: [x], sr: SR, grid: () => grid, strength: 0.5 });
  const mid = meanErr(T.onsets(half.channels[0], SR).map((o) => o.t), grid);
  assert.ok(mid > before * 0.3 && mid < before * 0.7, `half ${(mid * 1000).toFixed(1)} vs before ${(before * 1000).toFixed(1)}`);
  assert.ok(full.meanErrAfter < 1e-3 && full.meanErrBefore > 0.01 && full.moved > 20);
  // a tone with one hit in the middle: away from the hit the tone's level is unchanged
  const n = 4 * SR, tone = new Float32Array(n); for (let i = 0; i < n; i++) tone[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / SR);
  for (let i = 0; i < 2000; i++) tone[2 * SR + 600 + i] += 0.8 * Math.exp(-i / 300) * (i % 7 < 3 ? 1 : -1);
  const r = T.tightenClip({ channels: [tone], sr: SR, grid: () => [2], strength: 1 });
  const rms = (a, s, e) => { let q = 0; for (let i = s; i < e; i++) q += a[i] * a[i]; return Math.sqrt(q / (e - s)); };
  const a0 = rms(tone, 0.5 * SR, 1.5 * SR), a1 = rms(r.channels[0], 0.5 * SR, 1.5 * SR); const b0 = rms(tone, 3 * SR, 3.8 * SR), b1 = rms(r.channels[0], 3 * SR, 3.8 * SR);
  assert.ok(Math.abs(a1 / a0 - 1) < 0.05 && Math.abs(b1 / b0 - 1) < 0.05, `${a1 / a0} ${b1 / b0}`);
});

test('quantizeNotes moves toward the grid by strength, keeps length', () => {
  const q = T.quantizeNotes([{ t: 1.1, d: 0.2, n: 60, v: 0.8 }, { t: 0.02, d: 0.1, n: 62 }], [0, 0.5, 1, 1.5], { strength: 0.5 });
  assert.deepEqual(q.map((x) => [+x.t.toFixed(3), x.d]), [[1.05, 0.2], [0.01, 0.1]]);
});

test('30 s of stereo tightens in under 3 s', () => {
  const { x, grid } = drums(30, 3); const y = x.map((v, i) => v * 0.8 + (i % 2 ? 0.001 : 0));
  const t0 = Date.now(); const r = T.tightenClip({ channels: [x, Float32Array.from(y)], sr: SR, grid: () => grid, strength: 0.8 });
  const ms = Date.now() - t0; assert.ok(ms < 3000, `${ms} ms`); assert.equal(r.channels.length, 2);
});
