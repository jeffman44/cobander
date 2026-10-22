// Tab transcription off the UI thread (a 3-minute guitar take is seconds of number crunching; Practice keeps scrolling).
// In: {id, mono: Float32Array, sr, instrument}. Out: {id, ok, result: {events, tuningCents}} | {id, ok:false, error}.
importScripts('tuner.js', 'music.js', 'pitchcheck.js', 'tab.js');
self.onmessage = (e) => {
  const d = e.data || {};
  try { const r = self.BPTab.transcribe(d.mono, d.sr, { instrument: d.instrument }); postMessage({ id: d.id, ok: true, result: { events: r.events, tuningCents: r.tuningCents } }); }
  catch (err) { postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) }); }
};
