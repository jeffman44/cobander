'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ML = require('../../src/renderer/melody');
const MU = require('../../src/renderer/music');

test('syllables and stress for song lyrics', () => {
  const cases = { argue: ['ar-gue', '10'], beautiful: ['beau-ti-ful', '100'], away: ['a-way', '01'], tonight: ['to-night', '01'], riot: ['ri-ot', '10'], lonely: [null, '10'], singing: ['sing-ing', '10'], wanted: ['want-ed', '10'], walked: ['walked', '1'], every: ['ev-ry', '10'], fire: ['fire', '1'], information: [null, '0010'] };
  for (const [w, [split, st]] of Object.entries(cases)) {
    const syl = ML.wordSyllables(w); assert.equal(syl.length, st.length, `${w}: ${syl.join('-')}`);
    if (split) assert.equal(syl.join('-'), split);
    assert.equal(ML.wordStress(w, syl.length).join(''), st, w);
  }
  const L = ML.syllables('I can\'t ar-gue with the way you left\n\nevery_word was wrong');
  assert.equal(L.length, 2); assert.equal(L[0].length, 9); assert.equal(L[0][0].stress, 0, '"I" is weak'); assert.equal(L[1][0].text, 'every word', 'underscore joins'); assert.equal(L[1].length, 3);
});

const chords = (t) => ['G', 'D', 'Em', 'C'][Math.floor(t / 2) % 4];
const lyric = "I can't argue with the way you left\nevery word I said was wrong\nI can't argue with the way you left\nnow I'm singing this alone";

test('generate: every syllable gets one note, in the key, inside the part, in a singable range', () => {
  const g = ML.generate({ text: lyric, seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', chordAt: chords, sectionType: 'chorus', seed: 7 });
  const total = ML.syllables(lyric).reduce((n, l) => n + l.length, 0);
  assert.equal(g.notes.length, total);
  const pcs = MU.scaleOf('G').pcs;
  for (const n of g.notes) { assert.ok(pcs.includes(n.n % 12), `out of key ${n.n}`); assert.ok(n.t >= 0 && n.t + n.d <= 32 + 1e-6, `outside the part ${n.t}`); assert.ok(n.l); }
  const range = Math.max(...g.notes.map((n) => n.n)) - Math.min(...g.notes.map((n) => n.n)); assert.ok(range <= 17, `range ${range}`);
  for (let i = 1; i < g.notes.length; i++) assert.ok(g.notes[i].t > g.notes[i - 1].t, 'notes in order, no overlaps at onset');
  // lines 1 and 3 have the same words → the same rhythm (relative to their bar)
  const lineStarts = [0, 1, 2, 3].map((l) => g.rhythm.filter((e) => e.line === l));
  assert.deepEqual(lineStarts[0].map((e) => e.beat % 16), lineStarts[2].map((e) => e.beat % 16));
  // even lines end "closed" on 1 or 3, odd lines "open" on 2 or 5 most of the time over many seeds
  let ok = 0, tries = 0;
  for (let seed = 1; seed <= 20; seed++) { const h = ML.generate({ text: lyric, seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', chordAt: chords, seed }); for (let l = 0; l < 4; l++) { const ix = h.rhythm.map((e, i) => (e.line === l ? i : -1)).filter((i) => i >= 0); const deg = pcs.indexOf(h.notes[ix[ix.length - 1]].n % 12) + 1; tries++; if ((l % 2 === 0 ? [2, 5] : [1, 3]).includes(deg)) ok++; } }
  assert.ok(ok / tries > 0.6, `cadences ${ok}/${tries}`);
});

test('generate: stepwise-leaning, stressed syllables on strong beats, deterministic by seed, locks work', () => {
  const a = ML.generate({ text: lyric, seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', chordAt: chords, seed: 99 });
  const b = ML.generate({ text: lyric, seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', chordAt: chords, seed: 99 });
  assert.deepEqual(a.notes, b.notes);
  let steps = 0, n = 0; for (let i = 1; i < a.notes.length; i++) if (a.rhythm[i].line === a.rhythm[i - 1].line) { n++; if (Math.abs(a.notes[i].n - a.notes[i - 1].n) <= 2) steps++; }
  assert.ok(steps / n >= 0.45, `steps ${steps}/${n}`);
  const syl = ML.syllables(lyric).flat(); let strongStressed = 0, stressed = 0;
  a.rhythm.forEach((e, i) => { if (syl[i].stress) { stressed++; if (ML.posWeight(e.beat, 4) >= 1) strongStressed++; } });
  assert.ok(strongStressed / stressed > 0.8, `stressed on beats/8ths ${strongStressed}/${stressed}`);
  const keepRhythm = ML.generate({ text: lyric, seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', chordAt: chords, seed: 5, rhythm: a.rhythm });
  assert.deepEqual(keepRhythm.notes.map((x) => x.t), a.notes.map((x) => x.t));
  const keepNotes = ML.generate({ text: lyric, seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', chordAt: chords, seed: 5, pitches: a.pitches });
  assert.deepEqual(keepNotes.notes.map((x) => x.n), a.pitches);
  assert.throws(() => ML.generate({ text: '  ', seconds: 8, bpm: 120 }), /no lyrics/);
});

test('crowded and sparse parts still fit every syllable; minor keys and odd meters', () => {
  const many = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
  const g = ML.generate({ text: many, seconds: 4, bpm: 120, timeSig: [4, 4], key: 'Em', seed: 3 });
  assert.equal(g.notes.length, ML.syllables(many)[0].length); assert.ok(g.notes[g.notes.length - 1].t < 4);
  const pcs = MU.scaleOf('Em').pcs; for (const n of g.notes) assert.ok(pcs.includes(n.n % 12));
  const w = ML.generate({ text: 'oh\nyeah', seconds: 16, bpm: 90, timeSig: [6, 8], key: 'D', seed: 4, voice: 'high' });
  assert.equal(w.notes.length, 2); for (const n of w.notes) assert.ok(n.n >= 57 && n.n <= 76);
});

test('vowels for the guide voice', () => {
  assert.equal(ML.vowelOf('see'), 'i'); assert.equal(ML.vowelOf('you'), 'u'); assert.equal(ML.vowelOf('go'), 'o'); assert.equal(ML.vowelOf('way'), 'a'); assert.equal(ML.vowelOf('left'), 'e');
});

test('key detection from notes and from audio', () => {
  assert.equal(MU.keyFromNotes([64, 67, 71, 66, 64, 62, 59, 64].map((n) => ({ n, d: 1 }))).key.replace(/m$/, 'm'), 'Em');
  const sr = 22050, n = sr * 3; const x = new Float32Array(n); const f = [146.83, 185.0, 220.0, 293.66];   // D major chord
  for (let i = 0; i < n; i++) { let v = 0; for (const h of f) v += Math.sin(2 * Math.PI * h * i / sr); x[i] = v / 4; }
  const k = MU.keyFromAudio([x], sr); assert.ok(['D', 'Bm', 'A', 'F#m', 'G', 'Em'].includes(k.key), k.key);
  assert.equal(MU.keyShift(k.key, 'D') === 0 || Math.abs(MU.keyShift(k.key, 'D')) <= 5, true);
});

test('review fixes: prototype words, numbers, every line sung in short parts, last line resolves, held notes capped', () => {
  assert.equal(ML.syllables('the constructor of love')[0].length, 6);
  const n = ML.syllables('24 hours in 1985'); assert.equal(n[0].map((x) => x.text).join(''), 'twentyfourhoursinnineteeneightyfive');
  const skip = ML.syllables('🎸\nsing it'); assert.equal(skip.length, 1); assert.equal(skip[0].src, 1);
  for (const [w, c] of [['crying', 2], ['saying', 2], ['guard', 1], ['square', 1], ['someone', 2], ['million', 2], ['twenty-one', 3], ['yeah', 1]]) assert.equal(ML.wordSyllables(w).length, c, w);
  const four = 'I can\'t argue\nwith the way you left\nevery word\nwas wrong';
  const g = ML.generate({ text: four, seconds: 4, bpm: 120, timeSig: [4, 4], key: 'G', seed: 2 });
  assert.equal(g.notes.length, ML.syllables(four).reduce((a, l) => a + l.length, 0), 'all four lines fit in 2 bars');
  for (let i = 0; i < g.notes.length; i++) { assert.ok(g.notes[i].t + g.notes[i].d <= 4 + 1e-6); if (i) assert.ok(g.notes[i - 1].t + g.notes[i - 1].d <= g.notes[i].t + 1e-9, 'no overlap'); }
  const pcs = MU.scaleOf('G').pcs; let closed = 0;
  for (let seed = 1; seed <= 40; seed++) { const h = ML.generate({ text: 'a single line to end on', seconds: 8, bpm: 120, timeSig: [4, 4], key: 'G', seed }); const deg = pcs.indexOf(h.notes[h.notes.length - 1].n % 12) + 1; if ([1, 3].includes(deg)) closed++; }
  assert.ok(closed >= 28, `one-line parts end home ${closed}/40`);
  const hold = ML.generate({ text: 'hold on', seconds: 32, bpm: 120, timeSig: [4, 4], key: 'G', seed: 1 });
  assert.ok(Math.max(...hold.notes.map((x) => x.d)) <= 2.01, 'held note capped at a bar');
  const t0 = Date.now(); ML.generate({ text: Array.from({ length: 40 }, () => 'la').join(' '), seconds: 154, bpm: 200, timeSig: [4, 4], key: 'G', seed: 2, density: 'busy' }); assert.ok(Date.now() - t0 < 1000, 'long lines stay fast');
});

test('key confidence drops for power chords and sparse note sets', () => {
  assert.ok(MU.keyFromNotes([64, 71, 64, 71].map((n) => ({ n, d: 1 }))).confidence < 0.3, 'E5 riff');
  assert.ok(MU.keyFromNotes([64, 67].map((n) => ({ n, d: 1 }))).confidence < 0.3, 'two notes');
  assert.ok(MU.keyFromNotes([60, 62, 64, 65, 67, 69, 71, 72, 64, 67, 60].map((n) => ({ n, d: 1 }))).confidence >= 0.3, 'a full C scale');
});
