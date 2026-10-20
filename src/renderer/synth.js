// Sound sources and the amp/cab generators. Everything takes a BaseAudioContext so it
// works identically live and in an OfflineAudioContext (bounce / analysis).
(function (global) {
  'use strict';

  const dbToGain = (db) => (db <= -90 ? 0 : Math.pow(10, db / 20));
  const noteHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

  // ---------- amp: waveshaper curves + synthetic cabinet IRs ----------
  const curveCache = new Map();
  function ampCurve(model, gain) {
    const key = `${model}:${Math.round(gain * 10)}`;
    if (curveCache.has(key)) return curveCache.get(key);
    const n = 4096, c = new Float32Array(n);
    const g = Math.pow(10, (gain / 10) * 2) * 0.6;   // gain 0..10 → 0.6..60× drive
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const d = x * g;
      let y;
      switch (model) {
        case 'clean':     y = Math.tanh(d * 0.35) / Math.tanh(0.35 * g) * Math.min(1, g); break;
        case 'crunch':    y = Math.tanh(d) + 0.08 * Math.tanh(d * 3) * (x > 0 ? 1 : 0.6); break;   // asymmetric: even harmonics
        case 'lead':      y = Math.tanh(d * 1.5) * 0.9 + 0.1 * Math.sign(d) * Math.min(1, Math.abs(d) / 3); break;
        case 'highgain':  y = Math.sign(d) * (1 - Math.exp(-Math.abs(d) * 1.8)); break;
        case 'fuzz':      y = Math.max(-0.8, Math.min(0.8, d * 2.2)) + 0.15 * Math.sin(d * 3); break;
        case 'bass':      y = Math.tanh(d * 0.5) / Math.tanh(0.5 * Math.max(1, g)); break;
        case 'bassdrive': y = Math.tanh(d * 0.9) + 0.05 * Math.tanh(d * 4); break;
        default:          y = Math.tanh(d);
      }
      c[i] = Math.max(-1, Math.min(1, y));
    }
    curveCache.set(key, c);
    return c;
  }

  // Cabinet IR: a short noise burst (broadband body) plus gentle low-Q modes under a 2-pole lowpass,
  // normalised to its average 80 Hz–3 kHz magnitude so a cab colours the tone without changing level.
  const irCache = new Map();
  function cabIR(ctx, cab) {
    const key = `${cab}:${ctx.sampleRate}`;
    if (irCache.has(key)) return irCache.get(key);
    const sr = ctx.sampleRate;
    const spec = {
      '412': { len: 0.06, lp: 4200, modes: [[95, 1, 0.03], [420, 0.5, 0.012], [1300, 0.4, 0.008], [2600, 0.35, 0.006], [3600, 0.2, 0.005]] },
      '212': { len: 0.05, lp: 5000, modes: [[120, 0.8, 0.025], [500, 0.5, 0.01], [1500, 0.45, 0.007], [3000, 0.35, 0.005], [4200, 0.2, 0.004]] },
      '112': { len: 0.045, lp: 5500, modes: [[150, 0.6, 0.02], [600, 0.5, 0.009], [1800, 0.5, 0.006], [3400, 0.4, 0.005], [4800, 0.2, 0.004]] },
      '810': { len: 0.07, lp: 3200, modes: [[60, 1, 0.04], [250, 0.6, 0.015], [900, 0.4, 0.008], [2000, 0.3, 0.006], [2900, 0.15, 0.005]] },
      '115': { len: 0.07, lp: 2800, modes: [[55, 1, 0.045], [220, 0.6, 0.016], [800, 0.4, 0.009], [1800, 0.25, 0.006], [2500, 0.1, 0.005]] },
    }[cab] || { len: 0.03, lp: 6000, modes: [[200, 0.5, 0.01], [2000, 0.5, 0.005]] };
    const n = Math.floor(sr * spec.len);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const a = Math.exp(-2 * Math.PI * spec.lp / sr);
    let lp = 0, lp2 = 0, seed = 4242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // broadband body: a short noise burst (smooth response), plus gentle modes for colour (low Q)
      let x = rnd() * Math.exp(-t / 0.004) * 1.5;
      for (const [f, amp, tau] of spec.modes) x += 0.25 * amp * Math.exp(-t / Math.min(tau, 0.006)) * Math.sin(2 * Math.PI * f * t);
      lp = a * lp + (1 - a) * x; lp2 = a * lp2 + (1 - a) * lp;   // 2-pole lowpass
      d[i] = lp2;
    }
    // normalise to the average magnitude response over 80 Hz – 3 kHz (log-spaced), evaluated directly
    let acc = 0; const N = 24;
    for (let k = 0; k < N; k++) {
      const f = 80 * Math.pow(3000 / 80, k / (N - 1)); let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * f * i / sr; re += d[i] * Math.cos(ph); im -= d[i] * Math.sin(ph); }
      acc += Math.hypot(re, im) ** 2;
    }
    const mag = Math.sqrt(acc / N) || 1;
    for (let i = 0; i < n; i++) { d[i] /= mag; if (!Number.isFinite(d[i])) d[i] = 0; }
    irCache.set(key, buf);
    return buf;
  }

  // ---------- drum machine ----------
  const KITS = {
    rock:  { kick: { f0: 150, f1: 45, dec: 0.45, click: 0.6 }, snare: { tone: 190, noise: 0.9, dec: 0.22, bp: 2200 }, hat: { dec: 0.045, hp: 7000 }, ohat: { dec: 0.25, hp: 6500 }, tom: { f0: 170, f1: 90, dec: 0.35 }, crash: { dec: 1.3, bp: 5000 } },
    punk:  { kick: { f0: 170, f1: 55, dec: 0.32, click: 0.9 }, snare: { tone: 210, noise: 1.0, dec: 0.18, bp: 2800 }, hat: { dec: 0.035, hp: 8000 }, ohat: { dec: 0.2, hp: 7000 }, tom: { f0: 190, f1: 100, dec: 0.28 }, crash: { dec: 1.1, bp: 5500 } },
    tight: { kick: { f0: 140, f1: 50, dec: 0.22, click: 0.8 }, snare: { tone: 220, noise: 0.8, dec: 0.12, bp: 3000 }, hat: { dec: 0.03, hp: 9000 }, ohat: { dec: 0.15, hp: 8000 }, tom: { f0: 160, f1: 95, dec: 0.2 }, crash: { dec: 0.9, bp: 6000 } },
    '808': { kick: { f0: 120, f1: 38, dec: 0.9, click: 0.2 }, snare: { tone: 180, noise: 0.7, dec: 0.25, bp: 1800 }, hat: { dec: 0.05, hp: 8000 }, ohat: { dec: 0.35, hp: 7000 }, tom: { f0: 140, f1: 70, dec: 0.5 }, crash: { dec: 1.5, bp: 4500 } },
    lofi:  { kick: { f0: 110, f1: 50, dec: 0.3, click: 0.3 }, snare: { tone: 170, noise: 0.6, dec: 0.2, bp: 1500 }, hat: { dec: 0.04, hp: 5000 }, ohat: { dec: 0.2, hp: 4500 }, tom: { f0: 150, f1: 85, dec: 0.3 }, crash: { dec: 0.8, bp: 3500 } },
  };
  const noiseCache = new Map();
  function noiseBuffer(ctx) {
    const key = ctx.sampleRate;
    if (noiseCache.has(key)) return noiseCache.get(key);
    const n = ctx.sampleRate * 2; const b = ctx.createBuffer(1, n, ctx.sampleRate); const d = b.getChannelData(0);
    let s = 777; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x7fffffff * 2 - 1; }
    noiseCache.set(key, b); return b;
  }
  // Schedules one drum hit into `out` at `when`. vel 0..1. Returns the nodes to allow stop().
  function drumHit(ctx, out, kitName, voice, when, vel = 1) {
    const kit = KITS[kitName] || KITS.rock; const p = kit[voice]; if (!p) return [];
    vel = vel * 0.5;   // kit headroom: a full pattern with accents peaks around -6 dBFS, leaving room for guitars
    const nodes = [];
    const env = (g, peak, dec) => { g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + dec); };
    if (voice === 'kick' || voice === 'tom') {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.setValueAtTime(p.f0, when); o.frequency.exponentialRampToValueAtTime(p.f1, when + (voice === 'kick' ? 0.08 : 0.15));
      env(g, vel * (voice === 'kick' ? 0.5 : 0.35), p.dec); o.connect(g); g.connect(out); o.start(when); o.stop(when + p.dec + 0.05); nodes.push(o);
      if (voice === 'kick' && p.click > 0) { const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000; const ng = ctx.createGain(); env(ng, vel * 0.12 * p.click, 0.02); n.connect(hp); hp.connect(ng); ng.connect(out); n.start(when); n.stop(when + 0.05); nodes.push(n); }
    } else if (voice === 'snare') {
      const o = ctx.createOscillator(); o.type = 'triangle'; const og = ctx.createGain(); o.frequency.setValueAtTime(p.tone, when); o.frequency.exponentialRampToValueAtTime(p.tone * 0.6, when + 0.1);
      env(og, vel * 0.25, p.dec * 0.7); o.connect(og); og.connect(out); o.start(when); o.stop(when + p.dec); nodes.push(o);
      const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = p.bp; bp.Q.value = 0.7; const ng = ctx.createGain(); env(ng, vel * 0.4 * p.noise, p.dec);
      n.connect(bp); bp.connect(ng); ng.connect(out); n.start(when); n.stop(when + p.dec + 0.05); nodes.push(n);
    } else if (voice === 'hat' || voice === 'ohat' || voice === 'crash') {
      const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx); n.loop = true;
      const f = ctx.createBiquadFilter(); f.type = voice === 'crash' ? 'bandpass' : 'highpass'; f.frequency.value = voice === 'crash' ? p.bp : p.hp; f.Q.value = voice === 'crash' ? 0.5 : 0.7;
      const g = ctx.createGain(); env(g, vel * (voice === 'crash' ? 0.25 : voice === 'ohat' ? 0.2 : 0.17), p.dec);
      n.connect(f); f.connect(g); g.connect(out); n.start(when); n.stop(when + p.dec + 0.05); nodes.push(n);
    }
    return nodes;
  }

  // Expand a drum config into hits (song-time seconds) between [from, to).
  // drum = { kit, pattern (name) | custom (steps), swing 0..1, bars (0 = until `to`) , offsetBars }
  function drumEvents(drum, patterns, bpm, timeSig, from, to) {
    const steps = drum.custom || patterns[drum.pattern] || {};
    const beat = 60 / bpm; const bar = beat * timeSig[0]; const step = beat / 4; const nSteps = Math.min(16, timeSig[0] * 4);
    const end = drum.bars ? Math.min(to, (drum.offsetBars || 0) * bar + drum.bars * bar) : to;
    const start = (drum.offsetBars || 0) * bar;
    const out = [];
    for (let b = Math.max(0, Math.floor((from - start) / bar)); start + b * bar < end; b++) {
      for (const [voice, arr] of Object.entries(steps)) {
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < nSteps; i++) {
          const v = arr[i]; if (!v) continue;
          let t = start + b * bar + i * step;
          if (drum.swing && i % 2 === 1) t += step * 0.33 * drum.swing;
          if (t >= from && t < end) out.push({ t, voice, vel: v >= 2 ? 1 : 0.7 });
        }
      }
    }
    return out;
  }

  // ---------- synth instruments ----------
  const SYNTHS = {
    bass:   { osc: ['sawtooth', 'square'], detune: 0, filter: 600, fenv: 1800, q: 2, a: 0.005, d: 0.25, s: 0.4, r: 0.08, oct: -1, gain: 0.5 },
    saw:    { osc: ['sawtooth', 'sawtooth'], detune: 12, filter: 2500, fenv: 3000, q: 1, a: 0.01, d: 0.2, s: 0.7, r: 0.15, oct: 0, gain: 0.35 },
    square: { osc: ['square'], detune: 0, filter: 3000, fenv: 1000, q: 0.7, a: 0.005, d: 0.1, s: 0.8, r: 0.1, oct: 0, gain: 0.3 },
    pad:    { osc: ['sawtooth', 'sawtooth', 'triangle'], detune: 10, filter: 900, fenv: 1500, q: 0.5, a: 0.6, d: 0.5, s: 0.8, r: 1.2, oct: 0, gain: 0.25 },
    keys:   { osc: ['sine', 'triangle'], detune: 0, filter: 4000, fenv: 2500, q: 0.5, a: 0.003, d: 0.6, s: 0.25, r: 0.4, oct: 0, gain: 0.4, harm: 2 },
    organ:  { osc: ['sine', 'sine', 'sine'], detune: 0, filter: 6000, fenv: 0, q: 0.3, a: 0.01, d: 0.05, s: 1.0, r: 0.05, oct: 0, gain: 0.3, drawbars: true },
    pluck:  { osc: ['triangle', 'sawtooth'], detune: 5, filter: 800, fenv: 5000, q: 1.5, a: 0.002, d: 0.25, s: 0.0, r: 0.2, oct: 0, gain: 0.4 },
    // plucked-string guitars (Karplus-Strong), played by guitarNote(); entries keep the names valid
    cleangtr:  { ks: true, bright: 0.55, decay: 0.9965, drive: 0, lp: 5200, gain: 0.5 },
    crunchgtr: { ks: true, bright: 0.7, decay: 0.998, drive: 6, lp: 4200, gain: 0.42 },
    distgtr:   { ks: true, bright: 0.8, decay: 0.9992, drive: 28, lp: 3800, gain: 0.34 },
    mutegtr:   { ks: true, bright: 0.35, decay: 0.982, drive: 18, lp: 1600, gain: 0.42, short: true },
    acoustic:  { ks: true, bright: 0.95, decay: 0.997, drive: 0, lp: 7500, gain: 0.5, body: true },
    bassgtr:   { ks: true, bright: 0.4, decay: 0.998, drive: 0, lp: 1800, gain: 0.7, oct: -1 },
    voice:  { osc: ['sawtooth'], detune: 0, filter: 3000, fenv: 0, q: 0.5, a: 0.03, d: 0.1, s: 0.85, r: 0.12, oct: 0, gain: 0.3 },   // played by voiceNote() (formants), entry kept so the name validates
  };

  // Guide voice: a buzzy source through three vowel formants, with gentle vibrato and a breath of noise on the
  // consonant. Sings the vowel of each lyric syllable in tune (it does not pronounce words — that needs a real
  // singing-synthesis model).
  const FORMANTS = { a: [[800, 1], [1150, 0.5], [2900, 0.25]], e: [[530, 1], [1840, 0.45], [2480, 0.2]], i: [[300, 1], [2300, 0.35], [3000, 0.25]], o: [[500, 1], [850, 0.6], [2800, 0.15]], u: [[330, 1], [750, 0.4], [2550, 0.1]] };
  function vowelOf(syl) { const B = typeof global.BPMelody !== 'undefined' ? global.BPMelody : null; return B ? B.vowelOf(syl) : 'a'; }
  function voiceNote(ctx, out, note, vel, when, dur, opts = {}) {
    const f0 = noteHz(note); const vw = FORMANTS[vowelOf(opts.syl)] || FORMANTS.a;
    const src = ctx.createOscillator(); src.type = 'sawtooth'; src.frequency.value = f0;
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2; const vibG = ctx.createGain(); vibG.gain.value = 0; vib.connect(vibG); vibG.connect(src.frequency);
    vibG.gain.setValueAtTime(0, when); vibG.gain.linearRampToValueAtTime(f0 * 0.012, when + Math.min(0.5, (dur || 0.5) * 0.6));
    const vca = ctx.createGain(); vca.gain.value = 0; vca.connect(out);
    const pre = ctx.createGain(); pre.gain.value = 0.9; src.connect(pre);
    for (const [f, g] of vw) { const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = f / 90; const gg = ctx.createGain(); gg.gain.value = g * 2.2; pre.connect(bp); bp.connect(gg); gg.connect(vca); }
    const nodes = [src, vib];
    if (/^[^aeiouy]/i.test(String(opts.syl || ''))) {   // consonant onset: a short breath of filtered noise
      const nz = ctx.createBufferSource(); nz.buffer = noiseBuffer(ctx); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = /^[sz]|^sh|^ch|^f/i.test(opts.syl) ? 4000 : 1800; const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, when); ng.gain.linearRampToValueAtTime(0.08 * vel, when + 0.008); ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      nz.connect(hp); hp.connect(ng); ng.connect(out); nz.start(when); nz.stop(when + 0.08); nodes.push(nz);
    }
    const peak = 0.32 * (0.5 + 0.5 * vel);
    vca.gain.setValueAtTime(0.0001, when); vca.gain.linearRampToValueAtTime(peak, when + 0.035); vca.gain.setTargetAtTime(peak * 0.85, when + 0.035, 0.08);
    src.start(when); vib.start(when);
    const release = (t) => { if (vca.gain.cancelAndHoldAtTime) vca.gain.cancelAndHoldAtTime(t); else vca.gain.cancelScheduledValues(t); vca.gain.setTargetAtTime(0.0001, t, 0.04); for (const o of [src, vib]) { try { o.stop(t + 0.3); } catch (_) {} } };
    if (dur != null) release(when + Math.max(0.03, dur));
    return { stop: release, nodes };
  }

  // ---- plucked-string guitar (Karplus-Strong): a noise burst through a tuned, slightly lossy delay line ----
  const ksCache = new Map();
  function ksBuffer(ctx, note, p, len) {
    const key = `${ctx.sampleRate}|${note}|${p.bright}|${p.decay}|${Math.ceil(len * 4)}`; if (ksCache.has(key)) return ksCache.get(key);
    const sr = ctx.sampleRate, f = noteHz(note), N = sr / f, n = Math.max(1, Math.ceil(Math.min(6, len) * sr));
    const y = new Float32Array(n); const Ni = Math.floor(N), fr = N - Ni;
    let lp = 0; const k = 1 - p.bright * 0.9;   // darker pick = lowpassed excitation
    for (let i = 0; i < Math.min(n, Ni + 2); i++) { const w = Math.random() * 2 - 1; lp = lp * k + w * (1 - k); y[i] = lp; }
    for (let i = Ni + 2; i < n; i++) { const a = y[i - Ni] * (1 - fr) + y[i - Ni - 1] * fr, b = y[i - Ni - 1] * (1 - fr) + y[i - Ni - 2] * fr; y[i] = p.decay * 0.5 * (a + b); }
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(y[i])); if (mx > 0) for (let i = 0; i < n; i++) y[i] /= mx;
    const buf = ctx.createBuffer(1, n, sr); buf.copyToChannel(y, 0);
    if (ksCache.size > 400) ksCache.delete(ksCache.keys().next().value); ksCache.set(key, buf); return buf;
  }
  // one amp per output: the notes of a chord distort TOGETHER (that's what makes a power chord sound like one)
  const ampFor = new WeakMap();
  function guitarAmp(ctx, out, p) {
    let m = ampFor.get(out); if (!m) { m = new Map(); ampFor.set(out, m); }
    const id = `${p.drive}|${p.lp}|${!!p.body}`; if (m.has(id)) return m.get(id);
    const input = ctx.createGain(); let node = input;
    if (p.drive) { const pre = ctx.createGain(); pre.gain.value = p.drive; const sh = ctx.createWaveShaper(); const c = new Float32Array(2048); for (let i = 0; i < 2048; i++) { const x = i / 1023.5 - 1; c[i] = Math.tanh(x * 2.2); } sh.curve = c; sh.oversample = '2x'; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1600; mid.gain.value = 3; mid.Q.value = 0.8; const post = ctx.createGain(); post.gain.value = 0.55; node.connect(hp); hp.connect(pre); pre.connect(sh); sh.connect(mid); mid.connect(post); node = post; }
    if (p.body) { const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 210; bp.gain.value = 5; bp.Q.value = 1.2; node.connect(bp); node = bp; }
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = p.lp; lp.Q.value = 0.7; node.connect(lp); lp.connect(out);
    m.set(id, input); return input;
  }
  function guitarNote(ctx, out, p, note, vel, when, dur) {
    const n0 = note + 12 * (p.oct || 0); const len = (dur == null ? 2 : dur) + 0.4;
    const src = ctx.createBufferSource(); src.buffer = ksBuffer(ctx, n0, p, Math.min(6, p.short ? Math.min(len, 0.35) : len));
    const vca = ctx.createGain(); const peak = p.gain * (0.35 + 0.65 * vel);
    vca.gain.setValueAtTime(peak, when); src.connect(vca); vca.connect(guitarAmp(ctx, out, p)); src.start(when);
    const release = (t) => { if (vca.gain.cancelAndHoldAtTime) vca.gain.cancelAndHoldAtTime(t); else vca.gain.cancelScheduledValues(t); vca.gain.setTargetAtTime(0.0001, t, p.short ? 0.02 : 0.06); try { src.stop(t + 0.4); } catch (_) {} };
    if (dur != null) release(when + Math.max(0.02, dur));
    return { stop: release, nodes: [src] };
  }

  // Schedules one note. Returns { stop(when) } so live playing can release early.
  function synthNote(ctx, out, name, note, vel, when, dur, opts) {
    if (name === 'voice') return voiceNote(ctx, out, note, vel, when, dur, opts || {});
    const p = SYNTHS[name] || SYNTHS.saw;
    if (p.ks) return guitarNote(ctx, out, p, note, vel, when, dur);
    const f0 = noteHz(note + 12 * (p.oct || 0));
    const vca = ctx.createGain(); vca.gain.value = 0;
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = p.q;
    flt.connect(vca); vca.connect(out);
    const oscs = [];
    p.osc.forEach((type, i) => {
      const o = ctx.createOscillator(); o.type = type;
      let f = f0;
      if (p.drawbars) f = f0 * [1, 2, 3][i];
      else if (p.harm && i === 1) f = f0 * p.harm;
      o.frequency.value = f;
      o.detune.value = (i === 0 ? -1 : 1) * (p.detune || 0) * (i === 2 ? 0 : 1);
      const og = ctx.createGain(); og.gain.value = (p.drawbars ? [1, 0.5, 0.25][i] : (p.harm && i === 1 ? 0.3 : 1)) / p.osc.length;
      o.connect(og); og.connect(flt); o.start(when); oscs.push(o);
    });
    const peak = p.gain * (0.4 + 0.6 * vel);
    const sus = Math.max(0.0001, peak * p.s);
    vca.gain.setValueAtTime(0.0001, when);
    vca.gain.linearRampToValueAtTime(peak, when + p.a);
    vca.gain.setTargetAtTime(sus, when + p.a, p.d / 3);
    flt.frequency.setValueAtTime(p.filter + p.fenv * vel, when);
    flt.frequency.setTargetAtTime(p.filter, when + p.a, (p.d + 0.05) / 3);
    const release = (t) => {
      if (vca.gain.cancelAndHoldAtTime) vca.gain.cancelAndHoldAtTime(t); else vca.gain.cancelScheduledValues(t);
      vca.gain.setTargetAtTime(0.0001, t, p.r / 3);
      for (const o of oscs) { try { o.stop(t + p.r * 2 + 0.1); } catch (_) {} }
    };
    if (dur != null) release(when + Math.max(0.01, dur));
    return { stop: release, nodes: oscs };
  }

  global.BPSynth = { ampCurve, cabIR, drumHit, drumEvents, synthNote, KITS, SYNTHS, noteHz, dbToGain };
})(window);
