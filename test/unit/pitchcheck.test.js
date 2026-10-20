'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../src/renderer/pitchcheck.js');

// sung-ish line: 5 harmonics, 5 Hz / 5 cent vibrato, 30 ms scoop up into each note, soft attack/release, short breaths
function sing(notes, sr = 48000) {
  const total = Math.ceil(Math.max(...notes.map((n) => n.t + n.d)) * sr) + sr / 4; const x = new Float32Array(total);
  for (const n of notes) {
    const a = Math.round(n.t * sr), len = Math.round(n.d * sr); let ph = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / sr; const scoop = tt < 0.03 ? -60 * (1 - tt / 0.03) : 0; const vib = 5 * Math.sin(2 * Math.PI * 5 * tt);
      const f = 440 * 2 ** ((n.m + (n.c + scoop + vib) / 100 - 69) / 12); ph += 2 * Math.PI * f / sr;
      const env = Math.min(1, tt / 0.02, (n.d - tt) / 0.02);
      let s = 0; for (let h = 1; h <= 5; h++) s += Math.sin(h * ph) / h; x[a + i] = 0.25 * env * s;
    }
  }
  return x;
}
// G major scale up, 0.4 s each with 0.05 s breaths; #2 and #5 sung 35 cents flat, #6 sung a semitone wrong (F# instead of E)
const SCALE = [67, 69, 71, 72, 74, 76, 78, 79];
const plan = SCALE.map((m, i) => ({ t: 0.2 + i * 0.45, d: 0.4, m: i === 5 ? 77 : m, c: i === 1 || i === 4 ? -35 : 0 }));
const melody = SCALE.map((m, i) => ({ t: 0.2 + i * 0.45, d: 0.4, n: m }));

test('notes(): boundaries within 30 ms and pitch within 5 cents', () => {
  const sr = 48000; const pts = P.track(sing(plan, sr), sr); const ns = P.notes(pts);
  assert.equal(ns.length, plan.length, JSON.stringify(ns.map((n) => [n.t0.toFixed(3), n.midi.toFixed(2)])));
  ns.forEach((n, i) => {
    const p = plan[i]; assert.ok(Math.abs(n.t0 - p.t) < 0.03, `start ${i}: ${n.t0} vs ${p.t}`); assert.ok(Math.abs(n.t1 - (p.t + p.d)) < 0.03, `end ${i}: ${n.t1}`);
    assert.ok(Math.abs((n.midi - (p.m + p.c / 100)) * 100) < 5, `pitch ${i}: ${n.midi}`);
    assert.ok(n.vibrato > 1 && n.vibrato < 10, `vibrato ${n.vibrato}`);
  });
});

test('check(): flags exactly the planted flat notes and the wrong note (melody), key-only targets scale tones', () => {
  const sr = 48000; const ns = P.notes(P.track(sing(plan, sr), sr));
  const r = P.check(ns, { melody, key: 'G' });
  assert.deepEqual(r.results.map((x) => x.flag), ['ok', 'flat', 'ok', 'ok', 'flat', 'wrong-note', 'ok', 'ok']);
  assert.equal(r.summary.flat, 2); assert.equal(r.summary.wrong, 1); assert.equal(r.summary.worst[0].flag, 'wrong-note');
  assert.ok(Math.abs(r.results[1].off + 35) <= 5);
  const k = P.check(ns, { key: 'G' });   // F (77) isn't in G major: nearest scale tones are E / F#, a semitone away
  assert.deepEqual(k.results.map((x) => x.target), [67, 69, 71, 72, 74, 76, 78, 79].map((m, i) => (i === 5 ? k.results[5].target : m)));
  assert.equal(k.results[5].flag, 'wrong-note'); assert.equal(k.results[1].flag, 'flat');
  const plainR = P.check(ns, {}); assert.equal(plainR.results[5].flag, 'ok');   // no key, no melody: F is a fine F
  const rep = P.sectionReport(r.results, [{ name: 'Verse', start: 0, end: 2 }, { name: 'Chorus', start: 2, end: 4 }], (t) => `${t.toFixed(2)} s`);
  assert.ok(rep.Verse && rep.Chorus); assert.match(rep.Chorus.worst, /^F5 \+(9[5-9]|10[0-5])c at /);
});

test('silence and noise give no notes', () => {
  const sr = 48000; assert.equal(P.notes(P.track(new Float32Array(sr * 2), sr)).length, 0);
  const nz = new Float32Array(sr * 2); for (let i = 0; i < nz.length; i++) nz[i] = (Math.random() - 0.5) * 0.2;
  assert.ok(P.notes(P.track(nz, sr)).length <= 1);
});

test('60 s of 48 kHz in under 3 s', () => {
  const sr = 48000; const long = []; for (let i = 0; i < 130; i++) long.push({ t: i * 0.46, d: 0.4, m: SCALE[i % 8], c: 0 });
  const x = sing(long, sr).subarray(0, 60 * sr); const t0 = Date.now(); const ns = P.notes(P.track(x, sr)); const ms = Date.now() - t0;
  assert.ok(ms < 3000, `${ms} ms`); assert.ok(ns.length > 120, `${ns.length}`);
});
