// Takeout key issuer — a Cloudflare Worker. A sale comes in (Lemon Squeezy or Ko-fi webhook), the Worker signs a
// `cob1.…` key with the same Ed25519 private key as scripts/takeout-key.js, emails it to the buyer, and remembers it
// so a lost key can be re-sent. No database beyond a KV namespace, no server of Jeff's to keep alive.
//
// Secrets (wrangler secret put …):  TAKEOUT_PRIV (base64url raw Ed25519 private key, same as the script's),
//   LS_SIGNING_SECRET (Lemon Squeezy webhook signing secret), KOFI_TOKEN (Ko-fi verification token),
//   RESEND_API_KEY (resend.com), ADMIN_TOKEN (for /lookup and /resend). Vars: FROM (e.g. "Cobander <takeout@cobander.app>"),
//   PUB (the app's public key — the Worker refuses to start issuing keys that the app wouldn't accept), ROADIE_CENTS (default 6000).
// KV binding: KEYS.

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const PKCS8 = '302e020100300506032b657004220420', SPKI = '302a300506032b6570032100';
const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

export async function sign(claims, privB64u) {
  const band = String(claims.band || '').trim(); if (!band) throw new Error('band name required');
  const payload = { band, tier: claims.tier === 'roadie' ? 'roadie' : 'takeout', iat: claims.iat || new Date().toISOString().slice(0, 10) };
  if (claims.email) payload.email = String(claims.email).trim().toLowerCase();
  if (claims.order) payload.order = String(claims.order);
  const key = await crypto.subtle.importKey('pkcs8', cat(hex(PKCS8), unb64u(privB64u)), { name: 'Ed25519' }, false, ['sign']);
  const body = enc.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, body);
  return `cob1.${b64u(body)}.${b64u(sig)}`;
}
export async function verify(keyStr, pubB64u) {
  try {
    const m = /^cob1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(keyStr || '').replace(/\s+/g, '')); if (!m) return null;
    const key = await crypto.subtle.importKey('spki', cat(hex(SPKI), unb64u(pubB64u)), { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64u(m[2]), unb64u(m[1])))) return null;
    return JSON.parse(new TextDecoder().decode(unb64u(m[1])));
  } catch (_) { return null; }
}
async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const timingEq = (a, b) => a.length === b.length && [...a].reduce((ok, c, i) => ok & (c === b[i]), 1) === 1;

// ---- what a sale looks like, from either store ----
// Lemon Squeezy: order_created; the checkout's custom field "band" is the band name. Ko-fi: Shop Order / Donation with the band
// name in the message. Falls back to "<buyer>'s band" so a key still goes out; the band can ask for a rename.
export function saleFromLemon(evt) {
  const a = evt && evt.data && evt.data.attributes; if (!a) return null;
  const custom = (evt.meta && evt.meta.custom_data) || {};
  return { source: 'lemonsqueezy', order: String(evt.data.id), email: a.user_email, name: a.user_name, band: custom.band || a.user_name && `${a.user_name}'s band`, cents: Number(a.total_usd || a.total || 0), test: !!a.test_mode };
}
export function saleFromKofi(d) {
  if (!d || !d.email) return null;
  const msg = String(d.message || '').trim();
  return { source: 'kofi', order: String(d.kofi_transaction_id || d.message_id), email: d.email, name: d.from_name, band: msg.slice(0, 80) || (d.from_name && `${d.from_name}'s band`), cents: Math.round(parseFloat(d.amount || '0') * 100), test: false };
}
export async function issue(sale, env) {
  const tier = sale.cents >= Number(env.ROADIE_CENTS || 6000) ? 'roadie' : 'takeout';
  const key = await sign({ band: sale.band, tier, email: sale.email, order: sale.order }, env.TAKEOUT_PRIV);
  if (env.PUB && !(await verify(key, env.PUB))) throw new Error('signed a key the app would reject: TAKEOUT_PRIV does not match PUB');
  const rec = { key, tier, band: sale.band, email: String(sale.email).toLowerCase(), name: sale.name, order: sale.order, source: sale.source, cents: sale.cents, at: new Date().toISOString() };
  if (env.KEYS) { await env.KEYS.put(`order:${sale.source}:${sale.order}`, JSON.stringify(rec)); await env.KEYS.put(`email:${rec.email}`, JSON.stringify(rec)); }
  return rec;
}
export function emailFor(rec) {
  const roadie = rec.tier === 'roadie';
  const text = `Thanks for the noods${rec.name ? `, ${rec.name.split(' ')[0]}` : ''}.

Here's ${rec.band}'s Takeout key — one key for the whole band:

${rec.key}

In Cobander: ⚙ Settings → "Enter a key" (or just make a second song and paste it when it asks). It goes in the shared
band folder, so whoever pastes it unlocks everyone.
${roadie ? '\nRoadie: your band goes in the credits. Reply with how you want the name to read if it\'s different from "' + rec.band + '".\n' : ''}
Lost this email? Reply and it gets re-sent. — Jeff`;
  return { subject: `${rec.band} — your Cobander Takeout key`, text };
}
async function sendEmail(env, to, { subject, text }) {
  if (!env.RESEND_API_KEY) return { skipped: 'no RESEND_API_KEY' };
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.FROM || 'Cobander <onboarding@resend.dev>', to: [to], subject, text }) });
  if (!r.ok) throw new Error(`email failed: ${r.status} ${await r.text()}`);
  return r.json();
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return new Response('cobander takeout issuer', { headers: { 'content-type': 'text/plain' } });

    // Lemon Squeezy → POST /webhook/lemonsqueezy  (X-Signature = HMAC-SHA256 hex of the raw body)
    if (req.method === 'POST' && url.pathname === '/webhook/lemonsqueezy') {
      const raw = await req.text();
      if (!env.LS_SIGNING_SECRET || !timingEq(await hmacHex(env.LS_SIGNING_SECRET, raw), req.headers.get('x-signature') || '')) return json({ error: 'bad signature' }, 401);
      const evt = JSON.parse(raw); const name = evt.meta && evt.meta.event_name;
      if (name !== 'order_created') return json({ ok: true, ignored: name });
      const sale = saleFromLemon(evt); if (!sale || !sale.email) return json({ error: 'no buyer email' }, 400);
      if (sale.test && env.ALLOW_TEST !== '1') return json({ ok: true, ignored: 'test mode' });
      const rec = await issue(sale, env); const mail = await sendEmail(env, rec.email, emailFor(rec));
      return json({ ok: true, band: rec.band, tier: rec.tier, mail });
    }
    // Ko-fi → POST /webhook/kofi  (form field data=<json>, verification_token inside)
    if (req.method === 'POST' && url.pathname === '/webhook/kofi') {
      const form = await req.formData(); let d; try { d = JSON.parse(form.get('data') || '{}'); } catch (_) { return json({ error: 'bad data' }, 400); }
      if (!env.KOFI_TOKEN || !timingEq(String(d.verification_token || ''), env.KOFI_TOKEN)) return json({ error: 'bad token' }, 401);
      const sale = saleFromKofi(d); if (!sale) return json({ error: 'no buyer email' }, 400);
      if (sale.cents < Number(env.MIN_CENTS || 1200)) return json({ ok: true, ignored: 'below the Takeout minimum — a tip, thanks' });
      const rec = await issue(sale, env); const mail = await sendEmail(env, rec.email, emailFor(rec));
      return json({ ok: true, band: rec.band, tier: rec.tier, mail });
    }
    // Jeff's side: GET /lookup?email=  and POST /resend?email=   (Authorization: Bearer ADMIN_TOKEN)
    if (url.pathname === '/lookup' || url.pathname === '/resend') {
      if (!env.ADMIN_TOKEN || (req.headers.get('authorization') || '') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'nope' }, 401);
      const email = String(url.searchParams.get('email') || '').toLowerCase(); const raw = env.KEYS && (await env.KEYS.get(`email:${email}`));
      if (!raw) return json({ error: 'no key for that email' }, 404);
      const rec = JSON.parse(raw);
      if (url.pathname === '/resend' && req.method === 'POST') return json({ ok: true, mail: await sendEmail(env, rec.email, emailFor(rec)) });
      return json(rec);
    }
    // POST /issue {band, email, tier, cents}  (admin) — a manual sale (Venmo, cash at a show)
    if (req.method === 'POST' && url.pathname === '/issue') {
      if (!env.ADMIN_TOKEN || (req.headers.get('authorization') || '') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'nope' }, 401);
      const b = await req.json(); if (!b.band || !b.email) return json({ error: 'band and email required' }, 400);
      const rec = await issue({ source: 'manual', order: b.order || `manual-${Date.now()}`, email: b.email, name: b.name, band: b.band, cents: Number(b.cents || 2500) }, env);
      const mail = b.send === false ? { skipped: 'send:false' } : await sendEmail(env, rec.email, emailFor(rec));
      return json({ ok: true, key: rec.key, tier: rec.tier, mail });
    }
    return json({ error: 'not found' }, 404);
  },
};
