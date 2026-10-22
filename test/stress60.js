'use strict';
// Run: xvfb-run -a -s "-screen 0 1440x900x24" node test/stress60.js   (N=60 SECS=180 by default). Output in .e2e/stress/.
// 60-track stress: one window, a 3-minute song with 60 tracks of real-ish audio. Measures import, open freeze, playback.
const { spawn } = require('child_process'); const fs = require('fs'); const fsp = require('fs/promises'); const path = require('path'); const http = require('http');
const ROOT = require('path').join(__dirname, '..'); const WORK = path.join(ROOT, '.e2e', 'stress'); const ELECTRON = require(path.join(ROOT, 'node_modules', 'electron'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const N = Number(process.env.N || 60), SECS = Number(process.env.SECS || 180), SR = 48000;
function wav(seed) { const n = SECS * SR, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  const f = 80 * 2 ** (seed % 36 / 12); let s = seed * 7919 + 1; for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; const v = 0.25 * Math.sin(2 * Math.PI * f * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * i / SR)) + 0.03 * (s / 2147483647 - 0.5); b.writeInt16LE(Math.round(v * 32767), 44 + i * 2); } return b; }
const port = 47321, token = 'stress';
function req(method, p, body, timeout = 600000) { return new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, method, path: p, timeout, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} res.statusCode >= 400 ? reject(new Error(`${p} ${res.statusCode} ${d.slice(0, 200)}`)) : resolve(j); }); }); r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout ' + p))); if (body !== undefined) r.write(JSON.stringify(body)); r.end(); }); }
const ev = (js) => req('POST', '/debug/eval', { js }).then((r) => r.result);
(async () => {
  await fsp.rm(WORK, { recursive: true, force: true }); const shared = path.join(WORK, 'shared'), cfg = path.join(WORK, 'cfg'), src = path.join(WORK, 'src'); await fsp.mkdir(shared, { recursive: true }); await fsp.mkdir(src, { recursive: true });
  const ud = path.join(cfg, 'Cobander'); await fsp.mkdir(ud, { recursive: true });
  await fsp.writeFile(path.join(ud, 'settings.json'), JSON.stringify({ sharedFolder: shared, displayName: 'Riley', apiPort: port, apiToken: token, phonePort: port + 10, apiInbox: path.join(cfg, 'inbox'), fanfare: false, autoUnlockTracks: true }));
  let t = Date.now(); for (let i = 0; i < N; i++) await fsp.writeFile(path.join(src, `t${i}.wav`), wav(i)); console.log(`made ${N} × ${SECS}s wavs in ${Date.now() - t} ms`);
  const proc = spawn(ELECTRON, [ROOT, '--no-sandbox', '--autoplay-policy=no-user-gesture-required'], { env: { ...process.env, XDG_CONFIG_HOME: cfg, BP_DEBUG: '1' }, stdio: ['ignore', fs.openSync(path.join(WORK, 'app.log'), 'w'), fs.openSync(path.join(WORK, 'app.log'), 'a')] });
  try {
    for (let i = 0; i < 120; i++) { try { await req('GET', '/state'); break; } catch (_) { await sleep(500); } }
    await req('POST', '/song/create', { name: 'Sixty', bpm: 120 }); await sleep(1500);
    t = Date.now(); for (let i = 0; i < N; i++) { const s = Date.now(); await req('POST', '/clip/import', { path: path.join(src, `t${i}.wav`), start: 0, name: `take ${i + 1}` }); if (i % 10 === 9) console.log(`  imported ${i + 1} (last ${Date.now() - s} ms)`); }
    console.log(`import ${N}: ${Date.now() - t} ms`);
    await req('POST', '/song/save', { force: true }); const st = await req('GET', '/state'); console.log('tracks in song:', st.song && (st.song.tracks || []).length, JSON.stringify(st).slice(0, 200));
    const mem0 = await ev('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1e6) : null');
    await req('POST', '/song/close'); await sleep(1500);
    await ev(`(() => { window.__lt = []; try { window.__po && window.__po.disconnect(); window.__po = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }); window.__po.observe({ entryTypes: ['longtask'] }); } catch (_) {} return true; })()`);
    const t1 = await ev('Math.round(performance.now())'); t = Date.now(); await req('POST', '/song/open', { folder: 'Sixty' }); const openMs = Date.now() - t;
    const t2 = await ev('Math.round(performance.now())'); await sleep(8000);
    const lt = await ev(`window.__lt || []`); const during = lt.filter(([s]) => s >= t1 && s < t2), after = lt.filter(([s]) => s >= t2 - 50);
    console.log(`open: ${openMs} ms (API returns when loaded); longest freeze while loading ${Math.max(0, ...during.map((x) => x[1]))} ms; after the bar ${Math.max(0, ...after.map((x) => x[1]))} ms (${after.length} long tasks)`);
    console.log('JS heap MB:', mem0, '→', await ev('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1e6) : null'));
    for (const ws of ['record', 'mix', 'write']) { await ev(`window.__lt = []; true`); const a = Date.now(); await req('POST', '/workspace', { ws }); await sleep(1500); const l = await ev('window.__lt'); console.log(`workspace ${ws}: longest freeze ${Math.max(0, ...l.map((x) => x[1]))} ms`); }
    // playback: does the transport keep real time with 60 tracks?
    await req('POST', '/transport', { action: 'seek', time: 10 }); await ev(`window.__lt = []; true`);
    const p0 = Date.now(); await req('POST', '/transport', { action: 'play' }); await sleep(10000); const s1 = await req('GET', '/state'); const wall = (Date.now() - p0) / 1000;
    await req('POST', '/transport', { action: 'stop' });
    const pos = s1.transport ? s1.transport.time : s1.time; const l = await ev('window.__lt');
    console.log(`play 10 s wall → song time ${pos} (started at 10; expect ~${(10 + wall).toFixed(1)}); longest freeze while playing ${Math.max(0, ...l.map((x) => x[1]))} ms`);
    console.log('transport state sample:', JSON.stringify(s1.transport || {}).slice(0, 300));
    const errs = await ev('(window.__errs || []).slice(0, 5)'); console.log('renderer errors:', JSON.stringify(errs));
    await req('POST', '/debug/screenshot', { file: path.join(WORK, 'mix60.png') }).catch(() => {});
    const du = require('child_process').execSync(`du -sh "${path.join(shared, 'Sixty')}"`).toString().trim(); console.log('song folder size:', du);
  } catch (e) { console.log('FAIL', e.stack); }
  finally { proc.kill('SIGTERM'); await sleep(1500); try { proc.kill('SIGKILL'); } catch (_) {} }
  console.log('done');
})();
