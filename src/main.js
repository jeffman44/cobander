'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, systemPreferences, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { SongStore, clientIdentity, HEARTBEAT_MS, SONG_FILE, LOCK_FILE, PRESENCE_DIR, looksLikeDrivePath, cloudProvider, atomicWrite, localStamp, lockNewer } = require('./store');
const controlApi = require('./control-api');
const { Updater } = require('./updater');

// Cobander was BandPad until 0.15: keep every computer's settings, models and unsaved backups by moving the old
// data folder over once (or using it in place if the move fails — another window may still be closing).
try {
  const appData = app.getPath('appData'); const neu = path.join(appData, 'Cobander'); const alt = path.join(appData, 'BandPad');
  if (!fs.existsSync(neu) && fs.existsSync(alt)) { try { fs.renameSync(alt, neu); } catch (_) { app.setPath('userData', alt); } }
  else if (fs.existsSync(neu) && fs.existsSync(alt) && !fs.existsSync(path.join(neu, 'settings.json')) && fs.existsSync(path.join(alt, 'settings.json'))) { try { fs.copyFileSync(path.join(alt, 'settings.json'), path.join(neu, 'settings.json')); } catch (_) {} }
} catch (_) { /* best effort */ }
// Where Cobander lives in public: GitHub repo (releases + issues) and the tip jar.
const PKG = require('../package.json');
const REPO = (PKG.repository && String(PKG.repository.url || PKG.repository).replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '')) || null;
const LINKS = { repo: REPO ? `https://github.com/${REPO}` : null, venmo: 'https://venmo.com/u/jdeuel44', kofi: PKG.funding && PKG.funding.kofi ? PKG.funding.kofi : null, takeout: (PKG.funding && (PKG.funding.takeout || PKG.funding.kofi)) || null };   // takeout: the pay-what-you-want download (Ko-fi until the storefront exists)
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const POLL_MS = 3000;            // belt-and-suspenders poll; fs.watch is unreliable on Drive mounts
const AI_DOC_VERSION_RE = /^<!-- bandpad-ai-doc v(\d+) -->/m;

// One instance per machine: two instances would fight over the API port, settings and locks.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

let win = null;
let store = null;
let settings = { sharedFolder: null, displayName: null, inputDeviceId: null, apiPort: controlApi.DEFAULT_PORT, apiToken: null, apiInbox: null, lastSeen: {} };
let apiHandlers = null;
let identity = null;
let apiServer = null;
let apiStartError = null;
let updater = null;

// per-open-song state
let open = null;   // { folder, lock, heartbeatTimer, lastMtime, lastSaveId, missedHeartbeats }
let watcher = null;
let pollTimer = null;
let lastListSnapshot = '';
let lastLockStatus = '';
let snapshotInFlight = false;
let snapshotAgain = false;

// ---------- settings ----------
function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8').replace(/^\uFEFF/, '')) };   // tolerate a UTF-8 BOM (PowerShell's Set-Content adds one)
  } catch (_) { /* first run */ }
  if (!settings.apiToken) {
    settings.apiToken = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  }
  if (!settings.machineName) {
    settings.machineName = require('os').hostname().replace(/\.(local|lan|home|localdomain)$/i, '');
    try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (_) {}
  }
  identity = clientIdentity(settings.displayName, settings.machineName);
}
async function saveSettings() {
  await fsp.mkdir(path.dirname(SETTINGS_FILE()), { recursive: true });
  await fsp.writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  identity = clientIdentity(settings.displayName, settings.machineName);
}
const settingsView = () => ({ ...settings, identity, driveLike: looksLikeDrivePath(settings.sharedFolder), cloud: cloudProvider(settings.sharedFolder) });

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- shared folder watching ----------
async function snapshotSongs() {
  if (!store) return;
  if (snapshotInFlight) { snapshotAgain = true; return; }
  snapshotInFlight = true;
  try {
    const songs = await store.listSongs(identity, { lastSeen: seenMap() });
    const snap = JSON.stringify(songs.map((s) => [s.folder, s.rev, s.saveId, s.mtimeMs, s.lock && s.lock.token, s.lock && s.lock.heartbeat, s.lock && s.lock.stale, s.conflictCopies, s.needsOpen, s.mentions, s.presence, s.needsMine, s.stage, s.needsDone]));
    if (snap !== lastListSnapshot) {
      lastListSnapshot = snap;
      send('songs:changed', songs);
    }
    if (open) {
      const mine = songs.find((s) => s.folder === open.folder);
      if (mine) {
        if (mine.saveId !== open.lastSaveId) {
          open.lastSaveId = mine.saveId; open.lastMtime = mine.mtimeMs;
          send('song:externalChange', { folder: open.folder, rev: mine.rev, saveId: mine.saveId, savedBy: mine.savedBy, savedAt: mine.savedAt });
        }
        // A newer lock than ours (someone took over) → drop to read-only now, not after two missed heartbeats.
        // An OLDER foreign lock could be Drive serving a stale file, so that case is left to the heartbeat rule.
        if (open.lock && mine.lock && mine.lock.token !== open.lock.token && lockNewer(mine.lock, open.lock)) markLockLost(mine.lock);
        const ls = JSON.stringify([mine.lock && mine.lock.token, mine.lock && mine.lock.stale, mine.lockMine, mine.lock && mine.lock.user]);
        if (ls !== lastLockStatus) {
          lastLockStatus = ls;
          send('song:lockStatus', { folder: open.folder, lock: mine.lock, mine: mine.lockMine });
        }
      } else if (!(await store.songExists(open.folder))) {
        send('song:externalChange', { folder: open.folder, deleted: true });
      }
      // else: song.json half-synced or unparsable right now; say nothing and wait
    }
  } catch (err) {
    send('store:error', { message: `Shared folder problem: ${err.message}` });
  } finally {
    snapshotInFlight = false;
    if (snapshotAgain) { snapshotAgain = false; setTimeout(snapshotSongs, 200); }
  }
}

function startWatching() {
  stopWatching();
  if (!store) return;
  try {
    watcher = fs.watch(store.root, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const base = path.basename(String(filename));
      if (/\.(wav|flac)$/i.test(base)) { clearTimeout(watcher._wavDebounce); watcher._wavDebounce = setTimeout(() => send('audio:arrived', {}), 800); }
      if (base === SONG_FILE || base === LOCK_FILE || /\.(wav|flac)$/i.test(base) || /\(\d+\)\.json$/.test(base) || String(filename).includes(PRESENCE_DIR)) {
        clearTimeout(watcher._debounce);
        watcher._debounce = setTimeout(snapshotSongs, 400);
      }
    });
    watcher.on('error', () => { /* fall back to polling only */ });
  } catch (_) {
    watcher = null;
  }
  pollTimer = setInterval(snapshotSongs, POLL_MS);
  snapshotSongs();
}
function stopWatching() {
  if (watcher) { try { watcher.close(); } catch (_) {} watcher = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastListSnapshot = ''; lastLockStatus = '';
}

async function dropAiDoc(folder) {
  try {
    const src = path.join(__dirname, 'AI.md');
    const dst = path.join(folder, 'AI.md');
    const body = await fsp.readFile(src, 'utf8');
    const ours = Number((AI_DOC_VERSION_RE.exec(body) || [])[1] || 0);
    let theirs = -1;
    try { theirs = Number((AI_DOC_VERSION_RE.exec(await fsp.readFile(dst, 'utf8')) || [])[1] || 0); } catch (_) {}
    if (theirs < ours) await fsp.writeFile(dst, body);
  } catch (_) { /* non-fatal */ }
}

function setSharedFolder(folder) {
  store = folder ? new SongStore(folder) : null;
  if (folder) dropAiDoc(folder);
  startWatching();
  if (updater) updater.start();
}

// ---------- "seen" times (for @mention badges) + presence ----------
// settings.lastSeen[<sharedFolder>::<song folder>] = ISO time I last had that song open; mentions older than that are read.
const seenKey = (folder) => `${settings.sharedFolder}::${folder}`;
function seenMap() { const out = {}; const pre = `${settings.sharedFolder}::`; for (const [k, v] of Object.entries(settings.lastSeen || {})) if (k.startsWith(pre)) out[k.slice(pre.length)] = v; return out; }
function markSeen(folder) { settings.lastSeen = { ...(settings.lastSeen || {}), [seenKey(folder)]: new Date().toISOString() }; saveSettings().catch(() => {}); }
let presence = { mode: 'listening', playing: false };
let presenceTimer = null;
async function writePresenceNow() {
  if (!open || !store) return;
  try { await store.writePresence(open.folder, identity, { mode: presence.mode === 'practicing' ? 'practicing' : open.lock ? presence.mode === 'recording' ? 'recording' : 'editing' : presence.mode === 'waiting' ? 'waiting' : 'listening', playing: presence.playing }); } catch (_) { /* Drive hiccup; next beat retries */ }
}
function startPresence() { stopPresence(); writePresenceNow(); presenceTimer = setInterval(writePresenceNow, HEARTBEAT_MS); }
function stopPresence() { if (presenceTimer) clearInterval(presenceTimer); presenceTimer = null; }

// ---------- sleep / wake ----------
// After the computer sleeps (or the app stalls), our view of the shared folder is old: a bandmate may have taken the
// lock while we were away and Drive has not delivered that yet. Hold heartbeats and saves briefly so we never write
// our stale lock / song over theirs, and restart the "has the lock stopped changing" clocks.
const WAKE_HOLD_MS = 25 * 1000;
let wakeHoldUntil = 0;
function noteWake(why) {
  wakeHoldUntil = Date.now() + WAKE_HOLD_MS;
  if (store) { store.seen.clear(); if (store.seenPresence) store.seenPresence.clear(); }
  if (process.env.BP_DEBUG) console.log(`wake hold (${why})`);
  setTimeout(snapshotSongs, 2000);
}
const inWakeHold = () => Date.now() < wakeHoldUntil;

// ---------- lock lifecycle ----------
async function closeOpenSong() {
  if (!open) return;
  const me = open;
  clearInterval(me.heartbeatTimer);
  me.gen = (me.gen || 0) + 1;          // any in-flight heartbeat must not resurrect the lock
  open = null;
  lastLockStatus = '';
  stopPresence(); markSeen(me.folder);
  if (store) await Promise.race([store.clearPresence(me.folder, identity).catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  if (me.hbInFlight) await Promise.race([me.hbInFlight.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  if (me.lock && store) await Promise.race([store.releaseLock(me.folder, me.lock).catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
}

function startHeartbeat() {
  const gen = (open.gen = (open.gen || 0) + 1);
  const me = open;
  me.lastBeatAt = Date.now();
  open.heartbeatTimer = setInterval(async () => {
    if (open !== me || me.gen !== gen || !me.lock) return;
    const gap = Date.now() - (me.lastBeatAt || Date.now()); me.lastBeatAt = Date.now();
    if (gap > HEARTBEAT_MS * 2.5) noteWake(`timer gap ${Math.round(gap / 1000)} s`);
    if (inWakeHold()) return;
    try {
      me.hbInFlight = store.heartbeat(me.folder, me.lock, () => open === me && me.gen === gen);
      const hb = await me.hbInFlight.finally(() => { me.hbInFlight = null; });
      if (open !== me || me.gen !== gen) return;
      if (hb.missing) { open.missedHeartbeats = 0; open.lock = hb.lock; }   // file vanished (Drive hiccup) → re-asserted
      else if (hb.lost) {
        // Drive can momentarily serve an older lock file; require two misses in a row —
        // unless the foreign lock is newer than ours, which can only be a real takeover.
        open.missedHeartbeats = (open.missedHeartbeats || 0) + 1;
        const newer = lockNewer(hb.lock, open.lock);
        if (open.missedHeartbeats >= 2 || newer) {
          clearInterval(open.heartbeatTimer);
          open.lock = null;
          send('song:lockLost', { folder: open.folder, lock: hb.lock });
        }
      } else {
        open.missedHeartbeats = 0;
        open.lock = hb.lock;
      }
    } catch (err) {
      send('store:error', { message: `Heartbeat failed: ${err.message}` });
    }
  }, HEARTBEAT_MS);
}

async function openSong(folder, { force = false, quiet = false } = {}) {
  await closeOpenSong();
  const { song, mtimeMs } = await store.loadSong(folder);
  const res = await store.acquireLock(folder, identity, { force });
  open = { folder, lock: res.ok ? res.lock : null, heartbeatTimer: null, lastMtime: mtimeMs, lastSaveId: song.saveId || null, missedHeartbeats: 0 };
  if (res.ok) startHeartbeat();
  const lastSeen = seenMap()[folder] || null;
  if (!quiet) markSeen(folder); presence = { mode: 'listening', playing: false }; startPresence();
  return { song, mtimeMs, readOnly: !res.ok, lock: res.lock, lastSeen, bounces: await store.listBounces(folder), unreferenced: await store.unreferencedTakes(folder) };
}

// Take over the lock on the song that is already open, without reloading anything.
async function takeOverLock(folder) {
  if (!open || open.folder !== folder) throw new Error('that song is not open');
  const me = open;
  clearInterval(me.heartbeatTimer);
  me.gen = (me.gen || 0) + 1;                   // retire any in-flight heartbeat of the old lock
  if (me.hbInFlight) await Promise.race([me.hbInFlight.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  const res = await store.acquireLock(folder, identity, { force: true });
  if (open !== me) {                            // closed while we were acquiring: don't orphan the new lock
    if (res.ok) await store.releaseLock(folder, res.lock).catch(() => {});
    throw new Error('song was closed during take-over');
  }
  me.lock = res.ok ? res.lock : null;
  me.missedHeartbeats = 0;
  if (res.ok) startHeartbeat();
  lastLockStatus = '';
  writePresenceNow();
  snapshotSongs();
  return { readOnly: !res.ok, lock: res.lock };
}

// ---------- IPC ----------
function guardStore() {
  if (!store) throw new Error('No shared folder selected');
  return store;
}

let inFlightWrites = 0;
async function tracked(fn) { inFlightWrites++; try { return await fn(); } finally { inFlightWrites--; } }
function markLockLost(theirLock) {
  if (!open || !open.lock) return;
  clearInterval(open.heartbeatTimer);
  open.gen = (open.gen || 0) + 1;              // an in-flight heartbeat must not resurrect our lock
  open.lock = null; open.missedHeartbeats = 0;
  send('song:lockLost', { folder: open.folder, lock: theirLock });
}
async function doSave(folder, song, opts) {
  const s = guardStore();
  if (!open || open.folder !== folder || !open.lock) throw new Error('You do not hold the lock on this song (read-only). Use "Take over" to edit.');
  if (inWakeHold()) { const err = new Error('Just woke up — waiting a few seconds for Drive to catch up before saving. Will retry.'); err.transient = true; throw err; }
  // Re-check the lock file right before writing: a takeover in the last few seconds must not be clobbered.
  const cur = await s.readLock(folder).catch(() => null);
  if (cur && cur.token !== open.lock.token) {
    if (lockNewer(cur, open.lock)) {
      markLockLost(cur);
      throw new Error(`${cur.user || 'Someone'} took over this song — not saved. Your changes are kept; "Take over" to get the lock back.`);
    }
    // Foreign lock that looks older than ours: probably Drive serving a stale file, but never write over a lock we can't verify.
    const err = new Error(`Lock file is not yours right now (${cur.user || 'someone'}'s) — Drive may be mid-sync. Will retry.`); err.transient = true; throw err;
  }
  return tracked(async () => {
    const r = await s.saveSong(folder, song, identity, opts || {});
    if (!r.conflict && open && open.folder === folder) { open.lastMtime = r.mtimeMs; open.lastSaveId = r.song.saveId; }
    return r;
  });
}

// Unsaved-work backups live in the user's own app data (never in the shared folder).
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'unsaved');
const backupFile = (folder) => path.join(BACKUP_DIR(), `${Buffer.from(`${settings.sharedFolder}::${folder}`).toString('base64url')}.json`);
async function writeBackup(folder, song, takes = []) {
  return tracked(async () => {
    await fsp.mkdir(BACKUP_DIR(), { recursive: true });
    const saved = [];
    for (const t of takes) { const f = backupFile(folder).replace(/\.json$/, `.${t.clipId}.wav`); await atomicWrite(f, Buffer.from(t.wav)); saved.push({ clipId: t.clipId, trackId: t.trackId, clip: t.clip, file: f, crash: t.crash || null }); }
    await atomicWrite(backupFile(folder), JSON.stringify({ folder, at: new Date().toISOString(), song, takes: saved }));
  });
}
async function readBackup(folder) {
  try {
    const b = JSON.parse(await fsp.readFile(backupFile(folder), 'utf8'));
    for (const t of b.takes || []) { const buf = await fsp.readFile(t.file); t.wav = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
    return b;
  } catch (_) { return null; }
}
async function clearBackup(folder) {
  const b = await readBackup(folder).catch(() => null);
  for (const t of (b && b.takes) || []) await fsp.unlink(t.file).catch(() => {});
  await fsp.unlink(backupFile(folder)).catch(() => {});
}

ipcMain.handle('settings:get', () => settingsView());
ipcMain.handle('update:status', () => updater ? updater.status : { state: 'idle', current: app.getVersion() });
ipcMain.handle('update:check', () => updater.check({ force: true }));
ipcMain.handle('update:install', () => updater.install());
ipcMain.handle('update:snooze', () => updater.snooze());
ipcMain.handle('settings:set', async (_e, patch) => {
  const prevFolder = settings.sharedFolder;
  settings = { ...settings, ...patch };
  await saveSettings();
  if (patch.sharedFolder !== undefined && patch.sharedFolder !== prevFolder) {
    await closeOpenSong();
    setSharedFolder(settings.sharedFolder);
  }
  if (patch.apiInbox !== undefined) startInbox();
  // Name changed while holding a lock: re-stamp the lock so bandmates see the new name.
  if (patch.displayName !== undefined && open && open.lock && open.lock.user !== identity.user) {
    try {
      await takeOverLock(open.folder);
    } catch (err) { send('store:error', { message: `Could not update your name on the lock: ${err.message}` }); }
  }
  return settingsView();
});
ipcMain.handle('settings:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pick the shared band folder (inside Google Drive)',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('songs:list', () => guardStore().listSongs(identity, { lastSeen: seenMap() }));
ipcMain.handle('presence:set', (_e, p) => { const next = { mode: ['listening', 'editing', 'recording', 'waiting', 'practicing'].includes(p && p.mode) ? p.mode : 'listening', playing: !!(p && p.playing) }; const changed = next.mode !== presence.mode || next.playing !== presence.playing; presence = next; if (changed) writePresenceNow(); });
ipcMain.handle('song:markSeen', (_e, folder) => { if (folder) markSeen(folder); });
ipcMain.handle('version:write', (_e, folder, id, song) => tracked(() => guardStore().writeVersion(folder, id, song)));
ipcMain.handle('version:read', (_e, folder, id) => guardStore().readVersion(folder, id));
ipcMain.handle('history:list', (_e, folder) => guardStore().listHistory(folder));
ipcMain.handle('templates:list', () => guardStore().listTemplates());
ipcMain.handle('parts:list', () => guardStore().listParts());
ipcMain.handle('parts:save', (_e, folder, part, audioIds) => tracked(() => guardStore().savePart(folder, part, audioIds)));
ipcMain.handle('parts:readAudio', async (_e, id) => { const b = await guardStore().readPartAudio(id); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); });
ipcMain.handle('parts:delete', (_e, id) => guardStore().deletePart(id));
ipcMain.handle('parts:writeAudio', (_e, id, buf) => tracked(() => guardStore().writePartAudio(id, buf)));
ipcMain.handle('templates:write', (_e, t) => tracked(() => guardStore().writeTemplate(t)));
ipcMain.handle('templates:delete', (_e, id) => guardStore().deleteTemplate(id));
ipcMain.handle('history:read', (_e, folder, saveId) => guardStore().readHistory(folder, saveId));
ipcMain.handle('songs:create', (_e, name) => guardStore().createSong(name));
ipcMain.handle('songs:check', (_e, name) => guardStore().checkSongName(name));
ipcMain.handle('song:open', (_e, folder, opts) => { guardStore(); return openSong(folder, opts || {}); });
ipcMain.handle('song:close', () => closeOpenSong());
ipcMain.handle('song:trash', async (_e, folder) => { const s = guardStore(); if (open && open.folder === folder) await closeOpenSong(); const r = await s.trashSong(folder, identity); snapshotSongs().catch(() => {}); return r; });
ipcMain.handle('song:trashed', () => guardStore().listTrashedSongs());
ipcMain.handle('quest:read', () => guardStore().readQuest());
// ---- speech-to-text model files (Whisper, downloaded once per computer into userData/models) ----
const modelDir = () => path.join(app.getPath('userData'), 'models');
const modelFile = (url) => path.join(modelDir(), require('crypto').createHash('sha256').update(String(url)).digest('hex').slice(0, 40));
ipcMain.handle('asr:cacheGet', async (_e, url) => { try { const b = await fs.promises.readFile(modelFile(url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch (_) { return null; } });
ipcMain.handle('asr:cachePut', async (_e, url, buf) => { await fs.promises.mkdir(modelDir(), { recursive: true }); const f = modelFile(url); await fs.promises.writeFile(`${f}.part`, Buffer.from(buf)); await fs.promises.rename(`${f}.part`, f); return true; });
ipcMain.handle('asr:cacheInfo', async () => { try { const names = await fs.promises.readdir(modelDir()); let bytes = 0; for (const n of names) { try { bytes += (await fs.promises.stat(path.join(modelDir(), n))).size; } catch (_) {} } return { files: names.length, bytes, dir: modelDir() }; } catch (_) { return { files: 0, bytes: 0, dir: modelDir() }; } });
ipcMain.handle('quest:write', (_e, patch) => guardStore().writeQuest(identity, patch));
ipcMain.handle('song:restore', async (_e, id) => { const r = await guardStore().restoreSong(id); snapshotSongs().catch(() => {}); return r; });
ipcMain.handle('song:peek', async (_e, folder) => { const s = guardStore(); const r = await s.loadSong(folder); return { song: r.song }; });
ipcMain.handle('song:reload', async (_e, folder) => {
  const s = guardStore();
  const r = await s.loadSong(folder);
  if (open && open.folder === folder) { open.lastMtime = r.mtimeMs; open.lastSaveId = r.song.saveId || null; }
  return { ...r, bounces: await s.listBounces(folder), unreferenced: await s.unreferencedTakes(folder) };
});
ipcMain.handle('song:save', (_e, folder, song, opts) => doSave(folder, song, opts));
ipcMain.handle('song:takeOver', (_e, folder) => { guardStore(); return takeOverLock(folder); });
ipcMain.handle('song:unreferenced', (_e, folder, ids) => guardStore().unreferencedTakes(folder, ids));
// Lighten Drive: one song, or every song when folder is null. opts: {dryRun, olderThanDays, convert, purge}
async function compactAudio(folder, opts = {}) {
  const s = guardStore(); const folders = folder ? [folder] : (await s.listSongs(identity)).map((x) => x.folder || x.name);
  const res = { songs: [], converted: 0, removed: 0, before: 0, after: 0 };
  // the open song's takes count as used even before they're saved (a just-restored take, a dirty edit)
  let openRefs = null; try { openRefs = await askRenderer('openRefs', {}, 10000); } catch (_) { openRefs = null; }
  if (opts.purge !== false && open && !openRefs) opts = { ...opts, purge: false };   // can't see the open song: remove nothing
  for (const f of folders) {
    let r; try { r = await s.compactAudio(f, { ...opts, extraRefs: openRefs && openRefs.folder === f ? openRefs.ids : null, onProgress: (p) => send('audio:compactProgress', { song: f, ...p }) }); } catch (err) { res.songs.push({ folder: f, error: err.message }); continue; }
    res.songs.push({ folder: f, purgeSkipped: r.purgeSkipped || null, converted: r.converted, removed: r.removed.length, before: r.before, after: r.after, removedFiles: r.removed.map((x) => x.file) });
    res.converted += r.converted; res.removed += r.removed.length; res.before += r.before; res.after += r.after;
  }
  if (!opts.dryRun) setTimeout(snapshotSongs, 200);
  return res;
}
ipcMain.handle('audio:purge', (_e, folder, ids) => tracked(() => guardStore().purgeAudio(folder, ids || [])));
ipcMain.handle('audio:compact', (_e, folder, opts) => tracked(() => compactAudio(folder || null, opts || {})));
ipcMain.handle('audio:write', (_e, folder, clipId, arrayBuffer, opts) => tracked(() => guardStore().writeAudio(folder, clipId, Buffer.from(arrayBuffer), opts || {})));
ipcMain.handle('audio:rename', (_e, folder, clipId, label) => tracked(() => guardStore().renameAudio(folder, clipId, label)));
ipcMain.handle('audio:path', (_e, folder, clipId) => guardStore().findAudio(folder, clipId));
// Crash-safe recording: while a take records, its raw input streams to the user's app data every second, so a crash,
// power cut or force-quit loses at most a second. Cleared once the take is safely in the shared folder.
const REC_DIR = () => path.join(app.getPath('userData'), 'recording');
const recFile = (id, ext) => { if (!/^[a-f0-9]{12}$/.test(String(id))) throw new Error('bad recording id'); return path.join(REC_DIR(), `${id}.${ext}`); };
ipcMain.handle('rec:begin', async (_e, id, meta) => { await fsp.mkdir(REC_DIR(), { recursive: true }); await atomicWrite(recFile(id, 'json'), JSON.stringify({ ...meta, id })); return true; });
ipcMain.handle('rec:append', async (_e, id, chans) => { for (let c = 0; c < (chans || []).length; c++) { const a = chans[c]; await fsp.appendFile(recFile(id, `ch${c}.f32`), Buffer.from(a.buffer, a.byteOffset, a.byteLength)); } return true; });
ipcMain.handle('rec:end', async (_e, id) => { let names = []; try { names = await fsp.readdir(REC_DIR()); } catch (_) {} for (const n of names) if (n.startsWith(`${id}.`)) await fsp.unlink(path.join(REC_DIR(), n)).catch(() => {}); return true; });
ipcMain.handle('rec:list', async () => {
  let names = []; try { names = await fsp.readdir(REC_DIR()); } catch (_) { return []; }
  const out = [];
  for (const n of names.filter((x) => /^[a-f0-9]{12}\.json$/.test(x))) {
    try { const m = JSON.parse(await fsp.readFile(path.join(REC_DIR(), n), 'utf8')); let bytes = 0; try { bytes = (await fsp.stat(recFile(m.id, 'ch0.f32'))).size; } catch (_) {} m.seconds = bytes / 4 / (m.sampleRate || 48000); out.push(m); } catch (_) {}
  }
  return out;
});
ipcMain.handle('rec:read', async (_e, id) => {
  const meta = JSON.parse(await fsp.readFile(recFile(id, 'json'), 'utf8')); const channels = [];
  for (let c = 0; c < 8; c++) { let b; try { b = await fsp.readFile(recFile(id, `ch${c}.f32`)); } catch (_) { break; } channels.push(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4))); }
  return { meta, channels };
});
ipcMain.handle('song:backup', (_e, folder, song, takes) => writeBackup(folder, song, takes || []));
ipcMain.handle('mail:post', (_e, folder, op) => store.postMail(folder, identity, op));
ipcMain.handle('mail:read', (_e, folder) => store.readMail(folder));
ipcMain.handle('mail:remove', (_e, folder, file) => store.removeMail(folder, file));
ipcMain.handle('tlock:list', (_e, folder) => guardStore().readTrackLocks(folder));
ipcMain.handle('tlock:claim', (_e, folder, trackId, opts) => guardStore().claimTrackLock(folder, trackId, identity, opts || {}));
ipcMain.handle('tlock:touch', (_e, folder, trackId) => guardStore().touchTrackLock(folder, trackId, identity));
ipcMain.handle('tlock:release', (_e, folder, trackId) => guardStore().releaseTrackLock(folder, trackId, identity));
ipcMain.handle('tracks:post', (_e, folder, trackId, payload) => guardStore().postTrack(folder, identity, trackId, payload));
ipcMain.handle('tracks:read', (_e, folder) => guardStore().readTracks(folder));
ipcMain.handle('tracks:remove', (_e, folder, file, id) => guardStore().removeTrackPost(folder, file, id));
ipcMain.handle('me:identity', () => identity);
ipcMain.handle('song:readBackup', (_e, folder) => readBackup(folder));
ipcMain.handle('song:clearBackup', (_e, folder) => clearBackup(folder));
ipcMain.handle('audio:read', async (_e, folder, clipId) => {
  const buf = await guardStore().readAudio(folder, clipId);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle('audio:readFile', async (_e, p) => {
  const st = await fsp.stat(p);
  if (st.size > 300e6) throw new Error('file is larger than 300 MB; trim it first');
  const buf = await fsp.readFile(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});
ipcMain.handle('bounce:write', (_e, folder, baseName, arrayBuffer, opts) => tracked(() => guardStore().writeBounce(folder, baseName, Buffer.from(arrayBuffer), opts || {})));
ipcMain.handle('bounce:stamp', () => localStamp());
ipcMain.handle('export:write', (_e, folder, name, files) => tracked(() => guardStore().writeExport(folder, name, (files || []).map((f) => (f.data instanceof ArrayBuffer || ArrayBuffer.isView(f.data) ? { ...f, data: Buffer.from(f.data.buffer || f.data) } : f)))));
ipcMain.handle('bounce:list', (_e, folder) => guardStore().listBounces(folder));
ipcMain.handle('shell:showInFolder', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('shell:links', () => LINKS);
ipcMain.handle('shell:openLink', (_e, which) => { const u = which === 'issues' && LINKS.repo ? `${LINKS.repo}/issues` : which === 'releases' && LINKS.repo ? `${LINKS.repo}/releases` : LINKS[which]; if (!u) throw new Error(`no link for ${which}`); return shell.openExternal(u); });
ipcMain.handle('shell:openSongFolder', (_e, folder) => shell.openPath(guardStore().songDir(folder)));
ipcMain.handle('mic:ensure', async () => {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status !== 'granted') return systemPreferences.askForMediaAccess('microphone');
  }
  return true;
});

// ---------- renderer relay (for the control API and quit-time save) ----------
const pending = new Map();
let rendererReady = null;      // resolves once the renderer has registered its request handler
let markRendererReady = () => {};
function resetRendererReady() { rendererReady = new Promise((r) => { markRendererReady = r; }); }
resetRendererReady();
ipcMain.on('renderer:ready', () => markRendererReady());
async function askRenderer(op, args, timeoutMs = 60000) {
  if (!win || win.isDestroyed()) throw new Error('app window is not open');
  const ready = await Promise.race([rendererReady.then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
  if (!ready) throw new Error('app window is still loading');
  if (!win || win.isDestroyed()) throw new Error('app window is not open');
  const id = crypto.randomBytes(8).toString('hex');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`renderer timed out on ${op}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, t });
    win.webContents.send('api:request', { id, op, args });
  });
}
ipcMain.on('api:response', (_e, { id, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.t); pending.delete(id);
  if (error) p.reject(new Error(error)); else p.resolve(result);
});

async function startApi() {
  if (apiServer) { apiServer.close(); apiServer = null; }
  const dbg = (fn) => async (ctx) => { if (!process.env.BP_DEBUG) throw new Error('debug disabled'); return fn(ctx); };
  const handlers = {
    'GET /state': async () => ({
      settings: { sharedFolder: settings.sharedFolder, displayName: settings.displayName, apiPort: settings.apiPort, driveLike: looksLikeDrivePath(settings.sharedFolder), cloud: cloudProvider(settings.sharedFolder) },
      identity,
      open: open ? { folder: open.folder, lock: open.lock, readOnly: !open.lock } : null,
      ...(await askRenderer('state', {})),
    }),
    'GET /songs': () => guardStore().listSongs(identity, { lastSeen: seenMap() }),
    'POST /song/open': ({ body }) => askRenderer('openSong', body),
    'POST /song/close': () => askRenderer('closeSong', {}),
    'POST /song/create': ({ body }) => askRenderer('createSong', body),
    'POST /song/save': ({ body }) => askRenderer('save', body),
    'POST /song/reload': () => askRenderer('reload', {}),
    'POST /song/takeover': () => askRenderer('takeOver', {}),
    'POST /song/snapshot': ({ body }) => askRenderer('snapshot', body),
    'POST /song/restore': ({ body }) => askRenderer('restore', body),
    'GET /song/snapshots': () => askRenderer('snapshots', {}),
    'POST /mix': ({ body }) => askRenderer('mix', body),
    'POST /song/patch': ({ body }) => askRenderer('patchSong', body),
    'POST /transport': ({ body }) => askRenderer('transport', body),
    'GET /meters': () => askRenderer('meters', {}),
    'GET /analyze': ({ query }) => askRenderer('analyze', query, 180000),
    'POST /export': ({ body }) => askRenderer('exportDaw', body, 600000),
    'POST /clip/split': ({ body }) => askRenderer('splitClip', body),
    'POST /clip/duplicate': ({ body }) => askRenderer('duplicateClip', body),
    'POST /bounce': ({ body }) => askRenderer('bounce', body, 1800000),
    'POST /clip/import': ({ body }) => askRenderer('importClip', body, 1800000),
    'GET /takes/unreferenced': () => askRenderer('unreferenced', {}),
    'POST /takes/relabel': () => askRenderer('relabelTakes', {}, 120000),
    'GET /presets': ({ query }) => askRenderer('presets', query),
    'POST /track/preset': ({ body }) => askRenderer('applyPreset', body),
    'POST /drums': ({ body }) => askRenderer('drums', body),
    'POST /midi/notes': ({ body }) => askRenderer('midiNotes', body),
    'POST /midi/quantize': ({ body }) => askRenderer('quantize', body),
    'POST /note': ({ body }) => askRenderer('playNote', body),
    'GET /midi/inputs': ({ query }) => askRenderer('midiInputs', query),
    'POST /midi/inputs': ({ body }) => askRenderer('midiInputs', body),
    'POST /clip/attach': ({ body }) => askRenderer('attachTake', body, 120000),
    'GET /collab': () => askRenderer('collab', {}),
    'GET /quest': () => askRenderer('quest', {}),
    'GET /audio': () => askRenderer('audioSettings', {}),
    'GET /changes': ({ query }) => askRenderer('changes', query || {}, 60000),
    'POST /part/share': ({ body }) => askRenderer('sharePart', body || {}, 600000),
    'POST /comp': ({ body }) => askRenderer('comp', body || {}),
    'POST /workspace': ({ body }) => askRenderer('workspace', body || {}),
    'POST /chords/detect': ({ body }) => askRenderer('chordsDetect', body || {}, 600000),
    'POST /mix/auto': () => askRenderer('autoMix', {}, 900000),
    'POST /master/auto': ({ body }) => askRenderer('autoMaster', body || {}, 600000),
    'POST /mix/ab': () => askRenderer('mixAB', {}),
    'POST /clip/tighten': ({ body }) => askRenderer('tighten', body || {}, 600000),
    'POST /pitch/check': ({ body }) => askRenderer('pitchCheck', body || {}, 600000),
    'POST /practice': ({ body }) => askRenderer('practice', body || {}, 120000),
    'GET /phone': () => Phone.info(),
    'POST /audio/compact': ({ body }) => tracked(() => compactAudio((body && body.folder) || null, body || {})),
    'POST /lyrics/transcribe': ({ body }) => askRenderer('transcribe', body || {}, 900000),
    'POST /audio': ({ body }) => askRenderer('audioSettings', body || {}),
    'POST /latency/measure': ({ body }) => askRenderer('measureLatency', body || {}),
    'POST /update': async ({ body }) => { if (!updater) throw new Error('updater not running'); if (body && body.install) { updater.install(); return { installing: true }; } return updater.check({ force: true }); },
    'POST /quest': ({ body }) => askRenderer('questSet', body || {}),
    'POST /chart/all': () => askRenderer('chartAll', {}),
    'POST /sections': ({ body }) => askRenderer('sections', body),
    'POST /chords': ({ body }) => askRenderer('chords', body),
    'POST /lyrics': ({ body }) => askRenderer('lyrics', body),
    'POST /needs': ({ body }) => askRenderer('needs', body),
    'POST /note/reply': ({ body }) => askRenderer('noteReply', body),
    'POST /note/resolve': ({ body }) => askRenderer('noteResolve', body),
    'POST /vote': ({ body }) => askRenderer('vote', body),
    'POST /idea': ({ body }) => askRenderer('idea', body, 300000),
    'POST /version': ({ body }) => askRenderer('version', body, 120000),
    'GET /versions': () => askRenderer('versions', {}),
    'GET /history': () => askRenderer('history', {}),
    'POST /rollback': ({ body }) => askRenderer('rollback', body, 120000),
    'GET /templates': () => askRenderer('templates', {}),
    'GET /arrangements': () => askRenderer('arrangements', {}),
    'POST /link': ({ body }) => askRenderer('link', body),
    'POST /section/unlink': ({ body }) => askRenderer('unlinkSection', body),
    'POST /room': ({ body }) => askRenderer('room', body),
    'POST /restructure': ({ body }) => askRenderer('restructure', body, 60000),
    'POST /tempo': ({ body }) => askRenderer('tempo', body, 300000),
    'POST /template': ({ body }) => askRenderer('saveTemplate', body),
    'GET /parts': () => askRenderer('parts', {}),
    'POST /melody': ({ body }) => askRenderer('melody', body, 60000),
    'POST /drum-part': ({ body }) => askRenderer('drumPart', body, 60000),
    'POST /song/transpose': ({ body }) => askRenderer('transpose', body, 600000),
    'POST /song/key/detect': ({ body }) => askRenderer('detectKey', body, 120000),
    'POST /part/key': ({ body }) => askRenderer('partKey', body, 120000),
    'POST /part/tags': ({ body }) => askRenderer('partTags', body),
    'GET /chart': ({ query }) => askRenderer('chart', query || {}),
    'POST /part': ({ body }) => askRenderer('savePart', body, 120000),
    'POST /part/drop': ({ body }) => askRenderer('dropPart', body, 600000),
    'POST /debug/screenshot': dbg(async ({ body }) => { const img = await win.capturePage(); await fsp.writeFile(body.file, img.toPNG()); return { file: body.file }; }),
    'POST /debug/eval': dbg(async ({ body }) => ({ result: await win.webContents.executeJavaScript(body.js, true) })),
    'GET /doc': async () => ({ markdown: await fsp.readFile(path.join(__dirname, 'AI.md'), 'utf8') }),
  };
  apiHandlers = handlers;
  startInbox();
  try {
    apiServer = await controlApi.start({ port: settings.apiPort, token: settings.apiToken, handlers, log: console.error });
    apiStartError = null;
  } catch (err) {
    apiStartError = `Control API could not start on port ${settings.apiPort}: ${err.message}`;
  }
}
// ---- phone page (practice from your phone on the home network) ----
const Phone = require('./phone');
ipcMain.handle('phone:start', async () => {
  if (!settings.phoneKey) { settings.phoneKey = crypto.randomBytes(6).toString('hex'); await saveSettings(); }
  try { return await Phone.start({ port: settings.phonePort || 47811, key: settings.phoneKey, ask: (op, args) => askRenderer(op, args, 8000) }); }
  catch (err) { if (err.code === 'EADDRINUSE') throw new Error(`Port ${settings.phonePort || 47811} is busy — another app is using it.`); throw err; }
});
ipcMain.handle('phone:stop', () => { Phone.stop(); return { on: false }; });
ipcMain.handle('phone:info', () => Phone.info());
ipcMain.handle('phone:newKey', async () => { settings.phoneKey = crypto.randomBytes(6).toString('hex'); await saveSettings(); if (Phone.info().on) return Phone.start({ port: settings.phonePort || 47811, key: settings.phoneKey, ask: (op, args) => askRenderer(op, args, 8000) }); return { on: false }; });
ipcMain.handle('api:info', () => ({ port: settings.apiPort, token: settings.apiToken, settingsFile: SETTINGS_FILE(), running: !!apiServer, error: apiStartError, inbox: inboxDir() }));

// ---------- file-drop inbox: same API, driven by JSON files ----------
// Anyone who can write to this folder is already the local user, so no token is needed.
// Request:  <inbox>/<name>.json  = {"method":"POST","path":"/mix","body":{...}}  (or an array of them, run in order)
// Response: <inbox>/<name>.result.json = {"ok":true,"status":200,"result":...} per request; request file renamed to <name>.done
const inboxDir = () => settings.apiInbox || path.join(app.getPath('userData'), 'inbox');
let inboxWatcher = null, inboxPoll = null, inboxBusy = false;
function startInbox() {
  stopInbox();
  const dir = inboxDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { console.error('inbox mkdir failed', err.message); return; }
  try { inboxWatcher = fs.watch(dir, () => { clearTimeout(inboxWatcher._t); inboxWatcher._t = setTimeout(processInbox, 300); }); inboxWatcher.on('error', () => {}); } catch (_) {}
  inboxPoll = setInterval(processInbox, 2000);
  processInbox();
}
function stopInbox() { if (inboxWatcher) { try { inboxWatcher.close(); } catch (_) {} inboxWatcher = null; } if (inboxPoll) { clearInterval(inboxPoll); inboxPoll = null; } }
async function processInbox() {
  if (inboxBusy || !apiHandlers) return;
  inboxBusy = true;
  try {
    const dir = inboxDir();
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json') && !n.endsWith('.result.json')).sort();
    for (const n of names) {
      const file = path.join(dir, n);
      let reqs;
      try {
        const txt = await fsp.readFile(file, 'utf8');
        if (!txt.trim()) continue;                  // still being written
        reqs = JSON.parse(txt);
      } catch (_) { continue; }                     // partial write; try next tick
      const list = Array.isArray(reqs) ? reqs : [reqs];
      const out = [];
      for (const r of list) {
        const key = `${String(r.method || 'GET').toUpperCase()} ${r.path || ''}`;
        const h = apiHandlers[key];
        if (!h) { out.push({ ok: false, status: 404, error: `no route ${key}` }); continue; }
        try { const res = await h({ body: r.body || {}, query: r.query || {} }); out.push({ ok: true, status: 200, result: res === undefined ? { ok: true } : res }); }
        catch (err) { out.push({ ok: false, status: err.status || 500, error: err.message }); if (r.stopOnError !== false) { out.push({ skipped: list.length - out.length }); break; } }
      }
      const base = n.replace(/\.json$/, '');
      await fsp.writeFile(path.join(dir, `${base}.result.json`), JSON.stringify(Array.isArray(reqs) ? out : out[0], null, 2));
      await fsp.rename(file, path.join(dir, `${base}.done`)).catch(() => {});
    }
  } catch (err) { console.error('inbox error', err.message); }
  finally { inboxBusy = false; }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: 'Cobander',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  // Dropping a file outside a track lane must never navigate the window away from the app.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Text fields get the usual right-click Cut / Copy / Paste (Electron has no default text menu).
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !(p.selectionText && p.selectionText.trim())) return;
    const f = p.editFlags || {};
    const items = p.isEditable
      ? [{ role: 'undo', enabled: !!f.canUndo }, { role: 'redo', enabled: !!f.canRedo }, { type: 'separator' }, { role: 'cut', enabled: !!f.canCut }, { role: 'copy', enabled: !!f.canCopy }, { role: 'paste', enabled: !!f.canPaste }, { type: 'separator' }, { role: 'selectAll' }]
      : [{ role: 'copy' }];
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  // The window's renderer can die (out of memory on a huge import, GPU crash, killed): bring the window back instead of
  // leaving a blank window whose heartbeat keeps the song locked forever. Give up after 3 crashes in 5 minutes.
  const crashes = [];
  if (process.env.BANDPAD_E2E || process.env.BP_CONSOLE) win.webContents.on('console-message', (e, level, message, line, source) => { const lv = e.level ?? level; const msg = e.message ?? message; if (lv === 'error' || lv === 'warning' || lv >= 2) console.log(`renderer[${lv}] ${msg} (${String(e.sourceId ?? source).split('/').pop()}:${e.lineNumber ?? line})`); });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('renderer gone:', d && d.reason, d && d.exitCode);
    if (closing || quitting || !win || win.isDestroyed() || (d && d.reason === 'clean-exit')) return;
    const now = Date.now(); while (crashes.length && now - crashes[0] > 300000) crashes.shift(); crashes.push(now);
    if (crashes.length > 3) { try { require('electron').dialog.showErrorBox('Cobander', 'Cobander keeps crashing. Close it and open it again; your saved work is safe on the shared folder.'); } catch (_) {} return; }
    setTimeout(() => { try { if (win && !win.isDestroyed()) win.webContents.reload(); } catch (_) {} }, 800);
    setTimeout(() => { try { if (win && !win.isDestroyed()) require('electron').dialog.showMessageBox(win, { type: 'warning', message: 'Cobander had to restart its window', detail: `${d && d.reason === 'oom' ? 'It ran out of memory (a very long take or file?). ' : ''}Anything saved is safe. Changes from the last few seconds may need redoing.` }); } catch (_) {} }, 2500);
  });
  resetRendererReady();
  win.webContents.on('did-start-loading', () => resetRendererReady());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (closing || quitting) return;
    e.preventDefault();
    closing = true;
    flushAndQuit();
  });
  win.on('closed', () => { win = null; });
}
let closing = false;
async function flushAndQuit() {
  stopWatching(); stopInbox();
  if (apiServer) apiServer.close();
  try { await askRenderer('saveForQuit', {}, 60000); } catch (err) { console.error('saveForQuit failed:', err.message); }
  const until = Date.now() + 60000;
  while (inFlightWrites > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  await Promise.race([closeOpenSong(), new Promise((r) => setTimeout(r, 12000))]);
  quitting = true;
  app.quit();
}

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');   // multi-threaded speech-to-text (WASM threads) without cross-origin isolation
app.whenReady().then(() => {
  loadSettings();
  powerMonitor.on('resume', () => noteWake('resume'));
  powerMonitor.on('unlock-screen', () => noteWake('unlock'));
  updater = new Updater({ currentVersion: app.getVersion(), sharedFolder: () => settings.sharedFolder, repo: REPO, fetch: (u, o) => require('electron').net.fetch(u, o), notify: (st) => send('update:status', st), quit: () => { app.quit(); setTimeout(() => app.exit(0), 100000).unref(); } });   /* the installer helper waits for this process; never leave it waiting forever */
  const tmpl = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, ...(process.env.BP_DEBUG ? [{ role: 'toggleDevTools' }] : [])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl));
  if (settings.sharedFolder) setSharedFolder(settings.sharedFolder);
  createWindow();
  startApi();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  if (closing) return;
  closing = true;
  flushAndQuit();
});
app.on('window-all-closed', () => { if (!closing) { closing = true; flushAndQuit(); } });
