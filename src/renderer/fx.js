// Eye candy that never gets in the way: every effect here is additive (pointer-events: none, nothing waits for an
// animation to finish, no handler is delayed), runs on the compositor (transform / opacity via the Web Animations API)
// or on one small canvas, and stops the moment it is not needed. window.BPFx.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPFx = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const doc = typeof document !== 'undefined' ? document : null;
  const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  const el = (cls, text) => { const d = doc.createElement('div'); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---- where the last click / keypress happened: effects start from there ----
  let pointer = { x: 0, y: 0, at: 0 };
  if (doc) {
    doc.addEventListener('pointerdown', (e) => { pointer = { x: e.clientX, y: e.clientY, at: performance.now() }; }, { capture: true, passive: true });
    doc.addEventListener('keydown', () => { const a = doc.activeElement; if (a && a !== doc.body && a.getBoundingClientRect) { const r = a.getBoundingClientRect(); if (r.width) pointer = { x: r.left + r.width / 2, y: r.top + r.height / 2, at: performance.now() }; } }, { capture: true, passive: true });
  }
  const origin = (fallback) => (performance.now() - pointer.at < 4000 && pointer.x ? pointer : fallback);

  // ---- "+25 XP": blooms where you clicked, arcs to the XP chip, bursts into sparks; the chip jolts and its bar sweeps ----
  function xpBurst({ xp, what, target = null, from = null } = {}) {
    if (!doc) return;
    const chip = target || doc.getElementById('xp-chip'); const cr = chip && !chip.hidden ? chip.getBoundingClientRect() : null;
    const dest = cr ? { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 } : { x: innerWidth - 200, y: 48 };
    const src = from || origin({ x: innerWidth / 2, y: innerHeight / 2 });
    const p = el('fx-xp'); p.append(el('fx-xp-n', `+${xp} XP`)); if (what) p.append(el('fx-xp-w', what)); doc.body.append(p);
    p.style.left = `${src.x}px`; p.style.top = `${src.y}px`;
    const dx = dest.x - src.x, dy = dest.y - src.y; const dur = reduced() ? 10 : 950;
    const bulge = -Math.max(80, Math.abs(dx) * 0.25);   // arc height
    const a = p.animate([
      { transform: 'translate(-50%,-50%) scale(.4)', opacity: 0, offset: 0 },
      { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 1, offset: 0.14 },
      { transform: 'translate(-50%,-50%) scale(1.35)', opacity: 1, offset: 0.42 },
      { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55 + bulge}px)) scale(.9)`, opacity: 1, offset: 0.78 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.25)`, opacity: 0.2, offset: 1 },
    ], { duration: dur, easing: 'cubic-bezier(.3,.9,.4,1)', fill: 'forwards' });
    a.onfinish = () => { p.remove(); sparks(dest.x, dest.y, 18, ['#f2b534', '#ffe28a', '#fff', '#d8392b']); if (chip && cr) jolt(chip); };
    // a little glow halo rides along
    const halo = el('fx-xp-halo'); doc.body.append(halo); halo.style.left = `${src.x}px`; halo.style.top = `${src.y}px`;
    halo.animate([{ transform: 'translate(-50%,-50%) scale(.2)', opacity: .9 }, { transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 }], { duration: 520, easing: 'ease-out', fill: 'forwards' }).onfinish = () => halo.remove();
  }
  // the chip: a jolt + a sweep of light across its bar
  function jolt(chip) {
    chip.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: .3 }, { transform: 'scale(.97)', offset: .6 }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
    chip.classList.add('fx-hit'); setTimeout(() => chip.classList.remove('fx-hit'), 700);
    const bar = chip.querySelector('.xp-bar'); if (bar) { const s = el('fx-sheen'); bar.append(s); s.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(220%)' }], { duration: 650, easing: 'ease-out' }).onfinish = () => s.remove(); }
  }
  // confetti-ish sparks from a point (compositor-only transforms)
  function sparks(x, y, n = 14, colors = ['#fff', '#f2b534', '#5b8def', '#ff4d6d'], { size = 6, spread = 70 } = {}) {
    if (!doc || reduced()) return;
    const wrap = el('fx-sparks'); wrap.style.left = `${x}px`; wrap.style.top = `${y}px`; doc.body.append(wrap);
    for (let i = 0; i < n; i++) {
      const s = el('fx-spark'); const a = rnd(0, Math.PI * 2), r = rnd(spread * 0.4, spread); s.style.background = colors[i % colors.length]; const sz = rnd(size * 0.5, size * 1.3); s.style.width = s.style.height = `${sz}px`;
      wrap.append(s);
      s.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${Math.cos(a) * r}px, ${Math.sin(a) * r + 22}px) scale(.2)`, opacity: 0 }], { duration: rnd(420, 760), easing: 'cubic-bezier(.1,.8,.3,1)', fill: 'forwards' });
    }
    setTimeout(() => wrap.remove(), 800);
  }
  // a ripple ring from a point (clicks on transport, arm, etc.)
  function ripple(x, y, color = 'rgba(255,255,255,.55)', size = 44) {
    if (!doc || reduced()) return;
    const r = el('fx-ripple'); r.style.left = `${x}px`; r.style.top = `${y}px`; r.style.width = r.style.height = `${size}px`; r.style.borderColor = color; doc.body.append(r);
    r.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: .9 }, { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 0 }], { duration: 380, easing: 'ease-out', fill: 'forwards' }).onfinish = () => r.remove();
  }
  // pop an element (a button that just toggled, a chip that just changed): quick scale bounce, never blocks input
  function pop(node, amt = 1.18, dur = 220) { if (!node || !node.animate || reduced()) return; node.animate([{ transform: 'scale(1)' }, { transform: `scale(${amt})`, offset: .35 }, { transform: 'scale(1)' }], { duration: dur, easing: 'ease-out' }); }
  // shake a node (wrong move, locked track)
  function shake(node, px = 5) { if (!node || !node.animate || reduced()) return; node.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${px}px)` }, { transform: `translateX(${px}px)` }, { transform: `translateX(-${px * .6}px)` }, { transform: `translateX(${px * .6}px)` }, { transform: 'translateX(0)' }], { duration: 320 }); }
  // flash the whole window edge (a take just landed, a bandmate arrived)
  function edgeFlash(color = 'rgba(242,181,52,.55)', dur = 500) {
    if (!doc || reduced()) return; const f = el('fx-edge'); f.style.boxShadow = `inset 0 0 90px 10px ${color}`; doc.body.append(f);
    f.animate([{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 0 }], { duration: dur, easing: 'ease-out', fill: 'forwards' }).onfinish = () => f.remove();
  }
  // "count up" a number in a text node (XP totals, levels) — a few frames, then the real value
  function countTo(node, to, { from = null, dur = 600, fmt = (v) => String(v) } = {}) {
    if (!node) return; const start = from == null ? Number(String(node.textContent).replace(/[^\d.-]/g, '')) || 0 : from; const t0 = performance.now();
    if (reduced() || !Number.isFinite(start) || start === to) { node.textContent = fmt(to); return; }
    const step = () => { const k = Math.min(1, (performance.now() - t0) / dur); const e = 1 - Math.pow(1 - k, 3); node.textContent = fmt(Math.round(start + (to - start) * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  // ---- neon lightning around the track that is recording ----
  // One canvas over #arrange, sized to the row's visible rectangle. Each edge is a jagged polyline whose kinks drift
  // with time; a few bolts arc inward. Drawn at ~30 fps while recording, with a wide soft pass + a thin hot core.
  const neon = {
    cv: null, host: null, row: null, raf: 0, last: 0, t0: 0, seed: 0,
    start(host, row, { colors = ['#19f1ff', '#ff3df0', '#ffffff'] } = {}) {
      if (!doc) return; this.stop(); this.host = host; this.row = row; this.colors = colors; this.t0 = performance.now(); this.seed = Math.random() * 1000;
      const cv = doc.createElement('canvas'); cv.className = 'fx-neon'; host.append(cv); this.cv = cv;
      const loop = (now) => { if (!this.cv) return; this.raf = requestAnimationFrame(loop); if (now - this.last < 33) return; this.last = now; this.draw(now); };
      this.raf = requestAnimationFrame(loop);
    },
    retarget(row) { this.row = row; },
    stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; if (this.cv) this.cv.remove(); this.cv = null; this.row = null; this.host = null; },
    draw(now) {
      const cv = this.cv, host = this.host, row = this.row; if (!cv || !host || !row || !row.isConnected) { if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
      const sl = host.scrollLeft, st = host.scrollTop, vw = host.clientWidth, vh = host.clientHeight;
      const top = row.offsetTop, h = row.offsetHeight; const y0 = Math.max(top, st - 20), y1 = Math.min(top + h, st + vh + 20); if (y1 <= y0) { cv.width = 1; return; }
      const pad = 12; const W = vw + pad * 2, H = (y1 - y0) + pad * 2;
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      cv.style.left = `${sl - pad}px`; cv.style.top = `${y0 - pad}px`;
      const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
      const t = (now - this.t0) / 1000; const x0 = pad, x1 = W - pad, ya = pad + (top - y0), yb = pad + (Math.min(top + h, y1) - y0);
      const edges = [[x0, ya, x1, ya], [x1, ya, x1, yb], [x1, yb, x0, yb], [x0, yb, x0, ya]];
      const noise = (i, k) => Math.sin(i * 1.7 + t * 9 + k) * 0.5 + Math.sin(i * 3.1 - t * 13 + k * 2) * 0.3 + Math.sin(i * 0.7 + t * 5 + k * 3) * 0.2;
      const path = (amp, seg) => { g.beginPath(); for (const [ax, ay, bx, by] of edges) { const len = Math.hypot(bx - ax, by - ay); const n = Math.max(4, Math.floor(len / seg)); const nx = -(by - ay) / len, ny = (bx - ax) / len; for (let i = 0; i <= n; i++) { const k = i / n; const d = i === 0 || i === n ? 0 : noise(i + this.seed, k * 10) * amp; const px = ax + (bx - ax) * k + nx * d, py = ay + (by - ay) * k + ny * d; if (i === 0) g.moveTo(px, py); else g.lineTo(px, py); } } g.closePath(); };
      g.lineJoin = 'round'; g.lineCap = 'round'; g.globalCompositeOperation = 'lighter';
      const [c1, c2, c3] = this.colors; const pulse = 0.7 + 0.3 * Math.sin(t * 6);
      g.globalAlpha = 0.18 * pulse; g.strokeStyle = c1; g.lineWidth = 14; path(6, 26); g.stroke();
      g.globalAlpha = 0.35; g.strokeStyle = c2; g.lineWidth = 5; path(7, 18); g.stroke();
      g.globalAlpha = 0.95; g.strokeStyle = c3; g.lineWidth = 1.6; path(7, 18); g.stroke();
      g.globalAlpha = 0.8; g.strokeStyle = c1; g.lineWidth = 1; path(9, 12); g.stroke();
      // bolts: short branches that flicker off the outline toward the inside
      const nb = 2 + Math.floor((Math.sin(t * 7.3 + this.seed) + 1) * 2);
      for (let b = 0; b < nb; b++) {
        const ph = (t * 1.9 + b * 0.37 + this.seed) % 1; const [ax, ay, bx, by] = edges[b % 4]; const sx = ax + (bx - ax) * ph, sy = ay + (by - ay) * ph;
        const len = Math.hypot(bx - ax, by - ay); const nx = (by - ay) / len, ny = -(bx - ax) / len;   // inward normal (edges run clockwise)
        g.beginPath(); g.moveTo(sx, sy); let px = sx, py = sy; const L = 10 + 26 * Math.abs(Math.sin(t * 11 + b));
        for (let i = 1; i <= 5; i++) { px = sx + nx * (L * i / 5) + (ny * noise(i + b * 5, t * 3)) * 9; py = sy + ny * (L * i / 5) + (nx * noise(i * 2 + b, t * 2)) * 9; g.lineTo(px, py); }
        g.strokeStyle = c3; g.lineWidth = 1.2; g.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 17 + b * 2)); g.stroke();
        g.strokeStyle = c2; g.lineWidth = 3; g.globalAlpha = 0.25; g.stroke();
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    },
  };

  // ---- beat pulse: called by the app on every beat with the beat index; nudges the given nodes ----
  function beat(nodes, accent = false) {
    if (reduced()) return;
    for (const n of nodes) { if (!n || !n.animate) continue; n.animate([{ transform: `scale(${accent ? 1.12 : 1.06})` }, { transform: 'scale(1)' }], { duration: accent ? 260 : 180, easing: 'ease-out' }); }
  }

  return { xpBurst, sparks, ripple, pop, shake, edgeFlash, countTo, neon, beat, jolt, origin, reduced };
});
