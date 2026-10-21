// The Worker signs with WebCrypto; the app verifies with Node crypto. They have to agree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const T = require('../../src/takeout');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url');

test('worker: WebCrypto-signed keys verify in the app, and vice versa', async () => {
  const W = await import('../../worker/takeout/src/index.js');
  const k = await W.sign({ band: 'Never a Doubt', tier: 'roadie', email: 'x@y.z', order: '42' }, priv);
  const c = T.verify(k, pub); assert.equal(c.band, 'Never a Doubt'); assert.equal(c.tier, 'roadie'); assert.equal(c.order, '42');
  const k2 = T.sign({ band: 'Other' }, priv); assert.equal((await W.verify(k2, pub)).band, 'Other');
  assert.equal(await W.verify(k.slice(0, -2) + 'AA', pub), null);
});
test('worker: sales map from both stores, tier by amount, KV + email records', async () => {
  const W = await import('../../worker/takeout/src/index.js');
  const ls = W.saleFromLemon({ meta: { event_name: 'order_created', custom_data: { band: 'The Tallboys' } }, data: { id: '7', attributes: { user_email: 'A@B.co', user_name: 'Al', total_usd: 6000, test_mode: false } } });
  assert.equal(ls.band, 'The Tallboys'); assert.equal(ls.cents, 6000);
  const kofi = W.saleFromKofi({ email: 'k@f.i', from_name: 'Kat', amount: '25.00', message: 'Kat & the Kittens', kofi_transaction_id: 'abc' });
  assert.equal(kofi.band, 'Kat & the Kittens'); assert.equal(kofi.cents, 2500);
  const kv = new Map(); const env = { TAKEOUT_PRIV: priv, PUB: pub, KEYS: { put: async (k, v) => kv.set(k, v), get: async (k) => kv.get(k) } };
  const r1 = await W.issue(ls, env); assert.equal(r1.tier, 'roadie'); assert.equal(T.verify(r1.key, pub).band, 'The Tallboys');
  const r2 = await W.issue(kofi, env); assert.equal(r2.tier, 'takeout');
  assert.ok(kv.has('email:a@b.co') && kv.has('order:kofi:abc'));
  const m = W.emailFor(r1); assert.match(m.subject, /Tallboys/); assert.match(m.text, /Roadie/); assert.ok(m.text.includes(r1.key));
  await assert.rejects(W.issue(kofi, { ...env, PUB: T.PUBLIC_KEY }), /does not match PUB/);
});
