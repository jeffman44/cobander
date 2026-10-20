// Lossless FLAC encoder (pure JS, no deps): takes are stored as FLAC — bit-for-bit the same audio as a 24-bit WAV at
// roughly half the size on the band Drive. Fixed linear predictors (order 0–4, best per block and channel), stereo
// decorrelation (left/side, right/side or mid/side, whichever is smallest), constant subframes for silence, Rice-coded
// residuals with partitioned parameters. Decoding is left to the platform (Chromium, every DAW, ffmpeg).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPFlac = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  class BitWriter {
    constructor(cap = 1 << 20) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.n = 0; }
    grow(need) { if (this.pos + need + 8 <= this.buf.length) return; let c = this.buf.length * 2; while (c < this.pos + need + 8) c *= 2; const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.pos)); this.buf = b; }
    // write `bits` (≤ 24) low bits of v
    w(v, bits) {
      if (bits > 24) { const hi = Math.floor(v / 2 ** (bits - 24)); this.w(hi & 0xffffff, 24); this.w(v - hi * 2 ** (bits - 24), bits - 24); return; }
      this.acc = (this.acc * (1 << bits)) + (v & ((1 << bits) - 1)) >>> 0; this.n += bits;
      while (this.n >= 8) { this.grow(1); this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 0xff; }
      this.acc &= (1 << this.n) - 1;
    }
    unary0(q) { while (q >= 24) { this.w(0, 24); q -= 24; } this.w(1, q + 1); }   // q zeros then a one
    align() { if (this.n) this.w(0, 8 - this.n); }
    bytes() { return this.buf.subarray(0, this.pos); }
  }
  const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c; let d = i << 8; for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d; }
  const crc8 = (b, a, z) => { let c = 0; for (let i = a; i < z; i++) c = CRC8[c ^ b[i]]; return c; };
  const crc16 = (b, a, z) => { let c = 0; for (let i = a; i < z; i++) c = ((c << 8) ^ CRC16[(c >> 8) ^ b[i]]) & 0xffff; return c; };
  const zig = (r) => (r >= 0 ? 2 * r : -2 * r - 1);

  function residuals(x, order) {
    const n = x.length, r = new Float64Array(n);
    for (let i = order; i < n; i++) {
      switch (order) {
        case 0: r[i] = x[i]; break;
        case 1: r[i] = x[i] - x[i - 1]; break;
        case 2: r[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
        case 3: r[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
        default: r[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
      }
    }
    return r;
  }
  // Rice parameter + estimated bits for a partition from the sum of its zig-zagged residuals (exact enough to choose)
  function estK(sum, n) { if (n <= 0) return { k: 0, bits: 0 }; const mean = sum / n; let k = mean > 1 ? Math.floor(Math.log2(mean)) : 0; if (k > 14) k = 14; return { k, bits: n * (k + 1) + Math.floor(sum / 2 ** k) }; }
  function planResidual(z, n, order) {
    const pre = new Float64Array(n + 1); for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (i >= order ? z[i] : 0);
    let best = null;
    for (let p = 0; p <= 8; p++) {
      if (n % (1 << p) || (n >> p) <= order) break;
      const ps = n >> p; let bits = 0; const ks = [];
      for (let j = 0; j < (1 << p); j++) { const a = j === 0 ? order : j * ps, b = (j + 1) * ps; const e = estK(pre[b] - pre[a], b - a); ks.push(e.k); bits += e.bits + 4; }
      if (!best || bits < best.bits) best = { p, ks, bits };
    }
    return best;
  }
  // one channel's samples (ints) → subframe plan {bits, write(bw)}
  function subframe(x, bps) {
    const n = x.length;
    let allSame = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { allSame = false; break; }
    if (allSame) return { bits: 8 + bps, write: (bw) => { bw.w(0, 8); bw.w(x[0] < 0 ? x[0] + 2 ** bps : x[0], bps); } };
    // pick the predictor order by total |residual| (one pass each), then plan only that one
    let bo = 0, bs = Infinity;
    for (let order = 0; order <= Math.min(4, n - 1); order++) {
      let s = 0;
      for (let i = order; i < n; i++) {
        const r = order === 0 ? x[i] : order === 1 ? x[i] - x[i - 1] : order === 2 ? x[i] - 2 * x[i - 1] + x[i - 2] : order === 3 ? x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3] : x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
        s += r < 0 ? -r : r;
      }
      if (s < bs) { bs = s; bo = order; }
    }
    const order = bo; const r = residuals(x, order); const z = new Float64Array(n); for (let i = order; i < n; i++) z[i] = zig(r[i]);
    const plan = planResidual(z, n, order);
    const est = plan ? 8 + order * bps + 6 + plan.bits : Infinity;
    const verbatim = 8 + n * bps;
    if (!plan || est >= verbatim) return { bits: verbatim, write: (bw) => { bw.w(1 << 1, 8); for (let i = 0; i < n; i++) bw.w(x[i] < 0 ? x[i] + 2 ** bps : x[i], bps); } };
    return {
      bits: est,
      write: (bw) => {
        bw.w((8 + order) << 1, 8);   // 0 pad, 001xxx fixed, no wasted bits
        for (let i = 0; i < order; i++) bw.w(x[i] < 0 ? x[i] + 2 ** bps : x[i], bps);
        bw.w(0, 2); bw.w(plan.p, 4);
        const ps = n >> plan.p;
        for (let j = 0; j < (1 << plan.p); j++) {
          const k = plan.ks[j], a = j === 0 ? order : j * ps, b = (j + 1) * ps; bw.w(k, 4); const m = 2 ** k;
          for (let i = a; i < b; i++) { const u = z[i]; const q = Math.floor(u / m); bw.unary0(q); if (k) bw.w(u - q * m, k); }
        }
      },
    };
  }
  function utf8Num(bw, v) {   // FLAC's UTF-8-style frame number
    if (v < 0x80) { bw.w(v, 8); return; }
    let len = 2; while (len < 7 && v >= 2 ** (5 * len + 1)) len++;
    const tail = []; let x = v; for (let i = 1; i < len; i++) { tail.unshift(0x80 | (x % 64)); x = Math.floor(x / 64); }
    bw.w(((0xff << (8 - len)) & 0xff) | x, 8); for (const b of tail) bw.w(b, 8);
  }
  // channels: Float32Array[] (−1…1); bits: 16 or 24 → Uint8Array (a complete .flac file)
  function encode(channels, sampleRate, { bits = 24, blockSize = 4096 } = {}) {
    const total = channels[0].length, scale = 2 ** (bits - 1) - 1;
    const ints = channels.map((c) => { const o = new Int32Array(total); for (let i = 0; i < total; i++) { let v = c[i]; v = v > 1 ? 1 : v < -1 ? -1 : v; o[i] = Math.round(v * scale); } return o; });
    return encodeInts(ints, sampleRate, { bits, blockSize });
  }
  // integer samples (Int32Array per channel) → .flac bytes; bit-exact with the PCM it came from
  function encodeInts(ints, sampleRate, { bits = 24, blockSize = 4096 } = {}) {
    const nch = ints.length, total = ints[0].length;
    const bw = new BitWriter(Math.max(1 << 16, Math.floor(total * nch * bits / 8 * 0.7)));
    bw.w(0x664c6143 >>> 8, 24); bw.w(0x43, 8);   // "fLaC"
    bw.w(0x80, 8); bw.w(34, 24);                 // last metadata block: STREAMINFO, 34 bytes
    bw.w(blockSize, 16); bw.w(blockSize, 16); bw.w(0, 24); bw.w(0, 24);
    bw.w(sampleRate, 20); bw.w(nch - 1, 3); bw.w(bits - 1, 5); bw.w(Math.floor(total / 2 ** 32), 4); bw.w(total >>> 0, 32);
    for (let i = 0; i < 16; i++) bw.w(0, 8);       // MD5 not computed (allowed)
    const bpsCode = bits === 16 ? 4 : bits === 24 ? 6 : bits === 8 ? 1 : 0;
    for (let f = 0, start = 0; start < total; f++, start += blockSize) {
      const n = Math.min(blockSize, total - start);
      const xs = ints.map((c) => c.subarray(start, start + n));
      // stereo: try the four channel assignments, keep the smallest
      let assign = nch - 1, plans = null;
      const indep = xs.map((x) => subframe(x, bits));
      plans = indep; let size = indep.reduce((s, p) => s + p.bits, 0);
      if (nch === 2) {
        const L = xs[0], R = xs[1]; const side = new Int32Array(n), mid = new Int32Array(n);
        for (let i = 0; i < n; i++) { side[i] = L[i] - R[i]; mid[i] = (L[i] + R[i]) >> 1; }
        const sS = subframe(side, bits + 1), sM = subframe(mid, bits);
        const cands = [[8, [indep[0], sS]], [9, [sS, indep[1]]], [10, [sM, sS]]];
        for (const [a, p] of cands) { const b = p[0].bits + p[1].bits; if (b < size) { size = b; assign = a; plans = p; } }
      }
      const h0 = bw.pos;
      bw.w(0x3ffe, 14); bw.w(0, 1); bw.w(0, 1); bw.w(0b0111, 4); bw.w(0, 4); bw.w(assign, 4); bw.w(bpsCode, 3); bw.w(0, 1);
      utf8Num(bw, f); bw.w(n - 1, 16);
      bw.w(crc8(bw.buf, h0, bw.pos), 8);
      plans.forEach((p) => p.write(bw));
      bw.align(); const c = crc16(bw.buf, h0, bw.pos); bw.w(c, 16);
    }
    return bw.bytes().slice();
  }
  // PCM WAV (8/16/24-bit integer; any chunk order) → {ints, sampleRate, bits}; null for float / 32-bit / not a WAV
  function fromWav(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
    if (b.length < 44) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let fmt = null, data = null;
    for (let o = 12; o + 8 <= b.length;) {
      const id = tag(o); let size = dv.getUint32(o + 4, true); const body = o + 8;
      if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), ch: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true), ext: size >= 26 ? dv.getUint16(body + 24, true) : null };
      else if (id === 'data') { if (size > b.length - body || size === 0xffffffff) size = b.length - body; data = { o: body, size }; break; }
      o = body + size + (size & 1);
    }
    if (!fmt || !data) return null;
    const pcm = fmt.format === 1 || (fmt.format === 0xfffe && fmt.ext === 1);
    if (!pcm || ![8, 16, 24].includes(fmt.bits) || fmt.ch < 1 || fmt.ch > 8 || !fmt.sr || fmt.sr > 655350) return null;
    const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.ch));
    if (!frames) return null;
    const ints = []; for (let c = 0; c < fmt.ch; c++) ints.push(new Int32Array(frames));
    let o = data.o;
    for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++) {
      let v; if (bps === 3) { v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (v & 0x800000) v -= 0x1000000; } else if (bps === 2) v = dv.getInt16(o, true); else v = b[o] - 128;
      ints[c][i] = v; o += bps;
    }
    return { ints, sampleRate: fmt.sr, bits: fmt.bits };
  }
  // WAV bytes → FLAC bytes (lossless), or null when the WAV isn't plain integer PCM
  function fromWavToFlac(buf) { const w = fromWav(buf); return w ? encodeInts(w.ints, w.sampleRate, { bits: w.bits }) : null; }
  const isFlac = (buf) => { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, Math.min(4, buf.byteLength || 4)); return b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43; };
  // STREAMINFO → {channels, sampleRate, seconds}
  function info(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); if (!isFlac(b) || b.length < 42) return null;
    const o = 8; const sr = (b[o + 10] << 12) | (b[o + 11] << 4) | (b[o + 12] >> 4); const ch = ((b[o + 12] >> 1) & 7) + 1;
    const total = (b[o + 13] & 0x0f) * 2 ** 32 + ((b[o + 14] << 24) >>> 0) + (b[o + 15] << 16) + (b[o + 16] << 8) + b[o + 17];
    return { channels: ch, sampleRate: sr, seconds: sr ? total / sr : 0, bits: (((b[o + 12] & 1) << 4) | (b[o + 13] >> 4)) + 1 };
  }
  return { encode, encodeInts, fromWav, fromWavToFlac, isFlac, info };
});
