// Liberated Pixel Cup characters for the Band page: a "look" (body type, skin, head, hair + colour, beard, face, top, jacket,
// legs, shoes, hat) composited from the sheets scripts/lpc-fetch.js put under lpc/sheets/ (64×64 frames, one PNG per
// item × body type × animation, 4 direction rows). Recolouring = swap the sheet's base palette ramp for the chosen ramp,
// pixel by pixel on an offscreen canvas (cached per sheet + colour). Everything is lazy: render() loads what the look needs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPLPC = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const BASE = 'lpc/', FR = 64, DIRS = { up: 0, left: 1, down: 2, right: 3 };
  // slot → category in the manifest, and which colour key of the look recolours it (by the item's material)
  const SLOTS = [['bodyItem', 'body'], ['head', 'head'], ['face', 'expression'], ['hair', 'hair'], ['beard', 'beard'], ['top', 'clothes'], ['jacket', 'jacket'], ['legs', 'legs'], ['shoes', 'shoes'], ['hat', 'hat']];
  const COLOR_KEY = { top: 'topColor', legs: 'legsColor', shoes: 'shoesColor', hat: 'hatColor' };
  const HEAD_VAR = { heads_human_male: 'male', heads_human_female: 'female' };   // expressions are drawn per human head; other heads have none
  let M = null, loading = null;
  const sheets = new Map(), tinted = new Map();   // path+anim → Promise<ImageData>; +colour → canvas

  function load() {
    if (loading) return loading;
    return (loading = fetch(BASE + 'manifest.json').then((r) => r.json()).then((m) => (M = m)));
  }
  const ready = () => !!M;
  // decode a sheet to ImageData via blob → ImageBitmap so the canvas is never tainted (file:// images would be)
  function sheet(path, anim) {
    const k = path + anim; if (sheets.has(k)) return sheets.get(k);
    const p = fetch(`${BASE}sheets/${path}${anim}.png`).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }).then((b) => createImageBitmap(b)).then((bm) => {
      const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bm, 0, 0); bm.close && bm.close();
      return x.getImageData(0, 0, c.width, c.height);
    }).catch(() => null);
    sheets.set(k, p); return p;
  }
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  // base ramp → target ramp, same index; colours within ±12 per channel of a base colour count (the sheets have a few
  // off-by-a-bit pixels, e.g. hair #a02600 for #a42600); anything else (eyes, outlines) stays
  function tint(img, base, target) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d');
    const out = x.createImageData(img.width, img.height); const d = img.data, o = out.data; const B = base.map(rgb), T = target.map(rgb); const memo = new Map();
    for (let i = 0; i < d.length; i += 4) {
      o[i + 3] = d[i + 3]; if (!d[i + 3]) continue; const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; let t = memo.get(key);
      if (t === undefined) { t = null; let best = 13; for (let j = 0; j < B.length; j++) { const dd = Math.max(Math.abs(B[j][0] - d[i]), Math.abs(B[j][1] - d[i + 1]), Math.abs(B[j][2] - d[i + 2])); if (dd < best) { best = dd; t = T[j] || null; } } memo.set(key, t); }
      if (t) { o[i] = t[0]; o[i + 1] = t[1]; o[i + 2] = t[2]; } else { o[i] = d[i]; o[i + 1] = d[i + 1]; o[i + 2] = d[i + 2]; }
    }
    x.putImageData(out, 0, 0); return c;
  }
  async function tintedSheet(path, anim, item, color) {
    const ramp = color && item.material && M.palettes[item.material].ramps[color]; const k = `${path}${anim}|${ramp ? color : ''}`;
    if (tinted.has(k)) return tinted.get(k);
    const img = await sheet(path, anim); if (!img) return null;
    let c; if (ramp && item.base) c = tint(img, item.base, ramp); else { c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); }
    tinted.set(k, c); return c;
  }
  const hasAnim = (item, path, anim) => item.anims.includes(anim) && !(item.noAnim && item.noAnim[path] && item.noAnim[path].includes(anim));
  // an item drawn for fewer body types borrows the nearest one's sheet (a female top on a teen, a male coat on muscular)
  const NEAR = { male: ['muscular', 'teen', 'female'], female: ['teen', 'male', 'muscular'], muscular: ['male', 'teen', 'female'], teen: ['female', 'male', 'muscular'] };
  const pathFor = (paths, body) => paths[body] || (NEAR[body] || []).map((b) => paths[b]).find(Boolean) || null;
  // the draw list for a look: [{item, path, color, z}] in z order (shadow first)
  function layers(look) {
    const out = []; const push = (id, slot) => { const it = M.items[id]; if (!it) return; const color = it.material === 'body' ? look.skin : it.material === 'hair' ? look.hairColor : it.material === 'cloth' ? look[COLOR_KEY[slot]] : null; for (const L of it.zLayers) { const path = it.byHead ? L.paths[HEAD_VAR[look.head]] : pathFor(L.paths, look.body); if (path) out.push({ item: it, slot, path, color: color || null, z: L.z }); } };
    push('shadow', 'shadow'); for (const [slot] of SLOTS) if (look[slot]) push(look[slot], slot);
    return out.sort((a, b) => a.z - b.z);
  }
  const frames = (anim) => M && M.anims[anim] ? M.anims[anim] : { cols: 1, cycle: [0] };
  // Draw one frame. The body decides the animation (a zombie has no idle → everybody walks); a layer that lacks it stands
  // still (walk column 0) for the idle-ish anims and sits out the big ones (a jacket vanishes mid-jump rather than floats).
  async function render(canvas, look, { anim = 'idle', frame = 0, dir = 'down', scale = 1 } = {}) {
    if (!M) await load(); look = sanitize(look);
    const Ls = layers(look); const body = Ls.find((l) => l.slot === 'bodyItem'); let a = anim; if (body && !hasAnim(body.item, body.path, a)) a = 'walk';
    const F = frames(a); const col = F.cycle[((frame % F.cycle.length) + F.cycle.length) % F.cycle.length]; const row = F.rows === 1 ? 0 : (DIRS[dir] || 0);
    const draws = await Promise.all(Ls.map(async (l) => { let la = a, c = col, r = row; if (!hasAnim(l.item, l.path, a)) { if (a !== 'idle' && a !== 'combat_idle') return null; la = 'walk'; c = 0; r = DIRS[dir] || 0; } const sh = await tintedSheet(l.path, la, l.item, l.color); return sh ? { sh, c, r } : null; }));
    const W = FR * scale; if (canvas.width !== W || canvas.height !== W) { canvas.width = W; canvas.height = W; }
    const x = canvas.getContext('2d'); x.imageSmoothingEnabled = false; x.clearRect(0, 0, W, W);
    for (const d of draws) if (d) x.drawImage(d.sh, d.c * FR, d.r * FR, FR, FR, 0, 0, W, W);
    return canvas;
  }
  // run the cycle on a canvas at ~fps until stop() is called (or the canvas leaves the document)
  function animate(canvas, look, { anim = 'idle', fps = 8, dir = 'down', scale = 1, anims = null } = {}) {
    let k = 0, on = true; const list = anims || [anim]; let ai = 0;
    const tick = () => { if (!on) return; if (!canvas.isConnected) { on = false; return; } const a = list[ai % list.length]; const n = frames(a).cycle.length; render(canvas, look, { anim: a, frame: k, dir, scale }).catch(() => {}); if (++k >= n && list.length > 1) { k = 0; ai++; } };
    tick(); const tm = setInterval(tick, 1000 / fps); return () => { on = false; clearInterval(tm); };
  }
  // deterministic "random" look from a string (a member's name) so everyone has a character before they build one
  function defaultLook(seed) {
    let h = 2166136261; for (const ch of String(seed || '')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0; return h / 4294967296; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)]; const O = options();
    const body = pick(['male', 'female', 'muscular', 'teen']); const fem = body === 'female' || (body === 'teen' && rnd() < 0.5);
    const cloth = O.cloth.filter((c) => c !== 'white');
    return sanitize({
      body, bodyItem: 'body', skin: pick(['light', 'ivory', 'porcelain', 'peach', 'tan', 'tawny', 'honey', 'bronze', 'brown', 'coffee', 'amber', 'olive', 'taupe'].filter((c) => O.skin.includes(c))), head: fem ? 'heads_human_female' : 'heads_human_male',
      hair: pick(O.hair.map((x) => x.id)), hairColor: pick(O.hairColor), beard: !fem && rnd() < 0.35 ? pick(O.beard.map((x) => x.id)) : null, face: pick(O.face.map((x) => x.id)),
      top: pick(O.top.map((x) => x.id)), topColor: pick(cloth), jacket: null, legs: pick(O.legs.map((x) => x.id)), legsColor: pick(['black', 'navy', 'charcoal', 'gray', 'blue', 'leather', 'walnut']), shoes: pick(O.shoes.map((x) => x.id)), shoesColor: pick(['black', 'leather', 'brown', 'charcoal', 'walnut']), hat: rnd() < 0.2 ? pick(O.hat.map((x) => x.id)) : null, hatColor: pick(cloth),
    });
  }
  // everything the builder offers, by category
  function options() {
    const by = (cat) => Object.entries(M.items).filter(([, it]) => it.cat === cat).map(([id, it]) => ({ id, name: it.name, material: it.material }));
    return { body: M.bodies.slice(), bodyItem: by('body'), skin: Object.keys(M.palettes.body.ramps), head: by('head'), hair: by('hair'), hairColor: Object.keys(M.palettes.hair.ramps), beard: by('beard'), face: by('expression'), top: by('clothes'), jacket: by('jacket'), legs: by('legs'), shoes: by('shoes'), hat: by('hat'), cloth: Object.keys(M.palettes.cloth.ramps) };
  }
  // unknown ids / colours fall back to a sensible default; anything not a known key is dropped
  function sanitize(look) {
    const l = look && typeof look === 'object' ? look : {}; const O = options(); const id = (v, cat) => (typeof v === 'string' && M.items[v] && M.items[v].cat === cat ? v : null);
    const color = (v, mat, dflt) => (typeof v === 'string' && M.palettes[mat].ramps[v] ? v : dflt);
    const body = M.bodies.includes(l.body) ? l.body : 'male'; const bodyItem = id(l.bodyItem, 'body') || 'body';
    const head = id(l.head, 'head') || (bodyItem === 'body_zombie' ? 'heads_zombie' : bodyItem === 'body_skeleton' ? 'heads_skeleton' : body === 'female' ? 'heads_human_female' : 'heads_human_male');
    return { body, bodyItem, skin: color(l.skin, 'body', 'light'), head, hair: id(l.hair, 'hair'), hairColor: color(l.hairColor, 'hair', 'brown'), beard: id(l.beard, 'beard'), face: id(l.face, 'expression'), top: id(l.top, 'clothes'), topColor: color(l.topColor, 'cloth', 'black'), jacket: id(l.jacket, 'jacket'), legs: id(l.legs, 'legs'), legsColor: color(l.legsColor, 'cloth', 'navy'), shoes: id(l.shoes, 'shoes'), shoesColor: color(l.shoesColor, 'cloth', 'black'), hat: id(l.hat, 'hat'), hatColor: color(l.hatColor, 'cloth', 'red') };
  }
  const KEYS = ['body', 'bodyItem', 'skin', 'head', 'hair', 'hairColor', 'beard', 'face', 'top', 'topColor', 'jacket', 'legs', 'legsColor', 'shoes', 'shoesColor', 'hat', 'hatColor'];
  const ramp = (mat, name) => (M && M.palettes[mat] && M.palettes[mat].ramps[name]) || null;
  return { load, ready, render, animate, defaultLook, options, sanitize, frames, ramp, KEYS, SLOTS };
});
