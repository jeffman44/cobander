// Takeout — the one paid thing. Free Cobander is the whole app with ONE song per shared folder; a Takeout key
// (one per band, lives in <Shared>/_takeout.json so whoever pastes it unlocks everyone) lifts the limit.
//
// A key is `cob1.<payload>.<sig>`: payload = base64url JSON { band, tier, iat, members?, email?, order? }, sig = Ed25519 over the
// payload bytes with the owner's private key (scripts/takeout-key.js, or the Worker in worker/takeout). The app only
// holds the public key, verifies offline, never phones home, and nothing expires. The source is MIT, so this check
// is one function anyone can delete — it's a tip jar with a nudge, not DRM.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY = process.env.COBANDER_TAKEOUT_PUB || '6VNy5P50t96e5vKcEvpOGArFlX8z5l6t7Gak4JCBg1M';   // Ed25519, base64url raw 32 bytes (env override is for the test harness)
const FILE = '_takeout.json';
const FREE_SONGS = 1;
const TIERS = { takeout: 'Roadie', roadie: 'VIP' };   // tier ids stay 'takeout' (keys already issued carry them); the label is what people see

// Leaked keys: cobander.com/revoked.json lists fingerprints (sha256 of the key, 16 hex — one-way, reveals nothing).
// Main fetches it read-only and hands it here; a revoked key drops its folder back to free (songs already there stay).
let revoked = new Set();
function fingerprint(key) { return crypto.createHash('sha256').update(String(key || '').replace(/\s+/g, '')).digest('hex').slice(0, 16); }
function setRevoked(list) { revoked = new Set((Array.isArray(list) ? list : []).map((x) => String(x && x.fp || x).toLowerCase()).filter((x) => /^[0-9a-f]{16}$/.test(x))); }
const isRevoked = (key) => revoked.has(fingerprint(key));
const cleanMembers = (m) => (Array.isArray(m) ? m : []).map((x) => String(x || '').trim().slice(0, 30)).filter(Boolean).slice(0, 8);

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function spki(raw) { return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' }); }
function pkcs8(raw) { return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]), format: 'der', type: 'pkcs8' }); }

// Make a key. `priv` is the base64url raw private key (32 bytes). Used by the script and the Worker's Node twin.
function sign(claims, priv) {
  const band = String(claims.band || '').trim();
  if (!band) throw new Error('band name required');
  const payload = { band, tier: TIERS[claims.tier] ? claims.tier : 'takeout', iat: claims.iat || new Date().toISOString().slice(0, 10) };
  const members = cleanMembers(claims.members); if (members.length) payload.members = members;
  if (claims.email) payload.email = String(claims.email).trim().toLowerCase();
  if (claims.order) payload.order = String(claims.order);
  const body = Buffer.from(JSON.stringify(payload));
  const sig = crypto.sign(null, body, pkcs8(Buffer.from(priv, 'base64url')));
  return `cob1.${b64u(body)}.${b64u(sig)}`;
}

// Check a key. Returns the claims, or null. Whitespace/line breaks from a pasted email are tolerated.
function verify(key, pub = PUBLIC_KEY) {
  try {
    const s = String(key || '').replace(/\s+/g, '');
    const m = /^cob1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(s);
    if (!m) return null;
    const body = Buffer.from(m[1], 'base64url'), sig = Buffer.from(m[2], 'base64url');
    if (sig.length !== 64) return null;
    if (!crypto.verify(null, body, spki(Buffer.from(pub, 'base64url')), sig)) return null;
    const claims = JSON.parse(body.toString('utf8'));
    if (!claims || typeof claims.band !== 'string' || !claims.band) return null;
    claims.tier = TIERS[claims.tier] ? claims.tier : 'takeout'; claims.members = cleanMembers(claims.members);
    return claims;
  } catch (_) { return null; }
}

// ---- the band folder's key ----
function filePath(root) { return path.join(root, FILE); }
function readSync(root) {
  try { const j = JSON.parse(fs.readFileSync(filePath(root), 'utf8')); const claims = verify(j.key); return claims ? { key: j.key, ...claims } : null; } catch (_) { return null; }
}
async function write(root, key) {
  const claims = verify(key);
  if (!claims) throw new Error('That isn\'t a Send noods key. Keys look like cob1.xxxx.xxxx — paste the whole thing from the email.');
  if (isRevoked(key)) throw new Error('That key was switched off after it was posted publicly. If it\'s yours, email noods@cobander.com and you\'ll get a fresh one.');
  const tmp = filePath(root) + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify({ key: String(key).replace(/\s+/g, ''), band: claims.band, tier: claims.tier, added: new Date().toISOString() }, null, 2));
  await fs.promises.rename(tmp, filePath(root));
  return claims;
}

// What the UI shows and what createSong asks: { unlocked, revoked, tier, band, members, songs, limit }.
function status(root, songCount) {
  let k = root ? readSync(root) : null; const rev = !!(k && isRevoked(k.key)); const keyBand = k ? k.band : null; if (rev) k = null;
  return { unlocked: !!k, revoked: rev, tier: k ? k.tier : 'free', tierName: k ? TIERS[k.tier] : 'Groupie', band: k ? k.band : null, members: k ? k.members || [] : [], leakedFrom: rev ? keyBand : null, songs: songCount, limit: k ? null : FREE_SONGS };
}
// Throws the error the renderer turns into the Takeout dialog when a free folder already holds its song.
function assertCanAdd(root, songCount) {
  const st = status(root, songCount);
  if (st.unlocked || songCount < FREE_SONGS) return st;
  const err = new Error(`Groupie (free) Cobander keeps one song per band folder. Send noods lifts the limit — one key for the whole band.`);
  err.code = 'TAKEOUT'; err.status = st;
  throw err;
}

module.exports = { PUBLIC_KEY, FILE, FREE_SONGS, TIERS, sign, verify, readSync, write, status, assertCanAdd, fingerprint, setRevoked, isRevoked };
