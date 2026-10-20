'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/renderer/chart.js');
test('chords sit over the word they land on; parts without words show the progression', () => {
  const song = {
    sections: [{ id: 's1', name: 'Verse 1', start: 0, end: 8 }, { id: 's2', name: 'Solo', start: 8, end: 16 }],
    lyrics: [{ id: 'l1', time: 0, text: 'I walked down to the river', words: [{ w: 'I', t: 0, e: 0.3 }, { w: 'walked', t: 0.4, e: 0.8 }, { w: 'down', t: 0.9, e: 1.2 }, { w: 'to', t: 1.3, e: 1.4 }, { w: 'the', t: 1.5, e: 1.6 }, { w: 'river', t: 1.7, e: 2.4 }] }],
    chords: [{ time: 0, chord: 'G' }, { time: 1.7, chord: 'D/F#' }, { time: 8, chord: 'Em' }, { time: 12, chord: 'C' }],
    markers: [{ id: 'n', time: 9, text: 'double this', by: 'Kat' }],
  };
  const txt = C.chart(song, { title: 'River' });
  const lines = txt.split('\n');
  const i = lines.indexOf('[Verse 1]');
  assert.equal(lines[i + 1], 'G'.padEnd(20) + 'D/F#');
  assert.equal(lines[i + 2], 'I walked down to the river');
  assert.ok(txt.includes('[Solo]\n| Em | C |'));
  assert.ok(txt.includes('- Kat: double this'));
  assert.ok(!C.chart(song, { from: 8, to: 16 }).includes('river'));
});
