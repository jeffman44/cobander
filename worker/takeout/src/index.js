// Takeout key issuer — a Cloudflare Worker. A sale comes in (Lemon Squeezy or Ko-fi webhook), the Worker signs a
// `cob1.…` key with the same Ed25519 private key as scripts/takeout-key.js, emails it to the buyer, and remembers it
// so a lost key can be re-sent. No database beyond a KV namespace, no server of Jeff's to keep alive.
//
// Secrets (wrangler secret put …):  TAKEOUT_PRIV (base64url raw Ed25519 private key, same as the script's),
//   LS_SIGNING_SECRET (Lemon Squeezy webhook signing secret), KOFI_TOKEN (Ko-fi verification token),
//   RESEND_API_KEY (resend.com), ADMIN_TOKEN (for /lookup and /resend), AGENT_TOKEN (support-drafting task: /inbox only),
//   RESEND_READ_KEY (optional full-access Resend key to read inbound bodies; else RESEND_API_KEY is tried). Vars: FROM (e.g. "Cobander <takeout@cobander.app>"),
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
  const members = splitMembers(claims.members); if (members.length) payload.members = members;
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
// Svix signature (Resend's webhooks): v1 = base64(HMAC-SHA256(secret, `${id}.${ts}.${body}`)), secret is after "whsec_"
async function svixOk(secret, headers, body) {
  try {
    const id = headers.get('svix-id'), ts = headers.get('svix-timestamp'), sigs = headers.get('svix-signature') || '';
    if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const key = await crypto.subtle.importKey('raw', unb64u(secret.replace(/^whsec_/, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${body}`)))));
    return sigs.split(' ').some((s) => s.startsWith('v1,') && timingEq(s.slice(3), mac));
  } catch (_) { return false; }
}
const timingEq = (a, b) => a.length === b.length && [...a].reduce((ok, c, i) => ok & (c === b[i]), 1) === 1;

// Bandmates on the key: "Jeff, Logan & Dan" / ["Jeff","Logan"] → ['Jeff','Logan','Dan'] (max 8, 30 chars each). Must match src/takeout.js.
export function splitMembers(m) { return (Array.isArray(m) ? m : String(m || '').split(/\s*(?:,|;|\/|\band\b|&|\n)\s*/i)).map((x) => String(x || '').trim().slice(0, 30)).filter(Boolean).slice(0, 8); }
// Ko-fi has one message box: "Never a Doubt (Jeff, Logan, Dan, Zach)" — band name, bandmates in parentheses (optional).
export function parseBandMessage(msg) {
  const t = String(msg || '').trim(); const m = /^(.*?)\s*\(([^()]*)\)\s*$/s.exec(t);
  return m && m[1].trim() ? { band: m[1].trim().slice(0, 80), members: splitMembers(m[2]) } : { band: t.split('\n')[0].trim().slice(0, 80), members: splitMembers(t.split('\n').slice(1).join(',')) };
}
// ---- what a sale looks like, from either store ----
// Lemon Squeezy: order_created; the checkout's custom field "band" is the band name. Ko-fi: Shop Order / Donation with the band
// name in the message. Falls back to "<buyer>'s band" so a key still goes out; the band can ask for a rename.
export function saleFromLemon(evt) {
  const a = evt && evt.data && evt.data.attributes; if (!a) return null;
  const custom = (evt.meta && evt.meta.custom_data) || {};
  return { source: 'lemonsqueezy', order: String(evt.data.id), email: a.user_email, name: a.user_name, members: splitMembers(custom.members), band: custom.band || a.user_name && `${a.user_name}'s band`, cents: Number(a.total_usd || a.total || 0), test: !!a.test_mode };
}
export function saleFromKofi(d) {
  if (!d || !d.email) return null;
  const msg = String(d.message || '').trim();
  const pm = parseBandMessage(msg);
  return { source: 'kofi', order: String(d.kofi_transaction_id || d.message_id), email: d.email, name: d.from_name, members: pm.members, band: pm.band || (d.from_name && `${d.from_name}'s band`), cents: Math.round(parseFloat(d.amount || '0') * 100), test: false };
}
export async function issue(sale, env) {
  const tier = sale.cents >= Number(env.ROADIE_CENTS || 6000) ? 'roadie' : 'takeout';
  const key = await sign({ band: sale.band, tier, members: sale.members, email: sale.email, order: sale.order }, env.TAKEOUT_PRIV);
  if (env.PUB && !(await verify(key, env.PUB))) throw new Error('signed a key the app would reject: TAKEOUT_PRIV does not match PUB');
  const rec = { key, tier, band: sale.band, members: splitMembers(sale.members), email: String(sale.email).toLowerCase(), name: sale.name, order: sale.order, source: sale.source, cents: sale.cents, at: new Date().toISOString() };
  if (env.KEYS) { await env.KEYS.put(`order:${sale.source}:${sale.order}`, JSON.stringify(rec)); await env.KEYS.put(`email:${rec.email}`, JSON.stringify(rec)); }
  return rec;
}
export function emailFor(rec) {
  const roadie = rec.tier === 'roadie';
  const text = `Thanks for the noods${rec.name ? `, ${rec.name.split(' ')[0]}` : ''}.

Here's ${rec.band}'s key — one key for the whole band${rec.members && rec.members.length ? ` (${rec.members.join(', ')})` : ''}:

${rec.key}

In Cobander: ⚙ Settings → "Enter a key" (or just make a second song and paste it when it asks). It goes in the shared
band folder, so whoever pastes it unlocks everyone. The key carries your band's name, and Cobander shows it.
Keep it in the band — a key posted publicly gets switched off (you'd get a fresh one).
${roadie ? '\nRoadie: your band goes on the Roadies wall. Reply with how you want the name to read if it\'s different from "' + rec.band + '".\n' : ''}
Lost this email? Reply and it gets re-sent. — Jeff`;
  return { subject: `${rec.band} — your Cobander key (noods received)`, text };
}
async function sendEmail(env, to, { subject, text }) {
  if (!env.RESEND_API_KEY) return { skipped: 'no RESEND_API_KEY' };
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.FROM || 'Cobander <onboarding@resend.dev>', to: [to], subject, text }) });
  if (!r.ok) throw new Error(`email failed: ${r.status} ${await r.text()}`);
  return r.json();
}
// A Roadie sale: Jeff adds the band to docs/roadies.json by hand (so nothing lands on the site unreviewed); this is the nudge.
async function notifyRoadie(env, rec) {
  if (rec.tier !== 'roadie' || !env.NOTIFY) return;
  try { await sendEmail(env, env.NOTIFY, { subject: `New Roadie: ${rec.band}`, text: `${rec.band} (${rec.email}) sent $${(rec.cents / 100).toFixed(2)} via ${rec.source}.\n\nAdd them to docs/roadies.json: { "band": "${rec.band}", "since": "${rec.at.slice(0, 7)}" }` }); } catch (_) {}
}
async function latestRelease(env) {
  const repo = env.REPO || 'jeffman44/cobander';
  if (env.KEYS) { const c = await env.KEYS.get('release:latest'); if (c) return JSON.parse(c); }
  // No API call (unauthenticated GitHub API gets rate-limited from shared IPs): the /releases/latest redirect names the tag,
  // and the asset names follow from the version.
  const r = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', headers: { 'user-agent': 'cobander-takeout' } });
  const loc = r.headers.get('location') || ''; const m = /\/tag\/v?([0-9][^/?#]*)$/.exec(loc);
  if (!m) return null;
  const v = m[1], base = `https://github.com/${repo}/releases/download/v${v}/`;
  const slim = { tag: `v${v}`, assets: [`Cobander-${v}-win-x64.exe`, `Cobander-${v}-mac-arm64.zip`, `Cobander-${v}-mac-x64.zip`, 'latest.json'].map((name) => ({ name, browser_download_url: base + name })) };
  if (env.KEYS) await env.KEYS.put('release:latest', JSON.stringify(slim), { expirationTtl: 600 });
  return slim;
}

// ---- support inbox (noods@ / support@ / hello@ / jeff@) ----
// The Resend webhook stores each real message as KV `inbox:<id>`. A scheduled Claude task reads GET /inbox (AGENT_TOKEN),
// writes a reply with POST /inbox/draft, and the Worker mails Jeff the draft with a link to an approve page. Nothing reaches a
// customer until Jeff presses Send on that page (he can edit the text there first). Statuses: new → drafted → sent | done.
const INBOX_TTL = 60 * 60 * 24 * 120;
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const addr = (x) => (Array.isArray(x) ? x : [x]).filter(Boolean).map(String);
export async function inboxRecord(env, d) {
  const rec = { id: String(d.email_id || d.id), from: addr(d.from).join(', '), to: addr(d.to), subject: d.subject || '(no subject)', at: d.created_at || new Date().toISOString(), status: 'new', text: null, message_id: d.message_id || null };
  const key = env.RESEND_READ_KEY || env.RESEND_API_KEY;
  if (key) {
    try {
      const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(rec.id)}`, { headers: { authorization: `Bearer ${key}` } });
      if (r.ok) {
        const m = await r.json();
        rec.text = String(m.text || (m.html ? String(m.html).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ') : '')).slice(0, 20000);
        rec.message_id = m.message_id || rec.message_id; if (m.reply_to && addr(m.reply_to).length) rec.reply_to = addr(m.reply_to)[0];
        if (m.attachments && m.attachments.length) rec.attachments = m.attachments.map((a) => a.filename).slice(0, 10);
      } else rec.fetch_error = `${r.status}`;
    } catch (e) { rec.fetch_error = String(e.message || e).slice(0, 200); }
  }
  if (env.KEYS) await env.KEYS.put(`inbox:${rec.id}`, JSON.stringify(rec), { expirationTtl: INBOX_TTL });
  return rec;
}
async function inboxGet(env, id) { const raw = env.KEYS && (await env.KEYS.get(`inbox:${id}`)); return raw ? JSON.parse(raw) : null; }
async function inboxPut(env, rec) { await env.KEYS.put(`inbox:${rec.id}`, JSON.stringify(rec), { expirationTtl: INBOX_TTL }); }
export async function inboxList(env, statuses) {
  const out = []; let cursor;
  do { const page = await env.KEYS.list({ prefix: 'inbox:', cursor }); for (const k of page.keys) { const r = await inboxGet(env, k.name.slice(6)); if (r && (!statuses || statuses.includes(r.status))) out.push(r); } cursor = page.list_complete ? null : page.cursor; } while (cursor);
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
export const approveSig = (env, id) => hmacHex(env.ADMIN_TOKEN, `inbox-send:${id}`);
const replyTo = (rec) => { const m = /<([^>]+)>/.exec(rec.reply_to || rec.from); return (m ? m[1] : rec.reply_to || rec.from).trim(); };
const page = (title, body) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#222}pre{white-space:pre-wrap;background:#f4f1ea;padding:12px;border-radius:6px}textarea{width:100%;min-height:260px;font:inherit;padding:10px;box-sizing:border-box}button{font:inherit;padding:10px 18px;margin-right:8px;border-radius:6px;border:0;background:#c0392b;color:#fff;cursor:pointer}button.alt{background:#777}</style>${body}`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') return new Response('cobander takeout issuer', { headers: { 'content-type': 'text/plain' } });

    // Stable download links for the site: /download/win | /download/mac-arm64 | /download/mac-x64 | /download/latest.json
    // → 302 to the matching asset of the latest GitHub release (looked up once every 10 minutes).
    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const want = url.pathname.slice('/download/'.length);
      const rel = await latestRelease(env); if (!rel) return json({ error: 'no release yet' }, 503);
      const pick = want === 'latest.json' ? (a) => a.name === 'latest.json' : want === 'win' ? (a) => /-win-x64\.exe$/.test(a.name) : want === 'mac-arm64' ? (a) => /-mac-arm64\.zip$/.test(a.name) : want === 'mac-x64' ? (a) => /-mac-x64\.zip$/.test(a.name) : null;
      const asset = pick && (rel.assets || []).find(pick);
      if (!asset) return json({ error: 'unknown download', have: (rel.assets || []).map((a) => a.name) }, 404);
      return Response.redirect(asset.browser_download_url, 302);
    }
    // Lemon Squeezy → POST /webhook/lemonsqueezy  (X-Signature = HMAC-SHA256 hex of the raw body)
    if (req.method === 'POST' && url.pathname === '/webhook/lemonsqueezy') {
      const raw = await req.text();
      if (!env.LS_SIGNING_SECRET || !timingEq(await hmacHex(env.LS_SIGNING_SECRET, raw), req.headers.get('x-signature') || '')) return json({ error: 'bad signature' }, 401);
      const evt = JSON.parse(raw); const name = evt.meta && evt.meta.event_name;
      if (name !== 'order_created') return json({ ok: true, ignored: name });
      const sale = saleFromLemon(evt); if (!sale || !sale.email) return json({ error: 'no buyer email' }, 400);
      if (sale.test && env.ALLOW_TEST !== '1') return json({ ok: true, ignored: 'test mode' });
      const rec = await issue(sale, env); const mail = await sendEmail(env, rec.email, emailFor(rec)); await notifyRoadie(env, rec);
      return json({ ok: true, band: rec.band, tier: rec.tier, mail });
    }
    // Ko-fi → POST /webhook/kofi  (form field data=<json>, verification_token inside)
    if (req.method === 'POST' && url.pathname === '/webhook/kofi') {
      const form = await req.formData(); let d; try { d = JSON.parse(form.get('data') || '{}'); } catch (_) { return json({ error: 'bad data' }, 400); }
      if (!env.KOFI_TOKEN || !timingEq(String(d.verification_token || ''), env.KOFI_TOKEN)) return json({ error: 'bad token' }, 401);
      const sale = saleFromKofi(d); if (!sale) return json({ error: 'no buyer email' }, 400);
      if (sale.cents < Number(env.MIN_CENTS || 2500)) return json({ ok: true, ignored: 'under $25 — extra sauce, thanks' });
      const rec = await issue(sale, env); const mail = await sendEmail(env, rec.email, emailFor(rec)); await notifyRoadie(env, rec);
      return json({ ok: true, band: rec.band, tier: rec.tier, mail });
    }
    // Resend → POST /webhook/resend (Svix-signed). Mail to noods@cobander.com lands in Resend's inbox; this pings Jeff so it isn't missed.
    if (req.method === 'POST' && url.pathname === '/webhook/resend') {
      const raw = await req.text();
      if (!env.RESEND_WEBHOOK_SECRET || !(await svixOk(env.RESEND_WEBHOOK_SECRET, req.headers, raw))) return json({ error: 'bad signature' }, 401);
      const evt = JSON.parse(raw);
      if (evt.type === 'email.received' && env.NOTIFY) {
        const d = evt.data || {}; const from = Array.isArray(d.from) ? d.from.join(', ') : String(d.from || '?');
        // Receiving is domain-wide, so spam to made-up addresses arrives too. Only the real mailboxes ring the bell.
        const boxes = String(env.INBOXES || 'noods,support,hello,jeff').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
        const to = (d.to || []).map((x) => String(x).toLowerCase());
        if (!to.some((addr) => boxes.includes(addr.split('@')[0].replace(/^.*</, '')))) return json({ ok: true, ignored: 'not a real mailbox', to });
        if (/no-?reply@|noreply@|notifications?@|newsletter|mailer-daemon/i.test(from)) return json({ ok: true, ignored: 'automated sender' });
        const rec = await inboxRecord(env, d);
        await sendEmail(env, env.NOTIFY, { subject: `[noods] ${rec.subject} — from ${from}`, text: `New mail to ${rec.to.join(', ')} from ${from}.\n\n${rec.text ? rec.text.slice(0, 3000) : '(body not fetched' + (rec.fetch_error ? ': ' + rec.fetch_error : '') + ')'}\n\nA drafted reply will follow for you to approve.` });
      }
      return json({ ok: true });
    }

    // ---- support inbox ----
    // Agent side (Authorization: Bearer AGENT_TOKEN or ADMIN_TOKEN): GET /inbox[?status=new,drafted]  POST /inbox/draft {id, reply}
    //   POST /inbox/done {id, note}  (spam / nothing to answer)
    if (url.pathname === '/inbox' || url.pathname === '/inbox/draft' || url.pathname === '/inbox/done') {
      const auth = req.headers.get('authorization') || '';
      if (!((env.AGENT_TOKEN && auth === `Bearer ${env.AGENT_TOKEN}`) || (env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`))) return json({ error: 'nope' }, 401);
      if (req.method === 'GET' && url.pathname === '/inbox') return json({ items: await inboxList(env, String(url.searchParams.get('status') || 'new').split(',')) });
      if (req.method !== 'POST') return json({ error: 'POST' }, 405);
      const b = await req.json().catch(() => ({})); const rec = b.id && (await inboxGet(env, String(b.id)));
      if (!rec) return json({ error: 'no such message' }, 404);
      if (rec.status === 'sent') return json({ error: 'already answered' }, 409);
      if (url.pathname === '/inbox/done') { rec.status = 'done'; rec.note = String(b.note || '').slice(0, 300); await inboxPut(env, rec); return json({ ok: true }); }
      const reply = String(b.reply || '').trim(); if (!reply) return json({ error: 'reply required' }, 400);
      rec.status = 'drafted'; rec.draft = reply.slice(0, 10000); rec.draftAt = new Date().toISOString(); if (b.note) rec.note = String(b.note).slice(0, 300); await inboxPut(env, rec);
      const link = `${url.origin}/inbox/approve?id=${encodeURIComponent(rec.id)}&sig=${await approveSig(env, rec.id)}`;
      const mail = env.NOTIFY ? await sendEmail(env, env.NOTIFY, { subject: `[noods draft] Re: ${rec.subject}`, text: `${rec.from} wrote:\n\n${(rec.text || '(no text)').slice(0, 4000)}\n\n———— draft reply ————\n\n${rec.draft}\n\n————\n${rec.note ? 'Note: ' + rec.note + '\n' : ''}\nReview, edit and send: ${link}\n(Nothing goes out until you press Send there.)` }) : { skipped: 'no NOTIFY' };
      return json({ ok: true, mail });
    }
    // Jeff's approve page: GET shows the message + an editable draft, POST sends it (link-scanners only ever GET).
    if (url.pathname === '/inbox/approve') {
      const id = String(url.searchParams.get('id') || ''), sig = String(url.searchParams.get('sig') || '');
      if (!env.ADMIN_TOKEN || !id || !timingEq(sig, await approveSig(env, id))) return page('Nope', '<p>That link is not valid.</p>');
      const rec = await inboxGet(env, id); if (!rec) return page('Gone', '<p>That message is gone (older than 120 days?).</p>');
      if (req.method === 'POST') {
        const form = await req.formData(); const act = form.get('act');
        if (rec.status === 'sent') return page('Already sent', `<p>Already sent ${esc(rec.sentAt)}.</p>`);
        if (act === 'done') { rec.status = 'done'; await inboxPut(env, rec); return page('Done', '<p>Marked done — no reply sent.</p>'); }
        const text = String(form.get('reply') || '').trim(); if (!text) return page('Empty', '<p>The reply was empty; nothing sent.</p>');
        const subject = /^re:/i.test(rec.subject) ? rec.subject : `Re: ${rec.subject}`;
        const headers = rec.message_id ? { 'In-Reply-To': rec.message_id, References: rec.message_id } : undefined;
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.FROM, to: [replyTo(rec)], subject, text, ...(headers ? { headers } : {}) }) });
        if (!r.ok) return page('Failed', `<p>Resend said ${r.status}: ${esc(await r.text())}</p>`);
        rec.status = 'sent'; rec.sent = text; rec.sentAt = new Date().toISOString(); await inboxPut(env, rec);
        return page('Sent', `<p>Sent to ${esc(replyTo(rec))}.</p>`);
      }
      return page(`Re: ${rec.subject}`, `<h2>${esc(rec.subject)}</h2><p><b>From</b> ${esc(rec.from)} · ${esc(rec.at)} · <b>${esc(rec.status)}</b></p><pre>${esc(rec.text || '(no text)')}</pre>${rec.note ? `<p><i>${esc(rec.note)}</i></p>` : ''}${rec.status === 'sent' ? `<h3>Sent ${esc(rec.sentAt)}</h3><pre>${esc(rec.sent)}</pre>` : `<form method="post"><h3>Reply to ${esc(replyTo(rec))}</h3><textarea name="reply">${esc(rec.draft || '')}</textarea><p><button name="act" value="send">Send</button><button class="alt" name="act" value="done">No reply needed</button></p></form>`}`);
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
      const rec = await issue({ source: 'manual', order: b.order || `manual-${Date.now()}`, email: b.email, name: b.name, band: b.band, members: splitMembers(b.members), cents: Number(b.cents || 2500) }, env);
      const mail = b.send === false ? { skipped: 'send:false' } : await sendEmail(env, rec.email, emailFor(rec));
      return json({ ok: true, key: rec.key, tier: rec.tier, mail });
    }
    return json({ error: 'not found' }, 404);
  },
};
