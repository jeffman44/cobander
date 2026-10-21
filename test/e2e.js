'use strict';
// End-to-end smoke: two real Cobander windows (Jeff + Kat) on one shared folder, under xvfb, driven through
// the control API. Run with test/e2e.sh. Screenshots land in .e2e/shots/.
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, '.e2e');
const SHOTS = path.join(WORK, 'shots');
const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const Takeout = require(path.join(ROOT, 'src', 'takeout.js'));
// a throwaway Takeout keypair: the apps run with its public key so the harness can test the free-song gate and unlock it
const TK = (() => { const c = require('crypto'); const { publicKey, privateKey } = c.generateKeyPairSync('ed25519'); return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url'), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url') }; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const results = [];

function wav(seconds, freq = 220, sr = 48000) {
  const n = Math.round(seconds * sr); const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / sr) * 12000), 44 + i * 2);
  return b;
}

function wavF(chans, sr = 48000) {   // float channels → 16-bit PCM WAV
  const n = chans[0].length, ch = chans.length, b = Buffer.alloc(44 + n * 2 * ch);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2 * ch, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2 * ch, 28); b.writeUInt16LE(2 * ch, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2 * ch, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(chans[c][i] * 32767))), 44 + (i * ch + c) * 2);
  return b;
}
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
// strummed guitar-ish chords, one a bar at 120 bpm (2 s bars), every beat
function chordWav(prog, sr = 48000) {
  const CH = { G: [43, 47, 50, 55, 59, 67], D: [50, 57, 62, 66], Em: [40, 47, 52, 55, 59, 64], C: [48, 52, 55, 60, 64], Am: [45, 52, 57, 60, 64], F: [41, 48, 53, 57, 60, 65] };
  const n = prog.length * 2 * sr; const x = new Float32Array(n);
  prog.forEach((name, bar) => { for (let beat = 0; beat < 4; beat++) { const t0 = Math.round((bar * 2 + beat * 0.5) * sr); for (const m of CH[name]) { const f = mtof(m); for (let i = 0; i < 0.5 * sr && t0 + i < n; i++) { const env = Math.exp(-i / sr * 3); let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(2 * Math.PI * f * h * i / sr) / (h * 1.3); x[t0 + i] += 0.05 * env * v; } } } });
  return wavF([x], sr);
}
// noise-burst hits on 1/8 notes at 120 bpm, each 15–30 ms late or early
function sloppyDrums(seconds, sr = 48000) {
  const n = seconds * sr, x = new Float32Array(n); let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k * 0.25 < seconds - 0.3; k++) { const off = (rnd() < 0.5 ? -1 : 1) * (0.015 + rnd() * 0.015); const t0 = Math.round((k * 0.25 + 0.25 + off) * sr); for (let i = 0; i < 0.12 * sr && t0 + i < n; i++) if (t0 + i >= 0) x[t0 + i] += (rnd() * 2 - 1) * 0.6 * Math.exp(-i / sr * 40); }
  return wavF([x], sr);
}
// a "sung" line: G A B C (G major), 0.6 s each, the third 35 cents flat
function sungWav(sr = 48000) {
  const notes = [[67, 0], [69, 0], [71, -35], [72, 0]]; const n = Math.round(notes.length * 0.6 * sr) + sr; const x = new Float32Array(n); let ph = 0;
  notes.forEach(([m, c], k) => { const t0 = Math.round((0.5 + k * 0.6) * sr); for (let i = 0; i < 0.55 * sr; i++) { const f = mtof(m + c / 100) * (1 + 0.003 * Math.sin(2 * Math.PI * 5 * i / sr)); ph += 2 * Math.PI * f / sr; let v = 0; for (let h = 1; h <= 5; h++) v += Math.sin(ph * h) / h; x[t0 + i] = 0.2 * v * Math.min(1, i / (0.02 * sr), (0.55 * sr - i) / (0.02 * sr)); } });
  return wavF([x], sr);
}

class App {
  constructor(name, port, shared) { this.name = name; this.port = port; this.shared = shared; this.token = `tok-${name}`; this.cfg = path.join(WORK, `cfg-${name}`); }
  async start() {
    const ud = path.join(this.cfg, 'Cobander'); await fsp.mkdir(ud, { recursive: true });
    await fsp.writeFile(path.join(ud, 'settings.json'), JSON.stringify({ sharedFolder: this.shared, displayName: this.name, apiPort: this.port, apiToken: this.token, phonePort: this.port + 10, apiInbox: path.join(this.cfg, 'inbox'), fanfare: false, ...(this.name === 'Jeff' ? { autoUnlockTracks: true } : {}) }));
    this.log = fs.createWriteStream(path.join(WORK, `${this.name}.log`));
    this.proc = spawn(ELECTRON, [ROOT, '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'], { env: { ...process.env, XDG_CONFIG_HOME: this.cfg, BP_DEBUG: '1', COBANDER_TAKEOUT_PUB: TK.pub }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.pipe(this.log); this.proc.stderr.pipe(this.log);
    for (let i = 0; i < 120; i++) { try { await this.get('/state'); return; } catch (_) { await sleep(500); } }
    throw new Error(`${this.name} did not start`);
  }
  req(method, p, body, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: this.port, method, path: p, timeout, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} if (res.statusCode >= 400) { const e = new Error(`${this.name} ${method} ${p} → ${res.statusCode} ${j && j.error ? j.error : d}`); e.status = res.statusCode; reject(e); } else resolve(j); }); });
      r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); if (body !== undefined) r.write(JSON.stringify(body)); r.end();
    });
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  evalJs(js) { return this.post('/debug/eval', { js }).then((r) => r.result); }
  shot(name) { return this.post('/debug/screenshot', { file: path.join(SHOTS, `${this.name}-${name}.png`) }); }
  async stop() { try { this.proc.kill('SIGTERM'); } catch (_) {} await sleep(1500); try { this.proc.kill('SIGKILL'); } catch (_) {} }
}

async function step(name, fn) {
  if (process.env.ONLY && !process.env.ONLY.split('|').some((o) => name.includes(o))) return;   // ONLY=<text>[|<text>] runs just the matching steps
  const t0 = Date.now();
  try { await fn(); results.push(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (err) { failures++; results.push(`FAIL ${name}: ${err.stack || err.message}`); }
}
async function until(fn, ms = 20000, what = 'condition') { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(300); } throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`); }

(async () => {
  await fsp.rm(WORK, { recursive: true, force: true }); await fsp.mkdir(SHOTS, { recursive: true });
  const shared = path.join(WORK, 'shared'); await fsp.mkdir(shared, { recursive: true });
  await fsp.writeFile(path.join(WORK, 'riff.wav'), wav(6, 220)); await fsp.writeFile(path.join(WORK, 'memo.wav'), wav(3, 330));
  const jeff = new App('Jeff', 47811, shared), kat = new App('Kat', 47812, shared);
  try {
    await jeff.start();
    let song;
    await step('create song + tracks + import audio', async () => {
      await jeff.post('/song/create', { name: 'E2E Song' });
      await jeff.post('/song/patch', { bpm: 120, addTrack: { kind: 'guitar', name: 'Gtr' } });
      await jeff.post('/song/patch', { addTrack: { kind: 'vocals', name: 'Vox' } });
      const st = await jeff.get('/state'); const g = st.song.tracks.find((t) => t.name === 'Gtr');
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 0, name: 'riff A' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 0, name: 'riff B' });
      const s = await jeff.post('/song/save'); assert.equal(s.result, 'ok');
    });
    await step('mute/solo on someone else\'s track is ears-only (never saved)', async () => {
      await kat.start().catch(() => {});
      const st = await jeff.get('/state'); const g = st.song.tracks.find((t) => t.name === 'Gtr'); assert.ok(g, 'Gtr exists');
      await jeff.post('/song/save'); await jeff.post('/song/close');
      const before = !!JSON.parse(await fsp.readFile(path.join(shared, 'E2E Song', 'song.json'), 'utf8')).tracks.find((t) => t.name === 'Gtr').mute;
      await kat.post('/song/open', { folder: 'E2E Song' }); await sleep(800);
      const r = await kat.evalJs(`(() => { const t = window.cobanderDebug.engine.tracks.find((x) => x.name === 'Gtr'); const mine = window.cobanderDebug.mineT(t.id); const b = document.querySelector('.track[data-id="' + t.id + '"] button.mute') || [...document.querySelectorAll('button.mute')][0]; b.click(); return { mine, muted: !!window.cobanderDebug.engine.track(t.id).mute }; })()`);
      assert.equal(r.mine, false, 'Gtr is not Kat\'s'); assert.equal(r.muted, !before, 'toggled locally for Kat');
      const sv = await kat.post('/song/save', { force: true }).catch((e) => ({ result: 'error', error: String(e) }));
      await sleep(500);
      const disk = JSON.parse(await fsp.readFile(path.join(shared, 'E2E Song', 'song.json'), 'utf8')); const gd = disk.tracks.find((t) => t.name === 'Gtr');
      assert.equal(!!gd.mute, before, 'Kat\'s local mute must not reach the saved song');
      assert.equal(sv.result, 'ok', 'Kat could save (song lock was hers)');
      await kat.post('/song/close').catch(() => {}); await jeff.post('/song/open', { folder: 'E2E Song' }); await sleep(500);
    });
    await step('takeout: free folder keeps one song; a key unlocks the band', async () => {
      const r = await jeff.post('/song/create', { name: 'Second Song' }).catch((e) => e);
      assert.match(String(r.error || r.message || JSON.stringify(r)), /Send noods lifts the limit/, 'second song must hit the free limit');
      assert.equal((await fsp.readdir(shared, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).length, 1);
      assert.equal(Takeout.verify('cob1.nope.nope', TK.pub), null);
      await jeff.evalJs(`document.querySelector('#s-takeout-key').click()`); await sleep(300);
      assert.equal(await jeff.evalJs(`document.querySelector('#takeout').open`), true, 'the Takeout dialog opens');
      await jeff.shot('takeout'); await jeff.evalJs(`document.querySelector('#takeout').close('cancel')`);
      await fsp.writeFile(path.join(shared, Takeout.FILE), JSON.stringify({ key: Takeout.sign({ band: 'E2E Band', tier: 'roadie' }, TK.priv) }));
      const r2 = await jeff.post('/song/create', { name: 'Second Song' }); assert.ok(r2.folder, 'unlocked folder creates a second song');
      await jeff.post('/song/close').catch(() => {}); await jeff.post('/song/open', { folder: 'E2E Song' }).catch(() => {});
      const st = await jeff.evalJs('window.cobander.shell.takeout()').catch(() => null);
      const roadies = await jeff.evalJs('window.cobander.shell.roadies()'); assert.ok(Array.isArray(roadies) && roadies.some((b) => b.band === 'Never a Doubt'), 'roadies list ships with the app');
      if (st) { assert.equal(st.unlocked, true); assert.equal(st.band, 'E2E Band'); }
      song = (await jeff.get('/state')).song; assert.equal(song.tracks.find((t) => t.name === 'Gtr').clips.length, 2);
    });
    await step('sections: add by bars, update, loop menu has them', async () => {
      const r = await jeff.post('/sections', { add: [{ name: 'Intro', startBar: 1, endBar: 2 }, { name: 'Verse', startBar: 3, endBar: 10 }, { name: 'Chorus', startBar: 11, endBar: 18 }] });
      assert.equal(r.sections.length, 3); assert.equal(r.sections[1].start, 4);   // bar 3 starts after 2 bars of 4/4 @120 = 4 s
      await jeff.post('/sections', { update: [{ id: r.sections[0].id, name: 'Count-in' }] });
      await assert.rejects(jeff.post('/sections', { remove: ['nope'] }), /no section/);
      const ui = await jeff.evalJs(`document.querySelectorAll('#section-lane .section-block').length`); assert.equal(ui, 3);
    });
    await step('chords: a progression by bars', async () => {
      const r = await jeff.post('/chords', { fromBar: 3, bars: 'G D | Em C' });
      assert.deepEqual(r.chords.map((c) => c.chord), ['G', 'D', 'Em', 'C']);
      assert.equal(await jeff.evalJs(`document.querySelectorAll('#chord-lane .chord-chip').length`), 4);
    });
    await step('lyrics: add lines, pin, now-line follows the playhead', async () => {
      await jeff.post('/lyrics', { text: 'first line\nsecond line\nthird line' });
      let c = await jeff.get('/collab'); assert.equal(c.lyrics.length, 3);
      await jeff.post('/lyrics', { pin: { id: c.lyrics[0].id, time: 4 } });
      await jeff.post('/transport', { action: 'seek', time: 4.5 });
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=lyrics]').click()`);
      await jeff.evalJs(`window.cobanderDebug.engine.seek(4.6)`);
      const now = await until(() => jeff.evalJs(`document.querySelector('#now-lyric').textContent`), 5000, 'now-line lyric'); assert.match(now, /first line/);
      assert.match(await jeff.evalJs(`document.querySelector('#now-section').textContent`), /Verse/);
      assert.match(await jeff.evalJs(`document.querySelector('#now-chord').textContent`), /G/);
      c = await jeff.get('/collab'); assert.equal(c.lyrics[0].time, 4);
    });
    await step('needs checklist', async () => {
      await jeff.post('/needs', { add: ['needs bass', 'needs a harmony'] });
      const c = await jeff.get('/collab'); await jeff.post('/needs', { done: [c.needs[1].id] });
      const c2 = await jeff.get('/collab'); assert.equal(c2.needs.filter((n) => !n.done).length, 1);
    });
    await step('notes: thread with @mention, resolve', async () => {
      await jeff.post('/song/patch', { addNotes: [{ time: 8, text: 'tighten this up' }, { time: 20, text: 'bridge idea?' }] });
      let c = await jeff.get('/collab'); const n = c.notes.find((x) => x.text === 'tighten this up');
      await jeff.post('/note/reply', { noteId: n.id, text: '@Kat can you double this?' });
      const n2 = c.notes.find((x) => x.text === 'bridge idea?'); await jeff.post('/note/resolve', { noteId: n2.id });
      c = await jeff.get('/collab'); assert.equal(c.notes.find((x) => x.id === n.id).replies.length, 1); assert.ok(c.notes.find((x) => x.id === n2.id).resolved);
      assert.equal(await jeff.evalJs(`document.querySelectorAll('#note-list .note-row').length`), 1, 'resolved note hidden by default');
    });
    await step('take voting: most stars becomes the hero', async () => {
      const st = await jeff.get('/state'); const g = st.song.tracks.find((t) => t.name === 'Gtr'); const a = g.clips.find((c) => c.name === 'riff A');
      const r = await jeff.post('/vote', { clipId: a.id }); assert.equal(r.stars, 1); assert.equal(r.mute, false);
      const st2 = await jeff.get('/state'); const b = st2.song.tracks.find((t) => t.name === 'Gtr').clips.find((c) => c.name === 'riff B'); assert.equal(b.mute, true, 'the other overlapping take is muted');
    });
    await step('ideas: text + audio file, not on the timeline, not a "deleted take"', async () => {
      await jeff.post('/idea', { text: 'half-time feel for the last chorus' });
      const i = await jeff.post('/idea', { path: path.join(WORK, 'memo.wav'), title: 'phone memo' }); assert.equal(i.kind, 'audio'); assert.ok(i.seconds > 2.5);
      const un = await jeff.get('/takes/unreferenced'); assert.equal(un.length, 0);
      const files = await fsp.readdir(path.join(shared, 'E2E Song', 'audio')); assert.ok(files.some((f) => /^Idea - phone memo - Jeff - [a-f0-9]{12}\.flac$/.test(f)), files.join(', '));
    });
    await step('version tag + A/B + restore', async () => {
      await jeff.post('/song/save');
      const v = await jeff.post('/version', { name: 'before tempo change' });
      await jeff.post('/song/patch', { bpm: 150 });
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=versions]').click()`);
      await jeff.evalJs(`document.querySelector('#btn-ab').click()`); await sleep(800);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.bpm`), 120, 'B plays the tagged version');
      assert.equal((await jeff.get('/state')).song.bpm, 150, 'the song itself is still the current one during A/B');
      await jeff.evalJs(`document.querySelector('#btn-ab').click()`); await sleep(500);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.bpm`), 150);
      await jeff.post('/version', { restore: v.id }); assert.equal((await jeff.get('/state')).song.bpm, 120);
      const c = await jeff.get('/collab'); assert.equal(c.lyrics.length, 3, 'restoring a version keeps the lyrics'); assert.equal(c.versions.length, 1);
      assert.ok(fs.existsSync(path.join(shared, 'E2E Song', 'versions', `${v.id}.json`)));
    });
    await step('activity feed is written on save', async () => {
      const s = await jeff.post('/song/save'); assert.equal(s.result, 'ok');
      const c = await jeff.get('/collab'); assert.ok(c.activity.length >= 2); assert.ok(c.activity.some((a) => a.items.some((x) => /restored version/.test(x))), JSON.stringify(c.activity[0]));
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=feed]').click()`);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#feed-list li').length`) >= 2);
      await jeff.shot('feed');
    });

    // ---------- 0.3 regression coverage + 0.4 history / tempo / restructure ----------
    const songFile = () => JSON.parse(fs.readFileSync(path.join(shared, 'E2E Song', 'song.json'), 'utf8'));
    const gtrClips = async () => (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Gtr').clips;
    await step('record a take with the (fake) mic: it lands on Vox and on Drive', async () => {
      const st = await jeff.get('/state'); const vox = st.song.tracks.find((t) => t.name === 'Vox');
      await jeff.post('/transport', { action: 'click', enabled: false }); await jeff.evalJs(`window.cobanderDebug.engine.click.countIn = false`);
      await jeff.post('/transport', { action: 'loop', enabled: false });
      await jeff.post('/transport', { action: 'seek', time: 0 });
      await jeff.post('/transport', { action: 'record', trackId: vox.id }); await sleep(2500); await jeff.post('/transport', { action: 'stop' });
      const clip = await until(async () => { const s2 = await jeff.get('/state'); const v = s2.song.tracks.find((t) => t.id === vox.id); return !s2.dirty && v.clips.length ? v.clips[0] : null; }, 20000, 'take saved');
      assert.ok(clip.duration > 1.5, `duration ${clip.duration}`);
      const files = await fsp.readdir(path.join(shared, 'E2E Song', 'audio')); assert.ok(files.some((f) => f.endsWith(`${clip.id}.flac`)), 'flac on Drive');
    });
    await step('edit: split a take, undo puts it back', async () => {
      const a = (await gtrClips()).find((c) => c.name === 'riff A');
      await jeff.post('/clip/split', { clipId: a.id, at: 3 });
      assert.equal((await gtrClips()).length, 3);
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(600);
      assert.equal((await gtrClips()).length, 2);
    });
    await step('A/B a version, then record: leaves A/B and the take goes into the current song', async () => {
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=versions]').click()`);
      await jeff.evalJs(`document.querySelector('#btn-ab').click()`); await sleep(600);
      assert.equal(await jeff.evalJs(`document.querySelector('#song').classList.contains('ab')`), true);
      // collab edits still work while A/B-ing
      await jeff.post('/needs', { add: ['needs a tambourine'] }); assert.ok((await jeff.get('/collab')).needs.some((n) => n.text === 'needs a tambourine'));
      const vox = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Vox'); const before = vox.clips.length;
      await jeff.post('/transport', { action: 'seek', time: 6 });
      await jeff.post('/transport', { action: 'record', trackId: vox.id }); await sleep(1800); await jeff.post('/transport', { action: 'stop' });
      assert.equal(await jeff.evalJs(`document.querySelector('#song').classList.contains('ab')`), false, 'left A/B');
      await until(async () => { const s2 = await jeff.get('/state'); return !s2.dirty && s2.song.tracks.find((t) => t.id === vox.id).clips.length === before + 1; }, 20000, 'take saved into the current song');
      assert.equal(songFile().tracks.find((t) => t.id === vox.id).clips.length, before + 1);
    });
    await step('history: every save is a roll-back point; roll back from the feed, undo it', async () => {
      await jeff.post('/song/patch', { addTrack: { kind: 'keys', name: 'Organ' } }); assert.equal((await jeff.post('/song/save')).result, 'ok');
      const h = await jeff.get('/history'); assert.ok(h.length >= 5, `history ${h.length}`);
      await sleep(500); const files = (await fsp.readdir(path.join(shared, 'E2E Song', 'history'))).filter((f) => /^rev-/.test(f)); assert.ok(files.length >= h.length, `${files.length} files, ${h.length} listed`);
      const prev = h[h.length - 2];
      await jeff.post('/rollback', { saveId: prev.saveId });
      let st = await jeff.get('/state'); assert.ok(!st.song.tracks.some((t) => t.name === 'Organ'), 'rolled back past the Organ track');
      assert.ok((await jeff.get('/collab')).needs.some((n) => n.text === 'needs a tambourine'), 'default roll-back keeps notes/needs');
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(700);
      st = await jeff.get('/state'); assert.ok(st.song.tracks.some((t) => t.name === 'Organ'), 'undo brings it back');
      await jeff.post('/song/save');
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=feed]').click()`);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#feed-list li.rollable').length`) >= 2, 'feed rows offer roll-back');
      const c = await jeff.get('/collab'); assert.ok(c.activity.some((a) => a.kinds && a.kinds.take >= 1), 'typed events recorded');
    });
    await step('tempo change: takes follow like tape (new files), timeline keeps its bars, undo restores', async () => {
      const a0 = (await gtrClips()).find((c) => c.name === 'riff A'); const verse0 = (await jeff.get('/collab')).sections.find((x) => /^Verse/.test(x.name));
      await jeff.post('/tempo', { bpm: 150 });
      const st = await jeff.get('/state'); assert.equal(st.song.bpm, 150);
      const a1 = st.song.tracks.find((t) => t.name === 'Gtr').clips.find((c) => c.name === 'riff A');
      assert.notEqual(a1.src || a1.id, a0.src || a0.id, 'points at a re-sped file');
      assert.ok(Math.abs(a1.duration - a0.duration * 120 / 150) < 0.02, `duration ${a0.duration} → ${a1.duration}`);
      const verse1 = (await jeff.get('/collab')).sections.find((x) => x.id === verse0.id); assert.ok(Math.abs(verse1.start - verse0.start * 0.8) < 1e-6, 'sections keep their bar');
      const files = await fsp.readdir(path.join(shared, 'E2E Song', 'audio')); assert.ok(files.some((f) => /150bpm - [a-f0-9]{12}\.flac$/.test(f)), files.join(', '));
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(800);
      const st2 = await jeff.get('/state'); assert.equal(st2.song.bpm, 120); assert.equal(st2.song.tracks.find((t) => t.name === 'Gtr').clips.find((c) => c.name === 'riff A').src || a0.id, a0.src || a0.id);
      await jeff.post('/tempo', { bpm: 100, keepTakes: true }); const st3 = await jeff.get('/state'); assert.equal(st3.song.bpm, 100); assert.equal(st3.song.tracks.find((t) => t.name === 'Gtr').clips.find((c) => c.name === 'riff A').src || a0.id, a0.src || a0.id, 'keepTakes leaves audio alone');
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(500); assert.equal((await jeff.get('/state')).song.bpm, 120);
    });
    await step('restructure: pop-punk "half-chorus tease" re-cuts the labelled parts', async () => {
      const dry = await jeff.post('/restructure', { arrangement: 'pop-punk:half-chorus', dryRun: true });
      assert.equal(dry.applied, false); assert.ok(dry.report.missing.includes('Bridge'), JSON.stringify(dry.report));
      const r = await jeff.post('/restructure', { arrangement: 'pop-punk:half-chorus' });
      assert.deepEqual(r.sections.map((x) => x.name).slice(0, 4), ['Verse 1', 'Half chorus', 'Verse 2', 'Chorus 1']);
      assert.equal(r.sections[1].from, 'Chorus');
      const c = await jeff.get('/collab'); assert.deepEqual(c.sections.map((x) => x.name).slice(0, 2), ['Verse 1', 'Half chorus']);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#section-lane .section-block').length`) >= 7);
      await jeff.shot('restructured');
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(700);
      assert.ok((await jeff.get('/collab')).sections.some((x) => x.name === 'Count-in'), 'undo restores the old arrangement');
      await jeff.post('/song/save');
    });
    await step('DAW hand-off export and the file-drop inbox still work', async () => {
      const ex = await jeff.post('/export', {}); assert.equal(ex.reaper, true); assert.ok((await fsp.readdir(ex.folder)).some((f) => /\.rpp$/i.test(f)), 'REAPER project written');
      const inbox = path.join(jeff.cfg, 'inbox'); await fsp.mkdir(inbox, { recursive: true });
      await fsp.writeFile(path.join(inbox, 'q1.json'), JSON.stringify({ method: 'GET', path: '/collab' }));
      const res = await until(async () => { try { return JSON.parse(await fsp.readFile(path.join(inbox, 'q1.result.json'), 'utf8')); } catch (_) { return null; } }, 15000, 'inbox result');
      assert.equal(res.ok, true); assert.ok(res.result.sections.length >= 3);
    });
    // ---------- 0.5: rooms / linked sections, parts bin, chart, assignments, stage, writing mode ----------
    await step('linked choruses: record once in the room, it plays in every Chorus; unlink one', async () => {
      await jeff.post('/sections', { add: [{ name: 'Chorus', startBar: 25, endBar: 32 }] });
      const g = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Gtr');
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 20, name: 'chorus riff' });
      const l = await jeff.post('/link', { type: 'chorus' });
      assert.equal(l.followers.length, 1); assert.ok(l.mirrors >= 1, JSON.stringify(l));
      const c = await jeff.get('/collab'); const follower = c.sections.find((x) => x.id === l.followers[0]);
      let st = await jeff.get('/state'); let mir = st.song.tracks.find((t) => t.name === 'Gtr').clips.find((x) => x.link);
      assert.ok(Math.abs(mir.start - follower.start) < 1e-6, `${mir.start} vs ${follower.start}`);
      const room = st.song.tracks.find((t) => t.name === 'Gtr').clips.find((x) => x.name === 'chorus riff' && !x.link);
      await jeff.post('/song/patch', { clips: [{ id: room.id, start: 21 }] });
      st = await jeff.get('/state'); mir = st.song.tracks.find((t) => t.name === 'Gtr').clips.find((x) => x.link); assert.ok(Math.abs(mir.start - (follower.start + 1)) < 1e-6, 'mirror follows the room');
      await jeff.post('/song/patch', { clips: [{ id: mir.id, start: follower.start + 2 }] });   // 0.11: an edit on the copy goes to the room
      st = await jeff.get('/state'); assert.ok(Math.abs(st.song.tracks.find((t) => t.name === 'Gtr').clips.find((x) => x.id === room.id).start - 22) < 1e-6, 'moving the copy moved the room take');
      const rm = await jeff.post('/room', { sectionId: l.room }); assert.equal(rm.loop.enabled, true);
      assert.equal(await jeff.evalJs(`!document.querySelector('#room-bar').hidden`), true); await sleep(500); await jeff.shot('room');
      await jeff.post('/room', { leave: true });
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      assert.ok(songFile().tracks.find((t) => t.name === 'Gtr').clips.some((x) => x.link), 'mirrors are saved as real clips');
      const countGtr = async () => (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Gtr').clips;
      const before = (await countGtr()).length;
      for (let i = 0; i < 2; i++) { await jeff.post('/song/reload'); await jeff.post('/song/patch', { addNotes: [{ time: 1, text: `poke ${i}` }] }); }
      const after = await countGtr(); assert.equal(after.length, before, 'reloads + edits never pile up copies');
      assert.equal(new Set(after.map((c) => c.id)).size, after.length, 'no duplicate ids');
      await jeff.post('/section/unlink', { sectionId: follower.id });
      st = await jeff.get('/state'); const own = st.song.tracks.find((t) => t.name === 'Gtr').clips.filter((x) => !x.link && x.start >= follower.start - 0.01);
      assert.equal(own.length, 1, 'the unlinked Chorus kept the take as its own'); assert.ok(!st.song.tracks.some((t) => t.clips.some((x) => x.link)));
    });
    await step('needs: assign to a bandmate and a section; stage; chart', async () => {
      const ch = (await jeff.get('/collab')).sections.find((x) => /^Chorus/.test(x.name));
      await jeff.post('/needs', { add: [{ text: 'needs a harmony on the chorus', who: 'Kat' }] });
      const n = (await jeff.get('/collab')).needs.find((x) => /harmony on the chorus/.test(x.text)); assert.equal(n.who, 'Kat'); assert.ok(n.sectionId, 'section picked up from the text');
      await jeff.post('/song/patch', { stage: 'writing', key: 'G' });
      const chart = await jeff.get('/chart'); assert.match(chart.text, /\[CHORUS/); assert.match(chart.text, /\[G\] first line/); assert.match(chart.text, /key G/);
      const up = await jeff.get('/chart?transpose=2'); assert.match(up.text, /\[A\] first line/);
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=chart]').click()`); assert.match(await jeff.evalJs(`document.querySelector('#chart-view').textContent`), /CHORUS/);
      await jeff.shot('chart');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      const s = (await jeff.get('/songs')).find((x) => x.folder === 'E2E Song'); assert.equal(s.stage, 'writing');
      assert.equal(await jeff.evalJs(`document.body.classList.contains('writing')`), true, 'writing mode on by default');
      await jeff.evalJs(`document.querySelector('#btn-writing').click()`); assert.equal(await jeff.evalJs(`document.body.classList.contains('writing')`), false);
      await jeff.evalJs(`document.querySelector('#btn-writing').click()`);
    });
    await step('parts bin: save a take as a part', async () => {
      const a = (await gtrClips()).find((c) => c.name === 'riff A');
      const p = await jeff.post('/part', { name: 'E2E riff', clipId: a.id }); assert.equal(p.bpm, 120); assert.equal(p.key, 'G');
      { const pp = (await jeff.get('/parts')).find((x) => x.name === 'E2E riff'); assert.ok(pp); assert.deepEqual(pp.timeSig, [4, 4]); assert.equal(pp.bars, 3, 'a 6 s take at 120 = 3 whole measures'); }
      assert.ok((await fsp.readdir(path.join(shared, '_parts', 'audio'))).length >= 1);
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=parts]').click()`); await sleep(500);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#part-list li').length`) >= 1);
    });
    await step('sections: drag the block to move it, drag an edge to resize it', async () => {
      const v = (await jeff.get('/collab')).sections.slice().sort((a, b) => b.start - a.start)[0];   // the last section: free room after it (sections can't overlap)
      const drag = (sel, dx) => jeff.evalJs(`(() => { const b = document.querySelector('#section-lane .section-block[data-id="${v.id}"]'); const t = ${sel}; const r = t.getBoundingClientRect(); const x = r.left + Math.min(20, r.width / 2), y = r.top + r.height / 2;
        t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }));
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 2, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + ${dx}, clientY: y }));
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + ${dx}, clientY: y })); return true; })()`);
      const px = await jeff.evalJs(`window.cobanderDebug.state ? window.cobanderDebug.state.pxPerSec : null`) || await jeff.evalJs(`parseFloat(document.querySelector('#section-lane .section-block').style.width) / 1`);
      const bar = 2; const pps = await jeff.evalJs(`(() => { const b = document.querySelector('#section-lane .section-block[data-id="${v.id}"]'); return parseFloat(b.style.width) / ${v.end - v.start}; })()`);
      await drag('b', Math.round(pps * bar * 2));   // two bars right
      let v2 = (await jeff.get('/collab')).sections.find((x) => x.id === v.id);
      assert.ok(Math.abs(v2.start - (v.start + 4)) < 1e-6 && Math.abs((v2.end - v2.start) - (v.end - v.start)) < 1e-6, `moved ${v.start}→${v2.start}`);
      await drag('b.querySelector(".edge.right")', Math.round(pps * bar));   // one bar longer
      v2 = (await jeff.get('/collab')).sections.find((x) => x.id === v.id);
      assert.ok(Math.abs((v2.end - v2.start) - (v.end - v.start + 2)) < 1e-6, `resized to ${v2.end - v2.start}`);
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(400); await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(400);
      v2 = (await jeff.get('/collab')).sections.find((x) => x.id === v.id); assert.ok(Math.abs(v2.start - v.start) < 1e-6 && Math.abs(v2.end - v.end) < 1e-6, 'undo puts it back');
      // dragged onto the section before it: it can't overlap — it lands in the nearest free spot
      await drag('b', -Math.round(pps * bar * 3));
      const all = (await jeff.get('/collab')).sections.slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < all.length; i++) assert.ok(all[i].start >= all[i - 1].end - 1e-6, `no overlap: ${all.map((x) => `${x.name} ${x.start}-${x.end}`).join(', ')}`);
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(400);
    });
    await step('drag audio files from outside onto the window: each becomes a new track', async () => {
      const before = (await jeff.get('/state')).song.tracks.length;
      await jeff.evalJs(`(() => { const sr = 48000, n = sr; const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.sin(2 * Math.PI * 330 * i / sr) * 0.3;
        const wav = window.BPWav.encodeWav([c], sr, 16); const dt = new DataTransfer();
        dt.items.add(new File([wav], 'Dan bass DI.wav', { type: 'audio/wav' })); dt.items.add(new File([wav], 'Dan gtr L.wav', { type: 'audio/wav' }));
        document.querySelector('#bottom').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
      const st = await until(async () => { const s2 = await jeff.get('/state'); return s2.song.tracks.length === before + 2 && !s2.dirty ? s2 : null; }, 20000, 'two new tracks');
      assert.ok(st.song.tracks.some((t) => t.name === 'Dan bass DI') && st.song.tracks.some((t) => t.name === 'Dan gtr L'));
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(500); await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(500);
      await jeff.post('/song/save');
    });
    // ---------- 0.6: modulation, part keys, melody generator ----------
    await step('melody from lyrics: one note per syllable, in key, on the guide-voice track, lyrics pinned; survives reload', async () => {
      const ch = (await jeff.get('/collab')).sections.find((x) => /^Chorus/.test(x.name));
      const text = "I can't ar-gue with the way you left\nevery word I said was wrong";
      const r = await jeff.post('/melody', { text, sectionId: ch.id, seed: 5, place: true });
      assert.equal(r.syllables, 16); assert.equal(r.key, 'G');
      const G = [7, 9, 11, 0, 2, 4, 6]; for (const n of r.notes) assert.ok(G.includes(n.n % 12), `note ${n.n} out of G`);
      let st = await jeff.get('/state'); const mt = st.song.tracks.find((t) => t.instrument === 'synth:voice');
      assert.ok(mt, 'Melody track'); const clip = mt.clips.find((c) => c.melody); assert.ok(clip); assert.equal(clip.notes[0].l, 'I'); assert.equal(clip.melody.seed, 5);
      const lyr = (await jeff.get('/collab')).lyrics; assert.ok(lyr.some((l) => l.text === "I can't argue with the way you left" && Math.abs(l.time - (ch.start + r.notes[0].t)) < 1e-6), 'line pinned where it is sung');
      assert.equal((await jeff.post('/song/save')).result, 'ok'); await jeff.post('/song/reload');
      st = await jeff.get('/state'); const c2 = st.song.tracks.find((t) => t.instrument === 'synth:voice').clips.find((c) => c.melody);
      assert.equal(c2.notes.length, 16); assert.equal(c2.notes[3].l, r.notes[3].l); assert.equal(c2.melody.text, text);
      // same seed again replaces (not stacks) the melody in that part
      await jeff.post('/melody', { text, sectionId: ch.id, seed: 6 });
      assert.equal((await jeff.get('/state')).song.tracks.find((t) => t.instrument === 'synth:voice').clips.filter((c) => c.melody && Math.abs(c.start - ch.start) < 1e-3).length, 1);
    });
    await step('melody dialog: Again rolls a new one, Done keeps it', async () => {
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=lyrics]').click()`);
      await jeff.evalJs(`document.querySelector('#btn-melody').click()`); await until(() => jeff.evalJs(`document.querySelector('#melody').open`), 5000, 'melody dialog');
      await jeff.evalJs(`(() => { const t = document.querySelector('#ml-text'); t.value = 'oh we were young\\nand we were loud'; t.dispatchEvent(new Event('input')); })()`);
      assert.match(await jeff.evalJs(`document.querySelector('#ml-syl').textContent`), /\(4\)/);
      await jeff.evalJs(`document.querySelector('#ml-again').click()`); const a1 = await jeff.evalJs(`document.querySelector('#ml-info').textContent`);
      await jeff.evalJs(`document.querySelector('#ml-again').click()`); const a2 = await jeff.evalJs(`document.querySelector('#ml-info').textContent`);
      assert.notEqual(a1, a2, 'each roll is new'); await jeff.evalJs(`document.querySelector('#ml-star').click()`);
      assert.equal(await jeff.evalJs(`document.querySelectorAll('#ml-kept button').length`), 1);
      const loopBefore = await jeff.evalJs(`JSON.stringify(window.cobanderDebug.engine.loop)`);
      await jeff.evalJs(`document.querySelector('#ml-play').click()`); await sleep(500);
      const lp = await jeff.evalJs(`window.cobanderDebug.engine.loop`); const chs = (await jeff.get('/collab')).sections.find((x) => /^Chorus/.test(x.name));
      assert.ok(lp.enabled && Math.abs(lp.start - chs.start) < 1e-6 && Math.abs(lp.end - chs.end) < 1e-6, `Play loops the part being written: ${JSON.stringify(lp)}`);
      await jeff.evalJs(`document.querySelector('#ml-play').click()`); await sleep(300);
      await sleep(300); await jeff.shot('melody');
      await jeff.evalJs(`document.querySelector('#melody form').requestSubmit(document.querySelector('#melody menu button.primary'))`); await sleep(500);
      const clips = (await jeff.get('/state')).song.tracks.find((t) => t.instrument === 'synth:voice').clips.filter((c) => c.melody);
      assert.ok(clips.some((c) => /young/.test(c.melody.text)), 'kept after Done');
      assert.equal(await jeff.evalJs(`JSON.stringify(window.cobanderDebug.engine.loop)`), loopBefore, 'the old loop is back after the dialog');
    });
    await step('ruler: click moves the playhead, dragging loops on the snap grid (bars when locked to Bar)', async () => {
      const bl = await jeff.evalJs(`(() => { const e = window.cobanderDebug.engine; document.querySelector('#arrange').scrollLeft = 0; return e.beatLen() * e.timeSig[0]; })()`);
      const r = await jeff.evalJs(`(() => { const el = document.querySelector('#ruler'); const b = el.getBoundingClientRect(); return { left: b.left, top: b.top + 8, pps: window.cobanderDebug.state.pxPerSec }; })()`);
      const X = (sec) => r.left + sec * r.pps;
      const md = (type, x, tgt) => `${tgt}.dispatchEvent(new MouseEvent('${type}', { bubbles: true, clientX: ${x}, clientY: ${r.top}, button: 0 }))`;
      // click (no drag) → seek
      await jeff.evalJs(`(() => { ${md('mousedown', X(bl * 2.5), "document.querySelector('#ruler')")}; ${md('mouseup', X(bl * 2.5), 'window')}; })()`);
      const ph = await jeff.evalJs(`window.cobanderDebug.engine.playhead`); assert.ok(Math.abs(ph - bl * 2.5) < bl * 0.3, `seek ${ph}`);
      // drag from inside bar 2 to inside bar 4 → loop bars 2–4 exactly
      await jeff.evalJs(`(() => { ${md('mousedown', X(bl * 1.3), "document.querySelector('#ruler')")}; ${md('mousemove', X(bl * 2.2), 'window')}; ${md('mousemove', X(bl * 3.6), 'window')}; ${md('mouseup', X(bl * 3.6), 'window')}; })()`);
      const lp = await jeff.evalJs(`window.cobanderDebug.engine.loop`);
      const gs = await jeff.evalJs(`(() => { const e = window.cobanderDebug.engine; const t = document.querySelector('#snap-ind').textContent; const m = /1\\/(\\d+)/.exec(t); return m ? e.beatLen() * 4 / Number(m[1]) : e.beatLen() * e.timeSig[0]; })()`);
      assert.ok(lp.enabled && Math.abs(lp.start - Math.floor(bl * 1.3 / gs) * gs) < 1e-6 && Math.abs(lp.end - (Math.floor(bl * 3.6 / gs) + 1) * gs) < 1e-6, `loop on the zoom's grid (${gs}s): ${JSON.stringify(lp)}`);
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(200);
      // snap locked to Bar → whole bars 2–4 exactly
      await jeff.evalJs(`(() => { window.cobanderDebug.state.snapMode = 'bar'; ${md('mousedown', X(bl * 1.3), "document.querySelector('#ruler')")}; ${md('mousemove', X(bl * 2.2), 'window')}; ${md('mousemove', X(bl * 3.6), 'window')}; ${md('mouseup', X(bl * 3.6), 'window')}; window.cobanderDebug.state.snapMode = 'auto'; })()`);
      const lp2 = await jeff.evalJs(`window.cobanderDebug.engine.loop`);
      assert.ok(Math.abs(lp2.start - bl) < 1e-6 && Math.abs(lp2.end - bl * 4) < 1e-6, `bar snap loop ${JSON.stringify(lp2)}`);
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(200);
      // a click on a take of the already-selected track moves the playhead there; the first click (selecting) doesn't
      const a = (await gtrClips()).find((c) => c.name === 'riff A'); const other = (await jeff.get('/state')).song.tracks.find((t) => t.name !== 'Gtr').id;
      await jeff.evalJs(`window.cobanderDebug.state.selectedTrack = ${JSON.stringify(other)}; window.cobanderDebug.engine.seek(0)`);
      const clickClip = `(() => { const d = document.querySelector('.clip[data-id="${a.id}"]'); const b = d.getBoundingClientRect(); const x = b.left + Math.min(b.width - 6, 2 * window.cobanderDebug.state.pxPerSec), y = b.top + b.height / 2;
        d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 })); window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 })); return true; })()`;
      await jeff.evalJs(clickClip); await sleep(150);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.playhead`), 0, 'first click only selects');
      await jeff.evalJs(clickClip); await sleep(150);
      const ph2 = await jeff.evalJs(`window.cobanderDebug.engine.playhead`); assert.ok(Math.abs(ph2 - (a.start + 2)) < 0.3, `second click seeks: ${ph2}`);
      assert.equal((await gtrClips()).find((c) => c.id === a.id).start, a.start, 'the take did not move');
    });
    await step('melody note editor: opens the part\'s melody, drag moves a note (in key), double-click adds / deletes, Undo edit, Cancel puts it back, Done keeps an edit', async () => {
      const ch = (await jeff.get('/collab')).sections.find((x) => /^Chorus/.test(x.name));
      const melClip = async () => (await jeff.get('/state')).song.tracks.find((t) => t.instrument === 'synth:voice').clips.find((c) => c.melody && Math.abs(c.start - ch.start) < 1e-3);
      const openOn = async () => {
        await jeff.evalJs(`document.querySelector('#btn-melody').click()`); await until(() => jeff.evalJs(`document.querySelector('#melody').open`), 5000, 'melody dialog');
        await jeff.evalJs(`(() => { const s = document.querySelector('#ml-section'); s.value = ${JSON.stringify(ch.id)}; s.dispatchEvent(new Event('change')); })()`); await sleep(300);
      };
      const before = (await melClip()).notes;
      await openOn();
      assert.equal(await jeff.evalJs(`window.cobanderDebug.state.mel.gen.notes.length`), before.length, 'the existing melody is open in the editor');
      const p = await jeff.evalJs(`window.cobanderDebug.rollAt(0)`); assert.ok(p, 'note 0 on the roll');
      const ev = (type, x, y, extra = '') => `document.querySelector('#ml-roll').dispatchEvent(new PointerEvent('${type}', { bubbles: true, clientX: ${x}, clientY: ${y}, button: 0, buttons: 1, pointerId: 7${extra} }))`;
      const tx = p.x + p.grid * p.pxPerSec * 2, ty = p.y - p.rowH * 2;
      await jeff.evalJs(`(() => { ${ev('pointerdown', p.x, p.y)}; ${ev('pointermove', (p.x + tx) / 2, (p.y + ty) / 2)}; ${ev('pointermove', tx, ty)}; ${ev('pointerup', tx, ty)}; })()`); await sleep(300);
      const after = (await melClip()).notes;
      const G = [7, 9, 11, 0, 2, 4, 6]; const b0 = before.slice().sort((a, b) => a.t - b.t)[0];
      const moved = after.find((n) => n.l === b0.l && Math.abs(n.t - (Math.round((ch.start + b0.t) / p.grid) * p.grid - ch.start + 2 * p.grid)) < 1e-6);
      assert.ok(moved, `note moved two 16ths: ${JSON.stringify(after.slice(0, 3))}`); assert.ok(moved.n > b0.n, 'moved up'); assert.ok(G.includes(moved.n % 12), 'stays in G');
      assert.ok(after.every((n) => !('_line' in n)), 'draft-only fields stay out of the song');
      // double-click on an empty spot high up adds a note; Undo edit takes it back; double-click a note deletes it
      const dbl = (x, y) => `document.querySelector('#ml-roll').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${x}, clientY: ${y} }))`;
      await jeff.evalJs(dbl(p.left + p.gut + 40, p.top + p.topPad + p.rowH * 1.5)); await sleep(200);
      assert.equal((await melClip()).notes.length, before.length + 1, 'added');
      await jeff.evalJs(`document.querySelector('#ml-undo').click()`); await sleep(200);
      assert.equal((await melClip()).notes.length, before.length, 'Undo edit');
      const q = await jeff.evalJs(`window.cobanderDebug.rollAt(1)`); await jeff.evalJs(dbl(q.x, q.y)); await sleep(200);
      assert.equal((await melClip()).notes.length, before.length - 1, 'deleted');
      await jeff.shot('melody-editor');
      await jeff.evalJs(`document.querySelector('#melody form').requestSubmit(document.querySelector('#melody menu button.cancel'))`); await sleep(500);
      const back = (await melClip()).notes; const key = (n) => `${n.t.toFixed(4)}:${n.n}:${n.l || ''}`;
      assert.deepEqual(back.map(key).sort(), before.map(key).sort(), 'Cancel puts the melody back as it was');
      // Done keeps an edit
      await openOn();
      const p2 = await jeff.evalJs(`window.cobanderDebug.rollAt(0)`);
      await jeff.evalJs(`(() => { ${ev('pointerdown', p2.x, p2.y)}; ${ev('pointerup', p2.x, p2.y)}; const c = document.querySelector('#ml-roll'); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true })); })()`); await sleep(200);
      await jeff.evalJs(`document.querySelector('#melody form').requestSubmit(document.querySelector('#melody menu button.primary'))`); await sleep(500);
      const kept = (await melClip()).notes.slice().sort((a, b) => a.t - b.t); assert.equal(kept[0].n, b0.n + 12, 'Shift+↑ = up an octave, kept after Done');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
    });
    await step('key change on a section; chart and chord picker follow it; parts know their key', async () => {
      const ch = (await jeff.get('/collab')).sections.find((x) => /^Chorus/.test(x.name));
      await jeff.post('/sections', { update: [{ id: ch.id, key: 'A' }] });
      assert.match((await jeff.get('/chart')).text, /\[CHORUS[^\n]*key A/);
      assert.equal(await jeff.evalJs(`[...document.querySelectorAll('#section-lane .skey')].map((x) => x.textContent).join(',')`), 'A');
      const m = await jeff.post('/melody', { text: 'la la la la', sectionId: ch.id, seed: 1 }); assert.equal(m.key, 'A');
      const A = [9, 11, 1, 2, 4, 6, 8]; for (const n of m.notes) assert.ok(A.includes(n.n % 12));
      const part = (await jeff.get('/parts')).find((x) => x.name === 'E2E riff'); assert.equal(part.key, 'G'); assert.equal(part.keySource, 'song');
      const k = await jeff.post('/part/key', { partId: part.id, detect: true }); assert.ok(k.key, 'a key was heard'); assert.equal(k.source, 'audio');
      await jeff.post('/part/key', { partId: part.id, key: 'G' });
      await jeff.post('/sections', { update: [{ id: ch.id, key: null }] });
      // repeated lines both get pinned (not collapsed into one)
      const v = (await jeff.get('/collab')).sections.find((x) => /^Verse/.test(x.name));
      await jeff.post('/melody', { text: 'over and over\nover and over', sectionId: v.id, seed: 3, place: true });
      assert.equal((await jeff.get('/collab')).lyrics.filter((l) => l.text === 'over and over' && typeof l.time === 'number').length, 2);
    });
    await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=notes]').click()`); await jeff.shot('song');

    await kat.start();
    await step('Kat: song list shows needs, @mention badge and Jeff\'s presence', async () => {
      const songs = await until(async () => { const l = await kat.get('/songs'); const s = l.find((x) => x.folder === 'E2E Song'); return s && s.presence.length ? l : null; }, 30000, 'presence');
      const s = songs.find((x) => x.folder === 'E2E Song');
      assert.equal(s.needsOpen, 3); assert.equal(s.mentions, 1); assert.equal(s.needsMine, 1, 'the harmony is assigned to Kat'); assert.equal(s.presence[0].user, 'Jeff'); assert.equal(s.presence[0].mode, 'editing');
      await until(() => kat.evalJs(`document.querySelector('#song-list .chip-s.ping') && document.querySelector('#song-list .chip-s.ping').textContent`), 10000, 'ping chip');
      await kat.shot('songlist');
    });
    await step('Kat opens read-only, sees "Jeff is editing", then Jeff sees Kat listening', async () => {
      await kat.post('/song/open', { folder: 'E2E Song' });
      const st = await kat.get('/state'); assert.equal(st.readOnly, true);
      await until(() => kat.evalJs(`!document.querySelector('#presence-line').hidden && document.querySelector('#presence-line').textContent`), 30000, 'presence line on Kat');
      await kat.post('/transport', { action: 'play' });
      const line = await until(() => jeff.evalJs(`!document.querySelector('#presence-line').hidden && document.querySelector('#presence-line').textContent`), 40000, 'presence line on Jeff'); assert.match(line, /Kat/);
      await kat.post('/transport', { action: 'stop' });
      const forYou = await kat.evalJs(`document.querySelector('#for-you').hidden ? '' : document.querySelector('#for-you').textContent`); assert.match(forYou, /For you/);
      await kat.shot('readonly');
    });
    await step('two editors: Kat takes over and adds, Jeff adds while read-only, both survive', async () => {
      await kat.post('/song/takeover');
      await until(async () => (await jeff.get('/state')).readOnly, 30000, 'Jeff to drop to read-only');
      await kat.post('/needs', { add: ['needs a real drummer'] });
      const c = await kat.get('/collab'); const n = c.notes.find((x) => x.text === 'tighten this up');
      await kat.post('/note/reply', { noteId: n.id, text: 'on it @Jeff' });
      assert.equal((await kat.post('/song/save')).result, 'ok');
      await jeff.post('/song/takeover');
      const cnt = (await jeff.get('/collab')).sections.find((x) => x.name === 'Count-in');
      await jeff.post('/sections', { update: [{ id: cnt.id, name: 'Intro' }] });   // an edit to an entry that exists on both sides: must survive "save mine"
      await jeff.post('/lyrics', { add: [{ text: 'jeff line', bar: 20 }] });
      await jeff.post('/sections', { add: [{ name: 'Bridge', startBar: 19, endBar: 22 }] });
      const r = await jeff.post('/song/save');
      const r2 = r.result === 'conflict' ? await jeff.post('/song/save', { force: true }) : r;
      assert.equal(r2.result, 'ok', JSON.stringify(r2));
      const disk = JSON.parse(await fsp.readFile(path.join(shared, 'E2E Song', 'song.json'), 'utf8'));
      const live = (k) => (disk[k] || []).filter((x) => !x.deleted);
      assert.ok(live('needs').some((x) => x.text === 'needs a real drummer'), 'Kat\'s need kept');
      assert.ok(live('lyrics').some((x) => x.text === 'jeff line'), 'Jeff\'s lyric kept');
      assert.ok(live('sections').some((x) => x.name === 'Bridge'), 'Jeff\'s section kept');
      assert.ok(live('sections').some((x) => x.name === 'Intro') && !live('sections').some((x) => x.name === 'Count-in'), 'Jeff\'s rename survives the merge (frozen base)');
      assert.ok(live('markers').find((x) => x.text === 'tighten this up').replies.some((x) => /on it/.test(x.text)), 'Kat\'s reply kept');
      assert.ok(disk.activity.some((a) => a.by === 'Kat') && disk.activity.some((a) => a.by === 'Jeff'));
    });
    await step('save as band template, then the new-song wizard builds a song from it and from a built-in', async () => {
      const t = await jeff.post('/template', { name: 'E2E shape' }); assert.equal(t.id, 'band-e2e-shape');
      assert.ok(fs.existsSync(path.join(shared, '_templates', 'band-e2e-shape.json')));
      const list = await jeff.get('/templates'); assert.ok(list.some((x) => x.band && x.name === 'E2E shape')); assert.ok(list.some((x) => x.id === 'pop-punk'));
      assert.ok(!(await jeff.get('/songs')).some((s) => s.folder === '_templates'), 'templates folder is not a song');
      // the wizard, through the UI
      await jeff.evalJs(`document.querySelector('#btn-new-song').click()`);
      await until(() => jeff.evalJs(`document.querySelector('#newsong').open`), 5000, 'wizard open');
      await jeff.evalJs(`(() => { document.querySelector('#ns-name').value = 'Wizard Song'; document.querySelector('#ns-templates [data-id="pop-punk"]').click(); const s = document.querySelector('#ns-arr'); s.value = 'pop-punk:cold-open'; s.dispatchEvent(new Event('change')); })()`);
      await sleep(400); await jeff.shot('wizard');
      assert.match(await jeff.evalJs(`document.querySelector('#ns-structure').textContent`), /^Chorus 1/);
      await jeff.evalJs(`document.querySelector('#ns-create').click()`);
      const st = await until(async () => { const s2 = await jeff.get('/state'); return s2.folder === 'Wizard Song' && s2.song.tracks.length >= 5 && !s2.dirty ? s2 : null; }, 20000, 'wizard song set up');
      assert.equal(st.song.bpm, 180);
      const c = await jeff.get('/collab'); assert.equal(c.sections[0].name, 'Chorus 1'); assert.equal(c.sections.length, 8);
      assert.deepEqual(st.song.tracks.map((x) => x.type), ['guitar', 'guitar', 'bass', 'vocals', 'drums']);
      await jeff.shot('wizard-song');
      // API: from the band template
      const r = await jeff.post('/song/create', { name: 'From Band Template', template: 'band-e2e-shape' });
      assert.ok(r.sections >= 3); assert.equal(r.tracks, (await jeff.get('/state')).song.tracks.length);
      const r2 = await jeff.post('/song/create', { name: 'Ska API', template: 'ska', bpm: 160, key: 'Am' });
      const st2 = await jeff.get('/state'); assert.equal(st2.song.bpm, 160); assert.equal(st2.song.key, 'Am'); assert.ok(r2.sections >= 7);
      // drop the E2E riff (120 bpm, G) into it: re-timed to 160 and moved G → Am (relative of C) = +5 semitones
      const part = (await jeff.get('/parts')).find((x) => x.name === 'E2E riff');
      const d = await jeff.post('/part/drop', { partId: part.id, at: 0 }); assert.equal(d.semis, 5); assert.ok(Math.abs(d.ratio - 160 / 120) < 1e-9);
      const st3 = await jeff.get('/state'); const pc = st3.song.tracks.flatMap((t) => t.clips).find((c) => c.part && c.part.id === part.id);
      assert.ok(pc, 'dropped clip is in the song'); assert.ok(Math.abs((pc.duration - pc.trimStart - pc.trimEnd) - 6 * 120 / 160) < 0.05, `length ${pc.duration - pc.trimStart - pc.trimEnd}`);
    });
    await step('song key from the recordings: detect via the API, auto-set after a take is dropped into a song with no key', async () => {
      const r0 = await jeff.post('/song/create', { name: 'Key Song', bpm: 120 }); assert.ok(r0);
      await jeff.post('/song/patch', { key: '' }); assert.ok(!(await jeff.get('/state')).song.key);
      // G major, played as a little tune with harmonics (like a guitar line)
      const notes = [55, 59, 62, 67, 62, 59, 57, 60, 64, 66, 67, 62, 55, 59, 62, 67];
      const sr = 48000, per = 0.4, n = Math.round(notes.length * per * sr); const b = Buffer.alloc(44 + n * 2);
      b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
      for (let i = 0; i < n; i++) { const k = Math.min(notes.length - 1, Math.floor(i / (per * sr))); const f = 440 * 2 ** ((notes[k] - 69) / 12); const env = Math.exp(-((i / sr) % per) * 3); let v = 0; for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * i / sr) / h; b.writeInt16LE(Math.round(v * env * 8000), 44 + i * 2); }
      await fsp.writeFile(path.join(WORK, 'gtune.wav'), b);
      await jeff.post('/clip/import', { path: path.join(WORK, 'gtune.wav'), start: 0, name: 'G tune' });
      const r = await jeff.post('/song/key/detect', {}); assert.ok(['G', 'Em'].includes(r.key), JSON.stringify(r)); assert.equal(r.source, 'audio');
      await jeff.post('/song/key/detect', { apply: true }); assert.equal((await jeff.get('/state')).song.key, r.key);
      // auto: clear the key, drop the same audio in through the window → key set by itself
      await jeff.post('/song/patch', { key: '' });
      await jeff.evalJs(`(async () => { const notes = ${JSON.stringify(notes)}, sr = 48000, per = 0.4, n = Math.round(notes.length * per * sr); const c = new Float32Array(n);
        for (let i = 0; i < n; i++) { const k = Math.min(notes.length - 1, Math.floor(i / (per * sr))); const f = 440 * 2 ** ((notes[k] - 69) / 12); const env = Math.exp(-((i / sr) % per) * 3); let v = 0; for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * i / sr) / h; c[i] = v * env * 0.25; }
        const dt = new DataTransfer(); dt.items.add(new File([window.BPWav.encodeWav([c], sr, 16)], 'Dan gtr.wav', { type: 'audio/wav' }));
        document.querySelector('#bottom').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
      const k = await until(async () => (await jeff.get('/state')).song.key, 20000, 'auto key'); assert.ok(['G', 'Em'].includes(k), k);
      assert.equal((await jeff.post('/song/save')).result, 'ok');
    });
    await step('transpose: the song moves up 2 (audio really pitched, chords, key) and back down to the original files; a section moves alone', async () => {
      await jeff.post('/song/patch', { key: 'G' });
      await jeff.post('/chords', { fromBar: 1, bars: 'G D | Em C' });
      const st0 = await jeff.get('/state'); const aud0 = st0.song.tracks.flatMap((t) => t.clips).filter((c) => c.kind !== 'midi');
      assert.ok(aud0.length >= 2, 'two audio takes');
      const r = await jeff.post('/song/transpose', { semis: 2 }); assert.equal(r.key, 'A');
      const st1 = await jeff.get('/state'); const aud1 = st1.song.tracks.flatMap((t) => t.clips).filter((c) => c.kind !== 'midi');
      for (const c of aud1) { assert.ok(c.ps && c.ps.semis === 2, `ps on ${c.name}`); assert.ok(c.src && c.src !== (aud0.find((x) => x.id === c.id).src || c.id), 'new file'); }
      assert.deepEqual((await jeff.get('/collab')).chords.map((c) => c.chord).slice(0, 4), ['A', 'E', 'F#m', 'D']);
      const heard = await jeff.post('/song/key/detect', {}); assert.ok(['A', 'F#m'].includes(heard.key), `the audio really moved: ${JSON.stringify(heard)}`);
      const len = (c) => c.duration - c.trimStart - c.trimEnd; for (const c of aud1) assert.ok(Math.abs(len(c) - len(aud0.find((x) => x.id === c.id))) < 0.05, 'same length (tempo kept)');
      await jeff.post('/song/transpose', { semis: -2 });
      const st2 = await jeff.get('/state'); const aud2 = st2.song.tracks.flatMap((t) => t.clips).filter((c) => c.kind !== 'midi');
      for (const c of aud2) { const o = aud0.find((x) => x.id === c.id); assert.equal(c.src || null, o.src || null, 'back on the original recording'); assert.ok(!c.ps); }
      assert.equal(st2.song.key, 'G'); assert.deepEqual((await jeff.get('/collab')).chords.map((c) => c.chord).slice(0, 4), ['G', 'D', 'Em', 'C']);
      // one section: the take is cut at the section edges, only the inside moves; the section gets the new key
      await jeff.post('/sections', { add: [{ name: 'Bridge', startBar: 2, endBar: 2 }] });
      const br = (await jeff.get('/collab')).sections.find((x) => x.name === 'Bridge');
      const n0 = (await jeff.get('/state')).song.tracks.flatMap((t) => t.clips).length;
      const r2 = await jeff.post('/song/transpose', { semis: 3, sectionId: br.id }); assert.equal(r2.sectionKey, 'Bb'); assert.equal(r2.key, 'G');
      const clips = (await jeff.get('/state')).song.tracks.flatMap((t) => t.clips);
      assert.ok(clips.length > n0, 'takes were cut at the section edges');
      const moved = clips.filter((c) => c.ps); assert.ok(moved.length >= 1 && moved.every((c) => Math.abs(c.start - br.start) < 1e-6), 'only the inside piece moved');
      assert.equal((await jeff.get('/collab')).chords.find((c) => Math.abs(c.time - br.start) < 1e-6).chord, 'Gm', 'the chord in the section moved (Em → Gm)');
      const r3 = await jeff.post('/song/transpose', { semis: -3, sectionId: br.id }); assert.equal(r3.sectionKey, '', 'back on the song key: no separate section key');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
    });
    await step('QA regressions: song object survives a save, playback runs to the end of the sections, blank bpm ignored, wizard keeps the open song on a taken name, melody Keep/Cancel', async () => {
      const sec = (await jeff.get('/collab')).sections[0];
      await jeff.evalJs(`window.__s0 = window.cobanderDebug.state.song.sections.find((x) => x.id === ${JSON.stringify(sec.id)}); true`);
      await jeff.post('/sections', { update: [{ id: sec.id, name: 'Intro' }] }); assert.equal((await jeff.post('/song/save')).result, 'ok');
      assert.equal(await jeff.evalJs(`window.__s0 === window.cobanderDebug.state.song.sections.find((x) => x.id === ${JSON.stringify(sec.id)})`), true, 'lanes keep editing the live song after a save');
      await jeff.post('/sections', { add: [{ name: 'Outro', startBar: 30, endBar: 33 }] });
      const bl = await jeff.evalJs(`window.cobanderDebug.engine.beatLen() * window.cobanderDebug.engine.timeSig[0]`);
      assert.ok(await jeff.evalJs(`window.cobanderDebug.engine.contentLength()`) >= 33 * bl - 1e-6, 'playback runs to the end of the last section');
      const bpm0 = (await jeff.get('/state')).song.bpm;
      await jeff.evalJs(`(() => { const b = document.querySelector('#bpm'); b.value = ''; b.dispatchEvent(new Event('change')); })()`); await sleep(300);
      assert.equal((await jeff.get('/state')).song.bpm, bpm0, 'blank bpm box changes nothing');
      // wizard: a name that clashes (different case) keeps the dialog open AND the current song open
      const folder0 = (await jeff.get('/state')).folder;
      await jeff.evalJs(`document.querySelector('#btn-new-song').click()`); await until(() => jeff.evalJs(`document.querySelector('#newsong').open`), 5000, 'wizard');
      await jeff.evalJs(`(() => { document.querySelector('#ns-name').value = ${JSON.stringify(folder0.toUpperCase())}; document.querySelector('#ns-create').click(); })()`);
      await until(() => jeff.evalJs(`!document.querySelector('#ns-err').hidden`), 5000, 'name error shown');
      assert.equal(await jeff.evalJs(`document.querySelector('#newsong').open`), true, 'dialog stays open');
      assert.equal((await jeff.get('/state')).folder, folder0, 'current song still open');
      await jeff.evalJs(`document.querySelector('#newsong form').requestSubmit(document.querySelector('#newsong menu button.cancel'))`); await sleep(300);
      // melody: Keep → clicking the kept one keeps the dialog open; Cancel leaves no melody, no Melody track and nothing to undo
      const undo0 = await jeff.evalJs(`window.cobanderDebug.state.undo.length`); const tracks0 = (await jeff.get('/state')).song.tracks.length;
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=lyrics]').click(); document.querySelector('#btn-melody').click()`); await until(() => jeff.evalJs(`document.querySelector('#melody').open`), 5000, 'melody');
      await jeff.evalJs(`(() => { const t = document.querySelector('#ml-text'); t.value = 'la la la la'; t.dispatchEvent(new Event('input')); document.querySelector('#ml-again').click(); document.querySelector('#ml-star').click(); document.querySelector('#ml-again').click(); document.querySelector('#ml-kept button').click(); })()`); await sleep(300);
      assert.equal(await jeff.evalJs(`document.querySelector('#melody').open`), true, 'bringing back a kept melody does not close the dialog');
      await jeff.evalJs(`document.querySelector('#melody form').requestSubmit(document.querySelector('#melody menu button.cancel'))`); await sleep(500);
      const st = await jeff.get('/state'); assert.equal(st.song.tracks.length, tracks0, 'no leftover Melody track');
      assert.equal(await jeff.evalJs(`window.cobanderDebug.state.undo.length`), undo0, 'nothing from the cancelled visit left to undo');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
    });
    await step('0.8: drum part (generated + edited in the drum editor), chord notes survive reload, parts tags/sort, band feed, pane splitters, noodle pad', async () => {
      // drums: generated part for a section replaces the groove there; the editor's fill menu fills a row
      const sec = (await jeff.get('/collab')).sections[0];
      const d = await jeff.post('/drum-part', { sectionId: sec.id, style: 'punk', seed: 7 }); assert.ok(d.notes > 8, JSON.stringify(d));
      let st = await jeff.get('/state'); const dt = st.song.tracks.find((t) => t.id === d.trackId); assert.equal(dt.instrument, 'drumkit');
      const dc = dt.clips.find((c) => c.id === d.clipId); assert.ok(Math.abs(dc.start - sec.start) < 1e-6 && dc.notes.some((n) => n.n === 38));
      await jeff.evalJs(`document.querySelector('#btn-drums').click()`); await until(() => jeff.evalJs(`document.querySelector('#drumed').open`), 5000, 'drum editor');
      await jeff.evalJs(`(() => { const s = document.querySelector('#dr-section'); s.value = ${JSON.stringify(sec.id)}; s.dispatchEvent(new Event('change')); })()`); await sleep(200);
      const n0 = await jeff.evalJs(`window.cobanderDebug.state.dr.hits.length`); assert.ok(n0 > 8, "existing part loaded");
      await jeff.evalJs(`document.querySelectorAll('#dr-rows .dr-row')[2].querySelector('button').click()`); await sleep(200);   // Hi-hat → fill menu
      await jeff.evalJs(`[...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => x.textContent.includes('1/16 notes')).click()`); await sleep(300);
      const sixteenths = Math.round((sec.end - sec.start) / (await jeff.evalJs(`window.cobanderDebug.engine.beatLen()`) / 4));
      assert.equal(await jeff.evalJs(`window.cobanderDebug.state.dr.hits.filter((h) => h.voice === 'hat').length`), sixteenths, 'hat row filled with 16ths across the part');
      // click a square (pointer) on the kick row adds a hit
      const before = await jeff.evalJs(`window.cobanderDebug.state.dr.hits.length`);
      await jeff.evalJs(`(() => { const cv = document.querySelector('#dr-canvas'); const r = cv.getBoundingClientRect(); const cw = r.width / ${sixteenths}; const x = r.left + 3 * cw + cw / 2, y = r.top + 18 + 5 * 28 + 10; for (const t of ['pointerdown', 'pointerup']) cv.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 3 })); })()`); await sleep(200);
      assert.notEqual(await jeff.evalJs(`window.cobanderDebug.state.dr.hits.length`), before, 'clicking a square toggles a hit');
      await jeff.shot('drums');
      await jeff.evalJs(`document.querySelector('#drumed form').requestSubmit(document.querySelector('#drumed menu button.primary'))`); await sleep(400);
      st = await jeff.get('/state'); assert.equal(st.song.tracks.find((t) => t.id === d.trackId).clips.find((c) => c.id === d.clipId).notes.filter((n) => n.n === 42).length, sixteenths, 'kept after Done');
      // chord notes: a power chord on a synth note survives save + reload and exports
      await jeff.post('/song/patch', { addTrack: { kind: 'keys', name: 'Chug' } });
      await jeff.post('/midi/notes', { name: 'Chug', notes: [{ t: 0, d: 0.5, n: 40, v: 0.8 }], start: 0 }); await sleep(200);
      const chugId = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Chug').clips[0].id;
      // open the note editor and use the right-click chord menu
      await jeff.evalJs(`(() => { const c = document.querySelector('.clip[data-id="${chugId}"]'); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: c.getBoundingClientRect().left + 5, clientY: c.getBoundingClientRect().top + 5 })); [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => /Edit notes/.test(x.textContent)).click(); })()`);
      await until(() => jeff.evalJs(`document.querySelector('#noteed').open`), 5000, 'note editor');
      await jeff.evalJs(`(() => { const cv = document.querySelector('#ne-roll'); const G = window.cobanderDebug.rollAt(0); cv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: G.x, clientY: G.y })); [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => /^Power chord/.test(x.querySelector('.ctx-label').textContent.replace('✓ ', ''))).click(); })()`); await sleep(300);
      await jeff.evalJs(`document.querySelector('#noteed form').requestSubmit(document.querySelector('#noteed menu button.primary'))`); await sleep(300);
      assert.equal((await jeff.post('/song/save')).result, 'ok'); await jeff.post('/song/reload');
      st = await jeff.get('/state'); const chug = st.song.tracks.find((t) => t.name === 'Chug').clips[0];
      assert.deepEqual(chug.notes[0].iv, [0, 7], 'power chord stored on the root note and survives reload');
      // parts: auto tags + style, tag edit via API, sort by style groups
      const p = await jeff.post('/part', { name: 'Tag test', sectionId: sec.id }); const parts = await jeff.get('/parts'); const pp = parts.find((x) => x.name === 'Tag test');
      assert.ok(pp && pp.tags.includes('drums'), `auto tags: ${JSON.stringify(pp && pp.tags)}`);
      await jeff.post('/part/tags', { partId: pp.id, tags: ['Riff', 'heavy'], style: 'Pop-punk' });
      const pp2 = (await jeff.get('/parts')).find((x) => x.id === pp.id); assert.deepEqual(pp2.tags, ['riff', 'heavy']); assert.equal(pp2.style, 'Pop-punk');
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=parts]').click(); const s = document.querySelector('#parts-sort'); s.value = 'style'; s.dispatchEvent(new Event('change')); true`); await sleep(300);
      assert.ok(await jeff.evalJs(`[...document.querySelectorAll('#part-list .pgroup')].some((x) => x.textContent === 'Pop-punk')`), 'grouped by style');
      assert.ok(await jeff.evalJs(`[...document.querySelectorAll('#part-list .ptag')].some((x) => x.textContent === 'heavy')`), 'tags shown');
      // band feed + splitters
      await jeff.evalJs(`window.cobanderDebug && true`); await sleep(200);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#band-feed li').length > 0`), 'band feed has entries');
      assert.equal(await jeff.evalJs(`document.querySelectorAll('.vsplit').length`), 3, 'three draggable dividers');
      await jeff.evalJs(`(() => { const sp = document.querySelector('.vsplit[data-target="#notes-panel"]'); const r = sp.getBoundingClientRect(); sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left, clientY: r.top + 20 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left - 120, clientY: r.top + 20 })); window.dispatchEvent(new MouseEvent('mouseup', {})); })()`);
      // draw notes: double-click an empty spot on a MIDI lane → note editor; riff generator; click-drag draws a note snapped to 1/32
      await jeff.post('/song/patch', { addTrack: { kind: 'midiGuitar', name: 'Riffs' } });
      await jeff.evalJs(`(() => { const row = [...document.querySelectorAll('#tracks > .track')].find((r) => r.querySelector('.track-head') && r.querySelector('.track-head').textContent.includes('Riffs')); const lane = row.querySelector('.lane'); const r = lane.getBoundingClientRect(); lane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 30, clientY: r.top + 20 })); })()`);
      await until(() => jeff.evalJs(`document.querySelector('#noteed').open`), 5000, 'note editor from lane');
      await jeff.evalJs(`(() => { document.querySelector('#rf-count').value = 3; document.querySelector('#rf-rate').value = '2'; document.querySelector('#rf-roll').click(); })()`); await sleep(300);
      const rn = await jeff.evalJs(`window.cobanderDebug.state.ned.gen.notes.length`); assert.ok(rn > 3, 'riff written');
      assert.ok(await jeff.evalJs(`window.cobanderDebug.state.ned.gen.notes.every((n) => n.iv && n.iv[1] === 7)`), 'distorted guitar defaults to power chords');
      await jeff.evalJs(`(() => { const cv = document.querySelector('#ne-roll'); const G = window.cobanderDebug.rollAt(0); const box = document.querySelector('#ne-scroll'); const y = G.y + G.rowH * 3; const x0 = G.left + G.gut + 4 + G.pxPerSec * 0.5, x1 = x0 + G.pxPerSec * 0.3; cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x0, clientY: y, button: 0, pointerId: 4 })); cv.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x1, clientY: y, pointerId: 4 })); cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x1, clientY: y, pointerId: 4 })); })()`); await sleep(300);
      const drawn = await jeff.evalJs(`(() => { const g32 = window.cobanderDebug.engine.beatLen() / 8; const ns = window.cobanderDebug.state.ned.gen.notes; return { n: ns.length, ok: ns.every((x) => Math.abs(x.t / g32 - Math.round(x.t / g32)) < 1e-6) }; })()`);
      assert.equal(drawn.n, rn + 1, 'click-drag drew a note'); assert.ok(drawn.ok, 'snapped to 1/32');
      await jeff.shot('noteed');
      await jeff.evalJs(`document.querySelector('#noteed form').requestSubmit(document.querySelector('#noteed menu button.primary'))`); await sleep(300);
      { const tr = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Riffs'); assert.equal(tr.instrument, 'synth:distgtr'); assert.equal(tr.clips.length, 1); assert.equal(tr.clips[0].notes.length, rn + 1); }
      // drag the last track's head to the top
      const order0 = (await jeff.get('/state')).song.tracks.map((t) => t.name);
      await jeff.evalJs(`(() => { const rows = [...document.querySelectorAll('#tracks > .track')]; const h = rows[rows.length - 1].querySelector('.track-head'); const hr = h.getBoundingClientRect(); const top = rows[0].getBoundingClientRect();
        h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: hr.left + 60, clientY: hr.top + 30 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: hr.left + 60, clientY: hr.top + 10 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: hr.left + 60, clientY: top.top + 5 })); window.dispatchEvent(new MouseEvent('mouseup', {})); })()`); await sleep(300);
      const order1 = (await jeff.get('/state')).song.tracks.map((t) => t.name);
      assert.equal(order1[0], order0[order0.length - 1], `dragged to the top: ${order1.join(', ')}`);
      // noodle pad
      await jeff.evalJs(`document.querySelector('#btn-noodle').click()`);
      const nst = await until(async () => { const x = await jeff.get('/state'); return x.folder === 'Noodle pad - Jeff' && !x.dirty && x.song.sandbox ? x : null; }, 20000, 'noodle pad');
      assert.ok(nst.song.sandbox && nst.song.tracks.length === 1 && nst.song.loop.enabled, 'noodle pad: one track, loop on');
      await jeff.shot('noodle');
    });
    await step('updater bar appears for a newer installer in the shared folder', async () => {
      await fsp.mkdir(path.join(shared, 'installers'), { recursive: true });
      const key = process.platform === 'linux' ? `linux-${process.arch}` : 'win-x64';
      await fsp.writeFile(path.join(shared, 'installers', 'x.bin'), 'x');
      await fsp.writeFile(path.join(shared, 'installers', 'latest.json'), JSON.stringify({ version: '99.0.0', notes: ['test'], files: { [key]: 'x.bin' }, size: { [key]: 1 } }));
      await jeff.evalJs(`document.querySelector('#s-check-update').click()`);
      await until(() => jeff.evalJs(`!document.querySelector('#update-bar').hidden`), 10000, 'update bar');
      await fsp.rm(path.join(shared, 'installers'), { recursive: true });
    });
    await step('0.8.3: snap follows the zoom (sections, chip), takes drag between tracks with a ghost + drop outline, Shift-drag copies, note editor Ctrl+D / Shift-drag duplicates', async () => {
      await jeff.post('/song/create', { name: 'Snap Song', bpm: 120 });
      await jeff.post('/sections', { add: [{ name: 'Verse', startBar: 1, endBar: 4 }] });
      await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'Gtr A' } }); await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'Gtr B' } });
      let st = await jeff.get('/state'); const ta = st.song.tracks.find((t) => t.name === 'Gtr A'), tb = st.song.tracks.find((t) => t.name === 'Gtr B');
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: ta.id, start: 0, name: 'lick' }); await sleep(300);
      // zoom in: 160 px/s at 120 bpm → a beat is 80 px → snap 1/16
      await jeff.evalJs(`(() => { window.cobanderDebug.state.pxPerSec = 160; document.querySelector('#arrange').dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 0.0001, bubbles: true, cancelable: true })); return true; })()`); await sleep(300);
      const px = await jeff.evalJs(`window.cobanderDebug.state.pxPerSec`);
      const chip = await jeff.evalJs(`document.querySelector('#snap-ind').textContent`); assert.match(chip, /1\/(8|16)/, chip);
      const sixteenth = 0.125, g = /1\/16/.test(chip) ? sixteenth : 0.25;
      const v = (await jeff.get('/collab')).sections.find((x) => x.name === 'Verse');
      await jeff.evalJs(`(() => { const b = document.querySelector('#section-lane .section-block[data-id="${v.id}"]'); const r = b.getBoundingClientRect(); const x = r.left + 30, y = r.top + r.height / 2;
        b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 4, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + ${px} * ${g} * 3 + 2, clientY: y })); window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + ${px} * ${g} * 3 + 2, clientY: y })); return true; })()`); await sleep(300);
      const v2 = (await jeff.get('/collab')).sections.find((x) => x.id === v.id); assert.ok(Math.abs(v2.start - (v.start + 3 * g)) < 1e-6, `section snapped to ${g}s steps: ${v.start} → ${v2.start}`);
      // take dragged onto Gtr B: ghost follows the mouse, outline on B, then it lands on B
      const lick = (await jeff.get('/state')).song.tracks.find((t) => t.id === ta.id).clips[0];
      await jeff.evalJs(`(() => { document.querySelector('.track[data-id="${ta.id}"]').scrollIntoView({ block: 'center' }); document.querySelector('#arrange').scrollLeft = 0; return true; })()`); await sleep(200);
      const mid = await jeff.evalJs(`(() => { const c = document.querySelector('.clip[data-id="${lick.id}"]'); const r = c.getBoundingClientRect(); const lb = document.querySelector('.track[data-id="${tb.id}"] .lane').getBoundingClientRect(); const x = r.left + 200, y = r.top + 10;
        c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 3, clientY: lb.top + 30 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 6, clientY: lb.top + 30 }));
        const hit = document.elementFromPoint(x + 6, lb.top + 30); const out = { dbg: [hit && hit.className, lb.top, y, innerHeight].join('|'), ghost: !!document.querySelector('.clip-ghost'), drop: !!document.querySelector('.track[data-id="${tb.id}"] .lane .clip-drop'), faded: c.classList.contains('drag-src') };
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + 6, clientY: lb.top + 30 })); out.after = !document.querySelector('.clip-ghost') && !document.querySelector('.clip-drop'); return out; })()`);
      assert.deepEqual({ ...mid, dbg: 0 }, { dbg: 0, ghost: true, drop: true, faded: true, after: true }, JSON.stringify(mid));
      st = await jeff.get('/state'); assert.ok(st.song.tracks.find((t) => t.id === tb.id).clips.some((c) => c.id === lick.id) && !st.song.tracks.find((t) => t.id === ta.id).clips.length, 'moved to Gtr B');
      // Shift-drag back to A = a copy (both tracks have it)
      await jeff.evalJs(`(() => { const c = document.querySelector('.clip[data-id="${lick.id}"]'); const r = c.getBoundingClientRect(); const la = document.querySelector('.track[data-id="${ta.id}"] .lane').getBoundingClientRect(); const x = r.left + 200, y = r.top + 10;
        c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true, clientX: x + 3, clientY: la.top + 30 })); window.dispatchEvent(new MouseEvent('mousemove', { shiftKey: true, clientX: x + 6, clientY: la.top + 30 }));
        window.dispatchEvent(new MouseEvent('mouseup', { shiftKey: true, clientX: x + 6, clientY: la.top + 30 })); return true; })()`); await sleep(300);
      st = await jeff.get('/state'); assert.equal(st.song.tracks.find((t) => t.id === ta.id).clips.length, 1, 'copy on A'); assert.equal(st.song.tracks.find((t) => t.id === tb.id).clips.length, 1, 'original still on B');
      // note editor: Ctrl+D duplicates the selected note right after itself; Shift-drag drags a copy
      await jeff.post('/song/patch', { addTrack: { kind: 'keys', name: 'Dup' } });
      await jeff.post('/midi/notes', { name: 'Dup', notes: [{ t: 0, d: 0.25, n: 48, v: 0.8 }, { t: 1.5, d: 0.25, n: 50, v: 0.8 }], start: 0 }); await sleep(200);
      const dupId = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Dup').clips[0].id;
      await jeff.evalJs(`(() => { const c = document.querySelector('.clip[data-id="${dupId}"]'); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: c.getBoundingClientRect().left + 5, clientY: c.getBoundingClientRect().top + 5 })); [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => /Edit notes/.test(x.textContent)).click(); })()`);
      await until(() => jeff.evalJs(`document.querySelector('#noteed').open`), 5000, 'note editor');
      const n0 = await jeff.evalJs(`window.cobanderDebug.state.ned.gen.notes.length`);
      await jeff.evalJs(`(() => { const cv = document.querySelector('#ne-roll'); const G = window.cobanderDebug.rollAt(0); cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: G.x, clientY: G.y, pointerId: 1 })); cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: G.x, clientY: G.y, pointerId: 1 }));
        cv.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true })); return true; })()`); await sleep(200);
      const ns = await jeff.evalJs(`window.cobanderDebug.state.ned.gen.notes.map((z) => [Math.round(z.t * 1000) / 1000, z.n])`);
      assert.equal(ns.length, n0 + 1, 'Ctrl+D added a note'); assert.ok(ns.some((z) => Math.abs(z[0] - 0.25) < 1e-3 && z[1] === 48), `copy right after: ${JSON.stringify(ns)}`);
      await jeff.evalJs(`(() => { const cv = document.querySelector('#ne-roll'); const G = window.cobanderDebug.rollAt(0); cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, shiftKey: true, clientX: G.x, clientY: G.y, pointerId: 1 })); cv.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, shiftKey: true, clientX: G.x + 60, clientY: G.y, pointerId: 1 })); cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: G.x + 60, clientY: G.y, pointerId: 1 })); return true; })()`); await sleep(200);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.state.ned.gen.notes.length`), n0 + 2, 'Shift-drag left the original and made a copy');
      assert.equal(await jeff.evalJs(`document.querySelector('#ne-grid').value`), 'auto');
      await jeff.evalJs(`document.querySelector('#noteed form').requestSubmit(document.querySelector('#noteed menu button.primary'))`); await sleep(300);
      assert.equal((await jeff.get('/state')).song.tracks.find((t) => t.name === 'Dup').clips[0].notes.length, n0 + 2, 'kept after Done');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
    });
    await step('0.8.4: read-only bandmate can still add a need + reply (mailbox), the editor merges it; R with nothing armed records on the selected track only', async () => {
      const folder = (await jeff.get('/state')).folder;
      await kat.post('/song/open', { folder }); await sleep(800);
      assert.equal((await kat.get('/state')).readOnly, true, 'Kat is read-only (Jeff has it)');
      await kat.evalJs(`(() => { document.querySelector('#need-input').value = 'needs a gang vocal @Jeff'; document.querySelector('#need-form').requestSubmit(); return true; })()`);
      await kat.evalJs(`window.cobanderDebug.state.song.markers = window.cobanderDebug.state.song.markers || []; true`);
      const got = await until(async () => (await jeff.get('/collab')).needs.find((n) => /gang vocal/.test(n.text) && !n.deleted), 30000, 'Jeff merges Kat\'s need from the mailbox');
      assert.equal(got.by, 'Kat');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      assert.match(JSON.stringify((await jeff.get('/state')).song.activity || []), /Kat: needs: needs a gang vocal/, 'the feed says it came from Kat');
      await until(async () => (await kat.get('/collab')).needs.some((n) => /gang vocal/.test(n.text)), 30000, 'Kat sees it after Jeff saves');
      await kat.post('/song/close').catch(() => {});
    });
    await step('0.9: track locks — Kat unlocks a track in Jeff\'s song and works on it at the same time; each can only touch their own; idle locks fade', async () => {
      await jeff.post('/song/create', { name: 'Lock Song', bpm: 120 });
      await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'Jeff gtr' } }); await jeff.post('/song/patch', { addTrack: { kind: 'bass', name: 'Kat bass' } });
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      let st = await jeff.get('/state'); const ja = st.song.tracks.find((t) => t.name === 'Jeff gtr'), kb = st.song.tracks.find((t) => t.name === 'Kat bass');
      assert.ok(await jeff.evalJs(`window.cobanderDebug.mineT('${kb.id}')`), 'Jeff (auto-unlock) has both tracks');
      await jeff.evalJs(`(async () => { await window.cobanderDebug.lockAll(); return true; })()`);
      await jeff.evalJs(`(async () => { const s = window.cobanderDebug; return true; })()`);
      await jeff.evalJs(`document.querySelector('.track[data-id="${ja.id}"] .tlock').click(); true`); await sleep(1500);
      assert.ok(await jeff.evalJs(`window.cobanderDebug.mineT('${ja.id}')`) && !(await jeff.evalJs(`window.cobanderDebug.mineT('${kb.id}')`)), 'Jeff has only his guitar now');
      // Kat opens it (read-only for the song) and unlocks the bass by clicking its 🔒
      await kat.post('/song/open', { folder: 'Lock Song' }); await sleep(1500);
      assert.equal((await kat.get('/state')).readOnly, true);
      await until(() => kat.evalJs(`!!document.querySelector('.track[data-id="${kb.id}"] .tlock')`), 10000, 'Kat sees the tracks');
      await kat.evalJs(`document.querySelector('.track[data-id="${kb.id}"] .tlock').click(); true`);
      await until(() => kat.evalJs(`window.cobanderDebug.mineT('${kb.id}')`), 10000, 'Kat has the bass');
      // each edits their own at the same time
      assert.equal(await kat.evalJs(`window.cobanderDebug.editTrack('${kb.id}', { gainDb: -11 })`), true, 'Kat can edit the bass');
      assert.equal(await kat.evalJs(`window.cobanderDebug.editTrack('${ja.id}', { gainDb: -20 })`), false, 'Kat can\'t touch Jeff\'s guitar');
      await sleep(1500);
      assert.notEqual(await kat.evalJs(`window.cobanderDebug.engine.track('${ja.id}').gainDb`), -20, 'refused edit was put back ' + await kat.evalJs(`JSON.stringify(window.__errs || [])`));
      assert.equal((await kat.get('/state')).dirty, false, 'Kat\'s track edits aren\'t "unsaved changes" (they go to Jeff)');
      await until(() => jeff.evalJs(`window.cobanderDebug.heldBy('${kb.id}') === 'Kat'`), 15000, 'Jeff sees Kat holds the bass');
      assert.equal(await jeff.evalJs(`window.cobanderDebug.editTrack('${kb.id}', { gainDb: 3 })`), false, 'Jeff can\'t touch Kat\'s bass');
      assert.equal(await jeff.evalJs(`window.cobanderDebug.editTrack('${ja.id}', { gainDb: -7 })`), true, 'Jeff edits his guitar');
      await until(async () => (await jeff.get('/state')).song.tracks.find((t) => t.id === kb.id).gainDb === -11, 20000, 'Jeff\'s song picks up Kat\'s bass change');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      st = await jeff.get('/state'); assert.equal(st.song.tracks.find((t) => t.id === ja.id).gainDb, -7); assert.equal(st.song.tracks.find((t) => t.id === kb.id).gainDb, -11);
      assert.match(JSON.stringify(st.song.activity || []), /Kat: updated Kat bass/);
      await until(async () => (await fsp.readdir(path.join(shared, 'Lock Song', '_tracks')).catch(() => [])).length === 0, 15000, 'folded post removed after the save');
      // Kat's own view keeps her bass while Jeff's saves arrive
      await sleep(3000); assert.equal(await kat.evalJs(`window.cobanderDebug.engine.track('${kb.id}').gainDb`), -11);
      // a lock nobody touches for 10 min fades: age Kat's lock file → Jeff can unlock the bass
      const lf = path.join(shared, 'Lock Song', '_tracklocks', `${kb.id}.json`); const l = JSON.parse(await fsp.readFile(lf, 'utf8')); l.at = Date.now() - 11 * 60 * 1000; await fsp.writeFile(lf, JSON.stringify(l));
      await until(() => jeff.evalJs(`window.cobanderDebug.heldBy('${kb.id}') === null`), 15000, 'faded lock is free');
      await jeff.evalJs(`document.querySelector('.track[data-id="${kb.id}"] .tlock').click(); true`);
      await until(() => jeff.evalJs(`window.cobanderDebug.mineT('${kb.id}')`), 10000, 'Jeff took the faded bass lock');
      await kat.post('/song/close').catch(() => {});
    });
    await step('0.9: parts with their takes — delete a part and close the gap, duplicate, move earlier, slice, takes move with a dragged part', async () => {
      await jeff.post('/song/create', { name: 'Parts Song', bpm: 120 });
      await jeff.post('/sections', { add: [{ name: 'Intro', startBar: 1, endBar: 2 }, { name: 'Verse', startBar: 3, endBar: 4 }, { name: 'Chorus', startBar: 5, endBar: 6 }] });
      await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'G' } });
      const g = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'G');
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 0, name: 'one' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 8, name: 'two' });
      await jeff.post('/chords', { fromBar: 5, bars: 'Em' });
      await jeff.evalJs(`(async () => { await window.cobanderDebug.unlockAll({ quiet: true }); return true; })()`);
      const secs = async () => (await jeff.get('/collab')).sections.slice().sort((a, b) => a.start - b.start).map((x) => `${x.name}:${x.start}-${x.end}`);
      const clips = async () => (await jeff.get('/state')).song.tracks.find((t) => t.id === g.id).clips.map((c) => [c.name, Math.round(c.start * 100) / 100, Math.round((c.duration - c.trimStart - c.trimEnd) * 100) / 100]).sort((a, b) => a[1] - b[1]);
      const menu = (name, label) => jeff.evalJs(`(() => { const b = [...document.querySelectorAll('#section-lane .section-block')].find((x) => x.textContent.startsWith(${JSON.stringify(name)})); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.getBoundingClientRect().left + 5, clientY: b.getBoundingClientRect().top + 5 })); const it = [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => x.querySelector('.ctx-label').textContent.replace('✓ ', '').startsWith(${JSON.stringify(label)})); if (!it) return false; it.click(); return true; })()`);
      const undo = async () => { await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(700); };
      const s0 = await secs(), c0 = await clips();
      // Dan's case: delete Verse + everything in it, close the gap
      assert.ok(await menu('Verse', 'Delete Verse + its takes (close the gap)')); await sleep(500);
      assert.deepEqual(await secs(), ['Intro:0-4', 'Chorus:4-8']);
      assert.deepEqual((await clips()).map((c) => c[1]), [0, 4], `the take in the Verse is gone, the Chorus take moved up: ${JSON.stringify(await clips())}`);
      assert.equal((await jeff.get('/collab')).chords.find((c) => c.chord === 'Em').time, 4, 'chords move up too');
      await undo(); assert.deepEqual(await secs(), s0); assert.deepEqual(await clips(), c0, 'undo puts it all back');
      // duplicate the Intro
      assert.ok(await menu('Intro', 'Duplicate Intro')); await sleep(500);
      assert.deepEqual((await secs()).map((x) => x.split(':')[1]), ['0-4', '4-8', '8-12', '12-16']);
      assert.ok((await clips()).some((c) => c[1] === 4), 'a copy of the Intro take at bar 3 (whole, with the bar it rings into the Verse)');
      await undo();
      // move the Chorus earlier (swap with the Verse)
      assert.ok(await menu('Chorus', 'Move earlier')); await sleep(500);
      assert.deepEqual(await secs(), ['Intro:0-4', 'Chorus:4-8', 'Verse:8-12']);
      assert.ok((await clips()).some((c) => c[0] === 'two' && c[1] === 4), 'the Chorus take came with it');
      assert.equal((await jeff.get('/collab')).chords.find((c) => c.chord === 'Em').time, 4);
      await undo();
      // slice at the part's edges: the long take is cut at 4 s
      assert.ok(await menu('Verse', 'Slice every track')); await sleep(500);
      assert.ok((await clips()).some((c) => c[1] === 4), `cut at the Verse start: ${JSON.stringify(await clips())}`);
      await undo();
      // just the marker
      assert.ok(await menu('Verse', 'Delete just the part marker')); await sleep(500);
      assert.deepEqual(await clips(), c0, 'takes stay'); assert.deepEqual(await secs(), ['Intro:0-4', 'Chorus:8-12']);
      await undo();
      // "takes move with Chorus": drag the Chorus block 2 bars right → its take goes along
      assert.ok(await menu('Chorus', 'Takes move with Chorus')); await sleep(400);
      const pps = await jeff.evalJs(`window.cobanderDebug.state.pxPerSec`);
      await jeff.evalJs(`(() => { document.querySelector('#arrange').scrollLeft = 0; const b = [...document.querySelectorAll('#section-lane .section-block')].find((x) => x.textContent.startsWith('Chorus')); const r = b.getBoundingClientRect(); const x = r.left + 20, y = r.top + r.height / 2;
        b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 4, clientY: y })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: x + ${pps} * 4, clientY: y })); window.dispatchEvent(new MouseEvent('mouseup', { clientX: x + ${pps} * 4, clientY: y })); return true; })()`); await sleep(600);
      assert.deepEqual((await secs()).slice(-1), ['Chorus:12-16']); assert.ok((await clips()).some((c) => c[0] === 'two' && c[1] === 12), `take moved with the part: ${JSON.stringify(await clips())}`);
      assert.equal((await jeff.post('/song/save')).result, 'ok');
    });
    await step('0.10: any time signature (13/7, 2+2+3/8), 6/8 clicks 1 and 4, a part with its own tempo + meter', async () => {
      await jeff.post('/song/create', { name: 'Meter Song', bpm: 120 });
      await jeff.post('/sections', { add: [{ name: 'Intro', startBar: 1, endBar: 2 }, { name: 'Bridge', startBar: 3, endBar: 4 }, { name: 'Outro', startBar: 5, endBar: 6 }] });
      await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'G' } });
      const g = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'G');
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 8, name: 'outro' });
      await jeff.evalJs(`(async () => { await window.cobanderDebug.unlockAll({ quiet: true }); return true; })()`);
      const ts = () => jeff.evalJs(`JSON.stringify(window.cobanderDebug.engine.timeSig)`);
      await jeff.post('/song/patch', { timeSig: '2+2+3/8' }); assert.equal(await ts(), '[7,8,[2,2,3]]');
      assert.equal(await jeff.evalJs(`JSON.stringify(window.BPMeter.accents(window.cobanderDebug.engine.timeSig))`), '[2,0,1,0,1,0,0]');
      await jeff.post('/song/patch', { timeSig: [13, 7] }); assert.equal(await ts(), '[13,7]');
      assert.equal(await jeff.evalJs(`document.querySelector('#timesig').value`), '13/7', 'the select shows a custom meter');
      let bad = null; try { await jeff.post('/song/patch', { timeSig: [12, 99] }); } catch (e) { bad = e; } assert.ok(bad, '12/99 is refused');
      // 6/8: six eighths, accents on 1 (strong) and 4 (medium)
      await jeff.post('/song/patch', { timeSig: [6, 8] });
      assert.equal(await jeff.evalJs(`(() => { const e = window.cobanderDebug.engine; const was = e.click.countIn; e.click.countIn = true; const p = e.countInPlan(0); e.click.countIn = was; return JSON.stringify(p.clicks.map((c) => c.accent)); })()`), '[2,0,0,1,0,0]');
      await jeff.post('/song/patch', { timeSig: [4, 4] });
      // Bridge in 90 bpm 6/8: still 2 bars, 4 s a bar → 8 s long; the Outro and its take move 4 s later
      const secs = async () => (await jeff.get('/collab')).sections.filter((x) => !x.deleted).slice().sort((a, b) => a.start - b.start).map((x) => `${x.name}:${Math.round(x.start * 100) / 100}-${Math.round(x.end * 100) / 100}`);
      const menu = (name, label) => jeff.evalJs(`(() => { const b = [...document.querySelectorAll('#section-lane .section-block')].find((x) => x.textContent.startsWith(${JSON.stringify(name)})); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.getBoundingClientRect().left + 5, clientY: b.getBoundingClientRect().top + 5 })); const it = [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => x.querySelector('.ctx-label').textContent.replace('✓ ', '').startsWith(${JSON.stringify(label)})); if (!it) return false; it.click(); return true; })()`);
      const answer = async (v) => { await sleep(300); await jeff.evalJs(`(() => { document.querySelector('#prompt-input').value = ${JSON.stringify(v)}; document.querySelector('#prompt').close('ok'); return true; })()`); await sleep(600); };
      assert.ok(await menu('Bridge', 'Tempo & time signature')); await answer('90 6/8');
      assert.deepEqual(await secs(), ['Intro:0-4', 'Bridge:4-12', 'Outro:12-16']);
      const clip = (await jeff.get('/state')).song.tracks.find((t) => t.id === g.id).clips[0]; assert.equal(Math.round(clip.start * 100) / 100, 12, 'the Outro take moved with it');
      assert.equal(await jeff.evalJs(`(() => { const m = window.BPMeter, map = window.cobanderDebug.engine.meterMap(); return [m.posAt(map, 12.01).bar, m.posAt(map, 8.01).bar, m.posAt(map, 9.4).beat].join(','); })()`), '5,4,3', 'bars count through the part: Outro starts on bar 5, beat 3 of a 6/8 bar at 90 = 1.33 s in');
      assert.equal(await jeff.evalJs(`(() => { const e = window.cobanderDebug.engine; const b = window.BPMeter.beatsIn(e.meterMap(), 4, 8); return JSON.stringify(b.slice(0, 6).map((x) => x.accent)); })()`), '[2,0,0,1,0,0]', 'the Bridge clicks in 6/8');
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      assert.ok((await jeff.get('/collab')).sections.some((x) => x.name === 'Bridge' && x.bpm === 90 && JSON.stringify(x.timeSig) === '[6,8]'), 'the part tempo/meter is saved');
      assert.ok(await menu('Bridge', 'Back to the song tempo')); await sleep(600);
      assert.deepEqual(await secs(), ['Intro:0-4', 'Bridge:4-8', 'Outro:8-12'], 'back to the song meter, the gap closes');
    });
    await step('0.11: repeated parts link by themselves; record / edit / note in ANY copy and they all change; drag a part in from the song bin; delete + restore a song', async () => {
      await jeff.post('/song/create', { name: 'Link Song', bpm: 120 });
      await jeff.post('/sections', { add: [{ name: 'Verse 1', startBar: 1, endBar: 2 }, { name: 'Chorus', startBar: 3, endBar: 4 }, { name: 'Verse 2', startBar: 5, endBar: 6 }] });
      await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'G' } });
      const g = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'G');
      await jeff.evalJs(`(async () => { await window.cobanderDebug.unlockAll({ quiet: true }); return true; })()`);
      assert.equal(await jeff.evalJs(`JSON.stringify(window.cobanderDebug.state.song.linkGroups || {})`), '{"verse":true}', 'two Verses: linked without asking');
      const clips = async () => (await jeff.get('/state')).song.tracks.find((t) => t.id === g.id).clips.map((c) => ({ id: c.id, start: Math.round(c.start * 100) / 100, link: !!c.link, gain: c.gainDb || 0, mute: !!c.mute })).sort((a, b) => a.start - b.start);
      // record (import) a take in Verse 2: it goes to the room (Verse 1) and Verse 2 plays it
      await jeff.post('/clip/import', { path: path.join(WORK, 'memo.wav'), trackId: g.id, start: 8, name: 'v2 take' }); await sleep(400);
      let cs = await clips();
      assert.ok(cs.some((c) => !c.link && c.start === 0), `the take moved to Verse 1: ${JSON.stringify(cs)}`);
      assert.ok(cs.some((c) => c.link && c.start === 8), `Verse 2 plays it: ${JSON.stringify(cs)}`);
      // edit the copy in Verse 2: gain and a move → the room's take changes, so the copy keeps it
      const mirror = cs.find((c) => c.link && c.start === 8);
      await jeff.post('/song/patch', { clips: [{ id: mirror.id, gainDb: -6 }] }); await sleep(300);
      cs = await clips(); assert.equal(cs.find((c) => !c.link && c.start < 1).gain, -6, 'gain went to the room'); assert.equal(cs.find((c) => c.link).gain, -6);
      await jeff.post('/song/patch', { clips: [{ id: mirror.id, start: 8.5 }] }); await sleep(300);
      cs = await clips(); assert.ok(cs.some((c) => !c.link && c.start === 0.5) && cs.some((c) => c.link && c.start === 8.5), `moved in both: ${JSON.stringify(cs)}`);
      // a note added in Verse 2 lives in Verse 1 and shows in both
      await jeff.evalJs(`(async () => { await window.cobanderDebug.addNote(${JSON.stringify(g.id)}, 9, 'redo this'); return true; })()`); await sleep(300);
      const notes = (await jeff.get('/collab')).notes || (await jeff.get('/collab')).markers;
      assert.equal(notes.find((n) => n.text === 'redo this').time, 1, 'stored at the room time');
      assert.equal(await jeff.evalJs(`document.querySelectorAll('.note-pin[data-id]').length >= 2 && !!document.querySelector('.note-pin[data-ghost]')`), true, 'pinned in both verses');
      // the song's parts bin lists Verse and Chorus; drop a Verse at the end → Verse 3, linked
      assert.equal(await jeff.evalJs(`window.cobanderDebug.songPartList().map((p) => p.ty).join(',')`), 'verse,chorus');
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#song-parts li.songpart').length`) >= 2);
      const v1 = (await jeff.get('/collab')).sections.find((x) => x.name === 'Verse 1');
      await jeff.evalJs(`window.cobanderDebug.insertSongPart(${JSON.stringify(v1.id)}, 12)`); await sleep(400);
      const secs = (await jeff.get('/collab')).sections.filter((x) => !x.deleted).sort((a, b) => a.start - b.start).map((x) => `${x.name}:${x.start}-${x.end}`);
      assert.deepEqual(secs, ['Verse 1:0-4', 'Chorus:4-8', 'Verse 2:8-12', 'Verse 3:12-16']);
      cs = await clips(); assert.ok(cs.some((c) => c.link && c.start === 12.5), `Verse 3 plays the room: ${JSON.stringify(cs)}`);
      // a Post-chorus is its own part: dropping one gives "Post-chorus 2", linked to the Post-chorus, not a Chorus
      await jeff.post('/sections', { add: [{ name: 'Post-chorus', startBar: 9, endBar: 10 }] });
      const pc = (await jeff.get('/collab')).sections.find((x) => x.name === 'Post-chorus');
      await jeff.evalJs(`window.cobanderDebug.insertSongPart(${JSON.stringify(pc.id)}, 1e6)`); await sleep(400);
      assert.ok((await jeff.get('/collab')).sections.some((x) => x.name === 'Post-chorus 2' && !x.deleted), JSON.stringify((await jeff.get('/collab')).sections.map((x) => x.name)));
      assert.equal(await jeff.evalJs(`JSON.stringify(Object.keys(window.cobanderDebug.state.song.linkGroups || {}).sort())`), '["post-chorus","verse"]');
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(500); await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(500);
      // delete the copy's take = delete it everywhere
      await jeff.post('/song/patch', { clips: [{ id: cs.find((c) => c.link && c.start === 12.5).id, delete: true }] }); await sleep(300);
      assert.equal((await clips()).length, 0, 'gone from every verse');
      // deleting the room hands its takes to Verse 2
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(600);
      assert.equal((await clips()).filter((c) => !c.link).length, 1);
      const menu = (name, label) => jeff.evalJs(`(() => { const b = [...document.querySelectorAll('#section-lane .section-block')].find((x) => x.textContent.startsWith(${JSON.stringify(name)})); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.getBoundingClientRect().left + 5, clientY: b.getBoundingClientRect().top + 5 })); const it = [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => x.querySelector('.ctx-label').textContent.replace('✓ ', '').startsWith(${JSON.stringify(label)})); if (!it) return false; it.click(); return true; })()`);
      assert.ok(await menu('Verse 1', 'Delete Verse 1 + its takes (close the gap)')); await sleep(600);
      cs = await clips(); assert.ok(cs.some((c) => !c.link && c.start === 4.5) && cs.some((c) => c.link && c.start === 8.5), `Verse 2 is the room now and kept the take: ${JSON.stringify(cs)}`);
      await jeff.evalJs(`document.querySelector('#btn-undo').click()`); await sleep(600);
      assert.equal((await jeff.post('/song/save')).result, 'ok');
      // delete the song → _deleted on the Drive; restore it
      assert.equal(await jeff.evalJs(`(async () => await window.cobanderDebug.closeSong({ interactive: false }))()`), true);
      const r = await jeff.evalJs(`(async () => JSON.stringify(await window.cobander.song.trash('Link Song')))()`);
      assert.ok(/Link Song - deleted/.test(r), r);
      assert.ok(fs.existsSync(path.join(shared, '_deleted')) && fs.readdirSync(path.join(shared, '_deleted')).some((n) => n.startsWith('Link Song - deleted')));
      assert.ok(!fs.existsSync(path.join(shared, 'Link Song')));
      const list = JSON.parse(await jeff.evalJs(`(async () => JSON.stringify(await window.cobander.song.trashed()))()`));
      const back = JSON.parse(await jeff.evalJs(`(async () => JSON.stringify(await window.cobander.song.restore(${JSON.stringify(list[0].id)})))()`));
      assert.equal(back.folder, 'Link Song'); assert.ok(fs.existsSync(path.join(shared, 'Link Song', 'song.json')));
    });
    await step('0.11.1: band feed minimizes from its header and remembers it', async () => {
      const vis = () => jeff.evalJs(`getComputedStyle(document.querySelector('#band-feed')).display !== 'none'`);
      assert.equal(await vis(), true);
      await jeff.evalJs(`document.querySelector('#band-feed-head').click()`); await sleep(200);
      assert.equal(await vis(), false); assert.equal(await jeff.evalJs(`localStorage.getItem('bp.feedMin')`), '1');
      await jeff.evalJs(`document.querySelector('#band-feed-head').click()`); await sleep(200);
      assert.equal(await vis(), true);
    });
    await step('0.12: the game layer — XP from real work (takes, notes, chords), parts-written % from takes, goals/tasks, levels, achievements, Kat sees it', async () => {
      // everything Jeff did in Link Song counts: the take, the note, and now chords + lyrics
      await jeff.post('/song/open', { folder: 'Link Song' }); await sleep(800);
      const q0 = (await jeff.get('/quest')).members.find((m) => m.name === 'Jeff');
      await jeff.post('/chords', { fromBar: 1, bars: 'G D | Em C' }); await jeff.post('/lyrics', { text: 'first line\nsecond line' });
      assert.equal((await jeff.post('/song/save')).result, 'ok'); await sleep(1500);
      const q = await jeff.get('/quest');
      const jeffQ = q.members.find((m) => m.name === 'Jeff'); assert.ok(jeffQ, JSON.stringify(q.members.map((m) => m.name)));
      assert.ok(jeffQ.takes >= 1 && jeffQ.notes >= 1 && jeffQ.chords >= q0.chords + 4 && jeffQ.lyrics >= q0.lyrics + 2, `counted from the songs: ${JSON.stringify({ takes: jeffQ.takes, notes: jeffQ.notes, chords: jeffQ.chords, lyrics: jeffQ.lyrics })}`);
      assert.equal(jeffQ.xp - q0.xp, 4 * 2 + 2 * 3 + 1, 'chords 2 each, lyric lines 3 each, the save 1');
      assert.ok(jeffQ.achievements.some((a) => a.id === 'first-take'));
      const ls = (await jeff.get('/quest')).songs.find((s) => s.folder === 'Link Song');
      const jp = ls.parts.find((p) => p.member === 'Jeff'); assert.equal(jp.pct, 75, `his take is in Verse 1 and plays in Verse 2 + 3 (linked): 3 of 4 parts: ${JSON.stringify(ls.parts)}`);
      assert.ok(ls.milestones.find((x) => x.id === 'laidout').done);
      // the Band tab in the song: level chip, goals, parts %, a task; +XP pop on a note
      assert.equal(await jeff.evalJs(`!document.querySelector('#xp-chip').hidden && /Lv \\d/.test(document.querySelector('#xp-chip').textContent)`), true);
      await jeff.post('/workspace', { ws: 'band' }); await sleep(600);
      assert.match(await jeff.evalJs(`document.querySelector('#qb-song').textContent`), /Jeff.*75%/s);
      const xp0 = ls.xp;
      await jeff.post('/quest', { goal: { song: 'Link Song', id: 'title', done: true }, task: { song: 'Link Song', text: 'learn the bridge', who: 'Kat' } });
      let q2 = (await jeff.get('/quest')).songs.find((s) => s.folder === 'Link Song'); assert.equal(q2.xp, xp0 + 15); assert.equal(q2.tasks[0].who, 'Kat');
      await jeff.post('/quest', { task: { song: 'Link Song', id: q2.tasks[0].id, done: true } });
      q2 = (await jeff.get('/quest')).songs.find((s) => s.folder === 'Link Song'); assert.equal(q2.xp, xp0 + 25);
      await jeff.evalJs(`(async () => { await window.cobanderDebug.addNote(null, 1, 'more cowbell'); return true; })()`); await sleep(200);
      assert.equal(await jeff.evalJs(`!!document.querySelector('.xp-pop')`), true, '+XP pop on a note');
      await jeff.post('/quest', { boss: { title: 'Halloween practice', date: '2026-10-31', songs: ['Link Song'] }, next: 'house show in January' });
      assert.match(await jeff.evalJs(`document.querySelector('#qb-boss').textContent`), /Halloween practice/);
      assert.ok(fs.readdirSync(path.join(shared, '_quest')).includes('Jeff.json'), 'Jeff writes only his own file');
      // Kat's Cobander sees the same board (through the shared folder)
      const kq = await until(async () => { const x = await kat.get('/quest'); return x.boss && x.boss.title === 'Halloween practice' ? x : null; }, 30000, 'Kat sees the boss battle');
      assert.equal(kq.songs.find((s) => s.folder === 'Link Song').goals.find((g) => g.id === 'title').done, true);
      assert.match(await kat.evalJs(`document.querySelector('#band-feed').textContent`), /Final Title/);
      assert.ok(kq.members.find((m) => m.name === 'Kat'), 'Kat is on the board (she did work in this run)');
      await jeff.shot('band-tab');
      assert.ok(await jeff.evalJs(`!!document.querySelector('#song-list .song-xp')`), 'song list shows quest XP');
      await jeff.post('/workspace', { ws: 'write' }); await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=notes]').click()`);
    });
    await step('0.12: monitoring runs through the armed track\'s FX chain; output device + latency measurement are wired', async () => {
      await jeff.post('/song/create', { name: 'Mon Song', bpm: 120 }); await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'G' } });
      const g = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'G');
      await jeff.evalJs(`(async () => { const e = window.cobanderDebug.engine; await e.init(); window.cobanderDebug.state.armedTrack = ${JSON.stringify(g.id)}; window.cobanderDebug.renderAll(); return true; })()`); await sleep(200);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.monitorVia`), g.id, 'the live input is routed into the armed track\'s chain');
      await jeff.evalJs(`(() => { const e = window.cobanderDebug.engine; e.setMonitorFx(false); return true; })()`);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.monitorVia`), null, 'dry when FX monitoring is off');
      await jeff.evalJs(`window.cobanderDebug.engine.setMonitorFx(true)`);
      // the fake mic can't hear the output: Measure says so instead of setting a wrong number
      const r = await jeff.evalJs(`(async () => { const e = window.cobanderDebug.engine; if (!e.stream) await e.openInput(null); try { const r = await e.measureLatency({ clicks: 4, gap: 0.1 }); return 'measured ' + JSON.stringify(r); } catch (err) { return 'error ' + err.message; } })()`);
      assert.ok(/^error Didn|^measured/.test(r), r);
      const au = await jeff.get('/audio'); assert.equal(au.sampleRate, 48000); assert.ok(Array.isArray(au.outputs));
      const au2 = await jeff.post('/audio', { recordOffsetMs: 281 }); assert.equal(au2.recordOffsetMs, 281); assert.equal(au2.offsetManual, true);
      const au3 = await jeff.post('/audio', { recordOffsetMs: null }); assert.equal(au3.offsetManual, false);
      let me = null, mr = null; try { mr = await jeff.post('/latency/measure', {}); } catch (e) { me = e; } assert.ok(me ? /hear the clicks|nothing|Input/.test(me.message) : Number.isFinite(mr.ms), String(me && me.message));
      assert.equal(await jeff.evalJs(`(async () => typeof window.cobanderDebug.engine.ctx.setSinkId === 'function' && (await window.cobanderDebug.engine.listOutputs()).length >= 0)()`), true);
    });
    await step('0.13: speech-to-text writes timed lyrics from a vocal take (Whisper on this computer)', async () => {
      await jeff.post('/song/create', { name: 'Words Song', bpm: 120 });
      await jeff.post('/song/patch', { addTrack: { kind: 'vocals', name: 'Vox' } });
      const v = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Vox');
      await jeff.post('/clip/import', { path: path.join(ROOT, 'test', 'fixtures-jfk.wav'), trackId: v.id, start: 4, name: 'speech' });
      const r = await jeff.req('POST', '/lyrics/transcribe', { model: 'base.en' }, 600000);
      assert.ok(r.lines >= 1, JSON.stringify(r));
      const all = r.lyrics.map((l) => l.text).join(' ');
      assert.match(all, /country/i, all);
      assert.ok(r.lyrics[0].time >= 4 && r.lyrics[0].time < 5, `first line pinned where it's spoken (clip at 4 s): ${r.lyrics[0].time}`);
      assert.ok(r.lyrics.every((l) => l.words > 0), 'word timings for karaoke');
      assert.equal(await jeff.evalJs(`window.BPAsr.state.lastRun`), 'worker', 'ran off the UI thread');
      const again = await jeff.req('POST', '/lyrics/transcribe', { trackId: v.id, model: 'base.en' }, 600000);
      assert.equal(again.lyrics.length, r.lyrics.length, 'transcribing the same take again replaces its lines, no doubles');
      // karaoke: the line being sung, its words lighting up
      await jeff.evalJs(`document.querySelector('#btn-karaoke').click()`); await sleep(300);
      assert.equal(await jeff.evalJs(`!document.querySelector('#karaoke').hidden`), true);
      await jeff.post('/transport', { action: 'seek', time: 4.9 }); await sleep(300);
      const cur = await jeff.evalJs(`document.querySelector('#k-cur').textContent`); assert.match(cur, /And so my fellow/i, cur);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#k-cur .k-w.sung, #k-cur .k-w.now').length`) >= 1, 'words light up');
      assert.match(await jeff.evalJs(`document.querySelector('#k-next').textContent`), /\w/, 'next line shown');
      await jeff.evalJs(`document.querySelector('#k-vox').value = 'off'; document.querySelector('#k-vox').dispatchEvent(new Event('change')); true`);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.tempMute.has(${JSON.stringify(v.id)})`), true, 'vocals muted for practice');
      await jeff.shot('karaoke');
      await jeff.evalJs(`document.querySelector('#k-close').click()`);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.tempMute.size`), 0, 'closing brings the vocals back');
    });
    await step('0.13: FLAC takes, Lighten Drive, comp, punch in/out, crash-safe recording, chart, share a part, what changed, shortcuts, part keys', async () => {
      await jeff.post('/song/create', { name: 'QoL Song', bpm: 120 });
      await jeff.post('/sections', { add: [{ name: 'Verse 1', startBar: 1, endBar: 4 }, { name: 'Chorus', startBar: 5, endBar: 8 }] });
      await jeff.post('/chords', { fromBar: 1, bars: 'G | D | Em | C | Am | F | C | G' });
      await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'Gtr' } });
      const g = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Gtr');
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 0, name: 'one' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'riff.wav'), trackId: g.id, start: 0, name: 'two' });
      const adir = path.join(shared, 'QoL Song', 'audio');
      let files = await fsp.readdir(adir); assert.ok(files.length >= 2 && files.every((f) => f.endsWith('.flac')), files.join(', '));
      // FLAC plays: reload the song and the takes decode
      await jeff.post('/song/save'); await jeff.post('/song/reload'); await sleep(800);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.state.missingClips.size`), 0, 'FLAC takes load');
      // comp: "two" only for bars 2-3 (2 s – 6 s); "one" everywhere else
      let st = await jeff.get('/state'); let gc = st.song.tracks.find((t) => t.id === g.id).clips;
      const one = gc.find((c) => c.name === 'one'), two = gc.find((c) => c.name === 'two');
      await jeff.post('/comp', { clipId: one.id, from: 0, to: 6 });
      await jeff.post('/comp', { clipId: two.id, from: 2, to: 4 });
      st = await jeff.get('/state'); gc = st.song.tracks.find((t) => t.id === g.id).clips;
      const heard = (t) => gc.filter((c) => !c.mute && t >= c.start && t < c.start + (c.duration - c.trimStart - c.trimEnd)).map((c) => c.src || c.id);
      assert.deepEqual(heard(1), [one.id]); assert.deepEqual(heard(3), [two.id]); assert.deepEqual(heard(5), [one.id]);
      // punch in/out over bars 3-4 on a new track: the take only plays inside the range
      await jeff.post('/song/patch', { addTrack: { kind: 'vocals', name: 'Vox' } });
      const vx = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Vox');
      await jeff.post('/transport', { action: 'click', enabled: false });
      await jeff.post('/transport', { action: 'loop', enabled: false, start: 4, end: 6 });
      await jeff.evalJs(`document.querySelector('#punch-on').checked = true; true`);
      await jeff.post('/transport', { action: 'record', trackId: vx.id });
      await sleep(1600);
      const recDir = path.join(jeff.cfg, 'Cobander', 'recording');
      const during = await fsp.readdir(recDir).catch(() => []); assert.ok(during.some((f) => f.endsWith('.ch0.f32')), `crash copy streams while recording: ${during}`);
      const pc = await until(async () => { const s2 = await jeff.get('/state'); const v = s2.song.tracks.find((t) => t.id === vx.id); return !s2.transport.recording && !s2.dirty && v.clips.length ? v.clips[0] : null; }, 20000, 'punch stopped by itself');
      assert.ok(Math.abs(pc.start - 4) < 0.02, `punch-in at 4 s: ${pc.start}`); assert.ok(pc.trimStart > 1, 'pre-roll kept as a handle');
      assert.ok(Math.abs(pc.duration - pc.trimStart - pc.trimEnd - 2) < 0.05, `plays 2 s: ${JSON.stringify(pc)}`);
      await jeff.evalJs(`document.querySelector('#punch-on').checked = false; true`);
      await until(async () => !(await fsp.readdir(recDir).catch(() => [])).length, 5000, 'crash copy cleared once saved');
      // crash recovery: a leftover recording is offered and comes back as a take
      const sr = 48000, n = sr * 2; const pcm = new Float32Array(n); for (let i = 0; i < n; i++) pcm[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr);
      const rid = 'abcabcabcabc'; await fsp.mkdir(recDir, { recursive: true });
      await fsp.writeFile(path.join(recDir, `${rid}.json`), JSON.stringify({ id: rid, folder: 'QoL Song', song: 'QoL Song', trackId: vx.id, trackName: 'Vox', startPos: 12, startFrame: 0, startCtxTime: 0, sampleRate: sr, offsetMs: 0, who: 'Jeff', at: new Date().toISOString() }));
      await fsp.writeFile(path.join(recDir, `${rid}.ch0.f32`), Buffer.from(pcm.buffer));
      const listed = await jeff.evalJs(`window.cobander.rec.list().then((l) => l.map((x) => [x.id, Math.round(x.seconds)]))`); assert.deepEqual(listed, [[rid, 2]]);
      await jeff.post('/song/save'); await jeff.post('/song/close');
      const before = !!JSON.parse(await fsp.readFile(path.join(shared, 'E2E Song', 'song.json'), 'utf8')).tracks.find((t) => t.name === 'Gtr').mute; await jeff.post('/song/open', { folder: 'QoL Song' });
      await until(() => jeff.evalJs(`(() => { const b = [...document.querySelectorAll('#toasts button')].find((x) => /Recover the take/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`), 8000, 'recover offer');
      const rc = await until(async () => { const s2 = await jeff.get('/state'); return s2.song.tracks.find((t) => t.id === vx.id).clips.find((c) => /recovered/.test(c.name) && !s2.dirty); }, 15000, 'recovered take');
      assert.ok(Math.abs(rc.start - 12) < 0.01 && Math.abs(rc.duration - 2) < 0.01, JSON.stringify(rc));
      // Lighten Drive: an old WAV nobody uses goes, WAV takes become FLAC
      const old = path.join(adir, 'stray - 0123456789ab.wav'); await fsp.writeFile(old, wav(1, 330)); const ago = (Date.now() - 40 * 86400000) / 1000; await fsp.utimes(old, ago, ago);
      const dry = await jeff.post('/audio/compact', { folder: 'QoL Song', dryRun: true }); assert.equal(dry.removed, 1, JSON.stringify(dry));
      assert.ok(fs.existsSync(old), 'dry run changes nothing');
      const done = await jeff.post('/audio/compact', { folder: 'QoL Song' }); assert.equal(done.removed, 1); assert.ok(!fs.existsSync(old));
      // chart + share a part
      await jeff.post('/lyrics', { text: 'walking down the line' });
      await jeff.evalJs(`(() => { const l = window.cobanderDebug.state.song.lyrics.find((x) => x.text === 'walking down the line'); l.time = 0.5; return true; })()`);
      const ch = await jeff.get('/chart'); assert.match(ch.text, /\[VERSE 1\]/); assert.match(ch.text, /\[G\] walking down the line/); assert.match(ch.text, /\[CHORUS\][^\n]*\n\| Am \| F \| C \| G \|/);
      const sh = await jeff.post('/part/share', { section: 'Verse 1' }); const bdir = path.join(shared, 'QoL Song', 'bounces');
      const bfolder = (await fsp.readdir(bdir)).find((f) => f.startsWith('QoL Song - Verse 1')); assert.ok(bfolder, 'share folder'); const inside = await fsp.readdir(path.join(bdir, bfolder));
      assert.ok(inside.includes('chart.txt') && inside.some((f) => f.endsWith('.wav')), inside.join(', ')); void sh;
      // part keys: 2 jumps to the Chorus, ? opens the shortcut sheet
      await jeff.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', bubbles: true })); true`); await sleep(100);
      assert.equal(Math.round((await jeff.get('/state')).transport.playhead), 8);
      await jeff.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true })); true`); await sleep(100);
      assert.equal(await jeff.evalJs(`!!document.querySelector('#keys[open]')`), true); await jeff.shot('shortcuts');
      await jeff.evalJs(`document.querySelector('#keys').close(); true`);
      // what changed: Kat opens it after Jeff and sees Jeff's work since a moment ago
      await jeff.post('/song/save'); await jeff.post('/song/close');
      const t0 = new Date(Date.now() - 10 * 60000).toISOString();
      await kat.post('/song/open', { folder: 'QoL Song' });
      const chg = await kat.get(`/changes?since=${encodeURIComponent(t0)}`);
      assert.ok(chg.any && chg.people.some((p) => p.name === 'Jeff'), JSON.stringify(chg).slice(0, 300));
      await kat.post('/song/close');
    });
    await step('0.13: tuner reads the input; my track setups show first in Add track', async () => {
      await jeff.post('/song/open', { folder: 'QoL Song' });
      await jeff.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true })); true`);
      await until(() => jeff.evalJs(`!!document.querySelector('#tuner[open]')`), 5000, 'tuner open');
      await sleep(2500); await jeff.shot('tuner');
      const name = await jeff.evalJs(`document.querySelector('#tu-name').textContent`); assert.ok(typeof name === 'string');
      await jeff.evalJs(`document.querySelector('#tuner').close(); true`);
      // save the Gtr track as a setup, then Add track lists it and builds a copy from it
      await jeff.evalJs(`window.cobander.settings.set({ trackSetups: [{ name: 'My Strat', track: { name: 'Strat', type: 'guitar', instrument: 'audio', preset: null, gainDb: -9 } }] }).then((x) => { window.cobanderDebug.state.settings = x; return true; })`);
      await jeff.post('/song/reload'); await sleep(300);
      await jeff.evalJs(`document.querySelector('#btn-add-track').click(); true`); await sleep(300);
      assert.equal(await jeff.evalJs(`document.querySelector('#addtrack-mine button b') && document.querySelector('#addtrack-mine button b').textContent`), 'My Strat');
      await jeff.shot('addtrack-mine');
      await jeff.evalJs(`(() => { const d = document.querySelector('#addtrack'); d.close('setup:0'); return true; })()`); await sleep(300);
      const st = await jeff.get('/state'); const t = st.song.tracks.find((x) => x.name === 'Strat'); assert.ok(t && t.gainDb === -9, JSON.stringify(st.song.tracks.map((x) => x.name)));
      // practice mode: K opens it from the top bar; loop a part from the list, take tracks out, chords-only bars, capo display, jump parts
      await jeff.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true })); true`); await sleep(400);
      assert.equal(await jeff.evalJs(`!document.querySelector('#karaoke').hidden`), true, 'K opens practice');
      await jeff.evalJs(`(() => { const v = document.querySelector('#k-vox'); v.value = 'guide'; v.dispatchEvent(new Event('change')); return true; })()`);
      assert.equal(await jeff.evalJs(`document.querySelector('#k-loopsel').options.length`), 3, 'off + 2 parts');
      assert.equal(await jeff.evalJs(`document.querySelector('#k-tp').value`), '0', 'chords as written by default');
      await jeff.evalJs(`(() => { const s = document.querySelector('#k-loopsel'); s.value = s.options[2].value; s.dispatchEvent(new Event('change')); return true; })()`); await sleep(200);
      let tr = (await jeff.get('/state')).transport; assert.ok(tr.loop.enabled && Math.abs(tr.loop.start - 8) < 0.01 && Math.abs(tr.loop.end - 16) < 0.01, JSON.stringify(tr.loop));
      await jeff.evalJs(`(() => { const s = document.querySelector('#k-loopsel'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);
      await jeff.evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', code: 'Home', bubbles: true })); true`);
      await jeff.evalJs(`document.querySelector('#k-nextpart').click(); true`); await sleep(100);
      assert.equal(Math.round((await jeff.get('/state')).transport.playhead), 8, 'next part');
      await jeff.evalJs(`document.querySelector('#k-back').click(); true`); await sleep(100);
      assert.equal(Math.round((await jeff.get('/state')).transport.playhead), 6, 'back a bar');
      await jeff.evalJs(`document.querySelector('#k-mix').click(); true`); await sleep(150);
      assert.ok(await jeff.evalJs(`!!document.querySelector('.ctxmenu')`), 'mix menu shows over practice');
      await jeff.evalJs(`(() => { const it = [...document.querySelectorAll('.ctxmenu .ctx-item')].find((x) => /^(✓ )?Vox$/.test(x.textContent.trim())); it.click(); return true; })()`); await sleep(150);
      const voxId = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Vox').id;
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.tempMute.has(${JSON.stringify(voxId)})`), true, 'Vox taken out');
      assert.match(await jeff.evalJs(`document.querySelector('#k-mix').textContent`), /without: Vox/);
      await jeff.evalJs(`(() => { const v = document.querySelector('#k-view'); v.value = 'chords'; v.dispatchEvent(new Event('change')); const t = document.querySelector('#k-tp'); t.value = '2'; t.dispatchEvent(new Event('change')); return true; })()`);
      await jeff.post('/transport', { action: 'seek', time: 0.5 }); await sleep(300);
      const bars = await jeff.evalJs(`[...document.querySelectorAll('#k-bars .k-bar')].map((b) => b.textContent)`); assert.deepEqual(bars, ['A', 'E', 'F#m', 'D'], JSON.stringify(bars));
      assert.equal(await jeff.evalJs(`document.querySelector('#k-bars .k-bar.now').textContent`), 'A');
      await jeff.shot('practice-chords');
      await jeff.evalJs(`(() => { const v = document.querySelector('#k-view'); v.value = 'both'; v.dispatchEvent(new Event('change')); const t = document.querySelector('#k-tp'); t.value = '0'; t.dispatchEvent(new Event('change')); return true; })()`);
      await jeff.evalJs(`(() => { window.cobanderDebug.engine; document.querySelector('#k-close').click(); return true; })()`);
      assert.equal(await jeff.evalJs(`window.cobanderDebug.engine.tempMute.size`), 0, 'closing practice brings everyone back');
      await jeff.evalJs(`localStorage.removeItem('bp.kMutes'); localStorage.removeItem('bp.kView'); true`);
      await jeff.post('/song/save'); await jeff.post('/song/close');
    });
    await step('0.14: workspaces, Takes tab, chords from a guitar take, Auto mix / master + A/B, tighten, pitch check, phone page, Show mode + pedal, practice minutes', async () => {
      await fsp.writeFile(path.join(WORK, 'chords.wav'), chordWav(['G', 'D', 'Em', 'C']));
      await fsp.writeFile(path.join(WORK, 'drums.wav'), sloppyDrums(8));
      await fsp.writeFile(path.join(WORK, 'sung.wav'), sungWav());
      await jeff.post('/song/create', { name: 'Fourteen', bpm: 120 });
      await jeff.post('/sections', { add: [{ name: 'Verse 1', startBar: 1, endBar: 2 }, { name: 'Chorus', startBar: 3, endBar: 4 }] });
      for (const [kind, name] of [['guitar', 'Gtr'], ['drumsMic', 'Drums'], ['vocals', 'Vox']]) await jeff.post('/song/patch', { addTrack: { kind, name } });
      let st = await jeff.get('/state'); const tr = (n) => st.song.tracks.find((t) => t.name === n);
      await jeff.post('/clip/import', { path: path.join(WORK, 'chords.wav'), trackId: tr('Gtr').id, start: 0, name: 'strum' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'drums.wav'), trackId: tr('Drums').id, start: 0, name: 'sloppy' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'sung.wav'), trackId: tr('Vox').id, start: 0, name: 'la' });
      // workspaces
      for (const ws of ['record', 'mix', 'band', 'write']) { const r = await jeff.post('/workspace', { ws }); assert.equal(r.ws, ws); assert.equal(await jeff.evalJs(`document.body.classList.contains('ws-${ws}')`), true); }
      assert.equal(await jeff.evalJs(`!document.querySelector('#side-tabs [data-tab=takes]').hidden`), false, 'Takes tab is a Record thing');
      await jeff.post('/workspace', { ws: 'record' });
      assert.equal(await jeff.evalJs(`getComputedStyle(document.querySelector('.grp.only-record')).display !== 'none'`), true, 'record tools up top');
      await jeff.evalJs(`document.querySelector('#side-tabs [data-tab=takes]').click(); true`);
      await jeff.evalJs(`window.cobanderDebug.state.selectedTrack = ${JSON.stringify(tr('Drums').id)}; document.querySelector('#side-tabs [data-tab=takes]').click(); true`);
      assert.match(await jeff.evalJs(`document.querySelector('#take-list').textContent`), /sloppy/);
      await jeff.shot('record-takes');
      // chords from the guitar take
      const cd = await jeff.post('/chords/detect', {});
      assert.deepEqual(cd.chords.map((c) => c.chord), ['G', 'D', 'Em', 'C'], JSON.stringify(cd.chords));
      assert.ok(cd.chords.every((c) => c.det), 'drafts are marked');
      const again = await jeff.post('/chords/detect', {}); assert.equal(again.chords.length, 4, 're-running replaces drafts, no doubles');
      // Auto mix + master + A/B
      await jeff.post('/workspace', { ws: 'mix' });
      const am = await jeff.post('/mix/auto', {}); assert.ok(am && am.changes.length >= 2, JSON.stringify(am));
      const vox = am.tracks.find((t) => t.name === 'Vox'); assert.ok(vox.fx.hpf.on && vox.fx.comp.on, 'vocal cleanup + comp');
      const ms = await jeff.post('/master/auto', {}); assert.ok(ms.limiter && Number.isFinite(ms.gainDb));
      const pre = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Vox');
      const ab = await jeff.post('/mix/ab', {}); assert.equal(ab.showing, 'before');
      const bvox = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Vox'); assert.ok(bvox.gainDb !== vox.gainDb || bvox.fx.hpf.hz !== vox.fx.hpf.hz, `A = before: ${JSON.stringify([bvox.gainDb, vox.gainDb, pre.gainDb])}`);
      assert.equal((await jeff.post('/mix/ab', {})).showing, 'after');
      await jeff.shot('mix');
      // tighten the sloppy drums onto 1/8
      st = await jeff.get('/state'); const dclip = tr('Drums').clips[0];
      const tg = await jeff.post('/clip/tighten', { clipId: dclip.id, grid: '1/8', strength: 1 });
      assert.ok(tg.takes === 1 && tg.after < tg.before / 2, JSON.stringify(tg));
      st = await jeff.get('/state'); const tc = tr('Drums').clips[0]; assert.ok(tc.tt && tc.tt.src === (dclip.src || dclip.id) && tc.src !== tc.tt.src, JSON.stringify(tc));
      await jeff.post('/clip/tighten', { clipId: tc.id, undo: true }); st = await jeff.get('/state'); assert.ok(!tr('Drums').clips[0].tt, 'undo tighten');
      // pitch check: the third note is flat
      const pc = await jeff.post('/pitch/check', { trackId: tr('Vox').id });
      assert.deepEqual(pc.notes.map((n) => n.flag), ['ok', 'ok', 'flat', 'ok'], JSON.stringify(pc.notes));
      assert.ok(await jeff.evalJs(`document.querySelectorAll('.pitch-mark.flat').length`) >= 1, 'flagged on the take');
      // phone page: on, the page and its live state answer on the network port with the key
      await jeff.evalJs(`window.cobander.phone.start().then(() => true)`);
      const ph = await jeff.get('/phone'); assert.ok(ph.on);
      const key = ph.key;
      const get = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: ph.port, path: p }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ code: res.statusCode, body: d })); }).on('error', reject));
      assert.equal((await get('/state?k=nope')).code, 403, 'key required');
      const page = await get(`/?k=${key}`); assert.equal(page.code, 200); assert.match(page.body, /Cobander — practice/);
      const ps = JSON.parse((await get(`/state?k=${key}`)).body); assert.equal(ps.song, 'Fourteen'); assert.ok(ps.sections.length === 2 && ps.sections[0].bars[0].chords[0] === 'G', JSON.stringify(ps.sections[0]));
      // Show mode: setlist locked, click only, pedal (a key) steps songs
      await jeff.post('/workspace', { ws: 'write' });
      await jeff.post('/song/save'); await jeff.post('/song/create', { name: 'Encore' }); await jeff.post('/song/open', { folder: 'Fourteen' });
      const sh = await jeff.post('/practice', { open: true, show: true }); assert.ok(sh.show && sh.setlist.order.length >= 2, JSON.stringify(sh));
      const allMuted = await jeff.evalJs(`window.cobanderDebug.engine.tracks.every((t) => window.cobanderDebug.engine.tempMute.has(t.id))`); assert.equal(allMuted, true, 'click only');
      await jeff.evalJs(`window.cobander.settings.set({ showPedal: { next: { kind: 'key', code: 'KeyN' } } }).then((x) => { window.cobanderDebug.state.settings = x; return true; })`);
      const before = (await jeff.post('/practice', {})).setlist.i;
      await jeff.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true })); true`);
      await until(async () => { const p = await jeff.post('/practice', {}); return p.setlist.i === before + 1 && p.song === p.setlist.order[p.setlist.i]; }, 15000, 'pedal → next song');
      await jeff.shot('show');
      await jeff.post('/practice', { show: false });
      // play along: chord highway draws, bass tab reads the bass takes, timing report on the drums
      await jeff.post('/song/open', { folder: 'Fourteen' }); await jeff.post('/practice', { open: true });
      await jeff.evalJs(`(() => { const s = document.querySelector('#k-along'); s.value = 'chords'; s.dispatchEvent(new Event('change')); return true; })()`); await sleep(400);
      assert.equal(await jeff.evalJs(`!document.querySelector('#k-hw').hidden && document.querySelector('#k-highway').width > 100`), true, 'highway visible');
      const ev = await jeff.evalJs(`(() => { const c = document.querySelector('#k-highway').getContext('2d'); const d = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data; let n = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; })()`); assert.ok(ev > 20, `highway drew something (${ev})`);
      await jeff.evalJs(`(() => { const s = document.querySelector('#k-along'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);
      await jeff.post('/practice', { open: false });
      const trDr = (await jeff.get('/state')).song.tracks.find((t) => t.name === 'Drums');
      const tmr = await jeff.evalJs(`window.cobanderDebug.timingReport(${JSON.stringify(trDr.id)}).then((r) => r && r.overall.n)`); assert.ok(tmr >= 10, `timing report hits ${tmr}`);
      assert.equal(await jeff.evalJs(`!!document.querySelector('#take-list .timing-box')`), true, 'timing panel in Takes');
      await jeff.shot('timing'); await jeff.post('/practice', { open: true }); await jeff.evalJs(`(() => { const s = document.querySelector('#k-along'); s.value = 'chords'; s.dispatchEvent(new Event('change')); return true; })()`); await sleep(500); await jeff.shot('highway'); await jeff.evalJs(`(() => { const s = document.querySelector('#k-along'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`); await jeff.post('/practice', { open: false });
      // practice minutes land on the board
      await jeff.post('/practice', { open: true }); await jeff.post('/transport', { action: 'seek', time: 0 }); await jeff.evalJs(`document.querySelector('#k-countin').checked = false; document.querySelector('#k-play').click(); true`);
      await sleep(7000); const kd = await jeff.evalJs(`JSON.stringify({ p: window.cobanderDebug.kara().practiced, playing: window.cobanderDebug.engine.playing, open: window.cobanderDebug.kara().open })`); await jeff.post('/practice', { flush: true }); await jeff.post('/transport', { action: 'stop' });
      const pr = await until(async () => { const q = await jeff.get('/quest'); return q.practice && q.practice.members.find((m) => m.name === 'Jeff'); }, 10000, `practice logged ${kd}`);
      assert.ok(pr.total > 0.05 && pr.top[0].song, JSON.stringify(pr));
      await jeff.post('/practice', { open: false });
      await jeff.post('/workspace', { ws: 'band' }); await sleep(400);
      assert.equal(await jeff.evalJs(`!document.querySelector('#band-page').hidden`), true, await jeff.evalJs(`JSON.stringify([window.cobanderDebug.state.ws, document.body.className])`));
      await jeff.shot('band-page');
      await jeff.post('/workspace', { ws: 'write' });
      await jeff.evalJs(`window.cobander.phone.stop().then(() => true)`);
      const cur = (await jeff.get('/state')).folder; if (cur) { await jeff.post('/song/save'); await jeff.post('/song/close'); }
    });
    await step('0.15: band to-dos (loose ends), track height', async () => {
      await jeff.post('/workspace', { ws: 'band' }); await sleep(400);
      await jeff.post('/quest', { todo: { text: 'fix the PA @Dan' , who: 'Dan' } });
      let q = await jeff.get('/quest'); const td = q.todos.find((t) => /fix the PA/.test(t.text)); assert.ok(td && !td.done && td.who === 'Dan', JSON.stringify(q.todos));
      await sleep(300); assert.ok(await jeff.evalJs(`[...document.querySelectorAll('#qb-todos .qb-task span')].some((s) => /fix the PA/.test(s.textContent))`), 'to-do shows on the Band page');
      await jeff.post('/quest', { todo: { id: td.id, done: true } }); q = await jeff.get('/quest'); assert.ok(q.todos.find((t) => t.id === td.id).done, 'checked off');
      assert.ok(q.members.some((m) => m.name === 'Jeff' && m.xp > 0), 'XP to the doer');
      await jeff.shot('band-todos');
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#qb-members .char .gi').length >= 2 && !!document.querySelector('#qb-boss .gi-dragon')`), 'character sprites + boss dragon');
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#qb-members .char canvas.lpc').length >= 2 && [...document.querySelectorAll('#qb-members .char canvas.lpc')].every((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v) => v))`), 'LPC characters drawn');
      // the level-up show (no take rolling → full show with sound), then dismissed
      await jeff.evalJs(`window.cobanderDebug_levelUp(21); true`); await sleep(900);
      assert.ok(await jeff.evalJs(`!!document.querySelector('#levelup') && /LEVEL 21/.test(document.querySelector('#levelup .lu-n').textContent) && document.querySelectorAll('#levelup .p').length > 50`), 'level-up show');
      await jeff.shot('level-up'); await jeff.evalJs(`document.querySelector('#levelup').click(); true`); await sleep(600);
      assert.ok(await jeff.evalJs(`!document.querySelector('#levelup')`), 'show dismissed');
      // choose your character
      await jeff.evalJs(`document.querySelector('#qb-members .qb-member.me .char').click(); true`); await sleep(400);
      assert.ok(await jeff.evalJs(`document.querySelector('#charpick') && document.querySelector('#charpick').open && document.querySelectorAll('#charpick .char-pick').length >= 10 && document.querySelectorAll('#charpick .cb-row').length >= 10 && !!document.querySelector('#charpick .cb-preview canvas.lpc')`), 'character builder');
      await jeff.evalJs(`[...document.querySelectorAll('#charpick .char-pick')].find((c) => /Thumper/.test(c.textContent)).click(); true`);
      await jeff.evalJs(`[...document.querySelectorAll('#charpick .cb-row[data-key=hair] .cb-opt')].find((o) => o.title === 'Longhawk').click(); true`); await sleep(600); await jeff.shot('char-pick');
      await jeff.evalJs(`document.querySelector('#charpick form').requestSubmit(document.querySelector('#charpick menu button.primary')); true`); await sleep(900);
      q = await jeff.get('/quest'); assert.equal(q.members.find((m) => m.name === 'Jeff').character, 'thumper', 'character saved'); assert.equal(q.members.find((m) => m.name === 'Jeff').look.hair, 'hair_longhawk', 'look saved');
      await jeff.post('/quest', { todo: { id: td.id, delete: true } }); q = await jeff.get('/quest'); assert.ok(!q.todos.find((t) => t.id === td.id), 'removed');
      await jeff.post('/workspace', { ws: 'write' });
      { const names = (await jeff.get('/songs')).map((x) => x.folder); if (!names.includes('Fourteen')) { await jeff.post('/song/create', { name: 'Fourteen', bpm: 120 }); await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'Gtr' } }); } else await jeff.post('/song/open', { folder: 'Fourteen' }); await sleep(600); }
      await jeff.evalJs(`document.querySelector('#btn-track-h').click()`); await sleep(200);
      const h = await jeff.evalJs(`getComputedStyle(document.querySelector('.track')).height`); assert.ok(h === '132px' || h === '44px', `track height after one click: ${h}`);
      assert.equal(await jeff.evalJs(`localStorage.getItem('bp.trackH')`), h.replace('px', ''), 'remembered');
      await jeff.shot('track-height'); await jeff.evalJs(`document.querySelector('#btn-track-h').click(); document.querySelector('#btn-track-h').click()`);
      // many tracks: the playhead line spans the whole content, not just the visible box
      for (let i = 0; i < 14; i++) await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: `Pad ${i}` } });
      await sleep(400);
      { const r = await jeff.evalJs(`(() => { const a = document.querySelector('#arrange'), p = document.querySelector('#playhead'); return { sh: a.scrollHeight, ch: a.clientHeight, ph: p.getBoundingClientRect().height }; })()`); assert.ok(r.sh > r.ch + 50, `tracks overflow the viewport (${JSON.stringify(r)})`); assert.ok(r.ph >= r.sh - 2, `playhead spans the content ${JSON.stringify(r)}`); }
      // Mix = a console: timeline hidden, strips carry role / send / FX chips / quick fixes; Record heads show takes
      await jeff.post('/workspace', { ws: 'mix' }); await sleep(400);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#mixer .strip .quickfix').length >= 1 && document.querySelector('#master-area .lufs') !== null`), 'console strips');
      { const before = await jeff.evalJs(`window.cobanderDebug.engine.tracks[0].fx.hpf.on`); await jeff.evalJs(`document.querySelector('#mixer .strip .chip-fx').click(); true`); await sleep(200); assert.notEqual(await jeff.evalJs(`window.cobanderDebug.engine.tracks[0].fx.hpf.on`), before, 'LC chip toggles the high-pass'); }
      await jeff.shot('mix-console');
      assert.ok(await jeff.evalJs(`!!document.querySelector('.track-head .mixrow input[type=range]')`), 'mix head has a volume slider');
      assert.ok(await jeff.evalJs(`getComputedStyle(document.querySelector('#arrange')).display !== 'none'`), 'timeline visible in Mix');
      assert.ok(await jeff.evalJs(`!document.querySelector('.clip:not(.drumlane)') || (!!document.querySelector('.clip .gl') && !!document.querySelector('.clip .fh.in'))`), 'on-take gain line + fade handles');
      // practice: words flying at you (3D crawl)
      await jeff.post('/lyrics', { add: [{ text: 'noodles in the colander tonight', bar: 1 }, { text: 'strain it out and let it ring', bar: 3 }, { text: 'every take is just a thing', bar: 5 }, { text: 'we never had a doubt', bar: 7 }] });
      await jeff.post('/practice', { open: true }); await sleep(400);
      await jeff.evalJs(`(() => { const v = document.querySelector('#k-view'); v.value = 'crawl'; v.dispatchEvent(new Event('change')); return true; })()`); await sleep(600);
      assert.ok(await jeff.evalJs(`document.querySelectorAll('#k-plane .k-cw').length >= 8`), 'crawl words on the plane');
      // a word being sung sits ON the line (translateY 0), not past it
      { const r = await jeff.evalJs(`(() => { const hl = document.querySelector('#k-crawl .k-hitline').getBoundingClientRect(); return [...document.querySelectorAll('#k-plane .k-cw.now')].map((n) => { const b = n.getBoundingClientRect(); return Math.abs((b.top + b.bottom) / 2 - (hl.top + hl.bottom) / 2); }); })()`); assert.ok(r.length && r.every((d) => d < 8), `sung words sit on the line (off by ${JSON.stringify(r)} px)`); }
      await jeff.evalJs(`{ const kv = document.querySelector('#k-vol'); kv.value = 40; kv.dispatchEvent(new Event('input')); } true`);
      assert.ok(await jeff.evalJs(`Math.abs(window.cobanderDebug.engine.listen - 0.4) < 1e-6 && localStorage.getItem('bp.practiceVol') === '40'`), 'practice volume');
      assert.ok(await jeff.evalJs(`(() => { const k = document.querySelector('#karaoke').getBoundingClientRect(); const sb = document.querySelector('#sidebar').getBoundingClientRect(); return k.left >= sb.right - 1 && k.top > 40; })()`), 'practice covers only the song area');
      assert.ok(await jeff.evalJs(`!document.querySelector('#k-crawl').hidden`), 'crawl view shown');
      await jeff.shot('practice-crawl');
      await jeff.post('/practice', { open: false }); await sleep(200);
      await jeff.post('/workspace', { ws: 'record' }); await sleep(300);
      assert.ok(await jeff.evalJs(`/take|arm it/.test(document.querySelector('.track-head .tinfo').textContent)`), 'record head info');
      await jeff.post('/workspace', { ws: 'write' }); await sleep(300);
      // help: ? button → help mode; hovering a control shows our tip box (the native title is moved to data-tip)
      await jeff.evalJs(`document.querySelector('#btn-help').click(); true`); await sleep(100);
      assert.equal(await jeff.evalJs(`document.body.classList.contains('help')`), true, 'help mode on');
      await jeff.evalJs(`document.querySelector('#bpm').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true`); await sleep(300);
      assert.ok(await jeff.evalJs(`document.querySelector('#help-tip') && document.querySelector('#help-tip').style.display === 'block' && /beats per minute/i.test(document.querySelector('#help-tip').textContent)`), 'tip shows');
      await jeff.shot('help-mode');
      await jeff.evalJs(`document.querySelector('#btn-help').click(); true`);
      // tuner: Done closes the mic it opened
      await jeff.evalJs(`(() => { const E = window.cobanderDebug.engine; if (E.monitorInput) E.setMonitor(false); E.closeInput(); return true; })()`); await sleep(200);   // start with the mic closed, as a bandmate opening the tuner cold would
      await jeff.evalJs(`document.querySelector('#btn-tuner').click(); true`); await sleep(1200);
      assert.equal(await jeff.evalJs(`document.querySelector('#tuner').open`), true, 'tuner open');
      await jeff.evalJs(`document.querySelector('#tuner').close(); true`); await sleep(300);
      assert.equal(await jeff.evalJs(`!!(window.cobanderDebug.engine.inputAlive && window.cobanderDebug.engine.inputAlive())`), false, 'mic released after Done');
      await jeff.post('/song/save'); await jeff.post('/song/close');
      // chart every song: Fourteen has a guitar take (0.14 step) — chords it already drafted mean "nothing new"; a fresh song with the same take gets charted
      await fsp.writeFile(path.join(WORK, 'chords.wav'), chordWav(['G', 'D', 'Em', 'C']));
      await jeff.post('/song/create', { name: 'Fifteen', bpm: 120 }); await jeff.post('/song/patch', { addTrack: { kind: 'guitar', name: 'Gtr' } });
      { const st = await jeff.get('/state'); await jeff.post('/clip/import', { path: path.join(WORK, 'chords.wav'), trackId: st.song.tracks[0].id, start: 0, name: 'strum' }); }
      await jeff.post('/song/save'); await jeff.post('/song/close');
      const ca = await jeff.post('/chart/all'); assert.ok(ca.charted.some((x) => /^Fifteen/.test(x)), JSON.stringify(ca));
      await jeff.post('/song/open', { folder: 'Fifteen' }); { const st = await jeff.get('/state'); assert.ok((st.song.chords || []).length >= 2, 'Fifteen got chords'); } await jeff.post('/song/close');
    });
    await step('shots: website screenshots (a realistic song, no toasts)', async () => {
      if (!process.env.SHOTS) return;
      await fsp.writeFile(path.join(WORK, 'chords.wav'), chordWav(['G', 'D', 'Em', 'C']));
      await fsp.writeFile(path.join(WORK, 'drums.wav'), sloppyDrums(16));
      await fsp.writeFile(path.join(WORK, 'sung.wav'), sungWav());
      await jeff.post('/song/create', { name: 'Basement Anthem', bpm: 128 });
      await jeff.post('/sections', { add: [{ name: 'Intro', startBar: 1, endBar: 2 }, { name: 'Verse 1', startBar: 3, endBar: 6 }, { name: 'Chorus', startBar: 7, endBar: 10 }] });
      for (const [kind, name] of [['guitar', 'Rhythm gtr'], ['bass', 'Bass'], ['drumsMic', 'Drums'], ['vocals', 'Lead vox']]) await jeff.post('/song/patch', { addTrack: { kind, name } });
      const st = await jeff.get('/state'); const tr = (n) => st.song.tracks.find((t) => t.name === n);
      await jeff.post('/clip/import', { path: path.join(WORK, 'chords.wav'), trackId: tr('Rhythm gtr').id, start: 0, name: 'take 3' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'chords.wav'), trackId: tr('Bass').id, start: 0, name: 'take 1' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'drums.wav'), trackId: tr('Drums').id, start: 0, name: 'take 2' });
      await jeff.post('/clip/import', { path: path.join(WORK, 'sung.wav'), trackId: tr('Lead vox').id, start: 3.75, name: 'take 4' });
      await jeff.post('/chords', { fromBar: 1, bars: 'G D | Em C | G D | Em C | G D | Em C | G D | Em C | G D | Em C' });
      await jeff.post('/lyrics', { add: [{ text: 'noodles in the colander tonight', bar: 3 }, { text: 'strain it out and let it ring', bar: 5 }, { text: 'every take is just a thing', bar: 7 }, { text: 'we turn it up and let it out', bar: 9 }] });
      await jeff.post('/quest', { todo: { text: 'book the Halloween show', who: 'Kat' } }); await jeff.post('/quest', { bandName: 'The Colanders' }); await jeff.post('/quest', { todo: { text: 'new strings before practice' } });
      await jeff.post('/quest', { boss: { title: 'Halloween show at the Hi-Dive', date: '2026-10-31' } });
      await jeff.post('/song/save'); await sleep(500);
      // site shots: no real names, test-song names or machine paths in the picture (Jeff/Kat are the harness users). A
      // MutationObserver keeps rewriting, so a re-render after the swap can't bring the real text back.
      await jeff.evalJs(`(() => {
        const swap = [[/\\bJeff\\b/g, 'Riley'], [/\\bKat\\b/g, 'Sam'], [/E2E Band/g, 'The Colanders'], [/E2E Song/g, 'Parking Lot Anthem'], [/Ska API/g, 'Skank Pit'], [/Key Song/g, 'Late Bus'], [/Snap Song/g, 'Fourteen Again'], [/Link Song/g, 'Linked Up'], [/\\/[^\\s]*\\.e2e\\/shared[^\\s]*/g, 'Google Drive › Band stuff › Cobander']];
        const fix = (n) => { let v = n.nodeValue; for (const [re, to] of swap) v = v.replace(re, to); if (v !== n.nodeValue) n.nodeValue = v; };
        window.__scrub = () => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) fix(n); for (const e of document.querySelectorAll('[title]')) { let t = e.title; for (const [re, to] of swap) t = t.replace(re, to); if (t !== e.title) e.title = t; } };
        if (!window.__scrubObs) { window.__scrubObs = new MutationObserver(() => window.__scrub()); window.__scrubObs.observe(document.body, { subtree: true, childList: true, characterData: true }); }
        window.__scrub(); return true; })()`);
      const clean = () => jeff.evalJs(`(() => { for (const t of document.querySelectorAll('#toasts .toast, .toast')) t.remove(); const u = document.querySelector('#update-bar'); if (u) { u.hidden = true; u.style.display = 'none'; } window.__scrub && window.__scrub(); return true; })()`);
      await jeff.post('/workspace', { ws: 'write' }); await sleep(600); await clean(); await jeff.shot('site-write');
      await jeff.post('/workspace', { ws: 'mix' }); await sleep(600); await clean(); await jeff.shot('site-mix');
      await jeff.post('/workspace', { ws: 'band' }); await sleep(800); await clean(); await jeff.shot('site-band');
      // character builder: a fresh look, an instrument, a hair pick — then cancel (nothing saved)
      await jeff.evalJs(`document.querySelector('#qb-members .qb-member.me .char').click(); true`); await sleep(500);
      await jeff.evalJs(`(() => { [...document.querySelectorAll('#charpick .char-pick')].find((c) => /Shredder/.test(c.textContent)).click(); const h = [...document.querySelectorAll('#charpick .cb-row[data-key=hair] .cb-opt')].find((o) => o.title === 'Longhawk'); if (h) h.click(); return true; })()`); await sleep(700); await clean(); await jeff.shot('site-char');
      await jeff.evalJs(`document.querySelector('#charpick menu button.cancel').click(); true`); await sleep(400);
      // the level-up show (forced to a new-name level)
      await jeff.evalJs(`window.cobanderDebug_levelUp(21); true`); await sleep(1300); await clean(); await jeff.shot('site-levelup');
      await jeff.evalJs(`(() => { const o = document.querySelector('#levelup'); if (o) o.click(); return true; })()`); await sleep(600);
      await jeff.post('/workspace', { ws: 'write' }); await jeff.post('/practice', { open: true }); await sleep(400);
      await jeff.evalJs(`(() => { const v = document.querySelector('#k-view'); v.value = 'crawl'; v.dispatchEvent(new Event('change')); return true; })()`); await jeff.post('/transport', { action: 'seek', time: 4.2 }).catch(() => {}); await sleep(700); await clean(); await jeff.shot('site-practice');
      await jeff.post('/practice', { open: false }); await jeff.post('/song/close');
      await jeff.evalJs(`(() => { if (window.__scrubObs) window.__scrubObs.disconnect(); window.__scrubObs = null; return true; })()`);
    });
    await step('opening a song: the screen is usable when the loading bar goes (longest freeze after it is logged)', async () => {
      const songs = await jeff.get('/songs'); const pick = songs.map((x) => x.folder).find((f) => /Basement Anthem|Link Song|Tremors/.test(f)) || (songs[0] && songs[0].folder);
      if (!pick) return; await jeff.post('/song/close').catch(() => {});
      await jeff.evalJs(`(() => { window.__lt = []; try { window.__po && window.__po.disconnect(); window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }); window.__po.observe({ entryTypes: ['longtask'] }); } catch (_) {} return true; })()`);
      await jeff.post('/song/open', { folder: pick }); const t0 = await jeff.evalJs('Math.round(performance.now())'); await sleep(6000);
      const after = await jeff.evalJs(`(window.__lt || []).filter(([t]) => t >= ${t0} - 50)`); const worst = after.reduce((m, [, d]) => Math.max(m, d), 0);
      console.log(`  open "${pick}": longest freeze after the bar ${worst} ms (${after.length} long tasks)`);
      assert.ok(worst < 2500, `the screen froze ${worst} ms after the loading bar went away`);
    });
    await step('no renderer errors in either window', async () => {
      for (const a of [jeff, kat]) { const errs = await a.evalJs(`(window.__errs || []).slice(0, 5)`); assert.deepEqual(errs, [], `${a.name}: ${JSON.stringify(errs)}`); }
    });
    await jeff.shot('final'); await kat.shot('final');
  } catch (err) { failures++; results.push(`FAIL harness: ${err.stack}`); }
  finally { await jeff.stop(); await kat.stop(); }
  console.log(results.join('\n'));
  console.log(failures ? `\n${failures} FAILED` : '\nall e2e steps passed');
  process.exit(failures ? 1 : 0);
})();
