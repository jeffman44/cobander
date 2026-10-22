'use strict';
const test = require('node:test'); const assert = require('node:assert');
const E = require('../../src/renderer/tabedit.js'); const T = require('../../src/renderer/tab.js');
const G = T.GUITAR, B = T.BASS;
const beats = Array.from({ length: 8 }, (_, k) => ({ t: k * 0.5, beatLen: 0.5 }));   // 120 bpm, two bars of 4/4
const cols = E.columns(beats, 2);
test('columns and the nearest column', () => {
  assert.equal(cols.length, 16); assert.equal(cols[1], 0.25); assert.equal(E.colOf(cols, 0.26), 1); assert.equal(E.colOf(cols, 0.37), 1); assert.equal(E.colOf(cols, 0.38), 2); assert.equal(E.colOf(cols, 99), 15);
});
test('typing frets builds a chord, names it, clearing takes it apart', () => {
  let ev = [];
  ev = E.setFret(ev, cols, 4, 0, 3, G); assert.equal(ev.length, 1); assert.deepEqual(ev[0].notes, [43]); assert.ok(ev[0].mono); assert.equal(ev[0].t, 1);
  ev = E.setFret(ev, cols, 4, 1, 2, G); ev = E.setFret(ev, cols, 4, 2, 0, G); ev = E.setFret(ev, cols, 4, 3, 0, G); ev = E.setFret(ev, cols, 4, 4, 0, G); ev = E.setFret(ev, cols, 4, 5, 3, G);
  assert.equal(ev.length, 1, 'same column, same event'); assert.deepEqual(ev[0].frets, [3, 2, 0, 0, 0, 3]); assert.equal(ev[0].name, 'G'); assert.ok(!ev[0].mono);
  ev = E.setFret(ev, cols, 5, 5, 5, G); assert.equal(ev.length, 2); assert.deepEqual(ev[1].frets, [-1, -1, -1, -1, -1, 5]);
  assert.equal(E.setFret(ev, cols, 5, 5, 25, G), ev, 'past fret 24: nothing');
  ev = E.clear(ev, cols, 4, 5, G); assert.deepEqual(ev[0].frets, [3, 2, 0, 0, 0, -1]); assert.equal(ev[0].name, 'G');
  ev = E.clear(ev, cols, 5, 5, G); assert.equal(ev.length, 1, 'nothing left: the event goes');
  ev = E.clear(ev, cols, 4, -1, G); assert.equal(ev.length, 0, 'whole column');
});
test('a read-off-the-takes event (between columns) is edited where it is, not duplicated', () => {
  const ev0 = [{ t: 1.07, d: 0.4, notes: [45], frets: [-1, 0, -1, -1, -1, -1], mono: true }];
  const ev = E.setFret(ev0, cols, 4, 0, 5, G); assert.equal(ev.length, 1); assert.equal(ev[0].t, 1.07, 'keeps its own time'); assert.deepEqual(ev[0].notes, [45, 45]);
  assert.deepEqual(ev0[0].frets, [-1, 0, -1, -1, -1, -1], 'input untouched');
});
test('naming a column: a typed name sticks on an event, an empty column gets a playable shape', () => {
  let ev = E.setName([], cols, 0, 'C', G); assert.deepEqual(ev[0].frets, [-1, 3, 2, 0, 1, 0]); assert.equal(ev[0].name, 'C');
  ev = E.setName(ev, cols, 2, 'F', G); assert.deepEqual(ev[1].frets, [1, 3, 3, 2, 1, 1], 'F: E-shape barre at 1');
  ev = E.setName(ev, cols, 4, 'Bbm', G); assert.deepEqual(ev[2].frets, [-1, 1, 3, 3, 2, 1], 'Bbm: A-shape at 1 (lower than E-shape at 6)');
  ev = E.setName(ev, cols, 6, 'F#5', G); assert.deepEqual(ev[3].frets, [2, 4, 4, -1, -1, -1]);
  assert.equal(E.setName(ev, cols, 8, 'H7', G), null, 'not a chord');
  ev = E.setName(ev, cols, 0, 'Cadd9?', G); assert.equal(ev[0].name, 'Cadd9?', 'on an event: the name is just a label');
  ev = E.setFret(ev, cols, 0, 5, 3, G); assert.equal(ev[0].name, 'Cadd9?', 'a typed name survives fret edits');
  ev = E.setName(ev, cols, 0, '', G); assert.equal(ev[0].name, 'C', 'cleared: named from the notes again');
  // half-step-down guitar: the same shapes, named from what sounds
  const down = G.map((x) => x - 1); const e2 = E.setName([], cols, 0, 'D#', down); assert.deepEqual(e2[0].frets, [0, 2, 2, 1, 0, 0], 'Eb tuning: the E shape sounds D#'); assert.deepEqual(e2[0].notes, [39, 46, 51, 55, 58, 63]);
  // bass: the root on the lowest string that has it
  assert.deepEqual(E.setName([], cols, 0, 'G', B)[0].frets, [3, -1, -1, -1]); assert.deepEqual(E.setName([], cols, 0, 'D', B)[0].frets, [-1, 5, -1, -1]);
});
test('shift moves an event onto an empty column only', () => {
  let ev = E.setFret([], cols, 3, 2, 2, G); ev = E.setFret(ev, cols, 5, 2, 4, G);
  ev = E.shift(ev, cols, 3, 1); assert.equal(ev[0].t, cols[4]);
  assert.equal(E.shift(ev, cols, 4, 1), ev, 'column 5 is taken');
  assert.equal(E.shift(ev, cols, 0, 1), ev, 'nothing there');
});
