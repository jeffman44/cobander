// Note reading off the UI thread (Practice keeps scrolling while a 3-minute take is read).
// In:  {id, op: 'tab' | 'notes', mono: Float32Array, sr, instrument, beats?: [{t, beat}] (the take's own time), key?}
// Out: {id, progress} while it works, then {id, ok, result: {events, notes, tuningCents, key, engine}} | {id, ok:false, error}.
// The ears are the note tracker (nmp.js + models/nmp.onnx on ONNX Runtime); notes.js writes the notes down like a player.
// If the tracker can't start (no WebAssembly, model missing) the older spectrum reader (tab.js) answers instead.
importScripts('tuner.js', 'music.js', 'pitchcheck.js', 'tab.js', 'nmp.js', 'notes.js');
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
    if (d.instrument === 'voice') {   /* singing: the single-pitch tracker hears it, notes.js decides what was meant */
      const PC = self.BPPitchCheck; const sung = PC.track(d.mono, d.sr);
      const r = self.BPNotes.fromSung(sung, { beats: d.beats || null, key: d.key || null, chords: d.chords || null });
      postMessage({ id: d.id, ok: true, result: { events: [], notes: r.notes, key: r.key, tuningCents: 0, engine: 'pitch' } }); return;
    }
    try {
      const { ort, session } = await tracker();
      const post = await self.BPNmp.run(ort, session, d.mono, d.sr, { onProgress: (p) => postMessage({ id: d.id, progress: p }) });
      const r = self.BPNotes.transcribe(post, { instrument: d.instrument, beats: d.beats || null, key: d.key || null, chords: d.chords || null });
      result = { events: r.events, notes: r.notes, tuningCents: r.tuningCents, key: r.key, engine: 'nmp' };
    } catch (err) {
      if (d.op === 'notes') throw err;
      const r = self.BPTab.transcribe(d.mono, d.sr, { instrument: d.instrument });
      result = { events: r.events, notes: null, tuningCents: r.tuningCents, engine: 'dsp', why: String((err && err.message) || err) };
    }
    postMessage({ id: d.id, ok: true, result });
  } catch (err) { postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) }); }
};
