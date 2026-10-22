'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { AudioStore, Entry, PEAK_BIN, i16, f32 } = require('../../src/renderer/audiostore.js');

// a stand-in AudioBuffer
function ab(frames, chans = 1, sr = 48000, fill = (i) => Math.sin(i / 7) * 0.5) {
  const data = Array.from({ length: chans }, (_, c) => Float32Array.from({ length: frames }, (_, i) => fill(i, c)));
  return { sampleRate: sr, length: frames, numberOfChannels: chans, duration: frames / sr, getChannelData: (c) => data[c] };
}

test('entries quack like AudioBuffers and keep the float data by reference', () => {
  const s = new AudioStore({ floatBudget: 1e9 }); const b = ab(1000);
  s.set('a', b); const e = s.get('a');
  assert.ok(e instanceof Entry); assert.equal(e.length, 1000); assert.equal(e.numberOfChannels, 1); assert.equal(e.sampleRate, 48000);
  assert.ok(Math.abs(e.duration - 1000 / 48000) < 1e-9);
  assert.strictEqual(e.getChannelData(0), b.getChannelData(0)); assert.strictEqual(e.ab, b); assert.equal(e.int16, false);
  assert.equal(s.size, 1); assert.ok(s.has('a')); assert.deepEqual([...s.keys()], ['a']);
});

test('over the float budget the biggest takes go to 16-bit, the one just added last', () => {
  const s = new AudioStore({ floatBudget: 4 * 8000 });   // room for 8000 frames of float
  s.set('big', ab(4000)); s.set('small', ab(1000));
  assert.equal(s.get('big').int16, false); assert.equal(s.get('small').int16, false);
  s.set('third', ab(4000));   // now 9000 frames of float > budget 8000 → 'big' converts (biggest, and not the newcomer)
  assert.equal(s.get('big').int16, true); assert.equal(s.get('third').int16, false); assert.equal(s.get('small').int16, false);
  assert.equal(s.get('big').ab, null); assert.ok(s.get('big').chans[0] instanceof Int16Array);
  const st = s.stats(); assert.equal(st.int16, 1); assert.equal(st.float, 2);
  s.set('fourth', ab(4000)); assert.equal(s.get('third').int16, true, 'next biggest float goes');
  const s0 = new AudioStore({ floatBudget: 0 }); s0.set('x', ab(10)); assert.equal(s0.get('x').int16, true, 'budget 0 = always 16-bit');
});

test('16-bit round trip is within half an LSB and the float views come from a bounded cache', () => {
  const s = new AudioStore({ floatBudget: 0 }); const b = ab(5000, 2, 44100, (i, c) => (c ? -1 : 1) * Math.sin(i / 3) * 0.9);
  s.set('a', b); const e = s.get('a');
  const f = e.getChannelData(1); assert.ok(f instanceof Float32Array); assert.equal(f.length, 5000);
  for (let i = 0; i < 5000; i += 97) assert.ok(Math.abs(f[i] - b.getChannelData(1)[i]) <= 1 / 32768, `sample ${i}`);
  assert.strictEqual(e.getChannelData(1), f, 'cached');
  const sl = e.slice(0, 100, 164); assert.equal(sl.length, 64); assert.ok(Math.abs(sl[0] - b.getChannelData(0)[100]) <= 1 / 32768);
  const dst = new Float32Array(10); e.copyFromChannel(dst, 0, 50); assert.ok(Math.abs(dst[3] - b.getChannelData(0)[53]) <= 1 / 32768);
  const x = i16(Float32Array.from([1, -1, 0.5, 2, -2, 0])); assert.deepEqual([...x], [32767, -32768, 16384, 32767, -32768, 0]);
  assert.equal(f32(Int16Array.from([-32768, 16384]))[1], 0.5);
});

test('peaks summarise min / max / rms per bin, the same whether float or 16-bit', () => {
  const b = ab(PEAK_BIN * 10 + 5, 1, 48000, (i) => (i < PEAK_BIN ? 0.5 : i < 2 * PEAK_BIN ? -0.25 : 0));
  const s = new AudioStore({ floatBudget: 1e9 }); s.set('a', b); const p = s.get('a').peaks();
  assert.equal(p.bin, PEAK_BIN); assert.equal(p.min.length, 11);
  assert.equal(p.max[0], 64); assert.equal(p.min[0], 64); assert.equal(p.rms[0], 128);
  assert.equal(p.min[1], -32); assert.equal(p.max[1], -32); assert.equal(p.max[5], 0); assert.equal(p.rms[5], 0);
  const s2 = new AudioStore({ floatBudget: 0 }); s2.set('a', ab(PEAK_BIN * 10 + 5, 1, 48000, (i) => (i < PEAK_BIN ? 0.5 : i < 2 * PEAK_BIN ? -0.25 : 0))); const q = s2.get('a').peaks();
  assert.deepEqual([...q.max], [...p.max]); assert.deepEqual([...q.min], [...p.min]); assert.ok(Math.abs(q.rms[0] - p.rms[0]) <= 1);
  assert.strictEqual(s.get('a').peaks(), p, 'computed once');
});

test('delete / clear / iteration behave like a Map', () => {
  const s = new AudioStore({ floatBudget: 1e9 }); s.set('a', ab(10)); s.set('b', ab(20));
  let n = 0; for (const [k, v] of s) { n++; assert.ok(v instanceof Entry); assert.ok(['a', 'b'].includes(k)); }
  assert.equal(n, 2); assert.equal([...s.values()].length, 2);
  assert.equal(s.delete('a'), true); assert.equal(s.delete('zzz'), false); assert.equal(s.size, 1);
  s.clear(); assert.equal(s.size, 0);
  assert.equal(s.get('b'), undefined);
});
