'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
// these tests fill folders with songs, so every tmp folder gets a Takeout key signed by a throwaway pair
const TKP = require('crypto').generateKeyPairSync('ed25519');
process.env.COBANDER_TAKEOUT_PUB = TKP.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const Takeout = require('../../src/takeout');
const S = require('../../src/store');
const TK = Takeout.sign({ band: 'Test Band' }, TKP.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url'));

const tmp = (unlocked = true) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-store-')); if (unlocked) fs.writeFileSync(path.join(d, Takeout.FILE), JSON.stringify({ key: TK })); return d; };
const me = { user: 'Jeff', host: 'jeffpc', pid: 111 };
const kat = { user: 'Kat', host: 'katmac', pid: 222 };

test('safeSongName strips illegal characters and rejects reserved names', () => {
  assert.equal(S.safeSongName('  Can\'t Argue?  '), 'Can\'t Argue');
  assert.equal(S.safeSongName('a/b\\c:d'), 'abcd');
  assert.throws(() => S.safeSongName('CON'));
  assert.throws(() => S.safeSongName('...'));
  assert.throws(() => S.safeSongName('x'.repeat(121)));
});

test('take file names carry a label and parse back to the id', () => {
  assert.equal(S.takeFileName('Guitar - take 1 - Jeff', 'abcdef012345'), 'Guitar - take 1 - Jeff - abcdef012345.wav');
  assert.deepEqual(S.parseTakeName('Guitar - take 1 - Jeff - abcdef012345.wav'), { label: 'Guitar - take 1 - Jeff', id: 'abcdef012345', ext: 'wav' });
  assert.deepEqual(S.parseTakeName('abcdef012345.wav'), { label: '', id: 'abcdef012345', ext: 'wav' });
  assert.deepEqual(S.parseTakeName('Vox - abcdef012345.flac'), { label: 'Vox', id: 'abcdef012345', ext: 'flac' });
  assert.equal(S.parseTakeName('notes.txt'), null);
  assert.equal(S.safeLabel('a:b*c'), 'a b c');
});

test('free folder: one song, then Takeout; a key lifts it', async () => {
  const root = tmp(false); const st = new S.SongStore(root);
  fs.mkdirSync(path.join(root, 'installers')); fs.mkdirSync(path.join(root, 'Plugins'));   // not songs: must not eat the free slot
  assert.equal((await st.takeoutStatus()).unlocked, false); assert.equal((await st.takeoutStatus()).songs, 0);
  await st.createSong('First'); assert.equal((await st.takeoutStatus()).songs, 1);
  await assert.rejects(st.createSong('Second'), /Takeout lifts the limit/);
  await assert.rejects(st.takeoutEnter('cob1.x.y'), /isn't a Takeout key/);
  const stt = await st.takeoutEnter(TK); assert.equal(stt.unlocked, true); assert.equal(stt.band, 'Test Band'); assert.equal(stt.songs, 1);
  assert.equal((await st.createSong('Second')).folder, 'Second');
  assert.ok(!(await st.listSongs()).some((x) => x.folder.startsWith('_')), 'the key file is not a song');
});
test('create / load / save with optimistic concurrency', async () => {
  const st = new S.SongStore(tmp());
  const { folder, song } = await st.createSong('Tremors');
  assert.equal(folder, 'Tremors');
  await assert.rejects(st.createSong('Tremors'), /already exists/);
  await assert.rejects(st.createSong('tremors'), /already exists/, 'case-insensitive clash (Windows / Drive)');
  const dot = await st.createSong('../.hidden'); assert.equal(dot.folder, 'hidden', 'no leading dot (it would vanish from the list)');
  assert.ok((await st.listSongs()).some((x) => x.folder === 'hidden'));
  assert.equal((await st.createSong('_parts copy')).folder, 'parts copy', 'no leading underscore (clashes with _parts/_templates)');
  const r1 = await st.saveSong(folder, { ...song, bpm: 140 }, me, { expectedSaveId: null });
  assert.equal(r1.conflict, false); assert.equal(r1.song.rev, 1); assert.equal(r1.song.savedBy, 'Jeff');
  const stale = await st.saveSong(folder, { ...song, bpm: 90 }, kat, { expectedSaveId: null });
  assert.equal(stale.conflict, true); assert.equal(stale.onDisk.bpm, 140);
  const forced = await st.saveSong(folder, { ...song, bpm: 90 }, kat, { expectedSaveId: null, force: true });
  assert.equal(forced.song.rev, 2); assert.equal(forced.song.bpm, 90);
  const { song: loaded } = await st.loadSong(folder);
  assert.equal(loaded.savedBy, 'Kat');
});

test('loadSong refuses a song from a newer format', async () => {
  const root = tmp(); const st = new S.SongStore(root);
  const { folder } = await st.createSong('Future');
  await fsp.writeFile(path.join(root, folder, 'song.json'), JSON.stringify({ format: 99, tracks: [] }));
  await assert.rejects(st.loadSong(folder), /newer Cobander/);
});

test('songDir rejects traversal', () => {
  const st = new S.SongStore(tmp());
  assert.throws(() => st.songDir('../x'));
  assert.throws(() => st.songDir('a/b'));
  assert.throws(() => st.songDir(''));
});

test('audio takes are immutable and renameable by label', async () => {
  const st = new S.SongStore(tmp());
  const { folder } = await st.createSong('Takes');
  const id = 'aaaaaaaaaaaa';
  await st.writeAudio(folder, id, Buffer.from('RIFFxxxxWAVE'), { label: 'Vox - take 1 - Jeff' });
  await assert.rejects(st.writeAudio(folder, id, Buffer.from('x')), /immutable/);
  const p = await st.renameAudio(folder, id, 'Vox - keeper - Jeff');
  assert.match(path.basename(p), /^Vox - keeper - Jeff - aaaaaaaaaaaa\.wav$/);
  assert.equal(String(await st.readAudio(folder, id)), 'RIFFxxxxWAVE');
  await assert.rejects(st.writeAudio(folder, 'nothex', Buffer.from('x')), /bad clip id/);
});

test('unreferenced takes skip clips, split pieces (src) and idea sketches', async () => {
  const st = new S.SongStore(tmp());
  const { folder, song } = await st.createSong('Refs');
  for (const id of ['111111111111', '222222222222', '333333333333', '444444444444']) await st.writeAudio(folder, id, Buffer.from('x'));
  song.tracks = [{ id: 't1', clips: [{ id: '111111111111' }, { id: 'ffffffffffff', src: '222222222222' }] }];
  song.ideas = [{ id: 'i1', kind: 'audio', audioId: '333333333333' }];
  await st.saveSong(folder, song, me, { force: true });
  const un = await st.unreferencedTakes(folder);
  assert.deepEqual(un.map((u) => u.clipId), ['444444444444']);
});

test('locks: acquire, refuse a live foreign lock, same machine reclaims, release', async () => {
  const root = tmp(); const a = new S.SongStore(root), b = new S.SongStore(root);
  const { folder } = await a.createSong('Locks');
  const la = await a.acquireLock(folder, me); assert.equal(la.ok, true);
  const lb = await b.acquireLock(folder, kat); assert.equal(lb.ok, false); assert.equal(lb.lock.user, 'Jeff');
  const again = await b.acquireLock(folder, { ...me, pid: 999 }); assert.equal(again.ok, true, 'same user+host = old window, reclaimable');
  const hb = await a.heartbeat(folder, la.lock); assert.equal(hb.lost, true);
  await b.releaseLock(folder, again.lock);
  assert.equal(await b.readLock(folder), null);
});

test('lock staleness is judged by observation, not the holder clock', async () => {
  const root = tmp(); const a = new S.SongStore(root), b = new S.SongStore(root);
  const { folder } = await a.createSong('Stale');
  const la = await a.acquireLock(folder, me);
  const t0 = Date.now();
  const first = await b.readLock(folder, t0); assert.equal(first.stale, false);
  for (let t = 10000; t < S.LOCK_STALE_MS; t += 10000) await b.readLock(folder, t0 + t);   // watched the whole time (polling)
  const later = await b.readLock(folder, t0 + S.LOCK_STALE_MS + 1000); assert.equal(later.stale, true);
  await a.heartbeat(folder, la.lock);
  const fresh = await b.readLock(folder, t0 + S.LOCK_STALE_MS + 2000); assert.equal(fresh.stale, false, 'a new heartbeat resets the observation');
});

test('bounces get a stamp and never overwrite', async () => {
  const st = new S.SongStore(tmp());
  const { folder } = await st.createSong('Bounce');
  const a = await st.writeBounce(folder, 'Bounce mix', Buffer.from('1'), { stamp: '2026-10-14 120000' });
  const b = await st.writeBounce(folder, 'Bounce mix', Buffer.from('2'), { stamp: '2026-10-14 120000' });
  assert.notEqual(a, b); assert.match(path.basename(b), /\(2\)\.wav$/);
  const list = await st.listBounces(folder); assert.equal(list.length, 2);
});

test('DAW export refuses paths that escape the export folder', async () => {
  const st = new S.SongStore(tmp());
  const { folder } = await st.createSong('Export');
  await assert.rejects(st.writeExport(folder, 'x', [{ path: '../evil.txt', data: 'x' }]), /bad export path/);
  await assert.rejects(st.writeExport(folder, 'x', [{ path: '/abs.txt', data: 'x' }]), /bad export path/);
  const r = await st.writeExport(folder, 'x', [{ path: 'stems/a.wav', data: 'ok' }]);
  assert.equal(r.files.length, 1);
});

test('versions are immutable files under versions/ and never nest the version list', async () => {
  const st = new S.SongStore(tmp());
  const { folder, song } = await st.createSong('Versions');
  const id = 'abcabcabcabc';
  await st.writeVersion(folder, id, { ...song, bpm: 99, versions: [{ id }], activity: [{ id: 'x' }] });
  await assert.rejects(st.writeVersion(folder, id, song), /immutable/);
  const v = await st.readVersion(folder, id);
  assert.equal(v.bpm, 99); assert.equal(v.versions, undefined); assert.equal(v.activity, undefined);
  assert.throws(() => st.versionPath(folder, '../../x'), /bad version id/);
});

test('presence: written, seen by others, stale by observation, cleared on close', async () => {
  const root = tmp(); const a = new S.SongStore(root), b = new S.SongStore(root);
  const { folder } = await a.createSong('Presence');
  await a.writePresence(folder, kat, { mode: 'listening', playing: true });
  const t0 = Date.now();
  let p = await b.readPresence(folder, t0);
  assert.equal(p.length, 1); assert.equal(p[0].user, 'Kat'); assert.equal(p[0].playing, true); assert.equal(p[0].stale, false);
  for (let t = 10000; t < S.PRESENCE_STALE_MS; t += 10000) await b.readPresence(folder, t0 + t);
  p = await b.readPresence(folder, t0 + S.PRESENCE_STALE_MS + 1000); assert.equal(p[0].stale, true);
  await a.writePresence(folder, kat, { mode: 'editing' });
  p = await b.readPresence(folder, t0 + S.PRESENCE_STALE_MS + 2000); assert.equal(p[0].stale, false); assert.equal(p[0].mode, 'editing');
  await fsp.writeFile(path.join(root, folder, S.PRESENCE_DIR, 'Kat-xxxxxxxx (1).json'), '{}');
  p = await b.readPresence(folder); assert.equal(p.length, 1, 'Drive conflict copy of a presence file is dropped');
  await a.clearPresence(folder, kat);
  assert.deepEqual(await b.readPresence(folder), []);
});

test('listSongs reports open needs, unread @mentions and presence', async () => {
  const root = tmp(); const st = new S.SongStore(root);
  const { folder, song } = await st.createSong('Badges');
  song.needs = [{ id: 'n1', text: 'needs bass' }, { id: 'n2', text: 'needs harmony', done: { by: 'Kat' } }, { id: 'n3', text: 'gone', deleted: true }];
  song.markers = [
    { id: 'm1', time: 1, text: '@Jeff can you redo this?', by: 'Kat', at: '2026-10-14T10:00:00.000Z' },
    { id: 'm2', time: 2, text: '@Jeff old one', by: 'Kat', at: '2026-10-01T10:00:00.000Z' },
    { id: 'm3', time: 3, text: '@Jeff resolved', by: 'Kat', at: '2026-10-14T10:00:00.000Z', resolved: { by: 'Jeff' } },
    { id: 'm4', time: 4, text: 'plain', by: 'Logan', at: '2026-10-14T10:00:00.000Z', replies: [{ id: 'r1', text: 'agree @jeff', by: 'Zach', at: '2026-10-14T11:00:00.000Z' }] },
  ];
  await st.saveSong(folder, song, kat, { force: true });
  await st.writePresence(folder, kat, { mode: 'listening', playing: true });
  const [s] = await st.listSongs(me, { lastSeen: { Badges: '2026-10-05T00:00:00.000Z' } });
  assert.equal(s.needsOpen, 1); assert.deepEqual(s.needs, ['needs bass']);
  assert.equal(s.mentions, 2, 'm1 + the reply; m2 is older than last seen, m3 is resolved');
  assert.equal(s.presence.length, 1); assert.equal(s.presence[0].user, 'Kat');
});


test('a long gap between looks (we slept) does not make a live lock look stale', async () => {
  const root = tmp(); const a = new S.SongStore(root), b = new S.SongStore(root);
  const { folder } = await a.createSong('Sleepy');
  await a.acquireLock(folder, me);
  const t0 = Date.now();
  assert.equal((await b.readLock(folder, t0)).stale, false);
  assert.equal((await b.readLock(folder, t0 + 3 * 3600 * 1000)).stale, false, 'first look after waking restarts the clock');
});

test('lock generations: takeover is newer by gen, a late heartbeat of the old holder is undone', async () => {
  const root = tmp(); const a = new S.SongStore(root), b = new S.SongStore(root);
  const { folder } = await a.createSong('Gen');
  const la = (await a.acquireLock(folder, me)).lock;
  const lb = (await b.acquireLock(folder, kat, { force: true })).lock;
  assert.equal(lb.lockGen, la.lockGen + 1); assert.ok(S.lockNewer(lb, la)); assert.ok(!S.lockNewer(la, lb));
  // old holder wakes up and writes its stale heartbeat over the takeover (its disk had not seen it yet)
  await S.atomicWrite(a.lockPath(folder), JSON.stringify({ ...la, heartbeat: Date.now() }));
  const hb = await b.heartbeat(folder, lb);
  assert.equal(hb.lost, false); assert.equal(hb.reasserted, true);
  assert.equal(JSON.parse(await fsp.readFile(a.lockPath(folder), 'utf8')).token, lb.token);
  const ha = await a.heartbeat(folder, la); assert.equal(ha.lost, true, 'the old holder now sees the newer lock');
  // pre-0.4 locks without gen fall back to since
  assert.ok(S.lockNewer({ since: 2 }, { since: 1 })); assert.ok(!S.lockNewer({ lockGen: 1, since: 1 }, { since: 5 }), 'mixed old/new client: the old since rule');
});

test('a Drive conflict copy holding a newer lock is promoted, not deleted', async () => {
  const root = tmp(); const a = new S.SongStore(root);
  const { folder } = await a.createSong('Copy');
  const la = (await a.acquireLock(folder, me)).lock;
  const newer = { ...kat, token: 'n'.repeat(12), since: 1, heartbeat: Date.now(), lockGen: la.lockGen + 1 };
  await fsp.writeFile(path.join(root, folder, '_lock (1).json'), JSON.stringify(newer));
  await a.conflictCopies(folder);
  assert.equal(JSON.parse(await fsp.readFile(a.lockPath(folder), 'utf8')).token, newer.token);
  assert.ok(!fs.existsSync(path.join(root, folder, '_lock (1).json')));
});

test('history: every save is kept, readable by saveId, lineage grows, pruned past the cap', async () => {
  const st = new S.SongStore(tmp());
  const { folder, song } = await st.createSong('Hist');
  let cur = song;
  for (let i = 0; i < 5; i++) { const r = await st.saveSong(folder, { ...cur, notes: `n${i}`, activity: [{ id: 'a' + i }] }, me, { expectedSaveId: cur.saveId }); cur = r.song; await st.lastHistory; }
  const h = await st.listHistory(folder);
  assert.equal(h.length, 5); assert.deepEqual(h.map((x) => x.rev), [1, 2, 3, 4, 5]);
  const third = await st.readHistory(folder, h[2].saveId);
  assert.equal(third.notes, 'n2'); assert.equal(third.activity, undefined, 'logs are not part of a roll-back point');
  assert.equal(cur.lineage.length, 4); assert.equal(cur.lineage[3], h[3].saveId);
  await st.pruneHistory(folder, 2); assert.equal((await st.listHistory(folder)).length, 2);
  await assert.rejects(st.readHistory(folder, h[0].saveId), /isn't in the history/);
  await assert.rejects(st.readVersion(folder, 'abcdefabcdef'), /hasn't synced/);
});

test('one unreadable song folder does not empty the song list', async () => {
  const root = tmp(); const st = new S.SongStore(root);
  await st.createSong('Good');
  const bad = path.join(root, 'Bad'); fs.mkdirSync(bad); fs.mkdirSync(path.join(bad, 'song.json'));   // EISDIR on read
  const list = await st.listSongs(me);
  assert.deepEqual(list.map((x) => x.folder), ['Good']);
});


test('release leaves a tombstone: a waking laptop with an old lock cannot out-rank the next holder', async () => {
  const root = tmp(); const a = new S.SongStore(root), b = new S.SongStore(root), c = new S.SongStore(root);
  const { folder } = await a.createSong('Tomb');
  const la = (await a.acquireLock(folder, me)).lock;                       // gen 1
  const lb = (await b.acquireLock(folder, kat, { force: true })).lock;     // gen 2
  await b.releaseLock(folder, lb);
  assert.equal(await c.readLock(folder), null, 'tombstone reads as no lock');
  const lc = (await c.acquireLock(folder, { user: 'Zach', host: 'z', pid: 3 })).lock;
  assert.equal(lc.lockGen, 3, 'next lock goes above the tombstone');
  const ha = await a.heartbeat(folder, la); assert.equal(ha.lost, true);
  const pre04 = JSON.parse(await fsp.readFile(a.lockPath(folder), 'utf8')); assert.equal(pre04.token, lc.token);
});

test('lineage from a pre-0.4 save (copied, not extended) is not trusted', async () => {
  const st = new S.SongStore(tmp());
  const { folder, song } = await st.createSong('Lin');
  const s1 = (await st.saveSong(folder, song, me, { expectedSaveId: null })).song;
  const old = { ...s1, saveId: 'abcabcabcabc', rev: 5 };   // what a 0.3.1 client writes: lineage copied, lineageFor stale
  const s2 = (await st.saveSong(folder, old, me, { force: true })).song;
  assert.deepEqual(s2.lineage, ['abcabcabcabc']);
  assert.equal(s2.lineageFor, s2.saveId);
});

test('cloud provider detection covers Drive, OneDrive, iCloud, Dropbox and plain folders', () => {
  const { cloudProvider, looksLikeDrivePath } = require('../../src/store');
  assert.equal(cloudProvider('G:\\My Drive\\Band stuff').id, 'gdrive');
  assert.equal(cloudProvider('/Users/d/Library/CloudStorage/GoogleDrive-d@x.com/My Drive/Band').id, 'gdrive');
  assert.equal(cloudProvider('C:\\Users\\dan\\OneDrive - Acme\\Band').id, 'onedrive');
  assert.equal(cloudProvider('/Users/z/Library/Mobile Documents/com~apple~CloudDocs/Band').id, 'icloud');
  assert.equal(cloudProvider('C:\\Users\\z\\iCloudDrive\\Band').id, 'icloud');
  assert.equal(cloudProvider('/Users/l/Dropbox/Band').id, 'dropbox');
  assert.equal(cloudProvider('/home/x/music/band'), null);
  assert.equal(looksLikeDrivePath('/Users/l/Dropbox/Band'), true);
});
