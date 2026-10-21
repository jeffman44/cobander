const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs'); const os = require('os'); const path = require('path');
const T = require('../../src/takeout');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url');

test('takeout: sign/verify round-trips, tier defaults, pasted whitespace tolerated', () => {
  const k = T.sign({ band: 'Never a Doubt', tier: 'roadie', email: 'A@B.co' }, priv);
  assert.match(k, /^cob1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const c = T.verify(k, pub);
  assert.equal(c.band, 'Never a Doubt'); assert.equal(c.tier, 'roadie'); assert.equal(c.email, 'a@b.co'); assert.ok(c.iat);
  assert.equal(T.verify(k.replace('.', '.\n  '), pub).band, 'Never a Doubt');
  assert.equal(T.verify(T.sign({ band: 'X', tier: 'gold' }, priv), pub).tier, 'takeout');
});
test('takeout: tampered, wrong-key and garbage keys fail', () => {
  const k = T.sign({ band: 'Never a Doubt' }, priv);
  const [h, body, sig] = k.split('.');
  const other = Buffer.from(JSON.stringify({ band: 'Other', tier: 'roadie' })).toString('base64url');
  assert.equal(T.verify(`${h}.${other}.${sig}`, pub), null);
  assert.equal(T.verify(k), null, 'the real public key must not accept a test-signed key');
  assert.equal(T.verify('cob1.nope.nope', pub), null); assert.equal(T.verify('', pub), null); assert.equal(T.verify(null, pub), null);
  assert.throws(() => T.sign({ band: '' }, priv), /band name/);
});
test('takeout: free folder allows one song, a key in the folder lifts it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cob-takeout-'));
  assert.equal(T.status(root, 0).unlocked, false); assert.equal(T.status(root, 0).limit, 1);
  assert.doesNotThrow(() => T.assertCanAdd(root, 0));
  assert.throws(() => T.assertCanAdd(root, 1), (e) => e.code === 'TAKEOUT' && /Takeout lifts the limit/.test(e.message));
  await assert.rejects(T.write(root, 'cob1.nope.nope'), /isn't a Takeout key/);
  assert.equal(fs.existsSync(path.join(root, T.FILE)), false);
});
