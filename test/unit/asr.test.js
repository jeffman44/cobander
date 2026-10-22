const test = require('node:test'); const assert = require('node:assert/strict');
const A = require('../../src/renderer/asr.js');
const ch = (text, a, b) => ({ text, timestamp: [a, b] });
test('asr: noise tokens dropped, held-note loops trimmed', () => {
  const w = A.cleanWords([ch(' (mumbling)', 0, 1), ch(' [Music]', 1, 2), ch(' ♪', 2, 2.1), ch(' oh', 3, 3.2), ch(' oh', 3.2, 3.4), ch(' oh', 3.4, 3.6), ch(' oh', 3.6, 3.8), ch(' oh', 3.8, 4), ch(' yeah', 4, 4.3)]);
  assert.deepEqual(w.map((x) => x.w), ['oh', 'oh', 'oh', 'yeah']);
});
test('asr: words become lines at breaths and sentence ends, with word timings', () => {
  const words = A.cleanWords([ch(' I', 1, 1.2), ch(' cant', 1.2, 1.5), ch(' argue', 1.5, 2), ch(' with', 2, 2.2), ch(' you.', 2.2, 2.6), ch(' And', 2.7, 2.9), ch(' the', 2.9, 3), ch(' way', 3, 3.3), ch(' you', 4.5, 4.7), ch(' left', 4.7, 5)]);
  const lines = A.groupLines(words);
  assert.deepEqual(lines.map((l) => l.text), ['I cant argue with you.', 'And the way', 'You left']);
  assert.equal(lines[0].time, 1); assert.equal(lines[2].words[1].w, 'left'); assert.equal(lines[2].words[1].t, 4.7);
});

test('alignWords: typed words take the times of the words that were heard, fixes and extras fill the gaps', () => {
  const A = require('../../src/renderer/asr.js');
  const heard = [{ w: 'I', t: 1, e: 1.2 }, { w: 'walk', t: 1.3, e: 1.6 }, { w: 'down', t: 1.7, e: 2 }, { w: 'to', t: 2.1, e: 2.2 }, { w: 'river', t: 2.5, e: 3 }];
  const r = A.alignWords(heard, 'I walked down to the river');
  assert.deepEqual(r.map((x) => x.w), ['I', 'walked', 'down', 'to', 'the', 'river']);
  assert.equal(r[1].t, 1.3);   // "walked" ~ "walk"
  assert.ok(r[4].t >= 2.2 && r[4].t < 2.5);   // "the" was never heard: sits between "to" and "river"
  assert.equal(r[5].t, 2.5);
});
test('alignToTyped pins typed lines where they were sung and leaves unmatched heard lines over', () => {
  const A = require('../../src/renderer/asr.js');
  const heard = A.groupLines([{ w: 'hello', t: 0, e: 0.3 }, { w: 'darkness', t: 0.35, e: 0.8 }, { w: 'my', t: 0.85, e: 1 }, { w: 'old', t: 1.05, e: 1.3 }, { w: 'friend.', t: 1.35, e: 1.8 }, { w: 'yeah', t: 4, e: 4.5 }, { w: 'come', t: 6, e: 6.2 }, { w: 'to', t: 6.25, e: 6.4 }, { w: 'talk', t: 6.45, e: 6.8 }, { w: 'again', t: 6.85, e: 7.2 }]);
  const typed = [{ id: 'a', text: 'Hello darkness, my old friend' }, { id: 'b', text: "I've come to talk with you again" }];
  const r = A.alignToTyped(typed, heard);
  assert.deepEqual(r.matches.map((m) => [m.id, m.time]), [['a', 0], ['b', 6]]);
  assert.equal(r.matches[1].words.length, 7);
  assert.deepEqual(r.extra.map((l) => l.text), ['Yeah']);
});

// ---- word starts / ends moved onto the voice ----
{
  const SR = 16000;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // a sung syllable: a voiced tone with a few harmonics, soft 15 ms attack, a consonant burst of noise at its start
  function sing(buf, at, dur, f0, gain = 0.25) {
    const a0 = Math.floor(at * SR), n = Math.floor(dur * SR);
    for (let i = 0; i < n && a0 + i < buf.length; i++) {
      const t = i / SR; const env = Math.min(1, t / 0.015) * Math.min(1, (dur - t) / 0.03);
      let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      if (t < 0.03) v += (rnd() * 2 - 1) * 0.6;
      buf[a0 + i] += gain * env * v;
    }
  }
  const bleed = (buf, g = 0.002) => { for (let i = 0; i < buf.length; i++) buf[i] += (rnd() * 2 - 1) * g; };   // the band in the vocal mic, ~ -55 dB
  test('word starts snap to the vocal onsets near Whisper\'s guess; ends to where the voice stops', () => {
    const buf = new Float32Array(SR * 8); bleed(buf);
    const truth = []; let t = 0.6;
    for (let k = 0; k < 12; k++) { const d = 0.22 + rnd() * 0.3; sing(buf, t, d, 180 + rnd() * 120); truth.push({ t, e: t + d }); t += d + 0.08 + rnd() * 0.25; }
    const jit = [0.22, -0.18, 0.12, -0.25, 0.1, 0.1, 0.05, 0.2, -0.22, 0.15, -0.3, 0.25];
    const heard = truth.map((x, k) => ({ w: `w${k}`, t: x.t + jit[k], e: x.e + jit[k] }));
    // Whisper's typical glue: each word "ends" where the next one starts
    for (let k = 0; k < heard.length - 1; k++) heard[k].e = heard[k + 1].t;
    const r = A.refineWordTimes(heard, buf, SR);
    const errs = r.map((x, k) => Math.abs(x.t - truth[k].t));
    assert.ok(errs.filter((e) => e < 0.04).length >= 11, JSON.stringify(r.map((x, k) => [x.t, truth[k].t])));
    assert.ok(Math.max(...errs) < 0.12, `worst ${Math.max(...errs)}`);
    const eErr = r.map((x, k) => Math.abs(x.e - truth[k].e)); assert.ok(eErr.filter((e) => e < 0.09).length >= 10, JSON.stringify(r.map((x, k) => [x.e, truth[k].e])));
    for (let k = 1; k < r.length; k++) assert.ok(r[k].t > r[k - 1].t, 'never backwards'); r.forEach((x) => assert.ok(x.e > x.t));
    assert.equal(heard[0].t, truth[0].t + jit[0], 'input untouched');
  });
  test('a legato line with no onsets keeps Whisper\'s times (within reach), a word guessed in a gap moves to the voice', () => {
    const buf = new Float32Array(SR * 4); bleed(buf);
    // one long held vowel 0.5 → 3.0 s, pitch steps but no gaps or level jumps
    for (let i = Math.floor(0.5 * SR); i < 3 * SR; i++) { const t = i / SR; const f0 = t < 1.2 ? 200 : t < 2 ? 240 : 220; const env = Math.min(1, (t - 0.5) / 0.02) * Math.min(1, (3 - t) / 0.03); buf[i] += 0.25 * env * Math.sin(2 * Math.PI * f0 * t); }
    const heard = [{ w: 'oh', t: 0.3, e: 1.2 }, { w: 'my', t: 1.25, e: 2.0 }, { w: 'love', t: 2.05, e: 3.0 }];
    const r = A.refineWordTimes(heard, buf, SR);
    assert.ok(Math.abs(r[0].t - 0.5) < 0.04, `first word starts with the voice, got ${r[0].t}`);
    assert.ok(Math.abs(r[1].t - 1.25) < 0.15 && Math.abs(r[2].t - 2.05) < 0.15, JSON.stringify(r));
    assert.ok(Math.abs(r[2].e - 3.0) < 0.08, `last word ends with the voice, got ${r[2].e}`);
    // nothing to read (flat noise): untouched
    const flat = new Float32Array(SR * 2); bleed(flat, 0.1); const same = A.refineWordTimes([{ w: 'a', t: 0.5, e: 0.8 }], flat, SR); assert.equal(same[0].t, 0.5);
  });
}
