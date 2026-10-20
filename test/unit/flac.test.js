'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const F = require('../../src/renderer/flac.js');
globalThis.window = globalThis.window || globalThis; require('../../src/renderer/wav.js'); const W = globalThis.BPWav;
const S = require('../../src/store');

function tone(n, sr, ch = 2) { const out = []; for (let c = 0; c < ch; c++) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * (220 + 110 * c) * i / sr) + (i % 97 === 0 ? 0.01 : 0) + (Math.random() - 0.5) * 0.002; out.push(a); } return out; }
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
const wavOf = (chans, sr, bits) => Buffer.from(new Uint8Array(W.encodeWav(chans, sr, bits)));

test('fromWav reads integer PCM back exactly and refuses float WAVs', () => {
  const sr = 48000; const chans = tone(5000, sr, 2); const wav = wavOf(chans, sr, 24);
  const w = F.fromWav(wav); assert.equal(w.sampleRate, sr); assert.equal(w.bits, 24); assert.equal(w.ints.length, 2); assert.equal(w.ints[0].length, 5000);
  assert.equal(w.ints[0][1], Math.round(chans[0][1] * 8388607));
  const fl = Buffer.from(wav); fl.writeUInt16LE(3, 20); assert.equal(F.fromWav(fl), null);
  assert.equal(F.fromWav(Buffer.from('nope')), null);
});

test('FLAC header info matches; ffmpeg decodes it bit-exact (when available)', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-flac-'));
  for (const [bits, ch] of [[24, 1], [16, 2], [24, 2]]) {
    const sr = 44100; const wav = wavOf(tone(20000, sr, ch), sr, bits);
    const flac = Buffer.from(F.fromWavToFlac(wav));
    assert.ok(F.isFlac(flac)); assert.ok(flac.length < wav.length);
    const i = F.info(flac); assert.equal(i.channels, ch); assert.equal(i.sampleRate, sr); assert.equal(i.bits, bits); assert.ok(Math.abs(i.seconds - 20000 / sr) < 1e-6);
    const fin = path.join(dir, 'x.flac'), fout = path.join(dir, 'y.wav'); fs.writeFileSync(fin, flac);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fin, '-c:a', bits === 24 ? 'pcm_s24le' : 'pcm_s16le', fout]);
    const a = F.fromWav(wav), b = F.fromWav(fs.readFileSync(fout));
    for (let c = 0; c < ch; c++) assert.deepEqual(Array.from(b.ints[c]), Array.from(a.ints[c]), `${bits}-bit ch${c}`);
  }
});

test('store keeps new takes as FLAC; lookup, info, rename, parts and unreferenced all see them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-store-flac-')); const st = new S.SongStore(root);
  await st.createSong('Flac Song');
  const sr = 48000; const wav = wavOf(tone(48000, sr, 1), sr, 24);
  const file = await st.writeAudio('Flac Song', 'abcdef012345', wav, { label: 'Vox - take 1 - Jeff' });
  assert.match(file, /Vox - take 1 - Jeff - abcdef012345\.flac$/);
  assert.ok(fs.statSync(file).size < wav.length * 0.9);
  const info = await st.audioInfo('Flac Song', 'abcdef012345'); assert.equal(info.channels, 1); assert.equal(info.sampleRate, sr); assert.ok(Math.abs(info.seconds - 1) < 1e-6);
  assert.ok(F.isFlac(await st.readAudio('Flac Song', 'abcdef012345')));
  const moved = await st.renameAudio('Flac Song', 'abcdef012345', 'Lead vox - take 1 - Jeff'); assert.match(moved, /Lead vox - take 1 - Jeff - abcdef012345\.flac$/);
  const un = await st.unreferencedTakes('Flac Song', []); assert.equal(un.length, 1); assert.equal(un[0].seconds, 1);
  await st.savePart('Flac Song', { id: 'part-abcdef012345', name: 'Riff' }, ['abcdef012345']);
  assert.ok(F.isFlac(await st.readPartAudio('abcdef012345')));
  // flac off → stays WAV
  const st2 = new S.SongStore(root, { flac: false });
  const f2 = await st2.writeAudio('Flac Song', '0123456789ab', wav); assert.match(f2, /0123456789ab\.wav$/);
});

test('compactAudio converts WAV takes to FLAC and removes only old audio nothing references', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-compact-')); const st = new S.SongStore(root, { flac: false });
  await st.createSong('C');
  const sr = 48000; const wav = wavOf(tone(24000, sr, 1), sr, 24);
  const ids = { live: 'aaaaaaaaaaaa', hist: 'bbbbbbbbbbbb', orphanOld: 'cccccccccccc', orphanNew: 'dddddddddddd' };
  for (const [k, id] of Object.entries(ids)) await st.writeAudio('C', id, wav, { label: k });
  const { song } = await st.loadSong('C'); song.tracks = [{ id: 't1', name: 'Vox', clips: [{ id: ids.live, start: 0 }] }];
  await fs.promises.mkdir(path.join(st.songDir('C'), 'history'), { recursive: true });
  fs.writeFileSync(path.join(st.songDir('C'), 'history', 'rev-1-x.json'), JSON.stringify({ tracks: [{ clips: [{ id: ids.hist }] }] }));
  fs.writeFileSync(path.join(st.songDir('C'), 'song.json'), JSON.stringify(song));
  const old = (Date.now() - 40 * 86400000) / 1000;
  for (const id of [ids.hist, ids.orphanOld, ids.live]) fs.utimesSync(await st.findAudio('C', id), old, old);
  const dry = await st.compactAudio('C', { dryRun: true });
  assert.deepEqual(dry.removed.map((r) => r.file), ['orphanOld - cccccccccccc.wav']);
  assert.equal(dry.converted, 3);
  assert.ok(await st.findAudio('C', ids.orphanOld));
  const r = await st.compactAudio('C');
  assert.equal(r.converted, 3); assert.ok(r.after < r.before * 0.8);
  assert.equal(await st.findAudio('C', ids.orphanOld), null);
  for (const id of [ids.live, ids.hist, ids.orphanNew]) assert.match(await st.findAudio('C', id), /\.flac$/);
  assert.equal((await st.compactAudio('C')).converted, 0);
});

test('compactAudio removes nothing when song.json is unreadable, and never anything newer than 7 days', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-compact2-')); const st = new S.SongStore(root, { flac: false });
  await st.createSong('D'); const sr = 48000; const wav = wavOf(tone(4800, sr, 1), sr, 16);
  await st.writeAudio('D', 'eeeeeeeeeeee', wav); await st.writeAudio('D', 'ffffffffffff', wav);
  const ago = (Date.now() - 40 * 86400000) / 1000; fs.utimesSync(await st.findAudio('D', 'eeeeeeeeeeee'), ago, ago);
  const sj = path.join(st.songDir('D'), 'song.json'); const good = fs.readFileSync(sj, 'utf8');
  fs.writeFileSync(sj, good.slice(0, 20));
  const r = await st.compactAudio('D', { dryRun: true }); assert.equal(r.removed.length, 0); assert.ok(r.purgeSkipped);
  fs.writeFileSync(sj, good);
  const r2 = await st.compactAudio('D', { dryRun: true, olderThanDays: 0 }); assert.deepEqual(r2.removed.map((x) => x.file), ['eeeeeeeeeeee.wav']);
  const r3 = await st.compactAudio('D', { dryRun: true, extraRefs: ['eeeeeeeeeeee'] }); assert.equal(r3.removed.length, 0);
});

test('two WAV→FLAC encodes at once both finish (worker thread)', async () => {
  const FN = require('../../src/flac-node.js'); const sr = 48000;
  const [a, b] = await Promise.all([FN.wavToFlac(wavOf(tone(48000, sr, 2), sr, 24)), FN.wavToFlac(wavOf(tone(4800, sr, 1), sr, 16))]);
  assert.ok(FN.isFlac(a) && FN.isFlac(b));
});
