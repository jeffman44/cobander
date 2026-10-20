// Context menus: one implementation for every right-click in Cobander.
// BPMenu.show(x, y, items)  items: [{ label, action, disabled?, danger?, checked?, hint?, sub?: items }, 'sep', { title }]
// BPMenu.attach(el, () => items, { onlyIf })  — binds contextmenu (and long-press on touch) on an element.
(function (global) {
  'use strict';
  let root = null, onClose = null;
  function close() { if (root) { root.remove(); root = null; } const ae = document.activeElement; if (ae && ['INPUT', 'SELECT'].includes(ae.tagName) && !ae.closest('dialog') && !(ae.tagName === 'INPUT' && ['number', 'text'].includes(ae.type))) ae.blur(); window.removeEventListener('mousedown', outside, true); window.removeEventListener('keydown', esc, true); window.removeEventListener('blur', close); if (onClose) { const f = onClose; onClose = null; f(); } }
  function outside(e) { if (root && !root.contains(e.target)) close(); }
  function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function build(items, x, y, depth) {
    const m = document.createElement('div'); m.className = 'ctxmenu'; m.style.left = `${x}px`; m.style.top = `${y}px`;
    for (const it of items) {
      if (it === 'sep') { m.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
      if (it.title) { const t = document.createElement('div'); t.className = 'ctx-title'; t.textContent = it.title; m.appendChild(t); continue; }
      const row = document.createElement('div'); row.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '');
      const lab = document.createElement('span'); lab.className = 'ctx-label'; lab.textContent = (it.checked ? '✓ ' : '') + it.label; row.appendChild(lab);
      if (it.hint) { const h = document.createElement('span'); h.className = 'ctx-hint'; h.textContent = it.hint; row.appendChild(h); }
      if (it.sub) { const a = document.createElement('span'); a.className = 'ctx-hint'; a.textContent = '▸'; row.appendChild(a); }
      if (!it.disabled) {
        if (it.sub) {
          let sub = null;
          row.addEventListener('mouseenter', () => { if (sub) return; m.querySelectorAll(':scope > .ctxmenu').forEach((x) => x.remove()); for (const other of m.querySelectorAll(':scope > .ctx-item')) if (other._closeSub) other._closeSub(); const r = row.getBoundingClientRect(); sub = build(it.sub, r.right - 2, r.top - 4, depth + 1); m.appendChild(sub); });
          row._closeSub = () => { if (sub) { sub.remove(); sub = null; } };
          row.addEventListener('mouseleave', (e) => { if (sub && !sub.contains(e.relatedTarget)) { sub.remove(); sub = null; } });
        } else {
          row.addEventListener('click', (e) => { e.stopPropagation(); close(); try { const r = it.action && it.action(); if (r && r.catch) r.catch((err) => console.error(err)); } catch (err) { console.error(err); } });
        }
      }
      m.appendChild(row);
    }
    // keep on screen
    requestAnimationFrame(() => { const r = m.getBoundingClientRect(); if (r.right > window.innerWidth - 4) m.style.left = `${Math.max(4, x - r.width)}px`; if (r.bottom > window.innerHeight - 4) m.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`; });
    return m;
  }
  function show(x, y, items, opts = {}) {
    close();
    if (!items || !items.length) return;
    root = build(items, x, y, 0);
    (document.querySelector('dialog[open]') || document.body).appendChild(root);   // inside an open modal dialog, or it would sit behind it
    onClose = opts.onClose || null;
    setTimeout(() => { window.addEventListener('mousedown', outside, true); window.addEventListener('keydown', esc, true); window.addEventListener('blur', close); }, 0);
  }
  // Right-click (and long-press for touch screens) → menu. `getItems(ev)` returns the items; return null for no menu.
  function attach(el, getItems) {
    el.addEventListener('contextmenu', (e) => { const items = getItems(e); if (!items) return; e.preventDefault(); e.stopPropagation(); show(e.clientX, e.clientY, items); });
    let press = null;
    el.addEventListener('touchstart', (e) => { const t = e.touches[0]; press = setTimeout(() => { const items = getItems({ target: e.target, clientX: t.clientX, clientY: t.clientY, touch: true }); if (items) show(t.clientX, t.clientY, items); }, 550); }, { passive: true });
    el.addEventListener('touchend', () => clearTimeout(press)); el.addEventListener('touchmove', () => clearTimeout(press)); el.addEventListener('touchcancel', () => clearTimeout(press));
  }
  global.BPMenu = { show, close, attach, isOpen: () => !!root };
})(window);
