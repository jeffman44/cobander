// The audio store: every decoded take the song needs, under a memory budget. A take comes in as an AudioBuffer and
// is kept as one until the song's audio outgrows the float budget; from then on the biggest takes are held as 16-bit
// PCM (half the memory) and the engine plays them in short chunks built on the fly, so a 60-track song fits in a
// laptop's RAM. Entries quack like AudioBuffers (duration, sampleRate, numberOfChannels, length, getChannelData),
// so the rest of the app reads them the same way; `peaks()` is the once-per-take waveform summary the timeline draws
// from, so drawing never walks the samples again. Pure (renderer: window.BPAudioStore; node: require for tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPAudioStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PEAK_BIN = 64;                 // samples per peak bin: fine enough for the deepest zoom (400 px/s at 48 kHz = 120 samples/px)
  const F32_CACHE_BYTES = 160e6;       // float views handed out for analysis of 16-bit takes, kept this long for re-use

  const i16 = (f) => { const n = f.length, o = new Int16Array(n); for (let i = 0; i < n; i++) { let v = f[i] * 32768; v = v < -32768 ? -32768 : v > 32767 ? 32767 : v; o[i] = v < 0 ? Math.ceil(v - 0.5) : Math.floor(v + 0.5); } return o; };
  const f32 = (s, from = 0, to = s.length) => { const o = new Float32Array(to - from); for (let i = from, j = 0; i < to; i++, j++) o[j] = s[i] / 32768; return o; };

  class Entry {
    constructor(store, id, ab) {
      this.store = store; this.id = id;
      this.sampleRate = ab.sampleRate; this.length = ab.length; this.numberOfChannels = ab.numberOfChannels;
      this.ab = ab;                                                    // the AudioBuffer itself while this take is held as float
      this.chans = Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c));
      this.int16 = false; this._f32 = null; this._peaks = null; this.lastUse = ++store._clock;
    }
    get duration() { return this.length / this.sampleRate; }
    get bytes() { return this.length * this.numberOfChannels * (this.int16 ? 2 : 4); }
    touch() { this.lastUse = ++this.store._clock; return this; }
    // Float samples of one channel. For a 16-bit take this is a converted copy (cached briefly for re-use) — fine for
    // one-off analysis (normalize, key, chords, pitch); the timeline uses peaks() and the engine streams chunks.
    getChannelData(c) {
      if (!this.int16) return this.chans[c];
      if (!this._f32) this._f32 = [];
      if (!this._f32[c]) { this._f32[c] = f32(this.chans[c]); this.store._f32Bytes += this.length * 4; this.store._f32Cached.add(this); this.store._trimF32(this); }
      this._f32Hot = ++this.store._clock;
      return this._f32[c];
    }
    copyFromChannel(dst, c, start = 0) { const s = this.int16 ? this.chans[c] : this.chans[c]; const n = Math.min(dst.length, s.length - start); if (this.int16) { for (let i = 0; i < n; i++) dst[i] = s[start + i] / 32768; } else dst.set(s.subarray(start, start + n)); }
    // float samples of frames [a, b) of channel c — chunk playback and windowed analysis
    slice(c, a, b) { const s = this.chans[c]; return this.int16 ? f32(s, a, b) : s.subarray(a, b); }
    // A real AudioBuffer (the held one for float takes; a fresh full copy for 16-bit ones — transient, for analysis only).
    toAudioBuffer(ctx) {
      if (this.ab) return this.ab;
      const b = ctx.createBuffer(this.numberOfChannels, this.length, this.sampleRate);
      for (let c = 0; c < this.numberOfChannels; c++) b.copyToChannel(this.slice(c, 0, this.length), c);
      return b;
    }
    // Waveform summary: per bin of PEAK_BIN frames (channels summed to mono), min / max as Int8 (−127..127 of full scale)
    // and RMS as Uint8 (0..255). ~1.2 MB per 3-minute take instead of walking 8.6 M samples on every draw.
    peaks() {
      if (this._peaks) return this._peaks;
      const n = this.length, bins = Math.ceil(n / PEAK_BIN), nc = this.numberOfChannels;
      const mn = new Int8Array(bins), mx = new Int8Array(bins), rms = new Uint8Array(bins);
      const sc = this.int16 ? 127 / 32768 : 127, scR = this.int16 ? 255 / 32768 : 255;
      for (let b = 0; b < bins; b++) {
        const a = b * PEAK_BIN, z = Math.min(n, a + PEAK_BIN); let lo = Infinity, hi = -Infinity, sq = 0;
        for (let c = 0; c < nc; c++) { const d = this.chans[c]; for (let i = a; i < z; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; sq += v * v; } }
        mn[b] = Math.max(-127, Math.min(127, Math.round(lo * sc))); mx[b] = Math.max(-127, Math.min(127, Math.round(hi * sc)));
        rms[b] = Math.max(0, Math.min(255, Math.round(Math.sqrt(sq / Math.max(1, (z - a) * nc)) * scR)));
      }
      this._peaks = { bin: PEAK_BIN, min: mn, max: mx, rms };
      return this._peaks;
    }
    // Hold this take as 16-bit PCM from now on (the AudioBuffer goes; playback streams chunks). Returns bytes freed.
    toInt16() {
      if (this.int16) return 0;
      const before = this.bytes;
      this.chans = this.chans.map(i16); this.ab = null; this.int16 = true;
      return before - this.bytes;
    }
  }

  class AudioStore {
    // floatBudget: bytes of float audio to hold before the biggest takes drop to 16-bit (0 = always 16-bit)
    constructor({ floatBudget = 512e6 } = {}) { this.map = new Map(); this.floatBudget = floatBudget; this._clock = 0; this._f32Bytes = 0; this._f32Cached = new Set(); }
    get size() { return this.map.size; }
    has(id) { return this.map.has(id); }
    get(id) { const e = this.map.get(id); return e ? e.touch() : undefined; }
    keys() { return this.map.keys(); }
    values() { return this.map.values(); }
    entries() { return this.map.entries(); }
    [Symbol.iterator]() { return this.map[Symbol.iterator](); }
    forEach(fn, self) { this.map.forEach((v, k) => fn.call(self, v, k, this)); }
    delete(id) { const e = this.map.get(id); if (!e) return false; this._dropF32(e); this.map.delete(id); return true; }
    clear() { for (const e of this.map.values()) this._dropF32(e); this.map.clear(); }
    // Accepts an AudioBuffer (or an Entry from another store). Fits the float budget before returning.
    set(id, buf) {
      let e;
      if (buf instanceof Entry) { e = buf; e.store = this; e.id = id; e.touch(); }
      else e = new Entry(this, id, buf);
      const old = this.map.get(id); if (old && old !== e) this._dropF32(old);
      this.map.set(id, e);
      this.fit(e);
      return this;
    }
    floatBytes() { let n = 0; for (const e of this.map.values()) if (!e.int16) n += e.bytes; return n; }
    totalBytes() { let n = 0; for (const e of this.map.values()) n += e.bytes; return n; }
    // Over budget: the biggest float takes go to 16-bit, biggest first, never the one just added if a bigger one exists.
    fit(keep = null) {
      let over = this.floatBytes() - this.floatBudget;
      if (over <= 0) return 0;
      const cands = [...this.map.values()].filter((e) => !e.int16 && e !== keep).sort((a, b) => b.bytes - a.bytes || a.lastUse - b.lastUse);
      if (keep && !keep.int16) cands.push(keep);   // the take just added goes last: it is usually about to be analysed or drawn
      let freed = 0;
      for (const e of cands) { if (over <= 0) break; const f = e.toInt16(); freed += f; over -= f; }
      return freed;
    }
    _dropF32(e) { if (!e._f32) return; this._f32Bytes -= e.length * 4 * e._f32.filter(Boolean).length; e._f32 = null; this._f32Cached.delete(e); }
    _trimF32(keep) { if (this._f32Bytes <= F32_CACHE_BYTES) return; const olds = [...this._f32Cached].filter((e) => e !== keep).sort((a, b) => (a._f32Hot || 0) - (b._f32Hot || 0)); for (const e of olds) { if (this._f32Bytes <= F32_CACHE_BYTES) break; this._dropF32(e); } }
    stats() { let f = 0, i = 0, fb = 0, ib = 0; for (const e of this.map.values()) { if (e.int16) { i++; ib += e.bytes; } else { f++; fb += e.bytes; } } return { entries: this.map.size, float: f, int16: i, floatMB: Math.round(fb / 1e6), int16MB: Math.round(ib / 1e6), f32CacheMB: Math.round(this._f32Bytes / 1e6) }; }
  }
  return { AudioStore, Entry, PEAK_BIN, i16, f32 };
});
