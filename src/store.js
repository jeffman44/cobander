'use strict';
// Shared-folder project store. Pure Node, no Electron, so it can be unit-tested.
//
// Layout inside the shared (Drive for Desktop) folder:
//   <Shared>/<Song Name>/song.json          project metadata (tracks, clips, tempo, notes)
//   <Shared>/<Song Name>/audio/<label> - <clipId>.wav   immutable audio files, one per take (label is
//                                            "<track> - <take> - <who>" for humans; the 12-hex id is the key)
//   <Shared>/<Song Name>/bounces/*.wav      mixdowns / stems
//   <Shared>/<Song Name>/_lock.json         soft lock: who has the song open
//
// Rules that keep Drive sync from eating data:
//   * every write is atomic: write to a temp file in the same folder, then rename
//   * audio files are written once and never modified (new take = new file)
//   * song.json carries rev + a random saveId so a collision is detectable
//   * lock is a heartbeat file; staleness is judged by *observation* (has the file
//     stopped changing from our point of view), never by comparing two machines' clocks

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Quest = require('./renderer/quest.js');
const Collab = require('./renderer/collab');
const FlacNode = require('./flac-node');

const SONG_FILE = 'song.json';
const LOCK_FILE = '_lock.json';
const AUDIO_DIR = 'audio';
const BOUNCE_DIR = 'bounces';
const VERSION_DIR = 'versions';
const HISTORY_DIR = 'history';
const TEMPLATE_DIR = '_templates';
const TRASH_DIR = '_deleted';
const QUEST_DIR = '_quest';         // <Shared>/_quest/<who>.json — the quest board: each bandmate writes only their own file        // <Shared>/_deleted/<song> — deleted songs (restorable from the app; empty it by hand in Drive)
const PARTS_DIR = '_parts';          // <Shared>/_parts/<id>.json + _parts/audio/<audioId>.wav — the band's parts bin (riffs, sections) to drop into any song   // <Shared>/_templates/<id>.json — band song templates (structure, tempo, track setups; no audio)
const HISTORY_KEEP = 500;   // every save is kept as <song>/history/rev-<rev>-<saveId>.json; oldest pruned past this
const PRESENCE_DIR = '_presence';
const MAILBOX_DIR = '_mailbox';
const TRACKLOCK_DIR = '_tracklocks';   // one file per claimed track: {user, host, token, at} — "at" moves with every edit
const TRACKS_DIR = '_tracks';          // a track-lock holder's latest version of their track(s), until the song editor folds it into song.json
const TRACK_LOCK_IDLE_MS = 10 * 60 * 1000;   // a track nobody has touched for 10 min unlocks itself   // notes / replies / needs / reactions from bandmates who are read-only; the editor merges them in
const PRESENCE_STALE_MS = 70 * 1000;   // presence file unchanged (from our view) for 70 s = that person closed the song
const FORMAT_VERSION = 1;
const LOCK_STALE_MS = 90 * 1000;        // lock file unchanged (from our view) for 90 s = holder gone
const LOCK_ANCIENT_MS = 12 * 3600 * 1000; // holder clock says >12 h old: stale regardless (bounded skew)
const HEARTBEAT_MS = 20 * 1000;

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function num(x, dflt) { const n = Number(x); return Number.isFinite(n) ? n : dflt; }

// Is lock `a` a later takeover than lock `b`? Locks carry a generation counter (previous gen + 1 on every
// acquire), so this never compares two machines' clocks. Locks from pre-0.4 clients have no gen: fall back to `since`.
function lockNewer(a, b) {
  if (!a || !b) return false;
  if (Number.isFinite(a.lockGen) && Number.isFinite(b.lockGen)) return a.lockGen > b.lockGen;
  return Number(a.since) > Number(b.since);   // a pre-0.4 client on either side: the old rule (and token mismatch = lost after 2 misses)
}

// Drive, macOS and Windows disagree on what a legal folder name is; be conservative.
function safeSongName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[. ]+$/g, '')
    .replace(/^[._ ]+/g, '')   // a leading dot hides the folder (listSongs skips it); a leading _ collides with _templates/_parts
    .trim();
  if (!cleaned) throw new Error('Song name is empty after removing illegal characters');
  if (cleaned.length > 120) throw new Error('Song name is too long (120 characters max)');
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reserved.test(cleaned)) throw new Error(`"${cleaned}" is a reserved name on Windows`);
  return cleaned;
}

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${newId()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

// machineName: remembered once in settings, because macOS changes os.hostname() with the network (.local/.lan/DHCP names)
// and a changed name would make my own leftover lock look like someone else's.
function clientIdentity(displayName, machineName = null) {
  return {
    user: (displayName || os.userInfo().username || 'someone').trim(),
    host: machineName || os.hostname(),
    pid: process.pid,
  };
}

function emptySong(name) {
  return {
    format: FORMAT_VERSION,
    name,
    id: newId(),
    rev: 0,
    saveId: null,
    savedBy: null,
    savedAt: null,
    bpm: 120,
    timeSig: [4, 4],
    sampleRate: 48000,
    notes: '',
    loop: { enabled: false, start: 0, end: 8 },
    tracks: [],
  };
}

// "<label> - <id>.flac" (0.13+) or ".wav" ⇄ {label, id, ext}. Bare "<id>.wav" (older versions) still parses.
function parseTakeName(n) {
  const m = /^(?:(.*) - )?([a-f0-9]{12})\.(wav|flac)$/i.exec(String(n));
  return m ? { label: m[1] || '', id: m[2].toLowerCase(), ext: m[3].toLowerCase() } : null;
}
function safeLabel(label) {
  return String(label || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80);
}
function takeFileName(label, clipId, ext = 'wav') {
  const l = safeLabel(label);
  return l ? `${l} - ${clipId}.${ext}` : `${clipId}.${ext}`;
}
const audioExt = (buf) => (FlacNode.isFlac(buf) ? 'flac' : 'wav');
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Looks like a Google Drive for Desktop path? (soft check, used only for a warning)
// Which cloud-sync folder the band folder sits in. Cobander only needs a folder every bandmate's computer syncs;
// the provider matters for wording and for the ways each one parks files it hasn't downloaded yet.
const CLOUDS = [
  ['gdrive', 'Google Drive', /GoogleDrive|Google Drive|My Drive|Shared drives|CloudStorage[\\/]GoogleDrive/i],
  ['onedrive', 'OneDrive', /OneDrive/i],
  ['icloud', 'iCloud Drive', /com~apple~CloudDocs|iCloud ?Drive|Mobile Documents/i],
  ['dropbox', 'Dropbox', /Dropbox/i],
  ['box', 'Box', /[\\/]Box[\\/]|CloudStorage[\\/]Box/i],
];
function cloudProvider(p) {
  const s = String(p || ''); if (!s) return null;
  for (const [id, name, re] of CLOUDS) if (re.test(s)) return { id, name };
  return null;
}
function looksLikeDrivePath(p) { return !!cloudProvider(p); }
// iCloud Drive evicts files it thinks you don't need and leaves `.<name>.icloud` stubs; `brctl download` asks for the
// real file back. OneDrive (Files On-Demand) and Dropbox (online-only) fetch a file the moment it is opened, so a
// plain read is enough there — it is just slow the first time.
function icloudStubFor(dir, name) { return path.join(dir, `.${name}.icloud`); }
async function hydrateDir(dir, names = null) {
  if (process.platform !== 'darwin') return [];
  let list = names; if (!list) { try { list = await fsp.readdir(dir); } catch (_) { return []; } }
  const stubs = list.filter((n) => /^\..+\.icloud$/.test(n)).map((n) => n.slice(1, -'.icloud'.length));
  if (!stubs.length) return [];
  try { const { spawn } = require('child_process'); const c = spawn('brctl', ['download', ...stubs.map((n) => path.join(dir, n))], { stdio: 'ignore', detached: true }); c.on('error', () => {}); c.unref(); } catch (_) {}
  return stubs;
}

class SongStore {
  constructor(sharedRoot, { flac = true } = {}) {
    if (!sharedRoot) throw new Error('shared folder path required');
    this.root = path.resolve(sharedRoot);
    this.flac = flac;   // store new takes as FLAC (lossless, ~half the Drive space of WAV)
    this.seen = new Map(); // folder -> { token, heartbeat, firstSeenAt } for observation-based staleness
  }

  // Every method that takes a folder goes through here: the folder must be a plain
  // song-folder name (no separators, no traversal) that resolves inside the root.
  songDir(folder) {
    const f = String(folder || '');
    let safe;
    try { safe = safeSongName(f); } catch (err) { throw new Error(`Bad song folder "${f}": ${err.message}`); }
    if (safe !== f) throw new Error(`Bad song folder "${f}"`);
    const dir = path.resolve(this.root, f);
    if (path.dirname(dir) !== this.root) throw new Error(`Bad song folder "${f}"`);
    return dir;
  }

  async listSongs(identity = null, { lastSeen = {} } = {}) {
    let entries;
    try {
      entries = await fsp.readdir(this.root, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const songs = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === TEMPLATE_DIR || e.name === PARTS_DIR || e.name === TRASH_DIR || e.name === QUEST_DIR) continue;
      let dir;
      try { dir = this.songDir(e.name); } catch (_) { continue; }
      const songPath = path.join(dir, SONG_FILE);
      try {
        if (process.platform === 'darwin' && !fs.existsSync(songPath) && fs.existsSync(icloudStubFor(dir, SONG_FILE))) { hydrateDir(dir).catch(() => {}); continue; }   // iCloud evicted it: ask for it back, it lists next time
        const raw = JSON.parse(await fsp.readFile(songPath, 'utf8'));
        const st = await fsp.stat(songPath);
        const lock = await this.readLock(e.name);
        const presence = await this.readPresence(e.name).catch(() => []);
        const people = Collab.knownPeople(raw, identity ? [identity.user] : []);
        songs.push({
          folder: e.name,
          name: raw.name || e.name,
          rev: num(raw.rev, 0),
          saveId: raw.saveId || null,
          savedBy: raw.savedBy,
          savedAt: raw.savedAt,
          mtimeMs: st.mtimeMs,
          tracks: Array.isArray(raw.tracks) ? raw.tracks.length : 0,
          lock,
          lockMine: identity ? this.isMine(lock, identity) : false,
          lockSameMachine: identity ? this.isSameMachine(lock, identity) : false,
          conflictCopies: await this.conflictCopies(e.name),
          needsOpen: Collab.needsOpen(raw).length,
          needsMine: identity ? Collab.needsFor(raw, identity.user, people).length : 0,
          stage: typeof raw.stage === 'string' ? raw.stage.slice(0, 20) : null,
          quest: Quest.songStats(raw),   // the game layer: who did what in this song (takes, notes, chords …) and how much of it each member's takes cover
          bounced: await fsp.readdir(path.join(dir, BOUNCE_DIR)).then((n) => n.some((x) => /\.wav$/i.test(x)), () => false),
          recent: (Array.isArray(raw.activity) ? raw.activity.slice(-15) : []).filter((a) => a && a.at).map((a) => ({ by: String(a.by || '').slice(0, 40), at: a.at, items: (a.items || []).slice(0, 6).map((x) => String(x).slice(0, 120)) })),
          needsDone: Collab.live(raw.needs || []).filter((n) => n.done).length,
          needs: Collab.needsOpen(raw).slice(0, 8).map((n) => n.text),
          mentions: identity ? Collab.mentionsFor(raw, identity.user, { since: lastSeen[e.name] || null, knownNames: people }).length : 0,
          presence: presence.filter((p) => !p.stale && !(identity && p.user === identity.user && p.host === identity.host && p.pid === identity.pid)).map((p) => ({ user: p.user, host: p.host, mode: p.mode, playing: !!p.playing })),
        });
      } catch (err) {
        // not a song folder, half-synced, or Drive can't hand the file over right now (EBUSY/EPERM on Windows,
        // EDEADLK/ETIMEDOUT/EIO for an online-only file on macOS): skip this one folder, never empty the whole list
        if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) this.lastListErrors = { ...(this.lastListErrors || {}), [e.name]: err.code || err.message };
      }
    }
    songs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return songs;
  }

  // Drive writes "song (1).json" when two machines collide; make that visible.
  // Lock-file conflict copies are harmless noise from normal lock races: delete them.
  // Delete = move the whole folder to _deleted (Drive syncs that as a move: nobody loses anything, Restore puts it back).
  // Refused while someone else has it open (their lock or presence) — they'd be writing into a folder that moved.
  async trashSong(folder, identity, now = Date.now()) {
    const dir = this.songDir(folder);
    const lock = await this.readLock(folder, now);
    if (lock && !(identity && this.isMine(lock, identity))) throw new Error(`${lock.user} has "${folder}" open — they need to close it first.`);
    const others = (await this.readPresence(folder, now).catch(() => [])).filter((p) => !p.stale && !(identity && p.user === identity.user && p.host === identity.host && p.pid === identity.pid));
    if (others.length) throw new Error(`${[...new Set(others.map((p) => p.user))].join(', ')} ${others.length > 1 ? 'have' : 'has'} "${folder}" open — they need to close it first.`);
    const tdir = path.join(this.root, TRASH_DIR); await fsp.mkdir(tdir, { recursive: true });
    const by = identity ? identity.user : '?';
    let name = safeLabel(`${folder} - deleted ${localStamp(new Date(now))} by ${by}`); let k = 2;
    while (await fsp.stat(path.join(tdir, name)).then(() => true, () => false)) name = safeLabel(`${folder} - deleted ${localStamp(new Date(now))} (${k++})`);
    const dest = path.join(tdir, name);
    try { await fsp.rename(dir, dest); } catch (err) {
      if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await fsp.cp(dir, dest, { recursive: true }); await fsp.rm(dir, { recursive: true, force: true });   // Drive / Windows refused the move: copy, then remove
    }
    await atomicWrite(path.join(dest, '_deleted.json'), JSON.stringify({ folder, by, at: new Date(now).toISOString() }, null, 2)).catch(() => {});
    return { trashed: name };
  }
  async listTrashedSongs() {
    const tdir = path.join(this.root, TRASH_DIR); let entries;
    try { entries = await fsp.readdir(tdir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      let meta = {}; try { meta = JSON.parse(await fsp.readFile(path.join(tdir, e.name, '_deleted.json'), 'utf8')); } catch (_) {}
      let songName = null; try { songName = JSON.parse(await fsp.readFile(path.join(tdir, e.name, SONG_FILE), 'utf8')).name || null; } catch (_) {}
      out.push({ id: e.name, folder: meta.folder || e.name.replace(/ - deleted .*$/, ''), name: songName || meta.folder || e.name, by: meta.by || null, at: meta.at || null });
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  async restoreSong(id) {
    const tdir = path.join(this.root, TRASH_DIR); const src = path.resolve(tdir, String(id || ''));
    if (path.dirname(src) !== tdir) throw new Error('bad deleted-song id');
    let meta = {}; try { meta = JSON.parse(await fsp.readFile(path.join(src, '_deleted.json'), 'utf8')); } catch (_) {}
    const base = safeSongName(meta.folder || String(id).replace(/ - deleted .*$/, '')) || 'Restored song';
    let folder = base, k = 2; while (await fsp.stat(path.join(this.root, folder)).then(() => true, () => false)) folder = `${base} (restored${k > 2 ? ` ${k - 1}` : ''})`, k++;
    const dest = this.songDir(folder);
    try { await fsp.rename(src, dest); } catch (err) {
      if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await fsp.cp(src, dest, { recursive: true }); await fsp.rm(src, { recursive: true, force: true });
    }
    await fsp.unlink(path.join(dest, '_deleted.json')).catch(() => {});
    return { folder };
  }

  // ---- quest board ----
  async readQuest() {
    const dir = path.join(this.root, QUEST_DIR); let names;
    try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      try { const raw = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); if (raw && raw.fields && typeof raw.fields === 'object') out.push({ file: n, user: String(raw.user || n.replace(/\.json$/, '')), fields: raw.fields }); } catch (_) { /* half-synced */ }
    }
    return out;
  }
  // patch = {key: value} → my file gets {v, at, by} for each key (null value = cleared)
  async writeQuest(identity, patch, now = new Date()) {
    const user = (identity && identity.user) || 'someone';
    const dir = path.join(this.root, QUEST_DIR); await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeLabel(user) || 'someone'}.json`);
    let cur = { user, fields: {} }; try { const raw = JSON.parse(await fsp.readFile(file, 'utf8')); if (raw && raw.fields) cur = raw; } catch (_) {}
    const at = now.toISOString(); let n = 0;
    for (const [k, v] of Object.entries(patch || {})) { if (typeof k !== 'string' || k.length > 200 || !/^(band|song|practice|setlist):/.test(k)) continue; cur.fields[k] = { v: v === undefined ? null : v, at, by: user }; n++; }
    if (JSON.stringify(cur).length > 2e6) throw new Error('quest file too big');
    cur.user = user; cur.at = at;
    await atomicWrite(file, JSON.stringify(cur, null, 1));
    return { written: n, at };
  }

  async conflictCopies(folder) {
    try {
      const dir = this.songDir(folder);
      const names = await fsp.readdir(dir);
      let main = null; try { main = JSON.parse(await fsp.readFile(path.join(dir, LOCK_FILE), 'utf8')); } catch (_) {}
      for (const n of names) {
        if (!(/^_lock.*\(\d+\)\.json$/i.test(n) || /^_lock \(conflict/i.test(n))) continue;
        let copy = null; try { copy = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); } catch (_) {}
        // A copy holding a later takeover than the main file is the real lock: promote it instead of deleting it.
        if (copy && copy.token && (!main || lockNewer(copy, main))) { await atomicWrite(path.join(dir, LOCK_FILE), JSON.stringify(copy, null, 2)).catch(() => {}); main = copy; }
        await fsp.unlink(path.join(dir, n)).catch(() => {});
      }
      return names.filter((n) => /^song.*\(\d+\)\.json$/i.test(n) || /^song \(conflict/i.test(n));
    } catch (_) { return []; }
  }

  async songExists(folder) {
    try { await fsp.stat(this.songDir(folder)); return true; } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }

  // Name check without creating anything (the new-song dialog asks before it closes the open song).
  async checkSongName(name) {
    const folder = safeSongName(name);
    let names = []; try { names = await fsp.readdir(this.root); } catch (_) {}
    const clash = names.find((n) => n.toLowerCase() === folder.toLowerCase());   // Windows / macOS / Drive treat these as the same folder
    if (clash) throw new Error(`A song called "${clash}" already exists`);
    return folder;
  }
  async createSong(name) {
    const folder = await this.checkSongName(name);
    const dir = this.songDir(folder);
    try {
      await fsp.mkdir(dir, { recursive: false });
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`A song folder named "${folder}" already exists`);
      throw err;
    }
    await fsp.mkdir(path.join(dir, AUDIO_DIR), { recursive: true });
    await fsp.mkdir(path.join(dir, BOUNCE_DIR), { recursive: true });
    const song = emptySong(String(name).trim());
    await atomicWrite(path.join(dir, SONG_FILE), JSON.stringify(song, null, 2));
    return { folder, song };
  }

  async loadSong(folder) {
    const file = path.join(this.songDir(folder), SONG_FILE);
    const raw = await fsp.readFile(file, 'utf8');
    const song = JSON.parse(raw);
    if (typeof song.format !== 'number' || song.format > FORMAT_VERSION) {
      throw new Error(`This song was saved by a newer Cobander (format ${song.format}). Update Cobander to open it.`);
    }
    if (!Array.isArray(song.tracks)) song.tracks = [];
    const st = await fsp.stat(file);
    return { song, mtimeMs: st.mtimeMs };
  }

  // Save with optimistic concurrency. `expectedSaveId` is the saveId of the copy the
  // caller loaded (null for a never-saved song). If the on-disk saveId differs, someone
  // else saved in between: we refuse and hand back their copy. `force` skips the check.
  async saveSong(folder, song, identity, { expectedSaveId, force = false } = {}) {
    const dir = this.songDir(folder);
    const file = path.join(dir, SONG_FILE);
    try { await fsp.stat(dir); } catch (err) { if (err.code === 'ENOENT') throw new Error('The song folder is gone (deleted or renamed outside Cobander). Not saving.'); throw err; }
    let onDiskRev = 0;
    try {
      const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
      onDiskRev = num(onDisk.rev, 0);
      if (!force && expectedSaveId !== undefined && (onDisk.saveId || null) !== (expectedSaveId || null)) {
        return { conflict: true, onDisk };
      }
    } catch (err) {
      if (err instanceof SyntaxError) { if (!force) throw new Error('song.json on disk is unreadable right now (Drive is probably mid-sync). Try again in a moment.'); }
      else if (err.code !== 'ENOENT') throw err;
    }
    const out = {
      ...song,
      format: FORMAT_VERSION,
      rev: Math.max(onDiskRev, num(song.rev, 0)) + 1,
      saveId: newId(),
      // the last saveIds this song descends from: lets a client tell "built on my save" from "diverged offline"
      lineage: [...(Array.isArray(song.lineage) && song.lineageFor === song.saveId ? song.lineage : []), ...(song.saveId ? [song.saveId] : [])].slice(-1000),
      savedBy: identity.user,
      savedAt: new Date().toISOString(),
    };
    out.lineageFor = out.saveId;   // a pre-0.4 client copies `lineage` without extending it; lineageFor tells a stale copy from a real one
    await atomicWrite(file, JSON.stringify(out, null, 2));
    const st = await fsp.stat(file);
    this.lastHistory = this.writeHistory(folder, out).catch(() => {});   // roll-back point, written in the background; never fails or slows the save
    return { conflict: false, song: out, mtimeMs: st.mtimeMs };
  }

  audioDir(folder) { return path.join(this.songDir(folder), AUDIO_DIR); }
  // Take files are "<label> - <id>.wav" (or bare "<id>.wav" from 0.1/0.2). The id is the key; the label is for humans.
  async findAudio(folder, clipId) {
    if (!/^[a-f0-9]{12}$/.test(String(clipId))) throw new Error('bad clip id');
    let names; try { names = await fsp.readdir(this.audioDir(folder)); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    const hit = names.find((n) => parseTakeName(n) && parseTakeName(n).id === clipId);
    if (!hit) { const stubs = await hydrateDir(this.audioDir(folder), names); if (stubs.some((n) => parseTakeName(n) && parseTakeName(n).id === clipId)) { const err = new Error(`take ${clipId} is in iCloud but not on this Mac yet — asked iCloud to download it`); err.code = 'ENOENT'; err.icloud = true; throw err; } }
    return hit ? path.join(this.audioDir(folder), hit) : null;
  }
  async audioPath(folder, clipId) {
    const p = await this.findAudio(folder, clipId);
    if (!p) { const err = new Error(`take ${clipId} is not in the audio folder (not synced yet?)`); err.code = 'ENOENT'; throw err; }
    return p;
  }

  async writeAudio(folder, clipId, wavBuffer, { label = null, flac = this.flac } = {}) {
    if (!/^[a-f0-9]{12}$/.test(String(clipId))) throw new Error('bad clip id');
    if (await this.findAudio(folder, clipId)) throw new Error('audio file already exists; takes are immutable');
    let buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer);
    if (flac && FlacNode.isWav(buf)) { try { const f = await FlacNode.wavToFlac(buf); if (f) buf = f; } catch (_) { /* keep the WAV */ } }
    await fsp.mkdir(this.audioDir(folder), { recursive: true });
    const file = path.join(this.audioDir(folder), takeFileName(label, clipId, audioExt(buf)));
    await atomicWrite(file, buf);
    return file;
  }

  // Renames the human part of a take file; the id (and the audio) never change. Returns the new path, or null if unchanged.
  async renameAudio(folder, clipId, label) {
    const cur = await this.findAudio(folder, clipId);
    if (!cur) return null;
    const next = path.join(this.audioDir(folder), takeFileName(label, clipId, parseTakeName(path.basename(cur)).ext));
    if (next === cur) return null;
    await fsp.rename(cur, next);
    return next;
  }

  async readAudio(folder, clipId) {
    return fsp.readFile(await this.audioPath(folder, clipId));
  }

  // Cheap header peek (channels, sample rate, seconds) without reading the whole take.
  async audioInfo(folder, clipId) {
    const fh = await fsp.open(await this.audioPath(folder, clipId), 'r');
    try {
      const b = Buffer.alloc(64); const { bytesRead } = await fh.read(b, 0, 64, 0);
      if (FlacNode.isFlac(b)) { const i = FlacNode.info(new Uint8Array(b.buffer, b.byteOffset, bytesRead)); return i ? { channels: i.channels, sampleRate: i.sampleRate, bits: i.bits, seconds: i.seconds } : null; }
      if (bytesRead < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
      const channels = b.readUInt16LE(22), sampleRate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
      const st = await fh.stat();
      const seconds = (st.size - 44) / Math.max(1, channels * (bits / 8) * sampleRate);
      return { channels, sampleRate, bits, seconds };
    } finally { await fh.close(); }
  }

  // Takes sitting in audio/ that no clip references (deleted by mistake, or saved by a
  // client whose song.json save then lost a conflict).
  // Idea-scratchpad sketches live in audio/ too; callers that pass referencedIds must include them.
  async unreferencedTakes(folder, referencedIds = null) {
    const dir = path.join(this.songDir(folder), AUDIO_DIR);
    let names;
    try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    let referenced = new Set(Array.isArray(referencedIds) ? referencedIds.map(String) : []);
    if (!Array.isArray(referencedIds)) {
      try {
        const { song } = await this.loadSong(folder);
        for (const t of song.tracks) for (const c of t.clips || []) { referenced.add(c.src || c.id); for (const o of [c.vs, c.ps, c.ps && c.ps.vs]) if (o && o.src) referenced.add(String(o.src)); }
        for (const i of song.ideas || []) if (i && i.audioId) referenced.add(i.audioId);
      } catch (_) { /* treat as none referenced */ }
    }
    const out = [];
    for (const n of names) {
      const m = parseTakeName(n);
      if (!m || referenced.has(m.id)) continue;
      const st = await fsp.stat(path.join(dir, n));
      let info = null; try { info = await this.audioInfo(folder, m.id); } catch (_) {}
      out.push({ clipId: m.id, label: m.label, file: n, size: st.size, mtimeMs: st.mtimeMs, seconds: info ? Math.round(info.seconds * 10) / 10 : null, channels: info ? info.channels : null });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  // Every 12-hex id mentioned anywhere in this song's JSON: song.json, versions/, history/ (so "Deleted takes" and
  // rollbacks keep working), track-lock files and mailbox notes. Over-inclusive on purpose: a false hit only keeps a file.
  // Throws when song.json (or any other JSON in the song folder) can't be read and parsed: a half-synced / online-only
  // file would hide references, so nothing may be purged on its say-so.
  async referencedAudio(folder) {
    const dir = this.songDir(folder); const ids = new Set();
    const main = await fsp.readFile(path.join(dir, SONG_FILE), 'utf8'); JSON.parse(main);
    const walk = async (d, depth) => {
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 2 && e.name !== AUDIO_DIR && e.name !== BOUNCE_DIR) await walk(p, depth + 1); continue; }
        if (!/\.json$/i.test(e.name)) continue;
        const txt = await fsp.readFile(p, 'utf8'); JSON.parse(txt);   // unreadable or truncated: throw (no purge)
        for (const m of txt.matchAll(/"([a-f0-9]{12})"/g)) ids.add(m[1]);
      }
    };
    await walk(dir, 0);
    return ids;
  }
  // Audio ids the song still needs right now: song.json, tagged versions, other people's pending tracks and notes —
  // not the save history (a rollback to an old save may then show a missing take; that's the trade for freeing the space).
  async referencedAudioLive(folder) {
    const dir = this.songDir(folder); const ids = new Set();
    const scan = async (p) => { const txt = await fsp.readFile(p, 'utf8'); JSON.parse(txt); for (const m of txt.matchAll(/"([a-f0-9]{12})"/g)) ids.add(m[1]); };
    await scan(path.join(dir, SONG_FILE));
    for (const sub of [VERSION_DIR, TRACKS_DIR, MAILBOX_DIR]) { let names = []; try { names = await fsp.readdir(path.join(dir, sub)); } catch (_) { continue; } for (const n of names) if (/\.json$/i.test(n)) await scan(path.join(dir, sub, n)); }
    return ids;
  }
  // Remove take files for good — only ids that nothing live references (checked here, whatever the caller thinks).
  async purgeAudio(folder, ids) {
    const want = [...new Set((ids || []).map(String).filter((id) => /^[a-f0-9]{12}$/.test(id)))]; if (!want.length) return { removed: [], kept: [] };
    const live = await this.referencedAudioLive(folder); const removed = [], kept = [];
    for (const id of want) {
      if (live.has(id)) { kept.push(id); continue; }
      const p = await this.findAudio(folder, id); if (!p) continue;
      await fsp.unlink(p).catch(() => {}); removed.push(id);
    }
    return { removed, kept };
  }
  // Lighten the song folder on Drive: WAV takes → FLAC (lossless, about half the size), and audio that nothing has
  // referenced — not the song, a version, any of the last ${HISTORY_KEEP} saves, a track lock or a note — for olderThanDays.
  // Deleted songs (_deleted/), the parts bin and bounces are never touched. dryRun reports without changing anything.
  async compactAudio(folder, { convert = true, purge = true, olderThanDays = 30, dryRun = false, onProgress = null, extraRefs = null } = {}) {
    const dir = this.audioDir(folder); let names;
    try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return { converted: 0, removed: [], before: 0, after: 0 }; throw err; }
    olderThanDays = Math.max(7, Number(olderThanDays) || 30);   // never anything recent: a take can sit unreferenced until the next save
    let refs = null, purgeSkipped = null;
    if (purge) { try { refs = await this.referencedAudio(folder); for (const id of extraRefs || []) refs.add(String(id)); } catch (err) { purgeSkipped = `song files not readable (${err.code || err.message}) — nothing removed`; } }
    const cutoff = Date.now() - olderThanDays * 86400000;
    const out = { converted: 0, convertedFiles: [], removed: [], before: 0, after: 0, skipped: [], purgeSkipped };
    const takes = names.map((n) => ({ n, m: parseTakeName(n) })).filter((x) => x.m);
    let i = 0;
    for (const { n, m } of takes) {
      i++; if (onProgress) onProgress({ i, of: takes.length, file: n });
      const p = path.join(dir, n); let st; try { st = await fsp.stat(p); } catch (_) { continue; }
      out.before += st.size;
      if (refs && !refs.has(m.id) && st.mtimeMs < cutoff) { out.removed.push({ file: n, size: st.size }); if (!dryRun) await fsp.unlink(p).catch(() => {}); continue; }
      if (convert && m.ext === 'wav') {
        let buf; try { buf = await fsp.readFile(p); } catch (_) { out.after += st.size; continue; }
        let f = null; try { f = await FlacNode.wavToFlac(buf); } catch (_) {}
        if (!f || f.length >= buf.length) { out.skipped.push(n); out.after += st.size; continue; }
        out.converted++; out.convertedFiles.push({ file: n, from: st.size, to: f.length }); out.after += f.length;
        if (!dryRun) {
          const dst = path.join(dir, takeFileName(m.label, m.id, 'flac'));
          await atomicWrite(dst, f);
          await fsp.unlink(p).catch(() => {});
        }
        continue;
      }
      out.after += st.size;
    }
    return out;
  }

  async writeBounce(folder, baseName, wavBuffer, { stamp = null } = {}) {
    let safe; try { safe = safeSongName(baseName).replace(/\.wav$/i, ''); } catch (_) { safe = 'bounce'; }
    const dir = path.join(this.songDir(folder), BOUNCE_DIR);
    stamp = stamp && /^[\w .-]{1,40}$/.test(String(stamp)) ? String(stamp) : localStamp();
    let file = path.join(dir, `${safe} ${stamp}.wav`);
    for (let i = 2; i < 1000; i++) {
      try { await fsp.access(file); } catch (err) { if (err.code === 'ENOENT') break; throw err; }
      file = path.join(dir, `${safe} ${stamp} (${i}).wav`);
    }
    await atomicWrite(file, wavBuffer);
    return file;
  }

  // DAW hand-off bundle under bounces/<name>/. files: [{path, data:Buffer|string}] or [{path, copyTake: clipId}].
  async writeExport(folder, name, files) {
    let safe; try { safe = safeSongName(name); } catch (_) { safe = 'DAW export'; }
    const root = path.join(this.songDir(folder), BOUNCE_DIR, safe);
    await fsp.mkdir(root, { recursive: true });
    const out = [];
    for (const f of files) {
      const rel = String(f.path || '').replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || rel.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`bad export path ${f.path}`);
      const dest = path.join(root, ...rel.split('/'));
      if (!dest.startsWith(root + path.sep)) throw new Error('bad export path');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (f.copyTake) { const src = await this.audioPath(folder, f.copyTake); await fsp.copyFile(src, dest); }
      else await atomicWrite(dest, typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data));
      out.push(dest);
    }
    return { folder: root, files: out };
  }

  async listBounces(folder) {
    const dir = path.join(this.songDir(folder), BOUNCE_DIR);
    try {
      const out = [];
      for (const n of await fsp.readdir(dir)) {
        const st = await fsp.stat(path.join(dir, n));
        if (st.isDirectory()) { out.push({ name: n, path: path.join(dir, n), mtimeMs: st.mtimeMs, size: 0, dir: true }); continue; }
        if (!n.toLowerCase().endsWith('.wav')) continue;
        out.push({ name: n, path: path.join(dir, n), mtimeMs: st.mtimeMs, size: st.size });
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // ---- version tags: immutable snapshots of song.json under versions/<id>.json ----
  versionPath(folder, id) {
    if (!/^[a-f0-9]{12}$/.test(String(id))) throw new Error('bad version id');
    return path.join(this.songDir(folder), VERSION_DIR, `${id}.json`);
  }
  async writeVersion(folder, id, song) {
    const file = this.versionPath(folder, id);
    try { await fsp.access(file); throw new Error('version already exists; versions are immutable'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const body = { ...song }; for (const k of ['versions', 'activity']) delete body[k];   // a version never carries the list of versions (or the feed) inside it
    await atomicWrite(file, JSON.stringify(body));
    return file;
  }
  // ---- band templates ----
  templateDir() { return path.join(this.root, TEMPLATE_DIR); }
  async listTemplates() {
    let names; try { names = await fsp.readdir(this.templateDir()); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const n of names) {
      if (!/^[a-z0-9-]+\.json$/i.test(n)) continue;   // also skips Drive "(1)" conflict copies
      try { const t = JSON.parse(await fsp.readFile(path.join(this.templateDir(), n), 'utf8')); if (t && t.name) out.push({ ...t, id: n.replace(/\.json$/, '') }); } catch (_) { /* half-synced */ }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  async writeTemplate(t) {
    const id = String(t && t.id || '').toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('bad template id');
    if (!t.name) throw new Error('template needs a name');
    await atomicWrite(path.join(this.templateDir(), `${id}.json`), JSON.stringify({ ...t, id }, null, 2));
    return id;
  }
  async deleteTemplate(id) {
    if (!/^[a-z0-9-]{1,80}$/i.test(String(id))) throw new Error('bad template id');
    await fsp.unlink(path.join(this.templateDir(), `${id}.json`)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }

  // ---- parts bin ----
  partsDir() { return path.join(this.root, PARTS_DIR); }
  async listParts() {
    let names; try { names = await fsp.readdir(this.partsDir()); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const n of names) {
      if (!/^part-[a-f0-9]{12}\.json$/.test(n)) continue;
      try { const p = JSON.parse(await fsp.readFile(path.join(this.partsDir(), n), 'utf8')); if (p && p.name && !p.deleted) out.push({ ...p, id: n.replace(/\.json$/, '') }); } catch (_) { /* half-synced */ }
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  // Copies the audio the part uses out of the song (audio files are immutable, so a copy never goes stale), then the json.
  async savePart(folder, part, audioIds = []) {
    if (!/^part-[a-f0-9]{12}$/.test(String(part && part.id))) throw new Error('bad part id');
    const adir = path.join(this.partsDir(), AUDIO_DIR); await fsp.mkdir(adir, { recursive: true });
    for (const id of new Set(audioIds)) {
      if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('bad audio id');
      if (await this.findPartAudio(id)) continue;
      const src = await this.audioPath(folder, id);
      const dst = path.join(adir, `${id}.${parseTakeName(path.basename(src)).ext}`);
      const tmp = `${dst}.${process.pid}.${newId()}.tmp`; await fsp.copyFile(src, tmp); await fsp.rename(tmp, dst);
    }
    await atomicWrite(path.join(this.partsDir(), `${part.id}.json`), JSON.stringify(part, null, 2));
    return part.id;
  }
  async findPartAudio(audioId) {
    for (const ext of ['flac', 'wav']) { const p = path.join(this.partsDir(), AUDIO_DIR, `${audioId}.${ext}`); try { await fsp.access(p); return p; } catch (_) {} }
    return null;
  }
  async writePartAudio(audioId, buf) {
    if (!/^[a-f0-9]{12}$/.test(String(audioId))) throw new Error('bad audio id');
    let b = Buffer.from(buf);
    if (this.flac && FlacNode.isWav(b)) { try { const f = await FlacNode.wavToFlac(b); if (f) b = f; } catch (_) {} }
    await fsp.mkdir(path.join(this.partsDir(), AUDIO_DIR), { recursive: true });
    await atomicWrite(path.join(this.partsDir(), AUDIO_DIR, `${audioId}.${audioExt(b)}`), b);
  }
  async readPartAudio(audioId) {
    if (!/^[a-f0-9]{12}$/.test(String(audioId))) throw new Error('bad audio id');
    const p = await this.findPartAudio(audioId);
    if (!p) throw new Error("That part's audio hasn't synced from Drive yet — try again in a minute.");
    return fsp.readFile(p);
  }
  async deletePart(id) {
    if (!/^part-[a-f0-9]{12}$/.test(String(id))) throw new Error('bad part id');
    await fsp.unlink(path.join(this.partsDir(), `${id}.json`)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }

  // ---- history: one immutable copy of song.json per save (the roll-back points behind the Feed) ----
  historyDir(folder) { return path.join(this.songDir(folder), HISTORY_DIR); }
  async writeHistory(folder, song) {
    if (!song || !song.saveId) return null;
    const dir = this.historyDir(folder);
    const body = { ...song }; for (const k of ['versions', 'activity']) delete body[k];   // logs are never rolled back
    const file = path.join(dir, `rev-${String(num(song.rev, 0)).padStart(6, '0')}-${song.saveId}.json`);
    await atomicWrite(file, JSON.stringify(body));
    this.historyWrites = (this.historyWrites || 0) + 1;
    if (this.historyWrites % 10 === 1) await this.pruneHistory(folder).catch(() => {});
    return file;
  }
  async listHistory(folder) {
    let names; try { names = await fsp.readdir(this.historyDir(folder)); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return names.map((n) => { const m = /^rev-(\d+)-([a-f0-9]{12})\.json$/i.exec(n); return m ? { rev: Number(m[1]), saveId: m[2].toLowerCase(), file: n } : null; })
      .filter(Boolean).sort((a, b) => a.rev - b.rev || a.file.localeCompare(b.file));
  }
  async pruneHistory(folder, keep = HISTORY_KEEP) {
    const all = await this.listHistory(folder);
    for (const h of all.slice(0, Math.max(0, all.length - keep))) await fsp.unlink(path.join(this.historyDir(folder), h.file)).catch(() => {});
  }
  async readHistory(folder, saveId) {
    if (!/^[a-f0-9]{12}$/i.test(String(saveId))) throw new Error('bad history id');
    const h = (await this.listHistory(folder)).find((x) => x.saveId === String(saveId).toLowerCase());
    if (!h) throw new Error("That save isn't in the history (older than the last 200 saves, or not synced from Drive yet).");
    try { return JSON.parse(await fsp.readFile(path.join(this.historyDir(folder), h.file), 'utf8')); }
    catch (err) { if (err instanceof SyntaxError) throw new Error('That save is still syncing from Drive — try again in a minute.'); throw err; }
  }

  async readVersion(folder, id) {
    try { return JSON.parse(await fsp.readFile(this.versionPath(folder, id), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') throw new Error("That version hasn't synced from Drive yet — try again in a minute."); if (err instanceof SyntaxError) throw new Error('That version is still syncing from Drive — try again in a minute.'); throw err; }
  }

  // ---- presence: who has the song open right now, and doing what ----
  // <song>/_presence/<who>-<hash>.json, rewritten by every open Cobander every ~20 s, deleted on close.
  // Staleness is observation-based like the lock: unchanged for PRESENCE_STALE_MS on our clock = gone.
  presenceFile(folder, identity) {
    const h = crypto.createHash('sha1').update(`${identity.user}\n${identity.host}`).digest('hex').slice(0, 8);
    return path.join(this.songDir(folder), PRESENCE_DIR, `${safeLabel(identity.user) || 'someone'}-${h}.json`);
  }
  async writePresence(folder, identity, { mode = 'listening', playing = false } = {}) {
    const file = this.presenceFile(folder, identity);
    await atomicWrite(file, JSON.stringify({ user: identity.user, host: identity.host, pid: identity.pid, mode, playing: !!playing, at: Date.now(), token: newId() }));
    return file;
  }
  async clearPresence(folder, identity) {
    await fsp.unlink(this.presenceFile(folder, identity)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
  // ---- mailbox: comments from read-only bandmates (one small file each; the lock holder applies + deletes them) ----
  async postMail(folder, identity, op) {
    const id = newId(); const file = path.join(this.songDir(folder), MAILBOX_DIR, `${safeLabel(identity.user) || 'someone'}-${Date.now()}-${id}.json`);
    await atomicWrite(file, JSON.stringify({ id, by: identity.user, at: new Date().toISOString(), op }));
    return id;
  }
  async readMail(folder) {
    const dir = path.join(this.songDir(folder), MAILBOX_DIR);
    let names; try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const n of names.sort()) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      try { const m = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); if (m && m.op) out.push({ file: n, ...m }); } catch (_) { /* half-synced: next look */ }
    }
    return out;
  }
  async removeMail(folder, file) {
    if (!/^[^/\\]+\.json$/.test(String(file || ''))) return;
    await fsp.unlink(path.join(this.songDir(folder), MAILBOX_DIR, file)).catch(() => {});
  }
  // ---- per-track locks ----
  trackLockFile(folder, trackId) { if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(trackId))) throw new Error('bad track id'); return path.join(this.songDir(folder), TRACKLOCK_DIR, `${trackId}.json`); }
  async readTrackLocks(folder, now = Date.now()) {
    const dir = path.join(this.songDir(folder), TRACKLOCK_DIR);
    let names; try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
    const out = {};
    for (const n of names) {
      if (/\(\d+\)\.json$/i.test(n) || /conflict/i.test(n)) { await fsp.unlink(path.join(dir, n)).catch(() => {}); continue; }
      if (!n.endsWith('.json')) continue;
      try { const l = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); if (!l || !l.user || !l.token) continue; l.idle = now - Number(l.at || 0) > TRACK_LOCK_IDLE_MS; out[n.slice(0, -5)] = l; } catch (_) { /* half-synced */ }
    }
    return out;
  }
  // claim a track: refused when someone else holds it and has touched it within the idle window
  async claimTrackLock(folder, trackId, identity, { force = false } = {}) {
    const f = this.trackLockFile(folder, trackId); let cur = null;
    try { cur = JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { cur = null; }
    const fresh = cur && Date.now() - Number(cur.at || 0) <= TRACK_LOCK_IDLE_MS;
    const mine = cur && cur.user === identity.user && cur.host === identity.host;
    if (cur && fresh && !mine && !force) return { ok: false, lock: cur };
    const lock = { user: identity.user, host: identity.host, token: mine ? cur.token : newId(), at: Date.now() };
    await atomicWrite(f, JSON.stringify(lock));
    return { ok: true, lock };
  }
  async touchTrackLock(folder, trackId, identity) {
    const f = this.trackLockFile(folder, trackId); let cur = null;
    try { cur = JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return { ok: false }; }
    if (!cur || cur.user !== identity.user || cur.host !== identity.host) return { ok: false, lock: cur };
    cur.at = Date.now(); await atomicWrite(f, JSON.stringify(cur)); return { ok: true, lock: cur };
  }
  async releaseTrackLock(folder, trackId, identity) {
    const f = this.trackLockFile(folder, trackId); let cur = null;
    try { cur = JSON.parse(await fsp.readFile(f, 'utf8')); } catch (_) { return; }
    if (cur && cur.user === identity.user && cur.host === identity.host) await fsp.unlink(f).catch(() => {});
  }
  // ---- a track-lock holder's track (not the song editor): their latest version, one file per track ----
  async postTrack(folder, identity, trackId, payload) {
    const f = path.join(this.songDir(folder), TRACKS_DIR, `${String(trackId).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
    const body = { by: identity.user, host: identity.host, at: Date.now(), id: newId(), ...payload };
    await atomicWrite(f, JSON.stringify(body)); return { id: body.id, at: body.at };
  }
  async readTracks(folder) {
    const dir = path.join(this.songDir(folder), TRACKS_DIR);
    let names; try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json') || /\(\d+\)\.json$/i.test(n)) continue;
      try { const b = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); if (b && b.track && b.track.id) out.push({ file: n, ...b }); } catch (_) { /* half-synced */ }
    }
    return out;
  }
  // the song editor folded it in: remove it — but only if it's still the version they folded (not a newer one)
  async removeTrackPost(folder, file, id) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(String(file || ''))) return;
    const f = path.join(this.songDir(folder), TRACKS_DIR, file);
    try { const b = JSON.parse(await fsp.readFile(f, 'utf8')); if (b && b.id === id) await fsp.unlink(f); } catch (_) { /* gone already */ }
  }
  async readPresence(folder, now = Date.now()) {
    const dir = path.join(this.songDir(folder), PRESENCE_DIR);
    let names; try { names = await fsp.readdir(dir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    if (!this.seenPresence) this.seenPresence = new Map();
    const out = [];
    for (const n of names) {
      if (/\(\d+\)\.json$/i.test(n) || /conflict/i.test(n)) { await fsp.unlink(path.join(dir, n)).catch(() => {}); continue; }   // Drive conflict copies of presence files are noise
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      let raw; try { raw = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8')); } catch (_) { continue; }
      if (!raw || !raw.user || !raw.token) continue;
      const key = `${folder}/${n}`; const prev = this.seenPresence.get(key);
      const firstSeenAt = prev && prev.token === raw.token && now - (prev.lastLookAt || now) < PRESENCE_STALE_MS / 2 ? prev.firstSeenAt : now;
      this.seenPresence.set(key, { token: raw.token, firstSeenAt, lastLookAt: now });
      const stale = now - firstSeenAt > PRESENCE_STALE_MS || now - Number(raw.at || 0) > LOCK_ANCIENT_MS;
      out.push({ user: raw.user, host: raw.host, pid: raw.pid, mode: raw.mode || 'listening', playing: !!raw.playing, stale, file: n });
    }
    return out;
  }

  // ---- soft locks -------------------------------------------------------

  lockPath(folder) { return path.join(this.songDir(folder), LOCK_FILE); }

  // Staleness is observation-based: we remember the (token, heartbeat) pair we last saw
  // and when we first saw it on OUR clock. If it hasn't changed in LOCK_STALE_MS, the
  // holder is gone (or their Drive is not syncing, which for our purposes is the same).
  // The first time we see a lock it is live, unless its own timestamp is absurdly old.
  async readLock(folder, now = Date.now()) {
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(this.lockPath(folder), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) { this.seen.delete(folder); return null; }
      throw err;
    }
    if (raw && Number.isFinite(raw.lockGen)) this.noteGen(folder, raw.lockGen);
    if (!raw || raw.released || typeof raw.heartbeat !== 'number' || !raw.token) { this.seen.delete(folder); return null; }   // released = tombstone (keeps the generation)
    const prev = this.seen.get(folder);
    let firstSeenAt = now;
    // A long gap since our previous look (this computer slept, or polling stalled) means we were not watching:
    // restart the clock instead of calling a live holder stale the moment we wake up.
    if (prev && prev.token === raw.token && prev.heartbeat === raw.heartbeat && now - (prev.lastLookAt || now) < LOCK_STALE_MS / 2) firstSeenAt = prev.firstSeenAt;
    this.seen.set(folder, { token: raw.token, heartbeat: raw.heartbeat, firstSeenAt, lastLookAt: now });
    const unchangedFor = now - firstSeenAt;
    const stale = unchangedFor > LOCK_STALE_MS || now - raw.heartbeat > LOCK_ANCIENT_MS;
    return { ...raw, stale, unchangedForMs: unchangedFor };
  }

  // Highest lock generation ever seen for a folder (from locks and release tombstones): a new lock is always above it,
  // so a laptop waking up with an old lock can never out-rank whoever holds the song now.
  noteGen(folder, g) { if (!this.maxGen) this.maxGen = new Map(); if (!(this.maxGen.get(folder) >= g)) this.maxGen.set(folder, g); }
  topGen(folder) { return (this.maxGen && this.maxGen.get(folder)) || 0; }

  isMine(lock, identity) {
    return !!lock && lock.user === identity.user && lock.host === identity.host && lock.pid === identity.pid;
  }
  // Same person on the same computer, different process: a previous instance that
  // crashed or was force-quit. Reclaimable without ceremony.
  isSameMachine(lock, identity) {
    return !!lock && lock.user === identity.user && lock.host === identity.host;
  }

  // Acquire the lock. Returns {ok:true, lock} or {ok:false, lock} where lock is the live holder.
  async acquireLock(folder, identity, { force = false } = {}) {
    const existing = await this.readLock(folder);
    if (existing && !existing.stale && !this.isSameMachine(existing, identity) && !force) {
      return { ok: false, lock: existing };
    }
    const lock = { ...identity, token: newId(), since: Date.now(), heartbeat: Date.now(), lockGen: Math.max(existing && Number.isFinite(existing.lockGen) ? existing.lockGen : 0, this.topGen(folder)) + 1 };
    await atomicWrite(this.lockPath(folder), JSON.stringify(lock, null, 2));
    // Two clients can race through the check above; re-read and make sure ours stuck.
    await new Promise((r) => setTimeout(r, 150));
    const after = await this.readLock(folder);
    if (!after || after.token !== lock.token) {
      return { ok: false, lock: after };
    }
    return { ok: true, lock };
  }

  // `stillWanted` is re-checked right before the write so a heartbeat that was in flight
  // during a take-over or close cannot resurrect the old lock.
  async heartbeat(folder, lock, stillWanted = () => true) {
    const current = await this.readLock(folder);
    if (!current) {
      // Someone took over after us and has since closed (their release tombstone carries a higher generation): we lost it.
      if (Number.isFinite(lock.lockGen) && this.topGen(folder) > lock.lockGen) return { lost: true, lock: null };
      // Lock file vanished (Drive hiccup): re-assert ours.
      if (!stillWanted()) return { lost: false, lock };
      const again = { ...lock, heartbeat: Date.now() };
      await atomicWrite(this.lockPath(folder), JSON.stringify(again, null, 2));
      return { lost: false, missing: true, lock: again };
    }
    if (current.token !== lock.token) {
      // An OLDER generation over ours = the previous holder's late heartbeat (laptop woke up, Drive lag) clobbered
      // our takeover: put ours back. Only a newer generation (or a tie we lost) means we really lost the lock.
      if (lockNewer(lock, current) && stillWanted()) {
        const again = { ...lock, heartbeat: Date.now() };
        await atomicWrite(this.lockPath(folder), JSON.stringify(again, null, 2));
        return { lost: false, reasserted: true, lock: again };
      }
      return { lost: true, lock: current };
    }
    if (!stillWanted()) return { lost: false, lock };
    const updated = { ...lock, heartbeat: Date.now() };
    await atomicWrite(this.lockPath(folder), JSON.stringify(updated, null, 2));
    return { lost: false, lock: updated };
  }

  async releaseLock(folder, lock) {
    const current = await this.readLock(folder);
    if (current && current.token === lock.token) {
      // Leave a tombstone instead of deleting: it keeps the generation, and pre-0.4 clients read it as "no lock".
      await atomicWrite(this.lockPath(folder), JSON.stringify({ released: true, lockGen: Number.isFinite(lock.lockGen) ? lock.lockGen : 0, by: lock.user, at: Date.now() })).catch(() => {});
    }
    this.seen.delete(folder);
  }
}

module.exports = {
  SongStore,
  safeSongName,
  atomicWrite,
  clientIdentity,
  emptySong,
  newId,
  num,
  lockNewer,
  localStamp,
  parseTakeName, safeLabel, takeFileName,
  looksLikeDrivePath,
  cloudProvider,
  hydrateDir,
  SONG_FILE,
  LOCK_FILE,
  AUDIO_DIR,
  BOUNCE_DIR,
  VERSION_DIR,
  HISTORY_DIR,
  TEMPLATE_DIR,
  PARTS_DIR,
  HISTORY_KEEP,
  PRESENCE_DIR,
  PRESENCE_STALE_MS,
  LOCK_STALE_MS,
  LOCK_ANCIENT_MS,
  HEARTBEAT_MS,
  FORMAT_VERSION,
};
