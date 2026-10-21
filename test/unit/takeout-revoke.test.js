// Members on the key, and the leaked-key list: a revoked key drops the folder back to free, nothing else breaks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
process.env.COBANDER_TAKEOUT_PUB = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url');
const T = require('../../src/takeout');

test('key carries the bandmates (trimmed, capped at 8); status shows them', async () => {
  const k = T.sign({ band: 'Never a Doubt', members: [' Jeff ', 'Logan', '', 'Dan', 'Zach', 'a', 'b', 'c', 'd', 'e'] }, priv);
  assert.deepEqual(T.verify(k).members, ['Jeff', 'Logan', 'Dan', 'Zach', 'a', 'b', 'c', 'd']);
  assert.deepEqual(T.verify(T.sign({ band: 'Solo' }, priv)).members, [], 'old-style keys (no members) still verify');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cob-rev-'));
  await T.write(root, k);
  const st = T.status(root, 5); assert.equal(st.unlocked, true); assert.equal(st.tierName, 'Groupie'); assert.deepEqual(st.members.slice(0, 2), ['Jeff', 'Logan']);
});
test('a revoked key: folder goes back to free (songs stay), the leaked band is named, it can\'t be pasted again; fresh key works', async () => {
  const leaked = T.sign({ band: 'Never a Doubt', order: '1' }, priv), fresh = T.sign({ band: 'Never a Doubt', order: '1b' }, priv);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cob-rev-'));
  await T.write(root, leaked);
  T.setRevoked([{ fp: T.fingerprint(leaked), at: '2026-10-21' }, 'not-a-fingerprint']);
  assert.equal(T.isRevoked(leaked), true); assert.equal(T.isRevoked(fresh), false);
  const st = T.status(root, 4);
  assert.equal(st.unlocked, false); assert.equal(st.revoked, true); assert.equal(st.leakedFrom, 'Never a Doubt'); assert.equal(st.limit, 1);
  assert.throws(() => T.assertCanAdd(root, 4), (e) => e.code === 'TAKEOUT');
  await assert.rejects(T.write(root, leaked), /switched off/);
  await T.write(root, fresh); assert.equal(T.status(root, 4).unlocked, true);
  assert.equal(T.fingerprint(leaked.replace('.', '.\n ')), T.fingerprint(leaked), 'whitespace from an email does not change the fingerprint');
  T.setRevoked([]);
});
