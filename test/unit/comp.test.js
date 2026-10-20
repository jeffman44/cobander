'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/renderer/comp.js');
let n = 0; const newId = () => `id${++n}`;
const FULL = { t1: 20, t2: 20, t3: 20 };
const full = (c) => FULL[c.src || c.id];
const len = (c) => full(c) - c.trimStart - c.trimEnd;
const clip = (id, start, mute = false) => ({ id, start, trimStart: 0, trimEnd: 0, mute, fadeIn: 0, fadeOut: 0, name: id });
const heard = (clips, t) => clips.filter((c) => !c.mute && t >= c.start && t < c.start + len(c)).map((c) => c.src || c.id);

test('comp: only the kept take plays inside the range, everything else unchanged outside', () => {
  const clips = [clip('t1', 0), clip('t2', 0, true), clip('t3', 0, true)];
  const r = C.comp(clips, 't2', 4, 8, { len, full, newId });
  assert.deepEqual(heard(r.clips, 2), ['t1']);
  assert.deepEqual(heard(r.clips, 5), ['t2']);
  assert.deepEqual(heard(r.clips, 9), ['t1']);
  // audio offsets line up: the t2 middle piece reads its file from 4 s
  const mid = r.clips.find((c) => (c.src || c.id) === 't2' && !c.mute); assert.equal(mid.start, 4); assert.equal(mid.trimStart, 4); assert.equal(len(mid), 4);
  // comp again with t3 over part of it
  const r2 = C.comp(r.clips, mid.id, 6, 7, { len, full, newId }).clips;   // keep a piece = still fine
  assert.deepEqual(heard(r2, 6.5), ['t2']);
  const r3 = C.comp(r.clips, 't3', 6, 7, { len, full, newId }).clips;
  assert.deepEqual(heard(r3, 5), ['t2']); assert.deepEqual(heard(r3, 6.5), ['t3']); assert.deepEqual(heard(r3, 7.5), ['t2']); assert.deepEqual(heard(r3, 12), ['t1']);
});

test('linked mirrors are not touched', () => {
  const m = { ...clip('t1', 0), link: { section: 's2' } };
  const r = C.comp([m, clip('t2', 0)], 't2', 2, 4, { len, full, newId });
  assert.equal(r.clips[0], m);
});

test('punchTrim keeps only the window but the whole capture as handles', () => {
  const c = { id: 't1', start: 2, trimStart: 0, trimEnd: 0 };
  const p = C.punchTrim(c, 10, 4, 7);
  assert.equal(p.start, 4); assert.equal(p.trimStart, 2); assert.equal(p.trimEnd, 5); assert.equal(10 - p.trimStart - p.trimEnd, 3);
  assert.equal(C.punchTrim(c, 1.5, 4, 7), null);
});
