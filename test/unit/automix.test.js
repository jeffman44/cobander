'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AM = require('../../src/renderer/automix.js');

// the engine's normalizer, with just enough stubs to load it in node (validates every patch the way the app will)
globalThis.window = globalThis.window || globalThis;
window.BPSynth = window.BPSynth || { SYNTHS: { voice: {}, bassgtr: {}, pad: {}, distgtr: {} }, KITS: { rock: {} } };
window.BPPresets = window.BPPresets || { DRUM_PATTERNS: { 'Rock 4/4': {} } };
require('../../src/renderer/engine.js');
const E = window.BPEngine;

const clip = (id, mute = false) => ({ id, start: 0, duration: 60, trimStart: 0, trimEnd: 0, mute });
const ampOn = { on: true, model: 'crunch', gain: 6, bass: 1, mid: 2, treble: 3, presence: 1, cab: '412', level: -2 };
const tracks = [
  { id: 'v1', name: 'Lead vox', type: 'vocals', instrument: 'audio', clips: [clip('a00000000001')] },
  { id: 'v2', name: 'Harmony', type: 'vocals', instrument: 'audio', clips: [clip('a00000000002')] },
  { id: 'g1', name: 'Gtr L', type: 'guitar', instrument: 'audio', clips: [clip('a00000000003')] },
  { id: 'g2', name: 'Gtr R', type: 'guitar', instrument: 'audio', clips: [clip('a00000000004')], fx: { amp: ampOn } },
  { id: 'b1', name: 'Bass', type: 'bass', instrument: 'audio', clips: [clip('a00000000005')] },
  { id: 'd1', name: 'Drums', type: 'drums', instrument: 'drumkit', clips: [] },
  { id: 'k1', name: 'Keys', type: 'keys', instrument: 'synth:pad', clips: [clip('a00000000006')] },
  { id: 'm1', name: 'Old gtr', type: 'guitar', instrument: 'audio', mute: true, clips: [clip('a00000000007')] },
  { id: 'e1', name: 'Empty', type: 'other', instrument: 'audio', clips: [clip('a00000000008', true)] },
];
const st = (lvl, on = (i) => true) => Array.from({ length: 60 }, (_, i) => (on(i) ? lvl : -120));
const bands = (o = {}) => ({ sub: -40, low: -20, lowMid: -18, mid: -20, high: -30, air: -45, ...o });
const analysis = {
  v1: { lufs: -26, shortTerm: st(-25, (i) => i >= 10), peakDb: -6, bands: bands({ lowMid: -14, mid: -19, high: -33 }), monoish: true },
  v2: { lufs: -28, shortTerm: st(-27, (i) => i >= 20), peakDb: -8, bands: bands(), monoish: true },
  g1: { lufs: -24, shortTerm: st(-24), peakDb: -4, bands: bands({ lowMid: -12, mid: -18 }), monoish: false },
  g2: { lufs: -18, shortTerm: st(-18), peakDb: -2, bands: bands(), monoish: false },
  b1: { lufs: -30, shortTerm: st(-30), peakDb: -10, bands: bands({ low: -10 }), monoish: true },
  d1: { lufs: -16, shortTerm: st(-16), peakDb: -1, bands: bands({ low: -12, lowMid: -11 }), monoish: false },
  k1: { lufs: -27, shortTerm: st(-27), peakDb: -9, bands: bands(), monoish: false },
  m1: { lufs: -20, shortTerm: st(-20), peakDb: -3, bands: bands(), monoish: false },
};

test('roles from type, name, instrument', () => {
  assert.deepEqual(tracks.map(AM.role), ['leadVox', 'backVox', 'gtr', 'gtr', 'bass', 'drums', 'keys', 'gtr', 'other']);
  assert.equal(AM.role({ name: 'BGV', instrument: 'audio' }), 'backVox');
  assert.equal(AM.role({ name: 'Vox', instrument: 'audio' }), 'leadVox');
  assert.equal(AM.role({ name: 'Kick', instrument: 'audio' }), 'drums');
  assert.equal(AM.role({ name: 'Rhythm', instrument: 'audio' }), 'gtr');
  assert.equal(AM.role({ name: 'Lead', type: 'guitar', instrument: 'audio' }), 'gtr');
  assert.equal(AM.role({ name: 'Bass line', instrument: 'synth:bassgtr' }), 'bass');
  assert.equal(AM.role({ name: 'Melody', instrument: 'synth:voice' }), 'leadVox');
  assert.ok(AM.isGuide({ instrument: 'synth:voice' }));
  assert.equal(AM.role({ name: 'Pad', instrument: 'synth:pad' }), 'synth');
});

test('planMix: bed to targets, vocals fitted on the bed, pans spread, muted / silent left alone', () => {
  const p = AM.planMix(tracks, analysis);
  assert.ok(!p.tracks.m1 && !p.tracks.e1, 'muted + silent untouched');
  assert.ok(p.notes.some((n) => /Old gtr: left alone \(muted\)/.test(n)));
  // quiet bass gets boosted to −23.5, loud drums pulled to −19.5
  assert.equal(p.tracks.b1.gainDb, 6.5); assert.equal(p.tracks.d1.gainDb, -3.5);
  assert.ok(p.tracks.k1.gainDb > 0);
  // two guitars share −20: each at −23
  assert.equal(r(analysis.g1.lufs + p.tracks.g1.gainDb), -23); assert.equal(r(analysis.g2.lufs + p.tracks.g2.gainDb), -23);
  assert.ok(p.tracks.g1.pan < -0.5 && p.tracks.g2.pan > 0.5, 'guitars spread');
  assert.equal(p.tracks.v1.pan, 0); assert.equal(p.tracks.b1.pan, 0); assert.equal(p.tracks.d1.pan, 0);
  // lead sits about level with the bed (−0.5), harmony 5 dB under the lead
  const lead = analysis.v1.lufs + p.tracks.v1.gainDb, harm = analysis.v2.lufs + p.tracks.v2.gainDb;
  assert.ok(Math.abs(harm - (lead - 5)) < 0.11, `${lead} ${harm}`);
  assert.ok(p.tracks.v1.gainDb > 0, 'quiet lead brought up');
  assert.notEqual(p.tracks.v2.pan, 0);
  // roles drive HPF / comp / sends; mud cut where low-mids pile up; presence lift on a dull lead
  assert.equal(p.tracks.v1.fx.hpf.hz, 95); assert.equal(p.tracks.b1.fx.hpf.hz, 35); assert.equal(p.tracks.g1.fx.hpf.hz, 80);
  assert.equal(p.tracks.v1.fx.comp.ratio, 3.5); assert.equal(p.tracks.b1.fx.comp.ratio, 4); assert.equal(p.tracks.d1.fx.comp.ratio, 3);
  assert.ok(!p.tracks.g1.fx.comp);
  assert.equal(p.tracks.v1.fx.reverbSend, 0.2); assert.equal(p.tracks.d1.fx.reverbSend, 0.1); assert.equal(p.tracks.b1.fx.reverbSend, 0);
  assert.ok(p.tracks.g1.fx.eq.mid.db < 0, 'mud cut on the muddy guitar');
  assert.ok(p.tracks.v1.fx.eq.high.db > 0, 'presence on the dull lead');
  // amp never in a patch
  for (const t of Object.values(p.tracks)) assert.ok(!('amp' in t.fx));
  const g2 = AM.applyPlan(tracks[3], p.tracks.g2); assert.deepEqual(g2.fx.amp, ampOn);
});

test('every patch survives the engine normalizer unchanged (all in range)', () => {
  const p = AM.planMix(tracks, analysis);
  for (const t of tracks) {
    if (!p.tracks[t.id]) continue;
    const applied = AM.applyPlan({ ...t, fx: E.normalizeTrack(t).fx }, p.tracks[t.id]);
    const n = E.normalizeTrack(applied);
    assert.equal(n.gainDb, applied.gainDb); assert.equal(n.pan, applied.pan);
    for (const k of ['hpf', 'eq', 'comp']) if (p.tracks[t.id].fx[k]) for (const [kk, v] of Object.entries(p.tracks[t.id].fx[k])) assert.deepEqual(n.fx[k][kk], v, `${t.name} ${k}.${kk}`);
    assert.equal(n.fx.reverbSend, p.tracks[t.id].fx.reverbSend);
  }
});

test('deterministic', () => {
  assert.deepEqual(AM.planMix(tracks, analysis), AM.planMix(JSON.parse(JSON.stringify(tracks)), JSON.parse(JSON.stringify(analysis))));
});

test('planMaster: to target, capped when the limiter would work too hard', () => {
  assert.deepEqual(AM.planMaster({ lufs: -20, peakDb: -6 }).gainDb, 6);
  const m = AM.planMaster({ lufs: -24, peakDb: -2 });   // +10 dB would put peaks 9 dB over the −1 ceiling: capped at 6 over
  assert.equal(m.gainDb, 7); assert.ok(m.limiter); assert.ok(m.notes.some((x) => /capped/.test(x)));
  assert.equal(AM.planMaster({ lufs: -10, peakDb: 0 }).gainDb, -4);
  assert.equal(AM.planMaster({ lufs: -Infinity }).gainDb, 0);
  assert.equal(AM.planMaster({ lufs: -18, peakDb: -10 }, { target: -16 }).gainDb, 2);
});

test('diff reads like a change list', () => {
  const p = AM.planMix(tracks, analysis);
  const before = tracks.map((t) => E.normalizeTrack(t)); const after = before.map((t) => AM.applyPlan(t, p.tracks[t.id]));
  const lines = AM.diff(before, after);
  const v = lines.find((l) => l.startsWith('Lead vox:')); assert.match(v, /^Lead vox: \+\d+\.\d dB, HPF 95 Hz, .*comp 3\.5:1, reverb 20%/);
  assert.match(lines.find((l) => l.startsWith('Gtr L:')), /pan L 70/);
  assert.ok(!lines.some((l) => l.startsWith('Old gtr')));
});

test('loudness helpers: a 1 kHz sine at −20 dBFS reads ≈ −23 LUFS (mono), silence −120', () => {
  const sr = 48000, n = sr * 4; const a = new Float32Array(n); const amp = Math.pow(10, -20 / 20) * Math.SQRT2;
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * 1000 * i / sr);
  const L = AM.integratedLufs([a], sr); assert.ok(Math.abs(L - (-20 - 0.691 + 0.69)) < 0.6, String(L));
  const s = AM.shortTermLufs([a], sr); assert.equal(s.length, 2); assert.ok(Math.abs(s[0] - L) < 0.3);
  assert.deepEqual(AM.shortTermLufs([new Float32Array(n)], sr), [-120, -120]);
  assert.equal(AM.integratedLufs([new Float32Array(n)], sr), -120);
  assert.ok(AM.analysisNeeded().shortTerm);
});

function r(x) { return Math.round(x * 10) / 10; }
