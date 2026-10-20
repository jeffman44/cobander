'use strict';
// In-app updates with zero infrastructure: the band's shared folder carries the installers (and, for everyone else,
// the GitHub release does — same latest.json, attached as an asset next to the installers).
//   <sharedFolder>/installers/latest.json   { version, date, notes[], files{ 'win-x64', 'mac-arm64', 'mac-x64' }, size{}, sha256{} }
//   <sharedFolder>/installers/<file>        the installer that manifest names
// Whoever ships a build drops both there (scripts/build.sh writes release/latest.json; UPDATE-*.cmd copies it up).
// Every Cobander polls the manifest, shows an "Update now" bar when it is newer, verifies the file's sha256,
// copies it out of Drive (so a streamed/placeholder file is fully downloaded first) and installs:
//   Windows: silent NSIS install (/S) after the app exits, then relaunch
//   macOS:   unzip, swap the .app bundle in place, strip quarantine, relaunch
//   Linux:   reveal the file (no packaged Linux installer)
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MANIFEST = 'latest.json';
const CHECK_MS = 10 * 60 * 1000;

function parseVer(v) { return String(v || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0); }
function cmpVer(a, b) { const A = parseVer(a), B = parseVer(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; } return 0; }
function platformKey() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') { let arm = process.arch === 'arm64'; try { if (require('electron').app.runningUnderARM64Translation) arm = true; } catch (_) {} return arm ? 'mac-arm64' : 'mac-x64'; }   // an Intel build under Rosetta moves to the native one
  return `${process.platform}-${process.arch}`;
}
function sha256File(p, onProgress) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'); let done = 0;
    fs.createReadStream(p).on('data', (d) => { h.update(d); done += d.length; if (onProgress) onProgress(done); }).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

class Updater {
  // opts: { currentVersion, sharedFolder(): string|null, notify(status), quit(), log, repo: 'owner/name' (GitHub Releases fallback), fetch }
  constructor(opts) { this.o = opts; this.status = { state: 'idle', current: opts.currentVersion }; this.timer = null; this.snoozed = null; this.installing = false; }
  manifestPath() { const f = this.o.sharedFolder(); return f ? path.join(f, 'installers', MANIFEST) : null; }
  set(patch) { this.status = { ...this.status, ...patch, current: this.o.currentVersion }; this.o.notify(this.status); return this.status; }
  start() { this.stop(); this.check().catch(() => {}); this.timer = setInterval(() => this.check().catch(() => {}), CHECK_MS); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  snooze() { if (this.status.latest) this.snoozed = this.status.latest; this.set({ snoozed: true }); }

  async readManifest() {
    const mp = this.manifestPath();
    if (mp) { let m = null; try { m = JSON.parse((await fsp.readFile(mp, 'utf8')).replace(/^﻿/, '')); } catch (_) { m = null; } if (m && typeof m === 'object' && m.version) { this.source = 'folder'; return m; } }
    // No band folder with installers in it (or none yet): the public releases on GitHub carry the same latest.json.
    return this.readGithubManifest();
  }
  // GitHub Releases: each release has latest.json + the installers as assets; the manifest's `files` name the assets.
  async readGithubManifest() {
    const repo = this.o.repo; if (!repo || !this.o.fetch) return null;
    const now = Date.now(); if (this.gh && now - this.gh.at < 5 * 60 * 1000) return this.gh.m;
    let m = null;
    try {
      const r = await this.o.fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'cobander-updater' } });
      if (r.ok) { const rel = await r.json(); const asset = (rel.assets || []).find((a) => a.name === MANIFEST); if (asset) { const r2 = await this.o.fetch(asset.browser_download_url, { headers: { 'user-agent': 'cobander-updater' } }); if (r2.ok) { m = await r2.json(); if (m && m.chunked && m.chunked.version && cmpVer(m.chunked.version, m.version) > 0) { const ck = m.chunked; m = { version: ck.version, date: ck.date, notes: ck.notes, files: {}, size: {}, sha256: {} }; for (const [k, f] of Object.entries(ck.files || {})) { m.files[k] = String(f.name || '').replace(/^BandPad-/, 'Cobander-'); m.size[k] = f.size; m.sha256[k] = f.sha256; } }   /* the band folder's latest.json carries the real release under `chunked` (the top level is the 0.8.1 bridge) */
          if (m && m.version) { m.github = { tag: rel.tag_name, assets: Object.fromEntries((rel.assets || []).map((a) => [a.name, { url: a.browser_download_url, size: a.size }])) }; delete m.chunked; } else m = null; } } }
    } catch (_) { m = null; }
    this.gh = { at: now, m }; if (m) this.source = 'github';
    return m;
  }

  async check({ force = false } = {}) {
    if (this.installing) return this.status;
    const m = await this.readManifest();
    if (!m) return this.set({ state: 'idle', latest: null, available: false });
    const key = platformKey();
    // Chunked release (0.8.1+): the installer is stored on Drive as ≤25 MB parts (so it can be published without
    // anyone's PC joining it). Older Cobanders ignore `chunked` and use the top-level full installer instead.
    const ck = m.chunked && m.chunked.version && m.chunked.files && m.chunked.files[key] && cmpVer(m.chunked.version, m.version) >= 0 ? m.chunked : null;
    if (ck) return this.checkChunked(ck, key, force);
    const file = m.files && m.files[key];
    const newer = cmpVer(m.version, this.o.currentVersion) > 0;
    if (!newer) return this.set({ state: 'idle', latest: m.version, available: false, notes: m.notes || [], date: m.date || null });
    const base = { state: 'available', latest: m.version, available: true, notes: Array.isArray(m.notes) ? m.notes : [], date: m.date || null, file: file || null, snoozed: !force && this.snoozed === m.version };
    if (!file) return this.set({ ...base, ready: false, reason: `no ${key} installer listed` });
    if (m.github) { const a = m.github.assets[path.basename(file)]; if (!a) return this.set({ ...base, ready: false, reason: 'installer not attached to the GitHub release' }); return this.set({ ...base, ready: true, url: a.url, path: path.basename(file), size: a.size || (m.size && m.size[key]) || 0, sha256: m.sha256 && m.sha256[key] ? m.sha256[key] : null, source: 'github' }); }
    const p = path.join(path.dirname(this.manifestPath()), path.basename(file));
    let st = null; try { st = await fsp.stat(p); } catch (_) {}
    const want = m.size && m.size[key];
    if (!st) return this.set({ ...base, ready: false, reason: 'installer not synced in yet' });
    if (want && st.size !== want) return this.set({ ...base, ready: false, reason: `installer still syncing (${Math.round((100 * st.size) / want)}%)` });
    return this.set({ ...base, ready: true, path: p, size: st.size, sha256: m.sha256 && m.sha256[key] ? m.sha256[key] : null });
  }

  async checkChunked(ck, key, force) {
    const f = ck.files[key]; const dir = path.dirname(this.manifestPath());
    const newer = cmpVer(ck.version, this.o.currentVersion) > 0;
    if (!newer) return this.set({ state: 'idle', latest: ck.version, available: false, notes: ck.notes || [], date: ck.date || null });
    const base = { state: 'available', latest: ck.version, available: true, notes: Array.isArray(ck.notes) ? ck.notes : [], date: ck.date || null, file: f.name, snoozed: !force && this.snoozed === ck.version };
    const parts = Array.isArray(f.parts) ? f.parts : []; if (!parts.length) return this.set({ ...base, ready: false, reason: `no ${key} installer listed` });
    let have = 0, got = 0;
    for (const pt of parts) { let st = null; try { st = await fsp.stat(path.join(dir, path.basename(pt.file))); } catch (_) {} if (st && st.size === pt.size) { have++; got += st.size; } else if (st) got += Math.min(st.size, pt.size); }
    if (have < parts.length) return this.set({ ...base, ready: false, reason: have ? `installer still syncing (${Math.round((100 * got) / (f.size || 1))}%)` : 'installer not synced from Drive yet' });
    return this.set({ ...base, ready: true, parts: parts.map((pt) => path.join(dir, path.basename(pt.file))), path: f.name, size: f.size, sha256: f.sha256 || null });
  }

  async install() {
    if (this.installing) return this.status;
    const s = await this.check({ force: true });
    if (!s.available || !s.ready) throw new Error(s.reason || 'No update is ready.');
    this.installing = true; let out = null;
    try {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bandpad-update-'));
      const local = path.join(tmp, path.basename(s.path));
      this.set({ state: 'downloading', progress: 0 });
      let done = 0; const total = s.size || 1;
      out = fs.createWriteStream(local); let outErr = null; out.on('error', (e) => { outErr = e; });
      if (s.url) {   // GitHub release asset: stream it down
        const r = await this.o.fetch(s.url, { headers: { 'user-agent': 'cobander-updater' } }); if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
        const total2 = Number(r.headers.get('content-length')) || total;
        for await (const d of r.body) { if (outErr) throw outErr; if (!out.write(d)) await new Promise((res) => out.once('drain', res)); done += d.length; this.set({ state: 'downloading', progress: Math.min(1, done / total2) }); }
      } else for (const src of (s.parts || [s.path])) {   // a chunked installer is joined back together here
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(src); rs.on('data', (d) => { done += d.length; this.set({ state: 'downloading', progress: Math.min(1, done / total) }); });
          rs.on('error', reject); rs.on('end', resolve); rs.pipe(out, { end: false });
        });
      }
      if (outErr) throw outErr;
      await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
      this.set({ state: 'verifying' });
      if (s.sha256) { const got = await sha256File(local); if (got.toLowerCase() !== String(s.sha256).toLowerCase()) throw new Error('The installer in the shared folder is corrupt or still syncing (checksum mismatch). Try again in a minute.'); }
      this.set({ state: 'installing' });
      await this.launchInstaller(local, tmp);
      return this.status;
    } catch (err) {
      try { if (out) out.destroy(); } catch (_) {}
      this.installing = false; this.set({ state: 'error', error: err.message });
      throw err;
    }
  }

  async launchInstaller(local, tmp) {
    const pid = process.pid;
    if (process.platform === 'win32') {
      const exe = process.execPath;
      const script = path.join(tmp, 'update.cmd');
      await fsp.writeFile(script, [
        '@echo off',
        'set /a n=0',
        ':wait',
        // wait for Cobander to save and exit; after ~2 minutes stop waiting and close it (the quit-time save has finished or given up by then)
        `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul || goto go`,
        'set /a n+=1',
        `if %n% GEQ 120 (taskkill /PID ${pid} /T /F >nul 2>&1 & ping -n 3 127.0.0.1 >nul & goto go)`,
        'ping -n 2 127.0.0.1 >nul',
        'goto wait',
        ':go',
        `"${local}" /S`,
        // the app may now live under a new name (BandPad → Cobander): open whichever exists
        `if exist "%LOCALAPPDATA%\\Programs\\Cobander\\Cobander.exe" (start "" "%LOCALAPPDATA%\\Programs\\Cobander\\Cobander.exe") else (start "" "${exe}")`,
        '',
      ].join('\r\n'));
      // Run it through a hidden VBScript: with Windows Terminal as the default console, a plain detached cmd.exe pops a
      // terminal window (windowsHide is ignored); a window started hidden (SW_HIDE) is never handed to Terminal.
      const vbs = path.join(tmp, 'update.vbs');
      await fsp.writeFile(vbs, `CreateObject("WScript.Shell").Run "cmd.exe /c ""${script}""", 0, False\r\n`);
      const child = spawn('wscript.exe', ['//B', '//Nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => { const c2 = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }); c2.unref(); });   /* no Windows Script Host: the old way (a console window shows while it waits) */
      child.unref();
    } else if (process.platform === 'darwin') {
      // process.execPath = /…/Cobander.app/Contents/MacOS/Cobander → replace that bundle in place
      const bundle = path.resolve(process.execPath, '..', '..', '..');
      if (!/\.app$/.test(bundle)) throw new Error(`Not running from an app bundle (${bundle}); install the zip by hand.`);
      // Opened straight from Downloads/the zip, macOS runs a read-only copy ("App Translocation"): it cannot be replaced.
      if (/\/AppTranslocation\//.test(bundle)) throw new Error('macOS is running Cobander from a temporary read-only copy, so it can\'t update itself. Drag Cobander into your Applications folder, open it from there, then press Update now again.');
      try { await fsp.access(path.dirname(bundle), fs.constants.W_OK); } catch (_) { throw new Error(`Cobander can't write to ${path.dirname(bundle)}, so it can't update itself. Move Cobander into your Applications folder (or your own folder) and try again.`); }
      const logDir = path.join(os.homedir(), 'Library', 'Logs', 'Cobander'); await fsp.mkdir(logDir, { recursive: true }).catch(() => {});
      const log = path.join(logDir, 'update.log');
      const old = `${bundle}.old-${Date.now()}`;
      const script = path.join(tmp, 'update.sh');
      // Swap with rollback: move the old app aside, move the new one in; on any failure put the old one back.
      // Always relaunch whichever Cobander survived, and leave a log the next launch can show.
      await fsp.writeFile(script, [
        '#!/bin/bash',
        `exec >>"${log}" 2>&1; echo "--- $(date) update to ${path.basename(local)}"`,
        `while kill -0 ${pid} 2>/dev/null; do sleep 1; done`,
        // the zip holds one <Name>.app (Cobander.app; an older build was BandPad.app) — it goes in next to the running one under its own name
        `if ! ditto -xk "${local}" "${tmp}/unz" || [ -z "$(ls -d "${tmp}"/unz/*.app 2>/dev/null)" ]; then echo "FAIL unzip"; open "${bundle}"; exit 1; fi`,
        `NEW=$(ls -d "${tmp}"/unz/*.app | head -1); DEST="${path.dirname(bundle)}/$(basename "$NEW")"`,
        `if ! mv "${bundle}" "${old}"; then echo "FAIL move old aside"; open "${bundle}"; exit 1; fi`,
        `if [ "$DEST" != "${bundle}" ] && [ -e "$DEST" ]; then echo "replacing existing $DEST"; rm -rf "$DEST"; fi`,
        `if ! mv "$NEW" "$DEST"; then echo "FAIL move new in; rolling back"; mv "${old}" "${bundle}"; open "${bundle}"; exit 1; fi`,
        `xattr -dr com.apple.quarantine "$DEST" 2>/dev/null`,
        `rm -rf "${old}"`,
        'echo "OK"',
        `open "$DEST"`,
        '',
      ].join('\n'), { mode: 0o755 });
      const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }); child.unref();
    } else {
      throw new Error(`No automatic install on ${process.platform}. The file is at ${local}.`);
    }
    setTimeout(() => this.o.quit(), 400);
  }
}

module.exports = { Updater, cmpVer, platformKey, MANIFEST, sha256File };
