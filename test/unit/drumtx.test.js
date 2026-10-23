'use strict';
// Drums → hits: a synthesized rock beat (kick, snare, closed hats, a crash on bar 1) comes back hit for hit, on the grid.
const test = require('node:test'); const assert = require('node:assert');
const DT = require('../../src/renderer/drumtx.js');
const SR = 44100; let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
function hit(buf, at, kind, g = 1) {
  const a0 = Math.floor(at * SR); let prev = 0, lp = 0;
  const len = { kick: 0.35, snare: 0.25, hat: 0.06, crash: 2.2 }[kind];
  for (let i = 0; i < len * SR && a0 + i < buf.length; i++) {
    const t = i / SR; let v = 0;
    if (kind === 'kick') { const f = 45 + 90 * Math.exp(-t * 30); v = Math.sin(2 * Math.PI * f * t * (1 + 0)) * Math.exp(-t * 9) * 0.9 + rnd() * 0.05 * Math.exp(-t * 80); }
    else if (kind === 'snare') { const n = rnd(); lp = 0.6 * lp + 0.4 * n; v = (0.55 * lp + 0.25 * (n - prev)) * Math.exp(-t * 16) + 0.35 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25); prev = n; }
    else { const n = rnd(); v = (n - prev) * 0.5 * Math.exp(-t * (kind === 'hat' ? 70 : 1.0)); prev = n; }
    buf[a0 + i] += g * v * 0.5;
  }
}
test('a rock beat comes back hit for hit: kick, snare, hats and the crash, on the beat', () => {
  const bpm = 120, B = 0.5, bars = 4, off = 0.5; const buf = new Float32Array(Math.ceil((off + bars * 4 * B + 2) * SR)); const truth = [];
  const put = (t, d, g) => { hit(buf, t, d, g); truth.push({ t, drum: d }); };
  for (let bar = 0; bar < bars; bar++) for (let e = 0; e < 8; e++) { const t = off + bar * 2 + e * 0.25; put(t, 'hat', 0.6); if (e === 0 || e === 4 || (e === 5 && bar % 2)) put(t, 'kick', 1); if (e === 2 || e === 6) put(t, 'snare', 0.8); }
  put(off, 'crash', 0.9);
  const beats = []; for (let k = 0; off + k * B < buf.length / SR; k++) beats.push({ t: off + k * B, beat: k % 4 });
  const r = DT.transcribe(buf, SR, { beats });
  for (const d of ['kick', 'snare', 'hat']) {
    const T = truth.filter((x) => x.drum === d), G = r.hits.filter((h) => h.drum === d); const used = new Set(); let tp = 0;
    for (const g of G) { const i = T.findIndex((x, k) => !used.has(k) && Math.abs(x.t - g.t) < 0.03); if (i >= 0) { used.add(i); tp++; } }
    const p = tp / (G.length || 1), rc = tp / T.length; assert.ok(p >= 0.85 && rc >= 0.85, `${d}: P ${p.toFixed(2)} R ${rc.toFixed(2)} (${G.length} found, ${T.length} played)`);
  }
  assert.ok(r.hits.some((h) => h.drum === 'crash' && Math.abs(h.t - off) < 0.03), 'the crash on bar 1');
  for (const h of r.hits) { const k = (h.t - off) / 0.125; assert.ok(Math.abs(k - Math.round(k)) < 0.02, `${h.drum} at ${h.t} is on a 16th`); }
  assert.ok(r.hits.every((h) => DT.GM[h.drum] === h.n), 'GM note numbers');
});
