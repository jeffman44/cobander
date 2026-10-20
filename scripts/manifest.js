'use strict';
// Writes release/latest.json for the in-app updater (see src/updater.js).
// Notes come from the top "## <version>" section of CHANGELOG.md (one bullet = one note).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ver = process.argv[2] || require('../package.json').version;
const root = path.join(__dirname, '..');
const rel = path.join(root, 'release');

function notesFor(v) {
  const txt = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const re = new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm');
  const m = re.exec(txt);
  if (!m) throw new Error(`CHANGELOG.md has no "## ${v}" section`);
  return m[1].split('\n').filter((l) => /^\s*[-*] /.test(l)).map((l) => l.replace(/^\s*[-*] /, '').trim());
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const files = { 'win-x64': `Cobander-${ver}-win-x64.exe`, 'mac-arm64': `Cobander-${ver}-mac-arm64.zip`, 'mac-x64': `Cobander-${ver}-mac-x64.zip` };
const out = { version: ver, date: new Date().toISOString().slice(0, 10), notes: notesFor(ver), files: {}, size: {}, sha256: {} };
for (const [k, f] of Object.entries(files)) {
  const p = path.join(rel, f);
  if (!fs.existsSync(p)) continue;
  out.files[k] = f; out.size[k] = fs.statSync(p).size; out.sha256[k] = sha(p);
}
if (!Object.keys(out.files).length) throw new Error('no installers in release/');
// Chunked copy (Cobander 0.8.1+ reads it): stable part names, ≤25 MB each, so a release can be published by copying
// small files straight to Drive. Older clients keep using the top-level full installer.
const PART = 25 * 1024 * 1024; const cdir = path.join(rel, 'chunks'); fs.rmSync(cdir, { recursive: true, force: true }); fs.mkdirSync(cdir, { recursive: true });
out.chunked = { version: ver, date: out.date, notes: out.notes, files: {} };
for (const [k, f] of Object.entries(out.files)) {
  const buf = fs.readFileSync(path.join(rel, f)); const parts = [];
  for (let i = 0, n = 0; i < buf.length; i += PART, n++) { const name = `Cobander-${k}.part${String(n).padStart(2, '0')}`; const slice = buf.subarray(i, Math.min(buf.length, i + PART)); fs.writeFileSync(path.join(cdir, name), slice); parts.push({ file: name, size: slice.length }); }
  out.chunked.files[k] = { name: f, size: buf.length, sha256: out.sha256[k], parts };
}
// After the switch-over, the top-level (what older Cobanders read) keeps pointing at the last full installer on Drive.
if (process.env.BRIDGE && fs.existsSync(process.env.BRIDGE)) { const b = JSON.parse(fs.readFileSync(process.env.BRIDGE, 'utf8')); for (const k of ['version', 'date', 'notes', 'files', 'size', 'sha256']) out[k] = b[k]; }
fs.writeFileSync(path.join(rel, 'latest.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`latest.json: ${ver}, ${Object.keys(out.files).join(', ')}, ${out.notes.length} notes`);
