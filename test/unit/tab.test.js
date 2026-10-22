'use strict';
const test = require('node:test'); const assert = require('node:assert');
const T = require('../../src/renderer/tab.js');
const SR = 48000;
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };   // fixed phases: the same signal every run
// a plucked-string-ish note: harmonics that decay faster the higher they are, a touch of inharmonicity, soft attack
function pluck(buf, at, dur, midi, { gain = 0.3, harmonics = 9, detuneCents = 0 } = {}) {
  const f0 = midiToHz(midi) * Math.pow(2, detuneCents / 1200); const a0 = Math.floor(at * SR), n = Math.floor(dur * SR);
  for (let h = 1; h <= harmonics; h++) {
    const f = f0 * h * (1 + 0.0004 * h * h); if (f > SR / 2.2) break; const amp = gain / Math.pow(h, 1.15); const decay = 0.9 + 0.5 * h; const ph = rnd() * 6.28;
    for (let i = 0; i < n && a0 + i < buf.length; i++) { const t = i / SR; const env = Math.min(1, t / 0.004) * Math.exp(-decay * t); buf[a0 + i] += amp * env * Math.sin(2 * Math.PI * f * t + ph); }
  }
}
function strum(buf, at, dur, midis, opts) { midis.forEach((m, i) => pluck(buf, at + i * 0.012, dur, m, opts)); }
const score = (buf, events) => events;

test('single notes on a guitar come back as the right frets', () => {
  const buf = new Float32Array(SR * 4); const seq = [40, 45, 50, 55, 59, 64, 47, 52];   // open strings, then a couple of fretted notes
  seq.forEach((m, i) => pluck(buf, 0.3 + i * 0.45, 0.4, m));
  const r = T.transcribe(buf, SR, { instrument: 'guitar' });
  assert.equal(r.events.length, seq.length, JSON.stringify(r.events.map((e) => [e.t, e.notes])));
  r.events.forEach((e, i) => { assert.deepEqual(e.notes, [seq[i]], `note ${i}`); assert.ok(e.mono); assert.ok(Math.abs(e.t - (0.3 + i * 0.45)) < 0.03, `onset ${i} at ${e.t}`); });
  // open strings land on their own string at fret 0
  assert.deepEqual(r.events[0].frets, [0, -1, -1, -1, -1, -1]); assert.deepEqual(r.events[5].frets, [-1, -1, -1, -1, -1, 0]);
});

test('strummed chords: every note, the voicing and the name', () => {
  const buf = new Float32Array(SR * 5);
  const E = [40, 47, 52, 56, 59, 64], G = [43, 47, 50, 55, 59, 67], D = [50, 57, 62, 66], Am = [45, 52, 57, 60, 64];
  strum(buf, 0.3, 1.0, E); strum(buf, 1.4, 1.0, G); strum(buf, 2.5, 1.0, D); strum(buf, 3.6, 1.0, Am);
  const r = T.transcribe(buf, SR, { instrument: 'guitar' });
  assert.equal(r.events.length, 4, JSON.stringify(r.events.map((e) => [e.t, e.notes, e.name])));
  const [e, g, d, am] = r.events;
  const names = r.events.map((x) => x.name); assert.deepEqual(names, ['E', 'G', 'D', 'Am'], JSON.stringify(r.events.map((x) => [x.notes, x.name])));
  // at least 4 of the 6 strummed notes heard, and the voicing is the open shape
  assert.ok(e.notes.filter((n) => E.includes(n)).length >= 4, JSON.stringify(e.notes)); assert.ok(!e.notes.some((n) => !E.includes(n)), 'no ghost notes in E');
  assert.ok(g.notes.filter((n) => G.includes(n)).length >= 4, JSON.stringify(g.notes));
  assert.deepEqual(d.frets.slice(2), [0, 2, 3, 2], JSON.stringify(d.frets)); assert.ok(d.frets[0] === -1 && d.frets[1] === -1);
  assert.ok(am.notes.includes(45) && am.notes.includes(52) && am.notes.includes(60), JSON.stringify(am.notes));
  assert.deepEqual(e.frets, [0, 2, 2, 1, 0, 0], 'E shape filled in'); assert.deepEqual(g.frets, [3, 2, 0, 0, 0, 3]); assert.deepEqual(am.frets, [-1, 0, 2, 2, 1, 0]);
  assert.ok(!e.mono && !g.mono);
});

test('a bass line (low notes, 4 strings) and a flat-tuned guitar', () => {
  const buf = new Float32Array(SR * 3); const seq = [28, 31, 33, 35, 40, 43];
  seq.forEach((m, i) => pluck(buf, 0.2 + i * 0.4, 0.35, m, { harmonics: 7 }));
  const r = T.transcribe(buf, SR, { instrument: 'bass' });
  assert.equal(r.events.length, seq.length, JSON.stringify(r.events.map((e) => e.notes)));
  r.events.forEach((e, i) => assert.deepEqual(e.notes, [seq[i]], `bass note ${i}`));
  assert.deepEqual(r.events[0].frets, [0, -1, -1, -1]); assert.deepEqual(r.events[2].frets, [-1, 0, -1, -1]);
  // 30 cents flat all round: still the same notes, and the drift is reported
  const b2 = new Float32Array(SR * 3); [40, 45, 50, 55].forEach((m, i) => pluck(b2, 0.2 + i * 0.5, 0.45, m, { detuneCents: -30 }));
  const r2 = T.transcribe(b2, SR, { instrument: 'guitar' });
  assert.deepEqual(r2.events.map((e) => e.notes[0]), [40, 45, 50, 55]); assert.ok(r2.tuningCents <= -20 && r2.tuningCents >= -40, `tuning ${r2.tuningCents}`);
});

test('voicing picks one string per note with the smallest span; chord naming reads inversions', () => {
  assert.deepEqual(T.voicing([40, 47, 52, 56, 59, 64], T.GUITAR), [0, 2, 2, 1, 0, 0]);
  assert.deepEqual(T.voicing([45, 52, 57, 61, 64], T.GUITAR), [-1, 0, 2, 2, 2, 0]);
  assert.deepEqual(T.voicing([43, 47, 50, 55, 59, 67], T.GUITAR), [3, 2, 0, 0, 0, 3]);
  assert.equal(T.voicing([40, 41], T.GUITAR), null);   // E and F below the A string: nowhere to put both
  assert.deepEqual(T.voicing([40, 46], T.GUITAR), [0, 1, -1, -1, -1, -1]);
  assert.equal(T.chordName([40, 47, 52, 56, 59, 64]).name, 'E'); assert.equal(T.chordName([45, 52, 57, 60, 64]).name, 'Am');
  assert.equal(T.chordName([50, 57, 62, 66]).name, 'D'); assert.equal(T.chordName([43, 47, 50, 55, 59, 65]).name, 'G7');
  assert.equal(T.chordName([52, 57, 60]).name, 'Am/E'); assert.equal(T.chordName([40, 47]).name, 'E5');
});

test('text tab stacks chords, draws bars, names them', () => {
  const ev = [{ t: 0, d: 0.5, notes: [40], frets: [0, -1, -1, -1, -1, -1], mono: true }, { t: 0.5, d: 0.5, notes: [45, 52, 57, 61, 64], frets: [-1, 0, 2, 2, 2, 0], name: 'A' }, { t: 2, d: 0.5, notes: [52], frets: [-1, -1, -1, -1, -1, 12], mono: true }];
  const txt = T.tabText(ev, { tuning: T.GUITAR, beatLen: 0.5, charsPerBeat: 4, beatsPerBar: 4, lineBeats: 16 });
  const rows = txt.split('\n'); assert.equal(rows.length, 7, txt);
  assert.ok(rows[0].includes('A'), rows[0]); assert.ok(rows[1].startsWith('e |'), rows[1]); assert.ok(rows[6].startsWith('E |'));
  assert.ok(/^E \|0---0/.test(rows[6]) === false && rows[6].startsWith('E |0---'), rows[6]); assert.ok(rows[5].includes('0'), rows[5]);
  assert.ok(rows[1].includes('12'), rows[1]); assert.ok(rows[1].includes('|'), 'bar lines');
  const lanes = T.laneEvents(ev); assert.equal(lanes.length, 1 + 5 + 1); assert.equal(lanes[1].sub, 'A');
});
