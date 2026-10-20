// WAV encode/decode helpers. Takes and bounces are written as 24-bit PCM, which every
// DAW the band uses (REAPER, Logic, Ableton, Pro Tools) imports without conversion.
(function (global) {
  'use strict';

  function encodeWav(channels, sampleRate, bitDepth = 24) {
    const numCh = channels.length;
    const frames = channels[0].length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numCh * bytesPerSample;
    const dataBytes = frames * blockAlign;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true);
    v.setUint16(32, blockAlign, true); v.setUint16(34, bitDepth, true);
    str(36, 'data'); v.setUint32(40, dataBytes, true);
    let o = 44;
    const max24 = 8388607, max16 = 32767;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < numCh; c++) {
        let x = channels[c][i];
        if (x > 1) x = 1; else if (x < -1) x = -1;
        if (bitDepth === 24) {
          const s = Math.round(x * max24);
          v.setUint8(o, s & 0xff); v.setUint8(o + 1, (s >> 8) & 0xff); v.setUint8(o + 2, (s >> 16) & 0xff);
          o += 3;
        } else {
          v.setInt16(o, Math.round(x * max16), true); o += 2;
        }
      }
    }
    return buf;
  }

  // Native decode handles 16/24/32-bit PCM and float WAV. Returns AudioBuffer.
  async function decodeWav(ctx, arrayBuffer) {
    return ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  function audioBufferToChannels(buffer) {
    const out = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
    return out;
  }

  global.BPWav = { encodeWav, decodeWav, audioBufferToChannels };
})(window);
