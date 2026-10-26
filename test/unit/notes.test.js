'use strict';
// The note tracker + the musician's clean-up. The tracker test runs the real model (models/nmp.onnx on ONNX Runtime's
// WebAssembly build, exactly what the app's worker loads) on synthesized plucks; the clean-up tests use hand-built
// posteriors so each rule is checked on its own.
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const N = require('../../src/renderer/notes.js'); const NMP = require('../../src/renderer/nmp.js'); const TB = require('../../src/renderer/tab.js');
const R = path.join(__dirname, '../../src/renderer/');
const NP = 88, FPS = N.FPS;

// ---------- synthetic audio ----------
const SR = 44100; const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function pluck(buf, at, dur, midi, gain = 0.3) {
  const f0 = mtof(midi); const a0 = Math.floor(at * SR), n = Math.floor(dur * SR);
  for (let h = 1; h <= 10; h++) { const f = f0 * h * (1 + 0.0003 * h * h); if (f > SR / 2.2) break; const amp = gain / Math.pow(h, 1.1); const dec = 1.2 + 0.6 * h; const ph = rnd() * 6.28;
    for (let i = 0; i < n && a0 + i < buf.length; i++) { const t = i / SR; buf[a0 + i] += amp * Math.min(1, t / 0.003) * Math.exp(-dec * t) * Math.sin(2 * Math.PI * f * t + ph); } }
}
let ortP = null;
async function tracker() {
  if (!ortP) ortP = (async () => { const ort = await import(path.join(R, 'vendor/ort.min.mjs')); ort.env.wasm.wasmPaths = path.join(R, 'vendor/'); ort.env.wasm.numThreads = 1; const s = await ort.InferenceSession.create(fs.readFileSync(path.join(R, 'models/nmp.onnx')), { executionProviders: ['wasm'] }); return { ort, s }; })();
  return ortP;
}
const beatsAt = (bpm, off, len) => { const out = []; const B = 60 / bpm; for (let k = 0; off + k * B < len; k++) out.push({ t: off + k * B, beat: k % 4 }); return out; };
function f1(truth, got, tol = 0.05) { const used = new Set(); let tp = 0; for (const g of got) { const i = truth.findIndex((x, k) => !used.has(k) && x.n === g.n && Math.abs(x.t - g.t) <= tol); if (i >= 0) { used.add(i); tp++; } } const p = tp / (got.length || 1), r = tp / (truth.length || 1); return p + r ? (2 * p * r) / (p + r) : 0; }

test('the tracker hears a 16th-note riff note for note, snapped to the grid', async () => {
  const { ort, s } = await tracker();
  const bpm = 140, S16 = 60 / bpm / 4; const riff = [40, 43, 45, 47, 45, 43, 40, 50, 52, 50, 47, 45, 43, 45, 47, 50]; const truth = [];
  const buf = new Float32Array(SR * 5);
  for (let bar = 0; bar < 2; bar++) riff.forEach((m, k) => { const t = 0.4 + (bar * 16 + k) * S16; pluck(buf, t, S16 * 0.95, m); truth.push({ t, n: m }); });
  const post = await NMP.run(ort, s, buf, SR);
  assert.ok(post.T > 4 * FPS && post.note.length === post.T * NP, 'posteriors cover the take');
  const r = N.transcribe(post, { beats: beatsAt(bpm, 0.4, 5), key: 'Em' });
  const got = r.notes.map((x) => ({ t: x.t, n: x.n }));
  assert.ok(f1(truth, got) >= 0.9, `riff F1 ${f1(truth, got).toFixed(2)}: ${JSON.stringify(got.slice(0, 12))}`);
  // on the grid: every note sits on a 16th
  for (const x of r.notes) { const k = (x.t - 0.4) / S16; assert.ok(Math.abs(k - Math.round(k)) < 0.02, `note at ${x.t} is on the grid`); }
  // single notes, one per event, on the low strings in one hand position
  assert.ok(r.events.every((e) => e.mono), 'a riff is single notes');
  assert.ok(r.events.every((e) => e.frets.filter((f) => f >= 0).every((f) => f <= 5)), 'played down at the nut, not all over the neck');
  // and far better than the spectrum reader it replaces
  const old = TB.transcribe(buf, SR, { instrument: 'guitar' }); const oldN = []; for (const e of old.events) for (const m of e.notes) oldN.push({ t: e.t, n: m });
  assert.ok(f1(truth, got) > f1(truth, oldN) + 0.2, `new ${f1(truth, got).toFixed(2)} vs old ${f1(truth, oldN).toFixed(2)}`);
});

test('strummed chords come back as chords with the right names', async () => {
  const { ort, s } = await tracker();
  const CH = { G: [43, 47, 50, 55, 59, 67], C: [48, 52, 55, 60, 64], D: [50, 57, 62, 66], Em: [40, 47, 52, 55, 59, 64] };
  const bpm = 120, B = 0.5; const buf = new Float32Array(SR * 9);
  ['G', 'C', 'D', 'Em'].forEach((c, bar) => { for (let k = 0; k < 4; k++) CH[c].forEach((m, i) => pluck(buf, 0.5 + (bar * 4 + k) * B + i * 0.01, B * 0.95, m, 0.18)); });
  const post = await NMP.run(ort, s, buf, SR);
  const r = N.transcribe(post, { beats: beatsAt(bpm, 0.5, 9), key: 'G' });
  ['G', 'C', 'D', 'Em'].forEach((c, bar) => { const names = r.events.filter((e) => e.t >= 0.5 + bar * 2 - 0.05 && e.t < 0.5 + bar * 2 + 1.95).map((e) => e.name); assert.ok(names.filter((x) => x === c).length >= 3, `bar ${bar}: ${JSON.stringify(names)}`); });
  const CD = require('../../src/renderer/chordsdetect.js'); const beats = beatsAt(bpm, 0.5, 9);
  const lane = CD.fromNotes(r.notes, { beats: beats.map((b) => b.t), barStarts: beats.filter((b) => b.beat === 0).map((b) => b.t), key: 'G' });
  assert.deepEqual(lane.map((x) => x.chord), ['G', 'C', 'D', 'Em'], JSON.stringify(lane));
});

test('resampling keeps a tone where it was and keeps the top end from folding back', () => {
  const sr = 48000; const x = new Float32Array(sr); for (let i = 0; i < sr; i++) x[i] = Math.sin(2 * Math.PI * 440 * i / sr) + 0.5 * Math.sin(2 * Math.PI * 15000 * i / sr);
  const y = NMP.resample(x, sr, 22050); assert.equal(y.length, 22050);
  // correlate against 440 Hz and against where 15 kHz would alias (22050 - 15000 = 7050 Hz)
  const pw = (f) => { let a = 0, b = 0; for (let i = 2000; i < 20000; i++) { a += y[i] * Math.cos(2 * Math.PI * f * i / 22050); b += y[i] * Math.sin(2 * Math.PI * f * i / 22050); } return Math.hypot(a, b) / 18000; };
  assert.ok(pw(440) > 0.4, `440 Hz kept (${pw(440).toFixed(2)})`); assert.ok(pw(7050) < 0.02, `no alias (${pw(7050).toFixed(3)})`);
});

// ---------- hand-built posteriors: one rule at a time ----------
function postWith(notes, T) {
  const note = new Float32Array(T * NP), onset = new Float32Array(T * NP);
  for (const x of notes) { const p = x.m - 21; const f0 = N.timeToFrame(x.t), f1 = N.timeToFrame(x.t + x.d); for (let t = f0; t < f1 && t < T; t++) note[t * NP + p] = Math.max(note[t * NP + p], x.a); if (f0 < T) onset[f0 * NP + p] = Math.max(onset[f0 * NP + p], x.on == null ? 0.8 : x.on); }
  return { T, note, onset };
}
test('an overtone the tracker also reported is dropped in a single-note line, kept inside power chords', () => {
  const S = 0.15; const line = []; for (let k = 0; k < 12; k++) line.push({ t: 0.2 + k * S, d: S * 0.9, m: [40, 43, 45, 47][k % 4], a: 0.7 });
  const ghost = { t: 0.2 + 4 * S, d: S * 0.9, m: 40 + 12, a: 0.45, on: 0.6 };   // the low E's octave, quieter, struck with it
  let r = N.transcribe(postWith([...line, ghost], 300), {}); assert.ok(!r.notes.some((x) => x.n === 52), 'ghost octave in a riff is gone');
  const chords = []; for (let k = 0; k < 12; k++) { const root = [40, 43, 45, 48][k % 4]; for (const iv of [0, 7, 12]) chords.push({ t: 0.2 + k * S, d: S * 0.9, m: root + iv, a: iv === 12 ? 0.45 : 0.7 }); }
  r = N.transcribe(postWith(chords, 300), {}); assert.equal(r.notes.filter((x) => x.n === 52 && Math.round((x.t - 0.2) / S) % 4 === 0).length, 3, 'octaves of power chords stay');
  assert.ok(r.events.filter((e) => e.notes.length === 3).every((e) => /5$/.test(e.name)), 'power chords are named X5');
});
test('a weak note outside the key moves to the in-key neighbour the audio also shows', () => {
  const notes = []; for (let k = 0; k < 8; k++) notes.push({ t: 0.2 + k * 0.25, d: 0.22, m: [45, 48, 52, 55][k % 4], a: 0.7 });   // A minor stuff
  const p = postWith(notes, 260); const t0 = N.timeToFrame(2.3), t1 = N.timeToFrame(2.5);
  for (let t = t0; t < t1; t++) { p.note[t * NP + (49 - 21)] = 0.42; p.note[t * NP + (48 - 21)] = 0.38; } p.onset[t0 * NP + (49 - 21)] = 0.7;   // C#3 heard faintly, C3 nearly as strong
  const r = N.transcribe(p, { key: 'Am' }); const at = r.notes.filter((x) => Math.abs(x.t - 2.3) < 0.03);
  assert.ok(at.some((x) => x.n === 48) && !at.some((x) => x.n === 49), JSON.stringify(at));
});
test('repeated bars vote: a note one pass barely shows is filled in from the others', () => {
  const bpm = 120, S16 = 0.125; const pat = [[0, 45], [2, 48], [4, 52], [6, 48], [8, 45], [10, 50], [12, 52], [14, 50]]; const notes = [];
  for (let bar = 0; bar < 4; bar++) for (const [k, m] of pat) { if (bar === 2 && k === 10) continue; notes.push({ t: 0.5 + (bar * 16 + k) * S16, d: 0.2, m, a: 0.7 }); }
  const p = postWith(notes, 800); const t = 0.5 + (2 * 16 + 10) * S16; const f0 = N.timeToFrame(t);
  for (let f = f0; f < f0 + 10; f++) p.note[f * NP + (50 - 21)] = 0.2;   // the missed D3: there, but under the threshold
  const r = N.transcribe(p, { beats: beatsAt(bpm, 0.5, 9), key: 'Am' });
  const got = r.notes.find((x) => x.n === 50 && Math.abs(x.t - t) < 0.02); assert.ok(got, 'filled in'); assert.ok(r.events.some((e) => e.inferred), 'marked as inferred');
  // without any trace in the audio it is not invented
  const q = postWith(notes, 800); const r2 = N.transcribe(q, { beats: beatsAt(bpm, 0.5, 9), key: 'Am' }); assert.ok(!r2.notes.some((x) => x.n === 50 && Math.abs(x.t - t) < 0.02), 'not invented from nothing');
});
test('fretting stays in one hand position and puts the same note in the same place', () => {
  const evs = []; const line = [48, 60, 48, 51, 48, 60, 50, 58, 48, 60, 48, 51, 48, 60, 50, 58]; line.forEach((m, k) => evs.push({ t: k * 0.15, d: 0.14, notes: [m] }));
  const fr = N.fret(evs, N.GUITAR); const pos = (m) => new Set(fr.filter((x, i) => line[i] === m).map((x) => x.fr.join(',')));
  assert.equal(pos(60).size, 1, 'C4 always on the same string'); assert.equal(pos(48).size, 1, 'C3 always on the same string');
  const frets = fr.flatMap((x) => x.fr.filter((f) => f > 0)); assert.ok(Math.max(...frets) - Math.min(...frets) <= 4, `one position: ${JSON.stringify(frets)}`);
  assert.deepEqual(N.fingerings([40, 47, 52], N.GUITAR)[0].fr, [0, 2, 2, -1, -1, -1], 'E5 is the open shape');
});
test('the grid picks triplets where a bar is played in threes', () => {
  const bpm = 100, B = 0.6; const notes = []; for (let k = 0; k < 12; k++) notes.push({ t: 0.6 + (k * B) / 3, d: 0.18, m: [45, 48, 52][k % 3], a: 0.7 });
  const r = N.transcribe(postWith(notes, 400), { beats: beatsAt(bpm, 0.6, 4) });
  for (const x of r.notes) { const k = ((x.t - 0.6) / B) * 3; assert.ok(Math.abs(k - Math.round(k)) < 0.03, `${x.t} on a triplet`); }
});
test('a bass plays one note at a time and its overtones are not notes', () => {
  const notes = []; [28, 28, 35, 28, 31, 31, 33, 35].forEach((m, k) => { notes.push({ t: 0.3 + k * 0.25, d: 0.22, m, a: 0.65 }); notes.push({ t: 0.3 + k * 0.25, d: 0.2, m: m + 12, a: 0.45, on: 0.5 }); });
  const r = N.transcribe(postWith(notes, 260), { instrument: 'bass' });
  assert.deepEqual(r.notes.map((x) => x.n), [28, 28, 35, 28, 31, 31, 33, 35]); assert.ok(r.events.every((e) => e.frets.length === 4));
});

// ---------- singing ----------
function sing(buf, at, dur, midi, { detune = 0, sr = SR } = {}) {
  const n = Math.floor(dur * sr), a0 = Math.floor(at * sr); let ph = 0;
  for (let i = 0; i < n && a0 + i < buf.length; i++) {
    const t = i / sr; const cents = detune + 35 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, Math.max(0, (t - 0.15) / 0.2)) - 110 * Math.exp(-t / 0.05);
    const f = mtof(midi + cents / 100); ph += (2 * Math.PI * f) / sr; let v = 0;
    for (let h = 1; h <= 12; h++) { const fh = f * h; const a = Math.exp(-(((fh - 700) / 160) ** 2)) + 0.6 * Math.exp(-(((fh - 1200) / 220) ** 2)) + 0.25 * Math.exp(-(((fh - 2500) / 300) ** 2)) + 0.02; v += (a * Math.sin(h * ph)) / Math.pow(h, 0.3); }
    buf[a0 + i] += 0.2 * v * Math.min(1, t / 0.03) * Math.min(1, (dur - t) / 0.05);
  }
}
test('a sung line comes back as the notes meant: vibrato and scoops ignored, on the beat, in the key', () => {
  const PC = require('../../src/renderer/pitchcheck.js');
  const mel = [[0, 1, 55], [1, 1, 57], [2, 2, 59], [4, 1, 60], [5, 1, 59], [6, 2, 57], [8, 0.5, 55], [8.5, 0.5, 57], [9, 1, 59], [10, 2, 62]]; const B = 0.5;
  const buf = new Float32Array(SR * 7); mel.forEach(([b, d, m], k) => sing(buf, 0.5 + b * B + (k % 2 ? 0.03 : -0.02), d * B * 0.92, m, { detune: k % 3 === 0 ? 22 : -18 }));
  const r = N.fromSung(PC.track(buf, SR), { beats: beatsAt(120, 0.5, 7), key: 'G' });
  assert.deepEqual(r.notes.map((x) => [x.t, x.n]), mel.map(([b, , m]) => [0.5 + b * B, m]), JSON.stringify(r.notes));
});

test('tuning offset: where the contour energy sits between the 1/3-semitone bins', () => {
  const T = 50, C = 264; const mk = (phase) => { const contour = new Float32Array(T * C); for (let t = 0; t < T; t++) for (const m of [43, 50, 55]) contour[t * C + (m - 21) * 3 + 1 + phase] = 0.9; return { T, contour }; };
  assert.strictEqual(N.tuningOffset(mk(0)), 0);
  assert.strictEqual(N.tuningOffset(mk(1)), 33);
  assert.strictEqual(N.tuningOffset(mk(-1)), -33);
});

test('power chord root: a fourth on top gets the root under it only when the recording backs it', () => {
  const T = 100; const post = { T, note: new Float32Array(T * NP), onset: new Float32Array(T * NP) };
  const f0 = N.timeToFrame(0.2); for (let t = f0; t < f0 + 20; t++) post.note[t * NP + (48 - 21)] = 0.4; post.onset[f0 * NP + (48 - 21)] = 0.3;
  const evs = [{ t: 0.2, d: 0.2, notes: [55, 60], amps: { 55: 0.6, 60: 0.6 } }, { t: 0.6, d: 0.2, notes: [57, 62], amps: {} }];
  assert.strictEqual(N.powerRoots(evs, post, 40), 1);
  assert.deepStrictEqual(evs[0].notes, [48, 55, 60]);
  assert.deepStrictEqual(evs[1].notes, [57, 62]);   // no evidence for D3: left as the inverted fifth it may well be
});
