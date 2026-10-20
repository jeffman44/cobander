'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Updater, cmpVer, platformKey } = require('../../src/updater');
const controlApi = require('../../src/control-api');

test('version compare', () => {
  assert.ok(cmpVer('0.4.0', '0.3.1') > 0);
  assert.ok(cmpVer('0.3.10', '0.3.9') > 0);
  assert.equal(cmpVer('0.4', '0.4.0'), 0);
  assert.ok(cmpVer('0.3.1', '0.4.0') < 0);
});

function setup(manifest, fileBody) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-upd-'));
  fs.mkdirSync(path.join(shared, 'installers'));
  const key = platformKey();
  if (fileBody != null) fs.writeFileSync(path.join(shared, 'installers', `Cobander-${manifest.version}-x`), fileBody);
  fs.writeFileSync(path.join(shared, 'installers', 'latest.json'), '﻿' + JSON.stringify({ ...manifest, files: { [key]: `Cobander-${manifest.version}-x` } }));
  const seen = [];
  const u = new Updater({ currentVersion: '0.3.1', sharedFolder: () => shared, notify: (s) => seen.push(s), quit: () => {} });
  return { u, key };
}

test('updater: newer + synced + right size = ready (BOM tolerated)', async () => {
  const body = Buffer.from('installer bytes');
  const { u, key } = setup({ version: '0.4.0', notes: ['a'], size: { [platformKeyOf()]: body.length }, sha256: { [platformKeyOf()]: crypto.createHash('sha256').update(body).digest('hex') } }, body);
  void key;
  const s = await u.check();
  assert.equal(s.available, true); assert.equal(s.ready, true); assert.deepEqual(s.notes, ['a']);
});
function platformKeyOf() { return platformKey(); }

test('updater: still syncing when size differs; not synced when missing; idle when same version', async () => {
  const { u } = setup({ version: '0.4.0', size: { [platformKey()]: 999 } }, Buffer.from('short'));
  const s = await u.check(); assert.equal(s.ready, false); assert.match(s.reason, /syncing/);
  const { u: u2 } = setup({ version: '0.4.0' }, null);
  assert.match((await u2.check()).reason, /not synced/);
  const { u: u3 } = setup({ version: '0.3.1' }, Buffer.from('x'));
  assert.equal((await u3.check()).available, false);
});

test('updater: snooze hides this version until a forced check', async () => {
  const { u } = setup({ version: '0.4.0' }, Buffer.from('x'));
  await u.check(); u.snooze();
  assert.equal((await u.check()).snoozed, true);
  assert.equal((await u.check({ force: true })).snoozed, false);
});

function req(port, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null })); });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
}

test('control API: token required, routes dispatch, errors are JSON', async () => {
  const port = 47900 + Math.floor(Math.random() * 90);
  const server = await controlApi.start({ port, token: 'sekrit', handlers: { 'GET /songs': async () => [{ folder: 'x' }], 'POST /song/patch': async ({ body }) => { if (!body.bpm) throw new Error('bpm required'); return { bpm: body.bpm }; } }, log: () => {} });
  try {
    assert.equal((await req(port, 'GET', '/songs')).status, 401);
    assert.equal((await req(port, 'GET', '/songs', 'wrong')).status, 401);
    const ok = await req(port, 'GET', '/songs', 'sekrit'); assert.equal(ok.status, 200);
    const bad = await req(port, 'POST', '/song/patch', 'sekrit', {}); assert.ok(bad.status >= 400); assert.match(JSON.stringify(bad.body), /bpm required/);
    const good = await req(port, 'POST', '/song/patch', 'sekrit', { bpm: 150 }); assert.equal(good.body.bpm ?? good.body.result?.bpm, 150);
  } finally { server.close(); }
});

test('control API documents the 0.4 collaboration routes', () => {
  const paths = controlApi.ROUTES.map((r) => `${r[0]} ${r[1]}`);
  for (const p of ['GET /collab', 'POST /sections', 'POST /chords', 'POST /lyrics', 'POST /needs', 'POST /note/reply', 'POST /note/resolve', 'POST /vote', 'POST /idea', 'POST /version', 'GET /versions']) assert.ok(paths.includes(p), `${p} missing from ROUTES`);
});

test('updater: chunked release — parts present = ready, joined back on install and checksum-verified; old top-level ignored', async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-upd-')); const dir = path.join(shared, 'installers'); fs.mkdirSync(dir);
  const key = platformKey(); const body = Buffer.from('0123456789abcdefghij'.repeat(10));
  const a = body.subarray(0, 120), b = body.subarray(120);
  fs.writeFileSync(path.join(dir, `Cobander-${key}.part00`), a);
  const m = { version: '0.8.1', files: { [key]: 'old.exe' }, size: { [key]: 1 }, chunked: { version: '0.8.2', notes: ['new'], files: { [key]: { name: 'Cobander-0.8.2-x.exe', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), parts: [{ file: `Cobander-${key}.part00`, size: a.length }, { file: `Cobander-${key}.part01`, size: b.length }] } } } };
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(m));
  let launched = null;
  const u = new Updater({ currentVersion: '0.8.0', sharedFolder: () => shared, notify: () => {}, quit: () => {} });
  u.launchInstaller = async (local) => { launched = fs.readFileSync(local); };
  let s = await u.check(); assert.equal(s.latest, '0.8.2'); assert.equal(s.ready, false); assert.match(s.reason, /syncing/);
  fs.writeFileSync(path.join(dir, `Cobander-${key}.part01`), b);
  s = await u.check(); assert.equal(s.ready, true); assert.deepEqual(s.notes, ['new']);
  await u.install(); assert.ok(launched && launched.equals(body), 'parts joined in order');
  // corrupt part → checksum error
  fs.writeFileSync(path.join(dir, `Cobander-${key}.part01`), Buffer.alloc(b.length, 1));
  const u2 = new Updater({ currentVersion: '0.8.0', sharedFolder: () => shared, notify: () => {}, quit: () => {} }); u2.launchInstaller = async () => {};
  await assert.rejects(u2.install(), /checksum/);
});
