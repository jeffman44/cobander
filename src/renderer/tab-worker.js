// Note reading off the UI thread (Practice keeps scrolling while a 3-minute take is read).
// In:  {id, op: 'tab' | 'notes', mono: Float32Array, sr, instrument, beats?: [{t, beat}] (the take's own time), key?}
// Out: {id, progress} while it works, then {id, ok, result: {events, notes, tuningCents, key, engine}} | {id, ok:false, error}.
// The ears are the note tracker (nmp.js + models/nmp.onnx on ONNX Runtime); notes.js writes the notes down like a player.
// If the tracker can't start (no WebAssembly, model missing) the older spectrum reader (tab.js) answers instead.
importScripts('tuner.js', 'music.js', 'pitchcheck.js', 'tab.js', 'nmp.js', 'notes.js', 'drumtx.js');
let ortP = null;
function tracker() {
  if (!ortP) ortP = (async () => {
    const ort = await import('./vendor/ort.min.mjs');
    ort.env.wasm.wasmPaths = new URL('./vendor/', self.location.href).href; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    const model = await (await fetch(new URL('./models/nmp.onnx', self.location.href).href)).arrayBuffer();
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    return { ort, session };
  })().catch((err) => { ortP = null; throw err; });
  return ortP;
}
self.onmessage = async (e) => {
  const d = e.data || {};
  try {
    let result;
    if (d.op === 'drums') {   /* drum hits: kick / snare / hats / cymbals, snapped to the grid */
      const r = self.BPDrumTx.transcribe(d.mono, d.sr, { beats: d.beats || null });
      postMessage({ id: d.id, ok: true, result: { hits: r.hits, engine: 'drums' } }); return;
    }
    if (d.instrument === 'voice') {   /* singing: the single-pitch tracker hears it, notes.js decides what was meant */
      const PC = self.BPPitchCheck; const sung = PC.track(d.mono, d.sr);
      const r = self.BPNotes.fromSung(sung, { beats: d.beats || null, key: d.key || null, chords: d.chords || null });
      postMessage({ id: d.id, ok: true, result: { events: [], notes: r.notes, key: r.key, tuningCents: 0, engine: 'pitch' } }); return;
    }
    try {
      const { ort, session } = await tracker();
      let post = await self.BPNmp.run(ort, session, d.mono, d.sr, { onProgress: (p) => postMessage({ id: d.id, progress: p * 0.6 }) });
      // a band tuned to itself 15-45 cents off A440 makes the tracker split every note between two keys: hear it again
      // with the audio declared at the rate that puts it on pitch, and scale the times back (k = apparent / real)
      const off = self.BPNotes.tuningOffset(post); let k = 1;
      if (Math.abs(off) > 10) { const sr2 = d.sr / 2 ** (off / 1200); k = d.sr / sr2; post = await self.BPNmp.run(ort, session, d.mono, sr2, { onProgress: (p) => postMessage({ id: d.id, progress: 0.6 + p * 0.4 }) }); }
      const beats = d.beats ? d.beats.map((b) => ({ ...b, t: b.t * k })) : null;
      const r = self.BPNotes.transcribe(post, { instrument: d.instrument, beats, key: d.key || null, chords: d.chords ? d.chords.map((c) => ({ ...c, ...(c.t != null ? { t: c.t * k } : {}), ...(c.time != null ? { time: c.time * k } : {}), ...(c.end != null ? { end: c.end * k } : {}), ...(c.duration != null ? { duration: c.duration * k } : {}) })) : null });
      const back = (x) => Math.round((x / k) * 1000) / 1000;
      if (k !== 1) { for (const e of r.events) { e.t = back(e.t); e.d = back(e.d); } for (const n of r.notes) { n.t = back(n.t); n.d = back(n.d); } }
      result = { events: r.events, notes: r.notes, tuningCents: off, key: r.key, engine: 'nmp' };
    } catch (err) {
      if (d.op === 'notes') throw err;
      const r = self.BPTab.transcribe(d.mono, d.sr, { instrument: d.instrument });
      result = { events: r.events, notes: null, tuningCents: r.tuningCents, engine: 'dsp', why: String((err && err.message) || err) };
    }
    postMessage({ id: d.id, ok: true, result });
  } catch (err) { postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) }); }
};
