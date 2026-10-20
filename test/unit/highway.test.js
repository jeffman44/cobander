'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../src/renderer/highway.js');

test('chord shapes: open CAGED, barres, power chords, enharmonics, capo', () => {
  assert.deepEqual(H.shape('G').frets, [3, 2, 0, 0, 0, 3]);
  assert.deepEqual(H.shape('Em').frets, [0, 2, 2, 0, 0, 0]);
  const fsm = H.shape('F#m'); assert.deepEqual(fsm.frets, [2, 4, 4, 2, 2, 2]); assert.equal(fsm.barre, 2);
  const b = H.shape('B'); assert.deepEqual(b.frets, [-1, 2, 4, 4, 4, 2]); assert.equal(b.barre, 2);
  const b5 = H.shape('B5'); assert.deepEqual(b5.frets, [-1, 2, 4, 4, -1, -1]); assert.equal(b5.barre, null);
  assert.deepEqual(H.shape('A#m').frets, H.shape('Bbm').frets); assert.equal(H.shape('Bbm').name, 'Bbm');
  assert.deepEqual(H.shape('D/F#').frets, H.shape('D').frets);   // the bass note doesn't change the grip
  // capo 2: a sounding B is played as an A shape
  const bc = H.shape('B', { capo: 2 }); assert.deepEqual(bc.frets, [-1, 0, 2, 2, 2, 0]); assert.equal(bc.fingered, 'A'); assert.equal(bc.name, 'B');
  assert.deepEqual(H.shape('Dm7').frets, [-1, -1, 0, 2, 1, 1]); assert.deepEqual(H.shape('Asus4').frets, [-1, 0, 2, 2, 3, 0]);
  assert.equal(H.shape('nonsense'), null);
});

test('bassTab keeps the hand still and prefers low positions; notes below the range go up an octave', () => {
  // B1 G#1 E1 F#1 at 120 bpm
  const notes = [[35, 0], [32, 1], [28, 2], [30, 3]].map(([m, t]) => ({ midi: m, t, d: 0.9 }));
  const tb = H.bassTab(notes);
  assert.deepEqual(tb.map((n) => [n.string, n.fret]), [[0, 7], [0, 4], [0, 0], [0, 2]]);
  assert.ok(tb.every((n) => n.fret <= 12));
  const low = H.bassTab([{ midi: 20, t: 0, d: 1 }]); assert.equal(low[0].midi, 32); assert.equal(low[0].octave, 1);
  // a run high up stays on nearby strings rather than jumping to open strings and back
  const run = H.guitarTab([64, 66, 68, 69, 71].map((m, i) => ({ midi: m, t: i * 0.25, d: 0.2 })));
  const strings = new Set(run.map((n) => n.string)); assert.ok(strings.size <= 2, JSON.stringify(run));
});

test('events: chords carry shapes and last until the next chord; tabs are per string, time-ordered', () => {
  const chords = [{ time: 4, chord: 'E' }, { time: 0, chord: 'B' }, { time: 2, chord: 'G#m' }];
  const ev = H.events({ mode: 'chords', chords, capo: 0 });
  assert.deepEqual(ev.map((e) => [e.t, e.label, e.d]), [[0, 'B', 2], [2, 'G#m', 2], [4, 'E', 2]]);
  assert.ok(Array.isArray(ev[0].frets) && ev[0].frets.length === 6);
  const bev = H.events({ mode: 'bass', notes: [{ midi: 35, t: 1, d: 0.5 }, { midi: 28, t: 0, d: 0.5 }] });
  assert.deepEqual(bev.map((e) => [e.t, e.lane, e.label]), [[0, 0, '0'], [1, 1, '2']]);   // B after open E: 2nd fret on the A string, not a 7-fret jump
  assert.equal(H.events({ mode: 'chords', chords, from: 1, to: 3 }).length, 1);
});

test('notesFromPitchTrack segments a pitch track into notes', () => {
  const pts = []; for (let i = 0; i < 100; i++) pts.push({ t: i * 0.01, midi: i < 40 ? 47 + (i % 3) * 0.05 : i < 50 ? NaN : 52 });
  const ns = H.notesFromPitchTrack(pts);
  assert.equal(ns.length, 2); assert.equal(ns[0].midi, 47); assert.equal(ns[1].midi, 52); assert.ok(ns[0].d > 0.3);
});

function fakeCtx() { const calls = []; const rec = (k) => (...a) => { calls.push(k); }; const ctx = {}; for (const k of ['save', 'restore', 'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'fillText']) ctx[k] = rec(k); ctx.calls = calls; return ctx; }
test('draw: every mode renders on a bare context (no roundRect / measureText) without throwing', () => {
  const chords = [{ time: 0, chord: 'B' }, { time: 2, chord: 'G#m' }, { time: 4, chord: 'E' }];
  for (const [mode, lanes, opts] of [['chords', 1, { chords }], ['bass', 4, { notes: [{ midi: 35, t: 1, d: 0.5 }, { midi: 28, t: 2.5, d: 0.5 }] }], ['guitar', 6, { notes: [{ midi: 64, t: 0.5, d: 0.5 }] }], ['midi', 6, { notes: [{ n: 60, t: 1, d: 0.3 }] }]]) {
    const ctx = fakeCtx(); const ev = H.events({ mode, ...opts });
    H.draw(ctx, { w: 800, h: 600, now: 1, events: ev, lanes, labels: lanes === 4 ? ['E', 'A', 'D', 'G'] : null });
    assert.ok(ctx.calls.includes('fillText') && ctx.calls.includes('stroke'), mode);
  }
  const ctx = fakeCtx(); ctx.roundRect = (...a) => ctx.calls.push('roundRect'); ctx.measureText = (s) => ({ width: s.length * 9 });
  H.draw(ctx, { w: 400, h: 300, now: 0, events: H.events({ mode: 'chords', chords }), lanes: 1 }); assert.ok(ctx.calls.includes('roundRect'));
});

test('tabText lays frets on the right strings with bar lines', () => {
  const txt = H.tabText([{ midi: 35, t: 0, d: 0.5 }, { midi: 32, t: 0.5, d: 0.5 }, { midi: 28, t: 1, d: 0.5 }], { tuning: H.BASS, beatLen: 0.5, barLen: 2 });
  const lines = txt.split('\n'); assert.equal(lines.length, 4);
  assert.ok(lines[3].startsWith('E |7---4---0'), lines[3]);
  assert.ok(lines[0].startsWith('G |'));
});
