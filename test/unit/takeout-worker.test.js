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
  const [h, body, sig] = k.split('.'); const other = Buffer.from(JSON.stringify({ band: 'Other', tier: 'roadie' })).toString('base64url');
  assert.equal(await W.verify(`${h}.${other}.${sig}`, pub), null, 'payload swap must fail');
  assert.equal(await W.verify(`${h}.${body}.${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`, pub), null, 'signature flip must fail');
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
test('worker: support inbox — webhook stores, agent drafts, only the signed approve POST sends', async () => {
  const W = (await import('../../worker/takeout/src/index.js')).default;
  const kv = new Map();
  const KEYS = { put: async (k, v) => kv.set(k, v), get: async (k) => kv.get(k) ?? null, list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
  const secret = 'whsec_' + Buffer.from('s3cret-s3cret-s3cret').toString('base64');
  const env = { KEYS, ADMIN_TOKEN: 'adm', AGENT_TOKEN: 'agt', RESEND_API_KEY: 'rk', RESEND_WEBHOOK_SECRET: secret, NOTIFY: 'jeff@x.y', FROM: 'Cobander <noods@cobander.com>', INBOXES: 'noods' };
  const sent = []; const realFetch = global.fetch;
  global.fetch = async (u, o = {}) => {
    if (String(u).includes('/emails/receiving/')) return new Response(JSON.stringify({ text: 'How do I add my drummer?', message_id: '<m1@mail>' }), { status: 200 });
    if (String(u).endsWith('/emails')) { sent.push(JSON.parse(o.body)); return new Response('{"id":"e"}', { status: 200 }); }
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'abc', from: 'Kat <kat@band.co>', to: ['noods@cobander.com'], subject: 'drummer' } });
    const id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
    const mac = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
    let r = await W.fetch(new Request('https://t/webhook/resend', { method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${mac}` } }), env);
    assert.equal(r.status, 200);
    const rec = JSON.parse(kv.get('inbox:abc')); assert.equal(rec.status, 'new'); assert.match(rec.text, /drummer/); assert.equal(sent.length, 1, 'Jeff pinged');
    r = await W.fetch(new Request('https://t/inbox', { headers: { authorization: 'Bearer nope' } }), env); assert.equal(r.status, 401);
    r = await W.fetch(new Request('https://t/inbox', { headers: { authorization: 'Bearer agt' } }), env); assert.equal((await r.json()).items.length, 1);
    r = await W.fetch(new Request('https://t/inbox/draft', { method: 'POST', headers: { authorization: 'Bearer agt' }, body: JSON.stringify({ id: 'abc', reply: 'Band page → Invite.' }) }), env);
    assert.equal(r.status, 200); assert.equal(sent.length, 2); assert.equal(sent[1].to[0], 'jeff@x.y', 'draft goes to Jeff, not Kat');
    const link = /https:\/\/t\/inbox\/approve\?[^\s]+/.exec(sent[1].text)[0];
    r = await W.fetch(new Request(link.replace(/sig=[0-9a-f]+/, 'sig=00')), env); assert.match(await r.text(), /not valid/);
    r = await W.fetch(new Request(link), env); assert.match(await r.text(), /Band page/); assert.equal(sent.length, 2, 'GET never sends');
    const fd = new FormData(); fd.set('act', 'send'); fd.set('reply', 'Band page → Invite. — Jeff');
    r = await W.fetch(new Request(link, { method: 'POST', body: fd }), env); assert.match(await r.text(), /Sent to kat@band\.co/);
    assert.equal(sent[2].to[0], 'kat@band.co'); assert.equal(sent[2].subject, 'Re: drummer'); assert.equal(sent[2].headers['In-Reply-To'], '<m1@mail>');
    r = await W.fetch(new Request(link, { method: 'POST', body: fd }), env); assert.match(await r.text(), /Already sent/); assert.equal(sent.length, 3);
    r = await W.fetch(new Request('https://t/inbox/draft', { method: 'POST', headers: { authorization: 'Bearer agt' }, body: JSON.stringify({ id: 'abc', reply: 'again' }) }), env); assert.equal(r.status, 409);
  } finally { global.fetch = realFetch; }
});
test('worker: bandmates from the Ko-fi message / LS field ride on the key; $25 floor; key verifies in the app with members', async () => {
  const W = await import('../../worker/takeout/src/index.js');
  assert.deepEqual(W.parseBandMessage('Never a Doubt (Jeff, Logan & Dan, Zach)'), { band: 'Never a Doubt', members: ['Jeff', 'Logan', 'Dan', 'Zach'] });
  assert.deepEqual(W.parseBandMessage('The Tallboys'), { band: 'The Tallboys', members: [] });
  assert.deepEqual(W.parseBandMessage('Kat & the Kittens\nKat, Sam'), { band: 'Kat & the Kittens', members: ['Kat', 'Sam'] });
  const k = W.saleFromKofi({ email: 'k@f.i', from_name: 'Kat', amount: '25.00', message: 'Fuzz Lords (Kat, Sam)', kofi_transaction_id: 'z' });
  assert.equal(k.band, 'Fuzz Lords'); assert.deepEqual(k.members, ['Kat', 'Sam']);
  const ls = W.saleFromLemon({ meta: { event_name: 'order_created', custom_data: { band: 'Tallboys', members: 'A, B' } }, data: { id: '9', attributes: { user_email: 'a@b.c', total_usd: 2500 } } });
  assert.deepEqual(ls.members, ['A', 'B']);
  const kv = new Map(); const env = { TAKEOUT_PRIV: priv, PUB: pub, KEYS: { put: async (a, b) => kv.set(a, b), get: async (a) => kv.get(a) } };
  const rec = await W.issue(k, env); const c = T.verify(rec.key, pub); assert.deepEqual(c.members, ['Kat', 'Sam']); assert.equal(c.band, 'Fuzz Lords');
  assert.match(W.emailFor(rec).text, /\(Kat, Sam\)/);
  const Wd = W.default; const form = new FormData(); form.set('data', JSON.stringify({ verification_token: 't', email: 'x@y.z', amount: '12.00', message: 'Cheap' }));
  const r = await Wd.fetch(new Request('https://t/webhook/kofi', { method: 'POST', body: form }), { ...env, KOFI_TOKEN: 't' }); assert.match((await r.json()).ignored, /under \$25/);
});
