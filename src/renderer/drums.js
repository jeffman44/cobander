// Drum part generator + grid helpers. A drum part is a MIDI clip on the drum-machine track (GM note numbers), so it
// plays through the kit, exports to a DAW as MIDI, and can be edited hit by hit in the drum editor.
// Pure functions (unit-testable in node).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPDrums = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // rows of the editor, top to bottom; GM note numbers the engine and DAW export understand
  const VOICES = [
    { id: 'crash', name: 'Crash', n: 49 },
    { id: 'ohat', name: 'Open hat / ride', n: 46 },
    { id: 'hat', name: 'Hi-hat', n: 42 },
    { id: 'tom', name: 'Tom', n: 45 },
    { id: 'snare', name: 'Snare', n: 38 },
    { id: 'kick', name: 'Kick', n: 36 },
  ];
  const NOTE = Object.fromEntries(VOICES.map((v) => [v.id, v.n]));
  const VOICE_OF = { 35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 40: 'snare', 42: 'hat', 44: 'hat', 46: 'ohat', 51: 'ohat', 53: 'ohat', 59: 'ohat', 41: 'tom', 43: 'tom', 45: 'tom', 47: 'tom', 48: 'tom', 50: 'tom', 49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash' };
  const voiceOf = (n) => VOICE_OF[Math.round(n)] || null;

  // Fill presets per row: hits per beat (and offset in beats). "backbeat" = beats 2 and 4 (or 2 in 3/4 etc.).
  const FILLS = [
    { id: 'bar', label: 'Every bar (1)', perBeat: null, everyBeats: 'bar' },
    { id: 'half', label: '1/2 notes', perBeat: 0.5 },
    { id: 'q', label: '1/4 notes', perBeat: 1 },
    { id: 'back', label: 'Backbeat (2 & 4)', backbeat: true },
    { id: 'e', label: '1/8 notes', perBeat: 2 },
    { id: 'off', label: 'Off-beat 1/8s (the "and")', perBeat: 1, offset: 0.5 },
    { id: 't8', label: '1/8 triplets', perBeat: 3 },
    { id: 's', label: '1/16 notes', perBeat: 4 },
    { id: 't16', label: '1/16 triplets', perBeat: 6 },
    { id: 'clear', label: 'Clear row', clear: true },
  ];

  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // hits for one row filling [0, seconds): times in seconds from the part start
  function fillTimes(fill, { seconds, beatSec, beatsPerBar }) {
    const f = typeof fill === 'string' ? FILLS.find((x) => x.id === fill) : fill; if (!f || f.clear) return [];
    const out = []; const bar = beatSec * beatsPerBar; const eps = 1e-6;
    if (f.everyBeats === 'bar') { for (let t = 0; t < seconds - eps; t += bar) out.push(t); return out; }
    if (f.backbeat) { for (let b = 0; b * beatSec < seconds - eps; b++) { const inBar = b % beatsPerBar; if (beatsPerBar === 3 ? inBar === 1 : inBar % 2 === 1) out.push(b * beatSec); } return out; }
    const step = beatSec / f.perBeat; const off = (f.offset || 0) * beatSec;
    for (let t = off; t < seconds - eps; t += step) out.push(t);
    return out;
  }

  // 16-step (one 4/4 bar) groove templates: 2 = accent, 1 = normal, 0.5 = ghost
  const STYLES = {
    rock: { name: 'Rock', kick: [2,0,0,0, 0,0,0,0, 2,0,1,0, 0,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    punk: { name: 'Pop-punk', kick: [2,0,1,0, 0,0,1,0, 2,0,1,0, 0,0,1,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    skate: { name: 'Skate punk (double-time)', kick: [2,0,0,0, 2,0,0,0, 2,0,0,0, 2,0,0,0], snare: [0,0,2,0, 0,0,2,0, 0,0,2,0, 0,0,2,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    halftime: { name: 'Half-time', kick: [2,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0], snare: [0,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    funk: { name: 'Funk', kick: [2,0,0,1, 0,0,1,0, 0,0,1,0, 0,1,0,0], snare: [0,0,0,0, 2,0,0,0.5, 0,0.5,0,0, 2,0,0,0.5], hat: [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1] },
    disco: { name: 'Four on the floor', kick: [2,0,0,0, 2,0,0,0, 2,0,0,0, 2,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0], ohat: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0] },
    metal: { name: 'Metal (double kick)', kick: [2,1,1,1, 1,1,1,1, 2,1,1,1, 1,1,1,1], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    shuffle: { name: 'Shuffle', triplet: true },
    ska: { name: 'Ska / offbeat', kick: [2,0,0,0, 2,0,0,0, 2,0,0,0, 2,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0] },
    ballad: { name: 'Ballad', kick: [2,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0] },
    blast: { name: 'Blast beat', kick: [2,0,2,0, 2,0,2,0, 2,0,2,0, 2,0,2,0], snare: [0,2,0,2, 0,2,0,2, 0,2,0,2, 0,2,0,2], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
  };
  const STYLE_IDS = Object.keys(STYLES);
  // guess a groove from a song's style name ("Pop-punk", "Metal", …)
  function styleFor(songStyle) {
    const s = String(songStyle || '').toLowerCase();
    if (/skate|hardcore|thrash/.test(s)) return 'skate'; if (/punk|emo|pop/.test(s)) return 'punk'; if (/metal|core|djent/.test(s)) return 'metal';
    if (/funk|r&b|soul/.test(s)) return 'funk'; if (/disco|dance|house|edm/.test(s)) return 'disco'; if (/blues|shuffle|swing|country/.test(s)) return 'shuffle';
    if (/ska|reggae/.test(s)) return 'ska'; if (/ballad|folk|waltz|acoustic/.test(s)) return 'ballad'; return 'rock';
  }

  // A full drum part: groove per bar with small variations, section-aware (chorus opens up, bridge goes half-time),
  // a fill at the end of every 4th bar and at the end of the part, a crash on the first downbeat.
  //   opts: { seconds, bpm, timeSig:[n,d], style, sectionType, intensity: 'chill'|'normal'|'busy', seed }
  //   → [{ t (s from part start), voice, vel }]
  function generate(opts) {
    const bpm = Number(opts.bpm) || 120, beatSec = 60 / bpm, bpb = (opts.timeSig && opts.timeSig[0]) || 4;
    const seconds = Math.max(beatSec, Number(opts.seconds) || beatSec * bpb * 4);
    const bars = Math.max(1, Math.round(seconds / (beatSec * bpb)));
    const r = rng(Number.isFinite(opts.seed) ? opts.seed : (Math.random() * 2 ** 32) >>> 0);
    const ty = String(opts.sectionType || '').toLowerCase(); const busy = opts.intensity === 'busy' ? 1 : opts.intensity === 'chill' ? -1 : 0;
    let style = STYLES[opts.style] ? opts.style : 'rock';
    if (/bridge|breakdown/.test(ty) && style !== 'blast') style = r() < 0.6 ? 'halftime' : style;
    const st = STYLES[style]; const hits = [];
    const add = (t, voice, vel) => { if (t >= -1e-6 && t < seconds - 1e-6) hits.push({ t: Math.max(0, t), voice, vel: Math.max(0.2, Math.min(1, vel)) }); };
    const chorusy = /chorus|hook|drop|outro/.test(ty);
    const quietIntro = /intro/.test(ty) && busy < 1;
    const fillBar = (b) => b === bars - 1 || (bars > 4 && (b + 1) % 4 === 0 && r() < 0.8);
    for (let b = 0; b < bars; b++) {
      const b0 = b * bpb * beatSec;
      const fill = fillBar(b); const fillBeats = fill ? (bars >= 8 && b === bars - 1 ? 2 : 1) : 0; const fillFrom = b0 + (bpb - fillBeats) * beatSec;
      if (st.triplet) {   // shuffle: triplet feel, hat on the 1st and 3rd triplet of each beat
        for (let k = 0; k < bpb; k++) { const t = b0 + k * beatSec; if (fill && t >= fillFrom) break; add(t, chorusy ? 'ohat' : 'hat', k === 0 ? 0.9 : 0.75); add(t + beatSec * 2 / 3, chorusy ? 'ohat' : 'hat', 0.6); if (k % 2 === 0) add(t, 'kick', k === 0 ? 1 : 0.8); else add(t, 'snare', 1); if (busy > 0 && r() < 0.3) add(t + beatSec * 2 / 3, 'kick', 0.6); }
      } else {
        const step = beatSec / 4; const nSteps = bpb * 4;
        for (let i = 0; i < nSteps; i++) {
          const t = b0 + i * step; if (fill && t >= fillFrom - 1e-6) break;
          const j = i % 16;   // templates are one 4/4 bar; other meters wrap
          const kv = (st.kick || [])[j] || 0, sv = (st.snare || [])[j] || 0, hv = (st.hat || [])[j] || 0, ov = (st.ohat || [])[j] || 0;
          if (kv) add(t, 'kick', kv >= 2 ? 1 : 0.8);
          if (sv) add(t, 'snare', sv >= 2 ? 1 : sv < 1 ? 0.35 : 0.75);
          if (hv && !quietIntro) add(t, chorusy && style !== 'disco' ? 'ohat' : 'hat', (i % 4 === 0 ? 0.85 : 0.65) + (busy < 0 ? -0.1 : 0));
          if (ov) add(t, 'ohat', 0.7);
          // variations: an extra kick, a ghost note, 16th hats when busy
          if (!kv && busy >= 0 && i % 2 === 1 && r() < 0.06 + 0.06 * busy) add(t, 'kick', 0.65);
          if (!sv && busy > 0 && i % 4 === 3 && r() < 0.18) add(t, 'snare', 0.3);
          if (busy > 0 && !hv && !quietIntro && style !== 'metal' && r() < 0.35) add(t, 'hat', 0.45);
        }
        if (!chorusy && busy >= 0 && b % 2 === 1 && r() < 0.35 && !fill) add(b0 + (bpb - 0.5) * beatSec, 'ohat', 0.7);   // open hat at the end of a phrase
        if (quietIntro) for (let k = 0; k < bpb; k++) add(b0 + k * beatSec, 'hat', 0.5);
      }
      if (fill) {   // snare / tom fill over the last beat(s), 16ths (or 8ths when chill)
        const per = busy < 0 ? 2 : 4; const n = fillBeats * per; const pat = r();
        for (let k = 0; k < n; k++) { const t = fillFrom + k * beatSec / per; const v = 0.55 + 0.45 * (k / Math.max(1, n - 1)); const voice = pat < 0.4 ? 'snare' : pat < 0.75 ? (k < n / 2 ? 'snare' : 'tom') : (k % 2 ? 'tom' : 'snare'); add(t, voice, v); if (k === 0) add(t, 'kick', 0.8); }
      }
    }
    if (busy >= 0 && !quietIntro) add(0, 'crash', 1);   // land the part
    if (chorusy) for (let b = 4; b < bars; b += 4) add(b * bpb * beatSec, 'crash', 0.9);
    // one hit per voice per moment
    const seen = new Set(); return hits.filter((h) => { const k = `${h.voice}@${Math.round(h.t * 1000)}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.t - b.t);
  }
  const toNotes = (hits) => hits.map((h) => ({ t: h.t, d: 0.1, n: NOTE[h.voice] || 38, v: h.vel }));
  const fromNotes = (notes) => (notes || []).map((n) => ({ t: n.t, voice: voiceOf(n.n), vel: n.v == null ? 0.8 : n.v })).filter((h) => h.voice);

  return { VOICES, NOTE, voiceOf, FILLS, fillTimes, STYLES, STYLE_IDS, styleFor, generate, toNotes, fromNotes, rng };
});
