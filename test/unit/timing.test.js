'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../src/renderer/timing.js');

const BEAT = 0.5, BAR = 2;   // 120 bpm 4/4
const grid = Array.from({ length: 4 * 8 }, (_, i) => i * BEAT / 2);   // 1/8 notes over 4 bars
const bars = [0, 2, 4, 6];
// bar 1 all +20 ms, bar 2 all −20, bar 3 ±5 mixed, bar 4 empty; one stray hit 150 ms off a line
function onsets() {
  const out = [];
  for (let i = 0; i < 8; i++) out.push({ t: i * BEAT / 2 + 0.020, strength: 1 });
  for (let i = 0; i < 8; i++) out.push({ t: BAR + i * BEAT / 2 - 0.020, strength: 1 });
  for (let i = 0; i < 8; i++) out.push({ t: 2 * BAR + i * BEAT / 2 + (i % 2 ? 0.005 : -0.005), strength: 0.9 });
  out.push({ t: 3 * BAR + 0.150, strength: 1 });   // far from any line (1/8 = 250 ms apart): ignored
  out.push({ t: 3 * BAR + 0.5, strength: 0.05 });  // too weak: ignored
  return out;
}

test('per-bar early / late in ms, strays and weak hits ignored', () => {
  const r = T.report({ onsets: onsets(), gridTimes: grid, barStarts: bars });
  assert.equal(r.bars.length, 3);
  const [b1, b2, b3] = r.bars;
  assert.equal(b1.bar, 1); assert.ok(Math.abs(b1.meanMs - 20) < 0.5 && Math.abs(b1.medianMs - 20) < 0.5 && Math.abs(b1.absMs - 20) < 0.5, JSON.stringify(b1));
  assert.ok(Math.abs(b2.meanMs + 20) < 0.5 && Math.abs(b2.absMs - 20) < 0.5);
  assert.ok(Math.abs(b3.meanMs) < 0.5 && Math.abs(b3.absMs - 5) < 0.5 && Math.abs(Math.abs(b3.worstMs) - 5) < 0.5);
  assert.equal(b1.n + b2.n + b3.n, 24);
  assert.equal(r.overall.n, 24); assert.ok(Math.abs(r.overall.medianMs) <= 5.5, String(r.overall.medianMs));
  assert.ok(Math.abs(r.overall.lateShare - 12 / 24) < 0.01);
  assert.equal(r.overall.offsetLikely, false);
  assert.ok(Math.abs(r.overall.meanAbsMs - 15) < 0.5 && ['tight', 'ok'].includes(r.grade));   // mean |err| sits on the 15 ms boundary
});

test('grade thresholds and a fixed offset', () => {
  const mk = (ms) => grid.map((t) => ({ t: t + ms / 1000, strength: 1 }));
  const r25 = T.report({ onsets: mk(25), gridTimes: grid, barStarts: bars });
  assert.equal(r25.overall.offsetLikely, true); assert.equal(r25.overall.rushDrag, 'late'); assert.equal(r25.grade, 'ok');
  assert.equal(T.report({ onsets: mk(5), gridTimes: grid, barStarts: bars }).grade, 'tight');
  assert.equal(T.report({ onsets: mk(-40), gridTimes: grid, barStarts: bars }).grade, 'loose');
  assert.equal(T.report({ onsets: mk(-40), gridTimes: grid, barStarts: bars }).overall.rushDrag, 'early');
  assert.equal(T.report({ onsets: mk(0), gridTimes: grid, barStarts: bars }).overall.rushDrag, 'even');
});

test('reportNotes matches report for the same times; summary text; chart runs on a fake ctx', () => {
  const on = onsets().filter((o) => o.strength >= 0.25);
  const a = T.report({ onsets: on, gridTimes: grid, barStarts: bars }), b = T.reportNotes({ notes: on.map((o) => ({ t: o.t })), gridTimes: grid, barStarts: bars });
  assert.deepEqual(a.bars.map((x) => [x.bar, x.meanMs, x.absMs]), b.bars.map((x) => [x.bar, x.meanMs, x.absMs]));
  const txt = T.summaryText(T.report({ onsets: grid.map((t) => ({ t: t + 0.025, strength: 1 })), gridTimes: grid, barStarts: bars }), { fmtBar: (n) => `bar ${n}` });
  assert.match(txt, /mostly 25 ms late/); assert.match(txt, /fixed offset/); assert.match(txt, /worst: bar \d+ \(25 ms\)/);
  assert.equal(T.summaryText(T.report({ onsets: [], gridTimes: grid, barStarts: bars })), 'no hits near the grid');
  const calls = []; const ctx = { fillRect: (...x) => calls.push(x), clearRect: () => {} };
  T.barChart(ctx, a, { w: 120, h: 40 }); assert.ok(calls.length >= a.bars.length);
  const calls2 = []; const ctx2 = { beginPath: () => {}, roundRect: (...x) => calls2.push(x), fill: () => {}, fillRect: () => {}, clearRect: () => {} };
  T.barChart(ctx2, a, { w: 120, h: 40 }); assert.equal(calls2.length, a.bars.length);
});
