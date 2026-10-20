// Pitch check for sung takes: pitch track (YIN via tuner.js on a 16 kHz copy) → sung notes → how far each one is from
// what it should be (the melody note at that moment, else the nearest note of the key, else the nearest semitone).
// Shows and flags only — nothing here changes the audio.
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(() => (isNode ? require('./tuner.js') : root.BPTuner), () => (isNode ? require('./music.js') : root.BPMusic));
  if (isNode) module.exports = api;
  else root.BPPitchCheck = api;
})(typeof self !== 'undefined' ? self : this, function (getT, getM) {
  'use strict';
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
  const noteLabel = (m) => { const r = Math.round(m); return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`; };

  // mono: Float32Array (any rate); returns a point every `hop` s, t = centre of the analysis window
  function track(mono, sr, { hop = 0.01, win = 2048, minHz = 70, maxHz = 1100 } = {}) {
    const T = getT();
    const k = Math.max(1, Math.round(sr / 16000)); const fs = sr / k;
    const n = Math.floor(mono.length / k); const x = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const o = i * k; for (let j = 0; j < k; j++) s += mono[o + j]; x[i] = s / k; }   // box filter + decimate
    const W = Math.max(256, Math.round(win / k)); const H = hop * fs; const out = [];
    for (let f = 0; ; f++) {
      const a = Math.round(f * H); if (a + W > n) break;
      const seg = x.subarray(a, a + W); let e = 0; for (let i = 0; i < W; i++) e += seg[i] * seg[i]; const rms = Math.sqrt(e / W);
      const t = (a + W / 2) / fs;
      let midi = NaN, clarity = 0;
      if (rms >= 0.004) { const r = T.detect(seg, fs, { minHz, maxHz, minRms: 0.004 }); if (r && r.clarity >= 0.75) { midi = 69 + 12 * Math.log2(r.freq / 440); clarity = r.clarity; } }
      out.push({ t, midi, clarity, rms });
    }
    return out;
  }

  // points → sung notes; a note ends at an unvoiced gap or a jump of more than maxJump semitones
  function notes(pts, { minDur = 0.12, maxJump = 0.8, gap = 0.015 } = {}) {
    const hop = pts.length > 1 ? pts[1].t - pts[0].t : 0.01;
    const segs = []; let cur = null; let lastT = -Infinity;
    for (const p of pts) {
      if (!Number.isFinite(p.midi)) continue;
      const ref = cur ? median(cur.slice(-5).map((q) => q.midi)) : NaN;
      if (!cur || p.t - lastT > gap + hop * 0.5 || Math.abs(p.midi - ref) > maxJump) { cur = []; segs.push(cur); }
      cur.push(p); lastT = p.t;
    }
    const out = [];
    for (let s of segs) {
      // the analysis window still hears a note while it's half-way off its edge: trim frames that are clearly quieter
      const mr = median(s.map((q) => q.rms)); let i0 = 0, i1 = s.length - 1;
      while (i0 < i1 && s[i0].rms < 0.65 * mr) i0++; while (i1 > i0 && s[i1].rms < 0.65 * mr) i1--; s = s.slice(i0, i1 + 1);
      const t0 = s[0].t - hop / 2, t1 = s[s.length - 1].t + hop / 2;
      if (t1 - t0 < minDur) continue;
      const a = Math.floor(s.length * 0.2), b = Math.max(a + 1, Math.ceil(s.length * 0.8));
      const mid = s.slice(a, b).map((q) => q.midi);
      const m = median(mid);
      out.push({ t0, t1, midi: m, cents: Math.round((m - Math.round(m)) * 100), vibrato: Math.round(((pct(mid, 0.9) - pct(mid, 0.1)) / 2) * 100) });
    }
    return out;
  }

  // nearest MIDI note whose pitch class is in the scale
  function nearestInScale(m, pcs) { let best = null; for (let r = Math.floor(m) - 2; r <= Math.ceil(m) + 2; r++) if (pcs.includes(((r % 12) + 12) % 12) && (best == null || Math.abs(r - m) < Math.abs(best - m))) best = r; return best == null ? Math.round(m) : best; }

  // Calibrated on real pop-punk vocal takes (2026-10): notes under 0.2 s are consonant / scoop territory and read
  // anywhere within a semitone, so they're shown but not judged ('short'); a note sitting between two scale tones
  // (|off| 40–60 cents) is 'between' — ambiguous, not sharp or flat; wild vibrato (> 70 cents) is 'wobbly'.
  function check(sung, { key = null, melody = null, tolerance = 25, offset = 0, minDur = 0.2, maxVibrato = 70 } = {}) {
    const sc = key ? getM().scaleOf(key) : null;
    const res = (sung || []).map((nt) => {
      const tm = (nt.t0 + nt.t1) / 2 + offset; let target, why;
      const mel = melody && melody.length ? melody.filter((m) => tm >= m.t - 1e-6 && tm < m.t + m.d + 1e-6).sort((a, b) => Math.abs(a.n - nt.midi) - Math.abs(b.n - nt.midi))[0] : null;
      if (mel) { target = mel.n; why = 'melody'; }
      else if (sc) { target = nearestInScale(nt.midi, sc.pcs); why = `key of ${key}`; }
      else { target = Math.round(nt.midi); why = 'nearest note'; }
      const off = Math.round((nt.midi - target) * 100);
      const dur = nt.t1 - nt.t0;
      const flag = dur < minDur ? 'short' : (mel || sc) && Math.abs(off) > 80 ? 'wrong-note' : Math.abs(off) >= 40 && Math.abs(off) <= 60 && !mel ? 'between' : off > tolerance ? 'sharp' : off < -tolerance ? 'flat' : (nt.vibrato || 0) > maxVibrato ? 'wobbly' : 'ok';
      return { ...nt, target, off, flag, why: flag === 'wrong-note' ? `${noteLabel(nt.midi)} sung, ${noteLabel(target)} expected (${why})` : why };
    });
    const by = (f) => res.filter((r) => r.flag === f).length;
    const judged = res.filter((r) => r.flag !== 'short');
    const summary = { notes: judged.length, short: by('short'), ok: by('ok') + by('wobbly'), sharp: by('sharp'), flat: by('flat'), between: by('between'), wobbly: by('wobbly'), wrong: by('wrong-note'), avgAbsCents: judged.length ? Math.round(judged.reduce((n, r) => n + Math.abs(r.off), 0) / judged.length) : 0, worst: judged.filter((r) => r.flag !== 'between').sort((a, b) => Math.abs(b.off) - Math.abs(a.off)).slice(0, 3) };
    return { results: res, summary };
  }

  // sections: [{name, start, end}]; fmt(t) → a position label ('bar 12.3')
  function sectionReport(results, sections, fmt = (t) => `${t.toFixed(1)} s`) {
    const out = {};
    for (const s of sections || []) {
      const rs = (results || []).filter((r) => { const m = (r.t0 + r.t1) / 2; return m >= s.start && m < s.end && r.flag !== 'short'; });
      if (!rs.length) continue;
      const w = rs.filter((r) => r.flag !== 'between').sort((a, b) => Math.abs(b.off) - Math.abs(a.off))[0] || rs[0];
      out[s.name] = { notes: rs.length, ok: Math.round(100 * rs.filter((r) => r.flag === 'ok' || r.flag === 'wobbly' || r.flag === 'between').length / rs.length), avgAbsCents: Math.round(rs.reduce((n, r) => n + Math.abs(r.off), 0) / rs.length),
        worst: `${noteLabel(w.midi)} ${w.off < 0 ? '−' : '+'}${Math.abs(w.off)}c at ${fmt(w.t0)}` };
    }
    return out;
  }
  return { track, notes, check, sectionReport, noteLabel };
});
