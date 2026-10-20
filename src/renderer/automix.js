// Auto mix / auto master planning (pure: no audio graph). The app measures each track solo (post-FX, unity fader),
// hands the numbers here, and gets back fader / pan / FX patches it applies through change() — so one Undo puts it back.
// Rules are the ones that worked on American Appetites: an instrument bed at fixed loudness targets per role, vocals
// fitted on top of the bed's short-term loudness, per-role HPF / comp / sends, guitars spread, everything clamped to the
// engine's ranges. Never touches a track's amp (that's the player's tone) or a muted / silent track.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPAutoMix = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ROLES = ['leadVox', 'backVox', 'bass', 'drums', 'gtr', 'keys', 'synth', 'other'];
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(x)) ? Number(x) : lo));
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const db2lin = (d) => Math.pow(10, d / 10);   // power
  const lin2db = (p) => (p > 0 ? 10 * Math.log10(p) : -120);

  // ---------- roles ----------
  const BACK = /harm|backing|\bbgv\b|\bbv\b|\bbvs\b|double|\bdbl\b|oohs?|aahs?|choir|gang|stack|backup/i;
  function role(t) {
    const name = String((t && t.name) || ''), preset = String((t && t.preset) || ''), inst = String((t && t.instrument) || 'audio'), type = String((t && t.type) || '');
    const txt = `${name} ${preset}`;
    if (inst === 'drumkit') return 'drums';
    // a bounced bed ("Backing (no drums)", "instrumental", "full mix") is a bed whatever its type says: it's not a voice
    // to EQ like one even when someone made it on a vocal-type track (seen on a real song)
    if (/\bbacking\b(?!\s*vo|\s*vox)|\(no drums\)|instrumental|\bbed\b|full mix|\bstems?\b|\bbounce\b|\bmix\b/i.test(name) && !/\bvo(x|cals?)\b/i.test(name.replace(/\(no drums\)/i, ''))) return 'other';
    if (inst === 'synth:voice') return BACK.test(txt) ? 'backVox' : 'leadVox';
    if (inst === 'synth:bassgtr' || (inst.startsWith('synth:') && /\bbass\b/i.test(txt))) return 'bass';
    if (/^synth:(cleangtr|crunchgtr|distgtr|mutegtr|acoustic)$/.test(inst)) return 'gtr';
    if (type === 'vocals') return BACK.test(txt) ? 'backVox' : 'leadVox';
    if (type === 'bass') return 'bass';
    if (type === 'drums') return 'drums';
    if (type === 'guitar') return 'gtr';
    if (type === 'keys') return 'keys';
    if (/\bbass\b/i.test(txt)) return 'bass';
    if (/drum|kick|snare|\bhats?\b|overhead|\boh\b|\btoms?\b|\bkit\b|perc|cymbal/i.test(txt)) return 'drums';
    if (/g(ui)?ta?r|rhythm|\briff|\bacoustic|\belec/i.test(txt)) return 'gtr';
    if (/\bvox\b|vocal|voice|sing|\blead\b|harm|\bbgv\b|\bbv\b|choir/i.test(txt)) return BACK.test(txt) ? 'backVox' : 'leadVox';
    if (/key|piano|organ|rhodes|wurli|\bep\b/i.test(txt)) return 'keys';
    if (inst.startsWith('synth:')) return 'synth';
    return 'other';
  }
  const isGuide = (t) => String((t && t.instrument) || '') === 'synth:voice';

  // ---------- what the caller measures ----------
  function analysisNeeded() {
    return {
      perTrack: 'render the track solo, post-FX, fader at 0 dB, pan centre, master at unity (engine.render({ soloTrackId, unityMaster: true, exact: true }) over the song)',
      lufs: 'integrated loudness, LUFS (engine.analyzeBuffer(buf).lufsApprox, or BPAutoMix.integratedLufs(channels, sr))',
      shortTerm: 'number[]: LUFS in 3 s windows, 1 s hop, -120 where silent — BPAutoMix.shortTermLufs(channels, sr); all tracks must share the same timeline (same from/to)',
      peakDb: 'sample peak dBFS (analyzeBuffer(buf).peakDbfs)',
      bands: 'band levels in dB: engine.analyzeBuffer(buf).bandsDbfs ({sub, low, lowMid, mid, high, air}) — absolute is fine, they are made relative here',
      monoish: 'true when L and R are (nearly) the same signal',
      mix: 'for planMaster: the whole mix rendered at master 0 dB: { lufs, peakDb } (engine.analyzeMix())',
    };
  }

  // ---------- K-weighted loudness helpers (BS.1770; any sample rate) ----------
  function biquad(x, b0, b1, b2, a1, a2) {
    const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i]; const o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = o; y[i] = o; }
    return y;
  }
  function kWeight(x, sr) {
    // stage 1: high shelf (+4 dB above ~1.5 kHz); stage 2: RLB high-pass ~38 Hz — coefficients as in pyloudnorm
    let G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.974450955533;
    let A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / sr, al = Math.sin(w0) / (2 * Q), c = Math.cos(w0);
    let a0 = (A + 1) - (A - 1) * c + 2 * Math.sqrt(A) * al;
    const s1 = biquad(x, A * ((A + 1) + (A - 1) * c + 2 * Math.sqrt(A) * al) / a0, -2 * A * ((A - 1) + (A + 1) * c) / a0, A * ((A + 1) + (A - 1) * c - 2 * Math.sqrt(A) * al) / a0, 2 * ((A - 1) - (A + 1) * c) / a0, ((A + 1) - (A - 1) * c - 2 * Math.sqrt(A) * al) / a0);
    Q = 0.5003270373238773; fc = 38.13547087602444; w0 = 2 * Math.PI * fc / sr; al = Math.sin(w0) / (2 * Q); c = Math.cos(w0); a0 = 1 + al;
    return biquad(s1, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0);
  }
  // mean K-weighted power per block (summed over channels)
  function blockPowers(channels, sr, win, hop) {
    const k = channels.slice(0, 2).map((c) => kWeight(c, sr)); const n = k[0].length; const W = Math.max(1, Math.round(win * sr)), H = Math.max(1, Math.round(hop * sr));
    // prefix sums of squares → any window in O(1)
    const pre = new Float64Array(n + 1); for (let i = 0; i < n; i++) { let s = 0; for (const ch of k) s += ch[i] * ch[i]; pre[i + 1] = pre[i] + s; }
    const out = []; for (let i = 0; i + W <= n; i += H) out.push((pre[i + W] - pre[i]) / W);
    if (!out.length && n) out.push(pre[n] / n);
    return out;
  }
  const toL = (p) => (p > 1e-12 ? -0.691 + 10 * Math.log10(p) : -120);
  function shortTermLufs(channels, sr, { win = 3, hop = 1, floor = -70 } = {}) { return blockPowers(channels, sr, win, hop).map((p) => { const l = toL(p); return l < floor ? -120 : r1(l); }); }
  function integratedLufs(channels, sr) {
    const ps = blockPowers(channels, sr, 0.4, 0.1); let a = ps.filter((p) => toL(p) > -70); if (!a.length) return -120;
    const rel = toL(a.reduce((x, y) => x + y, 0) / a.length) - 10; a = a.filter((p) => toL(p) > rel); if (!a.length) return -120;
    return r1(toL(a.reduce((x, y) => x + y, 0) / a.length));
  }

  // ---------- the mix ----------
  const BED = { drums: -19.5, bass: -23.5, gtr: -20, keys: -24, synth: -24, other: -23 };
  const HPF = { leadVox: 95, backVox: 110, gtr: 80, bass: 35, drums: 32, keys: 60, synth: 45, other: 40 };
  const COMP = { leadVox: { threshold: -24, ratio: 3.5, attack: 0.005, release: 0.1 }, backVox: { threshold: -24, ratio: 4, attack: 0.004, release: 0.1 }, bass: { threshold: -22, ratio: 4, attack: 0.006, release: 0.09 }, drums: { threshold: -18, ratio: 3, attack: 0.01, release: 0.11 } };
  const SEND = { leadVox: 0.2, backVox: 0.25, drums: 0.1 };
  // bands → relative dB (loudest band = 0), accepting the engine's names or the short ones
  function relBands(b) {
    if (!b) return null;
    const v = { sub: b.sub, low: b.low, lowmid: b.lowmid != null ? b.lowmid : b.lowMid, mid: b.mid, presence: b.presence != null ? b.presence : b.high, air: b.air };
    const vals = Object.values(v).filter((x) => Number.isFinite(x)); if (!vals.length) return null; const mx = Math.max(...vals);
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = Number.isFinite(x) ? x - mx : null; return o;
  }
  const audible = (t) => !t.mute && (t.instrument === 'drumkit' || (Array.isArray(t.clips) && t.clips.some((c) => c && !c.mute)));
  // tracks: Cobander tracks (as in song.json); analysis: { [trackId]: {lufs, shortTerm, peakDb, bands, monoish} }
  function planMix(tracks, analysis, { style = '' } = {}) {
    void style;
    const out = { tracks: {}, notes: [] }; const A = analysis || {};
    const list = (tracks || []).filter((t) => t && t.id != null);
    const live = list.filter((t) => audible(t) && A[t.id] && Number.isFinite(A[t.id].lufs) && A[t.id].lufs > -70);
    for (const t of list) if (!live.includes(t)) out.notes.push(`${t.name}: left alone (${t.mute ? 'muted' : !audible(t) ? 'nothing playing' : 'not measured / silent'})`);
    const R = new Map(live.map((t) => [t.id, role(t)]));
    const of = (r) => live.filter((t) => R.get(t.id) === r);
    const gtrs = of('gtr');
    // 1) instrument bed: each role to its target (several guitars share the guitar loudness: −3 dB each per doubling)
    const gain = new Map();
    for (const t of live) {
      const r = R.get(t.id); if (r === 'leadVox' || r === 'backVox') continue;
      const n = r === 'gtr' ? gtrs.length : of(r).length;
      const tgt = (BED[r] != null ? BED[r] : BED.other) - (n > 1 ? 10 * Math.log10(n) : 0);
      gain.set(t.id, tgt - A[t.id].lufs);
    }
    // the bed's short-term loudness (power sum of the gained instrument tracks)
    const bedIds = [...gain.keys()]; const len = Math.max(0, ...live.map((t) => (A[t.id].shortTerm || []).length));
    const bed = []; for (let i = 0; i < len; i++) { let p = 0; for (const id of bedIds) { const s = (A[id].shortTerm || [])[i]; if (Number.isFinite(s) && s > -70) p += db2lin(s + gain.get(id)); } bed.push(p > 0 ? lin2db(p) : -120); }
    const bedInt = bedIds.length ? lin2db(bedIds.reduce((p, id) => p + db2lin(A[id].lufs + gain.get(id)), 0)) : null;
    // 2) vocals fitted on top of the bed where they sing
    const fit = (t, offset) => {
      const st = A[t.id].shortTerm || []; const d = [];
      for (let i = 0; i < Math.min(st.length, bed.length); i++) if (st[i] > -60 && bed[i] > -60) d.push(bed[i] - st[i]);
      const m = median(d);
      if (m != null) return m + offset;
      return (bedInt != null ? bedInt : -20) - A[t.id].lufs + offset;   // no overlap with the bed: fit to its integrated level
    };
    const leads = of('leadVox'), backs = of('backVox');
    const realLeads = leads.filter((t) => !isGuide(t)); const leadRef = realLeads[0] || leads[0] || null;
    for (const t of leads) gain.set(t.id, fit(t, t === leadRef ? -0.5 : -2));
    const leadAbs = leadRef ? A[leadRef.id].lufs + gain.get(leadRef.id) : null;
    backs.forEach((t, i) => { if (leadAbs != null) gain.set(t.id, (leadAbs - (5 + Math.min(2, i))) - A[t.id].lufs); else gain.set(t.id, fit(t, -5)); });
    // 3) per-track fader / pan / FX patch
    const pans = new Map(); const spread = [-0.7, 0.7, -0.4, 0.4, -0.85, 0.85];
    gtrs.forEach((t, i) => pans.set(t.id, gtrs.length === 1 ? 0 : spread[i % spread.length]));
    backs.forEach((t, i) => pans.set(t.id, backs.length === 1 ? -0.3 : (i % 2 ? 0.45 : -0.45)));
    of('keys').forEach((t, i, a) => pans.set(t.id, a.length === 1 ? (gtrs.length === 1 ? 0.3 : 0) : (i % 2 ? 0.35 : -0.35)));
    for (const t of live) {
      const r = R.get(t.id); const a = A[t.id]; const bands = relBands(a.bands); const why = [];
      const fx = {}; const cur = t.fx || {};
      let g = gain.get(t.id); if (!Number.isFinite(g)) g = 0;
      // the measurement is at unity fader, so this is the absolute fader setting
      const gainDb = r1(clamp(g, -60, 12));
      fx.hpf = { on: true, hz: clamp(r === 'leadVox' && bands && bands.low != null && bands.low > -6 ? 110 : HPF[r] || 40, 20, 1000) };
      why.push(`HPF ${fx.hpf.hz} Hz`);
      const eq = { on: true, low: { hz: 120, db: 0 }, mid: { hz: 1000, db: 0, q: 1 }, high: { hz: 8000, db: 0 } };
      if (bands && bands.lowmid != null && bands.mid != null && bands.lowmid - bands.mid > 3 && r !== 'bass' && r !== 'drums') { const cut = r1(clamp(-(bands.lowmid - bands.mid - 3) * 0.6 - 1.5, -6, -1.5)); eq.mid = { hz: r === 'gtr' ? 350 : 300, db: cut, q: 1 }; why.push(`mud cut ${cut} dB @ ${eq.mid.hz} Hz`); }
      if (r === 'drums' && bands && bands.lowmid != null && bands.low != null && bands.lowmid > bands.low - 2) { eq.mid = { hz: 380, db: -3, q: 1 }; why.push('boxy cut −3 dB @ 380 Hz'); }
      if ((r === 'leadVox' || r === 'backVox') && bands && bands.presence != null && bands.presence < -12) { const lift = r1(clamp((-12 - bands.presence) * 0.5 + 2, 2, 5)); eq.high = { hz: r === 'leadVox' ? 5000 : 4000, db: lift }; why.push(`presence +${lift} dB`); }
      if (r === 'leadVox' || r === 'backVox') { eq.low = { hz: 230, db: -2 }; }
      if (r === 'bass') { eq.low = { hz: 90, db: 1.5 }; eq.mid = { hz: 800, db: 1.5, q: 0.9 }; }
      if (r === 'drums') eq.high = { hz: 8000, db: 2 };
      fx.eq = eq;
      if (COMP[r]) { fx.comp = { on: true, ...COMP[r], knee: 6, makeup: 0 }; why.push(`comp ${COMP[r].ratio}:1`); }
      const send = SEND[r] || 0; fx.reverbSend = r2(clamp(send, 0, 1)); if (send) why.push(`reverb ${Math.round(send * 100)}%`);
      if (cur.amp && cur.amp.on) { /* the player's amp stays exactly as it is */ }
      const pan = r2(clamp(pans.has(t.id) ? pans.get(t.id) : 0, -1, 1));
      out.tracks[t.id] = { gainDb, pan, fx, role: r };
      out.notes.push(`${t.name} (${r}${isGuide(t) ? ', guide' : ''}): ${gainDb >= 0 ? '+' : ''}${gainDb} dB, ${why.join(', ')}${pan ? `, pan ${pan < 0 ? 'L' : 'R'} ${Math.round(Math.abs(pan) * 100)}` : ''}`);
    }
    return out;
  }

  // mix: { lufs (integrated, master at 0 dB), peakDb (sample peak, or a true-peak estimate) }
  function planMaster(mix, { target = -14, ceiling = -1, maxPush = 6 } = {}) {
    const notes = []; const l = Number(mix && mix.lufs); const pk = Number(mix && mix.peakDb);
    if (!Number.isFinite(l) || l <= -70) return { gainDb: 0, limiter: true, notes: ['nothing measurable in the mix — master left at 0 dB'] };
    let g = target - l;
    // the limiter (ceiling −1 dBFS) catches what goes over; don't make it work more than maxPush dB on the peaks
    if (Number.isFinite(pk)) { const over = pk + g - ceiling; if (over > maxPush) { const g2 = g - (over - maxPush); notes.push(`capped at ${r1(g2)} dB so the limiter isn't squashing more than ${maxPush} dB of peaks (would have been ${r1(g)} dB)`); g = g2; } }
    g = r1(clamp(g, -60, 12));
    notes.unshift(`mix ${r1(l)} LUFS → target ${target} LUFS: master ${g >= 0 ? '+' : ''}${g} dB, limiter on (ceiling ${ceiling} dBFS)`);
    return { gainDb: g, limiter: true, expectedLufs: r1(l + g), notes };
  }

  // before / after: [{id, name, gainDb, pan, fx}] lists (or {tracks:[]} songs) → ["Vox: +2.0 dB, HPF 95 Hz, comp 3.5:1, pan L 70"]
  function diff(before, after) {
    const B = Array.isArray(before) ? before : (before && before.tracks) || []; const Aa = Array.isArray(after) ? after : (after && after.tracks) || [];
    const lines = [];
    for (const a of Aa) {
      const b = B.find((x) => x.id === a.id); if (!b) continue; const bits = []; const bf = b.fx || {}, af = a.fx || {};
      const dg = (Number(a.gainDb) || 0) - (Number(b.gainDb) || 0); if (Math.abs(dg) >= 0.05) bits.push(`${dg > 0 ? '+' : ''}${dg.toFixed(1)} dB`);
      const on = (f) => f && f.on;
      if (on(af.hpf) && (!on(bf.hpf) || bf.hpf.hz !== af.hpf.hz)) bits.push(`HPF ${Math.round(af.hpf.hz)} Hz`); else if (on(bf.hpf) && !on(af.hpf)) bits.push('HPF off');
      if (on(af.lpf) && (!on(bf.lpf) || bf.lpf.hz !== af.lpf.hz)) bits.push(`LPF ${Math.round(af.lpf.hz)} Hz`);
      if (on(af.eq)) { for (const k of ['low', 'mid', 'high']) { const x = af.eq[k], y = on(bf.eq) ? bf.eq[k] : null; if (x && x.db && (!y || y.db !== x.db || y.hz !== x.hz)) bits.push(`EQ ${x.db > 0 ? '+' : ''}${x.db} dB @ ${x.hz >= 1000 ? `${r1(x.hz / 1000)}k` : Math.round(x.hz)}`); } }
      if (on(af.comp) && (!on(bf.comp) || bf.comp.ratio !== af.comp.ratio || bf.comp.threshold !== af.comp.threshold)) bits.push(`comp ${af.comp.ratio}:1`); else if (on(bf.comp) && !on(af.comp)) bits.push('comp off');
      if ((Number(af.reverbSend) || 0) !== (Number(bf.reverbSend) || 0)) bits.push(`reverb ${Math.round((Number(af.reverbSend) || 0) * 100)}%`);
      const pa = Number(a.pan) || 0; if (Math.abs(pa - (Number(b.pan) || 0)) >= 0.01) bits.push(pa ? `pan ${pa < 0 ? 'L' : 'R'} ${Math.round(Math.abs(pa) * 100)}` : 'pan centre');
      if (bits.length) lines.push(`${a.name || b.name}: ${bits.join(', ')}`);
    }
    return lines;
  }
  // a track with the plan's patch applied (deep merge of fx; the amp is never part of a patch)
  function applyPlan(track, p) {
    if (!p) return track; const fx = JSON.parse(JSON.stringify(track.fx || {}));
    for (const [k, v] of Object.entries(p.fx || {})) { if (k === 'amp') continue; fx[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(fx[k] || {}), ...JSON.parse(JSON.stringify(v)) } : v; }
    return { ...track, gainDb: p.gainDb, pan: p.pan, fx };
  }
  return { ROLES, role, isGuide, analysisNeeded, planMix, planMaster, diff, applyPlan, shortTermLufs, integratedLufs, kWeight };
});
