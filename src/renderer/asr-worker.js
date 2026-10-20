// Runs Whisper off the UI thread. Messages in: {id, op:'run', model, audio(Float32Array 16 kHz)}; replies {id, ok, result|error}
// and {id, progress}. Model files come from the page's cache bridge: {cache:'get'|'put', key, url, buf} round trips.
let tx = null; const pipes = new Map(); let seq = 0; const waits = new Map();
const ask = (msg, transfer) => new Promise((resolve) => { const key = ++seq; waits.set(key, resolve); postMessage({ ...msg, key }, transfer || []); });
self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.cacheReply) { const r = waits.get(d.key); if (r) { waits.delete(d.key); r(d.buf || null); } return; }
  if (d.op !== 'run') return;
  try {
    if (!tx) {
      tx = await import('./vendor/transformers.min.js');
      tx.env.allowLocalModels = false; tx.env.useBrowserCache = false; tx.env.useCustomCache = true;
      tx.env.customCache = {
        async match(req) { const url = typeof req === 'string' ? req : req.url; const b = await ask({ cache: 'get', url }); return b ? new Response(b) : undefined; },
        async put(req, res) { const url = typeof req === 'string' ? req : req.url; try { const b = await res.arrayBuffer(); await ask({ cache: 'put', url, buf: b }, [b]); } catch (_) { /* not cached: downloads again next time */ } },
      };
      const ow = tx.env.backends.onnx.wasm; ow.wasmPaths = new URL('./vendor/', self.location.href).href; ow.proxy = false;
      ow.numThreads = d.threads || 1;
    }
    let p = pipes.get(d.model);
    if (!p) { p = tx.pipeline('automatic-speech-recognition', d.model, { dtype: 'q8', progress_callback: (ev) => { if (ev && ev.status === 'progress') postMessage({ id: d.id, progress: { file: ev.file, pct: ev.progress } }); } }); pipes.set(d.model, p); p.catch(() => pipes.delete(d.model)); }
    const asr = await p;
    const r = await asr(d.audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    postMessage({ id: d.id, ok: true, result: { text: r.text, chunks: r.chunks } });
  } catch (err) { postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) }); }
};
