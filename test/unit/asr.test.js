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
