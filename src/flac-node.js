// WAV → FLAC off the main thread (a worker_thread), so encoding a long take never stalls the window's IPC.
// Falls back to encoding inline if a worker can't start. Returns a Buffer, or null when the input isn't integer PCM WAV.
const path = require('path');
const FLAC_JS = path.join(__dirname, 'renderer', 'flac.js');
const flac = require(FLAC_JS);
let Worker = null; try { ({ Worker } = require('worker_threads')); } catch (_) { /* inline only */ }
const SRC = `const { parentPort, workerData } = require('worker_threads'); const f = require(workerData.lib);
parentPort.on('message', ({ id, buf }) => { try { const out = f.fromWavToFlac(new Uint8Array(buf)); parentPort.postMessage({ id, out: out ? out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) : null }, out ? [] : []); } catch (e) { parentPort.postMessage({ id, err: String(e && e.message || e) }); } });`;
let w = null, seq = 0; const jobs = new Map(); let idle = null;
function worker() {
  if (w || !Worker) return w;
  try {
    w = new Worker(SRC, { eval: true, workerData: { lib: FLAC_JS } });
    w.on('message', ({ id, out, err }) => { const j = jobs.get(id); if (!j) return; jobs.delete(id); if (err) j.reject(new Error(err)); else j.resolve(out ? Buffer.from(out) : null); park(); });
    w.on('error', (e) => { for (const j of jobs.values()) j.fallback(); jobs.clear(); w = null; Worker = null; void e; });
    w.unref();
  } catch (_) { w = null; Worker = null; }
  return w;
}
function park() { clearTimeout(idle); idle = null; if (jobs.size || !w) return; w.unref(); idle = setTimeout(() => { if (!jobs.size && w) { w.terminate(); w = null; } }, 30000); if (idle.unref) idle.unref(); }
const inline = (buf) => { const out = flac.fromWavToFlac(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)); return out ? Buffer.from(out.buffer, out.byteOffset, out.byteLength) : null; };
function wavToFlac(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (!isWav(b)) return Promise.resolve(null);
  const ww = worker();
  if (!ww) return Promise.resolve().then(() => inline(b));
  return new Promise((resolve, reject) => {
    const id = ++seq; clearTimeout(idle); ww.ref();
    jobs.set(id, { resolve, reject, fallback: () => { try { resolve(inline(b)); } catch (e) { reject(e); } } });
    const copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    ww.postMessage({ id, buf: copy }, [copy]);
  });
}
const isWav = (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
const isFlac = (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC';
module.exports = { wavToFlac, isWav, isFlac, info: flac.info };
