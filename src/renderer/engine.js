// Cobander audio engine: Web Audio graph, transport, recording, metering, offline bounce
// and numeric analysis. The engine never touches disk; app.js hands it buffers.
(function (global) {
  'use strict';

  const dbToGain = (db) => (db <= -90 ? 0 : Math.pow(10, db / 20));
  const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
  const num = (x, dflt) => { const n = typeof x === 'string' ? Number(x.replace(/[−–]/g, '-')) : Number(x); return Number.isFinite(n) ? n : dflt; };
  const clamp = (x, lo, hi, dflt = lo) => { const n = num(x, dflt); return Math.min(hi, Math.max(lo, n)); };
  const SCHEDULE_AHEAD = 0.05;   // seconds between "now" and the first scheduled sample
  const GEN_WINDOW = 8;          // seconds of drum/synth content scheduled ahead during live playback

  const DEFAULT_FX = () => ({
    gate: { on: false, threshold: -50 },
    amp: { on: false, model: 'clean', gain: 3, bass: 0, mid: 0, treble: 0, presence: 0, cab: '212', level: 0 },
    hpf: { on: false, hz: 80 },
    lpf: { on: false, hz: 4000 },   // low-pass: takes the click / fret noise off a bass DI, tames fizz
    eq: { on: false, low: { hz: 120, db: 0 }, mid: { hz: 1000, db: 0, q: 1.0 }, high: { hz: 8000, db: 0 } },
    comp: { on: false, threshold: -18, ratio: 3, attack: 0.01, release: 0.2, knee: 6, makeup: 0 },
    delay: { on: false, time: 0.25, feedback: 0.3, mix: 0.2, sync: true },
    reverbSend: 0,
  });
  const AMP_MODELS = ['clean', 'crunch', 'lead', 'highgain', 'fuzz', 'bass', 'bassdrive'];
  const CABS = ['412', '212', '112', '810', '115', 'none'];
  const TRACK_TYPES = ['guitar', 'bass', 'vocals', 'drums', 'keys', 'other'];
  const audioId = (c) => c.src || c.id;
  const DRUM_VOICE = { 35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 40: 'snare', 42: 'hat', 44: 'hat', 46: 'ohat', 51: 'ohat', 53: 'ohat', 59: 'ohat', 41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash' };
  const DEFAULT_DRUM = () => ({ kit: 'rock', pattern: 'Rock 4/4', custom: null, swing: 0, bars: 0, offsetBars: 0, gainDb: 0 });

  const DEFAULT_MASTER = () => ({ gainDb: 0, limiter: true, reverb: { decay: 1.8, preDelay: 0.02, damp: 6000 } });
  // Safety limiter on the master: fast brick-wall-ish compressor so stacked presets cannot clip the output.
  function makeLimiter(ctx) { const l = ctx.createDynamicsCompressor(); l.threshold.value = -1; l.knee.value = 0; l.ratio.value = 20; l.attack.value = 0.001; l.release.value = 0.08; return l; }

  function normalizeMaster(m) {
    const d = DEFAULT_MASTER(); const src = m || {}; const r = src.reverb || {};
    return {
      gainDb: clamp(src.gainDb, -60, 12, 0),
      limiter: src.limiter !== false,
      reverb: { decay: clamp(r.decay, 0.2, 8, d.reverb.decay), preDelay: clamp(r.preDelay, 0, 0.2, d.reverb.preDelay), damp: clamp(r.damp, 500, 20000, d.reverb.damp) },
    };
  }

  // Whitelists every field so junk from a hand-edited song.json or an API call never lands in the graph.
  function normalizeTrack(t) {
    const d = DEFAULT_FX();
    const src = t.fx || {};
    const eq = src.eq || {};
    const cp = src.comp || {};
    const am = src.amp || {};
    const dl = src.delay || {};
    const gt = src.gate || {};
    const instrument = typeof t.instrument === 'string' && (t.instrument === 'audio' || t.instrument === 'drumkit' || (/^synth:[a-z]+$/.test(t.instrument) && global.BPSynth.SYNTHS[t.instrument.slice(6)])) ? t.instrument : 'audio';
    const dd = DEFAULT_DRUM(); const dr = t.drum || {};
    const custom = dr.custom && typeof dr.custom === 'object' ? Object.fromEntries(['kick', 'snare', 'hat', 'ohat', 'tom', 'crash'].filter((k) => Array.isArray(dr.custom[k])).map((k) => [k, Array.from({ length: 16 }, (_, i) => [0, 1, 2].includes(dr.custom[k][i]) ? dr.custom[k][i] : 0)])) : null;
    return {
      id: String(t.id),
      name: String(t.name || 'Track').slice(0, 60),
      color: /^#[0-9a-fA-F]{6}$/.test(t.color || '') ? t.color : '#5b8def',
      type: TRACK_TYPES.includes(t.type) ? t.type : 'other',
      typeSet: !!t.typeSet,   // someone picked the type by hand: never re-guessed from the name
      preset: t.preset ? String(t.preset).slice(0, 60) : null,
      instrument,
      drum: instrument === 'drumkit' ? { kit: global.BPSynth.KITS[dr.kit] ? dr.kit : dd.kit, pattern: global.BPPresets.DRUM_PATTERNS[dr.pattern] ? dr.pattern : dd.pattern, custom, swing: clamp(dr.swing, 0, 1, 0), bars: Math.round(clamp(dr.bars, 0, 1024, 0)), offsetBars: Math.round(clamp(dr.offsetBars, 0, 1024, 0)), gainDb: clamp(dr.gainDb, -60, 12, 0) } : undefined,
      gainDb: clamp(t.gainDb, -60, 12, 0),
      pan: clamp(t.pan, -1, 1, 0),
      mute: !!t.mute,
      solo: !!t.solo,
      fx: {
        gate: { on: !!gt.on, threshold: clamp(gt.threshold, -90, 0, -50) },
        amp: { on: !!am.on, model: AMP_MODELS.includes(am.model) ? am.model : 'clean', gain: clamp(am.gain, 0, 10, 3), bass: clamp(am.bass, -8, 8, 0), mid: clamp(am.mid, -8, 8, 0), treble: clamp(am.treble, -8, 8, 0), presence: clamp(am.presence, -8, 8, 0), cab: CABS.includes(String(am.cab)) ? String(am.cab) : '212', level: clamp(am.level, -24, 12, 0) },
        hpf: { on: !!(src.hpf && src.hpf.on), hz: clamp(src.hpf && src.hpf.hz, 20, 1000, d.hpf.hz) },
        lpf: { on: !!(src.lpf && src.lpf.on), hz: clamp(src.lpf && src.lpf.hz, 500, 20000, d.lpf.hz) },
        eq: {
          on: !!eq.on,
          low: { hz: clamp(eq.low && eq.low.hz, 30, 500, d.eq.low.hz), db: clamp(eq.low && eq.low.db, -18, 18, 0) },
          mid: { hz: clamp(eq.mid && eq.mid.hz, 100, 10000, d.eq.mid.hz), db: clamp(eq.mid && eq.mid.db, -18, 18, 0), q: clamp(eq.mid && eq.mid.q, 0.2, 10, 1) },
          high: { hz: clamp(eq.high && eq.high.hz, 1500, 16000, d.eq.high.hz), db: clamp(eq.high && eq.high.db, -18, 18, 0) },
        },
        comp: {
          on: !!cp.on, threshold: clamp(cp.threshold, -60, 0, d.comp.threshold), ratio: clamp(cp.ratio, 1, 20, d.comp.ratio),
          attack: clamp(cp.attack, 0.001, 1, d.comp.attack), release: clamp(cp.release, 0.01, 2, d.comp.release),
          knee: clamp(cp.knee, 0, 40, d.comp.knee), makeup: clamp(cp.makeup, 0, 24, 0),
        },
        delay: { on: !!dl.on, time: clamp(dl.time, 0.01, 4, 0.5), feedback: clamp(dl.feedback, 0, 0.9, 0.3), mix: clamp(dl.mix, 0, 1, 0.2), sync: dl.sync !== false },
        reverbSend: clamp(src.reverbSend, 0, 1, 0),
      },
      clips: (Array.isArray(t.clips) ? t.clips : []).filter((c) => c && /^[a-f0-9]{12}$/.test(String(c.id))).map((c) => {
        const kind = c.kind === 'midi' ? 'midi' : 'audio';
        const duration = clamp(c.duration, 0, 1e6, 0);
        const trimStart = clamp(c.trimStart, 0, 1e6, 0);
        const trimEnd = clamp(c.trimEnd, 0, Math.max(0, duration - trimStart - 0.01), 0);
        const base = {
          id: c.id, kind,
          name: String(c.name || (kind === 'midi' ? 'midi' : 'take')).slice(0, 60),
          start: clamp(c.start, 0, 1e6, 0),
          gainDb: clamp(c.gainDb, -60, 12, 0),
          trimStart, trimEnd, duration,
          takenBy: c.takenBy ? String(c.takenBy).slice(0, 60) : null,
          takenAt: c.takenAt || null,
          mute: !!c.mute,   // a muted take stays in the song (and on disk) but does not play or render
          src: /^[a-f0-9]{12}$/.test(String(c.src || '')) && c.src !== c.id ? c.src : undefined,   // audio file id when several clips share one take (split / copy)
          fadeIn: Math.min(clamp(c.fadeIn, 0, 30, 0), Math.max(0, duration - trimStart - trimEnd)), fadeOut: Math.min(clamp(c.fadeOut, 0, 30, 0), Math.max(0, duration - trimStart - trimEnd)),
        };
        if (base.src === undefined) delete base.src;
        // varispeed: the original recording this clip was re-sped from (so the next tempo change renders from it, not from a copy)
        if (kind === 'audio' && c.vs && /^[a-f0-9]{12}$/.test(String(c.vs.src || '')) && Number.isFinite(Number(c.vs.bpm))) base.vs = { src: c.vs.src, bpm: clamp(c.vs.bpm, 30, 300, 120) };
        // transposed take: the untransposed source (and its tempo origin) so a transpose back returns to the original file
        if (kind === 'audio' && c.ps && /^[a-f0-9]{12}$/.test(String(c.ps.src || '')) && Number.isFinite(Number(c.ps.semis))) { base.ps = { src: c.ps.src, semis: Math.round(clamp(c.ps.semis, -48, 48, 0)) }; if (c.ps.vs && /^[a-f0-9]{12}$/.test(String(c.ps.vs.src || '')) && Number.isFinite(Number(c.ps.vs.bpm))) base.ps.vs = { src: c.ps.vs.src, bpm: clamp(c.ps.vs.bpm, 30, 300, 120) }; }
        // linked-section copy (regenerated from the room on every change; must survive loads or copies would pile up)
        if (c.link && typeof c.link === 'object' && c.link.from && c.link.section) base.link = { from: String(c.link.from).slice(0, 40), section: String(c.link.section).slice(0, 40) };
        // parts bin: where a dropped part came from (shown in the take's menu)
        if (kind === 'midi' && c.melody && typeof c.melody === 'object') base.melody = { text: String(c.melody.text || '').slice(0, 4000), seed: Number(c.melody.seed) >>> 0, section: c.melody.section ? String(c.melody.section).slice(0, 40) : null, voice: ['low', 'mid', 'high'].includes(c.melody.voice) ? c.melody.voice : 'mid' };
        // tightened take: the original recording it was tightened from (Undo tighten / re-tighten start from it)
        if (kind === 'audio' && c.tt && /^[a-f0-9]{12}$/.test(String(c.tt.src || ''))) base.tt = { src: c.tt.src, grid: String(c.tt.grid || '').slice(0, 20), strength: clamp(c.tt.strength, 0, 1, 0.6) };
        if (kind === 'midi' && c.qz && typeof c.qz === 'object') base.qz = { grid: String(c.qz.grid || '').slice(0, 20), strength: clamp(c.qz.strength, 0, 1, 1) };
        if (kind === 'audio' && c.pitch && typeof c.pitch === 'object') base.pitch = { ok: Math.round(clamp(c.pitch.ok, 0, 100, 100)), at: String(c.pitch.at || '').slice(0, 30) };
        if (c.part && typeof c.part === 'object') base.part = { id: String(c.part.id || '').slice(0, 40), name: String(c.part.name || '').slice(0, 60), shift: Number(c.part.shift) || 0, stretch: Number(c.part.stretch) || 1 };
        if (kind === 'midi') {
          const notes = (Array.isArray(c.notes) ? c.notes : []).map((n) => { const o = { t: clamp(n.t, 0, 1e6, 0), d: clamp(n.d, 0.01, 60, 0.25), n: Math.round(clamp(n.n, 0, 127, 60)), v: clamp(n.v, 0, 1, 0.8) }; if (typeof n.l === 'string' && n.l) o.l = n.l.slice(0, 24); if (Array.isArray(n.iv) && n.iv.length) { const iv = [...new Set(n.iv.map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x >= -24 && x <= 36))].sort((a, b) => a - b).slice(0, 8); if (iv.length > 1 || (iv.length === 1 && iv[0] !== 0)) o.iv = iv; } return o; }).sort((a, b) => a.t - b.t).slice(0, 20000);
          if (!base.duration) base.duration = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0) + 0.05;
          base.notes = notes.filter((n) => n.t <= base.duration);
        } else {
          base.channels = c.channels === 1 ? 1 : (c.channels === 2 ? 2 : undefined);
        }
        return base;
      }),
    };
  }

  // ---------- impulse response for the shared reverb ----------
  function makeImpulse(ctx, { decay = 1.8, preDelay = 0.02, damp = 6000 } = {}) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * (decay + preDelay)));
    const ir = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * preDelay);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      const a = Math.exp(-2 * Math.PI * damp / sr);
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / sr;
        const env = Math.exp(-6.9 * t / decay);
        const n = (Math.random() * 2 - 1);
        lp = a * lp + (1 - a) * n;      // one-pole lowpass darkens the tail
        d[i] = lp * env;
      }
    }
    return ir;
  }

  // Build the per-track chain in any BaseAudioContext (live or offline).
  function buildTrackChain(ctx, track, masterIn, reverbIn) {
    const input = ctx.createGain();
    // (fx.gate is stored and shown but not yet audible: Web Audio has no expander node; a worklet gate is on the list.)
    const gate = ctx.audioWorklet && ctx._bpGateReady ? new AudioWorkletNode(ctx, 'bp-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }) : null;
    const ampPre = ctx.createGain();
    const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
    const ampBass = ctx.createBiquadFilter(); ampBass.type = 'lowshelf'; ampBass.frequency.value = 150;
    const ampMid = ctx.createBiquadFilter(); ampMid.type = 'peaking'; ampMid.frequency.value = 700; ampMid.Q.value = 0.8;
    const ampTreble = ctx.createBiquadFilter(); ampTreble.type = 'highshelf'; ampTreble.frequency.value = 2500;
    const ampPres = ctx.createBiquadFilter(); ampPres.type = 'peaking'; ampPres.frequency.value = 4500; ampPres.Q.value = 0.7;
    const cab = ctx.createConvolver(); cab.normalize = false;
    const cabBypass = ctx.createGain();
    const cabWet = ctx.createGain();
    const ampLevel = ctx.createGain();
    const ampDry = ctx.createGain();     // when amp is off, input goes straight through this
    const ampOut = ctx.createGain();
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass';
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = 20000; lpf.Q.value = 0.707;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
    const high = ctx.createBiquadFilter(); high.type = 'highshelf';
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const fader = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const send = ctx.createGain();
    const dlyNode = ctx.createDelay(4.0); dlyNode.delayTime.value = 0.25; const dlyFb = ctx.createGain(); dlyFb.gain.value = 0; const dlyWet = ctx.createGain(); dlyWet.gain.value = 0; const dlyTone = ctx.createBiquadFilter(); dlyTone.type = 'lowpass'; dlyTone.frequency.value = 4000;
    const analyser = ctx.createAnalyser ? ctx.createAnalyser() : null;
    // amp path: input → pre → shaper → tone stack → (cab | bypass) → level → ampOut ; dry path: input → ampDry → ampOut
    const src0 = gate ? (input.connect(gate), gate) : input;
    src0.connect(ampPre); ampPre.connect(shaper); shaper.connect(ampBass); ampBass.connect(ampMid); ampMid.connect(ampTreble); ampTreble.connect(ampPres);
    ampPres.connect(cab); cab.connect(cabWet); cabWet.connect(ampLevel); ampPres.connect(cabBypass); cabBypass.connect(ampLevel); ampLevel.connect(ampOut);
    src0.connect(ampDry); ampDry.connect(ampOut);
    ampOut.connect(hpf); hpf.connect(lpf); lpf.connect(low); low.connect(mid); mid.connect(high); high.connect(comp); comp.connect(makeup); makeup.connect(fader);
    // delay as an insert after the compressor: makeup → delay → tone → wet → fader ; feedback loop
    makeup.connect(dlyNode); dlyNode.connect(dlyTone); dlyTone.connect(dlyWet); dlyWet.connect(fader); dlyTone.connect(dlyFb); dlyFb.connect(dlyNode);
    fader.connect(panner);
    panner.connect(masterIn);
    panner.connect(send);
    if (reverbIn) send.connect(reverbIn);
    if (analyser) { analyser.fftSize = 2048; panner.connect(analyser); }
    const chain = { input, gate, ampPre, shaper, ampBass, ampMid, ampTreble, ampPres, cab, cabBypass, cabWet, ampLevel, ampDry, ampOut, hpf, lpf, low, mid, high, comp, makeup, dlyNode, dlyFb, dlyWet, dlyTone, fader, panner, send, analyser, sources: [], cabName: null, curveKey: null };
    applyTrackParams(ctx, chain, track, false);
    return chain;
  }

  function applyTrackParams(ctx, chain, track, audible, bpm = 120) {
    const fx = track.fx;
    const t = ctx.currentTime;
    // offline contexts start at t=0: set values directly so the first 50 ms of a bounce are right
    const set = (param, v) => { param.cancelScheduledValues(t); if (t === 0) { param.setValueAtTime(v, 0); } else param.setTargetAtTime(v, t, 0.01); };
    if (chain.gate) { chain.gate.parameters.get('on').setValueAtTime(fx.gate.on ? 1 : 0, t); chain.gate.parameters.get('threshold').setValueAtTime(fx.gate.threshold, t); }
    // amp
    const a = fx.amp;
    if (a.on) {
      const ck = `${a.model}:${a.gain}`;
      if (chain.curveKey !== ck) { chain.shaper.curve = global.BPSynth.ampCurve(a.model, a.gain); chain.curveKey = ck; }
      set(chain.ampPre.gain, 1);
      set(chain.ampBass.gain, a.bass * 1.5); set(chain.ampMid.gain, a.mid * 1.5); set(chain.ampTreble.gain, a.treble * 1.5); set(chain.ampPres.gain, a.presence * 1.2);
      const useCab = a.cab !== 'none';
      if (useCab && chain.cabName !== a.cab) { chain.cab.buffer = global.BPSynth.cabIR(ctx, a.cab); chain.cabName = a.cab; }
      set(chain.cabWet.gain, useCab ? 1 : 0); set(chain.cabBypass.gain, useCab ? 0 : 1);
      // waveshaping adds level; compensate roughly by model and gain
      // measured so an amp'd track lands ~4 dB under the dry signal's RMS at the preset gains
      const comp = { clean: -5, crunch: -10, lead: -10, highgain: -11, fuzz: -9, bass: -12, bassdrive: -15 }[a.model] || 0;
      set(chain.ampLevel.gain, dbToGain(a.level + comp));
      set(chain.ampDry.gain, 0);
    } else {
      set(chain.ampDry.gain, 1); chain.ampLevel.gain.cancelScheduledValues(t); chain.ampLevel.gain.setValueAtTime(0, t);
    }
    // delay: when sync, `time` is in beats (0.5 = eighth, 0.75 = dotted eighth, 1 = quarter); else seconds
    const d = fx.delay;
    if (d.on) {
      const secs = Math.min(4, Math.max(0.01, d.sync ? d.time * (60 / bpm) : d.time));
      set(chain.dlyNode.delayTime, secs); set(chain.dlyFb.gain, d.feedback); set(chain.dlyWet.gain, d.mix);
    } else { chain.dlyWet.gain.cancelScheduledValues(t); chain.dlyWet.gain.setValueAtTime(0, t); chain.dlyFb.gain.cancelScheduledValues(t); chain.dlyFb.gain.setValueAtTime(0, t); }
    set(chain.hpf.frequency, fx.hpf.on ? fx.hpf.hz : 10);
    chain.hpf.Q.value = 0.707;
    if (chain.lpf) set(chain.lpf.frequency, fx.lpf && fx.lpf.on ? fx.lpf.hz : 20000);
    set(chain.low.frequency, fx.eq.low.hz); set(chain.low.gain, fx.eq.on ? fx.eq.low.db : 0);
    set(chain.mid.frequency, fx.eq.mid.hz); set(chain.mid.gain, fx.eq.on ? fx.eq.mid.db : 0); set(chain.mid.Q, fx.eq.mid.q);
    set(chain.high.frequency, fx.eq.high.hz); set(chain.high.gain, fx.eq.on ? fx.eq.high.db : 0);
    if (fx.comp.on) {
      set(chain.comp.threshold, fx.comp.threshold); set(chain.comp.ratio, fx.comp.ratio);
      set(chain.comp.attack, fx.comp.attack); set(chain.comp.release, fx.comp.release); set(chain.comp.knee, fx.comp.knee);
      set(chain.makeup.gain, dbToGain(fx.comp.makeup));
    } else {
      set(chain.comp.threshold, 0); set(chain.comp.ratio, 1); set(chain.comp.knee, 0); set(chain.makeup.gain, 1);
    }
    set(chain.fader.gain, audible ? dbToGain(track.gainDb) : 0);
    set(chain.panner.pan, track.pan);
    set(chain.send.gain, audible ? fx.reverbSend : 0);
  }

  class Engine {
    constructor() {
      this.ctx = null;
      this.buffers = new Map();     // clipId -> AudioBuffer
      this.tracks = [];
      this.master = DEFAULT_MASTER();
      this.audition = null;
      this.tempMute = new Set();   // karaoke: tracks silenced for practice only (never saved)
      this.chains = new Map();      // trackId -> chain
      this.playing = false;
      this.recording = null;        // { trackId, startPos, startCtxTime, chunks, node, startFrame }
      this.playhead = 0;
      this.startPos = 0;
      this.startCtxTime = 0;
      this.loop = { enabled: false, start: 0, end: 8 };
      this.bpm = 120;
      this.timeSig = [4, 4];
      this.click = { on: false, countIn: true, countInBars: 1, gainDb: -12 };
      this.monitorInput = false; this.monitorFx = true; this.monitorTrackId = null; this.outputDeviceId = null;   // live input through the armed track's amp / EQ / FX
      this.recordOffsetMs = null;
      this.offsetManual = false;    // false = follow the current output device's latency (re-measured before every take)
      this.inputDeviceId = null;
      this.listeners = new Set();
      this._clickTimer = null;
      this._raf = null;
      this._nextPass = null;        // pre-scheduled loop wrap: { at, pos }
      this._clicks = [];            // scheduled click oscillators, so stop() can silence them
      this.midi = { access: null, inputs: [], selectedId: null, held: new Map(), liveTrackId: null, ready: false };
      this._genCursor = 0;          // song position up to which generated content (drums/synth) is scheduled
      this.stream = null;
    }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(ev, data) { for (const fn of this.listeners) { try { fn(ev, data); } catch (e) { console.error(e); } } }

    async init() {
      if (this.ctx) return;
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      await this.ctx.audioWorklet.addModule('recorder-worklet.js');
      try { await this.ctx.audioWorklet.addModule('gate-worklet.js'); this.ctx._bpGateReady = true; } catch (err) { console.warn('gate worklet unavailable', err); }
      this.masterIn = this.ctx.createGain();
      this.masterGain = this.ctx.createGain();
      this.masterAnalyser = this.ctx.createAnalyser(); this.masterAnalyser.fftSize = 2048;
      this.reverbIn = this.ctx.createGain();
      this.convolver = this.ctx.createConvolver();
      this.convolver.buffer = makeImpulse(this.ctx, this.master.reverb);
      this.reverbIn.connect(this.convolver); this.convolver.connect(this.masterIn);
      this.limiter = makeLimiter(this.ctx); this.limiterBypass = this.ctx.createGain(); this.limiterOn = this.ctx.createGain();
      // analyser sits BEFORE the limiter so the clip light shows what the limiter had to catch
      this.masterIn.connect(this.masterGain); this.masterGain.connect(this.masterAnalyser);
      // listen gain: the volume knob in Practice — this computer's speakers only, never part of the saved mix
      this.listenGain = this.ctx.createGain(); this.listenGain.gain.value = this.listen === undefined ? 1 : this.listen; this.listenGain.connect(this.ctx.destination);
      this.masterAnalyser.connect(this.limiterOn); this.limiterOn.connect(this.limiter); this.limiter.connect(this.listenGain);
      this.masterAnalyser.connect(this.limiterBypass); this.limiterBypass.connect(this.listenGain);
      this.clickGain = this.ctx.createGain(); this.clickGain.connect(this.ctx.destination);
      this.monitorGain = this.ctx.createGain(); this.monitorGain.gain.value = 0; this.monitorGain.connect(this.masterIn);
      if (this.recordOffsetMs === null) this.recordOffsetMs = this.autoOffsetMs();
      if (this.wantOutput && typeof this.ctx.setSinkId === 'function') this.ctx.setSinkId(this.wantOutput).then(() => { this.outputDeviceId = this.wantOutput; if (!this.offsetManual) this.recordOffsetMs = this.autoOffsetMs(); }).catch(() => {});
    }
    autoOffsetMs() { return Math.round(((this.ctx && this.ctx.baseLatency) || 0) * 1000 + ((this.ctx && this.ctx.outputLatency) || 0) * 1000); }
    inputAlive() { const tr = this.stream && this.stream.getAudioTracks()[0]; return !!(this.recNode && tr && tr.readyState === 'live'); }
    // Let go of the mic (AirPods drop out of phone-quality headset mode, the mic indicator goes off). Reopened on demand.
    closeInput() {
      if (this.recording) return false;
      if (this.stream) { for (const tr of this.stream.getTracks()) { tr.onended = null; tr.stop(); } this.stream = null; }
      for (const n of [this.inputSource, this.recNode]) if (n) { try { n.disconnect(); } catch (_) {} }
      this.inputSource = null; this.recNode = null; this.inputAnalyser = null;
      return true;
    }

    async resume() { if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume(); }

    // ---------- song state ----------
    // Loads song fields. Keeps the playhead where it is and only stops playback if it
    // was running (a bandmate saving a mix change should not yank your transport).
    loadSong(song) {
      const wasPlaying = this.playing && !this.recording;
      const pos = this.currentPos();
      if (this.playing) this.stop();
      this.bpm = clamp(song.bpm, 30, 300, 120);
      this.timeSig = validTimeSig(song.timeSig);
      const lp = song.loop || {};
      this.loop = { enabled: !!lp.enabled, start: clamp(lp.start, 0, 1e6, 0), end: clamp(lp.end, 0, 1e6, this.beatLen() * this.timeSig[0] * 4) };   // default loop: bars 1–4 at this tempo
      if (this.loop.end <= this.loop.start) this.loop.end = this.loop.start + this.beatLen() * this.timeSig[0];
      this.master = normalizeMaster(song.master);
      this.tracks = (song.tracks || []).map(normalizeTrack);
      this.rebuildGraph();
      if (this.ctx) this.convolver.buffer = makeImpulse(this.ctx, this.master.reverb);
      this.playhead = Math.min(pos, this.songLength() + 1);
      this.emit('song', null);
      if (wasPlaying) this.play();
    }

    rebuildGraph() {
      for (const ch of this.chains.values()) this.disconnectChain(ch);
      this.chains.clear();
      if (!this.ctx) return;
      for (const t of this.tracks) this.chains.set(t.id, buildTrackChain(this.ctx, t, this.masterIn, this.reverbIn));
      this._routeMonitor();
      this.applyAll();
    }

    disconnectChain(ch) {
      for (const s of ch.sources) { try { s.stop(); } catch (_) {} }
      ch.sources = [];
      for (const k of ['input', 'gate', 'ampPre', 'shaper', 'ampBass', 'ampMid', 'ampTreble', 'ampPres', 'cab', 'cabBypass', 'cabWet', 'ampLevel', 'ampDry', 'ampOut', 'hpf', 'lpf', 'low', 'mid', 'high', 'comp', 'makeup', 'dlyNode', 'dlyFb', 'dlyWet', 'dlyTone', 'fader', 'panner', 'send', 'analyser']) { try { ch[k] && ch[k].disconnect(); } catch (_) {} }
    }

    anySolo() { return this.tracks.some((t) => t.solo); }
    audible(t) { return !t.mute && !(this.tempMute && this.tempMute.has(t.id)) && (!this.anySolo() || t.solo); }

    applyAll() {
      if (!this.ctx) return;
      for (const t of this.tracks) {
        const ch = this.chains.get(t.id);
        if (ch) applyTrackParams(this.ctx, ch, t, this.audible(t), this.bpm);
      }
      this.masterGain.gain.setTargetAtTime(dbToGain(this.master.gainDb), this.ctx.currentTime, 0.01);
      if (this.limiterOn) { this.limiterOn.gain.setTargetAtTime(this.master.limiter ? 1 : 0, this.ctx.currentTime, 0.01); this.limiterBypass.gain.setTargetAtTime(this.master.limiter ? 0 : 1, this.ctx.currentTime, 0.01); }
      this.clickGain.gain.value = dbToGain(clamp(this.click.gainDb, -60, 0, -12));
    }

    setListen(v) { this.listen = Math.max(0, Math.min(1, Number(v))); if (this.listenGain) this.listenGain.gain.setTargetAtTime(this.listen * this.listen, this.ctx.currentTime, 0.02); }   /* squared: the slider feels linear */
    setMaster(patch) {
      const merged = { ...this.master, ...patch, reverb: { ...this.master.reverb, ...(patch.reverb || {}) } };
      const prevReverb = JSON.stringify(this.master.reverb);
      this.master = normalizeMaster(merged);
      if (this.ctx && JSON.stringify(this.master.reverb) !== prevReverb) this.convolver.buffer = makeImpulse(this.ctx, this.master.reverb);
      this.applyAll();
      return this.master;
    }

    track(id) { return this.tracks.find((t) => t.id === id); }
    // Playback-only mute override for "Listen to this take" — never written to the song.
    clipMuted(c) { const a = this.audition; if (a) { if (a.unmute.has(c.id)) return false; if (a.mute.has(c.id)) return true; } return !!c.mute; }

    addTrack(name, color) {
      const palette = ['#5b8def', '#e06c75', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66'];
      const t = normalizeTrack({ id: global.BPUtil.newId(), name: name || `Track ${this.tracks.length + 1}`, color: color || palette[this.tracks.length % palette.length] });
      this.tracks.push(t);
      if (this.ctx) { this.chains.set(t.id, buildTrackChain(this.ctx, t, this.masterIn, this.reverbIn)); this._routeMonitor(); }
      this.applyAll();
      return t;
    }

    // a bandmate's version of one track (track locks): swap it in place (same object, new contents) or add it
    replaceTrack(tj, index = null) {
      const n = normalizeTrack(JSON.parse(JSON.stringify(tj)));
      const cur = this.track(n.id);
      if (cur) { Object.assign(cur, n); const ch = this.chains.get(n.id); if (ch) { this.disconnectChain(ch); this.chains.delete(n.id); } }
      else { if (index != null && index >= 0 && index <= this.tracks.length) this.tracks.splice(index, 0, n); else this.tracks.push(n); }
      if (this.ctx) { this.chains.set(n.id, buildTrackChain(this.ctx, this.track(n.id), this.masterIn, this.reverbIn)); this._routeMonitor(); }
      this.applyAll(); this.refreshTrack(n.id);
      return this.track(n.id);
    }

    removeTrack(id) {
      const ch = this.chains.get(id);
      if (ch) { this.disconnectChain(ch); this.chains.delete(id); }
      this.tracks = this.tracks.filter((t) => t.id !== id); this._routeMonitor();
      this.applyAll();
    }

    updateTrack(id, patch) {
      const t = this.track(id);
      if (!t) throw new Error(`no track ${id}`);
      const merged = { ...t, ...patch, fx: patch.fx ? deepMerge(t.fx, patch.fx) : t.fx, clips: patch.clips || t.clips };
      const prevClips = t.clips;
      Object.assign(t, normalizeTrack(merged));
      if (!patch.clips) t.clips = prevClips;   // keep clip object identity: the UI holds references
      this.applyAll();
      return t;
    }

    toSongFields() {
      return {
        bpm: this.bpm, timeSig: this.timeSig, loop: { ...this.loop }, master: JSON.parse(JSON.stringify(this.master)),
        sampleRate: this.ctx ? this.ctx.sampleRate : 48000,
        tracks: this.tracks.map((t) => ({ ...t, fx: JSON.parse(JSON.stringify(t.fx)), clips: t.clips.map((c) => ({ ...c })) })),
      };
    }

    songLength() {
      let end = 0;
      for (const t of this.tracks) for (const c of t.clips) end = Math.max(end, c.start + this.clipLength(c));
      return end;
    }

    clipLength(c) {
      const b = this.buffers.get(audioId(c));
      const full = b ? b.duration : (c.duration || 0);
      return Math.max(0, full - c.trimStart - c.trimEnd);
    }

    beatLen() { return 60 / this.bpm; }
    // the tempo map (parts can have their own tempo / time signature); falls back to the song's one tempo
    setMeter(map) { this.meter = map || null; }
    meterMap() { const M = global.BPMeter; if (!M) return null; if (this.meter && this.meter.bpm === this.bpm && JSON.stringify(this.meter.ts) === JSON.stringify(validTimeSig(this.timeSig))) return this.meter; return M.build({ bpm: this.bpm, timeSig: this.timeSig, sections: (this.meter && this.meter.sections) || [] }); }

    // ---------- transport ----------
    play(from) {
      if (!this.ctx) return;
      if (this.recording) return;                 // play/seek while recording would desync the take
      if (this.playing) this._stopInternal();
      this.resume();
      if (typeof from === 'number') this.playhead = Math.max(0, num(from, 0));
      if (this.loop.enabled && (this.playhead < this.loop.start || this.playhead >= this.loop.end)) this.playhead = this.loop.start;
      this.startPos = this.playhead;
      this.startCtxTime = this.ctx.currentTime + SCHEDULE_AHEAD;
      this._startPass(this.startPos, this.startCtxTime);
      this.playing = true;
      this.tick();
      this.emit('transport', this.transportState());
    }

    // Schedules clips (and click) for one pass starting at song position `fromPos` at
    // context time `atCtxTime`. With loop on, the pass ends at loop.end and the next pass
    // is pre-scheduled from tick() so there is no gap at the wrap.
    _startPass(fromPos, atCtxTime) {
      const until = this.loop.enabled && !this.recording ? this.loop.end : Infinity;
      this.scheduleClips(fromPos, atCtxTime, until);
      if (this.click.on) this.startClick(fromPos, atCtxTime, until);
      this._nextPass = null;
    }

    scheduleClips(fromPos, atCtxTime, until = Infinity) {
      this._scheduleInto(this.ctx, (id) => this.chains.get(id), fromPos, atCtxTime, until, (ch, src) => ch.sources.push(src), null, GEN_WINDOW);
    }
    // Notes on a MIDI / drum track changed while playing (note editor, drum editor): re-schedule just that track for
    // what's left of the current window, so edits are heard right away instead of on the next loop pass.
    refreshTrack(trackId) {
      if (!this.playing || !this.ctx) return;
      const t = this.track(trackId); const ch = t && this.chains.get(t.id); if (!ch || t.instrument === 'audio') return;
      const now = this.ctx.currentTime; for (const src of ch.sources) { try { src.stop(now + 0.005); } catch (_) {} } ch.sources = [];
      const pos = this.currentPos(); const passEnd = this.loop.enabled && (!this.recording || this.recording.loopRec) ? this.loop.end : Infinity;
      const until = Math.min(passEnd, Number.isFinite(this._genCursor) ? this._genCursor : pos + GEN_WINDOW);
      if (until <= pos) return;
      this._scheduleInto(this.ctx, (id) => this.chains.get(id), pos + 0.01, now + 0.01, until, (c, src) => c.sources.push(src), t.id, null, false);
    }
    // Called from tick(): schedule the next window of drums/synth notes for the current pass.
    _extendGenerated() {
      if (!this.playing) return;
      const pos = this.currentPos();
      const passEnd = this.loop.enabled && (!this.recording || this.recording.loopRec) ? this.loop.end : Infinity;
      if (this._genCursor >= passEnd || this._genCursor - pos > GEN_WINDOW / 2) return;
      // when recording, there is no end: keep the beat going for as long as the take runs
      const from = this._genCursor; const at = this.startCtxTime + (from - this.startPos);
      this._scheduleInto(this.ctx, (id) => this.chains.get(id), from, at, passEnd, (ch, src) => ch.sources.push(src), null, GEN_WINDOW, true);
    }

    // Shared by live playback and offline render. `getChain(trackId)` → chain; `track(src)` registers a stoppable source.
    _scheduleInto(ctx, getChain, fromPos, atCtxTime, until, track, onlyTrackId = null, genWindow = null, generatedOnly = false) {
      const S = global.BPSynth;
      // generated content (drums / synth notes) is scheduled only within [fromPos, genEnd); live playback
      // extends it from tick() in windows so a 5-minute song does not create every node up front
      const genEnd = genWindow != null ? Math.min(until, fromPos + genWindow) : until;
      const horizon = Number.isFinite(genEnd) ? genEnd : Math.max(this.contentLength() || this.beatLen() * this.timeSig[0] * 16, fromPos) + 0.01;
      if (genWindow != null) this._genCursor = Number.isFinite(genEnd) ? genEnd : horizon;
      for (const t of this.tracks) {
        if (onlyTrackId && t.id !== onlyTrackId) continue;
        const ch = getChain(t.id);
        if (!ch) continue;
        // drum machine
        if (t.instrument === 'drumkit' && t.drum) {
          if (!generatedOnly || true) { /* drums are generated content */ }
          const g = ctx.createGain(); g.gain.value = dbToGain(t.drum.gainDb); g.connect(ch.input);
          const end = Number.isFinite(genEnd) ? genEnd : (t.drum.bars ? Infinity : horizon);
          // a drum PART (MIDI clip on this track) replaces the groove where it sits
          const parts = t.clips.filter((c) => c.kind === 'midi' && !this.clipMuted(c)).map((c) => [c.start, c.start + this.clipLength(c)]);
          const map = this.meterMap(); const evs = [];
          if (!map || map.uniform) evs.push(...S.drumEvents(t.drum, global.BPPresets.DRUM_PATTERNS, this.bpm, this.timeSig, fromPos, end));
          else {
           const M = global.BPMeter; const w0 = M.secAtBar(map, t.drum.offsetBars || 0), w1 = t.drum.bars ? M.secAtBar(map, (t.drum.offsetBars || 0) + t.drum.bars) : Infinity;   // a fixed-length drum machine: its bars counted through the tempo map
           for (const sg of map.segs) {   // each part plays the groove in its own tempo / meter, starting on its own bar 1
            const lo = Math.max(fromPos, sg.t0, w0), hi = Math.min(end, sg.t1, w1); if (hi <= lo) continue;
            const a = lo - sg.t0, b = hi - sg.t0;
            for (const ev of S.drumEvents({ ...t.drum, offsetBars: 0, bars: 0 }, global.BPPresets.DRUM_PATTERNS, sg.bpm, sg.ts, a, b)) evs.push({ ...ev, t: ev.t + sg.t0 });
           }
          }
          for (const ev of evs) {
            if (parts.length && parts.some(([a, b]) => ev.t >= a - 1e-6 && ev.t < b - 1e-6)) continue;
            for (const n of S.drumHit(ctx, g, t.drum.kit, ev.voice, atCtxTime + (ev.t - fromPos), ev.vel)) { n.onended = () => { n._ended = true; }; track(ch, n); }
          }
        }
        for (const c of t.clips) {
          if (this.clipMuted(c)) continue;
          if (c.kind === 'midi' && t.instrument === 'drumkit') {   // drum part: GM notes → the kit
            const g = ctx.createGain(); g.gain.value = dbToGain((t.drum && t.drum.gainDb) || 0) * dbToGain(c.gainDb || 0); g.connect(ch.input);
            const len = this.clipLength(c); const clipEnd = c.start + len;
            if (clipEnd <= fromPos || c.start >= genEnd) continue;
            for (const n of c.notes) {
              const abs = c.start + n.t - c.trimStart; if (n.t < c.trimStart || abs < fromPos || abs >= clipEnd || abs >= genEnd) continue;
              if (generatedOnly && abs < fromPos) continue;
              const voice = DRUM_VOICE[Math.round(n.n)]; if (!voice) continue;
              for (const o of S.drumHit(ctx, g, (t.drum && t.drum.kit) || 'rock', voice, atCtxTime + (abs - fromPos), n.v == null ? 0.8 : n.v)) { o.onended = () => { o._ended = true; }; track(ch, o); }
            }
            continue;
          }
          if (c.kind === 'midi') {
            if (!t.instrument.startsWith('synth:')) continue;
            const synth = t.instrument.slice(6);
            const g = ctx.createGain(); g.gain.value = dbToGain(c.gainDb); g.connect(ch.input);
            const len = this.clipLength(c); const clipEnd = c.start + len;
            if (clipEnd <= fromPos || c.start >= genEnd) continue;
            for (const n of c.notes) {
              const abs = c.start + n.t - c.trimStart;
              if (generatedOnly && abs < fromPos) continue;   // window extension: a note already sounding must not re-trigger
              if (n.t < c.trimStart || abs >= clipEnd || abs >= genEnd) continue;
              if (abs + n.d <= fromPos) continue;
              const when = atCtxTime + Math.max(0, abs - fromPos);
              const dur = Math.min(n.d - Math.max(0, fromPos - abs), clipEnd - Math.max(abs, fromPos), (Number.isFinite(until) ? until : Infinity) - Math.max(abs, fromPos));
              if (dur <= 0) continue;
              for (const iv of (Array.isArray(n.iv) && n.iv.length ? n.iv : [0])) {   // a chord note: root + its intervals
                const v = S.synthNote(ctx, g, synth, Math.max(0, Math.min(127, n.n + iv)), n.v * (iv ? 0.85 : 1), when, dur, n.l ? { syl: n.l } : undefined);
                for (const o of v.nodes) { o.onended = () => { o._ended = true; }; track(ch, o); }
              }
            }
            continue;
          }
          if (generatedOnly) continue;        // audio clips were scheduled in full at play()
          const buf = this.buffers.get((this.previewSrc && this.previewSrc.get(c.id)) || audioId(c));   // previewSrc: a playback-only stand-in (tighten preview), never saved
          if (!buf) continue;
          const len = this.clipLength(c);
          const clipEnd = c.start + len;
          if (clipEnd <= fromPos || c.start >= until) continue;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const g = ctx.createGain(); g.gain.value = dbToGain(c.gainDb);
          src.connect(g); g.connect(ch.input);
          let offset = c.trimStart, when = atCtxTime + (c.start - fromPos), dur = len;
          if (c.start < fromPos) { offset += fromPos - c.start; when = atCtxTime; dur = clipEnd - fromPos; }
          if (Number.isFinite(until)) dur = Math.min(dur, until - Math.max(c.start, fromPos));
          if (dur <= 0) continue;
          // fades (linear), expressed in clip-relative seconds; handle starting mid-clip and loop-pass truncation
          const posIn = offset - c.trimStart;           // where in the clip playback begins
          if (c.fadeIn > 0 || c.fadeOut > 0) {
            // one piecewise-linear envelope: full · min(1, t/fadeIn) · min(1, (len−t)/fadeOut), sampled at every breakpoint
            const full = dbToGain(c.gainDb); const fi = Math.min(c.fadeIn, len), fo = Math.min(c.fadeOut, len);
            const env = (tt) => full * (fi > 0 ? Math.min(1, tt / fi) : 1) * (fo > 0 ? Math.min(1, (len - tt) / fo) : 1);
            const pts = [posIn, fi, len - fo, posIn + dur, len].filter((tt) => tt >= posIn && tt <= posIn + dur + 1e-6).sort((x, y) => x - y);
            g.gain.setValueAtTime(Math.max(0.0001, env(pts[0])), when);
            for (const tt of pts.slice(1)) g.gain.linearRampToValueAtTime(Math.max(0.0001, env(tt)), when + (tt - posIn));
          }
          src.onended = () => { src._ended = true; };
          src.start(when, offset, dur);
          track(ch, src);
        }
      }
    }

    // Song length also counts a drum machine with a fixed bar count and the loop region.
    contentLength() {
      let end = Math.max(this.songLength(), this.arrangementEnd || 0);
      const bar = this.beatLen() * this.timeSig[0];
      const map = this.meterMap(); const M = global.BPMeter;
      for (const t of this.tracks) if (t.instrument === 'drumkit' && t.drum && t.drum.bars) end = Math.max(end, map && !map.uniform && M ? M.secAtBar(map, t.drum.offsetBars + t.drum.bars) : (t.drum.offsetBars + t.drum.bars) * bar);
      // a follow-the-song drum machine in a song with nothing else to end it keeps going until you stop (0 = no auto-stop)
      if (!end && this.tracks.some((t) => t.instrument === 'drumkit' && t.drum && !t.drum.bars)) return 0;
      return end;
    }

    _stopInternal() {
      this.playing = false;
      for (const ch of this.chains.values()) { for (const s of ch.sources) { try { s.stop(); } catch (_) {} } ch.sources = []; }
      this.stopClick();
      this.silenceClicks();
      this._nextPass = null;
      if (this._raf) { clearTimeout(this._raf); this._raf = null; }
    }

    // Public stop: ends playback. If a recording is in progress the caller must use
    // stopRecording() instead (app.js does); calling stop() mid-record aborts it.
    stop() {
      if (!this.ctx) return;
      const was = this.playing || !!this.recording;
      if (this.recording) { const rec = this.recording; this.recording = null; if (rec.node) { try { rec.node.port.postMessage('stop'); rec.node.port.onmessage = null; } catch (_) {} } }
      this._stopInternal();
      if (was) this.emit('transport', this.transportState());
    }

    pause() { if (!this.playing || this.recording) return; const pos = this.currentPos(); this._stopInternal(); this.playhead = pos; this.emit('transport', this.transportState()); }

    seek(pos) {
      if (this.recording) return;
      const was = this.playing;
      if (was) this._stopInternal();
      this.playhead = Math.max(0, num(pos, 0));
      if (was) this.play(); else this.emit('transport', this.transportState());
    }

    currentPos() { return this.playing && this.ctx ? this.startPos + (this.ctx.currentTime - this.startCtxTime) : this.playhead; }

    tick() {
      if (!this.playing) return;
      const now = this.ctx.currentTime;
      // loop wrap: pre-schedule the next pass 300 ms early, then flip bookkeeping exactly at the wrap time
      if (this.loop.enabled && (!this.recording || this.recording.loopRec)) {
        const wrapAt = this.startCtxTime + (this.loop.end - this.startPos);
        if (!this._nextPass && now > wrapAt - 0.3) {
          this._scheduleInto(this.ctx, (id) => this.chains.get(id), this.loop.start, wrapAt, this.loop.end, (ch, src) => ch.sources.push(src));
          if (this.click.on) this.scheduleClickRange(this.loop.start, wrapAt, this.loop.end);
          this._nextPass = { at: wrapAt, pos: this.loop.start };
        }
        if (this._nextPass && now >= this._nextPass.at) {
          this.startPos = this._nextPass.pos; this.startCtxTime = this._nextPass.at; this._nextPass = null; this._genCursor = this.loop.end;
          if (this.recording && this.recording.loopRec) { this.recording.loopRec.passes++; this.emit('loop-pass', this.recording.loopRec.passes + 1); }
          // sources from the finished pass have ended on their own (they were given `until`)
          for (const ch of this.chains.values()) ch.sources = ch.sources.filter((s) => !s._ended);
        }
      }
      const pos = this.currentPos();
      this.playhead = Math.max(0, pos);
      const end = this.contentLength();
      if (!this.recording && !this.loop.enabled && end > 0 && pos > end + 0.5) { this._stopInternal(); this.playhead = 0; this.emit('transport', this.transportState()); return; }
      this._extendGenerated();
      this.emit('tick', this.playhead);
      this._raf = setTimeout(() => this.tick(), 16);
    }

    transportState() {
      return { playing: this.playing, recording: !!this.recording, playhead: this.playhead, loop: { ...this.loop }, bpm: this.bpm, timeSig: this.timeSig, click: { ...this.click }, length: this.contentLength(), bar: Math.floor(this.playhead / (this.beatLen() * this.timeSig[0])) + 1 };
    }

    setLoop(patch) {
      const l = { ...this.loop, ...patch };
      l.enabled = !!l.enabled; l.start = clamp(l.start, 0, 1e6, 0); l.end = clamp(l.end, 0, 1e6, l.start + 8);
      if (l.end <= l.start + 0.05) l.end = l.start + this.beatLen() * this.timeSig[0];
      const changed = JSON.stringify(l) !== JSON.stringify(this.loop);
      this.loop = l;
      if (changed && this.playing && !this.recording) { const p = this.currentPos(); this._stopInternal(); this.playhead = p; this.play(); }
      return this.loop;
    }

    setBpm(bpm) { this.bpm = clamp(bpm, 30, 300, 120); this.applyAll(); this._restartIfPlaying(); return this.bpm; }
    setTimeSig(ts) { this.timeSig = validTimeSig(ts); this._restartIfPlaying(); return this.timeSig; }
    _restartIfPlaying() { if (this.playing && !this.recording) { const p = this.currentPos(); this._stopInternal(); this.playhead = p; this.play(); } }

    // ---------- click ----------
    // Click uses a short look-ahead scheduler. `until` bounds a loop pass.
    startClick(fromPos, atCtxTime, until = Infinity) {
      this.stopClick();
      const map = this.meterMap(); let cursor = fromPos;
      const schedule = () => {
        const horizonPos = fromPos + (this.ctx.currentTime + 0.25 - atCtxTime); const to = Math.min(until, horizonPos);
        if (to <= cursor) return;
        const beats = map ? global.BPMeter.beatsIn(map, cursor, to) : [];
        for (const b of beats) { const when = atCtxTime + (b.t - fromPos); if (when >= this.ctx.currentTime - 0.01) this.clickAt(when, b.accent); }
        cursor = to;
      };
      schedule();
      this._clickTimer = setInterval(schedule, 80);
    }
    // Schedule every click of a whole loop pass at once (loops are short). The interval
    // scheduler only serves the first pass; later passes are entirely pre-scheduled here.
    scheduleClickRange(fromPos, atCtxTime, until) {
      const map = this.meterMap(); if (!map) return;
      for (const b of global.BPMeter.beatsIn(map, fromPos, until, 4000)) this.clickAt(atCtxTime + (b.t - fromPos), b.accent);
    }
    // count-in clicks in the meter of where the take starts: [{dt, accent}], and how long it lasts
    countInPlan(pos) {
      const M = global.BPMeter; const map = this.meterMap();
      const sg = map ? M.segAt(map, pos) : { bpm: this.bpm, ts: this.timeSig }; const ts = validTimeSig(sg.ts); const bt = 60 / sg.bpm;
      const acc = M ? M.accents(ts) : [2]; const n = this.click.countIn ? ts[0] * clamp(this.click.countInBars, 1, 4, 1) : 0;
      return { clicks: Array.from({ length: n }, (_, i) => ({ dt: i * bt, accent: acc[i % ts[0]] || 0 })), length: n * bt };
    }
    stopClick() { if (this._clickTimer) { clearInterval(this._clickTimer); this._clickTimer = null; } }
    clickAt(when, accent, countIn = false) {   // accent: 2 / true = the one, 1 = a group start (the 4 in 6/8), 0 = the rest
      const lvl = accent === true ? 2 : accent === false ? 0 : (accent | 0);
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
      o.frequency.value = lvl === 2 ? 1600 : lvl === 1 ? 1300 : 1000;
      if (countIn) { o.type = 'triangle'; o.frequency.value = lvl === 2 ? 2000 : 1500; }   // count-in sounds unlike the click, so you can hear where the song starts
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(lvl === 2 ? 1 : lvl === 1 ? 0.8 : 0.5, when + 0.002); g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      o.connect(g); g.connect(this.clickGain); o.start(when); o.stop(when + 0.06);
      this._clicks.push(o);
      o.onended = () => { const i = this._clicks.indexOf(o); if (i >= 0) this._clicks.splice(i, 1); };
    }
    silenceClicks() {
      const now = this.ctx ? this.ctx.currentTime : 0;
      for (const o of this._clicks) { try { o.stop(now); } catch (_) {} try { o.disconnect(); } catch (_) {} }
      this._clicks = [];
    }

    // ---------- input / recording ----------
    async listInputs() {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Input (allow microphone access to see names)' }));
    }

    async openInput(deviceId) {
      if (this.stream) { for (const tr of this.stream.getTracks()) { tr.onended = null; tr.stop(); } this.stream = null; }
      const constraints = (id) => ({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } }, video: false });
      this.inputFallback = false;
      try { this.stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId)); }
      catch (err) {
        // The saved interface / AirPods aren't connected: use the default input rather than refusing to record.
        if (!deviceId || !/Overconstrained|NotFound|NotReadable/.test(err.name || '')) throw err;
        this.stream = await navigator.mediaDevices.getUserMedia(constraints(null));
        this.inputFallback = true;
      }
      this.inputDeviceId = this.inputFallback ? null : deviceId || null;
      const tr0 = this.stream.getAudioTracks()[0];
      if (tr0) tr0.onended = () => { this.emit('input-lost', { recording: !!this.recording, label: tr0.label }); };   // unplugged, Bluetooth dropped, AirPods back in the case
      if (this.inputSource) { try { this.inputSource.disconnect(); } catch (_) {} }
      if (this.recNode) { try { this.recNode.disconnect(); } catch (_) {} }
      this.inputSource = this.ctx.createMediaStreamSource(this.stream);
      this.inputAnalyser = this.ctx.createAnalyser(); this.inputAnalyser.fftSize = 1024;
      this.inputSource.connect(this.inputAnalyser);
      this.inputSource.connect(this.monitorGain);
      this.recNode = new AudioWorkletNode(this.ctx, 'bp-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.inputSource.connect(this.recNode);
      const silent = this.ctx.createGain(); silent.gain.value = 0; this.recNode.connect(silent); silent.connect(this.ctx.destination);
      return this.stream.getAudioTracks()[0].getSettings();
    }

    // Click to its own output (a drummer's in-ears / a second headphone out): the click leaves through an <audio> sink
    async setClickOutput(deviceId) {
      await this.init();
      try { this.clickGain.disconnect(); } catch (_) {}
      if (this._clickEl) { try { this._clickEl.pause(); } catch (_) {} this._clickEl.srcObject = null; this._clickEl = null; }
      if (!deviceId) { this.clickGain.connect(this.ctx.destination); this.clickOutputId = null; return null; }
      const back = () => { try { this.clickGain.disconnect(); } catch (_) {} this.clickGain.connect(this.ctx.destination); this.clickOutputId = null; };
      try {
        const dest = this.ctx.createMediaStreamDestination(); this.clickGain.connect(dest);
        const a = new Audio(); a.srcObject = dest.stream; a.autoplay = true;
        if (typeof a.setSinkId !== 'function') throw new Error('this build cannot pick an output for the click');
        await a.setSinkId(deviceId); await a.play().catch(() => {}); this._clickEl = a; this.clickOutputId = deviceId;
        return deviceId;
      } catch (err) { back(); throw err; }   // unplugged / refused: the click stays on the main output, never silent
    }
    setMonitor(on) { this.monitorInput = on; if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); }
    // Monitoring through the armed track: the live input goes into that track's chain (amp sim, EQ, compressor, sends,
    // fader), so what you hear while you play is what the take will sound like. The take itself still records dry.
    setMonitorTrack(trackId) { if (this.monitorTrackId === (trackId || null)) return; this.monitorTrackId = trackId || null; this._routeMonitor(); }
    setMonitorFx(on) { this.monitorFx = !!on; this._routeMonitor(); }
    _routeMonitor() {
      if (!this.monitorGain) return;
      try { this.monitorGain.disconnect(); } catch (_) {}
      const ch = this.monitorFx && this.monitorTrackId ? this.chains.get(this.monitorTrackId) : null;
      const t = ch && this.track(this.monitorTrackId);
      this.monitorGain.connect(ch && t && t.instrument === 'audio' ? ch.input : this.masterIn);
      this.monitorVia = ch && t && t.instrument === 'audio' ? this.monitorTrackId : null;
    }
    // ---- output device (the Scarlett's headphone / line out, not whatever Windows calls default) ----
    async listOutputs() { const devs = await navigator.mediaDevices.enumerateDevices(); return devs.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || 'Output (allow microphone access to see names)' })); }
    async setOutput(deviceId) {
      const id = deviceId || ''; this.wantOutput = id || null; await this.init();
      if (typeof this.ctx.setSinkId !== 'function') throw new Error('this build cannot choose the output device');
      await this.ctx.setSinkId(id); this.outputDeviceId = id || null;
      if (!this.offsetManual) this.recordOffsetMs = this.autoOffsetMs();
      return this.outputDeviceId;
    }
    // ---- latency measurement: play clicks out, hear them come back in, set the record offset from the delay ----
    async measureLatency({ clicks = 6 } = {}) {
      await this.init(); await this.resume();
      if (this.recording) throw new Error('stop recording first');
      if (!this.recNode) throw new Error('no input open');
      const sr = this.ctx.sampleRate; const node = this.recNode; const chunks = []; let startFrame = null;
      const started = new Promise((resolve) => { node.port.onmessage = (e) => { if (e.data.started !== undefined) { startFrame = e.data.started; resolve(); } if (e.data.chunk) chunks.push(e.data.chunk); }; });
      const mon = this.monitorGain.gain.value; this.monitorGain.gain.setValueAtTime(0, this.ctx.currentTime);   // no feedback loop through the monitor
      node.port.postMessage('start');
      await Promise.race([started, new Promise((r) => setTimeout(r, 1000))]);
      if (startFrame === null) { node.port.postMessage('stop'); node.port.onmessage = null; throw new Error('Input is not delivering audio.'); }
      // clicks far enough apart (1.1 s) that a late click can never be mistaken for the next one (up to 1 s of latency)
      const gap = 1.1, t0 = this.ctx.currentTime + 0.3; const times = Array.from({ length: clicks }, (_, i) => t0 + i * gap);
      const out = this.ctx.createGain(); out.gain.value = 0.9; out.connect(this.ctx.destination);
      for (const when of times) { const o = this.ctx.createOscillator(); const g = this.ctx.createGain(); o.type = 'square'; o.frequency.value = 2000; g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.0005); g.gain.setValueAtTime(1, when + 0.003); g.gain.linearRampToValueAtTime(0, when + 0.004); o.connect(g); g.connect(out); o.start(when); o.stop(when + 0.006); }
      await new Promise((r) => setTimeout(r, Math.round((times[times.length - 1] - this.ctx.currentTime + 1.1) * 1000)));
      await new Promise((resolve) => { const prev = node.port.onmessage; node.port.onmessage = (e) => { if (prev) prev(e); if (e.data.done) resolve(); }; node.port.postMessage('stop'); setTimeout(resolve, 500); });
      node.port.onmessage = null; this.monitorGain.gain.setTargetAtTime(mon, this.ctx.currentTime, 0.01);
      const total = chunks.reduce((n, c) => n + c[0].length, 0); if (!total) throw new Error('nothing was captured');
      const x = new Float32Array(total); { let o = 0; for (const c of chunks) { const a = c[0], b = c[1]; for (let i = 0; i < a.length; i++) x[o + i] = Math.max(Math.abs(a[i]), b ? Math.abs(b[i]) : 0); o += a.length; } }
      let peak = 0; for (let i = 0; i < total; i++) if (x[i] > peak) peak = x[i];
      if (peak < 0.003) throw new Error(`Didn't hear the clicks come back (input peak ${(20 * Math.log10(peak + 1e-9)).toFixed(0)} dBFS). Route the output into an input — a cable from the interface's output to an input, or a mic near the speakers — turn it up, and try again.`);
      // per click: the first sample after it was sent that crosses 30 % of the loudest thing heard
      const thr = peak * 0.3, maxLag = Math.round(1.0 * sr); const lags = [];
      for (const t of times) { const f = Math.round(t * sr) - startFrame; let hit = -1; for (let i = Math.max(0, f); i < Math.min(total, f + maxLag); i++) if (x[i] >= thr) { hit = i; break; } if (hit >= 0) lags.push((hit - f) / sr * 1000); }
      if (lags.length < Math.ceil(clicks / 2)) throw new Error(`Only heard ${lags.length} of ${clicks} clicks — turn the output up and try again.`);
      const sorted = lags.slice().sort((a, b) => a - b); const med = sorted[Math.floor(sorted.length / 2)];
      const spread = sorted[sorted.length - 1] - sorted[0];
      return { ms: Math.round(med * 10) / 10, lags: lags.map((l) => Math.round(l * 10) / 10), spread: Math.round(spread * 10) / 10, peakDb: Math.round(20 * Math.log10(peak)), auto: this.autoOffsetMs() };
    }

    // Starts capture immediately (so the exact start frame is known), plays the count-in,
    // then starts playback of the other tracks at `atCtxTime`. The take is aligned to
    // `atCtxTime` to the sample in stopRecording().
    async record(trackId) {
      if (!this.recNode) throw new Error('No input opened. Pick an input device in Settings.');
      if (this.recording) throw new Error('already recording');
      const t = this.track(trackId);
      if (!t) throw new Error('no armed track');
      await this.resume();
      if (this.playing) this._stopInternal();
      if (!this.offsetManual) this.recordOffsetMs = this.autoOffsetMs();   // output device may have changed (speakers ⇄ Bluetooth)
      const countBeats = 0; const ci = null;   /* count-in: see countInPlan (meter of where the take starts) */
      // Loop recording: every pass of the loop becomes its own take. Always starts at the loop start.
      const loopRec = this.loop.enabled && this.loop.end > this.loop.start + 0.25 ? { start: this.loop.start, end: this.loop.end, passes: 0 } : null;
      const startPos = loopRec ? loopRec.start : this.playhead;
      this.playhead = startPos;
      const chunks = [];
      const node = this.recNode;
      const rec = { trackId, startPos, startCtxTime: 0, chunks, node, startFrame: null, loopRec };
      const started = new Promise((resolve) => { rec._onStarted = resolve; });
      node.port.onmessage = (e) => {
        if (e.data.started !== undefined) { rec.startFrame = e.data.started; rec._onStarted(); }
        if (e.data.chunk) { chunks.push(e.data.chunk); if (this.onRecChunk) { try { this.onRecChunk(rec, e.data.chunk); } catch (_) {} } }
        if (e.data.done && rec._onDone) rec._onDone();
      };
      this.recording = rec;
      node.port.postMessage('start');
      await Promise.race([started, new Promise((r) => setTimeout(r, 1000))]);
      if (this.recording !== rec) { node.port.postMessage('stop'); node.port.onmessage = null; return null; }   // cancelled during start-up
      if (rec.startFrame === null) { this.recording = null; node.port.postMessage('stop'); node.port.onmessage = null; throw new Error('Input is not delivering audio. Check the device in Settings.'); }
      const now = this.ctx.currentTime; const plan = this.countInPlan(startPos); void countBeats; void ci;
      const atCtxTime = now + SCHEDULE_AHEAD + plan.length;
      rec.startCtxTime = atCtxTime; rec.countIn = { at: now + SCHEDULE_AHEAD, clicks: plan.clicks, length: plan.length }; rec.sampleRate = this.ctx.sampleRate; rec.offsetMs = this.recordOffsetMs || 0;
      for (const c of plan.clicks) this.clickAt(now + SCHEDULE_AHEAD + c.dt, c.accent, true);
      this.playing = true; this.startPos = startPos; this.startCtxTime = atCtxTime;
      this.emit('countin', rec.countIn);
      const until = loopRec ? loopRec.end : Infinity;   // loop recording: pass 1 must end at the loop end like every later pass
      this.scheduleClips(startPos, atCtxTime, until);
      if (this.click.on) this.startClick(startPos, atCtxTime, until);
      this.emit('transport', this.transportState());
      this.tick();
      return rec;
    }

    // Returns { clip, channels, sampleRate } to be saved by app.js, or null if nothing captured.
    async stopRecording() {
      const rec = this.recording;
      if (!rec) return null;
      if (rec.midi) return this.stopRecordingMidi();
      const done = new Promise((r) => { rec._onDone = r; });
      rec.node.port.postMessage('stop');
      await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
      try { rec.node.port.onmessage = null; } catch (_) {}   // the handler's closure would keep every chunk alive until the next take
      this.recording = null;
      this._stopInternal();
      this.playhead = rec.startPos;
      this.emit('transport', this.transportState());
      if (!rec.chunks.length || rec.startFrame === null) return null;
      const sr = this.ctx.sampleRate;
      const numCh = rec.chunks[0].length;
      const total = rec.chunks.reduce((n, c) => n + c[0].length, 0);
      const raw = [];
      for (let c = 0; c < numCh; c++) { const b = new Float32Array(total); let o = 0; for (const ch of rec.chunks) { b.set(ch[c] || new Float32Array(ch[0].length), o); o += ch[0].length; } raw.push(b); }
      rec.chunks.length = 0;   // memory: the chunks are in `raw` now
      // Align: capture began at startFrame; song position startPos corresponds to context
      // time startCtxTime. Drop everything captured before that, plus the round-trip offset.
      const alignFrame = Math.round(rec.startCtxTime * sr);
      let drop = alignFrame - rec.startFrame + Math.round((this.recordOffsetMs || 0) / 1000 * sr);
      let clipStart = rec.startPos;
      if (drop < 0) { clipStart += -drop / sr; drop = 0; }   // capture started late: shift the clip instead of trimming
      if (drop >= total) return null;
      let channels = raw.map((b) => b.subarray(drop));
      // A mono source on a stereo interface shows up as one live and one dead channel; store it mono.
      if (channels.length === 2) {
        const pk = channels.map((b) => { let p = 0; for (let i = 0; i < b.length; i += 4) { const a = Math.abs(b[i]); if (a > p) p = a; } return p; });
        if (pk[0] > 1e-4 && pk[1] <= 1e-4) channels = [channels[0]];
        else if (pk[1] > 1e-4 && pk[0] <= 1e-4) channels = [channels[1]];
      }
      const makeTake = (chans, start) => {
        const buf = this.ctx.createBuffer(chans.length, chans[0].length, sr);
        for (let c = 0; c < chans.length; c++) buf.copyToChannel(chans[c], c);
        const clip = { id: global.BPUtil.newId(), name: 'take', start, gainDb: 0, trimStart: 0, trimEnd: 0, duration: buf.duration, channels: chans.length, mute: false, fadeIn: 0, fadeOut: 0 };
        this.buffers.set(clip.id, buf);
        // hand back views of the AudioBuffer itself, so the big concatenated capture can be freed right away
        return { clip, channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)) };
      };
      if (rec.loopRec) {
        // one take per loop pass; a trailing fragment shorter than half a pass (stopped mid-way) is dropped
        const loopFrames = Math.round((rec.loopRec.end - rec.loopRec.start) * sr); const total = channels[0].length;
        const takes = [];
        for (let k = 0; k * loopFrames < total; k++) {
          const a = k * loopFrames, b = Math.min(total, (k + 1) * loopFrames);
          if (k > 0 && b - a < loopFrames / 2) break;   // stopped part-way through a pass: that fragment is not a take
          const tk = makeTake(channels.map((ch) => ch.subarray(a, b)), rec.loopRec.start); tk.partial = b - a < loopFrames - 1; takes.push(tk);
        }
        return { takes, loop: true, trackId: rec.trackId, sampleRate: sr, clip: takes[0] && takes[0].clip, channels: takes[0] && takes[0].channels };
      }
      const t0 = makeTake(channels, clipStart);
      return { clip: t0.clip, takes: [t0], loop: false, trackId: rec.trackId, channels: t0.channels, sampleRate: sr };
    }

    inputLevel() { return this.inputAnalyser ? levelOf(this.inputAnalyser) : null; }

    // ---------- MIDI ----------
    async initMidi() {
      if (this.midi.ready) return this.midi;
      this.midi.ready = true;
      if (!navigator.requestMIDIAccess) return this.midi;
      try {
        const access = await navigator.requestMIDIAccess({ sysex: false });
        this.midi.access = access;
        const refresh = () => { this.midi.inputs = [...access.inputs.values()].map((i) => ({ id: i.id, name: i.name || i.id })); this.emit('midi:inputs', this.midi.inputs); };
        access.onstatechange = () => { refresh(); if (this.ctx) for (const v of this.midi.held.values()) v.stop(this.ctx.currentTime); this.midi.held.clear(); this.selectMidiInput(this.midi.selectedId); };
        refresh();
      } catch (err) { console.warn('MIDI unavailable', err); }
      return this.midi;
    }
    selectMidiInput(id) {
      if (!this.midi || !this.midi.access) return;
      for (const i of this.midi.access.inputs.values()) i.onmidimessage = null;
      this.midi.selectedId = null;
      const inputs = [...this.midi.access.inputs.values()];
      const inp = inputs.find((i) => i.id === id) || (id === 'any' ? null : null);
      const targets = id === 'any' ? inputs : (inp ? [inp] : []);
      for (const i of targets) i.onmidimessage = (e) => this._onMidi(e.data, e.timeStamp);
      this.midi.selectedId = targets.length ? id : null;
    }
    _onMidi(data, ts) {
      const [status, d1, d2] = data; const cmd = status & 0xf0;
      if (cmd === 0xb0) { this.emit('midi:cc', { cc: d1, val: d2 }); return; }   // foot pedals / controllers
      if (cmd !== 0x90 && cmd !== 0x80) return;
      const on = cmd === 0x90 && d2 > 0;
      const t = this.ctx ? this.ctx.currentTime : 0;
      this.emit('midi', { on, note: d1, vel: d2 / 127 });
      if (this.pedalNotes && this.pedalNotes.has(d1)) return;   // a note used as a pedal (Show mode) doesn't play or record
      if (this.recording && this.recording.midi) {
        const rec = this.recording;
        if (on) rec.open.set(d1, { t, v: d2 / 127 });
        else { const o = rec.open.get(d1); if (o) { rec.open.delete(d1); rec.events.push({ tOn: o.t, tOff: t, n: d1, v: o.v }); } }
      }
      const track = this.track(this.midi.liveTrackId);
      if (!track || !this.ctx) return;
      const ch = this.chains.get(track.id); if (!ch) return;
      if (track.instrument.startsWith('synth:')) {
        if (on) { const old = this.midi.held.get(d1); if (old) old.stop(t); this.midi.held.set(d1, global.BPSynth.synthNote(this.ctx, ch.input, track.instrument.slice(6), d1, d2 / 127, t, null)); }
        else { const v = this.midi.held.get(d1); if (v) { v.stop(t); this.midi.held.delete(d1); } }
      } else if (track.instrument === 'drumkit' && on) {
        const voice = { 35: 'kick', 36: 'kick', 38: 'snare', 40: 'snare', 37: 'snare', 42: 'hat', 44: 'hat', 46: 'ohat', 41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 49: 'crash', 57: 'crash', 55: 'crash', 51: 'ohat' }[d1];
        if (voice) { const g = this.ctx.createGain(); g.gain.value = dbToGain((track.drum || {}).gainDb || 0); g.connect(ch.input); global.BPSynth.drumHit(this.ctx, g, (track.drum || {}).kit || 'rock', voice, t, d2 / 127); }
      }
    }
    // Which track live MIDI (and the on-screen keys) plays through.
    setLiveMidiTrack(id) { if (this.ctx) for (const v of this.midi.held.values()) v.stop(this.ctx.currentTime); this.midi.held.clear(); this.midi.liveTrackId = id; }
    // On-screen keys: behave exactly like a MIDI keyboard (audible, and recorded while recording MIDI).
    noteOn(trackId, note, vel = 0.8) { if (!this.ctx) return; if (this.midi.liveTrackId !== trackId) this.setLiveMidiTrack(trackId); this._onMidi([0x90, note, Math.round(clamp(vel, 0, 1, 0.8) * 127)], 0); }
    noteOff(trackId, note) { if (!this.ctx) return; this._onMidi([0x80, note, 0], 0); }
    // Audition a note from the UI / API (no MIDI hardware needed).
    playNote(trackId, note, vel = 0.8, dur = 0.5, opts = undefined) {
      const track = this.track(trackId); const ch = track && this.chains.get(track.id); if (!ch || !this.ctx) return;
      const t = this.ctx.currentTime;
      if (track.instrument.startsWith('synth:')) global.BPSynth.synthNote(this.ctx, ch.input, track.instrument.slice(6), note, vel, t, dur, opts);
      else if (track.instrument === 'drumkit') this._onMidi([0x90, note, Math.round(vel * 127)], 0);
    }

    // MIDI recording: notes are captured with context timestamps and aligned to startCtxTime.
    async recordMidi(trackId) {
      if (this.recording) throw new Error('already recording');
      const t = this.track(trackId); if (!t) throw new Error('no armed track');
      await this.resume();
      if (this.playing) this._stopInternal();
      const countBeats = 0; const ci = null;   /* count-in: see countInPlan (meter of where the take starts) */
      const loopRec = this.loop.enabled && this.loop.end > this.loop.start + 0.25 ? { start: this.loop.start, end: this.loop.end, passes: 0 } : null;
      const startPos = loopRec ? loopRec.start : this.playhead;
      this.playhead = startPos;
      const now = this.ctx.currentTime; const plan = this.countInPlan(startPos); void countBeats; void ci;
      const atCtxTime = now + SCHEDULE_AHEAD + plan.length;
      const rec = { midi: true, trackId, startPos, startCtxTime: atCtxTime, events: [], open: new Map(), loopRec };
      this.recording = rec;
      this.setLiveMidiTrack(trackId);
      for (const c of plan.clicks) this.clickAt(now + SCHEDULE_AHEAD + c.dt, c.accent, true);
      this.playing = true; this.startPos = startPos; this.startCtxTime = atCtxTime;
      rec.countIn = { at: now + SCHEDULE_AHEAD, clicks: plan.clicks, length: plan.length }; this.emit('countin', rec.countIn);
      const until = loopRec ? loopRec.end : Infinity;   // loop recording: pass 1 must end at the loop end like every later pass
      this.scheduleClips(startPos, atCtxTime, until);
      if (this.click.on) this.startClick(startPos, atCtxTime, until);
      this.emit('transport', this.transportState());
      this.tick();
      return rec;
    }
    stopRecordingMidi() {
      const rec = this.recording; if (!rec || !rec.midi) return null;
      const t = this.ctx.currentTime;
      for (const [n, o] of rec.open) rec.events.push({ tOn: o.t, tOff: t, n, v: o.v });
      rec.open.clear();
      this.recording = null;
      this._stopInternal();
      this.playhead = rec.startPos;
      this.emit('transport', this.transportState());
      const notes = rec.events.filter((e) => e.tOff > rec.startCtxTime).map((e) => ({ t: Math.max(0, e.tOn - rec.startCtxTime), d: Math.max(0.03, e.tOff - Math.max(e.tOn, rec.startCtxTime)), n: e.n, v: e.v })).sort((a, b) => a.t - b.t);
      if (!notes.length) return null;
      const mk = (ns, start, dur) => ({ id: global.BPUtil.newId(), kind: 'midi', name: 'midi take', start, gainDb: 0, trimStart: 0, trimEnd: 0, duration: dur, notes: ns, mute: false });
      if (rec.loopRec) {
        const L = rec.loopRec.end - rec.loopRec.start; const byPass = new Map();
        for (const n of notes) { const k = Math.floor(n.t / L); if (!byPass.has(k)) byPass.set(k, []); byPass.get(k).push({ ...n, t: n.t - k * L, d: Math.min(n.d, L - (n.t - k * L)) }); }
        const takes = [...byPass.keys()].sort((a, b) => a - b).map((k) => ({ clip: mk(byPass.get(k), rec.loopRec.start, L) }));
        return { takes, loop: true, trackId: rec.trackId, clip: takes[0].clip };
      }
      const duration = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0) + 0.05;
      const clip = mk(notes, rec.startPos, duration);
      return { clip, takes: [{ clip }], loop: false, trackId: rec.trackId };
    }
    // Quantise a midi clip's note starts to a grid (division in beats: 0.25 = sixteenth).
    quantizeClip(c, division = 0.25, strength = 1) {
      const grid = this.beatLen() * clamp(division, 1 / 32, 4, 0.25); strength = clamp(strength, 0, 1, 1);
      for (const n of c.notes) { const q = Math.round(n.t / grid) * grid; n.t = n.t + (q - n.t) * strength; }
      c.notes.sort((a, b) => a.t - b.t);
    }

    // ---------- meters ----------
    meters() {
      const out = { master: this.masterAnalyser ? levelOf(this.masterAnalyser) : null, limiterDb: this.limiter && this.master.limiter ? round1(this.limiter.reduction) : 0, tracks: {} };
      for (const [id, ch] of this.chains) out.tracks[id] = ch.analyser ? levelOf(ch.analyser) : null;
      out.input = this.inputLevel();
      return out;
    }

    // ---------- offline render ----------
    // Renders the mix (or one track post-fader/post-FX incl. its reverb send) between
    // `from` and `to` seconds. Master gain is applied unless unityMaster is set.
    async render({ soloTrackId = null, from = 0, to = null, unityMaster = false, limiter = null, exact = false } = {}) {
      const aud = this.audition; this.audition = null;
      try { return await this._render({ soloTrackId, from, to, unityMaster, limiter, exact }); } finally { this.audition = aud; }
    }
    async _render({ soloTrackId = null, from = 0, to = null, unityMaster = false, limiter = null, exact = false } = {}) {
      const length = to ?? this.contentLength();
      const dur = Math.max(0.01, length - from);
      const sr = this.ctx ? this.ctx.sampleRate : 48000;
      const tail = this.master.reverb.decay + this.master.reverb.preDelay + 0.5;
      const off = new OfflineAudioContext(2, Math.ceil((dur + tail) * sr), sr);
      if (this.ctx && this.ctx._bpGateReady) { try { await off.audioWorklet.addModule('gate-worklet.js'); off._bpGateReady = true; } catch (_) {} }
      const masterIn = off.createGain(); const masterGain = off.createGain();
      masterGain.gain.value = unityMaster ? 1 : dbToGain(this.master.gainDb);
      const reverbIn = off.createGain(); const conv = off.createConvolver(); conv.buffer = makeImpulse(off, this.master.reverb);
      reverbIn.connect(conv); conv.connect(masterIn); masterIn.connect(masterGain);
      if ((limiter === null ? this.master.limiter : limiter) && !unityMaster) { const lim = makeLimiter(off); masterGain.connect(lim); lim.connect(off.destination); } else masterGain.connect(off.destination);
      const chains = new Map();
      for (const t of this.tracks) {
        const audible = soloTrackId ? t.id === soloTrackId : this.audible(t);
        if (!audible) continue;
        const ch = buildTrackChain(off, t, masterIn, reverbIn);
        applyTrackParams(off, ch, t, true, this.bpm);
        chains.set(t.id, ch);
      }
      this._scheduleInto(off, (id) => chains.get(id), from, 0, length, () => {});
      const rendered = await off.startRendering();
      const keep = exact ? rendered.length : trailingKeep(rendered, Math.ceil(dur * sr));   // exact: identical length for every stem (DAW hand-off)
      const chans = [];
      for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(rendered.getChannelData(c).subarray(0, keep));
      return { channels: chans, sampleRate: sr };
    }

    // ---------- analysis ----------
    async analyzeBuffer(buf) {
      const sr = buf.sampleRate; const n = buf.length; const nc = Math.min(2, buf.numberOfChannels);
      let peak = 0, sumSq = 0, clips = 0, dc = 0, silentBlocks = 0, blocks = 0, activeSq = 0, activeN = 0;
      const blockN = Math.floor(sr * 0.05);
      for (let c = 0; c < nc; c++) {
        const d = buf.getChannelData(c);
        let bsum = 0, bi = 0;
        for (let i = 0; i < n; i++) {
          const x = d[i]; const a = Math.abs(x);
          if (a > peak) peak = a; sumSq += x * x; dc += x; if (a >= 0.999) clips++;
          bsum += x * x; bi++;
          if (bi === blockN) { blocks++; if (bsum / blockN < 1e-8) silentBlocks++; else { activeSq += bsum; activeN += blockN; } bsum = 0; bi = 0; }
        }
      }
      const rms = Math.sqrt(sumSq / Math.max(1, n * nc));
      const rmsActive = activeN ? Math.sqrt(activeSq / activeN) : rms;
      // Band energies on a mono sum; K-weighted loudness per channel (BS.1770: channel powers are summed).
      const bands = [['sub', 20, 60], ['low', 60, 250], ['lowMid', 250, 1000], ['mid', 1000, 4000], ['high', 4000, 10000], ['air', 10000, 20000]];
      const lanes = bands.length + nc;
      const off = new OfflineAudioContext(lanes, n, sr);
      const src = off.createBufferSource(); src.buffer = buf;
      const mono = off.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
      src.connect(mono);
      const merger = off.createChannelMerger(lanes); merger.channelCount = 1; merger.channelCountMode = 'explicit';
      bands.forEach(([name, lo, hi], i) => {
        const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = lo; hp.Q.value = 0.707;
        const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(hi, sr / 2 - 100); lp.Q.value = 0.707;
        mono.connect(hp); hp.connect(lp); lp.connect(merger, 0, i);
      });
      const splitter = off.createChannelSplitter(nc); src.connect(splitter);
      for (let c = 0; c < nc; c++) {
        const kShelf = off.createBiquadFilter(); kShelf.type = 'highshelf'; kShelf.frequency.value = 1500; kShelf.gain.value = 4;
        const kHp = off.createBiquadFilter(); kHp.type = 'highpass'; kHp.frequency.value = 38; kHp.Q.value = 0.5;
        splitter.connect(kShelf, c); kShelf.connect(kHp); kHp.connect(merger, 0, bands.length + c);
      }
      off.destination.channelCount = lanes; off.destination.channelCountMode = 'explicit'; off.destination.channelInterpretation = 'discrete';
      merger.connect(off.destination);
      src.start(0);
      const res = await off.startRendering();
      const bandDb = {};
      bands.forEach(([name], i) => { bandDb[name] = round1(gainToDb(rmsOf(res.getChannelData(i)))); });
      const kChans = []; for (let c = 0; c < nc; c++) kChans.push(res.getChannelData(bands.length + c));
      const lufs = gatedLoudness(kChans, sr);
      return {
        seconds: round1(buf.duration), channels: nc, sampleRate: sr,
        peakDbfs: round1(gainToDb(peak)), rmsDbfs: round1(gainToDb(rms)), rmsActiveDbfs: round1(gainToDb(rmsActive)), crestDb: round1(gainToDb(peak) - gainToDb(rmsActive)),
        lufsApprox: round1(lufs), dcOffset: Number((dc / Math.max(1, n * nc)).toFixed(5)),
        clippedSamples: clips, silentPct: blocks ? Math.round(100 * silentBlocks / blocks) : 100,
        bandsDbfs: bandDb,
      };
    }

    bufferFromRender(r) {
      const ctx = this.ctx || new OfflineAudioContext(2, 1, 48000);
      const buf = ctx.createBuffer(r.channels.length, r.channels[0].length, r.sampleRate);
      r.channels.forEach((c, i) => buf.copyToChannel(c, i));
      return buf;
    }

    async analyzeClip(clipId) {
      const c = this.tracks.flatMap((t) => t.clips).find((x) => x.id === clipId);
      const buf = this.buffers.get(c ? audioId(c) : clipId); if (!buf) throw new Error(`clip ${clipId} is not loaded`);
      return this.analyzeBuffer(buf);
    }
    async analyzeTrack(trackId, range = {}) {
      if (!this.track(trackId)) throw new Error(`no track ${trackId}`);
      return this.analyzeBuffer(this.bufferFromRender(await this.render({ soloTrackId: trackId, unityMaster: true, ...range })));
    }
    async analyzeMix(range = {}) {
      return this.analyzeBuffer(this.bufferFromRender(await this.render(range)));
    }
  }

  // any meter: 1–64 beats over any note value 1–64 (13/7 is fine); optional grouping for the click accents ([7, 8, [2, 2, 3]])
  function validTimeSig(ts) {
    if (global.BPMeter) return global.BPMeter.normTs(ts);
    if (!Array.isArray(ts) || ts.length < 2) return [4, 4];
    const n = Math.round(num(ts[0], 4)), d = Math.round(num(ts[1], 4));
    if (!(n >= 1 && n <= 64) || !(d >= 1 && d <= 64)) return [4, 4];
    return [n, d];
  }
  function deepMerge(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b || {})) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a && typeof a[k] === 'object') ? deepMerge(a[k], b[k]) : b[k];
    }
    return out;
  }
  function rmsOf(d) { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, d.length)); }
  function round1(x) { return Number.isFinite(x) ? Math.round(x * 10) / 10 : (x === -Infinity ? -120 : x); }
  function levelOf(an) {
    const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d);
    let p = 0, s = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; s += d[i] * d[i]; }
    return { peakDbfs: round1(gainToDb(p)), rmsDbfs: round1(gainToDb(Math.sqrt(s / d.length))) };
  }
  // BS.1770-style: 400 ms blocks, 75% overlap, per-channel K-weighted power summed,
  // absolute gate -70 LUFS then relative gate -10 LU.
  function gatedLoudness(kChans, sr) {
    const blk = Math.floor(sr * 0.4), hop = Math.floor(blk / 4); const vals = [];
    const len = kChans[0].length;
    for (let i = 0; i + blk <= len; i += hop) {
      let s = 0;
      for (const k of kChans) for (let j = i; j < i + blk; j++) s += k[j] * k[j];
      vals.push(s / blk);
    }
    const toL = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
    let a = vals.filter((v) => toL(v) > -70); if (!a.length) return -Infinity;
    const rel = toL(a.reduce((x, y) => x + y, 0) / a.length) - 10;
    a = a.filter((v) => toL(v) > rel); if (!a.length) return -Infinity;
    return toL(a.reduce((x, y) => x + y, 0) / a.length);
  }
  function trailingKeep(buf, minFrames) {
    const n = buf.length; let last = Math.min(n, minFrames);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = n - 1; i >= minFrames; i--) { if (Math.abs(d[i]) > 1e-4) { last = Math.max(last, i + 1); break; } } }
    return Math.min(n, last);
  }

  global.BPEngine = { Engine, DEFAULT_FX, DEFAULT_MASTER, DEFAULT_DRUM, AMP_MODELS, CABS, TRACK_TYPES, normalizeTrack, normalizeMaster, validTimeSig, dbToGain, gainToDb, num, clamp, audioId };
  global.BPUtil = global.BPUtil || {};
  global.BPUtil.newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => b.toString(16).padStart(2, '0')).join('');
})(window);
