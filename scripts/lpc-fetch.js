#!/usr/bin/env node
// Pulls a curated set of Liberated Pixel Cup sprites from the Universal LPC Spritesheet Character Generator site into
// src/renderer/lpc/ (one PNG per item layer × body type × animation, 64×64 frames, 4 direction rows) plus a manifest the
// renderer (src/renderer/lpc.js) composites from, and CREDITS.md with every author of every sheet we ship.
// Run: node scripts/lpc-fetch.js [--dry]. Re-runnable; skips files already on disk. Node built-ins + sharp only.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const SITE = 'https://liberatedpixelcup.github.io/Universal-LPC-Spritesheet-Character-Generator/';
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'lpc'), SHEETS = path.join(OUT, 'sheets');
const DRY = process.argv.includes('--dry');
const BODIES = ['male', 'female', 'muscular', 'teen'];
// the generator's anim id → folder name; cols = frame columns, cycle = frame order the app plays
const ANIMS = { idle: { cols: 2, cycle: [0, 0, 1] }, walk: { cols: 9, cycle: [1, 2, 3, 4, 5, 6, 7, 8] }, jump: { cols: 5, cycle: [0, 1, 2, 3, 4, 1] }, emote: { cols: 3, cycle: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2] }, hurt: { cols: 6, cycle: [0, 1, 2, 3, 4, 5], rows: 1 }, slash: { cols: 6, cycle: [0, 1, 2, 3, 4, 5] }, combat_idle: { cols: 2, cycle: [0, 0, 1], item: 'combat' }, run: { cols: 8, cycle: [0, 1, 2, 3, 4, 5, 6, 7] } };
// the curated set: [itemId, variant?] — variant only matters for items without palette recolors (pre-coloured sheets);
// 'white' variants are the cloth base ramp so they recolor like everything else (verified below by sampling).
const CURATED = {
  body: ['body', 'body_zombie', 'body_skeleton'],
  head: ['heads_human_male', 'heads_human_female', 'heads_zombie', 'heads_skeleton', 'heads_orc_male', 'heads_orc_female', 'heads_wolf_male', 'heads_wolf_female', 'heads_lizard_male', 'heads_lizard_female', 'heads_vampire', 'heads_frankenstein'],
  hair: ['hair_shorthawk', 'hair_longhawk', 'hair_spiked', 'hair_spiked_liberty', 'hair_buzzcut', 'hair_afro', 'hair_dreadlocks_long', 'hair_dreadlocks_short', 'hair_cornrows', 'hair_twists_straight', 'hair_bob', 'hair_ponytail', 'hair_long_tied', 'hair_long_messy', 'hair_messy', 'hair_bedhead', 'hair_balding', 'hair_high_and_tight', 'hair_bangs', 'hair_braid', 'hair_mop'],
  beard: ['beards_5oclock_shadow', 'beards_beard', 'beards_medium', 'beards_trimmed', 'beards_winter'],
  expression: ['face_happy', 'face_angry', 'face_neutral', 'face_closed', 'face_shock'],
  clothes: ['torso_clothes_tshirt', 'torso_clothes_tshirt_vneck', 'torso_clothes_tshirt_scoop', 'torso_clothes_sleeveless', 'torso_clothes_sleeveless_tanktop', 'torso_clothes_sleeveless_striped', 'torso_clothes_longsleeve', 'torso_clothes_longsleeve2_cardigan', 'torso_clothes_blouse', 'torso_clothes_longsleeve_formal', 'torso_clothes_tunic', 'torso_clothes_shortsleeve_polo'],
  jacket: [['torso_jacket_collared', 'black'], ['torso_jacket_trench', 'gray']],
  legs: ['legs_pants', 'legs_cuffed', 'legs_shorts', 'legs_shorts_short', 'legs_leggings', 'legs_skirt_straight', 'legs_skirts_slit'],
  shoes: ['feet_boots_basic', 'feet_shoes_basic', 'feet_boots_revised', 'feet_sandals'],
  hat: [['hat_cap_leather', 'white'], ['hat_formal_bowler', 'base'], ['hat_formal_tophat', 'base'], 'hat_bandana', 'hat_hood_cloth', ['hat_formal_crown', 'crown_gold'], ['hat_magic_wizard', 'white'], ['hat_holiday_christmas', 'red']],
  shadow: ['shadow'],
};
const MAX_BYTES = 6 * 1024 * 1024, MAX_ITEM_BYTES = 300 * 1024;

async function get(url, binary) { const r = await fetch(url); if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { status: r.status }); return binary ? Buffer.from(await r.arrayBuffer()) : r.text(); }
// the generator ships its catalog as hashed ES-module chunks; find them from the page and eval the object literal
async function metadata() {
  const cache = path.join(os.tmpdir(), 'lpc-meta'); fs.mkdirSync(cache, { recursive: true });
  const cached = async (name, url) => { const f = path.join(cache, name); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); const t = await get(url); fs.writeFileSync(f, t); return t; };
  const html = await cached('index.html', SITE); const main = /assets\/(main-[\w-]+\.js)/.exec(html)[1]; const mainJs = await cached(main, SITE + 'assets/' + main);
  const chunk = (kind) => { const m = new RegExp(`(${kind}-metadata-[\\w-]+\\.js)`).exec(mainJs) || new RegExp(`(${kind}-metadata-[\\w-]+\\.js)`).exec(html); if (!m) throw new Error(`no ${kind} chunk`); return m[1]; };
  const load = async (kind, pick) => { let s = await cached(chunk(kind), SITE + 'assets/' + chunk(kind)); s = s.replace(/^import[^;]*;/, '').replace(/var t=e\(\{[^}]*\}\),n=/, 'var n=').replace(/export\{[^}]*\};?\s*$/, ''); return new Function(s + `;return ${pick};`)(); };
  const items = await load('item', 'n'), layers = await load('layers', 'n'), credits = await load('credits', 'n'), palettes = await load('palette', 'e');
  const idx = await cached(chunk('index'), SITE + 'assets/' + chunk('index')); const variants = new Function('return ' + /\bn=(\[\[[\s\S]*?\]\]),/.exec(idx)[1])();
  return { items, layers, credits, palettes: palettes.materials, variants };
}
const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
// what share of a sheet's opaque pixels are in the material's base ramp (so we know recoloring will take)
async function rampCoverage(file, ramp) {
  const sharp = require('sharp'); const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = ramp.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))); let n = 0, hit = 0; const miss = new Map();
  for (let i = 0; i < data.length; i += 4) { if (data[i + 3] < 128) continue; n++; if (rgb.some((c) => Math.abs(c[0] - data[i]) <= 10 && Math.abs(c[1] - data[i + 1]) <= 10 && Math.abs(c[2] - data[i + 2]) <= 10)) hit++; else { const h = hex(data[i], data[i + 1], data[i + 2]); miss.set(h, (miss.get(h) || 0) + 1); } }
  return { n, hit, miss: [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, c]) => `${h}×${c}`), w: info.width, h: info.height };
}

(async () => {
  const { items, layers, credits, palettes, variants } = await metadata();
  const man = { site: SITE, bodies: BODIES, anims: ANIMS, items: {}, palettes: {} };
  for (const mat of ['body', 'hair', 'cloth', 'eye']) { const p = palettes[mat]; man.palettes[mat] = { base: p.palettes.ulpc[p.base], ramps: { ...(p.palettes.lpcr || {}), ...p.palettes.ulpc } }; }
  const log = [], skipped = [], authors = new Map(); let total = 0, files = 0;
  for (const [cat, list] of Object.entries(CURATED)) for (const ent of list) {
    const [id, variant] = Array.isArray(ent) ? ent : [ent, null]; const it = items[id], ly = layers[id];
    if (!it || !ly) { skipped.push(`${id}: not in the catalog`); continue; }
    const material = it.recolors.length ? it.recolors[0].material : (variant === 'white' ? 'cloth' : null);
    const vlist = variants[it.v] || []; const v = it.recolors.length ? null : (variant && vlist.includes(variant) ? variant : vlist[0] || null);
    const anims = Object.keys(ANIMS).filter((a) => it.animations.includes(ANIMS[a].item || a));
    // base = the ramp the sheet is drawn in (an orc head is drawn in body 'green', a zombie head in 'zombie'); the renderer maps base → chosen ramp
    const baseName = it.recolors.length ? it.recolors[0].base.replace(/^ulpc\./, '') : (material ? palettes[material].base : null);
    const entry = { name: it.name, type: it.type_name, cat, material, base: material ? palettes[material].palettes.ulpc[baseName] || null : null, anims, skin: !!it.matchBodyColor, zLayers: [], noAnim: {} };
    if (cat === 'expression') entry.byHead = true;   // path is per head variant (male/female faces), not per body type
    let bytes = 0, bad = false;
    for (let n = 1; ly[`layer_${n}`]; n++) {
      const L = ly[`layer_${n}`]; const paths = {};
      if (entry.byHead) { for (const hv of ['male', 'female']) paths[hv] = L.male.replace('${head}', hv); }
      else for (const bt of BODIES) if (it.required.includes(bt) && L[bt] && !L[bt].includes('${')) paths[bt] = L[bt];
      if (!Object.keys(paths).length) continue;
      entry.zLayers.push({ z: L.zPos, paths });
      for (const p of new Set(Object.values(paths))) for (const a of anims) {
        const url = `${SITE}spritesheets/${p}${a}${v ? '/' + v : ''}.png`, file = path.join(SHEETS, p, `${a}.png`);   // the folder is combat_idle even though items list 'combat'
        if (!fs.existsSync(file)) { if (DRY) { log.push(`would fetch ${url}`); continue; } try { const buf = await get(url, true); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); } catch (e) { log.push(`404 ${url}`); if (a === 'walk' || a === 'idle') bad = true; (entry.noAnim[p] = entry.noAnim[p] || []).push(a); continue; } }
        bytes += fs.statSync(file).size; files++;
      }
    }
    if (bad || !entry.zLayers.length) { skipped.push(`${id}: missing sheets`); continue; }
    if (bytes > MAX_ITEM_BYTES) { skipped.push(`${id}: too big (${(bytes / 1024).toFixed(0)} KB)`); continue; }
    if (!Object.keys(entry.noAnim).length) delete entry.noAnim;
    total += bytes; man.items[id] = entry;
    for (const c of credits[id] || []) for (const a of c.authors || []) authors.set(a, (authors.get(a) || new Set()).add(id));
    // verify the base ramp actually appears in the sheet; a sheet drawn in some other ramp can't be recolored, so drop the material
    if (material && !DRY) { const p0 = Object.values(entry.zLayers[0].paths)[0]; const f = path.join(SHEETS, p0, `${anims.includes('walk') ? 'walk' : anims[0]}.png`); const cov = await rampCoverage(f, entry.base || []); const pct = cov.n ? cov.hit / cov.n : 0; if (pct < 0.5) { log.push(`${id}: only ${(pct * 100).toFixed(0)}% of pixels in the ${material} base ramp (misses ${cov.miss.join(' ')}) → not recolorable`); entry.material = null; } else if (pct < 0.98) log.push(`${id}: ${(pct * 100).toFixed(0)}% in ${material} ramp (misses ${cov.miss.join(' ')})`); }
  }
  if (!DRY) {
    fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(man));
    const lines = [...authors.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([a, ids]) => `- ${a} — ${[...ids].sort().join(', ')}`);
    fs.writeFileSync(path.join(OUT, 'CREDITS.md'), `# Character sprites\n\nThe Band-page characters are built from the Liberated Pixel Cup (LPC) sprite collection, fetched from the\n[Universal LPC Spritesheet Character Generator](${SITE}) by \`scripts/lpc-fetch.js\`.\nLicense: CC-BY-SA 3.0 and GPL 3.0 (dual) — credit "Liberated Pixel Cup contributors"; the full per-item credits live on the\ngenerator's [credits page](${SITE}#credits-section).\n\nAuthors of the sheets Cobander ships (item ids in parentheses are the generator's):\n\n${lines.join('\n')}\n`);
  }
  console.log(`${Object.keys(man.items).length} items, ${files} sheets, ${(total / 1024 / 1024).toFixed(2)} MB${total > MAX_BYTES ? '  ** over budget **' : ''}`);
  for (const l of log) console.log('  ' + l); for (const s of skipped) console.log('  skipped ' + s);
})().catch((e) => { console.error(e); process.exit(1); });
