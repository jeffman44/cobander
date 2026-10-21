// Cobander UI + glue between the engine (audio) and main process (disk, locks, API).
(function () {
  'use strict';
  window.__errs = [];   // renderer errors, read by the e2e test and handy in a support screenshot
  window.addEventListener('error', (e) => window.__errs.push(String(e.message || e)));
  window.addEventListener('unhandledrejection', (e) => window.__errs.push(`unhandled: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const { Engine, dbToGain, num, clamp, validTimeSig, audioId } = window.BPEngine;
  const bp = window.bandpad;
  const CB = window.BPCollab;

  const engine = new Engine();
  const state = {
    trackH: 84,   // track row height in px (Dan: fit more on screen) — thin / regular / thick noodles
    settings: null,
    songs: [],
    folder: null,        // open song folder name
    song: null,          // song.json object (authoritative copy of non-engine fields)
    readOnly: false,
    lock: null,
    dirty: false,
    selectedTrack: null,
    selectedClip: null,
    armedTrack: null,
    pxPerSec: 40,
    snapMode: (() => { try { return localStorage.getItem('bp.snapMode') || 'auto'; } catch (_) { return 'auto'; } })(),
    missingClips: new Set(),
    bounces: [],
    unreferenced: [],
    pendingExternal: null,   // { rev, saveId, savedBy, savedAt, conflict?, deleted?, older?, deferred? }
    lastSaveError: null,
    saving: false,
    autosaveTimer: null,
    undo: [],                // snapshots of collectSong(), newest last
    redo: [],
    snapshots: [],           // named snapshots for the API / user
    pendingTakes: new Map(), // clipId -> {wav ArrayBuffer, trackId, clip}: takes whose WAV write failed; retried on every save
    savePromise: null,
    stashedExternal: null,   // external change that arrived while saving
    pendingActivity: [],     // labels of changes since the last save; become one activity-feed entry on save
    lastSeenAtOpen: null,    // when I last had this song open (mentions newer than this are "new")
    ab: null,                // { id, name, current: songJson } while A/B-ing against a tagged version
    showResolved: false,
  };
  const HEAD_W = 200;
  const MOD = bp.platform === 'darwin' ? 'Cmd' : 'Ctrl';

  // ---------- status ----------
  let statusTimer = null;
  function status(msg, ms = 4000) { $('#status').textContent = msg; clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(() => { if ($('#status').textContent === msg) $('#status').textContent = ''; }, ms); }
  function fail(err) { console.error(err); const m = (err && err.message ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); status(m, 8000); toast(m, { kind: 'bad', ms: 12000 }); }
  // Toast: the status line is easy to miss, so anything the user must notice goes here too.
  function toast(text, { kind = '', ms = 6000, buttons = [], onClose = null } = {}) {
    const box = $('#toasts'); const t = el('div', `toast ${kind}`.trim());
    t.append(el('div', 'toast-text', text));
    if (buttons.length) { const row = el('div', 'toast-btns'); for (const [label, fn] of buttons) { const b = el('button', null, label); b.addEventListener('click', () => { Promise.resolve(fn()).catch(fail); if (!b.dataset.keep) close(); }); row.append(b); } t.append(row); }
    const x = el('button', 'toast-x', '✕'); x.title = 'dismiss'; x.addEventListener('click', () => close()); t.append(x);
    let timer = null; const close = () => { clearTimeout(timer); t.remove(); if (onClose) { const f = onClose; onClose = null; f(); } };
    timer = setTimeout(close, ms || 90000);   // "sticky" toasts still go away after a minute and a half, and with the song they belong to
    if (ms) t.dataset.temp = '1'; if (state && state.folder) t.dataset.song = state.folder;
    box.append(t); while (box.children.length > 4) { const victim = box.querySelector('.toast[data-temp]') || box.firstElementChild; victim.remove(); }
    return close;
  }

  // ---------- settings ----------
  async function loadSettings() {
    state.settings = await bp.settings.get();
    $('#who').textContent = state.settings.displayName || 'no name set — click ⚙';
    $('#folder-line').textContent = state.settings.sharedFolder || 'No shared folder yet — open Settings';
    $('#folder-line').title = state.settings.sharedFolder || '';
    engine.offsetManual = state.settings.recordOffsetMs != null; if (engine.offsetManual) engine.recordOffsetMs = state.settings.recordOffsetMs;
    if (state.settings.clickDb != null) engine.click.gainDb = state.settings.clickDb;
    engine.monitorFx = state.settings.monitorFx !== false;
    if (state.settings.clickOutputId && engine.ctx && engine.clickOutputId !== state.settings.clickOutputId) engine.setClickOutput(state.settings.clickOutputId).catch(() => {});
    engine.wantOutput = state.settings.outputDeviceId || null; if (engine.ctx && (engine.outputDeviceId || '') !== (state.settings.outputDeviceId || '')) engine.setOutput(state.settings.outputDeviceId).catch(() => {});
  }

  async function fillInputs() {
    const sel = $('#s-input'); sel.innerHTML = '';
    { const o = el('option', null, 'System default input'); o.value = ''; sel.appendChild(o); }   // placeholders always have value "" so their text is never saved as a device id
    try {
      const inputs = await engine.listInputs();
      for (const i of inputs) { const o = el('option', null, i.label); o.value = i.id; if (i.id === (engine.inputDeviceId || state.settings.inputDeviceId)) o.selected = true; sel.appendChild(o); }
      if (!inputs.length) { const o = el('option', null, 'No inputs found'); o.value = ''; o.disabled = true; sel.appendChild(o); }
    } catch (err) { const o = el('option', null, `Could not list inputs: ${err.message}`); o.value = ''; o.disabled = true; sel.appendChild(o); }
  }
  async function fillOutputs() {
    { const cs = $('#s-clickout'); if (cs) { cs.innerHTML = ''; const o = el('option', null, 'Same as the audio output'); o.value = ''; cs.append(o); try { for (const d of await engine.listOutputs()) { if (d.id === 'default') continue; const x = el('option', null, d.label); x.value = d.id; if (d.id === state.settings.clickOutputId) x.selected = true; cs.append(x); } } catch (_) {} } }
    const sel = $('#s-output'); if (!sel) return; sel.innerHTML = '';
    { const o = el('option', null, 'System default output'); o.value = ''; sel.appendChild(o); }
    try { const outs = await engine.listOutputs(); for (const d of outs) { if (d.id === 'default') continue; const o = el('option', null, d.label); o.value = d.id; if (d.id === (engine.outputDeviceId || state.settings.outputDeviceId)) o.selected = true; sel.appendChild(o); } }
    catch (err) { const o = el('option', null, `Could not list outputs: ${err.message}`); o.value = ''; o.disabled = true; sel.appendChild(o); }
  }
  $('#s-measure').addEventListener('click', async () => {
    const out = $('#s-measure-out'); const b = $('#s-measure'); b.disabled = true; out.textContent = 'Listening… (8 clicks)';
    try {
      await engine.init(); await bp.mic.ensure(); if (!engine.stream) await engine.openInput($('#s-input').value || state.settings.inputDeviceId);
      if ($('#s-output').value !== (engine.outputDeviceId || '')) await engine.setOutput($('#s-output').value).catch(() => {});
      const r = await engine.measureLatency();
      $('#s-offset').value = Math.round(r.ms); out.textContent = `Round trip ${r.ms} ms (clicks: ${r.lags.join(', ')} ms; automatic guess was ${r.auto} ms). Saved when you hit OK — takes now land ${Math.round(r.ms - r.auto) >= 0 ? '+' : ''}${Math.round(r.ms - r.auto)} ms from where the automatic setting put them.`;
    } catch (err) { out.textContent = err.message; }
    b.disabled = false; scheduleInputRelease();
  });

  async function openSettings() {
    const d = $('#settings');
    $('#s-name').value = state.settings.displayName || '';
    $('#s-folder').value = state.settings.sharedFolder || '';
    $('#s-offset').value = engine.offsetManual ? engine.recordOffsetMs : (engine.ctx ? engine.autoOffsetMs() : engine.recordOffsetMs ?? 0);
    $('#s-offset').dataset.shown = $('#s-offset').value; $('#s-offset').title = engine.offsetManual ? 'set by you — clear the box to go back to automatic' : 'automatic: follows your current output (re-measured before every take). Type a number to fix it.';
    $('#s-click').value = engine.click.gainDb; $('#s-monfx').checked = state.settings.monitorFx !== false; $('#s-fanfare').checked = state.settings.fanfare !== false; $('#s-measure-out').textContent = '';
    await fillOutputs();
    { const sel = $('#s-asr'); sel.innerHTML = ''; for (const [k, m] of Object.entries(ASR.MODELS)) { const o = el('option', null, m.label); o.value = k; sel.append(o); } sel.value = asrModel(); bp.asr.cacheInfo().then((i) => { $('#s-asr-info').textContent = i.bytes ? ` ${Math.round(i.bytes / 1e6)} MB of speech models on this computer` : ' not downloaded yet'; }).catch(() => {}); }
    $('#s-drive-warn').hidden = !state.settings.sharedFolder || !!state.settings.driveLike; $('#s-cloud').textContent = state.settings.cloud ? `✓ ${state.settings.cloud.name} folder` : '';
    await fillInputs();
    try { await engine.init(); await engine.initMidi(); const ms = $('#s-midi'); ms.innerHTML = ''; for (const [v, t] of [['', 'none'], ['any', 'any connected MIDI input'], ...engine.midi.inputs.map((i) => [i.id, i.name])]) { const o = el('option', null, t); o.value = v; if (v === (state.settings.midiInputId || '')) o.selected = true; ms.appendChild(o); } if (!engine.midi.access) ms.appendChild(el('option', null, '(Web MIDI not available)')); } catch (_) {}
    renderTakeout();
    bp.shell.roadies().then((list) => { const row = $('#s-roadies'); if (!row) return; row.hidden = !list.length; $('#s-roadies-list').textContent = list.map((b) => b.band).join(' · '); }).catch(() => {});
    const api = await bp.api.info();
    $('#s-api').textContent = (api.running ? `http://127.0.0.1:${api.port}/\ntoken: ${api.token}` : (api.error || `API not running (port ${api.port} busy?)`)) + `\nsettings: ${api.settingsFile}\nfile inbox: ${api.inbox}`;
    d.returnValue = '';
    d.showModal();
    d.addEventListener('close', async function onClose() {
      d.removeEventListener('close', onClose);
      if (d.returnValue !== 'ok') return;
      try {
        const patch = {
          displayName: $('#s-name').value.trim() || null,
          sharedFolder: $('#s-folder').value || null,
          inputDeviceId: $('#s-input').value || null,
          // untouched (or emptied) = automatic per output device; a number you typed = fixed
          recordOffsetMs: $('#s-offset').value === '' || (!engine.offsetManual && $('#s-offset').value === $('#s-offset').dataset.shown) ? null : clamp($('#s-offset').value, 0, 500, 0),
          clickDb: clamp($('#s-click').value, -40, 0, -12),
          midiInputId: $('#s-midi').value || null,
          outputDeviceId: $('#s-output').value || null,
          clickOutputId: $('#s-clickout').value || null,
          monitorFx: $('#s-monfx').checked, fanfare: $('#s-fanfare').checked,
          asrModel: $('#s-asr').value || 'small.en',
        };
        engine.setMonitorFx(patch.monitorFx);
        if ((patch.outputDeviceId || '') !== (engine.outputDeviceId || '')) await engine.setOutput(patch.outputDeviceId).catch((e) => status(`Output: ${e.message}`, 8000));
        if ((patch.clickOutputId || null) !== (engine.clickOutputId || null)) await engine.setClickOutput(patch.clickOutputId).catch((e) => status(`Click output: ${e.message}`, 8000));
        engine.selectMidiInput(patch.midiInputId);
        const folderChanged = patch.sharedFolder !== state.settings.sharedFolder;
        if (folderChanged) { const ok = await closeSong(); if (!ok) { delete patch.sharedFolder; status('Folder not changed: resolve the unsaved changes first. Other settings were saved.'); } }
        state.settings = await bp.settings.set(patch);
        await loadSettings();
        if (!patch.displayName) toast('No name set — bandmates will see you as this computer\'s login name. Set it in Settings any time.', { kind: 'warn', ms: 9000 });
        if (!patch.sharedFolder) toast('No shared band folder yet. Open Settings (gear) and choose the synced folder (Google Drive, OneDrive, iCloud Drive, Dropbox) that the whole band uses.', { kind: 'warn', ms: 12000 });
        engine.applyAll();
        if (engine.stream && patch.inputDeviceId !== engine.inputDeviceId) await engine.openInput(patch.inputDeviceId).catch(fail);
        await refreshSongs();
      } catch (err) { fail(err); }
    });
  }
  $('#s-pick').addEventListener('click', async () => { const p = await bp.settings.pickFolder(); if (p) { $('#s-folder').value = p; const c = cloudOf(p); $('#s-drive-warn').hidden = !!c; $('#s-cloud').textContent = c ? `✓ ${c.name} folder` : ''; } });
  const CLOUD_RE = [['Google Drive', /GoogleDrive|Google Drive|My Drive|Shared drives/i], ['OneDrive', /OneDrive/i], ['iCloud Drive', /com~apple~CloudDocs|iCloud ?Drive|Mobile Documents/i], ['Dropbox', /Dropbox/i], ['Box', /[\\/]Box[\\/]/]];
  const cloudOf = (p) => { for (const [name, re] of CLOUD_RE) if (re.test(String(p || ''))) return { name }; return null; };
  $('#s-refresh-inputs').addEventListener('click', async () => { try { await engine.init(); await bp.mic.ensure(); if (!engine.stream) { await engine.openInput(state.settings.inputDeviceId); scheduleInputRelease(); } await fillInputs(); } catch (err) { fail(err); } });
  $('#btn-settings').addEventListener('click', openSettings);

  // ---------- updates (installers live in <shared folder>/installers, see src/updater.js) ----------
  const upd = { st: null, busy: false };
  function renderUpdate(st) {
    upd.st = st; const bar = $('#update-bar'); bar.innerHTML = ''; bar.className = '';
    $('#s-version').textContent = `Cobander ${st.current}${st.latest && st.available ? ` — ${st.latest} is available` : st.latest ? ' — up to date' : ''}`;
    if (!st.available || (st.snoozed && !['downloading', 'verifying', 'installing', 'error'].includes(st.state))) { bar.hidden = true; return; }
    bar.hidden = false;
    const text = el('span', 'grow');
    const add = (label, fn, cls) => { const b = el('button', cls || '', label); b.addEventListener('click', () => { if (upd.busy) return; fn().catch(fail); }); bar.append(b); return b; };
    if (st.state === 'downloading') { text.textContent = `Getting Cobander ${st.latest} from ${st.source === 'github' ? 'GitHub' : cloudName()}…`; bar.append(text); const p = el('div', 'bar'); const f = el('div'); f.style.width = `${Math.round((st.progress || 0) * 100)}%`; p.append(f); bar.append(p); return; }
    if (st.state === 'verifying') { text.textContent = `Checking Cobander ${st.latest}…`; bar.append(text); return; }
    if (st.state === 'installing') { text.textContent = `Installing Cobander ${st.latest} — Cobander will close and reopen by itself.`; bar.append(text); return; }
    if (st.state === 'error') { bar.className = 'err'; text.textContent = `Update failed: ${st.error}`; bar.append(text); add('Try again', async () => { const s2 = await bp.update.check(); renderUpdate(s2); if (s2.ready) await installUpdate(); else status(s2.reason ? `Update not ready yet: ${s2.reason}` : 'No update waiting.', 8000); }); add('Later', snoozeUpdate, 'quiet'); return; }
    text.textContent = st.ready ? `Cobander ${st.latest} is ready (you have ${st.current}).` : `Cobander ${st.latest} is out (you have ${st.current}) — ${st.reason || `waiting for ${cloudName()}`}.`;
    bar.append(text);
    if (st.ready) add('Update now', installUpdate, 'primary'); else add('Check again', () => bp.update.check(), '');
    if (st.notes && st.notes.length) add("What's new", async () => { await ask(`Cobander ${st.latest}`, st.notes.map((n) => `• ${n}`).join('\n'), [['OK', 'ok', 'primary']]); }, 'quiet');
    add('Later', snoozeUpdate, 'quiet');
  }
  async function installUpdate() {
    if (upd.busy) return; upd.busy = true;
    try {
      if (engine.recording) { status('Stop recording first.'); return; }
      await flushSketch();
      if (state.dirty || state.pendingTakes.size) { const r = await save(); if (r !== 'ok') { status('Could not save your changes — fix the banner, then update.', 8000); return; } }
      await bp.update.install();   // the app quits on success; main waits for saves and releases the lock first
    } catch (err) { fail(err); }
    finally { upd.busy = false; if (upd.st) renderUpdate(upd.st); }   // buttons drawn while busy were disabled: draw them again
  }
  async function snoozeUpdate() { await bp.update.snooze(); }
  bp.update.onStatus(renderUpdate);
  bp.update.status().then(renderUpdate).catch(() => {});
  // public links: GitHub, bugs, the tip jar (Ko-fi shows once package.json names a page)
  for (const b of document.querySelectorAll('.link-btn[data-link]')) b.addEventListener('click', () => bp.shell.openLink(b.dataset.link).catch(fail));
  bp.shell.links().then((l) => { for (const b of document.querySelectorAll('.link-btn[data-link]')) { const k = b.dataset.link; const has = k === 'kofi' ? !!l.kofi : k === 'venmo' ? !!l.venmo : k === 'takeout' ? !!l.takeout : (k === 'openmoji' || k === 'gameicons' || k === 'lpc' || k === 'manual' || k === 'site') ? true : !!l.repo; b.hidden = !has; if (k === 'takeout' && has) b.dataset.has = '1'; } renderTakeout(); }).catch(() => {});
  $('#s-check-update').addEventListener('click', async () => { const b = $('#s-check-update'); b.disabled = true; try { const st = await bp.update.check(); renderUpdate(st); if (!st.available) toast(st.latest ? `You're on the latest (${st.current}).` : 'No installers folder in the shared band folder yet.', { ms: 5000 }); } catch (err) { fail(err); } finally { b.disabled = false; } });

  var MT = window.BPMeter;   // hoisted: used from init-time renders
  function promptName(title, initial = '') {
    return new Promise((resolve) => {
      const d = $('#prompt'); $('#prompt-title').textContent = title; $('#prompt-input').value = initial;
      d.returnValue = ''; d.showModal(); $('#prompt-input').select();
      d.addEventListener('close', function h() { d.removeEventListener('close', h); resolve(d.returnValue === 'ok' ? $('#prompt-input').value.trim() : null); });
    });
  }
  // ---------- Takeout: the free-song gate ----------
  // createSong / restore throw when a free folder already holds its one song; this turns that into the dialog.
  function isTakeoutErr(err) { return /Send noods lifts the limit/.test(err && err.message ? err.message : String(err)); }
  async function takeoutDialog({ hit = false } = {}) {
    const d = $('#takeout'), inp = $('#takeout-key'), errEl = $('#takeout-err');
    inp.value = ''; errEl.hidden = true; d.returnValue = '';
    $('#takeout-title').textContent = hit ? 'That\'s the free song' : 'Send noods';
    return new Promise((resolve) => {
      d.addEventListener('close', async function h() {
        d.removeEventListener('close', h);
        if (d.returnValue !== 'ok') return resolve(false);
        const key = inp.value.trim();
        if (!key) { toast('Paste the key from your Send noods email first.', { kind: 'bad' }); return resolve(false); }
        try { const st = await bp.shell.takeoutEnter(key); await renderTakeout(st); toast(`Noods received! ${st.band} is unlocked — every song you want.`, { ms: 6000 }); resolve(true); }
        catch (err) { fail(err); resolve(false); }
      });
      d.showModal(); setTimeout(() => inp.focus(), 0);
    });
  }
  // Runs a song-adding action; on the free limit, offers Takeout and retries once a key is in.
  async function withTakeout(fn) {
    try { return await fn(); }
    catch (err) { if (!isTakeoutErr(err)) throw err; if (await takeoutDialog({ hit: true })) return fn(); return null; }
  }
  async function renderTakeout(st) {
    try { st = st || await bp.shell.takeout(); } catch (_) { return; }
    const t = st.unlocked ? `${st.tierName}: ${st.band} — unlimited songs. Thanks for the noods.` : `Free Cobander: one song per band folder${st.songs >= (st.limit || 1) ? ' (this folder has its song)' : ''}.`;
    for (const id of ['#s-takeout', '#bp-takeout']) { const n = $(id); if (n) n.textContent = t; }
    const get = $('#s-takeout-get'); if (get) get.hidden = st.unlocked || !get.dataset.has;
    const k = $('#s-takeout-key'); if (k) k.hidden = st.unlocked;
    state.takeout = st;
  }
  $('#s-takeout-key').addEventListener('click', () => takeoutDialog());
  // Three-way question. Returns the value of the chosen button.
  function ask(title, text, buttons) {
    return new Promise((resolve) => {
      const d = $('#ask'); $('#ask-title').textContent = title; $('#ask-text').textContent = text;
      const menu = $('#ask-menu'); menu.innerHTML = '';
      for (const [label, value, cls] of buttons) { const b = el('button', cls, label); b.value = value; menu.appendChild(b); }
      d.returnValue = ''; d.showModal();
      d.addEventListener('close', function h() { d.removeEventListener('close', h); resolve(d.returnValue || null); });
    });
  }

  // ---------- song list ----------
  async function refreshSongs() {
    renderTakeout();
    renderNoSong();
    if (!state.settings.sharedFolder) { state.songs = []; renderSongs(); return; }
    try { state.songs = await bp.songs.list(); } catch (err) { fail(err); state.songs = []; }
    renderSongs(); if (quest) loadQuest();
  }
  const cloudName = () => (state.settings && state.settings.cloud ? state.settings.cloud.name : 'the shared folder');
  function renderNoSong() {
    const ready = state.settings.sharedFolder && state.settings.displayName;
    const h = $('#no-song h2'), p = $('#no-song p');
    if (ready) { h.textContent = 'Pick a song on the left, or start a new one.'; p.innerHTML = 'Everything lives in the band\'s shared folder — whatever one of you noodles, the rest get in seconds. Hit <b>+ track</b> to say what you\'re recording, <b>R</b> to record, <b>Space</b> to play. Just want to mess around? 🎸 opens your Noodle pad.'; }
    else { h.textContent = 'Two things before the first song:'; p.innerHTML = `${state.settings.displayName ? '✓' : '○'} your name (bandmates see it on takes) &nbsp; ${state.settings.sharedFolder ? '✓' : '○'} the band's shared folder (Google Drive, OneDrive, iCloud Drive or Dropbox)<br><br>`; const b = el('button', 'primary', 'Open Settings'); b.addEventListener('click', openSettings); p.append(b); }
  }
  bp.songs.onChanged((songs) => { state.songs = songs; if (quest) loadQuest({ files: false }); renderSongs(); updateBadges(); retryMissingClips(); if (state.song) renderPresence(); waitingCheck(); });
  // read-only and wanted to edit: everyone sees "X is waiting to edit"; when the song frees up you get a nudge
  function waitingCheck() {
    if (!state.waiting) return;
    if (!state.folder || !state.readOnly) { state.waiting = false; bp.presence.set({ mode: 'listening' }).catch(() => {}); return; }
    const s0 = (state.songs || []).find((x) => x.folder === state.folder);
    if (s0 && (!s0.lock || s0.lock.stale) && !state.waitNudged) { state.waitNudged = true; toast(`${state.song ? state.song.name : 'The song'} is free now.`, { kind: 'ok', ms: 0, buttons: [['Take over / edit', () => takeOver()], ['Not now', () => { state.waiting = false; bp.presence.set({ mode: 'listening' }).catch(() => {}); }]] }); }
  }

  function lockBadge(s) {
    const lock = s.lock; if (!lock) return null;
    const b = el('span', 'lock' + (s.lockMine ? ' mine' : lock.stale ? ' stale' : ''));
    b.textContent = s.lockMine ? 'you' : lock.stale ? `${lock.user} (stale)` : s.lockSameMachine ? 'you (old window)' : `${lock.user} has it open`;
    b.title = `Lock: ${lock.user} has had this song open for editing on ${lock.host} since ${new Date(lock.since).toLocaleTimeString()}. While they hold it, others can only record on tracks they unlock.${lock.stale ? ' Their Cobander has not checked in for a while (maybe closed without closing the song), so you can take over safely.' : ''}`;
    return b;
  }

  const STAGES = { idea: '💡 idea', writing: '✍️ writing', demo: '🎙 demo', done: '✅ done' };
  $('#song-stage-filter').addEventListener('change', () => { try { localStorage.setItem('bp.stageFilter', $('#song-stage-filter').value); } catch (_) {} renderSongs(); });
  try { $('#song-stage-filter').value = localStorage.getItem('bp.stageFilter') || ''; } catch (_) {}
  // Band feed: what everyone did across every song (from each song's activity log), newest first, plus who is in
  // which song right now and new parts in the parts bin. Live: it re-draws whenever the song list refreshes.
  function ago(iso) { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); if (!Number.isFinite(s)) return ''; if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)}m`; if (s < 86400) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d`; }
  // minimizable: click the header. Minimized, it shows how many new things happened since you folded it.
  const feedMin = () => { try { return localStorage.getItem('bp.feedMin') === '1'; } catch (_) { return false; } };
  function setFeedMin(on) {
    try { localStorage.setItem('bp.feedMin', on ? '1' : '0'); if (on) localStorage.setItem('bp.feedSeen', new Date().toISOString()); } catch (_) {}
    applyFeedMin(); renderBandFeed();
  }
  function applyFeedMin() { const on = feedMin(); $('#sidebar').classList.toggle('feed-min', on); $('#band-feed-caret').textContent = on ? '▸' : '▾'; }
  $('#band-feed-head').addEventListener('click', () => setFeedMin(!feedMin()));
  applyFeedMin();
  function renderBandFeed() {
    const ul = $('#band-feed'); if (!ul) return; ul.innerHTML = '';
    const rows = bandFeedRows();
    { const badge = $('#band-feed-new'); let seen = ''; try { seen = localStorage.getItem('bp.feedSeen') || ''; } catch (_) {}
      const n = feedMin() ? rows.filter((r) => !r.now && r.at && String(r.at) > seen).length : 0; const live = feedMin() ? rows.filter((r) => r.now).length : 0;
      if (badge) { badge.hidden = !(n || live); badge.textContent = [n ? `${n} new` : '', live ? `${live} in now` : ''].filter(Boolean).join(' · '); } }
    fillFeed(ul, rows, 80);
    if (state.ws === 'band') renderBandPage();
  }
  function bandFeedRows() {
    const rows = [];
    for (const sg of state.songs || []) {
      for (const p of sg.presence || []) rows.push({ now: true, at: new Date().toISOString(), by: p.user, song: sg, what: p.mode === 'recording' ? '● recording now' : p.mode === 'practicing' ? '🎙 rehearsing now' : p.mode === 'editing' ? 'working on it now' : 'listening now' });
      for (const a of sg.recent || []) rows.push({ at: a.at, by: a.by, song: sg, what: a.items.join(' · '), xp: (a.items || []).reduce((n, it) => n + ((Q.xpForLabel(it) || {}).xp || 0), 0) });
    }
    for (const p of state.parts || []) if (p.at) rows.push({ at: p.at, by: p.by, part: p, what: `saved "${p.name}" to the parts bin` });
    if (quest && quest.board) for (const ev of Q.events(quest.fields, quest.board, 30)) rows.push({ at: ev.at, by: ev.by, quest: true, xp: ev.xp, song: ev.song ? (state.songs || []).find((x) => x.name === ev.song) || { name: ev.song } : { name: 'Band' }, what: `⚔ ${ev.what}` });
    rows.sort((a, b) => (b.now ? 1 : 0) - (a.now ? 1 : 0) || String(b.at).localeCompare(String(a.at)));
    return rows;
  }
  function fillFeed(ul, rows, limit) {
    ul.innerHTML = '';
    if (!rows.length) { ul.append(el('li', 'muted', 'Nothing yet — edits, takes and parts from everyone show up here.')); return; }
    for (const r of rows.slice(0, limit)) {
      const li = el('li', r.now ? 'now' : null);
      li.append(el('span', 'bf-when', r.now ? 'now' : ago(r.at)), el('span', 'bf-who', r.by || 'someone'), document.createTextNode(' '), el('span', 'bf-song', r.song ? r.song.name : 'Parts bin'), el('span', 'bf-what', r.what)); if (r.xp) li.append(el('span', 'bf-xp', `+${r.xp} XP`));
      li.title = `${r.by} — ${r.song ? r.song.name : 'parts bin'}: ${r.what}${r.at && !r.now ? `\n${new Date(r.at).toLocaleString()}` : ''}`;
      li.addEventListener('click', () => { if (r.quest && !(r.song && r.song.folder)) { setWorkspace('band'); } else if (r.song && r.song.folder) openSong(r.song.folder).catch(fail); else { setWorkspace('write'); showTab('parts'); } });
      ul.append(li);
    }
  }
  setInterval(() => { if (document.visibilityState === 'visible') renderBandFeed(); }, 30000);
  // ---------- the game layer: XP, levels, achievements, quests (see quest.js) ----------
  // Everything is derived from the songs (BPQuest.songStats runs in the song list); the band's DECISIONS (goals, tasks,
  // boss battle, who's who) live in _quest/<me>.json. UI: the ⚔ Band tab, the level chip in the header, XP bars in the
  // song list, "+XP" pops on your own work, achievements and level-ups as toasts.
  var Q = window.BPQuest;
  var quest = { files: [], fields: new Map(), board: null, open: false, sel: null, timer: null };
  const QSEEN = () => { try { return JSON.parse(localStorage.getItem('bp.questSeen') || '{}'); } catch (_) { return {}; } };
  const qseenSet = (o) => { try { localStorage.setItem('bp.questSeen', JSON.stringify(o)); } catch (_) {} };
  async function loadQuest({ files = true } = {}) {
    if (!quest || !state.settings.sharedFolder || !bp.quest) return null;
    if (files) { try { quest.files = await bp.quest.read(); } catch (_) { /* Drive hiccup: keep the last board */ } quest.fields = Q.merge(quest.files); }
    quest.board = Q.board(quest.fields, state.songs || [], { me: me() });
    questCelebrate(); renderXpChip(); renderBandPane(); renderBandFeed();
    return quest.board;
  }
  const myQuest = () => (quest && quest.board ? quest.board.members.find((m) => m.isMe) || null : null);
  function songQuest(folder) { return quest && quest.board && quest.board.songs.find((x) => x.folder === folder) || null; }
  // level-ups and new achievements (mine) → toasts, once
  function questCelebrate() {
    const m = myQuest(); if (!m) return; const seen = QSEEN(); let changed = false;
    if (seen.level != null && m.level.n > seen.level) levelUpShow(m);
    if (seen.level !== m.level.n) { seen.level = m.level.n; changed = true; }
    const had = new Set(seen.ach || []); const now = m.achievements.map((a) => a.id);
    if (seen.ach) for (const a of m.achievements) if (!had.has(a.id)) toast(`${a.icon} Achievement: ${a.title} — ${a.desc}`, { kind: 'ok', ms: 9000 });
    if (!seen.ach || now.some((id) => !had.has(id)) || now.length !== had.size) { seen.ach = now; changed = true; }
    const bl = quest.board.level.n;
    if (seen.band != null && bl > seen.band) toast(`⚔ ${quest.board.name} reached level ${bl}: ${quest.board.level.title}`, { kind: 'ok', ms: 9000 });
    if (seen.band !== bl) { seen.band = bl; changed = true; }
    if (changed) qseenSet(seen);
  }
  function renderXpChip() {
    const c = $('#xp-chip'); if (!c) return; const m = myQuest(); if (!m) { c.hidden = true; return; }
    c.hidden = false; c.querySelector('.xp-lvl').innerHTML = ''; { const i = el('i', `gi ${charOf(m)[2]}`); c.querySelector('.xp-lvl').append(i, document.createTextNode(` Lv ${m.level.n}`)); } c.querySelector('.xp-title').textContent = m.level.title;
    c.querySelector('.xp-bar i').style.width = `${(100 * m.level.frac).toFixed(0)}%`; c.querySelector('.xp-num').textContent = `${m.xp} XP`;
    c.title = `${m.name} — level ${m.level.n} ${m.level.title} · ${m.xp} XP${m.level.next ? ` · ${m.level.toNext} to ${m.level.next}` : ''} · ${m.achievements.length} achievement${m.achievements.length === 1 ? '' : 's'}\n${quest.board.name}: level ${quest.board.level.n} ${quest.board.level.title}`;
    const tb = $('#tb-band'); if (tb) tb.textContent = quest.board.boss && quest.board.boss.date && bossDays(quest.board.boss) >= 0 && bossDays(quest.board.boss) <= 7 ? `${bossDays(quest.board.boss)}d` : '';
  }
  $('#xp-chip').addEventListener('click', () => { if (true) setWorkspace('band'); else status(`${quest.board ? `${quest.board.name}: level ${quest.board.level.n} ${quest.board.level.title}` : ''} — open a song for the Band tab.`); });
  // "+25 XP · take recorded" when I do something that counts (optimistic: the real tally comes from the saved song)
  function questPop(label) {
    const w = Q.xpForLabel(label); if (!w || state.readOnly && !state.folder) return;
    const p = el('div', 'xp-pop', `+${w.xp} XP`); p.append(el('small', null, w.what)); document.body.append(p); setTimeout(() => p.remove(), 1800);
  }
  async function questWrite(patch) { if (!bp.quest) return; await bp.quest.write(patch); await loadQuest(); }
  const qKey = (s, rest) => `song:${s.qid}:${rest}`;
  const bossDays = (boss) => { if (!boss || !boss.date) return null; const d = Math.round((new Date(`${boss.date}T12:00:00`) - new Date()) / 86400000); return Number.isFinite(d) ? d : null; };
  function bossText(b) {
    const boss = b.boss; if (!boss) return 'No boss battle set — click to aim at the next practice or show';
    const d = bossDays(boss); const when = d == null ? '' : d > 1 ? ` · in ${d} days` : d === 1 ? ' · tomorrow' : d === 0 ? ' · TODAY' : ` · ${-d} day${d === -1 ? '' : 's'} ago`;
    const targets = (boss.songs || []).map((id) => b.songs.find((s) => s.qid === id)).filter(Boolean); const ready = targets.filter((s) => s.goals.find((g) => g.id === 'show').done).length;
    return `${boss.title}${when}${targets.length ? ` · ${ready}/${targets.length} show-ready` : ''}`;
  }
  async function editBoss() {
    const b = quest.board; const cur = b.boss || {};
    const title = await promptName('Next boss battle — a practice, a show? (blank clears it)', cur.title || ''); if (title === null) return;
    if (!title) { await questWrite({ 'band:boss': null }); return; }
    const date = await promptName('When? (YYYY-MM-DD, or blank)', cur.date || ''); if (date === null) return;
    const names = await promptName(`Songs that have to be show-ready (comma-separated): ${b.songs.map((s) => s.name).join(', ')}`, (cur.songs || []).map((id) => (b.songs.find((s) => s.qid === id) || {}).name).filter(Boolean).join(', ')); if (names === null) return;
    const ids = String(names).split(',').map((x) => Q.norm(x)).filter(Boolean).map((n) => (b.songs.find((s) => Q.norm(s.name) === n) || b.songs.find((s) => Q.norm(s.name).startsWith(n)) || {}).qid).filter(Boolean);
    await questWrite({ 'band:boss': { title: title.slice(0, 80), date: /^\d{4}-\d\d-\d\d$/.test(date.trim()) ? date.trim() : '', songs: ids } });
  }
  const xpBar = (frac, cls = '') => { const bar = el('div', `xp-bar ${cls}`.trim()); const i = el('i'); i.style.width = `${(100 * Math.max(0, Math.min(1, frac))).toFixed(1)}%`; bar.append(i); return bar; };
  function renderBandPane() {
    const b = quest.board; if (!b || !$('#band-pane')) return;
    $('#qb-lvl-n').textContent = `Lv ${b.level.n}`; $('#qb-lvl-title').textContent = `${b.name} · ${b.level.title}`;
    $('#qb-xp').textContent = `${b.xp} / ${b.max} XP`; $('#qb-bar').style.width = `${b.max ? (100 * b.xp / b.max).toFixed(1) : 0}%`;
    $('#qb-tonext').textContent = b.level.next ? `${b.level.toNext} XP to ${b.level.next}` : 'max level';
    const boss = $('#qb-boss'); boss.innerHTML = ''; const dr = el('i', 'gi gi-dragon'); boss.append(dr, el('i', 'gi gi-noodles'), document.createTextNode(' ' + bossText(b))); boss.classList.toggle('soon', bossDays(b.boss) != null && bossDays(b.boss) >= 0 && bossDays(b.boss) <= 7);
    // members
    const mw = $('#qb-members'); mw.innerHTML = '';
    for (const m of b.members.slice().sort((x, y) => y.xp - x.xp)) {
      const row = el('div', 'qb-member' + (m.isMe ? ' me' : '') + (quest.sel === m.name ? ' sel' : ''));
      const top = el('div', 'qb-mrow'); const sp = charSprite(m, { live: true }); if (m.isMe) sp.addEventListener('click', (e) => { e.stopPropagation(); chooseCharacter(m).catch(fail); }); top.append(sp, el('span', 'qb-icon', m.icon), el('b', null, m.name), el('span', 'qb-role muted', m.role || ''), el('span', 'qb-mlvl', `Lv ${m.level.n} ${m.level.title}`), el('span', 'qb-mxp mono', `${m.xp}`));
      row.append(top, xpBar(m.level.frac));
      const ach = el('div', 'qb-ach'); for (const a of m.achievements) { const t = el('span', 'qb-a', a.icon); t.title = `${a.title} — ${a.desc}`; ach.append(t); } if (!m.achievements.length) ach.append(el('span', 'muted small', 'no achievements yet'));
      row.append(ach);
      if (quest.sel === m.name) {
        const d = el('div', 'qb-detail');
        const cnt = Object.entries(Q.WORTH).filter(([k]) => m[k]).map(([k, [xp, what]]) => `${m[k]} × ${what.replace(/^(\w)/, (x) => x)} (${m[k] * xp})`);
        d.append(el('div', 'small', cnt.length ? cnt.join(' · ') : 'nothing counted yet — record a take, add a note, chart a chord…'));
        if (m.perSong.length) { const ul = el('ul', 'small qb-persong'); for (const ps of m.perSong.slice(0, 12)) { const li = el('li'); li.append(el('span', 'mono', `${ps.xp}`), document.createTextNode(` ${ps.name}`), el('span', 'muted', ` · parts ${ps.pct}%`)); if (ps.folder) { li.classList.add('link'); li.addEventListener('click', () => openSong(ps.folder).catch(fail)); } ul.append(li); } d.append(ul); }
        const locked = Q.ACHIEVEMENTS.filter(([id]) => !m.achievements.some((a) => a.id === id)); if (locked.length) d.append(el('div', 'muted small', `locked: ${locked.map(([, icon, title, desc]) => `${icon} ${title} (${desc})`).join(' · ')}`));
        row.append(d);
      }
      row.addEventListener('click', (e) => { if (e.target.closest('.qb-detail')) return; quest.sel = quest.sel === m.name ? null : m.name; renderBandPane(); });
      M.attach(row, () => [{ title: m.name }, ...(m.isMe ? [{ label: 'Choose your character…', action: () => chooseCharacter(m).catch(fail) }] : []), { label: 'Role / icon…', action: () => editMember(m).catch(fail) }, { label: `Also known in Cobander as… (${(m.aliases || []).join(', ') || 'nobody else'})`, action: () => editAliases(m).catch(fail) }, ...(m.auto ? [{ label: 'Add to the band for good', action: () => questWrite({ 'band:members': [...b.members.filter((x) => !x.auto).map(({ name, role, icon, aliases }) => ({ name, role, icon, aliases })), { name: m.name, role: '', icon: '🎵', aliases: [] }] }).catch(fail) }] : [])]);
      mw.append(row);
    }
    // this song
    const sq = state.folder ? songQuest(state.folder) : null; const sw = $('#qb-song'); sw.innerHTML = '';
    $('#qb-song-title').textContent = sq ? `This song · ${sq.xp} / ${sq.max} XP` : 'This song';
    if (!sq) sw.append(el('div', 'muted small', state.folder ? 'This song is hidden from the board (right-click it in the setlist to bring it back).' : 'Open a song.'));
    else {
      sw.append(xpBar(sq.max ? sq.xp / sq.max : 0, 'big'));
      const goals = el('div', 'qb-goals');
      for (const g of sq.goals) { const l = el('label', 'chip' + (g.done ? ' on' : '')); const cb = el('input'); cb.type = 'checkbox'; cb.checked = g.done; cb.disabled = ro(); cb.addEventListener('change', () => { questWrite({ [qKey(sq, `goal:${g.id}`)]: cb.checked }).catch(fail); if (cb.checked) questPopRaw(Q.GOAL_XP, g.label); }); l.append(cb, document.createTextNode(` ${g.label}`)); goals.append(l); }
      sw.append(goals);
      const ms = el('div', 'qb-milestones small'); for (const x of sq.milestones) { const t = el('span', 'qb-ms' + (x.done ? ' on' : '')); t.textContent = `${x.done ? '✓' : '○'} ${x.label}`; t.title = `${x.xp} XP — ${x.done ? 'done' : 'not yet'}`; ms.append(t); } sw.append(ms);
      const pw = el('div', 'qb-prog');
      for (const p of sq.prog) {
        const row = el('div', 'qb-prow'); row.append(el('b', null, p.member), xpBar(p.pct / 100, 'mid'), el('span', 'mono qb-pct', `${p.pct}%${p.written ? ' ✓' : ''}`), el('span', 'muted small', p.manual ? 'set by hand' : `${p.takes} take${p.takes === 1 ? '' : 's'}${p.midi ? ` · ${p.midi} MIDI` : ''}`));
        row.title = `${p.member}: parts written ${p.pct}% — the share of this song's parts their takes cover${p.manual ? ' (set by hand)' : ''} · ${p.xp} XP from this song`;
        M.attach(row, () => [{ title: `${p.member} — ${sq.name}` }, { label: 'Set parts written by hand… (for someone who records outside Cobander)', action: async () => { const v = await promptName(`${p.member}'s parts written, 0–100`, String(p.pct)); if (v !== null && v !== '') questWrite({ [qKey(sq, `m:${p.member}:manual`)]: Q.clampPct(v) }).catch(fail); } }, ...(p.manual ? [{ label: 'Back to counting takes', action: () => questWrite({ [qKey(sq, `m:${p.member}:manual`)]: null }).catch(fail) }] : [])]);
        pw.append(row);
      }
      sw.append(pw);
      const tl = el('div', 'qb-tasks');
      for (const t of sq.tasks) {
        const row = el('label', 'qb-task' + (t.done ? ' on' : '')); const cb = el('input'); cb.type = 'checkbox'; cb.checked = t.done; cb.disabled = ro();
        cb.addEventListener('change', () => { questWrite({ [`song:${t.qid}:task:${t.id}`]: { text: t.text, done: cb.checked, who: t.who } }).catch(fail); if (cb.checked) questPopRaw(Q.TASK_XP, 'task done'); });
        const x = el('button', 'qb-x', '✕'); x.type = 'button'; x.title = 'Remove this task from the list — for things that got done another way or are not needed any more.'; x.addEventListener('click', (e) => { e.preventDefault(); questWrite({ [`song:${t.qid}:task:${t.id}`]: { text: t.text, done: t.done, deleted: true } }).catch(fail); });
        row.append(cb, el('span', null, t.text)); if (t.who) row.append(el('span', 'qb-who', `@${t.who}`)); row.append(x); tl.append(row);
      }
      // the song's own open "needs" (Needs tab) show here too, so the board is the one to-do list for the band
      { const row0 = sq.folder && (state.songs || []).find((x) => x.folder === sq.folder); for (const n of (row0 && row0.needs) || []) { const row = el('div', 'qb-task qb-need'); row.append(el('span', null, `📌 ${n}`), el('span', 'qb-who muted', 'need')); row.title = 'From the song\'s Needs tab — click to open the song there'; row.addEventListener('click', async () => { if (state.folder !== sq.folder) await openSong(sq.folder); showTab('needs'); }); tl.append(row); } }
      const add = el('div', 'qb-addtask'); const inp = el('input'); inp.placeholder = 'add a task… (@Name assigns it)'; const ab = el('button', null, '+'); ab.type = 'button';
      const doAdd = () => { const v = inp.value.trim(); if (!v) return; const who = (/@(\w+)/.exec(v) || [])[1]; const mb = who ? Q.memberFor(b.members, who) : null; questWrite({ [qKey(sq, `task:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`)]: { text: v.slice(0, 200), done: false, who: mb ? mb.name : who || null } }).catch(fail); inp.value = ''; };
      ab.addEventListener('click', doAdd); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } e.stopPropagation(); });
      add.append(inp, ab); tl.append(add); sw.append(tl);
    }
    // band to-dos (Dan: "an overall to-do list, not for a specific song")
    { const tl = $('#qb-todos'); tl.innerHTML = '';
      if (!b.todos.length) tl.append(el('div', 'muted small', 'Nothing loose. Add one below.'));
      for (const t of b.todos) {
        const row = el('label', 'qb-task' + (t.done ? ' on' : '')); const cb = el('input'); cb.type = 'checkbox'; cb.checked = t.done;
        cb.addEventListener('change', () => { questWrite({ [`band:todo:${t.id}`]: { text: t.text, who: t.who, done: cb.checked, doneBy: cb.checked ? me() : null } }).catch(fail); if (cb.checked) questPopRaw(Q.TASK_XP, 'loose end tied'); });
        const x = el('button', 'qb-x', '✕'); x.type = 'button'; x.title = 'Remove this loose end from the band\'s list — for things that got done another way or are not needed any more.'; x.addEventListener('click', (e) => { e.preventDefault(); questWrite({ [`band:todo:${t.id}`]: { text: t.text, done: t.done, deleted: true } }).catch(fail); });
        row.append(cb, el('span', null, t.text)); if (t.who) row.append(el('span', 'qb-who', `@${t.who}`)); row.title = `added by ${t.by}${t.done && t.doneBy ? ` · done by ${t.doneBy}` : ''}`; row.append(x); tl.append(row);
      }
      const add = el('div', 'qb-addtask'); const inp = el('input'); inp.placeholder = 'add a loose end… (@Name assigns it)'; const ab = el('button', null, '+'); ab.type = 'button';
      const doAdd = () => { const v = inp.value.trim(); if (!v) return; const who = (/@(\w+)/.exec(v) || [])[1]; const mb = who ? Q.memberFor(b.members, who) : null; questWrite({ [`band:todo:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`]: { text: (mb ? v.replace(/\s*@\w+/, '') : v).trim().slice(0, 200) || v.slice(0, 200), done: false, who: mb ? mb.name : who || null } }).catch(fail); inp.value = ''; };
      ab.addEventListener('click', doAdd); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } e.stopPropagation(); });
      add.append(inp, ab); tl.append(add); }
    // setlist
    const ul = $('#qb-setlist'); ul.innerHTML = '';
    for (const s of b.songs) {
      const li = el('li', 'qb-song' + (s.folder === state.folder ? ' open' : '') + (s.folder ? '' : ' qonly'));
      const top = el('div', 'qb-srow'); top.append(el('span', 'name', s.name), el('span', 'mono muted', `${s.xp}/${s.max}`)); if (!s.folder) top.append(el('span', 'chip-s', 'not in Cobander'));
      const tgt = b.boss && (b.boss.songs || []).includes(s.qid); if (tgt) top.append(el('span', 'chip-s ping', 'boss target'));
      li.append(top, xpBar(s.max ? s.xp / s.max : 0));
      li.title = `${s.goals.filter((g) => g.done).map((g) => g.label).join(', ') || 'no goals yet'} · ${s.prog.map((p) => `${p.member} ${p.pct}%`).join(' · ')}`;
      if (s.folder) li.addEventListener('click', () => openSong(s.folder).catch(fail));
      M.attach(li, () => [{ title: s.name }, ...(s.folder ? [{ label: 'Open', action: () => openSong(s.folder).catch(fail) }] : []),
        { label: tgt ? 'Not a boss-battle target' : 'Boss-battle target', action: () => { const boss = b.boss || { title: 'Next practice', date: '', songs: [] }; questWrite({ 'band:boss': { ...boss, songs: tgt ? (boss.songs || []).filter((x) => x !== s.qid) : [...new Set([...(boss.songs || []), s.qid])] } }).catch(fail); } },
        ...(!s.folder ? [{ label: 'Rename…', action: async () => { const v = await promptName('Song name', s.name); if (v) questWrite({ [qKey(s, 'meta')]: { ...(s.meta || {}), name: v.slice(0, 80) } }).catch(fail); } }, { label: 'Parts written by hand…', sub: b.members.map((mb) => ({ label: `${mb.name}: ${(s.prog.find((p) => p.member === mb.name) || {}).pct || 0}%`, action: async () => { const v = await promptName(`${mb.name}'s parts written on ${s.name}, 0–100`, String((s.prog.find((p) => p.member === mb.name) || {}).pct || 0)); if (v !== null && v !== '') questWrite({ [qKey(s, `m:${mb.name}:pct`)]: Q.clampPct(v) }).catch(fail); } })) }] : []),
        { label: 'Move to the top', action: () => questWrite({ [qKey(s, 'meta')]: { ...(s.meta || {}), name: s.name, order: Math.min(0, ...b.songs.map((x) => x.order ?? 0)) - 1 } }).catch(fail) },
        'sep', { label: s.folder ? 'Hide from the board' : 'Remove from the setlist', danger: true, action: () => questWrite({ [qKey(s, 'meta')]: { ...(s.meta || {}), name: s.name, hidden: true } }).catch(fail) }]);
      ul.append(li);
    }
    const hidden = [...quest.fields].filter(([k, e]) => /^song:.+:meta$/.test(k) && e.v && e.v.hidden).map(([k, e]) => ({ qid: k.slice(5, -5), meta: e.v }));
    if (hidden.length) { const li = el('li', 'muted small'); li.textContent = `${hidden.length} hidden`; M.attach(li, () => hidden.map((h) => ({ label: `Bring back ${h.meta.name || h.qid}`, action: () => questWrite({ [`song:${h.qid}:meta`]: { ...h.meta, hidden: false } }).catch(fail) }))); li.addEventListener('click', (e) => li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY }))); ul.append(li); }
    $('#qb-next').textContent = b.next ? `Then: ${b.next}` : 'Then: … (click to set the target after the boss battle)';
  }
  function questPopRaw(xp, what) { const p = el('div', 'xp-pop', `+${xp} XP`); p.append(el('small', null, what)); document.body.append(p); setTimeout(() => p.remove(), 1800); }
  // ---- characters & level sprites ----
  const charOf = (m) => Q.CHARACTERS.find(([id]) => id === (m && m.character)) || Q.CHARACTERS.find(([id]) => id === roleGuess(m)) || Q.CHARACTERS[0];
  function roleGuess(m) { const r = String((m && m.role) || '').toLowerCase(); if (/bass/.test(r)) return 'lowend'; if (/drum/.test(r)) return 'thumper'; if (/vo(x|cal)|sing/.test(r)) return 'howler'; if (/key|piano|synth/.test(r)) return 'wizard'; if (/sax|horn|trumpet|brass/.test(r)) return 'horn'; if (/banjo|mandolin/.test(r)) return 'picker'; if (/guitar|gtr/.test(r)) return 'shredder'; return 'noodle'; }
  // everyone gets a look from the start (rolled from their name) until they build one; tiers pick the animation
  const LPC = window.BPLPC; LPC.load().then(() => { if (state.ws === 'band') renderBandPane(); }).catch((e) => console.warn('lpc', e));
  const lookOf = (m) => (LPC.ready() ? LPC.sanitize(m && m.look ? m.look : LPC.defaultLook(m && m.name)) : null);
  const animOf = (t) => Q.TIER_ANIM[t - 1] || 'idle';
  // a canvas that draws frame 0 now, animates while hovered, and (live) while it is on screen; a 'big' hero plays `anims` nonstop
  function lpcCanvas(look, { anim = 'idle', scale = 1, live = false, anims = null, hover = true } = {}) {
    const c = document.createElement('canvas'); c.className = 'lpc'; c.width = c.height = 64 * scale; if (!look) return c;
    LPC.render(c, look, { anim, scale }).catch(() => {}); let stop = null; const go = () => { if (!stop) stop = LPC.animate(c, look, { anim, scale, anims }); }; const halt = () => { if (stop) { stop(); stop = null; LPC.render(c, look, { anim, scale }).catch(() => {}); } };
    if (anims) { go(); return c; }
    if (hover) { c.addEventListener('mouseenter', go); c.addEventListener('mouseleave', () => { if (!c.dataset.vis) halt(); }); }
    if (live && 'IntersectionObserver' in window) { const io = new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting) { c.dataset.vis = '1'; go(); } else { delete c.dataset.vis; halt(); } if (!c.isConnected) io.disconnect(); } }); io.observe(c); }
    return c;
  }
  function charSprite(m, { tier = null, big = false, title = true, anim = null, live = false, look = null } = {}) {
    const ch = charOf(m); const lv = m && m.level ? m.level : { tier: 1, n: 1, title: Q.TIERS[0] }; const t = tier || lv.tier || 1; const lk = look || lookOf(m);
    const box = el('span', `char t${t}${big ? ' big' : ''}${lk ? ' body' : ''}`);
    if (lk) { box.append(lpcCanvas(lk, { anim: anim || animOf(t), scale: big ? 3 : 1, live })); const ins = el('span', 'inst'); ins.append(el('i', `gi ${ch[2]}`)); box.append(ins); }
    else box.append(el('i', `gi ${ch[2]}`));
    const badge = Q.TIER_BADGE[t - 1]; if (badge) { const b = el('span', 'badge'); b.append(el('i', `gi ${badge}`)); box.append(b); }
    if (title && m) box.title = `${ch[1]} — level ${lv.n}, ${lv.title}${lv.next ? ` · ${lv.toNext} XP to ${lv.next === lv.title ? `level ${lv.n + 1}` : lv.next}` : ' · max level'}${m.isMe ? ' · click to choose your character' : ''}`;
    return box;
  }
  // the builder: a live preview, a row of choices per slot (each a tiny canvas of the current look with that one thing
  // swapped, or a colour swatch), the instrument, and "That's me" writes `look` + `character` into band:members
  async function chooseCharacter(mb) {
    let d = $('#charpick'); if (d) d.remove(); if (!LPC.ready()) await LPC.load();
    d = document.createElement('dialog'); d.id = 'charpick'; const f = document.createElement('form'); f.method = 'dialog';
    f.append(el('h3', null, 'Choose your character'), el('p', 'muted small', 'Your person on the Band page. The badge, ring and glow grow with every new name (every 10 levels), and so does the move. Change it any time.'));
    let look = lookOf(mb), sel = (charOf(mb) || [])[0]; const O = LPC.options();
    const wrap = el('div', 'cb-wrap'); const left = el('div', 'cb-left'); const right = el('div', 'cb-right'); wrap.append(left, right);
    const preview = el('div', 'cb-preview'); const tiers = el('div', 'char-tiers'); const surprise = el('button', 'cb-surprise', '🎲 Surprise me'); surprise.type = 'button';
    left.append(preview, surprise, el('div', 'muted small', 'How it grows (every ten levels):'), tiers);
    const refreshPreview = () => { preview.innerHTML = ''; preview.append(charSprite({ ...mb, character: sel }, { big: true, title: false, look, anim: 'idle', live: true })); tiers.innerHTML = ''; for (let t = 1; t <= 10; t++) tiers.append(charSprite({ ...mb, character: sel }, { tier: t, title: false, look })); };
    // one row per slot: [label, key, choices (id/name list or colour names), colour material or null, allow none]
    const ROWS = [['Body', 'body', O.body.map((b) => ({ id: b, name: b })), null, false, ''], ['Skin', 'skin', O.skin, 'body', false], ['Head', 'head', O.head, null, false, 'head'], ['Hair', 'hair', O.hair, null, true, 'head'], ['Hair colour', 'hairColor', O.hairColor, 'hair', false], ['Beard', 'beard', O.beard, null, true, 'head'], ['Face', 'face', O.face, null, true, 'head'],
      ['Top', 'top', O.top, null, true, 'torso'], ['Top colour', 'topColor', O.cloth, 'cloth', false], ['Jacket', 'jacket', O.jacket, null, true, 'torso'], ['Legs', 'legs', O.legs, null, true, 'legs'], ['Legs colour', 'legsColor', O.cloth, 'cloth', false], ['Shoes', 'shoes', O.shoes, null, true, 'legs'], ['Shoes colour', 'shoesColor', O.cloth, 'cloth', false], ['Hat', 'hat', O.hat, null, true, 'hat'], ['Hat colour', 'hatColor', O.cloth, 'cloth', false]];
    const rows = el('div', 'cb-rows');
    const swatch = (mat, name) => { const r = LPC.ramp(mat, name) || []; const sw = el('span', 'cb-swatch'); sw.style.background = `linear-gradient(135deg, ${r[1] || '#000'}, ${r[3] || '#888'} 50%, ${r[4] || '#fff'})`; return sw; };
    const buildRow = (label, key, choices, mat, none, zoom = '') => {
      const row = el('div', 'cb-row'); row.dataset.key = key; const opts = el('div', 'cb-opts'); row.append(el('div', 'cb-label', label), opts);
      const items = none ? [{ id: null, name: 'none' }, ...choices] : choices; const dis = (k) => (k === 'beard' || k === 'face') && !(look.head === 'heads_human_male' || look.head === 'heads_human_female');   // only human heads take faces / beards
      for (const ch of items) { const id = typeof ch === 'string' ? ch : ch.id, name = typeof ch === 'string' ? ch : ch.name; const o = el('button', 'cb-opt' + (look[key] === id ? ' sel' : '') + (zoom && id !== null ? ` z-${zoom}` : '')); o.type = 'button'; o.title = name.replace(/_/g, ' ');
        if (mat) o.append(swatch(mat, id)); else if (id === null) o.append(el('span', 'cb-none', '∅')); else o.append(lpcCanvas(LPC.sanitize({ ...look, [key]: id }), { anim: 'idle', hover: false, scale: zoom ? 2 : 1 }));
        o.addEventListener('click', () => { look = LPC.sanitize({ ...look, [key]: id }); refreshAll(key); }); opts.append(o); }
      row.classList.toggle('off', dis(key)); return row;
    };
    const refreshAll = (changed) => { for (const r of [...rows.children]) { const key = r.dataset.key; const spec = ROWS.find((x) => x[1] === key); const colour = !!spec[3]; if (colour && changed !== key) { for (const o of r.querySelectorAll('.cb-opt')) o.classList.toggle('sel', (o.title === 'none' ? null : o.title.replace(/ /g, '_')) === look[key]); } else r.replaceWith(buildRow(...spec)); } refreshPreview(); };
    for (const spec of ROWS) rows.append(buildRow(...spec));
    surprise.addEventListener('click', () => { look = LPC.defaultLook(`${mb.name}:${Date.now()}:${Math.random()}`); refreshAll(); });
    const grid = el('div', 'char-grid');
    for (const [id, name, icon, blurb] of Q.CHARACTERS) { const c = el('div', 'char-pick' + (sel === id ? ' sel' : '')); c.dataset.id = id; const ic = el('span', 'char t1'); ic.append(el('i', `gi ${icon}`)); c.append(ic, el('b', null, name), el('small', null, blurb)); c.addEventListener('click', () => { sel = id; for (const x of grid.children) x.classList.toggle('sel', x === c); refreshPreview(); }); grid.append(c); }
    right.append(el('div', 'muted small', 'Who you are:'), rows, el('div', 'muted small', 'What you play:'), grid);
    const menu = document.createElement('menu'); const ok = el('button', 'primary', 'That\'s me'); ok.value = 'ok'; const cancel = el('button', 'cancel', 'Cancel'); cancel.value = 'cancel'; cancel.setAttribute('formnovalidate', ''); menu.append(cancel, ok);
    f.append(wrap, menu); d.append(f); document.body.append(d); refreshPreview();
    const r = await new Promise((res) => { d.addEventListener('close', () => res(d.returnValue), { once: true }); d.showModal(); });
    d.remove(); if (r !== 'ok') return;
    const list = quest.board.members.filter((x) => !x.auto || x.name === mb.name).map((x) => ({ name: x.name, role: x.role, icon: x.icon, aliases: x.aliases || [], character: x.character || null, look: x.look || null })).map((x) => (x.name === mb.name ? { ...x, character: sel, look } : x));
    await questWrite({ 'band:members': list }); toast(`You are ${Q.CHARACTERS.find(([id]) => id === sel)[1]}. 🤘`, { kind: 'ok', ms: 5000 });
  }
  // LEVEL UP: the full obnoxious show — unless a take is rolling
  let luAudio = null;
  function levelUpSound(tier) {
    try {
      const ctx = engine.ctx || (luAudio = luAudio || new (window.AudioContext || window.webkitAudioContext)()); const t0 = ctx.currentTime + 0.02; const out = ctx.createGain(); out.gain.value = 0.22; out.connect(ctx.destination);
      // power-chord fanfare: root–fifth–octave stabs, then a rising arpeggio; higher tiers get a longer, brighter run
      const stab = (f, at, len) => { for (const [mul, g] of [[1, 1], [1.5, 0.7], [2, 0.5]]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * mul; const env = ctx.createGain(); env.gain.setValueAtTime(0, at); env.gain.linearRampToValueAtTime(g, at + 0.01); env.gain.exponentialRampToValueAtTime(0.001, at + len); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, at); lp.frequency.exponentialRampToValueAtTime(5000, at + 0.08); o.connect(lp); lp.connect(env); env.connect(out); o.start(at); o.stop(at + len + 0.05); } };
      stab(110, t0, 0.22); stab(110, t0 + 0.26, 0.22); stab(146.8, t0 + 0.52, 0.5);
      const run = [220, 277, 330, 440, 554, 660, 880, 1109, 1319, 1760].slice(0, 5 + Math.min(5, tier)); run.forEach((f, i) => { const at = t0 + 0.95 + i * 0.07; const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; const env = ctx.createGain(); env.gain.setValueAtTime(0, at); env.gain.linearRampToValueAtTime(0.35, at + 0.01); env.gain.exponentialRampToValueAtTime(0.001, at + 0.25); o.connect(env); env.connect(out); o.start(at); o.stop(at + 0.3); });
      // crowd: filtered noise swell
      const n = ctx.createBufferSource(); const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length); n.buffer = b; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.6; const ng = ctx.createGain(); ng.gain.setValueAtTime(0, t0 + 0.9); ng.gain.linearRampToValueAtTime(0.5, t0 + 1.3); ng.gain.exponentialRampToValueAtTime(0.001, t0 + 2.8); n.connect(bp); bp.connect(ng); ng.connect(out); n.start(t0 + 0.9);
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (_) { /* no audio, no problem */ }
  }
  function levelUpShow(m, { force = false } = {}) {
    if (!force && (engine.recording || finishing || sketchRec || (state.settings && state.settings.fanfare === false))) { toast(`⚔ Level up — you're level ${m.level.n}: ${m.level.title}`, { kind: 'ok', ms: 9000 }); return; }
    const old = $('#levelup'); if (old) old.remove();
    const o = el('div'); o.id = 'levelup'; const newName = (m.level.n - 1) % 10 === 0;
    const hero = el('span', `char t${m.level.tier} big${lookOf(m) ? ' body' : ''}`); { const lk = lookOf(m); if (lk) { hero.append(lpcCanvas(lk, { scale: 3, anims: ['jump', 'emote'] })); const ins = el('span', 'inst'); ins.append(el('i', `gi ${charOf(m)[2]}`)); hero.append(ins); } else hero.append(el('i', `gi ${charOf(m)[2]}`)); const badge = Q.TIER_BADGE[m.level.tier - 1]; if (badge) { const b = el('span', 'badge'); b.append(el('i', `gi ${badge}`)); hero.append(b); } }
    const art = document.createElement('img'); art.className = 'lu-art'; art.src = 'art/levelup.jpg'; art.alt = ''; o.append(art);
    o.append(el('div', 'lu-title', 'LEVEL UP'), hero, el('div', 'lu-n', `LEVEL ${m.level.n}${newName ? ' — NEW NAME' : ''}`), el('div', 'lu-name', `${m.name} the ${m.level.title}`), el('div', 'lu-hint', 'click anywhere'));
    const cols = ['#f2b534', '#d8392b', '#fff', '#5b8def', '#4caf7d', '#ff4d6d']; const N = 70 + m.level.tier * 10;
    for (let i = 0; i < N; i++) { const p = el('span', 'p'); const a = Math.random() * Math.PI * 2, r = 180 + Math.random() * 520; p.style.setProperty('--dx', `${Math.cos(a) * r}px`); p.style.setProperty('--dy', `${Math.sin(a) * r + 200}px`); p.style.background = cols[i % cols.length]; p.style.animationDelay = `${(Math.random() * 0.35).toFixed(2)}s`; p.style.width = p.style.height = `${8 + Math.random() * 12}px`; if (i % 7 === 0) { p.className = 'p gi gi-noodles'; p.style.background = '#f2b534'; p.style.width = p.style.height = '26px'; } o.append(p); }
    document.body.append(o); document.body.classList.add('lu-shake'); setTimeout(() => document.body.classList.remove('lu-shake'), 600);
    levelUpSound(m.level.tier);
    const close = () => { if (!o.isConnected) return; o.classList.add('out'); setTimeout(() => o.remove(), 420); };
    o.addEventListener('click', close); setTimeout(close, 6500);
    logActivity(`hit level ${m.level.n}${newName ? ` — ${m.level.title}` : ''}`);
  }
  window.bandpadDebug_levelUp = (n) => { const m = myQuest() || { name: me(), role: '', level: Q.levelOf(Q.levelXp(n || 10), Q.MEMBER_LEVELS) }; levelUpShow({ ...m, level: Q.levelOf(Q.levelXp(n || m.level.n), Q.MEMBER_LEVELS) }, { force: true }); };
  async function editMember(mb) {
    const v = await promptName('Name · role · icon (e.g. "Zach · Drums · 🥁")', `${mb.name} · ${mb.role} · ${mb.icon}`); if (!v) return;
    const [name, role, icon] = v.split('·').map((x) => x.trim());
    const list = quest.board.members.filter((x) => !x.auto || x.name === mb.name).map((x) => ({ name: x.name, role: x.role, icon: x.icon, aliases: x.aliases || [], character: x.character || null, look: x.look || null })).map((x) => (x.name === mb.name ? { ...x, name: name || x.name, role: role ?? x.role, icon: icon || x.icon } : x));
    await questWrite({ 'band:members': list });
  }
  async function editAliases(mb) {
    const v = await promptName(`${mb.name} shows up in Cobander as… (comma-separated display names, e.g. FossTheBoss)`, (mb.aliases || []).join(', ')); if (v === null) return;
    const list = quest.board.members.filter((x) => !x.auto || x.name === mb.name).map((x) => ({ name: x.name, role: x.role, icon: x.icon, aliases: x.aliases || [], character: x.character || null, look: x.look || null })).map((x) => (x.name === mb.name ? { ...x, aliases: v.split(',').map((a) => a.trim()).filter(Boolean).slice(0, 6) } : x));
    await questWrite({ 'band:members': list });
  }
  $('#qb-boss').addEventListener('click', () => editBoss().catch(fail));
  $('#qb-next').addEventListener('click', async () => { const v = await promptName('The target after the boss battle (a show, a recording, a date)', quest.board.next || ''); if (v !== null) questWrite({ 'band:next': v.slice(0, 200) }).catch(fail); });
  const addSetlistSong = () => { const v = $('#qb-new').value.trim(); if (!v) return; questWrite({ [`song:q:${Date.now().toString(36)}:meta`]: { name: v.slice(0, 80) } }).catch(fail); $('#qb-new').value = ''; };
  // Chart every song: walk the band folder, draft chords where there are none, skip what someone else has open
  let chartAllBusy = null;
  async function chartAllSongs({ interactive = true } = {}) {
    if (chartAllBusy) { status('Already charting — one moment.'); return chartAllBusy; }
    chartAllBusy = (async () => {
      const back = state.folder; const out = { charted: [], skipped: [] };
      if (engine.recording || finishing) throw new Error('finish the take first');
      if (back && state.dirty && !state.readOnly) { const r = await save(); if (r !== 'ok') throw new Error(`save the open song first (${r})`); }
      if (back && state.dirty) throw new Error('the open song has unsaved changes it can\'t keep (read-only) — deal with those first');
      const list = (state.songs || []).filter((s) => s.folder && !/^Noodle pad/.test(s.folder));
      const close = toast(`Charting ${list.length} songs…`, { ms: 600000 });
      try {
        for (const s of list) {
          if (s.lock && !s.lock.stale && !s.lockMine && !s.lockSameMachine) { out.skipped.push(`${s.name} (${s.lock.user} has it open)`); continue; }
          try {
            await openSong(s.folder, { interactive: false, quiet: true }); if (state.folder !== s.folder) { out.skipped.push(`${s.name} (couldn't open it)`); break; }
            if (state.readOnly) { out.skipped.push(`${s.name} (read-only)`); continue; }
            const n = await chordsFromTracks(null, { replaceDrafts: true });
            if (n > 0) { const r = await save(); if (r !== 'ok') { out.skipped.push(`${s.name} (save: ${r})`); break; } out.charted.push(`${s.name} (+${n})`); } else out.skipped.push(`${s.name} (nothing new to hear)`);
          } catch (e) { out.skipped.push(`${s.name} (${e.message || e})`); }
        }
      } finally {
        close();
        if (state.folder !== back) { if (state.folder) await closeSong({ interactive: false }).catch(() => {}); if (back) await openSong(back, { interactive: false, quiet: true }).catch(() => {}); }
        chartAllBusy = null;
      }
      if (out.charted.length) logActivity(`charted ${out.charted.length} songs`);
      if (interactive) toast(`Charted ${out.charted.length}: ${out.charted.join(', ') || '—'}${out.skipped.length ? ` · skipped ${out.skipped.length}: ${out.skipped.join(', ')}` : ''}`, { kind: 'ok', ms: 15000 });
      return out;
    })();
    return chartAllBusy;
  }
  $('#qb-chart-all').addEventListener('click', () => chartAllSongs().catch(fail));
  $('#qb-add').addEventListener('click', addSetlistSong);
  $('#qb-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSetlistSong(); } e.stopPropagation(); });
  // parts-bin saves count for their author: whoever saves a part notes it (their own file; merged by newest)
  function questCountPart() { if (!quest.board || !bp.quest) return; const cur = { ...(quest.fields.get('band:partsBy') || { v: {} }).v }; cur[me()] = (Number(cur[me()]) || 0) + 1; questWrite({ 'band:partsBy': cur }).catch(() => {}); }
  setInterval(() => { if (document.visibilityState === 'visible' && state.settings.sharedFolder) loadQuest(); }, 20000);   // bandmates' files sync in through Drive
   // keep "5m ago" honest
  function renderSongs() {
    renderBandFeed();
    const ul = $('#song-list'); ul.innerHTML = '';
    const flt = $('#song-stage-filter') ? $('#song-stage-filter').value : '';
    for (const s of state.songs.filter((x) => !flt || (flt === 'none' ? !x.stage : x.stage === flt))) {
      const li = el('li'); if (s.folder === state.folder) li.classList.add('open');
      const name = el('div', 'name', `${/^Noodle pad - /.test(s.name) ? '🎸 ' : ''}${s.name}`);
      const b = lockBadge(s); if (b) name.appendChild(b);
      if (s.conflictCopies && s.conflictCopies.length) { const c = el('span', 'lock', 'conflict copy'); c.title = s.conflictCopies.join(', '); name.appendChild(c); }
      li.appendChild(name);
      li.appendChild(el('div', 'sub', `${s.tracks} track${s.tracks === 1 ? '' : 's'} · rev ${s.rev}${s.savedBy ? ` · ${s.savedBy}` : ''}${s.savedAt ? ` · ${timeAgo(s.savedAt)}` : ''}`));
      const chips = el('div', 'chips');
      if (s.mentions) { const c = el('span', 'chip-s ping', `@${s.mentions}`); c.title = `${s.mentions} note${s.mentions === 1 ? '' : 's'} mention you — open the song to read ${s.mentions === 1 ? 'it' : 'them'}`; chips.append(c); }
      if (s.stage) { const c = el('span', `chip-s stage stage-${s.stage}`, STAGES[s.stage] || s.stage); c.title = 'Stage: how far along the song is — idea, writing, demo or done. Right-click the song to change it; the filter above the list sorts by it.'; chips.append(c); }
      if (s.needsMine) { const c = el('span', 'chip-s ping', `for you ${s.needsMine}`); c.title = `${s.needsMine} "needs" item${s.needsMine === 1 ? '' : 's'} assigned to you`; chips.append(c); }
      if (s.needsOpen) { const tot = s.needsOpen + (s.needsDone || 0); const c = el('span', 'chip-s needs', `needs ${s.needsOpen}${s.needsDone ? ` · ${Math.round(100 * s.needsDone / tot)}% done` : ''}`); c.title = (s.needs || []).join('\n'); chips.append(c); }
      for (const p of s.presence || []) { if (s.lock && !s.lock.stale && p.user === s.lock.user && p.mode !== 'listening') continue; const c = el('span', 'chip-s here', `${p.user} ${p.mode === 'waiting' ? '⏳ waiting to edit' : p.mode === 'recording' ? '● rec' : p.mode === 'practicing' ? '🎙 rehearsing' : p.playing ? '🎧 listening' : 'looking'}`); c.title = `${p.user} has this song open on ${p.host}`; chips.append(c); }
      if (chips.children.length) li.appendChild(chips);
      { const qs = songQuest(s.folder); if (qs) { const bar = el('div', 'song-xp'); const f = el('i'); f.style.width = `${qs.max ? (100 * qs.xp / qs.max).toFixed(0) : 0}%`; bar.append(f); bar.title = `Quest: ${qs.xp} / ${qs.max} XP · ${qs.goals.filter((g) => g.done).map((g) => g.label).join(', ') || 'no goals yet'} · ${qs.prog.map((p) => `${p.member} ${p.pct}%${p.written ? ' ✓' : ''}`).join(' · ')}`; li.appendChild(bar); } }
      li.addEventListener('click', () => { if (s.folder === state.folder && state.readOnly && !(s.lock && !s.lock.stale && !s.lockMine)) takeOver().catch(fail); else openSong(s.folder).catch(fail); });
      M.attach(li, () => songMenu(s));
      ul.appendChild(li);
    }
    if (!state.songs.length) ul.appendChild(el('li', 'muted', state.settings.sharedFolder ? 'No songs yet — hit + and start noodling.' : ''));
  }
  function timeAgo(iso) { const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; return `${Math.floor(d / 86400)}d ago`; }

  $('#btn-new-song').addEventListener('click', () => newSongWizard().catch(fail));

  // ---------- new-song wizard + templates ----------
  const TPL = window.BPTemplates;
  const KIND_LABEL = { guitar: 'Guitar', bass: 'Bass', vocals: 'Vocals', drumsMic: 'Drums (mics)', drums: 'Drum machine', keys: 'Keys', other: 'Other audio' };
  async function allTemplates() {
    let band = []; try { band = (await bp.templates.list()).map(TPL.normalize).filter(Boolean).map((t) => ({ ...t, band: true })); } catch (_) {}
    return [...TPL.BUILTIN, ...band];
  }
  // ---------- noodle pad: a per-person scratch song for recording random ideas into the parts bin ----------
  async function openNoodle() {
    const name = `Noodle pad - ${me()}`.slice(0, 100);
    let sg = (state.songs || []).find((x) => x.name === name || x.folder === name);
    if (!sg) {
      if (state.folder && !(await closeSong())) return;
      const r = await withTakeout(() => bp.songs.create(name)); if (!r) return; await refreshSongs(); state.quietEmpty = true; await openSong(r.folder); state.quietEmpty = false;
      if (state.folder !== r.folder || state.readOnly) return;
      await applyTemplate({ template: TPL.BUILTIN.find((x) => x.id === 'blank'), bpm: 120, timeSig: [4, 4], key: '', click: true, tracks: ['guitar'] });
      change(() => { state.song.sandbox = true; state.song.stage = 'idea'; engine.setLoop({ enabled: true, start: 0, end: barLen() * 4 }); }, { label: 'noodle pad set up', undoable: false });
      $('#loop-on').checked = true; loopBarsFromEngine(); renderAll(); save();
    } else await openSong(sg.folder);
    toast('Noodle pad: loop is on — hit R and play whatever. Every take you like → "Save to Parts bin" (it pops up after each take, or right-click the take). Set the tempo / loop bars up top.', { kind: 'ok', ms: 12000 });
  }
  async function newSongWizard() {
    if (!state.settings.sharedFolder) return openSettings();
    const d = $('#newsong'); const list = await allTemplates();
    let cur = list.find((t) => t.id === (localStorage.getItem('bp.lastTemplate') || '')) || list[0];
    const sigSel = $('#ns-sig'); sigSel.innerHTML = ''; for (const [n, dd] of TPL.TIME_SIGS) { const o = el('option', null, `${n}/${dd}`); o.value = `${n}/${dd}`; sigSel.append(o); } { const o = el('option', null, 'Other…'); o.value = 'custom'; sigSel.append(o); }
    const nsSig = () => MT.parseTimeSig($('#ns-sig').value) || [4, 4];
    const setNsSig = (ts) => { const lab = MT.tsLabel(ts); if (![...sigSel.options].some((o) => o.value === lab)) { const o = el('option', null, lab); o.value = lab; sigSel.insertBefore(o, sigSel.lastChild); } sigSel.value = lab; };
    const keySel = $('#ns-key'); keySel.innerHTML = ''; for (const k of TPL.KEYS) { const o = el('option', null, k || '—'); o.value = k; keySel.append(o); }
    $('#ns-name').value = '';
    const grid = $('#ns-templates');
    const curStructure = () => { const a = TPL.ARRANGEMENTS.find((x) => x.id === $('#ns-arr').value); return a && a.genre === cur.id ? a.structure : cur.structure; };
    const renderStructure = () => {
      const bpm = bpmOr($('#ns-bpm').value, cur.bpm); const ts = nsSig();
      const structure = curStructure();
      const box = $('#ns-structure'); box.innerHTML = '';
      for (const sct of TPL.layoutSections(structure, bpm, ts)) { const c = el('span', 'sec', sct.name); c.style.background = CB.sectionColor(sct.name); c.style.flexGrow = String(Math.max(1, Math.round((sct.end - sct.start) / TPL.barSeconds(bpm, ts)))); box.append(c); }
      $('#ns-range').textContent = `${TPL.summary({ ...cur, structure, bpm, timeSig: ts })}${cur.bpmRange && cur.bpmRange[1] < 300 ? ` · usual range ${cur.bpmRange[0]}–${cur.bpmRange[1]} bpm` : ''}`;
    };
    const renderTracks = () => {
      const box = $('#ns-tracks'); box.innerHTML = '';
      const rows = cur.trackSetups ? cur.trackSetups.map((t, i) => ({ key: `s${i}`, label: `${t.name}`, on: true })) : (() => {
        const counts = {}; const r = cur.tracks.map((k, i) => { counts[k] = (counts[k] || 0) + 1; return { key: `t${i}:${k}`, kind: k, n: counts[k], on: true }; });
        for (const k of Object.keys(KIND_LABEL)) if (!cur.tracks.includes(k)) r.push({ key: `x:${k}`, kind: k, n: 1, on: false });
        return r.map((x) => ({ ...x, label: `${KIND_LABEL[x.kind]}${cur.tracks.filter((k) => k === x.kind).length > 1 ? ` ${x.n}` : ''}` }));
      })();
      for (const r of rows) { const l = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = r.on; cb.dataset.key = r.key; l.append(cb, document.createTextNode(r.label)); box.append(l); }
      box.onchange = () => { const dm = [...box.querySelectorAll('input')].some((cb) => cb.checked && /:drums$/.test(cb.dataset.key)); $('#ns-click').checked = !dm; };   // no drum machine → click on
    };
    const pick = (t) => {
      cur = t; for (const b of grid.children) b.classList.toggle('sel', b.dataset.id === t.id);
      $('#ns-bpm').value = t.bpm; setNsSig(t.timeSig); $('#ns-key').value = t.key || '';
      $('#ns-click').checked = !(t.tracks || []).includes('drums');   // a drum machine is the click
      const arrs = TPL.arrangementsFor(t.id); const as = $('#ns-arr'); as.innerHTML = ''; $('#ns-arr-row').hidden = !arrs.length;
      for (const a of arrs) { const o = el('option', null, `${a.name}${a.blurb ? ` — ${a.blurb}` : ''}`); o.value = a.id; as.append(o); }
      renderStructure(); renderTracks();
    };
    grid.innerHTML = '';
    for (const t of list) {
      const b = el('button', t.band ? 'band' : null); b.type = 'button'; b.dataset.id = t.id; b.append(el('b', null, t.name), el('span', null, `${t.blurb || ''}${t.bpm ? ` · ${t.bpm} bpm${t.timeSig[0] !== 4 || t.timeSig[1] !== 4 ? ` · ${t.timeSig.join('/')}` : ''}` : ''}`));
      b.addEventListener('click', () => pick(t));
      b.addEventListener('dblclick', () => { pick(t); tryCreate(); });
      if (t.band) M.attach(b, () => [{ title: t.name }, { label: 'Delete this band template', danger: true, action: async () => { const a = await ask('Delete template', `Delete the band template "${t.name}" for everyone?`, [['Delete', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a !== 'ok') return; await bp.templates.remove(t.id); b.remove(); if (cur === t) pick(list[0]); } }]);
      grid.append(b);
    }
    $('#ns-filter').value = ''; $('#ns-filter').oninput = () => { const q = $('#ns-filter').value.trim().toLowerCase(); for (const b of grid.children) b.hidden = !!q && !b.textContent.toLowerCase().includes(q); };
    $('#ns-bpm').oninput = renderStructure; $('#ns-sig').onchange = async () => { if (sigSel.value === 'custom') { const ts = await askTimeSig('Time signature'); setNsSig(ts || [4, 4]); } renderStructure(); }; $('#ns-arr').onchange = renderStructure;
    try { pick(cur); } catch (_) { cur = list[0]; pick(cur); }   // a broken band template never locks the wizard
    // check the name BEFORE the dialog closes (and before the open song is closed): bad / taken names keep everything you picked
    const err = $('#ns-err'); err.hidden = true; $('#ns-name').oninput = () => { err.hidden = true; };
    const tryCreate = async () => {
      const nm = $('#ns-name').value.trim();
      if (!nm) { err.textContent = 'Give the song a name.'; err.hidden = false; $('#ns-name').focus(); return; }
      try { await bp.songs.check(nm); } catch (e) { err.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); err.hidden = false; $('#ns-name').focus(); return; }
      d.close('ok');
    };
    const form = d.querySelector('form');
    form.onsubmit = (e) => { if (e.submitter && e.submitter.id === 'ns-create') { e.preventDefault(); if (form.reportValidity()) tryCreate(); } };
    d.returnValue = ''; d.showModal(); $('#ns-name').focus();
    const ok = await new Promise((resolve) => d.addEventListener('close', function h() { d.removeEventListener('close', h); resolve(d.returnValue === 'ok'); }));
    if (!ok) return;
    const name = $('#ns-name').value.trim();
    if (!name) { status('Give the song a name.'); return; }
    const picked = [...$('#ns-tracks').querySelectorAll('input:checked')].map((cb) => cb.dataset.key);
    const opts = { template: { ...cur, structure: curStructure() }, bpm: bpmOr($('#ns-bpm').value, cur.bpm), timeSig: nsSig(), key: $('#ns-key').value, click: $('#ns-click').checked,
      tracks: cur.trackSetups ? null : picked.map((k) => k.split(':').pop()), trackSetups: cur.trackSetups ? cur.trackSetups.filter((_, i) => picked.includes(`s${i}`)) : null };
    try { localStorage.setItem('bp.lastTemplate', cur.id); } catch (_) {}
    if (state.folder && !(await closeSong())) return;   // close (and save) the current song first, so no empty folder is left behind on Cancel
    const r = await withTakeout(() => bp.songs.create(name)); if (!r) return; await refreshSongs(); state.quietEmpty = true; await openSong(r.folder); state.quietEmpty = false;
    if (state.folder === r.folder && !state.readOnly) await applyTemplate(opts);
  }
  function bpmOr(v, def) { const n = parseFloat(String(v).trim()); return Number.isFinite(n) && n >= 30 && n <= 300 ? n : def; }
  // Lay a template onto the (new, empty) open song: tempo, time sig, key, sections, starter tracks, groove, click.
  async function applyTemplate({ template, bpm, timeSig, key, click, tracks, trackSetups }) {
    const t = template || TPL.BUILTIN.find((x) => x.id === 'blank');
    const b = TPL.barSeconds(bpm, timeSig);
    change(() => {
      engine.setTimeSig(timeSig); engine.setBpm(bpm);
      if (key) state.song.key = key; else delete state.song.key;
      { const base = TPL.BUILTIN.find((x) => x.id === String(t.id || '').split(':')[0]); const st = (base && base.name) || (t.band ? t.name : ''); if (st && t.id !== 'blank') state.song.style = st; }   // the parts bin tags parts with it
      const secs = TPL.layoutSections(t.structure, bpm, timeSig);
      state.song.sections = [...(state.song.sections || []), ...secs.map((sc) => ({ id: newId(), ...sc, by: me(), at: nowIso() }))];
      const chorus = secs.find((sc) => /^chorus/i.test(sc.name));
      if (t.loopBars) engine.setLoop({ enabled: true, start: 0, end: t.loopBars * b });
      else if (chorus) engine.setLoop({ enabled: false, start: chorus.start, end: chorus.end });   // L loops the first chorus
    }, { label: `new song from template "${t.name}"` });
    let firstArm = null;
    if (trackSetups) {
      change(() => { for (const ts of trackSetups) { const nt = engine.addTrack(ts.name || 'Track'); const patch = {}; for (const k of ['type', 'instrument', 'fx', 'gainDb', 'pan', 'color', 'preset', 'drum']) if (ts[k] !== undefined && ts[k] !== null) patch[k] = JSON.parse(JSON.stringify(ts[k])); engine.updateTrack(nt.id, patch); if (!firstArm && nt.instrument === 'audio') firstArm = nt.id; } }, { label: 'starter tracks' });
    } else {
      for (const k of tracks || []) {
        const nt = addTrackOfKind(k); if (!nt) continue;
        if (k === 'drums' && t.drum) engine.updateTrack(nt.id, { drum: { ...nt.drum, ...t.drum } });
        if (!firstArm && TRACK_KINDS[k] && TRACK_KINDS[k].arm && TRACK_KINDS[k].instrument === 'audio') firstArm = nt.id;
      }
    }
    if (firstArm) { state.armedTrack = firstArm; state.selectedTrack = firstArm; }
    engine.click.on = !!click; $('#click-on').checked = !!click;
    $('#bpm').value = engine.bpm; syncTsSelect(); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine();
    dropUndoHistory(); renderAll(); await save();
    status(`"${state.song.name}" is set up from ${t.name}: ${TPL.summary({ ...t, bpm, timeSig })}. Hit R to record${firstArm ? ` on ${engine.track(firstArm).name}` : ''}.`, 10000);
  }
  // ---------- linked sections / section rooms ----------
  // Turn on linking for a section type ("Link all Choruses"): the first Chorus is the room, the others play a mirror
  // of it (TPL.linkMirrors). Record or edit in the room and every linked Chorus follows. Unlink one to make it different.
  let syncingLinks = false;
  // Repeated parts link on their own (0.11): the first Verse is the room, the other Verses play it. A copy that already
  // has takes of its own stays unlinked (nothing is ever replaced). "Stop linking" stores false so it stays off.
  function autoLink() {
    if (!state.song || state.readOnly || state.ab) return false;
    const groups = state.song.linkGroups || {}; const byType = new Map(); let changed = false;
    for (const s of liveSections().slice().sort((a, b) => a.start - b.start)) { const ty = TPL.sectionType(s.name); if (!ty) continue; if (!byType.has(ty)) byType.set(ty, []); byType.get(ty).push(s); }
    for (const [ty, list] of byType) {
      if (list.length < 2 || groups[ty] !== undefined) continue;
      const room = list.find((x) => !x.unlinked) || list[0];
      for (const x of list) if (x !== room && !x.unlinked && (clipsIn(x).length || liveChords().some((c) => !c.link && c.time >= x.start - 1e-6 && c.time < x.end - 1e-6))) x.unlinked = true;
      state.song.linkGroups = { ...(state.song.linkGroups || {}), [ty]: true }; changed = true;
    }
    return changed;
  }
  // What a copy (mirror) looked like when we last made it, and what its source looked like: an edit made ON a copy
  // (move, trim, gain, mute, fades, MIDI notes) goes back to the room's take, so every copy gets it.
  let linkBase = null;   // null = don't compare (just loaded / undone): nothing counts as an edit
  const clipSig = (c) => JSON.stringify([c.start, c.trimStart || 0, c.trimEnd || 0, c.gainDb || 0, !!c.mute, c.fadeIn || 0, c.fadeOut || 0, c.kind === 'midi' ? c.notes || [] : 0]);
  function resetLinkBase() { linkBase = null; }
  function propagateMirrorEdits() {
    if (!linkBase) return false; let changed = false; const done = new Set();
    for (const t of engine.tracks) for (const m of t.clips.slice()) {
      if (!m.link) continue; const b = linkBase.mirrors.get(m.id); if (!b || clipSig(m) === b.sig && b.track === t.id) continue;
      let src = null, st = null; for (const tt of engine.tracks) { const x = tt.clips.find((y) => y.id === m.link.from && !y.link); if (x) { src = x; st = tt; break; } }
      if (!src || done.has(src.id) || linkBase.sources.get(src.id) !== clipSig(src)) continue;   // the source changed too (tempo, transpose …): not an edit on the copy
      done.add(src.id); changed = true;
      const bc = b.clip;
      src.start = Math.max(0, src.start + (m.start - bc.start)); src.trimStart = Math.max(0, (src.trimStart || 0) + ((m.trimStart || 0) - (bc.trimStart || 0))); src.trimEnd = Math.max(0, (src.trimEnd || 0) + ((m.trimEnd || 0) - (bc.trimEnd || 0)));
      if ((m.gainDb || 0) !== (bc.gainDb || 0)) src.gainDb = m.gainDb; if (!!m.mute !== !!bc.mute) src.mute = !!m.mute;
      if ((m.fadeIn || 0) !== (bc.fadeIn || 0)) src.fadeIn = m.fadeIn; if ((m.fadeOut || 0) !== (bc.fadeOut || 0)) src.fadeOut = m.fadeOut;
      if (m.kind === 'midi' && JSON.stringify(m.notes || []) !== JSON.stringify(bc.notes || [])) {
        const lo = bc.trimStart || 0, hi = lo + Math.max(0, (Number(bc.duration) || 0) - lo - (bc.trimEnd || 0));
        src.notes = [...(src.notes || []).filter((n) => n.t < lo - 1e-6 || n.t >= hi - 1e-6), ...(m.notes || []).map((n) => ({ ...n }))].sort((x, y) => x.t - y.t);
      }
      if (st !== t) { st.clips = st.clips.filter((x) => x !== src); t.clips.push(src); }   // a copy dragged to another track takes the take with it
    }
    return changed;
  }
  function rememberLinkBase() {
    const mirrors = new Map(), sources = new Map();
    for (const t of engine.tracks) for (const c of t.clips) { if (c.link) mirrors.set(c.id, { sig: clipSig(c), track: t.id, clip: JSON.parse(JSON.stringify(c)) }); else sources.set(c.id, clipSig(c)); }
    linkBase = { mirrors, sources };
  }
  // follower → room helpers (a note, a chord or a take made in a linked copy belongs to the room)
  const followerOf = (at) => (state.song ? TPL.followerAt({ sections: state.song.sections, linkGroups: state.song.linkGroups }, at + 1e-4) : null);
  const toRoomTime = (at) => { const fl = followerOf(at); return fl ? fl.group.room.start + (at - fl.section.start) : at; };
  function mirrorSource(c) { if (!c || !c.link) return null; for (const t of engine.tracks) { const x = t.clips.find((y) => y.id === c.link.from && !y.link); if (x) return { t, c: x }; } return null; }
  function roomShift(sectionId) { for (const g of Object.values(linkInfoCache())) { const f = g.followers.find((x) => x.id === sectionId); if (f) return g.room.start - f.start; } return 0; }
  function syncLinks() {
    if (syncingLinks || !state.song || state.ab) return false;
    const auto = autoLink();
    const r0 = syncLinksInner();
    return auto || r0;
  }
  function syncLinksInner() {
    const anyOn = state.song.linkGroups && Object.values(state.song.linkGroups).some(Boolean);
    if (!anyOn) {   // nothing linked (any more): leftover copies become ordinary clips
      const stuck = engine.tracks.some((t) => t.clips.some((c) => c.link)) || CB.list(state.song, 'chords').some((x) => x.link);
      if (!stuck) return false;
      for (const t of engine.tracks) for (const c of t.clips) delete c.link; for (const x of CB.list(state.song, 'chords')) delete x.link;
      return true;
    }
    syncingLinks = true;
    try {
      const edited = propagateMirrorEdits();
      try { return syncLinksBody() || edited; } finally { rememberLinkBase(); }
    } finally { syncingLinks = false; }
  }
  // how far a part's takes may reach past its edges and still belong to it (pickup before the downbeat, ring-out after): 1 bar
  function partEdge(sec) { try { return barLenAt(Math.max(0, sec.start + 1e-3)); } catch (_) { return 2; } }
  function syncLinksBody() {
    {
      // own takes that reach into a linked copy (full run-through, dropped part, older Cobander) are cut at its edges;
      // the inside piece goes to Deleted takes — that part plays the room now
      const carved = TPL.carveFollowers({ tracks: engine.tracks, sections: state.song.sections, linkGroups: state.song.linkGroups }, { clipLength: (c) => engine.clipLength(c), newId, edge: partEdge, through: (t) => isVocalTrack(t) });
      if (carved.changed) {
        engine.tracks.forEach((t, i) => { t.clips = carved.tracks[i].clips; });
        for (const rm of carved.removed) { const t = engine.track(rm.trackId); if (t) trashClip(t, rm.clip); }
        for (const mv of carved.moved || []) { const t = engine.track(mv.trackId); if (!t) continue; for (const x of t.clips) if (!x.link && !x.mute && x.start < mv.clip.start + engine.clipLength(mv.clip) - 0.01 && x.start + engine.clipLength(x) > mv.clip.start + 0.01) x.mute = true; t.clips.push(mv.clip); }   // the new take plays in the room (and so in every copy); what it covers there is muted, like any new take
        if ((carved.unlinked || []).length) { for (const id of carved.unlinked) { const s = liveSections().find((x) => x.id === id); if (s) s.unlinked = true; } setTimeout(() => status(`${carved.unlinked.map((id) => (liveSections().find((x) => x.id === id) || {}).name).filter(Boolean).join(', ')} kept the take that ran into ${carved.unlinked.length > 1 ? 'them' : 'it'} — unlinked (right-click → Re-link to follow the room again).`, 9000), 0); }
      }
      const view = { tracks: engine.tracks, sections: state.song.sections, linkGroups: state.song.linkGroups };
      const r = TPL.linkMirrors(view, { clipLength: (c) => engine.clipLength(c), edge: partEdge, through: (t) => isVocalTrack(t) });
      // chords follow the room too (mirrors marked `link`, deterministic ids)
      const chords = CB.list(state.song, 'chords'); const own = chords.filter((x) => !x.link);
      const mirrored = [];
      for (const g of Object.values(r.info)) for (const f of g.followers) for (const ch of own) if (!ch.deleted && ch.time >= g.room.start - 1e-6 && ch.time < g.room.end - 1e-6 && ch.time - g.room.start < f.end - f.start) mirrored.push({ ...ch, id: TPL.hash12(`${ch.id}|${f.id}`), time: f.start + (ch.time - g.room.start), link: { from: ch.id, section: f.id } });
      const chordsChanged = JSON.stringify(chords.filter((x) => x.link).map((x) => [x.id, x.time, x.chord, !!x.deleted])) !== JSON.stringify(mirrored.map((x) => [x.id, x.time, x.chord, false]));
      if (!r.changed && !chordsChanged) return carved.changed;
      if (r.changed) engine.tracks.forEach((t, i) => { t.clips = r.tracks[i].clips; });
      if (chordsChanged) { const fol = Object.values(r.info).flatMap((g) => g.followers); state.song.chords = [...own.filter((x) => !fol.some((f) => x.time >= f.start - 1e-6 && x.time < f.end - 1e-6)), ...mirrored]; }
      return true;
    }
  }
  const linkInfoCache = () => TPL.linkInfo({ sections: state.song ? state.song.sections : [], linkGroups: state.song ? state.song.linkGroups : null });
  $('#btn-room-leave').addEventListener('click', () => leaveRoom());
  $('#btn-room-rec').addEventListener('click', () => (engine.recording ? finishRecording() : record()).catch(fail));
  const linkOn = (ty) => !!(state.song && state.song.linkGroups && state.song.linkGroups[ty]);
  function linkMenuItems(s) {
    const ty = TPL.sectionType(s.name); const same = liveSections().filter((x) => TPL.sectionType(x.name) === ty);
    const info = TPL.linkInfo(collectSong())[ty];
    if (!linkOn(ty)) return same.length > 1 ? [{ label: `Link all ${plural(cap(ty))} (record once, plays in every ${cap(ty)})…`, action: () => linkGroup(ty).catch(fail), disabled: ro() }] : [];
    const isRoom = info && info.room && info.room.id === s.id;
    return [
      { label: isRoom ? `Open the ${s.name} room` : s.unlinked ? `Open ${s.name} (unlinked)` : `Go to the ${info && info.room ? info.room.name : ty} room`, action: () => openRoom(isRoom || s.unlinked ? s : info.room) },
      s.unlinked ? { label: `Re-link ${s.name} (follow the room again)…`, action: () => relinkSection(s).catch(fail), disabled: ro() } : { label: `Unlink ${s.name} (make this one different)…`, action: () => unlinkSection(s).catch(fail), disabled: ro() || (isRoom && !(info.followers || []).length) },
      { label: `Stop linking ${plural(cap(ty))}`, action: () => unlinkGroup(ty).catch(fail), disabled: ro() },
    ];
  }
  const plural = (x) => (/(s|sh|ch|x)$/i.test(x) ? `${x}es` : `${x}s`);
  const cap = (x) => String(x).replace(/(^|[\s-])\w/g, (m) => m.toUpperCase());
  const clipsIn = (sec, { mirrors = false } = {}) => engine.tracks.flatMap((t) => t.clips.filter((c) => (mirrors || !c.link) && Math.min(c.start + engine.clipLength(c), sec.end) - Math.max(c.start, sec.start) > 0.01).map((c) => ({ t, c })));
  async function linkGroup(ty) {
    if (ro()) return;
    const same = liveSections().filter((x) => TPL.sectionType(x.name) === ty).sort((a, b) => a.start - b.start);
    const others = same.slice(1).filter((x) => !x.unlinked && clipsIn(x).length);
    let keepOthers = false;
    if (others.length) {
      const a = await ask(`Link all ${plural(cap(ty))}`, `${same[0].name} becomes the room: what you record there plays in every ${cap(ty)}.\n\n${others.map((x) => x.name).join(', ')} already ${others.length === 1 ? 'has' : 'have'} takes of ${others.length === 1 ? 'its' : 'their'} own.`, [['Replace with the room (takes go to Deleted takes)', 'replace', 'primary'], ['Keep those as they are (unlinked)', 'keep'], ['Cancel', 'cancel']]);
      if (a !== 'replace' && a !== 'keep') return; keepOthers = a === 'keep';
    }
    change(() => {
      state.song.linkGroups = { ...(state.song.linkGroups || {}), [ty]: true };
      if (keepOthers) for (const x of others) x.unlinked = true;   // otherwise the next sync cuts their own takes at the section edges (to Deleted takes)
    }, { label: `linked ${plural(cap(ty))}` });
    renderAll(); toast(`${plural(cap(ty))} are linked. Record in ${same[0].name} (right-click it → Open the room) and every linked ${cap(ty)} plays it.`, { kind: 'ok', ms: 9000 });
  }
  async function unlinkGroup(ty) {
    const mine = new Set(liveSections().filter((x) => TPL.sectionType(x.name) === ty).map((x) => x.id));
    change(() => { for (const t of engine.tracks) for (const c of t.clips) if (c.link && mine.has(c.link.section)) delete c.link; for (const ch of CB.list(state.song, 'chords')) if (ch.link && mine.has(ch.link.section)) delete ch.link; const g = { ...(state.song.linkGroups || {}), [ty]: false }; state.song.linkGroups = g; for (const x of liveSections()) if (mine.has(x.id)) delete x.unlinked; }, { label: `stopped linking ${plural(cap(ty))}` });
    renderAll(); status(`${plural(cap(ty))} are no longer linked — every copy is now its own takes.`);
  }
  // Break one section off: its mirrors become its own clips (new ids), and it stops following the room.
  async function unlinkSection(sec) {
    if (ro()) return;
    change(() => {
      for (const t of engine.tracks) t.clips = t.clips.map((c) => (c.link && c.link.section === sec.id ? (() => { const n = { ...c, id: newId() }; delete n.link; return n; })() : c));
      state.song.chords = CB.list(state.song, 'chords').map((ch) => (ch.link && ch.link.section === sec.id ? (() => { const n = { ...ch, id: newId() }; delete n.link; return n; })() : ch));
      sec.unlinked = true;
    }, { label: `unlinked ${sec.name}` });
    renderAll(); toast(`${sec.name} is its own now — change it freely; the room no longer touches it. Right-click → Re-link to follow the room again.`, { kind: 'ok', ms: 9000 });
  }
  async function relinkSection(sec) {
    const own = clipsIn(sec);
    if (own.length) { const a = await ask('Re-link', `${sec.name} has ${own.length} take(s) of its own. Re-linking replaces them with the room (they go to Deleted takes).`, [['Re-link', 'ok', 'primary'], ['Cancel', 'cancel']]); if (a !== 'ok') return; }
    change(() => { delete sec.unlinked; }, { label: `re-linked ${sec.name}` });   // the sync cuts its own takes at the edges
    renderAll();
  }
  function mirrorHint(c) {
    const sec = liveSections().find((x) => x.id === c.link.section);
    status(`That's a linked copy${sec ? ` in ${sec.name}` : ''} and its take isn't in the room any more — right-click → Unlink to make this one its own.`, 8000);
  }
  // A "room": the timeline zooms to one section, loops it, and dims the rest. Recording here = loop-recording that part.
  function openRoom(sec) {
    const s0 = liveSections().find((x) => x.id === sec.id); if (!s0) return;
    if (!state.room) state.room = { prevPx: state.pxPerSec, prevLoop: { ...engine.loop } };
    state.room.id = s0.id;
    const w = Math.max(200, $('#arrange').clientWidth - HEAD_W - 40);
    state.pxPerSec = Math.max(4, Math.min(400, w / Math.max(1, s0.end - s0.start)));
    engine.setLoop({ enabled: true, start: s0.start, end: s0.end }); $('#loop-on').checked = true; loopBarsFromEngine();
    engine.seek(s0.start);
    renderAll(); $('#arrange').scrollLeft = Math.max(0, s0.start * state.pxPerSec - 20);
    const g = TPL.linkInfo(collectSong())[TPL.sectionType(s0.name)];
    const n = g && g.room && g.room.id === s0.id ? g.followers.length : 0;
    $('#room-bar').hidden = false;
    $('#room-name').textContent = `${s0.name} room`;
    $('#room-info').textContent = n ? `Everything here plays in ${n} other ${cap(TPL.sectionType(s0.name))}${n > 1 ? (/s$/i.test(TPL.sectionType(s0.name)) ? 'es' : 's') : ''} too. Hit R — it loops this part; every pass is a take.` : 'Loops this part. Hit R — every pass is a take.';
    document.body.classList.add('in-room'); positionRoomShade();
  }
  function leaveRoom() {
    if (!state.room) return;
    const r = state.room; state.room = null;
    state.pxPerSec = r.prevPx; engine.setLoop(r.prevLoop); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine();
    $('#room-bar').hidden = true; document.body.classList.remove('in-room'); renderAll();
  }
  function positionRoomShade() {
    const sh = $('#room-shade'); if (!sh) return;
    const s0 = state.room && liveSections().find((x) => x.id === state.room.id);
    if (!s0) { sh.hidden = true; return; }
    sh.style.width = `${Math.max($('#arrange').scrollWidth, HEAD_W + engine.contentLength() * state.pxPerSec)}px`;
    sh.hidden = false; sh.style.setProperty('--room-l', `${HEAD_W + s0.start * state.pxPerSec}px`); sh.style.setProperty('--room-r', `${HEAD_W + s0.end * state.pxPerSec}px`);
  }

  // ---------- restructure an existing song into a named structure ----------
  async function arrangementChoices() {
    const out = [];
    for (const t of TPL.BUILTIN) { const arrs = TPL.arrangementsFor(t.id); if (arrs.length) for (const a of arrs) out.push({ ...a, group: t.name }); else if (t.structure.length) out.push({ id: `${t.id}:default`, name: t.name, blurb: t.blurb, structure: t.structure, group: t.name }); }
    try { for (const t of (await bp.templates.list()).map(TPL.normalize).filter(Boolean)) if (t.structure.length) out.push({ id: `band:${t.id}`, name: t.name, blurb: t.blurb || '', structure: t.structure, group: 'Band templates' }); } catch (_) {}
    return out;
  }
  function strip(box, secs, total) {
    box.innerHTML = ''; const tot = total || secs.reduce((n, x) => Math.max(n, x.end), 0) || 1;
    for (const x of secs) { const c = el('span', 'sec' + (x.empty ? ' empty' : ''), x.name); c.style.background = CB.sectionColor(x.name); c.style.flex = `${(x.end - x.start) / tot} 1 0`; c.title = `${x.name}${x.from ? ` ← ${x.from}` : x.empty ? ' (nothing to put here yet)' : ''}`; box.append(c); }
  }
  function restructurePreview(arr) {
    const song = collectSong();
    return TPL.restructure(song, arr.structure, { bpm: engine.bpm, timeSig: engine.timeSig, newId, clipLength: (c) => engine.clipLength(c), linkGroups: state.song.linkGroups });
  }
  async function openRestructure() {
    if (!state.folder) return; if (ro()) { status('Read-only — take over first.'); return; }
    if (!liveSections().length) { toast('Label the parts first: click the sections strip above the tracks and mark Intro / Verse / Chorus… Then Restructure can move them around.', { kind: 'warn', ms: 10000 }); return; }
    const d = $('#restructure'); const choices = await arrangementChoices(); const sel = $('#rs-arr'); sel.innerHTML = '';
    const groups = new Map(); for (const c of choices) { if (!groups.has(c.group)) { const g = document.createElement('optgroup'); g.label = c.group; groups.set(c.group, g); sel.append(g); } const o = el('option', null, `${c.group === 'Band templates' ? '' : `${c.group} · `}${c.name}`); o.value = c.id; groups.get(c.group).append(o); }
    try { const last = localStorage.getItem('bp.lastArrangement'); if (last && choices.some((c) => c.id === last)) sel.value = last; } catch (_) {}
    const nowSecs = liveSections().map((x) => ({ name: x.name, start: x.start, end: x.end }));
    const show = () => {
      const arr = choices.find((c) => c.id === sel.value); if (!arr) return;
      const r = restructurePreview(arr); const tot = Math.max(r.length, nowSecs.reduce((n, x) => Math.max(n, x.end), 0));
      $('#rs-blurb').textContent = `${arr.blurb ? arr.blurb + ' · ' : ''}${TPL.numberSections(arr.structure).map(([n, b]) => `${n} ${b}`).join(' → ')} bars`;
      strip($('#rs-now'), nowSecs, tot);
      strip($('#rs-after'), r.sections.map((x, i) => ({ ...x, from: r.report.slots[i].from, empty: !r.report.slots[i].from })), tot);
      const rep = $('#rs-report'); rep.innerHTML = '';
      const line = (txt, warn) => rep.append(el('div', warn ? 'warn' : null, txt));
      line(`${r.tracks.reduce((n, t) => n + t.clips.length, 0)} take pieces · ${fmtTime(r.length)} long (was ${fmtTime(engine.contentLength())}).`);
      if (r.report.missing.length) line(`No ${r.report.missing.join(', ')} labelled in this song yet — those slots stay empty to record into.`, true);
      if (r.report.shortened.length) line(`Cut short (first bars only): ${r.report.shortened.join(', ')}.`);
      if (r.report.padded.length) line(`Repeated to fill: ${r.report.padded.join(', ')}.`);
      if (r.report.unusedSections.length) line(`Not used: ${r.report.unusedSections.join(', ')}.`, true);
      if (r.report.notesLeft.length) line(`${r.report.notesLeft.length} note(s) from parts that aren't used get parked at the end, labelled "(was in …)".`);
      if (r.report.droppedClips) line(`${r.report.droppedClips} take(s) sit outside the sections that are used and are left out (still in the song's history).`, true);
    };
    sel.onchange = show; show();
    d.returnValue = ''; d.showModal();
    const ok = await new Promise((resolve) => d.addEventListener('close', function h() { d.removeEventListener('close', h); resolve(d.returnValue === 'ok'); }));
    if (!ok) return;
    const arr = choices.find((c) => c.id === sel.value); try { localStorage.setItem('bp.lastArrangement', arr.id); } catch (_) {}
    return applyRestructure(arr);
  }
  function applyRestructure(arr) {
    if (ro()) throw new Error('read-only');
    if (engine.recording || finishing) throw new Error('stop recording first');
    if (tempoBusy) throw new Error('still re-speeding takes — one moment');
    if (engine.playing) engine.stop();
    const r = restructurePreview(arr);
    if (!r.sections.length) throw new Error('that structure is empty');
    const did = change(() => {
      engine.tracks.forEach((t, i) => { t.clips = r.tracks[i].clips; });
      // stars and emoji follow the take into every piece cut from it
      for (const v of CB.live(CB.list(state.song, 'votes'))) { const ids = r.idMap.get(v.clipId); if (!ids) continue; v.deleted = true; v.deletedBy = me(); for (const nid of ids) state.song.votes.push({ ...v, id: newId(), clipId: nid, deleted: undefined, deletedBy: undefined }); }
      for (const x of CB.live(CB.list(state.song, 'reactions'))) { const ids = r.idMap.get(x.target); if (!ids) continue; x.deleted = true; x.deletedBy = me(); for (const nid of ids) state.song.reactions.push({ ...x, id: newId(), target: nid, deleted: undefined, deletedBy: undefined }); }
      for (const k of ['votes', 'reactions']) if (state.song[k]) state.song[k] = state.song[k].map((x) => { const y = { ...x }; if (y.deleted === undefined) delete y.deleted; if (y.deletedBy === undefined) delete y.deletedBy; return y; });
      for (const x of liveSections()) { x.deleted = true; x.deletedBy = me(); }
      const made = r.sections.map((x) => { const { _from, ...rest } = x; return { id: newId(), ...rest, by: me(), at: nowIso(), _from }; });
      // needs pinned to a section follow it to the first new section cut from it (or lose the pin if it was left out)
      for (const nd of CB.live(CB.list(state.song, 'needs'))) if (nd.sectionId) { const to = made.find((x) => x._from === nd.sectionId); if (to) nd.sectionId = to.id; else delete nd.sectionId; }
      for (const x of made) delete x._from;
      state.song.sections = [...(state.song.sections || []), ...made];
      for (const x of CB.live(CB.list(state.song, 'chords'))) { x.deleted = true; x.deletedBy = me(); }
      state.song.chords = [...(state.song.chords || []), ...r.chords.map((x) => ({ ...x, by: x.by || me(), at: x.at || nowIso() }))];
      for (const l of CB.live(CB.list(state.song, 'lyrics'))) if (typeof l.time === 'number') l.time = r.lyricsMoved.has(l.id) ? r.lyricsMoved.get(l.id) : null;   // lines from parts that were left out go back to "unpinned"
      for (const m of CB.live(CB.list(state.song, 'markers'))) if (r.markersMoved.has(m.id)) m.time = r.markersMoved.get(m.id);
      for (const nl of r.report.notesLeft) { const m = CB.live(CB.list(state.song, 'markers')).find((x) => x.id === nl.id); if (m) { m.time = r.length; m.trackId = null; if (nl.from && !/^\(was in /.test(m.text)) m.text = `(was in ${nl.from}) ${m.text}`; } }   // parked at the end, labelled — never left sitting in the wrong part
      engine.setLoop({ enabled: false }); engine.playhead = 0;
    }, { label: `restructured to "${arr.name}"` });
    if (!did) return null;
    state.selectedClip = null; $('#loop-on').checked = false; loopBarsFromEngine(); renderAll();
    toast(`Restructured to ${arr.name}${r.report.missing.length ? ` — empty slots for ${r.report.missing.join(', ')}` : ''}. ${MOD}+Z puts it back.`, { kind: 'ok', ms: 10000 });
    return r;
  }

  async function saveAsTemplate(folder) {
    const song = folder === state.folder ? collectSong() : (await bp.song.peek(folder)).song;
    const name = await promptName('Template name (the whole band sees it in New song)', `${song.name} shape`);
    if (!name) return;
    const tpl = TPL.fromSong(song, name, me());
    const existing = (await bp.templates.list()).find((x) => x.id === tpl.id);
    if (existing) { const a = await ask('Replace template', `A band template called "${existing.name}" exists. Replace it?`, [['Replace', 'ok', 'primary'], ['Cancel', 'cancel']]); if (a !== 'ok') return; }
    await bp.templates.write(tpl);
    toast(`Saved band template "${tpl.name}" (${tpl.structure.length} sections, ${tpl.trackSetups.length} tracks, ${tpl.bpm} bpm). It shows up in New song for everyone.`, { kind: 'ok', ms: 9000 });
    return tpl;
  }

  // ---------- open / close / save ----------
  // Returns false if the user cancelled (unsaved work could not be resolved).
  // interactive=false (API callers): never open a dialog; throw a structured error instead.
  async function closeSong({ interactive = true } = {}) {
    if (!state.folder) return true;
    if (state.song) { await flushTracks().catch(() => {}); const mineIds = engine.tracks.filter((t) => mineT(t.id)).map((t) => t.id); await purgeTrashOnLock(mineIds).catch(() => {}); for (const id of mineIds) await bp.tlock.release(state.folder, id).catch(() => {}); state.tlocks = {}; }
    stopPractice();
    if (engine.recording) await finishRecording().catch(fail);
    if (finishing) await finishing.catch(() => {});
    await flushSketch();
    stopIdea(); if (state.ab) await leaveAB({ silent: true });
    for (let attempt = 0; attempt < 3 && (state.dirty || state.pendingTakes.size); attempt++) {
      if (state.readOnly) {
        if (!interactive) throw new Error('unsaved changes on a read-only song need a decision in the app (take over or discard)');
        const a = await ask('Unsaved changes', `You made changes while this song was read-only${state.pendingTakes.size ? ', including a take that is not on the shared folder yet' : ''}. Take over the lock and save them, or discard?`, [['Take over & save', 'take', 'primary'], ['Discard changes', 'discard'], ['Cancel', 'cancel']]);
        if (a === 'cancel' || !a) return false;
        if (a === 'take') { await takeOver(); if (state.dirty || state.pendingTakes.size) { status('Close cancelled — resolve the save conflict in the banner first.', 8000); return false; } }
        break;
      } else {
        const r = await save();
        if (r === 'readonly') continue;   // lost the lock during the save: go round again into the read-only branch
        if (r === 'conflict') {
          if (!interactive) throw new Error(`save conflict: ${state.pendingExternal.savedBy || 'someone'} saved rev ${state.pendingExternal.rev}; resolve with /song/reload or /song/save {force:true}`);
          const who = state.pendingExternal.savedBy || 'Someone'; const mineTxt = await mineSummary();
          const a = await ask('Save conflict', `${who} saved this song after you opened it.\nYours: ${mineTxt || 'small changes'}.\n\n"Save mine" keeps your changes AND any takes ${who} added. "Discard mine" throws your changes away.`, [['Save mine (keep their takes)', 'overwrite', 'primary'], ['Discard mine', 'discard'], ['Cancel', 'cancel']]);
          if (a === 'cancel' || !a) return false;
          if (a === 'overwrite') { const r2 = await overwriteKeepingTheirs(who); if (r2 !== 'ok') return false; }
        } else if (r === 'error' && state.lastSaveTransient && !state.lastSaveError) {
          // just woke up / Drive mid-sync: wait it out (up to ~40 s) instead of offering to throw the changes away
          let r2 = 'error';
          for (let i = 0; i < 14 && r2 !== 'ok'; i++) { status(`${state.lastSaveTransient} (closing when saved…)`, 0); await new Promise((res) => setTimeout(res, 3000)); state.lastSaveTransient = null; r2 = await save(); if (r2 !== 'error') break; }
          if (r2 !== 'ok') { try { await bp.song.backup(state.folder, collectSong(), [...state.pendingTakes].map(([clipId, p]) => ({ clipId, trackId: p.trackId, clip: p.clip, wav: p.wav, crash: p.crash || null }))); } catch (_) {} status('Could not save yet — your changes are kept on this computer and offered back next time you open the song.', 10000); state.backup = true; }
        } else if (r === 'error') {
          if (!interactive) throw new Error(`could not save: ${state.lastSaveError}`);
          const a = await ask('Could not save', `${state.lastSaveError}\n\nClose anyway and lose the changes?`, [['Keep editing', 'cancel', 'primary'], ['Close and lose changes', 'discard']]);
          if (a !== 'discard') return false;
        }
        break;
      }
    }
    engine.stop();
    if (!state.backup) await bp.song.clearBackup(state.folder);
    await bp.song.close();
    state.songs = state.songs.map((s) => (s.folder === state.folder ? { ...s, lock: null, lockMine: false, lockSameMachine: false } : s));
    state.pendingTakes.clear();
    state.folder = null; state.song = null; state.lock = null; state.readOnly = false; state.dirty = false; state.pendingExternal = null; state.lastSaveError = null; state.backup = null;
    state.undo = []; state.redo = []; state.snapshots = []; state.unreferenced = []; state.pendingActivity = []; presenceSent = ''; ideaBufs.clear();
    engine.buffers.clear(); engine.loadSong({ tracks: [] }); engine.playhead = 0; stopPreview();
    $('#bpm').value = engine.bpm; syncTsSelect(); $('#loop-on').checked = false; loopBarsFromEngine(); positionPlayhead();
    $('#song').hidden = true; $('#no-song').hidden = state.ws === 'band';
    renderSongs();
    return true;
  }

  let opening = null;
  // Loading bar (opening a song can take a while on Drive: every take is read and decoded)
  function showLoading(text, frac) {
    let o = $('#loading'); if (!o) { o = el('div'); o.id = 'loading'; o.append(el('div', 'ld-text'), Object.assign(el('div', 'ld-bar'), { innerHTML: '<i></i>' })); document.body.append(o); }
    o.hidden = false; o.querySelector('.ld-text').textContent = text; o.querySelector('.ld-bar i').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }
  function hideLoading() { const o = $('#loading'); if (o) o.hidden = true; }
  function openSong(folder, opts = {}) {
    if (opening) return opening.catch(() => {}).then(() => openSong(folder, opts));
    opening = _openSong(folder, opts).finally(() => { opening = null; });
    return opening;
  }
  async function _openSong(folder, { force = false, interactive = true, quiet = false } = {}) {   // quiet: a batch pass (chart every song) — don't mark it seen or show what changed
    if (state.folder === folder) { if (force) return takeOver(); return; }
    if (!(await closeSong({ interactive }))) return;
    showLoading(`Opening ${folder}…`, 0.03); let r0;
    try {
      await engine.init();
      r0 = await bp.song.open(folder, { force, quiet }); showLoading(`Opening ${folder}… loading takes`, 0.1);
      state.loadProgress = (d, n) => showLoading(n ? `Opening ${folder}… takes ${d}/${n}` : `Opening ${folder}…`, 0.1 + 0.85 * (n ? d / n : 1));
      await applyLoaded(folder, r0, { fresh: true });
    } finally { state.loadProgress = null; hideLoading(); }
    const r = r0;
    for (const x of document.querySelectorAll('#toasts .toast[data-song]')) if (x.dataset.song !== folder) x.remove();   // stale buttons from the last song
    status(r.readOnly ? `Opened read-only — ${r.lock ? r.lock.user : 'someone'} has it open` : `Opened ${r.song.name}`);
    if (!r.readOnly && !(r.song.tracks || []).length && !state.quietEmpty) toast('Empty song. Click "+ track" (top left of the timeline) or just hit R to record your first take.', { kind: '', ms: 10000 });
    if (!r.readOnly) scheduleTakeNameSync();
    setTimeout(() => checkCrashRecordings().catch(() => {}), 500);
    if (state.lastSeenAtOpen && !quiet) { const f = state.folder; setTimeout(() => { if (state.folder === f) showWhatChanged().catch(() => {}); }, 700); }
    { const f = state.folder; state.keyDoubt = null; renderKeyChip(); setTimeout(() => { if (state.folder === f) keyCheck().catch(() => {}); }, 2500); }
    if (!r.readOnly) fixTrackTypes();   // older songs: bring take file names up to "<track> - <take> - <who> - <id>.wav"
    const backup = await bp.song.readBackup(folder);
    if (backup && backup.song && backup.song.saveId !== undefined) {
      state.backup = backup; updateBadges();
    }
  }

  // Take the lock without reloading; keeps whatever is in memory (and saves it if dirty).
  async function takeOver({ interactive = true } = {}) {
    if (!state.folder) return;
    const here = state.songs.find((x) => x.folder === state.folder);
    const rec = here && (here.presence || []).find((p) => p.mode === 'recording');
    if (interactive && rec) {
      const a = await ask('They are recording', `${rec.user} is recording a take right now. Taking over stops them from saving it into the song until they deal with it. Take over anyway?`, [['Wait', 'cancel', 'primary'], ['Take over anyway', 'ok', 'danger']]);
      if (a !== 'ok') return;
    }
    const r = await bp.song.takeOver(state.folder);
    state.readOnly = r.readOnly; state.lock = r.lock;
    if (!r.readOnly) {
      status('You now hold the lock.'); sendPresence();
      $('#bottom').classList.remove('readonly');
      if (state.dirty) await save();   // a conflict here shows the reload/overwrite banner; never silently clobber
    } else {
      status(`Could not take the lock${r.lock ? ` — ${r.lock.user} re-took it` : ''}. Try again.`, 8000);
    }
    renderAll();
  }

  // state.base = the song exactly as it is on disk (last load or save), deep-frozen. It is the merge ancestor:
  // "did I change this since?" is always answered against it, never against state.song (which edits mutate in place).
  async function applyLoaded(folder, r, { fresh = false, base, keepMine = true } = {}) { resetLinkBase();
    state.base = JSON.parse(JSON.stringify(base !== undefined ? base : r.song));
    const keepArmed = state.armedTrack, keepSel = state.selectedTrack, keepClip = state.selectedClip;
    state.folder = folder; state.song = r.song; state.readOnly = r.readOnly; state.lock = r.lock; state.dirty = false; state.pendingExternal = null; state.lastSaveError = null;
    // my comments still in the mailbox (the editor hasn't merged them yet) keep showing; once merged they're dropped
    if (fresh) state.pendingMail = [];
    appliedPost.clear(); if (fresh) { state.tlocks = {}; state.trackDirty = new Set(); state.foldedPosts = []; }
    if (!fresh && keepMine && state.song && engine.tracks.length) {   // a reload (bandmate saved): the tracks I have unlocked stay as I have them
      const mineNow = engine.toSongFields().tracks.filter((t) => mineT(t.id));
      if (mineNow.length) { r.song.tracks = (r.song.tracks || []).map((t) => mineNow.find((m) => m.id === t.id) || t); for (const m of mineNow) if (!r.song.tracks.some((t) => t.id === m.id)) r.song.tracks.push(m); }
    }
    if (state.pendingMail && state.pendingMail.length && state.song) {
      state.pendingMail = state.pendingMail.filter((o) => { const cur = (state.song[o.key] || []).find((x) => x.id === o.entry.id); if (cur && JSON.stringify(CB.mergeEntry(cur, o.entry, o.base, o.key === 'markers' ? 'replies' : null)) === JSON.stringify(cur)) return false; if (state.readOnly) state.song[o.key] = CB.mergeList(state.song[o.key] || [], [o.entry], o.base ? [o.base] : [], o.key === 'markers' ? 'replies' : null); return state.readOnly; });
    }
    state.bounces = r.bounces || []; state.unreferenced = r.unreferenced || [];
    state.selectedTrack = null; state.selectedClip = null; state.armedTrack = null;
    if (fresh) stopPractice();
    if (fresh && state.room) { state.room = null; $('#room-bar').hidden = true; document.body.classList.remove('in-room'); }
    if (fresh) { arrange.scrollLeft = 0; arrange.scrollTop = 0; }   // a new song starts at bar 1, not where the last one was scrolled
    if (fresh) { state.undo = []; state.redo = []; state.snapshots = []; state.backup = null; renderFx.lastTrack = undefined; state.pendingActivity = []; state.ab = null; state.lastSeenAtOpen = r.lastSeen || null; state.freshClips = null; state.changes = null; state.mixAB = null; if (state.pitch) state.pitch.clear(); }
    await loadAudio(folder, r.song, fresh ? state.loadProgress : null);
    engine.loadSong(r.song);
    if (fresh) engine.playhead = 0;
    if (fresh && !r.readOnly && state.settings.autoUnlockTracks) { if (!ME) ME = await bp.identity().catch(() => null); state.tlocks = await bp.tlock.list(folder).catch(() => ({})); await unlockAll({ quiet: true }); }
    if (!fresh) { if (engine.track(keepArmed)) state.armedTrack = keepArmed; if (engine.track(keepSel)) state.selectedTrack = keepSel; if (engine.tracks.some((t) => t.clips.some((c) => c.id === keepClip))) state.selectedClip = keepClip; }
    // (nothing is armed when a song opens — the last person's armed track is theirs, not yours: R uses the selected track)
    if (!state.selectedTrack && engine.tracks.length) state.selectedTrack = state.armedTrack || engine.tracks[0].id;
    if (state.ws === 'band' && fresh && !kara.open) setWorkspace('write'); if (state.ws !== 'band') { $('#song').hidden = false; $('#no-song').hidden = true; }
    $('#song-title').textContent = r.song.name;
    $('#notes').value = r.song.notes || '';
    $('#bpm').value = engine.bpm; $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); syncTsSelect();
    $('#bottom').classList.toggle('readonly', state.readOnly);
    $('#notes').readOnly = state.readOnly;
    renderAll(); renderSongs(); renderBounces(); updateBadges(); sendPresence();
    refreshHistoryIds().then(() => { if (state.folder === folder) renderFeed(); });
  }

  async function loadAudio(folder, song, onProgress = null) {
    const need = [];
    const seen = new Set();
    for (const t of song.tracks || []) for (const c of t.clips || []) { const a = audioId(c); if (c.kind !== 'midi' && !engine.buffers.has(a) && !seen.has(a)) { seen.add(a); need.push(a); } }
    let done = 0; if (onProgress) onProgress(0, need.length);
    const results = await Promise.all(need.map(async (a) => {
      try { const ab = await bp.audio.read(folder, a); engine.buffers.set(a, await window.BPWav.decodeWav(engine.ctx, ab)); state.missingClips.delete(a); return true; }
      catch (err) { state.missingClips.add(a); return false; }
      finally { done++; if (onProgress) onProgress(done, need.length); }
    }));
    const referenced = new Set((song.tracks || []).flatMap((t) => (t.clips || []).filter((c) => c.kind !== 'midi').map((c) => audioId(c))));
    for (const id of [...state.missingClips]) if (!referenced.has(id)) state.missingClips.delete(id);
    if (results.some((r) => !r)) status(`${state.missingClips.size} take(s) not synced yet — ${cloudName()} is probably still downloading them. They will appear when they arrive.`, 8000);
  }

  bp.onAudioArrived(() => retryMissingClips());
  setInterval(() => { retryMissingClips(); refreshBounces(); }, 10000);
  async function refreshBounces() { if (!state.folder) return; try { const b = await bp.bounce.list(state.folder); if (JSON.stringify(b) !== JSON.stringify(state.bounces)) { state.bounces = b; renderBounces(); } } catch (_) {} }
  let retrying = false;
  async function retryMissingClips() {
    if (!state.folder || !state.missingClips.size || retrying) return;
    retrying = true;
    try {
      const before = state.missingClips.size;
      await loadAudio(state.folder, collectSong());
      if (state.missingClips.size < before) { renderTracks(); status(`${before - state.missingClips.size} take(s) arrived from ${cloudName()}.`); }
    } finally { retrying = false; }
  }

  function collectSong() {
    if (state.ab) return { ...JSON.parse(state.ab.current), ...collabFields(state.song) };   // engine holds the version being auditioned; the song is what it was
    return { ...state.song, ...engine.toSongFields(), notes: $('#notes').value };
  }
  const collabFields = (song) => Object.fromEntries(CB.COLLECTIONS.filter((k) => song && song[k] !== undefined).map((k) => [k, song[k]]));
  // "tracks & takes" from an older save, today's notes / lyrics / chords / needs. With linked sections the takes only make
  // sense with the sections + link groups they were laid out in (mirrors and rooms), so those come back with them.
  const takesOnly = (body) => { const linked = Object.keys(body.linkGroups || {}).length || Object.keys((state.song && state.song.linkGroups) || {}).length; const out = { ...body, ...collabFields(state.song) }; if (linked) { out.sections = body.sections || []; out.linkGroups = body.linkGroups || {}; } return out; };

  // Returns 'ok' | 'conflict' | 'error' | 'readonly' | 'skipped'
  async function save(opts = {}) {
    if (!state.folder) return 'skipped';
    if (state.savePromise) { await state.savePromise.catch(() => {}); if (!state.dirty && !state.pendingTakes.size) return 'ok'; }
    state.savePromise = _save(opts).then((r) => { const ev = state.stashedExternal; state.stashedExternal = null; if (ev && r !== 'ok') onExternal(ev); return r; }).finally(() => { state.savePromise = null; });
    return state.savePromise;
  }
  async function retryPendingTakes() {
    for (const [id, p] of [...state.pendingTakes]) {
      try { await bp.audio.write(state.folder, id, p.wav, { label: takeLabel(engine.track(p.trackId), p.clip) }); state.pendingTakes.delete(id); if (p.crash && ![...state.pendingTakes.values()].some((q) => q.crash === p.crash)) bp.rec && bp.rec.end(p.crash).catch(() => {}); }
      catch (err) { if (/already exists/.test(err.message)) { state.pendingTakes.delete(id); if (p.crash && ![...state.pendingTakes.values()].some((q) => q.crash === p.crash)) bp.rec && bp.rec.end(p.crash).catch(() => {}); } else throw new Error(`Take "${p.clip.name}" could not be written to the shared folder: ${err.message}`); }
    }
  }
  async function _save({ force = false } = {}) {
    if (!state.folder) return 'skipped';
    if (state.readOnly) { status('Read-only: use "Take over" to edit this song.'); return 'readonly'; }
    if (state.pendingExternal && state.pendingExternal.deleted) { state.lastSaveError = 'the song folder was deleted or renamed'; updateBadges(); return 'error'; }
    state.saving = true;
    try {
      await retryPendingTakes();
      if (syncLinks()) renderTracks();
      if (state.pendingActivity.length) { const ent = CB.activityEntry(state.pendingActivity, me(), new Date().toISOString(), window.BPUtil.newId()); if (ent) ent.base = state.song.saveId || null; CB.pushActivity(state.song, ent); state.pendingActivity = []; }   // base = the save this one replaced = the roll-back point "before this"
      const folded = state.foldedPosts.splice(0);
      const song = collectSong(); const seq = state.editSeq || 0; const songObj = state.song;
      const r = await bp.song.save(state.folder, song, { expectedSaveId: state.song.saveId || null, force });
      if (r.conflict) {
        state.foldedPosts.unshift(...folded);
        state.pendingExternal = { rev: r.onDisk.rev, saveId: r.onDisk.saveId, savedBy: r.onDisk.savedBy, savedAt: r.onDisk.savedAt, conflict: true };
        updateBadges();
        status(`Not saved: ${r.onDisk.savedBy || 'someone'} saved rev ${r.onDisk.rev} after you opened. Reload or overwrite.`, 0);
        return 'conflict';
      }
      state.base = JSON.parse(JSON.stringify(r.song)); state.pendingExternal = null; state.lastSaveError = null;
      for (const f of folded) bp.tracks.remove(state.folder, f.file, f.id).catch(() => {});   // bandmates' tracks are in song.json now
      // keep the SAME song object (lanes, menus and drags hold references into it) and just take the save's stamps;
      // replacing it with the deserialized copy made the next section drag / chord delete edit a dead object
      for (const k of ['format', 'rev', 'saveId', 'lineage', 'lineageFor', 'savedBy', 'savedAt']) { if (r.song[k] === undefined) delete songObj[k]; else songObj[k] = r.song[k]; }
      if ((state.editSeq || 0) !== seq) markDirty();   // edited while the save was in flight: those edits are already in the song; save again
      else state.dirty = false;
      scheduleTakeNameSync();
      setTimeout(() => refreshHistoryIds().then(renderFeed).catch(() => {}), 1500);
      updateBadges(); status(`Saved rev ${r.song.rev}`);
      return 'ok';
    } catch (err) {
      const m = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (/took over/.test(m)) { status(m, 10000); updateBadges(); return 'readonly'; }   // lock-loss handler already switched us to read-only; no "retry" banner
      if (/Will retry/.test(m)) { state.lastSaveTransient = m; status(m, 8000); clearTimeout(state.autosaveTimer); state.autosaveTimer = setTimeout(() => { if (state.dirty && !engine.recording) save(); }, 6000); updateBadges(); return 'error'; }
      state.lastSaveError = m; updateBadges(); fail(err); return 'error';
    } finally { state.saving = false; }
  }
  // Take files on Drive carry a human label ("<track> - <take> - <who>") in front of the id so bandmates can
  // find them in Explorer/Finder/any DAW. Labels follow renames; the id never changes.
  const takeLabel = (track, clip) => { const tn = (track && track.name) || 'Track', cn = clip.name || 'take'; return `${tn}${cn.toLowerCase() === tn.toLowerCase() ? '' : ` - ${cn}`}${clip.takenBy ? ` - ${clip.takenBy}` : ''}`; };
  let takeSyncTimer = null;
  function scheduleTakeNameSync() { clearTimeout(takeSyncTimer); takeSyncTimer = setTimeout(() => syncTakeNames().catch(() => {}), 2500); }
  async function syncTakeNames() {
    if (!state.folder || state.readOnly) return [];
    const folder = state.folder; const renamed = [];
    const done = new Set();
    const all = engine.tracks.flatMap((t) => t.clips.map((c) => [t, c]));
    for (const [t, c] of all) {
      const a = audioId(c); if (c.kind === 'midi' || state.missingClips.has(a) || done.has(a)) continue;
      done.add(a);
      const orig = all.find(([, x]) => x.id === a) || [t, c];   // the un-split original names the file; pieces share it
      try { const r = await bp.audio.rename(folder, a, takeLabel(orig[0], orig[1])); if (r) renamed.push({ clipId: a, file: r.split(/[\\/]/).pop() }); }
      catch (_) { /* Drive may be holding the file; next save tries again */ }
      if (state.folder !== folder) return renamed;
    }
    if (renamed.length) status(`${renamed.length} take file${renamed.length === 1 ? '' : 's'} renamed in the shared folder to match the song.`);
    return renamed;
  }
  // Used by the API: did the save actually land?
  const saved = () => !state.dirty && !state.pendingTakes.size;

  // After a recording/import: the WAV is already on disk, so a metadata conflict must
  // never lose the take. Merge the new clip into the on-disk song instead of giving up.
  async function saveWithClip(trackId, clipOrClips, trackName) {
    const clips = Array.isArray(clipOrClips) ? clipOrClips : [clipOrClips];
    if (state.readOnly) { state.trackDirty.add(trackId); await flushTracks(); return 'ok'; }   // someone else has the song: my track goes to them
    state.dirty = true;
    let r = await save();
    if (r !== 'conflict') return r;
    // The take (and everything else unsaved) is in memory: merge it all onto their version — never rebuild from theirs.
    r = await overwriteKeepingTheirs(state.pendingExternal && state.pendingExternal.savedBy, { quiet: true });
    if (r === 'ok') status('Your take was merged into the version your bandmate saved meanwhile.');
    return r;
  }

  // Undo entries carry a label so "Undone" can say what it undid.
  // "Overwrite with mine" never throws away a bandmate's takes: anything in their version that
  // mine doesn't have (whole tracks, or takes on a shared track) is carried over before the force-save.
  function mergeTheirsInto(mine, theirs, baseline = null) {
    const kept = [];
    const trash = mine.trash || {};
    const myTracks = new Map((mine.tracks || []).map((t) => [t.id, t]));
    const baseClips = new Map(); for (const t of (baseline && baseline.tracks) || []) for (const c of t.clips || []) baseClips.set(c.id, JSON.stringify(c));
    const baseTracks = new Map(((baseline && baseline.tracks) || []).map((t) => [t.id, t]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // song-level settings (tempo, notes text, loop…): one side changed it since the base → that side's value
    if (baseline) for (const k of ['bpm', 'timeSig', 'notes', 'loop', 'master', 'key', 'stage']) if (same(mine[k], baseline[k]) && !same(theirs[k], baseline[k])) { if (theirs[k] === undefined) delete mine[k]; else mine[k] = JSON.parse(JSON.stringify(theirs[k])); }
    { // link groups merge type by type (Alice links Verses while Bob links Choruses: both stay linked)
      const b = (baseline && baseline.linkGroups) || {}, m = mine.linkGroups || {}, t = theirs.linkGroups || {}; const out = { ...m };
      for (const k of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) if (!!m[k] === !!b[k] && !!t[k] !== !!b[k]) { if (t[k]) out[k] = true; else delete out[k]; }
      if (Object.keys(out).length || mine.linkGroups) mine.linkGroups = out;
    }
    for (const tt of theirs.tracks || []) {
      const mt = myTracks.get(tt.id);
      if (!mt && (mine.trashTracks || {})[tt.id]) continue;   // I deleted this track on purpose; its takes are in my trash
      if (!mt && baseTracks.has(tt.id)) continue;             // it was there when I loaded and I removed it (undo / restore): stays removed
      if (mt && baseTracks.has(tt.id)) {                      // track settings (name, mix, fx…) they changed and I didn't
        const bt = baseTracks.get(tt.id);
        for (const k of Object.keys(tt)) if (k !== 'clips' && k !== 'id' && same(mt[k], bt[k]) && !same(tt[k], bt[k])) mt[k] = JSON.parse(JSON.stringify(tt[k]));
      }
      if (!mt) { mine.tracks.push(JSON.parse(JSON.stringify(tt))); kept.push(`track ${tt.name} (${(tt.clips || []).length} take${(tt.clips || []).length === 1 ? '' : 's'})`); continue; }
      for (const c of tt.clips || []) {
        const i = mt.clips.findIndex((x) => x.id === c.id);
        if (i < 0) { if (!trash[c.id] && !baseClips.has(c.id)) { mt.clips.push(JSON.parse(JSON.stringify(c))); kept.push(`${c.name} on ${mt.name}`); } continue; }   // in the base but not in mine = I removed it
        // a take I did not touch since loading keeps THEIR edits (mute / gain / trim / position)
        if (baseClips.has(c.id) && baseClips.get(c.id) === JSON.stringify(mt.clips[i]) && JSON.stringify(c) !== baseClips.get(c.id)) mt.clips[i] = JSON.parse(JSON.stringify(c));
      }
      // takes THEY deleted that I did not touch: honour the deletion (their trash entry comes along so it stays restorable)
      for (const [id, tr] of Object.entries(theirs.trash || {})) { const i = mt.clips.findIndex((x) => x.id === id); if (i >= 0 && baseClips.has(id) && baseClips.get(id) === JSON.stringify(mt.clips[i])) { mt.clips.splice(i, 1); mine.trash = { ...(mine.trash || {}), [id]: tr }; } }
    }
    for (const [id, tr] of Object.entries(theirs.trash || {})) if (!(mine.trash || {})[id] && !mine.tracks.some((t) => t.clips.some((c) => c.id === id))) mine.trash = { ...(mine.trash || {}), [id]: tr };
    mine.trashTracks = { ...(theirs.trashTracks || {}), ...(mine.trashTracks || {}) };
    // notes, reactions, sections, chords, lyrics, needs, votes, ideas, versions, activity: field-level 3-way merge by id
    kept.push(...CB.mergeCollections(mine, theirs, baseline));
    return kept;
  }
  // The common ancestor of "mine" and their disk copy. Never guess: a wrong ancestor silently reverts someone's edits.
  //   their save descends from the one I loaded/saved  → that (state.base)
  //   their save is an ancestor of mine (Drive served an old file) → their copy itself (nothing of theirs is new)
  //   a known ancestor was passed (from history)        → that
  //   otherwise                                          → none: union merge, mine wins where both have a value
  const trustedLineage = (sg) => (sg && Array.isArray(sg.lineage) && sg.lineageFor === sg.saveId ? sg.lineage : []);
  function mergeBaseFor(disk, given) {
    const b = state.base;
    if (b && b.saveId && (disk.saveId === b.saveId || trustedLineage(disk).includes(b.saveId))) return b;
    const mine = [...trustedLineage(state.song), state.song && state.song.saveId].filter(Boolean);
    if (disk.saveId && mine.includes(disk.saveId)) return disk;
    return given || null;
  }
  async function overwriteKeepingTheirs(who, { quiet = false, base } = {}) {
    let r = 'conflict', kept = [];
    if (state.ab) await leaveAB({ silent: true });   // in A/B the engine holds the old version: merging into it would drop their takes
    for (let attempt = 0; attempt < 4 && r === 'conflict'; attempt++) {   // someone saved again mid-merge: merge again, never force
      const disk = await bp.song.reload(state.folder);
      const mine = collectSong();
      kept = mergeTheirsInto(mine, disk.song, mergeBaseFor(disk.song, attempt === 0 ? base : undefined));
      state.snapshots.push({ id: window.BPUtil.newId(), label: `${who || 'bandmate'}'s rev ${disk.song.rev} (merged under yours)`, at: new Date().toISOString(), json: JSON.stringify(disk.song) });
      if (state.snapshots.length > 30) state.snapshots.shift();
      await loadAudio(state.folder, mine);
      await applyLoaded(state.folder, { song: { ...mine, saveId: disk.song.saveId, rev: disk.song.rev, lineage: [...new Set([...trustedLineage(state.song), state.song.saveId, ...trustedLineage(disk.song)].filter(Boolean))].slice(-1000), lineageFor: disk.song.saveId }, readOnly: state.readOnly, lock: state.lock, bounces: disk.bounces, unreferenced: disk.unreferenced }, { base: disk.song });
      state.dirty = true; dropUndoHistory();
      r = await save();
    }
    if (r === 'ok') toast(quiet ? `Saved — merged with what ${who || 'your bandmate'} saved meanwhile${kept.length ? ` (kept: ${kept.join(', ')})` : ''}.` : kept.length ? `Saved yours. Kept from ${who || 'your bandmate'}'s version: ${kept.join(', ')}.` : 'Saved your version.', { kind: 'ok', ms: 10000 });
    refreshUnreferenced();
    return r;
  }
  // What "mine" is, for the reload-theirs confirmation.
  async function mineSummary() { try { const disk = await bp.song.peek(state.folder); return describeDiff(disk.song, collectSong()); } catch (_) { return ''; } }
  function pushUndo(label = 'change') {
    try { state.undo.push({ json: JSON.stringify(collectSong()), label }); if (state.undo.length > 60) state.undo.shift(); state.redo = []; } catch (_) {}
  }
  const undoLabel = (e) => (e && typeof e === 'object' ? e.label : 'change');
  const undoJson = (e) => (e && typeof e === 'object' ? e.json : e);
  async function restoreSnapshot(json, { quiet = false, keepHeld = true } = {}) { resetLinkBase(); state.mixAB = null; if (typeof mixABRender === 'function') mixABRender();
    if (engine.recording || finishing) throw new Error('cannot restore while recording');
    if (state.ab) await leaveAB();
    const song = JSON.parse(json);
    const keepSong = state.song, pe = state.pendingExternal;
    for (const k of ['activity', 'versions']) if (keepSong && keepSong[k]) song[k] = keepSong[k];   // append-only logs are not rolled back by undo
    { // undo never rolls back a track someone else has unlocked (their work arrived in between)
      const cur = engine.toSongFields().tracks; const held = keepHeld ? cur.filter((t) => heldBy(t.id)) : [];
      if (held.length) { song.tracks = (song.tracks || []).map((t) => held.find((h) => h.id === t.id) || t); for (const h of held) if (!song.tracks.some((t) => t.id === h.id)) song.tracks.push(h); }
    }
    await applyLoaded(state.folder, { song: { ...song, saveId: keepSong.saveId, rev: keepSong.rev, lineage: keepSong.lineage }, readOnly: state.readOnly, lock: state.lock, bounces: state.bounces, unreferenced: state.unreferenced }, { base: state.base, keepMine: false });
    state.pendingExternal = pe;
    if (!(quiet && state.readOnly)) markDirty(); renderAll();
  }
  async function undo() { if (!state.folder) return; if (tempoBusy || transposeBusy) { status('Still re-speeding the takes — one moment.'); return; } if (!state.undo.length || state.readOnly || engine.recording || finishing) { if (!state.undo.length) status('Nothing to undo.'); return; } const e = state.undo.pop(); state.redo.push({ json: JSON.stringify(collectSong()), label: undoLabel(e) }); await restoreSnapshot(undoJson(e)); logActivity(`undid ${undoLabel(e)}`); status(`Undid: ${undoLabel(e)} (${MOD}+Shift+Z redoes)`); refreshUnreferenced(); updateUndoButtons(); }
  async function redo() { if (!state.folder) return; if (tempoBusy || transposeBusy) { status('Still working on the last change — one moment.'); return; } if (!state.redo.length || state.readOnly || engine.recording || finishing) { if (!state.redo.length) status('Nothing to redo.'); return; } const e = state.redo.pop(); state.undo.push({ json: JSON.stringify(collectSong()), label: undoLabel(e) }); await restoreSnapshot(undoJson(e)); status(`Redid: ${undoLabel(e)}`); refreshUnreferenced(); updateUndoButtons(); }
  function updateUndoButtons() { const u = $('#btn-undo'), r = $('#btn-redo'); if (!u || !r) return; u.title = state.undo.length ? `Undo: ${undoLabel(state.undo[state.undo.length - 1])} (${MOD}+Z)` : `Nothing to undo (${MOD}+Z)`; r.title = state.redo.length ? `Redo: ${undoLabel(state.redo[state.redo.length - 1])} (${MOD}+Shift+Z)` : 'Nothing to redo'; u.disabled = !state.undo.length || state.readOnly; r.disabled = !state.redo.length || state.readOnly; }

  // Every user mutation goes through here: snapshot for undo (unless told not to), mark dirty, schedule autosave.
  function change(fn, { undoable = true, label = 'change', activity = true, collab = false, force = false } = {}) {
    if (state.readOnly && collab && state.folder && state.song) return mailChange(fn, label);
    if (state.folder && state.song && !collab && !force) return guardedChange(fn, { undoable, label, activity });
    if (state.readOnly) {
      if (!state.waiting) { state.waiting = true; state.waitNudged = false; bp.presence.set({ mode: 'waiting' }).catch(() => {}); }
      status(`Read-only: ${holderName() || 'a bandmate'} has the song — they now see you're waiting, and you'll get a nudge when it's free. (Notes, replies, needs and reactions still work.)`, 8000); return false;
    }
    if (state.ab && !collab) { status('You are A/B-ing a tagged version — press A/B to come back before editing.', 6000); return false; }
    if (undoable) pushUndo(label);
    fn();
    if (activity) logActivity(label);
    markDirty();
    return true;
  }
  // Notes, sections, chords, lyrics, needs, reactions, ideas live in state.song only (not in the engine), so they stay
  // editable while A/B-ing a tagged version — what you hear does not change what you can comment on.
  function cchange(fn, opts = {}) { return change(fn, { ...opts, collab: true }); }
  // ---- track locks: nobody touches a track until they unlock it (🔒 on the track, or "Unlock all"); an unlocked track is
  // yours until you lock it again or leave it alone for 10 min. Whoever has the song open saves song.json and folds in
  // the others' tracks (they post their version to _tracks/); song-wide changes (tempo, transpose, restructure, master,
  // track order) need the song and every track to be free of other people.
  state.tlocks = {}; let ME = null; bp.identity().then((x) => { ME = x; }).catch(() => {});
  const lockOf = (id) => state.tlocks[id];
  const isMe = (l) => !!(l && ME && l.user === ME.user && l.host === ME.host);
  const mineT = (id) => { const l = lockOf(id); return !!(l && !l.idle && isMe(l)); };
  const heldBy = (id) => { const l = lockOf(id); return l && !l.idle && !isMe(l) ? l.user : null; };
  const canTouch = (t) => !!(t && state.song && mineT(t.id));
  const trackFp = (t) => { try { return JSON.stringify(t); } catch (_) { return Math.random().toString(); } };
  const songWideFp = () => JSON.stringify({ bpm: engine.bpm, ts: engine.timeSig, master: engine.master, order: engine.tracks.map((t) => t.id) });
  function guardedChange(fn, { undoable, label, activity }) {
    if (state.ab) { status('You are A/B-ing a tagged version — press A/B to come back before editing.', 6000); return false; }
    const before = new Map(engine.tracks.map((t) => [t.id, trackFp(t)])); const sw0 = songWideFp();
    const snap = JSON.stringify(collectSong());
    if (undoable && !state.readOnly) pushUndo(label);
    fn();
    const after = new Map(engine.tracks.map((t) => [t.id, trackFp(t)]));
    const changed = [...after].filter(([id, fp]) => before.has(id) && before.get(id) !== fp).map(([id]) => id);
    const added = [...after.keys()].filter((id) => !before.has(id)); const removed = [...before.keys()].filter((id) => !after.has(id));
    const orderOnly = JSON.stringify([...before.keys()].filter((id) => after.has(id))) !== JSON.stringify([...after.keys()].filter((id) => before.has(id)));
    const sw = JSON.parse(sw0); const songWide = engine.bpm !== sw.bpm || JSON.stringify(engine.timeSig) !== JSON.stringify(sw.ts) || JSON.stringify(engine.master) !== JSON.stringify(sw.master) || orderOnly;
    const notMine = [...changed, ...removed].filter((id) => !mineT(id));
    const holders = (ids) => ids.map((id) => heldBy(id) && `${heldBy(id)} has ${(engine.track(id) || { name: 'a track' }).name}`).filter(Boolean);
    let why = null;
    if (songWide && state.readOnly) why = `${holderName() || 'A bandmate'} has the song open — tempo, time signature, the master and track order are theirs to change.`;
    else if (songWide && holders(engine.tracks.map((t) => t.id)).length) why = `That's a whole-song change, and ${holders(engine.tracks.map((t) => t.id)).join(', ')}. When they're done (or their lock fades after 10 min), try again.`;
    else if (notMine.length > 1) why = holders(notMine).length ? `That touches tracks other people have: ${holders(notMine).join(', ')}.` : 'That changes more than one locked track — hit "Unlock all" first.';
    else if (notMine.length) { const t = engine.track(notMine[0]) || { name: 'that track' }; const h = heldBy(notMine[0]); why = h ? `${h} has ${t.name} unlocked — it's theirs until they lock it (or leave it for 10 min).` : `${t.name} is locked — click its 🔒 (or "Unlock all") to work on it.`; }
    if (why) {
      if (undoable && !state.readOnly) state.undo.pop();
      restoreSnapshot(snap, { quiet: true, keepHeld: false }).catch(() => {});
      status(why, 8000); if (!heldBy(notMine[0] || '')) lockNudge(notMine[0]);
      return false;
    }
    for (const id of added) claimLocal(id);
    if (activity) logActivity(label);
    const mine = [...changed, ...added].filter((id) => engine.track(id));
    for (const id of mine) touchLock(id);
    if (state.readOnly) { for (const id of [...mine, ...removed]) state.trackDirty.add(id); flushTracksSoon(); return true; }   // not 'unsaved': it goes to whoever has the song
    markDirty();
    return true;
  }
  state.trackDirty = new Set();
  function lockNudge(id) { const t = id && engine.track(id); if (!t || ro()) return; toast(`${t.name} is locked.`, { kind: 'warn', ms: 6000, buttons: [[`🔓 Unlock ${t.name}`, () => unlockTrack(t.id)], ['Unlock all', () => unlockAll()]] }); }
  function claimLocal(id) { if (!ME) return; state.tlocks[id] = { user: ME.user, host: ME.host, token: 'pending', at: Date.now(), idle: false }; bp.tlock.claim(state.folder, id).then((r) => { if (r && r.lock) state.tlocks[id] = { ...r.lock, idle: false }; }).catch(() => {}); }
  const touchAt = new Map();
  function touchLock(id) { const now = Date.now(); if (now - (touchAt.get(id) || 0) < 20000) return; touchAt.set(id, now); const l = lockOf(id); if (l) l.at = now; bp.tlock.touch(state.folder, id).catch(() => {}); }
  async function unlockTrack(id, { quiet = false } = {}) {
    if (!state.folder) return false; const t = engine.track(id); if (!t) return false;
    const r = await bp.tlock.claim(state.folder, id).catch((err) => ({ ok: false, err }));
    if (r && r.ok) { state.tlocks[id] = { ...r.lock, idle: false }; if (!quiet) { renderAll(); status(`${t.name} is yours — it locks again if you leave it alone for 10 minutes.`, 5000); } return true; }
    if (!quiet) status(r && r.lock ? `${r.lock.user} has ${t.name} unlocked right now.` : `Couldn't unlock ${t.name}.`, 6000);
    return false;
  }
  async function unlockAll({ quiet = false } = {}) {
    if (!state.folder) return; const got = [], taken = [];
    for (const t of engine.tracks) { if (mineT(t.id)) continue; if (heldBy(t.id)) { taken.push(`${heldBy(t.id)} has ${t.name}`); continue; } if (await unlockTrack(t.id, { quiet: true })) got.push(t.name); }
    renderAll(); if (!quiet) status(`${got.length ? `Unlocked ${got.length} track${got.length > 1 ? 's' : ''}` : 'Nothing to unlock'}${taken.length ? ` — ${taken.join(', ')}` : ''}.`, 6000);
  }
  async function lockAll() { if (!state.folder) return; await flushTracks(); const ids = engine.tracks.filter((t) => mineT(t.id)).map((t) => t.id); for (const id of ids) { await bp.tlock.release(state.folder, id).catch(() => {}); delete state.tlocks[id]; } renderAll(); status('Locked — your tracks are free for the band.', 4000); purgeTrashOnLock(ids).catch(() => {}); }
  async function lockTrack(id) { await flushTracks(); await bp.tlock.release(state.folder, id).catch(() => {}); delete state.tlocks[id]; renderAll(); purgeTrashOnLock([id]).catch(() => {}); }
  // A take you deleted is gone for good once its track locks again (Deleted takes holds it until then) — only if
  // nothing live still points at the audio (the song, a tagged version, someone's pending track), checked on disk.
  async function purgeTrashOnLock(trackIds) {
    if (!state.folder || !state.song || state.readOnly || !bp.audio.purge) return;
    const trash = state.song.trash || {}; const mine = Object.entries(trash).filter(([, tr]) => trackIds.includes(tr.trackId) && (!tr.by || CB.nameMatch(tr.by, me())));
    if (!mine.length) return;
    if (state.dirty) { const r = await save(); if (r !== 'ok') return; }   // the song on disk must already not reference them
    const ids = [...new Set(mine.map(([, tr]) => (tr.clip ? audioId(tr.clip) : null)).filter(Boolean))].filter((id) => !engine.tracks.some((t) => t.clips.some((c) => audioId(c) === id)));
    if (!ids.length) return;
    const r = await bp.audio.purge(state.folder, ids);
    if (r.removed.length) {
      change(() => { const tr = { ...state.song.trash }; for (const [k, e] of mine) if (e.clip && r.removed.includes(audioId(e.clip))) delete tr[k]; state.song.trash = tr; }, { label: `cleared ${r.removed.length} deleted take${r.removed.length === 1 ? '' : 's'}`, undoable: false, activity: false });
      refreshUnreferenced(); status(`${r.removed.length} deleted take${r.removed.length === 1 ? '' : 's'} removed from the folder for good.`, 6000);
    }
  }
  // a track-lock holder who doesn't have the song: post my tracks for whoever does
  let flushTimer = null;
  function flushTracksSoon() { clearTimeout(flushTimer); flushTimer = setTimeout(() => flushTracks().catch(() => {}), 1500); }
  async function flushTracks() {
    clearTimeout(flushTimer); if (!state.folder || !state.readOnly || !state.trackDirty.size) return;
    const ids = [...state.trackDirty]; state.trackDirty.clear();
    for (const id of ids) {
      const t = engine.track(id);
      if (!t) { await bp.tracks.post(state.folder, id, { track: { id }, deleted: true }).catch(() => state.trackDirty.add(id)); continue; }
      if (!mineT(id)) continue;
      const tj = JSON.parse(JSON.stringify(engine.toSongFields().tracks.find((x) => x.id === id)));
      await bp.tracks.post(state.folder, id, { track: tj, index: engine.tracks.indexOf(t) }).catch(() => state.trackDirty.add(id));
    }
  }
  // everyone: pick up lock changes + bandmates' track posts; the song editor folds the posts into song.json
  const appliedPost = new Map(); let tlBusy = false; state.foldedPosts = [];
  async function pollTrackLocks() {
    if (tlBusy || !state.folder || !state.song || engine.recording) return; tlBusy = true;
    try {
      const folder = state.folder; const locks = await bp.tlock.list(folder); if (folder !== state.folder) return;
      for (const [id, l] of Object.entries(state.tlocks)) if (l.token === 'pending' && !locks[id]) locks[id] = l;
      const changed = JSON.stringify(locks) !== JSON.stringify(state.tlocks); state.tlocks = locks;
      const posts = await bp.tracks.read(folder); if (folder !== state.folder) return;
      let applied = 0;
      for (const p of posts) {
        const id = p.track.id; if (appliedPost.get(id) === p.id) continue;
        const mineP = ME && p.by === ME.user && p.host === ME.host;
        if (mineP) { if (!state.readOnly) state.foldedPosts.push({ file: p.file, id: p.id }); appliedPost.set(id, p.id); continue; }   // my own (from before I had the song): already in my engine
        if (mineT(id)) { appliedPost.set(id, p.id); continue; }   // I hold it now: mine wins
        if (p.deleted) { if (engine.track(id)) { if (!state.readOnly) change(() => engine.removeTrack(id), { force: true, undoable: false, label: `${p.by}: removed a track` }); else engine.removeTrack(id); applied++; } }
        else { await loadAudio(folder, { tracks: [p.track] }); if (folder !== state.folder) return; if (!state.readOnly) change(() => engine.replaceTrack(p.track, p.index), { force: true, undoable: false, label: `${p.by}: updated ${p.track.name}` }); else engine.replaceTrack(p.track, p.index); applied++; }
        appliedPost.set(id, p.id); if (!state.readOnly) state.foldedPosts.push({ file: p.file, id: p.id });
      }
      if (applied) renderAll(); else if (changed) renderTracks();
      // I'm editing tracks but nobody has the song (so nobody saves song.json): take it quietly
      if (state.readOnly && Object.keys(state.tlocks).some((id) => mineT(id))) { const s0 = (state.songs || []).find((x) => x.folder === folder); if (s0 && (!s0.lock || s0.lock.stale)) { await flushTracks(); await takeOver({ interactive: false }); if (!state.readOnly) markDirty(); } }
    } catch (_) { /* Drive hiccup: next look */ } finally { tlBusy = false; }
  }
  setInterval(() => { pollTrackLocks(); }, 4000);
  // ---- read-only bandmates can still talk: notes, replies, needs, reactions, stars, lyrics… go through the song's
  // mailbox. The change shows here at once; whoever holds the song merges it in (field-level, like a save merge).
  const MAIL_KEYS = CB.COLLECTIONS.filter((k) => k !== 'activity' && k !== 'versions');
  function mailChange(fn, label) {
    const before = Object.fromEntries(MAIL_KEYS.map((k) => [k, JSON.parse(JSON.stringify(state.song[k] || []))]));
    fn();
    const ops = [];
    for (const k of MAIL_KEYS) {
      const b = new Map(before[k].map((x) => [x.id, x]));
      for (const x of state.song[k] || []) { if (!x || !x.id) continue; const o = b.get(x.id); if (!o || JSON.stringify(o) !== JSON.stringify(x)) ops.push({ key: k, entry: JSON.parse(JSON.stringify(x)), base: o || null }); }
    }
    if (!ops.length) return true;
    state.pendingMail = [...(state.pendingMail || []), ...ops];
    bp.mail.post(state.folder, { ops, label }).then(() => { const h = holderName(); status(`Sent — ${h || 'whoever has the song'} merges it in on their next look (a few seconds).`, 5000); }).catch((err) => fail(new Error(`Couldn't send that to the band folder: ${err.message}`)));
    return true;
  }
  const holderName = () => (state.lockInfo && state.lockInfo.user) || ((state.songs || []).find((x) => x.folder === state.folder) || {}).lock?.user || '';
  // the editor's side: apply bandmates' mail, then delete it
  let mailBusy = false;
  async function pollMail() {
    if (mailBusy || !state.folder || state.readOnly || state.ab || !state.song || engine.recording) return;
    mailBusy = true;
    try {
      const folder = state.folder; const mails = await bp.mail.read(folder); if (!mails.length || folder !== state.folder || state.readOnly) return;
      let n = 0;
      for (const m of mails) {
        const ops = (m.op && m.op.ops) || [];
        const ok = cchange(() => { for (const o of ops) { if (!MAIL_KEYS.includes(o.key) || !o.entry || !o.entry.id) continue; state.song[o.key] = CB.mergeList(state.song[o.key] || [], [o.entry], o.base ? [o.base] : [], o.key === 'markers' ? 'replies' : null); } }, { label: `${m.by}: ${m.op && m.op.label ? m.op.label : 'a comment'}`, undoable: false });
        if (ok) { n++; await bp.mail.remove(folder, m.file); }
      }
      if (n) { renderAll(); pingToastMail(mails); }
    } catch (_) { /* Drive hiccup: next look */ } finally { mailBusy = false; }
  }
  function pingToastMail(mails) { const who = [...new Set(mails.map((m) => m.by))].join(', '); status(`Merged in ${mails.length} comment${mails.length > 1 ? 's' : ''} from ${who} (they're read-only while you edit).`, 6000); }
  setInterval(() => { pollMail(); }, 5000);
  function logActivity(label) { if (label && label !== 'change') { state.pendingActivity.push(label); try { questPop(label); } catch (_) {} } }

  function markDirty() {
    if (syncLinks()) setTimeout(() => renderTracks(), 0);
    state.editSeq = (state.editSeq || 0) + 1;
    state.dirty = true; updateBadges(); updateUndoButtons();
    if (state.readOnly) {   // can't save while a bandmate has it: keep a local backup so a crash doesn't lose it
      clearTimeout(state.backupTimer);
      state.backupTimer = setTimeout(() => { if (state.folder && state.readOnly && state.dirty) bp.song.backup(state.folder, collectSong(), [...state.pendingTakes].map(([clipId, p]) => ({ clipId, trackId: p.trackId, clip: p.clip, wav: p.wav, crash: p.crash || null }))).catch(() => {}); }, 5000);
      return;
    }
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(function tryAuto() { if (!state.dirty || engine.recording) return; if (['#melody', '#noteed', '#drumed'].some((id) => { const d = $(id); return d && d.open; })) { state.autosaveTimer = setTimeout(tryAuto, 3000); return; } save(); }, 4000);
  }

  async function reloadFromDisk() {
    if (engine.recording || finishing) throw new Error('cannot reload while recording');
    const r = await bp.song.reload(state.folder);
    if (state.ab) await leaveAB({ silent: true });
    await applyLoaded(state.folder, { song: r.song, readOnly: state.readOnly, lock: state.lock, bounces: r.bounces, unreferenced: r.unreferenced });
    if (!state.dirty) state.pendingActivity = [];
    dropUndoHistory();   // every undo entry predates their save; undoing would silently revert it
    renderAll(); status(`Reloaded rev ${r.song.rev}`);
  }
  function dropUndoHistory() { if (state.undo.length || state.redo.length) { state.undo = []; state.redo = []; updateUndoButtons(); } }

  bp.song.onExternalChange((info) => onExternal(info));
  async function onExternal(info) {
    if (!state.folder || info.folder !== state.folder) return;
    if (info.deleted) { state.pendingExternal = { deleted: true }; updateBadges(); return; }
    if (state.saving) { state.stashedExternal = info; return; }
    if (info.saveId === (state.song && state.song.saveId)) { if (state.pendingExternal && !state.pendingExternal.conflict) { state.pendingExternal = null; updateBadges(); } return; }
    // a late event for one of MY earlier saves (Drive / the folder watcher catching up) is not "an older version"
    if (state.song && info.saveId && trustedLineage(state.song).includes(info.saveId)) return;
    if (state.song && num(info.rev, 0) < num(state.song.rev, 0)) {
      const now = await bp.song.peek(state.folder).catch(() => null);
      if (now && now.song && (now.song.saveId === state.song.saveId || trustedLineage(state.song).includes(now.song.saveId))) { if (state.pendingExternal && state.pendingExternal.older) { state.pendingExternal = null; updateBadges(); } return; }
    }
    const busy = engine.playing || engine.recording || !!finishing;
    // Diverged: their save does not descend from my last save (we both saved while offline, or Drive picked one of
    // two simultaneous saves). Reloading would silently drop my saved work and "older" would drop theirs: merge both.
    if (!state.readOnly && !busy && !state.merging && state.song && state.song.saveId) {
      const disk = await bp.song.peek(state.folder).catch(() => null);
      const d = disk && disk.song;
      const mineLine = trustedLineage(state.song);
      if (d && d.saveId && d.saveId !== state.song.saveId && d.lineageFor === d.saveId && Array.isArray(d.lineage) && !d.lineage.includes(state.song.saveId) && !mineLine.includes(d.saveId)) {   // (an ancestor of mine arriving late is just Drive lag: not divergence)
        state.merging = true;
        try {
          const common = [...mineLine].reverse().find((id) => d.lineage.includes(id));   // newest save we both descend from
          const ancestor = common ? await bp.song.readHistory(state.folder, common).catch(() => null) : null;
          const r = await overwriteKeepingTheirs(d.savedBy, { quiet: true, base: ancestor || undefined }); if (r === 'ok') status(`${d.savedBy || 'A bandmate'} and you both saved separately (offline or at the same moment) — merged both.`, 10000); return; }
        finally { state.merging = false; }
      }
    }
    const older = state.song && num(info.rev, 0) < num(state.song.rev, 0);
    if (!state.dirty && !state.pendingTakes.size && !older && !busy) { const before = collectSong(); reloadFromDisk().then(() => { const d = describeDiff(before, collectSong()); toast(`${info.savedBy || 'Someone'} saved${d ? ': ' + d : ' (no audible change)'}.`, { kind: '', ms: 8000 }); }).catch(fail); status(`${info.savedBy || 'Someone'} saved — reloaded.`); }
    else { state.pendingExternal = { ...info, older, deferred: busy && !state.dirty && !older, conflict: !!(state.pendingExternal && state.pendingExternal.conflict) }; updateBadges(); }
  }
  // Human summary of what a bandmate's save changed (used by the reload toast).
  function describeDiff(a, b) {
    const out = [];
    if (a.bpm !== b.bpm) out.push(`tempo ${a.bpm} → ${b.bpm}`);
    if (JSON.stringify(a.timeSig) !== JSON.stringify(b.timeSig)) out.push(`time sig ${a.timeSig.join('/')} → ${b.timeSig.join('/')}`);
    const at = new Map((a.tracks || []).map((t) => [t.id, t])), bt = new Map((b.tracks || []).map((t) => [t.id, t]));
    for (const [id, t] of bt) {
      const o = at.get(id);
      if (!o) { out.push(`new track ${t.name}`); continue; }
      const oc = new Set((o.clips || []).map((c) => c.id)); const added = (t.clips || []).filter((c) => !oc.has(c.id)).length; const removed = (o.clips || []).filter((c) => !(t.clips || []).some((x) => x.id === c.id)).length;
      if (added) out.push(`+${added} take${added > 1 ? 's' : ''} on ${t.name}`); if (removed) out.push(`−${removed} take${removed > 1 ? 's' : ''} on ${t.name}`);
      if (o.name !== t.name) out.push(`${o.name} renamed ${t.name}`);
      if (o.gainDb !== t.gainDb || o.pan !== t.pan || JSON.stringify(o.fx) !== JSON.stringify(t.fx) || o.preset !== t.preset) out.push(`${t.name} mix/FX`);
      if (!!o.mute !== !!t.mute) out.push(`${t.name} ${t.mute ? 'muted' : 'unmuted'}`);
    }
    for (const [id, t] of at) if (!bt.has(id)) out.push(`track ${t.name} removed`);
    if ((a.notes || '') !== (b.notes || '')) out.push('notes');
    const cnt = (song, k) => CB.live(CB.list(song, k)).length;
    for (const [k, word] of [['markers', 'note'], ['sections', 'section'], ['chords', 'chord'], ['lyrics', 'lyric line'], ['needs', '"needs" item'], ['ideas', 'idea'], ['versions', 'version']]) { const d = cnt(b, k) - cnt(a, k); if (d) out.push(`${d > 0 ? '+' : '−'}${Math.abs(d)} ${word}${Math.abs(d) > 1 ? 's' : ''}`); }
    const replies = (song) => CB.live(CB.list(song, 'markers')).reduce((n, m) => n + CB.live(m.replies).length, 0); const dr = replies(b) - replies(a); if (dr > 0) out.push(`+${dr} repl${dr > 1 ? 'ies' : 'y'}`);
    const votes = (song) => CB.live(CB.list(song, 'votes')).length; if (votes(a) !== votes(b)) out.push('take stars');
    if (JSON.stringify(a.master) !== JSON.stringify(b.master)) out.push('master');
    return out.slice(0, 6).join(', ') + (out.length > 6 ? ` +${out.length - 6} more` : '');
  }
  function applyDeferredReload() {
    if (state.pendingExternal && state.pendingExternal.deferred && !state.dirty && !state.pendingTakes.size && !engine.playing && !engine.recording && !finishing) { state.pendingExternal = null; reloadFromDisk().catch(fail); }
  }
  engine.on((ev, data) => { if (ev === 'transport' && !data.playing && !data.recording) setTimeout(applyDeferredReload, 0); });
  bp.song.onLockStatus(({ folder, lock, mine }) => {
    if (folder !== state.folder) return;
    if (mine) state.lock = lock;
    updateBadges();
  });
  bp.song.onLockLost(({ lock }) => { setTimeout(sendPresence, 0); clearTimeout(state.autosaveTimer); state.lastSaveError = null; state.lock = null; state.readOnly = true; $('#bottom').classList.add('readonly'); updateBadges(); status(`${lock ? lock.user : 'Someone'} took over this song — you are now read-only.${state.dirty || state.pendingTakes.size ? ' Your unsaved changes are kept until you take it back or close.' : ' You still see their saves live.'}`, 0); renderAll(); });
  bp.onStoreError(({ message }) => status(message, 10000));

  function updateBadges() {
    const lb = $('#lock-badge'), sb = $('#sync-badge'), banner = $('#banner');
    if (state.readOnly) { lb.textContent = 'read-only'; lb.className = 'badge warn'; }
    else if (state.lock) { lb.textContent = "you're editing"; lb.title = 'you hold the lock: bandmates see this song as yours until you close it'; lb.className = 'badge ok'; }
    else { lb.textContent = ''; lb.className = 'badge'; }
    const pend = state.pendingTakes.size;
    sb.textContent = pend ? `${pend} take(s) not saved to the shared folder` : state.dirty ? 'unsaved changes' : (state.song && state.song.savedAt ? `saved ${timeAgo(state.song.savedAt)}${state.song.savedBy ? ` by ${state.song.savedBy}` : ''}` : 'new song');
    sb.title = state.song ? `revision ${state.song.rev}` : '';
    sb.className = 'badge' + (state.dirty || pend ? ' warn' : '');
    $('#notes').readOnly = state.readOnly;
    $('#song').classList.toggle('readonly', state.readOnly); $('#bottom').classList.toggle('readonly', state.readOnly);
    const nDel = state.song ? deletedTakesList().length : 0;
    const btn = $('#btn-recover'); btn.hidden = false; btn.disabled = !nDel || state.readOnly; btn.textContent = nDel ? `Deleted takes (${nDel}) — restore…` : 'Deleted takes: none';
    updateUndoButtons();
    banner.innerHTML = ''; banner.hidden = true;
    const other = state.songs.find((s) => s.folder === state.folder);
    const addLine = (cls, text, buttons) => {
      banner.hidden = false; banner.className = `banner ${cls}`;
      const line = el('div', 'banner-line'); line.append(el('span', null, text));
      for (const [label, fn] of buttons) { const b = el('button', null, label); b.addEventListener('click', () => fn().catch(fail)); line.append(b); }
      banner.append(line);
    };
    const behind = state.pendingExternal && !state.pendingExternal.deleted && !state.pendingExternal.older && !state.pendingExternal.deferred;
    if (state.readOnly && behind && state.dirty) {
      const live = other && other.lock && !other.lock.stale && !other.lockMine ? other.lock.user : null; const who = state.pendingExternal.savedBy || 'your bandmate';
      addLine('bad', `${who} saved this song while you had unsaved changes${live ? ` (${live} still has it open)` : ''}.`, [
        ['Use theirs (drop mine)', async () => { const mineTxt = await mineSummary(); const a = await ask('Drop your changes?', `Load ${who}'s version and throw away yours${mineTxt ? `: ${mineTxt}` : ''}?`, [['Load theirs', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a !== 'ok') return; await reloadFromDisk(); }],
        [live ? `Take over from ${live} & save mine on top` : 'Take the song back & save mine on top', async () => { const r = await bp.song.takeOver(state.folder); state.readOnly = r.readOnly; state.lock = r.lock; if (r.readOnly) { status('Could not take the lock. Try again.', 8000); renderAll(); return; } $('#bottom').classList.remove('readonly'); await overwriteKeepingTheirs(who); renderAll(); }],
      ]);
    } else if (state.readOnly) {
      const live = other && other.lock && !other.lock.stale && !other.lockMine ? other.lock.user : null;
      const stale = other && other.lock && other.lock.stale ? other.lock.user : null;
      addLine('', live ? `${live} has this song open. You can still work at the same time: 🔓 unlock a track nobody has and record / edit it — ${live} gets your changes in a few seconds. Tempo, structure and the mix stay with ${live} (or take over).` : stale ? `${stale} had this open but their Cobander has not checked in for a while (closed, crashed, or Drive paused). Safe to take over.` : 'Nobody has this song open now — you can edit it.', [[live ? `Take over from ${live}` : stale ? `Take over` : 'Edit this song', takeOver]]);
    }
    if (state.backup) {
      const b = state.backup; const moved = b.song.saveId !== state.song.saveId; const otherRev = other ? other.rev : state.song.rev, otherBy = other ? other.savedBy : state.song.savedBy;
      addLine('', `Unsaved changes from your last session (${new Date(b.at).toLocaleString()}) were kept on this computer.${moved ? ` ${state.song.savedBy || 'Someone'} has saved this song since; restoring will ask before replacing their version.` : ''}`, [['Restore them', async () => { state.backup = null; pushUndo('restore backup'); await restoreSnapshot(JSON.stringify(b.song)); state.song.saveId = b.song.saveId || null; if (moved) state.base = b.song.saveId ? await bp.song.readHistory(state.folder, b.song.saveId).catch(() => null) : null;   /* merge against what the backup was built on (or nothing), never against their newer copy */ state.song.rev = num(b.song.rev, state.song.rev); for (const t of b.takes || []) if (t.wav) state.pendingTakes.set(t.clipId, { wav: t.wav, trackId: t.trackId, clip: t.clip, crash: t.crash || null }); await bp.song.clearBackup(state.folder); if (moved) { state.pendingExternal = { rev: otherRev, savedBy: otherBy, conflict: true }; } updateBadges(); }], ['Discard', async () => { state.backup = null; await bp.song.clearBackup(state.folder); updateBadges(); }]]);
    }
    if (other && other.conflictCopies && other.conflictCopies.length) {
      addLine('bad', `Two people saved at the same moment and ${cloudName()} kept both versions. This one is loaded; the other is in the song folder as ${other.conflictCopies.join(', ')}. If a take or mix change is missing, "Unused takes" finds the audio, and an assistant can merge the other file.`, [['Open folder', async () => bp.shell.openSongFolder(state.folder)]]);
    }
    if (state.lastSaveError && !state.readOnly && (state.dirty || state.pendingTakes.size)) {
      addLine('bad', `Saving failed: ${state.lastSaveError}`, [['Retry save', async () => { await save(); }]]);
    }
    if (state.pendingExternal && !(state.readOnly && behind && state.dirty)) {
      const p = state.pendingExternal;
      if (p.deleted) addLine('bad', 'This song folder was deleted or renamed outside Cobander.', []);
      else if (p.older) addLine('bad', `${cloudName()} delivered an OLDER version (rev ${p.rev}, by ${p.savedBy || 'someone'}) than the one you have (rev ${state.song.rev}). Probably a sync hiccup. Keep yours unless you know better.`, [['Keep mine (merge theirs in)', async () => { await overwriteKeepingTheirs(p.savedBy); }], ['Load the older one', async () => { state.dirty = false; state.pendingExternal = null; await reloadFromDisk(); }]]);
      else if (p.deferred) addLine('', `${p.savedBy || 'Someone'} saved rev ${p.rev}. It will load when you stop.`, engine.recording ? [] : [['Load now', async () => { await stop(); }]]);
      else {
        const who = p.savedBy || 'your bandmate';
        const buttons = [['Use theirs (drop mine)', async () => {
          const mineTxt = await mineSummary();
          const a = await ask('Drop your changes?', `Load ${who}'s version and throw away yours${mineTxt ? `: ${mineTxt}` : ''}?${state.pendingTakes.size ? ' (Your unsaved take is kept and merged back in.)' : ''}`, [['Load theirs', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]);
          if (a !== 'ok') return;
          await reloadFromDisk();
        }]];
        if (!state.readOnly) buttons.push(['Save mine (keep their takes)', async () => {
          const a = await ask('Save yours?', `Your changes go on top of what ${who} saved. Any takes or tracks ${who} added are kept; their mix moves are replaced by yours.`, [['Save mine', 'ok', 'primary'], ['Cancel', 'cancel']]);
          if (a !== 'ok') return;
          await overwriteKeepingTheirs(who);
        }]);
        addLine('bad', `${who} saved this song while you have unsaved changes.`, buttons);
      }
    }
    $('#btn-save').disabled = state.readOnly; $('#btn-rec').disabled = state.readOnly; $('#btn-add-track').disabled = state.readOnly;
  }

  $('#btn-save').addEventListener('click', () => save());
  $('#btn-open-folder').addEventListener('click', () => { if (state.folder) { bp.shell.openSongFolder(state.folder); status(`Opened the "${state.folder}" folder in your file browser.`); } });
  $('#btn-undo').addEventListener('click', () => undo().catch(fail));
  $('#btn-redo').addEventListener('click', () => redo().catch(fail));
  $('#btn-close').addEventListener('click', () => closeSong().then((ok) => { if (ok) status('Song closed — bandmates can edit it now.'); }).catch(fail));
  $('#btn-recover').addEventListener('click', () => recoverTakes().catch(fail));

  // ---------- lighten Drive: WAV → FLAC + old unused audio ----------
  const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
  async function compactDrive() {
    if (engine.recording) throw new Error('stop recording first');
    if (state.dirty && !state.readOnly) { const r = await save(); if (r !== 'ok') throw new Error('Save the song first (see the banner) — then Lighten Drive.'); }
    status('Looking through every song\'s audio…', 0);
    const dry = await bp.audio.compact(null, { dryRun: true });
    const saved = dry.before - dry.after;
    if (!dry.converted && !dry.removed) { status(`The folder is already light: ${mb(dry.before)} of takes, nothing to convert or clear.`); return null; }
    const songs = dry.songs.filter((x) => x.converted || x.removed).length;
    const v = await ask('Lighten the folder', `${dry.converted} WAV take(s) → FLAC (lossless — the same audio, about half the size) and ${dry.removed} old take(s) nothing has used for 30 days removed, across ${songs} song(s). Takes ${mb(dry.before)} → ${mb(dry.after)} (saves ${mb(saved)}). Deleted songs, the parts bin, bounces, versions and anything in the last 500 saves are kept. Bandmates need Cobander 0.13 or newer to play FLAC takes.`, [['Lighten', 'ok', 'primary'], ['Convert only (remove nothing)', 'convert'], ['Cancel', '']]);
    if (!v) return null;
    const off = bp.audio.onCompactProgress ? bp.audio.onCompactProgress((p) => status(`Lightening ${p.song}: ${p.i}/${p.of}…`, 0)) : null;
    try {
      const r = await bp.audio.compact(null, { purge: v === 'ok' });
      const skip = r.songs.filter((x) => x.purgeSkipped || x.error).map((x) => x.folder);
      status(`Drive lightened: ${r.converted} take(s) now FLAC${r.removed ? `, ${r.removed} unused removed` : ''} — ${mb(r.before)} → ${mb(r.after)}.${skip.length ? ` Nothing removed from ${skip.join(', ')} (song file still syncing).` : ''}`, 12000);
      return r;
    } finally { if (typeof off === 'function') off(); }
  }
  $('#btn-compact').addEventListener('click', () => compactDrive().catch(fail));
  // the parked takes from before 0.15 (deleted long ago, tempo / key renders, lost saves): one look, one click
  async function clearParked({ auto = false } = {}) {
    if (!state.folder || state.readOnly) return null;
    state.unreferenced = await bp.song.unreferenced(state.folder, referencedIds());
    const list = state.unreferenced || []; if (!list.length) { if (!auto) status('Nothing parked — every take file is used.'); return null; }
    const size = list.reduce((n, u) => n + (u.size || 0), 0);
    const v = await ask('Parked takes', `${list.length} take file${list.length === 1 ? '' : 's'} in this song's folder (${mb(size)}) that nothing uses: takes deleted earlier, old tempo / key renders, saves that lost a conflict. Deleted takes can still bring any of them back right now; after this they're gone for good. Tagged versions are checked and kept.`, [['Clear them', 'ok', 'danger'], ['Review first', 'review'], ['Not now', '']]);
    if (v === 'review') return recoverTakes();
    if (v !== 'ok') { try { localStorage.setItem(`bp.parkedAsked.${state.folder}`, '1'); } catch (_) {} return null; }
    const r = await bp.audio.purge(state.folder, list.map((u) => u.clipId));
    if (r.removed.length && state.song.trash) change(() => { const tr = { ...state.song.trash }; for (const [k, e] of Object.entries(tr)) if (e.clip && r.removed.includes(audioId(e.clip))) delete tr[k]; state.song.trash = tr; }, { label: `cleared ${r.removed.length} parked takes`, undoable: false, activity: false });
    await refreshUnreferenced(); updateBadges();
    toast(`${r.removed.length} parked take${r.removed.length === 1 ? '' : 's'} removed (${mb(size)} freed in the shared folder)${r.kept.length ? `; ${r.kept.length} kept — a tagged version still uses them` : ''}.`, { kind: 'ok', ms: 8000 });
    return r;
  }

  // ---------- recover unreferenced takes ----------
  async function recoverTakes() {
    if (!state.folder) return;
    state.unreferenced = await bp.song.unreferenced(state.folder, referencedIds());
    const list = deletedTakesList();
    if (!list.length) { status('Nothing deleted — every take is in the song.'); updateBadges(); return; }
    const d = $('#recover'); const ul = $('#recover-list'); ul.innerHTML = '';
    for (const it of list) {
      const li = el('li'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = it.id; cb.checked = false;
      if (it.kind === 'trash') { const c = it.clip, tr = it.tr; li.append(cb, el('span', null, ` "${c.name}"${c.takenBy ? ` by ${c.takenBy}` : ''} — was on ${tr.trackName}, ${fmtBar(c.start)}${c.kind === 'midi' ? ' · MIDI' : (engine.clipLength(c) || c.duration) ? ` · ${(engine.clipLength(c) || c.duration).toFixed(1)} s` : ''} · deleted ${new Date(tr.at).toLocaleString()}`)); }
      else { const u = it.u; const why = /- [+-]?\d+st\b|bpm [+-]?\d+st/.test(u.label || '') ? 'an earlier key (transpose) render' : /- \d+bpm\b/.test(u.label || '') ? 'an earlier tempo render' : /harmony/i.test(u.label || '') ? 'a harmony render' : 'a take no song version uses (e.g. from a save that lost a conflict)'; li.append(cb, el('span', null, ` ${why} · ${u.seconds != null ? `${u.seconds} s` : `${(u.size / 1048576).toFixed(1)} MB`}${u.channels ? ` · ${u.channels === 1 ? 'mono' : 'stereo'}` : ''} · recorded ${new Date(u.mtimeMs).toLocaleString()} · ${u.label || u.clipId}`)); }
      ul.appendChild(li);
    }
    d.returnValue = ''; d.showModal();
    await new Promise((r) => d.addEventListener('close', r, { once: true }));
    if (d.returnValue !== 'ok') return;
    const ids = [...ul.querySelectorAll('input:checked')].map((i) => i.value);
    const back = [];
    for (const id of ids) { const it = list.find((x) => x.id === id); if (!it) continue; if (it.kind === 'trash' && it.tr.clip) back.push(await restoreTrashed(it)); else if (it.kind === 'trash') { const tr = it.tr; const r0 = await attachTake({ clipId: id, trackId: engine.track(tr.trackId) ? tr.trackId : state.selectedTrack, start: engine.track(tr.trackId) ? tr.start : engine.playhead, name: tr.name }); if (r0) back.push({ name: tr.name }); } else await attachTake({ clipId: id, trackId: state.selectedTrack, start: engine.playhead }); }
    if (back.length) status(`Restored ${back.map((x) => x.name).join(', ')}${back.some((x) => x.mutedOnRestore) ? ' (muted, because another take already plays there — right-click → Keep this take)' : ''}.`, 8000);
  }
  // Put a trashed clip back exactly as it was (same audio file via src); muted if something else plays there now.
  async function restoreTrashed(it) {
    const c = JSON.parse(JSON.stringify(it.clip)); const tr = it.tr;
    let t = engine.track(tr.trackId);
    if (c.kind !== 'midi') { const a = audioId(c); if (!engine.buffers.has(a)) { await engine.init(); const ab = await bp.audio.read(state.folder, a); engine.buffers.set(a, await window.BPWav.decodeWav(engine.ctx, ab)); state.missingClips.delete(a); } }
    let mutedOnRestore = false;
    change(() => {
      if (!t) { t = engine.addTrack(tr.trackName || 'Restored'); if (c.kind === 'midi') engine.updateTrack(t.id, { instrument: 'synth:keys' }); }
      if (c.kind !== 'midi' && t.instrument !== 'audio') { t = engine.addTrack(tr.trackName || 'Restored'); }
      c.mute = false; const over = t.clips.filter((x) => !x.mute && x.start < c.start + (engine.clipLength(c) || c.duration) && clipEnd(x) > c.start);
      if (over.length) { c.mute = true; mutedOnRestore = true; }
      t.clips.push(c); const tr2 = { ...state.song.trash }; delete tr2[c.id]; state.song.trash = tr2;
      state.selectedTrack = t.id; state.selectedClip = c.id;
    }, { label: `restore ${c.name}` });
    renderAll(); refreshUnreferenced();
    return { name: c.name, mutedOnRestore };
  }
  async function attachTake({ clipId, trackId, start, name }) {
    if (!state.folder) throw new Error('no song open');
    if (state.readOnly) throw new Error('Read-only — "Take over" (banner above) to edit.');
    if (!/^[a-f0-9]{12}$/.test(String(clipId))) throw new Error('bad clip id');
    await engine.init();
    const ab = await bp.audio.read(state.folder, clipId);
    const buf = await window.BPWav.decodeWav(engine.ctx, ab);
    engine.buffers.set(clipId, buf);
    let t = engine.track(trackId);
    change(() => {
      if (!t) t = engine.addTrack(name || 'Recovered');
      const tr = (state.song.trash || {})[clipId] || {};
      t.clips.push({ id: clipId, name: name || tr.name || `recovered ${clipId.slice(0, 4)}`, start: clamp(start, 0, 1e6, 0), gainDb: 0, trimStart: 0, trimEnd: 0, duration: buf.duration, channels: buf.numberOfChannels, takenBy: tr.takenBy || null, takenAt: null, mute: false });
      state.selectedTrack = t.id; state.selectedClip = clipId;
      if (state.song.trash && state.song.trash[clipId]) { const tr = { ...state.song.trash }; delete tr[clipId]; state.song.trash = tr; }
    }, { label: `restore ${name || 'take'}` });
    state.unreferenced = state.unreferenced.filter((u) => u.clipId !== clipId);
    renderAll();
    return { trackId: t.id, clipId };
  }

  // ---------- right-click menus (every element carries its own actions) ----------
  const M = window.BPMenu;
  const ro = () => state.readOnly;
  const fadeMenu = (c, which) => ['none', 0.01, 0.1, 0.5, 1, 2].map((v) => ({ label: v === 'none' ? 'none' : v < 1 ? `${Math.round(v * 1000)} ms` : `${v} s`, checked: v === 'none' ? !c[which] : Math.abs((c[which] || 0) - v) < 1e-6, action: () => setFade(c, which, v === 'none' ? 0 : v) })).concat([{ label: 'custom…', action: async () => { const v = await promptName(`${which === 'fadeIn' ? 'Fade in' : 'Fade out'} (seconds)`, String(c[which] || 0)); if (v !== null && Number.isFinite(Number(v))) setFade(c, which, Number(v)); } }]);
  function lockItems(t) {
    if (!state.song) return [];
    const h = heldBy(t.id);
    if (h) return [{ title: `🔒 ${h} has this track unlocked` }];
    return mineT(t.id) ? [{ label: '🔒 Lock this track (free it for the band)', action: () => lockTrack(t.id).catch(fail) }, 'sep'] : [{ label: '🔓 Unlock this track', action: () => unlockTrack(t.id).catch(fail) }, { label: 'Unlock all', action: () => unlockAll().catch(fail) }, 'sep'];
  }
  function clipMenu(t0, c0) {
    const live = findClip(c0.id); if (!live) return [{ title: `${c0.name} (song was reloaded — right-click again)` }];
    const t = live.t, c = live.c;
    const ro = () => !canTouch(t);   // track locks: a take can be changed only on a track you've unlocked
    if (c.link) { const sec = liveSections().find((x) => x.id === c.link.section); const g = sec && TPL.linkInfo(collectSong())[TPL.sectionType(sec.name)];
      const s0 = mirrorSource(c);
      if (s0) { const rest = clipMenu(s0.t, s0.c); return [{ title: `${c.name} — linked: changes here change every ${sec ? TPL.sectionType(sec.name) : 'copy'}` }, { label: `Unlink ${sec ? sec.name : 'this section'} (make just this one different)…`, action: () => sec && unlinkSection(sec).catch(fail), disabled: ro() || !sec }, { label: `Go to ${g ? g.room.name : 'the room'}`, action: () => { if (g) { engine.seek(g.room.start); positionPlayhead(); } } }, 'sep', ...rest.slice(1)]; }
      return [{ title: `${c.name} — linked copy` }, { label: `Go to the ${g ? g.room.name : 'section'} room (edit it there)`, action: () => { if (g) openRoom(g.room); } }, { label: `Unlink ${sec ? sec.name : 'this section'} (make it different)…`, action: () => sec && unlinkSection(sec).catch(fail), disabled: ro() || !sec }, { label: 'Listen to this take', action: () => auditionTake(t, c) }]; }
    const over = overlapping(t, c);
    return [
      { title: `${c.name}${c.takenBy ? ` — ${c.takenBy}` : ''}${c.part ? ` · from part "${c.part.name}"${c.part.shift ? ` (${c.part.shift > 0 ? '+' : ''}${c.part.shift} st)` : ''}` : ''}` },
      ...(c.melody ? [{ label: 'Melody… (re-roll / change the words)', action: () => openMelody(c.melody.section).catch(fail), disabled: ro() }, ...(() => { const src = liveSections().find((x) => Math.abs(x.start - c.start) < 1e-3); if (!src) return []; const ty = TPL.sectionType(src.name); const others = liveSections().filter((x) => x.id !== src.id && TPL.sectionType(x.name) === ty); return others.length ? [{ label: `Use this melody in every ${cap(ty)} (${others.length} more)`, action: () => copyMelodyToType(t, c, src, others), disabled: ro() }] : []; })()] : []),
      ...(c.kind === 'midi' && String(t.instrument).startsWith('synth:') ? [{ label: 'Edit notes… (piano roll, chords)', action: () => openNoteEditor(t, c).catch(fail), disabled: ro() }] : []),
      ...(c.kind === 'midi' && t.instrument === 'drumkit' ? [{ label: 'Drums… (edit hit by hit / generate)', action: () => { const w = melodyWindowOptions().find((x) => Math.abs(x.w0 - c.start) < 1e-3); openDrums(w ? w.id : null).catch(fail); }, disabled: ro() }] : []),
      { label: 'Save this take to the Parts bin…', action: () => savePartFrom({ clip: c, track: t }).catch(fail) },
      ...(over.length ? [{ label: 'Keep this take (mute the overlapping ones)', action: () => keepTake(t, c), disabled: ro() }, { label: 'Listen to this take', action: () => auditionTake(t, c) }, ...compItems(t, c, ro())] : []),
      { label: c.mute ? 'Un-mute' : 'Mute', hint: 'M', action: () => { change(() => { c.mute = !c.mute; }, { label: `${c.mute ? 'un-mute' : 'mute'} ${c.name}` }); renderAll(); }, disabled: ro() },
      'sep',
      { label: 'Split at playhead', hint: 'S', action: () => splitClip(t, c, engine.playhead), disabled: ro() },
      ...(c.kind !== 'midi' ? [{ label: '🎤 Lyrics from this take (speech-to-text)', action: () => transcribeClips([{ t, c: c.link ? (mirrorSource(c) || { c }).c : c }]), disabled: !!asrBusy }] : []),
      ...(harmonicTrack(t) || bassTrack(t) ? [{ label: '🎸 Chords from this track', action: () => chordsFromTracks([t]).catch(fail), disabled: ro() }] : []),
      { label: '⏱ Timing report (early / late per bar)', action: () => timingReport(t, c).catch(fail) },
      { label: c.kind === 'midi' ? 'Tighten to the grid… (quantize with a strength)' : 'Tighten to the grid…', action: () => openTighten(t, c).catch(fail), disabled: ro() },
      ...(c.tt ? [{ label: `Undo tighten (${c.tt.grid} ${Math.round(c.tt.strength * 100)}%)`, action: () => untighten(t, c), disabled: ro() }] : []),
      ...(c.kind !== 'midi' && isVocalTrack(t) ? [{ label: '🎯 Pitch check this take', hint: 'shows sharp / flat notes', action: () => pitchCheckTrack(t, c).catch(fail) }] : []),
      { label: 'Trim to loop', action: () => trimToLoop(t, c), disabled: ro() || !engine.loop.enabled },
      { label: 'Fade in', sub: fadeMenu(c, 'fadeIn'), disabled: ro() },
      { label: 'Fade out', sub: fadeMenu(c, 'fadeOut'), disabled: ro() },
      'sep',
      { label: 'Cut', hint: `${MOD}+X`, action: () => { copyClip(c); deleteClip(t, c, { confirm: false }); }, disabled: ro() },
      { label: 'Copy', hint: `${MOD}+C`, action: () => copyClip(c) },
      { label: 'Paste at playhead', hint: `${MOD}+V`, action: () => pasteClips(t.id, engine.playhead), disabled: ro() || !clipboard.clips.length },
      { label: 'Duplicate (right after)', hint: `${MOD}+D`, action: () => duplicateClip(t, c), disabled: ro() },
      { label: 'Move to track', sub: engine.tracks.filter((x) => x !== t).map((x) => ({ label: x.name, disabled: c.kind === 'midi' ? !String(x.instrument).startsWith('synth:') : x.instrument !== 'audio', action: () => moveClipToTrack(c, t, x) })), disabled: ro() || engine.tracks.length < 2 },
      'sep',
      { label: 'Loop this take', action: () => { setLoopBars(barOf(c.start), Math.ceil(barIdx(clipEnd(c)) - 1e-6)); } },
      { label: myVote(c.id) ? `Unstar (${CB.votesFor(state.song, c.id).length}★)` : `★ Star this take${CB.votesFor(state.song, c.id).length ? ` (${CB.votesFor(state.song, c.id).length}★ so far)` : ''}${over.length ? ' — most stars plays' : ''}`, action: () => toggleVote(t, c), disabled: ro() },
      { label: 'React to this take', sub: reactionItems(c.id, c.name) },
      { label: 'Note at playhead…', action: () => addNote(t.id, engine.playhead) },
      { label: 'Rename…', action: async () => { const n = await promptName('Take name', c.name); if (n) { change(() => { c.name = n; }, { label: `rename take to ${n}` }); renderAll(); } }, disabled: ro() },
      ...(c.kind !== 'midi' ? [{ label: 'Normalize (peak to −1 dB)', hint: 'sets the take level so its loudest moment is just under full', action: () => { const buf = engine.buffers.get(audioId(c)); if (!buf) { status('That take hasn\'t loaded yet.'); return; } let p = 0; for (let ch = 0; ch < buf.numberOfChannels; ch++) { const d0 = buf.getChannelData(ch); for (let i = 0; i < d0.length; i++) { const a = Math.abs(d0[i]); if (a > p) p = a; } } if (p < 1e-6) { status('Silent take.'); return; } const g = Math.round((-1 - 20 * Math.log10(p)) * 2) / 2; change(() => { c.gainDb = Math.max(-24, Math.min(24, g)); }, { label: `normalize ${c.name}` }); renderAll(); status(`${c.name}: level set to ${g > 0 ? '+' : ''}${g} dB (peak was ${(20 * Math.log10(p)).toFixed(1)} dBFS).`, 6000); }, disabled: ro() }] : []),
      { label: 'Reset gain / trims / fades', action: () => { change(() => { c.gainDb = 0; c.trimStart = 0; c.trimEnd = 0; c.fadeIn = 0; c.fadeOut = 0; }, { label: `reset ${c.name}` }); renderAll(); }, disabled: ro() },
      { label: 'Delete', hint: 'Del', danger: true, action: () => deleteClip(t, c, { confirm: false }), disabled: ro() },
    ];
  }
  function laneMenu(t0, sec) {
    const t = engine.track(t0.id); if (!t) return [{ title: 'song was reloaded — right-click again' }];
    const ro = () => !canTouch(t);
    return [
      { title: t.name },
      ...lockItems(t),
      { label: 'Paste here', hint: `${MOD}+V`, action: () => pasteClips(t.id, snap(sec)), disabled: ro() || !clipboard.clips.length || t.instrument === 'drumkit' },
      { label: 'Record here', hint: 'R', action: () => { state.armedTrack = t.id; engine.seek(snap(sec)); record().catch(fail); }, disabled: ro() || t.instrument === 'drumkit' },
      { label: 'Loop 4 bars from here', action: () => { const bar = barOf(sec); setLoopBars(bar, bar + 3); } },
      { label: 'Put playhead here', action: () => { engine.seek(snap(sec)); positionPlayhead(); } },
      { label: `Note here (${posLabel(sec)})…`, action: () => addNote(t.id, snap(sec)) },
      { label: 'React to track', sub: reactionItems(t.id, t.name) },
      'sep',
      ...trackItems(t),
    ];
  }
  function trackItems(t0) {
    const PR = window.BPPresets;
    const t = engine.track(t0.id) || t0;   // menus can outlive a reload: always act on the live object
    if (!engine.track(t0.id)) return [{ title: `${t0.name} (song was reloaded — right-click again)` }];
    const ro = () => !canTouch(t);
    return [
      ...lockItems(t),
      { label: state.armedTrack === t.id ? 'Disarm' : 'Arm for recording', action: () => { state.armedTrack = state.armedTrack === t.id ? null : t.id; renderTracks(); }, disabled: ro() || t.instrument === 'drumkit' },
      ...(t.instrument === 'audio' && t.clips.length && isVocalTrack(t) ? [{ label: '🎤 Lyrics from this track (speech-to-text)', action: () => transcribeTrack(t), disabled: !!asrBusy }] : []),
      ...(harmonicTrack(t) || bassTrack(t) ? [
        { label: '🎸 Chords & tabs for this track', sub: [
          { title: 'Show the chart moved for a capo / another key (nothing is re-tuned)' },
          ...[0, -1, -2, -3, -4, -5, 1, 2, 3].map((k) => ({ label: k === 0 ? 'As written' : k < 0 ? `Capo ${-k} (chords shown ${k})` : `Up ${k} half step${k === 1 ? '' : 's'}`, action: () => showChartShifted(k) })),
          'sep', { label: 'Chords from this track (listen to the takes)', action: () => chordsFromTracks([t]).catch(fail), disabled: ro() },
          { label: 'Play-along highway (Practice → play along)', action: () => { setWorkspace('practice'); setTimeout(() => { const al = $('#k-along'); if (al) { al.value = bassTrack(t) ? 'bass' : 'chords'; al.dispatchEvent(new Event('change')); } }, 300); } }] },
        { label: '🔁 Transpose the whole song (re-tunes the recordings too)', sub: transposeItems(null), disabled: state.readOnly }] : []),
      { label: t.mute ? 'Un-mute track' : 'Mute track', action: () => { change(() => engine.updateTrack(t.id, { mute: !t.mute }), { undoable: false }); renderAll(); }, disabled: ro() },
      { label: t.solo ? 'Un-solo track' : 'Solo track', action: () => { change(() => engine.updateTrack(t.id, { solo: !t.solo }), { undoable: false }); renderAll(); }, disabled: ro() },
      'sep',
      { label: 'Rename…', action: async () => { const n = await promptName('Track name', t.name); if (n) { change(() => engine.updateTrack(t.id, { name: n }), { label: `rename track to ${n}` }); fixTrackTypes({ quiet: false }); renderAll(); } }, disabled: ro() },
      { label: 'Save as my track setup… (amp, FX, level — for new tracks)', action: () => saveTrackSetup(t).catch(fail) },
      { label: 'Color…', action: () => { const r = (document.querySelector(`.track[data-id="${t.id}"] .track-head`) || document.body).getBoundingClientRect(); pickColor(t, r.left + 20, r.top + 20); }, disabled: ro() },
      { label: 'Type', sub: PR.TYPES.map((ty) => ({ label: ty, checked: t.type === ty, action: () => { change(() => engine.updateTrack(t.id, { type: ty, preset: null, typeSet: true })); renderAll(); } })), disabled: ro() },
      { label: 'Preset', sub: (PR.PRESETS[t.type] || []).map((p) => ({ label: p.name, checked: t.preset === p.name, action: () => applyPreset(t.id, p.name) })), disabled: ro() },
      { label: 'Source', sub: PR.INSTRUMENTS.map((i) => ({ label: i.name, checked: t.instrument === i.id, action: () => { change(() => engine.updateTrack(t.id, { instrument: i.id, drum: i.id === 'drumkit' ? (t.drum || window.BPEngine.DEFAULT_DRUM()) : undefined })); engine.setLiveMidiTrack(t.id); renderAll(); } })), disabled: ro() },
      ...(String(t.instrument).startsWith('synth:') ? [{ label: 'Draw notes / riff generator…', hint: 'or double-click the lane', action: () => openNoteEditor(t, null, engine.playhead).catch(fail), disabled: ro() }] : []),
      ...(t.instrument === 'drumkit' ? [{ label: 'Drums for a part (editor / generator)…', action: () => openDrums().catch(fail), disabled: ro() }] : []),
      ...(t.instrument === 'drumkit' && t.drum ? [{ label: 'Drum kit', sub: PR.DRUM_KITS.map((k) => ({ label: k, checked: t.drum.kit === k, action: () => { change(() => engine.updateTrack(t.id, { drum: { ...t.drum, kit: k } }), { label: `${t.name} kit ${k}` }); renderAll(); } })), disabled: ro() }, { label: 'Pattern', sub: Object.keys(PR.DRUM_PATTERNS).map((k) => ({ label: k, checked: !t.drum.custom && t.drum.pattern === k, action: () => { change(() => engine.updateTrack(t.id, { drum: { ...t.drum, pattern: k, custom: null } }), { label: `${t.name} pattern ${k}` }); renderAll(); } })), disabled: ro() }] : []),
      { label: 'Open in Track FX', action: () => { if (document.body.classList.contains('writing')) setWriting(false); selectTrack(t.id); $('#fx-panel').scrollTop = 0; } },
      { label: 'React', sub: reactionItems(t.id, t.name) },
      { label: 'Note at playhead…', action: () => addNote(t.id, engine.playhead) },
      'sep',
      { label: 'Add track above', action: () => addTrackAt(Math.max(0, engine.tracks.findIndex((x) => x.id === t.id))), disabled: ro() },
      { label: 'Add track below', action: () => addTrackAt(Math.max(0, engine.tracks.findIndex((x) => x.id === t.id)) + 1), disabled: ro() },
      { label: 'Duplicate track (settings, no takes)', action: () => { const lt = engine.track(t.id); if (!lt) return; change(() => { const n = engine.addTrack(`${lt.name} copy`, lt.color); engine.updateTrack(n.id, { type: lt.type, preset: lt.preset, instrument: lt.instrument, fx: JSON.parse(JSON.stringify(lt.fx)), gainDb: lt.gainDb, pan: lt.pan, drum: lt.drum ? JSON.parse(JSON.stringify(lt.drum)) : undefined }); const i = engine.tracks.indexOf(lt); engine.tracks.splice(engine.tracks.indexOf(n), 1); engine.tracks.splice(i + 1, 0, n); }, { label: `duplicate ${lt.name}` }); renderAll(); }, disabled: ro() },
      { label: 'Move up', action: () => moveTrack(t, -1), disabled: ro() || engine.tracks.indexOf(t) === 0 },
      { label: 'Move down', action: () => moveTrack(t, 1), disabled: ro() || engine.tracks.indexOf(t) === engine.tracks.length - 1 },
      'sep',
      { label: `Delete track${t.clips.length ? ` (${t.clips.length} take${t.clips.length === 1 ? ' goes' : 's go'} to Deleted takes)` : ''}`, danger: true, action: () => deleteTrack(t), disabled: ro() },
    ];
  }
  // Drag a track's head up/down to reorder (5 px threshold so clicks still just select).
  function trackDragStart(e, t, row) {
    if (e.button !== 0 || e.target.closest('button, input, select, textarea, .reacts, [contenteditable]')) return;
    if (ro() || engine.recording) return;
    const y0 = e.clientY; let dragging = false, line = null, target = -1;
    const rows = () => [...tracksEl.querySelectorAll(':scope > .track')];
    const move = (ev) => {
      if (!dragging) { if (Math.abs(ev.clientY - y0) < 5) return; dragging = true; row.classList.add('track-dragging'); document.body.classList.add('track-moving'); line = el('div', 'track-drop-line'); tracksEl.append(line); }
      const rs = rows(); target = rs.length;
      for (let i = 0; i < rs.length; i++) { const r = rs[i].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { target = i; break; } }
      const ref = rs[target] || rs[rs.length - 1]; const base = tracksEl.getBoundingClientRect(); const rr = ref.getBoundingClientRect();
      line.style.top = `${(target < rs.length ? rr.top : rr.bottom) - base.top + tracksEl.scrollTop - 1}px`;
      const ar = arrange.getBoundingClientRect(); if (ev.clientY > ar.bottom - 30) arrange.scrollTop += 12; else if (ev.clientY < ar.top + 80) arrange.scrollTop -= 12;
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      if (!dragging) return;
      row.classList.remove('track-dragging'); document.body.classList.remove('track-moving'); if (line) line.remove();
      const live = engine.track(t.id); const i = engine.tracks.indexOf(live); if (i < 0) return;
      let j = target; if (j > i) j--;   // removing it first shifts the rows below up by one
      if (j === i || j < 0) return;
      change(() => { engine.tracks.splice(i, 1); engine.tracks.splice(j, 0, live); }, { label: `move ${live.name}` }); renderAll();
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  function moveTrack(t0, d) { const t = engine.track(t0.id); if (!t) { status('That track is gone (song reloaded).'); return; } const i = engine.tracks.indexOf(t), j = i + d; if (i < 0 || j < 0 || j >= engine.tracks.length) return; change(() => { engine.tracks.splice(i, 1); engine.tracks.splice(j, 0, t); }, { label: `move ${t.name}` }); renderAll(); }
  async function addTrackAt(index) { if (state.ab) await leaveAB({ silent: true }); const kind = await pickTrackKind(); if (!kind) return; const t = addTrackOfKind(kind); if (!t) return; change(() => { engine.tracks.splice(engine.tracks.indexOf(t), 1); engine.tracks.splice(index, 0, t); }, { undoable: false }); renderAll(); }
  async function deleteTrack(t) {
    if (engine.recording || finishing) { status('Stop recording first.'); return; }
    const a = await ask('Delete track', `Delete track "${t.name}" and its ${t.clips.length} take(s) from the song? The audio files stay in the folder (Deleted takes brings them back); ${MOD}+Z undoes this.`, [['Delete', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a !== 'ok') return;
    change(() => { for (const c of t.clips) trashClip(t, c); state.song.trashTracks = { ...(state.song.trashTracks || {}), [t.id]: t.name }; engine.removeTrack(t.id); if (state.selectedTrack === t.id) state.selectedTrack = null; if (state.armedTrack === t.id) state.armedTrack = null; }, { label: `delete track ${t.name}` }); renderAll(); refreshUnreferenced();
  }
  function clickMenu() {
    const lv = engine.click.gainDb;
    return [
      { title: 'Click / metronome' },
      { label: engine.click.on ? 'Click off' : 'Click on', action: () => { $('#click-on').checked = !engine.click.on; $('#click-on').dispatchEvent(new Event('change')); } },
      { label: 'Level', sub: [-24, -18, -12, -6, 0].map((v) => ({ label: `${v} dB`, checked: Math.round(lv) === v, action: async () => { engine.click.gainDb = v; engine.applyAll(); state.settings = await bp.settings.set({ clickDb: v }); status(`Click ${v} dB`); } })) },
      { label: 'Count-in', sub: [['off', 0], ['1 bar', 1], ['2 bars', 2]].map(([l, n]) => ({ label: l, checked: n === 0 ? !engine.click.countIn : (engine.click.countIn && engine.click.countInBars === n), action: () => { engine.click.countIn = n > 0; if (n) engine.click.countInBars = n; $('#count-in').checked = engine.click.countIn; status(`Count-in: ${l}`); } })) },
      { label: 'Tempo…', action: tempoPrompt, disabled: ro() },
      { label: 'Time signature', sub: [...['4/4', '3/4', '6/8', '2/4', '5/4', '7/8', '9/8', '12/8'].map((ts) => ({ label: ts, checked: MT.tsLabel(engine.timeSig) === ts, action: () => { $('#timesig').value = ts; $('#timesig').dispatchEvent(new Event('change')); } })), { label: 'Other… (13/7, 2+2+3/8 …)', action: () => { $('#timesig').value = 'custom'; $('#timesig').dispatchEvent(new Event('change')); } }], disabled: ro() },
    ];
  }
  async function tempoPrompt() { const v = await promptName('Tempo (bpm)', String(engine.bpm)); if (v !== null && Number.isFinite(Number(v))) { $('#bpm').value = v; $('#bpm').dispatchEvent(new Event('change')); } }
  function bpmMenu() { return [{ title: `Tempo ${engine.bpm} bpm` }, { label: 'Set tempo…', action: tempoPrompt, disabled: ro() }, { label: 'Tap tempo…', action: tapTempo, disabled: ro() }, { label: 'Change tempo, keep takes as they are…', action: async () => { const v = await promptName('Tempo (bpm) — takes keep their real speed and pitch', String(engine.bpm)); if (v) await setTempo(Number(v), { mode: 'grid' }); }, disabled: ro() }, { label: 'Half time (÷2, grid only)', action: () => setTempo(Math.round(engine.bpm / 2), { mode: 'grid' }).catch(fail), disabled: ro() }, { label: 'Double time (×2, grid only)', action: () => setTempo(Math.round(engine.bpm * 2), { mode: 'grid' }).catch(fail), disabled: ro() }, 'sep', ...clickMenu().slice(1, 4)]; }
  function tapTempo() {
    const taps = []; let finished = false; const close = toast('Tap tempo: press T in time (8 taps). Esc cancels.', { kind: '', ms: 0, onClose: () => done(false) });
    const h = (e) => { const ae = document.activeElement; if (document.querySelector('dialog[open]') || (ae && ['INPUT', 'TEXTAREA'].includes(ae.tagName))) return; if (e.key === 'Escape') { e.stopPropagation(); done(); return; } if (e.key.toLowerCase() !== 't') return; e.preventDefault(); taps.push(performance.now()); if (taps.length >= 8) done(true); else status(`tap ${taps.length}/8`); };
    const done = (ok) => { if (finished) return; finished = true; window.removeEventListener('keydown', h, true); close(); if (!ok || taps.length < 4) return; const d = []; for (let i = 1; i < taps.length; i++) d.push(taps[i] - taps[i - 1]); d.sort((a, b) => a - b); const med = d[Math.floor(d.length / 2)]; const bpm = Math.round(60000 / med); $('#bpm').value = bpm; $('#bpm').dispatchEvent(new Event('change')); status(`Tempo ${bpm} bpm`); };
    window.addEventListener('keydown', h, true);
  }
  function loopMenu(sec = null) {
    const bar = barOf(sec != null ? sec : engine.playhead);
    const sel = selected();
    return [
      { title: `Loop ${engine.loop.enabled ? 'on' : 'off'}: bars ${Math.round(barIdx(engine.loop.start)) + 1}–${endBarNo(engine.loop.end)}` },
      { label: engine.loop.enabled ? 'Loop off' : 'Loop on', hint: 'L', action: () => $('#loop-on').click() },
      { label: 'Practice the loop slower (same pitch)', sub: practiceItems(engine.loop.start, engine.loop.end, `bars ${Math.round(barIdx(engine.loop.start)) + 1}–${endBarNo(engine.loop.end)}`), disabled: !state.folder },
      { label: `Loop 4 bars from bar ${bar}`, action: () => setLoopBars(bar, bar + 3) },
      { label: `Note here (${sec != null ? posFine(snap(sec)) : posLabel(engine.playhead)}, whole song)…`, action: () => addNote(null, sec != null ? snap(sec) : engine.playhead) },
      { label: `Loop start = bar ${bar}`, hint: '[', action: () => setLoopBars(bar, Math.max(bar, endBarNo(engine.loop.end))) },
      { label: `Loop end = bar ${Math.max(1, sec != null ? Math.ceil(barIdx(sec) - 1e-6) : Math.ceil(barIdx(engine.playhead) - 1e-6))}`, hint: ']', action: () => { const e = Math.max(1, sec != null ? Math.ceil(barIdx(sec) - 1e-6) : Math.ceil(barIdx(engine.playhead) - 1e-6)); setLoopBars(Math.min(Math.round(barIdx(engine.loop.start)) + 1, e), e); } },
      { label: 'Loop the selected take', action: () => $('#btn-loop-clip').click(), disabled: !sel },
      { label: 'Loop the whole song', action: () => setLoopBars(1, Math.max(1, Math.ceil(barIdx(engine.contentLength()) - 1e-6))) },
      { label: 'Loop a section', sub: liveSections().map((x) => ({ label: `${x.name} (bars ${barOf(x.start)}–${endBarNo(x.end)})`, action: () => loopSection(x) })), disabled: !state.song || !liveSections().length },
      { label: 'Loop bars…', action: async () => { const v = await promptName('Loop bars (from-to)', `${Math.round(barIdx(engine.loop.start)) + 1}-${endBarNo(engine.loop.end)}`); const m = v && /^(\d+)\s*[-–]\s*(\d+)$/.exec(v.trim()); if (m) setLoopBars(Number(m[1]), Number(m[2])); } },
      'sep',
      { label: 'Record every loop pass as a take', hint: 'R with loop on', action: () => { if (!engine.loop.enabled) $('#loop-on').click(); engine.seek(engine.loop.start); record().catch(fail); }, disabled: ro() },
    ];
  }
  function stripMenu(t0) {
    const t = t0 ? engine.track(t0.id) : null; if (t0 && !t) return [{ title: 'song was reloaded — right-click again' }];
    if (!t) return [{ title: 'Master' }, { label: engine.master.limiter ? 'Limiter off' : 'Limiter on', action: () => { change(() => engine.setMaster({ limiter: !engine.master.limiter }), { label: `master limiter ${engine.master.limiter ? 'off' : 'on'}` }); renderMixer(); }, disabled: ro() }, { label: 'Reset master fader', action: () => { change(() => engine.setMaster({ gainDb: 0 })); renderMixer(); }, disabled: ro() }, { label: 'Room reverb', sub: [['small', 0.8], ['medium', 1.8], ['big', 3.2], ['huge', 5]].map(([l, d]) => ({ label: l, checked: Math.abs(engine.master.reverb.decay - d) < 0.05, action: () => { change(() => engine.setMaster({ reverb: { decay: d } })); renderFx(); } })), disabled: ro() }];
    return [{ title: t.name }, { label: 'Reset fader (0 dB)', action: () => { change(() => engine.updateTrack(t.id, { gainDb: 0 }), { label: `reset ${t.name} fader` }); renderAll(); }, disabled: ro() }, { label: 'Center pan', action: () => { change(() => engine.updateTrack(t.id, { pan: 0 }), { label: `center ${t.name} pan` }); renderAll(); }, disabled: ro() }, 'sep', ...trackItems(t)];
  }
  function setStage(k) { change(() => { if (k) state.song.stage = k; else delete state.song.stage; }, { label: k ? `stage → ${k}` : 'stage cleared' }); renderAll(); save(); }
  function songMenu(sInfo) {
    const open = sInfo.folder === state.folder;
    return [{ title: sInfo.name }, { label: open ? (state.readOnly ? 'Take over / edit' : 'Already open') : 'Open', action: () => (open ? (state.readOnly ? takeOver() : null) : openSong(sInfo.folder)), disabled: open && !state.readOnly }, { label: 'Close', action: () => closeSong(), disabled: !open }, { label: 'Show folder', action: () => bp.shell.openSongFolder(sInfo.folder) }, { label: 'Hand off to a DAW…', action: () => exportDaw({}), disabled: !open }, { label: 'React to the song', sub: open ? reactionItems('song', sInfo.name) : null, disabled: !open || ro() }, { label: 'Note at playhead (whole song)…', action: () => addNote(null, engine.playhead), disabled: !open }, { label: 'Bounce mix', action: () => bounce('mix'), disabled: !open }, 'sep', { label: `Key${open && state.song && state.song.key ? `: ${state.song.key}` : ''}`, sub: [{ label: 'Detect from the tracks', hint: 'guitar, bass, keys, vocals', action: () => detectSongKey().catch(fail) }, 'sep', { title: 'Set the label only — nothing moves (to move the music: Transpose song)' }, ...window.BPTemplates.KEYS.map((k) => ({ label: k || 'no key', checked: open && state.song && (state.song.key || '') === k, action: () => setSongKey(k) }))], disabled: !open || ro() }, { label: 'Stage', sub: [...Object.entries(STAGES).map(([k, v]) => ({ label: v, checked: sInfo.stage === k, action: () => setStage(k) })), { label: 'no stage', action: () => setStage(null) }], disabled: !open || ro() }, { label: 'Transpose song', hint: 'moves the recordings, MIDI and chords', sub: open ? transposeItems(null) : [], disabled: !open || ro() }, { label: 'Import audio files as tracks…', hint: 'or drag them in', action: () => window.pickAudioFiles(0), disabled: !open || ro() }, { label: 'Restructure song…', action: () => openRestructure().catch(fail), disabled: !open || ro() }, { label: 'Save as band template…', action: () => saveAsTemplate(sInfo.folder).catch(fail) }, { label: 'New song…', action: () => newSongWizard().catch(fail) }, 'sep', { label: 'Delete song…', danger: true, action: () => deleteSong(sInfo).catch(fail), disabled: !!(sInfo.presence && sInfo.presence.length) || !!(sInfo.lock && !sInfo.lock.stale && !sInfo.lockMine), hint: sInfo.presence && sInfo.presence.length ? `${sInfo.presence.map((p) => p.user).join(', ')} has it open` : '' }, { label: 'Deleted songs…', action: () => deletedSongs().catch(fail) }];
  }
  // Delete = the song folder moves to _deleted on the band Drive (for everyone). Deleted songs… brings one back.
  async function deleteSong(sInfo) {
    const a = await ask(`Delete "${sInfo.name}"?`, `It disappears from everyone's song list. The folder (every take, bounce and version) moves to "_deleted" in the band folder on Drive — nothing is erased, and right-click → Deleted songs… puts it back.`, [['Delete song', 'del', 'danger'], ['Cancel', 'cancel']]);
    if (a !== 'del') return;
    if (sInfo.folder === state.folder) { const ok = await closeSong({ interactive: false }); if (!ok) { status('Couldn\'t close the song (unsaved changes didn\'t save) — not deleted.', 8000); return; } }
    await bp.song.trash(sInfo.folder); await refreshSongs().catch(() => {});
    toast(`"${sInfo.name}" deleted — it's in _deleted on the band Drive. Right-click any song → Deleted songs… to bring it back.`, { kind: 'ok', ms: 9000 });
  }
  async function deletedSongs() {
    const list = await bp.song.trashed();
    if (!list.length) { status('No deleted songs.'); return; }
    const rows = list.slice(0, 20).map((x) => [`Restore "${x.name}"${x.by ? ` (deleted by ${x.by}${x.at ? `, ${timeAgo(x.at)}` : ''})` : ''}`, x.id]);
    const id = await ask('Deleted songs', 'Restore one to the song list. (To erase them for good, empty the _deleted folder in Drive.)', [...rows, ['Close', '']]);
    if (!id) return; const r = await withTakeout(() => bp.song.restore(id)); if (!r) return; await refreshSongs().catch(() => {}); toast(`Restored as "${r.folder}".`, { kind: 'ok', ms: 6000 });
  }
  function bounceMenu(b) { return [{ title: b.name }, ...(b.dir ? [] : [{ label: 'Listen', action: () => previewBounce(b, { textContent: '' }) }]), { label: 'Show in folder', action: () => bp.shell.showInFolder(b.path) }, { label: 'Copy message for the group chat', action: () => navigator.clipboard.writeText(`"${state.song.name}" ${b.dir ? 'DAW export' : 'bounce'} is in the band folder: ${state.song.name}/bounces/${b.name}`).then(() => toast('Copied — paste it in the group chat.', { kind: 'ok', ms: 2500 })) }]; }
  (function wireTopbarMenus() {
    M.attach($('#click-on').closest('.chip'), () => clickMenu());
    M.attach($('#count-in').closest('.chip'), () => clickMenu());
    M.attach($('#bpm').closest('.chip'), () => bpmMenu());
    M.attach($('#timesig').closest('.chip'), () => clickMenu());
    M.attach($('#loop-on').closest('.chip'), () => loopMenu());
    M.attach($('#monitor').closest('.chip'), () => { const mt = engine.track(engine.monitorVia); return [{ title: `Input monitoring${mt ? ` — through ${mt.name}` : engine.monitorFx ? ' — dry (arm an audio track to hear it through its FX)' : ' — dry'}` }, { label: engine.monitorInput ? 'Monitor off' : 'Monitor on (hear your input)', action: () => { $('#monitor').checked = !engine.monitorInput; $('#monitor').dispatchEvent(new Event('change')); } }, { label: "Through the armed track's amp / EQ / FX", checked: engine.monitorFx, action: async () => { engine.setMonitorFx(!engine.monitorFx); state.settings = await bp.settings.set({ monitorFx: engine.monitorFx }); } }, { label: 'Audio settings… (output device, latency)', action: openSettings }]; });
    M.attach($('#midi-led'), () => [{ title: 'MIDI input' }, ...[['', 'none'], ['any', 'any connected input'], ...(engine.midi.inputs || []).map((i) => [i.id, i.name])].map(([v, l]) => ({ label: l, checked: (engine.midi.selectedId || '') === v, action: async () => { engine.selectMidiInput(v || null); state.settings = await bp.settings.set({ midiInputId: v || null }); } }))]);
    M.attach($('#transport'), () => [{ title: 'Transport' }, { label: 'Go to start', hint: 'Home', action: () => $('#btn-start').click() }, { label: 'Go to end', hint: 'End', action: () => $('#btn-end').click() }, { label: engine.playing ? 'Stop' : 'Play', hint: 'Space', action: () => (engine.playing ? stop() : play()) }, { label: 'Record', hint: 'R', action: () => record().catch(fail), disabled: ro() }, 'sep', ...loopMenu().slice(1, 3), ...clickMenu().slice(1, 4)]);
    M.attach($('#master-area'), () => stripMenu(null));
    M.attach($('#song-head'), () => (state.folder ? songMenu(state.songs.find((x) => x.folder === state.folder) || { folder: state.folder, name: state.song.name }) : null));
    M.attach($('#no-song'), () => [{ label: 'New song…', action: () => $('#btn-new-song').click() }, { label: 'Settings…', action: openSettings }]);
  })();

  // ---------- timeline notes + reactions (shared through song.json: song.markers[], song.reactions[]) ----------
  // A note is a pin at a time, on one track or on the master time scale (trackId null). A reaction is an emoji from one
  // person on a target ('song', a track id or a take id). Both are soft-deleted (deleted: true) so bandmates' saves merge cleanly.
  const EMOJIS = ['🔥', '🤘', '❤️', '👍', '😂', '🎸', '🥁', '🎤', '🤔', '💩'];
  const me = () => state.settings.identity.user;
  const liveNotes = () => (state.song && state.song.markers ? state.song.markers : []).filter((m) => !m.deleted);
  const reactionsFor = (target) => (state.song && state.song.reactions ? state.song.reactions : []).filter((r) => !r.deleted && r.target === target);
  const barOf = (sec) => MT.posAt(meter(), Math.max(0, sec)).bar;
  const beatOf = (sec) => MT.posAt(meter(), Math.max(0, sec)).beat;
  const posLabel = (sec) => `bar ${barOf(sec)}${beatOf(sec) > 1 ? `.${beatOf(sec)}` : ''}`;
  function toggleReaction(target, emoji, what) {
    cchange(() => {
      const rs = state.song.reactions = state.song.reactions || [];
      const mine = rs.find((r) => !r.deleted && r.target === target && r.emoji === emoji && r.by === me());
      if (mine) mine.deleted = true; else rs.push({ id: window.BPUtil.newId(), target, emoji, by: me(), at: new Date().toISOString() });
    }, { label: `${emoji} ${what}` });
    renderAll();
  }
  function reactionItems(target, what) { return EMOJIS.map((e) => ({ label: `${e}  ${reactionsFor(target).filter((r) => r.emoji === e).map((r) => r.by).join(', ')}`, checked: reactionsFor(target).some((r) => r.emoji === e && r.by === me()), action: () => toggleReaction(target, e, what) })); }
  function reactionChips(target, what, { compact = false } = {}) {
    const box = el('div', 'reactions' + (compact ? ' compact' : ''));
    const by = new Map(); for (const r of reactionsFor(target)) { if (!by.has(r.emoji)) by.set(r.emoji, []); by.get(r.emoji).push(r.by); }
    for (const [e, who] of by) { const c = el('span', 'reaction' + (who.includes(me()) ? ' mine' : ''), `${e}${who.length > 1 ? ` ${who.length}` : ''}`); c.title = `${who.join(', ')} — click to ${who.includes(me()) ? 'remove yours' : 'add yours'}`; c.addEventListener('click', (ev) => { ev.stopPropagation(); if (ro()) return; toggleReaction(target, e, what); }); box.append(c); }
    if (!compact || !by.size) { const add = el('span', 'reaction add', by.size ? '+' : '+ react'); add.title = 'Add a reaction: drop an emoji on it so the band knows what you think — quicker than writing a note. Click yours again to take it back.'; add.addEventListener('click', (ev) => { ev.stopPropagation(); if (ro()) return; M.show(ev.clientX, ev.clientY, [{ title: `React to ${what}` }, ...reactionItems(target, what)]); }); box.append(add); }
    return box;
  }
  const newId = () => window.BPUtil.newId();
  const nowIso = () => new Date().toISOString();
  const people = () => CB.knownPeople(state.song, [me(), ...state.songs.flatMap((s) => [s.savedBy, s.lock && s.lock.user, ...(s.presence || []).map((p) => p.user)])]).filter((n) => n && !CB.nameMatch(n, me()));
  // Text with @mentions highlighted (text nodes only — never innerHTML with user text).
  function withMentions(text) {
    const frag = document.createDocumentFragment(); const t = String(text || '');
    const re = /(^|[^\w@])(@[\p{L}\p{N}_.'-]+(?: [\p{L}\p{N}_.'-]+)?)/gu; let last = 0, m;
    const known = people().concat(me());
    while ((m = re.exec(t))) {
      const start = m.index + m[1].length; let tag = m[2];
      const hit = CB.mentionsIn(tag, known)[0]; if (hit) tag = `@${tag.slice(1, 1 + hit.length)}`;
      frag.append(document.createTextNode(t.slice(last, start))); frag.append(el('span', 'mention', tag)); last = start + tag.length; re.lastIndex = last;
    }
    frag.append(document.createTextNode(t.slice(last)));
    return frag;
  }
  function pingToast(text) {
    const who = CB.mentionsIn(text, people().concat(me())).filter((n) => !CB.nameMatch(n, me()));
    if (who.length) toast(`${who.map((n) => `@${n}`).join(', ')} will see a badge on this song once Drive syncs your save.`, { kind: 'ok', ms: 5000 });
  }

  // ---------- timeline notes: threads ----------
  async function addNote(trackId, sec, preset) {
    sec = toRoomTime(sec);   // a note in a linked copy lives in the room: every copy shows it
    const t = trackId ? engine.track(trackId) : null; const sc = CB.sectionAt(state.song, sec);
    const text = preset || await promptName(`Note at ${posLabel(sec)}${sc ? ` · ${sc.name}` : ''}${t ? ` on ${t.name}` : ' (whole song)'} — @Name pings a bandmate`, '');
    if (!text) return null;
    let made = null;
    cchange(() => { made = { id: newId(), trackId: trackId || null, time: Math.max(0, sec), text, by: me(), at: nowIso(), replies: [] }; (state.song.markers = state.song.markers || []).push(made); }, { label: `note at ${posLabel(sec)}: "${text.slice(0, 40)}"` });
    renderAll(); pingToast(text);
    return made;
  }
  const liveMarker = (id) => (state.song && state.song.markers || []).find((x) => x.id === id && !x.deleted) || null;
  function replyTo(m, text) {
    let r = null;
    cchange(() => { r = { id: newId(), text, by: me(), at: nowIso() }; m.replies = [...(m.replies || []), r]; if (m.resolved) delete m.resolved; }, { label: `reply on note at ${posLabel(m.time)}: "${text.slice(0, 40)}"` });
    pingToast(text); return r;
  }
  function setResolved(m, yes) { cchange(() => { if (yes) m.resolved = { by: me(), at: nowIso() }; else delete m.resolved; }, { label: `${yes ? 'resolved' : 're-opened'} note at ${posLabel(m.time)}` }); renderAll(); }
  async function openThread(m0) {
    hideTip();
    const m = liveMarker(m0.id); if (!m) { status('That note is gone.'); return; }
    if (renderNotesList.markSeen) { renderNotesList.markSeen(m); setTimeout(() => renderNotesList(), 0); }   // opened = read: it leaves "For you"
    const d = $('#thread'); const t = m.trackId ? engine.track(m.trackId) : null; const sc = CB.sectionAt(state.song, m.time);
    $('#thread-title').textContent = `${posLabel(m.time)}${sc ? ` · ${sc.name}` : ''} · ${t ? t.name : 'whole song'}${m.resolved ? ` · resolved by ${m.resolved.by}` : ''}`;
    const body = $('#thread-body'); body.innerHTML = '';
    const msg = (x, first) => { const b = el('div', 'msg' + (first ? ' first' : '')); const who = el('div', 'who'); who.append(el('span', null, `${x.by || '?'} · ${x.at ? timeAgo(x.at) : ''}${x.editedBy ? ' · edited' : ''}`)); if (!first && CB.nameMatch(x.by, me()) && !ro()) { const del = el('button', 'del', '✕'); del.type = 'button'; del.title = 'Delete this reply of yours from the thread (you can only delete your own).'; del.addEventListener('click', () => { cchange(() => { x.deleted = true; }, { label: 'delete reply' }); renderAll(); d.close('reopen'); }); who.append(del); } const tx = el('div', 'txt'); tx.append(withMentions(x.text)); b.append(who, tx); return b; };
    body.append(msg(m, true)); for (const r of CB.live(m.replies)) body.append(msg(r, false));
    const inp = $('#thread-input'); inp.value = ''; inp.disabled = false; inp.placeholder = ro() ? 'Reply… (sent to whoever has the song open; @Name pings a bandmate)' : 'Reply… (@Name pings a bandmate)';
    const pp = $('#thread-people'); pp.innerHTML = ''; const ppl = people(); if (ppl.length) { pp.append(el('span', 'muted', 'ping: ')); for (const n of ppl) { const c = el('span', 'chip-btn', `@${n}`); c.addEventListener('click', () => { const v = inp.value; inp.value = `${v}${v && !/\s$/.test(v) ? ' ' : ''}@${n} `; inp.focus(); }); pp.append(c); } }
    $('#thread-reply').disabled = false; $('#thread-resolve').disabled = false; $('#thread-resolve').textContent = m.resolved ? 'Re-open' : 'Resolve';
    d.returnValue = ''; d.showModal(); setTimeout(() => { body.scrollTop = body.scrollHeight; inp.focus(); }, 0);
    inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); d.close('reply'); } };   // Enter sends, Shift+Enter = new line
    const rv = await new Promise((res) => d.addEventListener('close', () => res(d.returnValue), { once: true }));
    const live = liveMarker(m.id); if (!live) return;
    if (rv === 'reply' && inp.value.trim()) { replyTo(live, inp.value.trim()); renderAll(); return openThread(live); }
    if (rv === 'resolve') { setResolved(live, !live.resolved); return; }
    if (rv === 'reopen') return openThread(live);
  }
  function noteMenu(m0) {
    const m = liveMarker(m0.id); if (!m) return [{ title: 'note is gone' }];
    const t = m.trackId ? engine.track(m.trackId) : null; const sc = CB.sectionAt(state.song, m.time); const n = CB.live(m.replies).length;
    return [
      { title: `${m.by || '?'} · ${posLabel(m.time)}${sc ? ` · ${sc.name}` : ''}${t ? ` · ${t.name}` : ''}` },
      { label: n ? `Open thread (${n} repl${n > 1 ? 'ies' : 'y'})…` : 'Reply…', action: () => openThread(m) },
      { label: m.resolved ? 'Re-open' : 'Resolve ✓', action: () => setResolved(m, !m.resolved) },
      'sep',
      { label: 'Go there', action: () => { engine.seek(m.time); positionPlayhead(); } },
      { label: 'Loop 4 bars here', action: () => setLoopBars(barOf(m.time), barOf(m.time) + 3) },
      ...(sc ? [{ label: `Loop ${sc.name}`, action: () => loopSection(sc) }] : []),
      'sep',
      { label: 'Edit…', action: async () => { const text = await promptName('Edit note', m.text); if (text && text !== m.text) { cchange(() => { m.text = text; m.editedBy = me(); m.editedAt = nowIso(); }, { label: 'edit note' }); renderAll(); pingToast(text); } }, disabled: ro() },
      { label: 'Move to playhead', action: () => { cchange(() => { m.time = toRoomTime(engine.playhead); }, { label: 'move note' }); renderAll(); }, disabled: ro() },
      { label: t ? 'Move to the master time scale' : 'Move to a track', sub: t ? null : engine.tracks.map((x) => ({ label: x.name, action: () => { cchange(() => { m.trackId = x.id; }, { label: 'move note' }); renderAll(); } })), action: t ? () => { cchange(() => { m.trackId = null; }, { label: 'move note' }); renderAll(); } : undefined, disabled: ro() || (!t && !engine.tracks.length) },
      { label: 'Delete note', danger: true, action: () => { cchange(() => { m.deleted = true; m.deletedBy = me(); }, { label: 'delete note' }); renderAll(); }, disabled: ro() },
    ];
  }
  let tipEl = null;
  function showTip(x, y, lines) { if (!tipEl) { tipEl = el('div'); tipEl.id = 'tip'; document.body.append(tipEl); } tipEl.innerHTML = ''; for (const [cls, txt] of lines) tipEl.append(el('div', cls, txt)); tipEl.style.display = 'block'; const w = tipEl.offsetWidth; tipEl.style.left = `${Math.min(window.innerWidth - w - 8, x + 12)}px`; tipEl.style.top = `${y + 14}px`; }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
  const notesShown = () => liveNotes().filter((m) => state.showResolved || !m.resolved);
  // a note in a room shows in every linked copy too (the same thread: reply / resolve / edit it from any of them)
  function noteGhosts(m) { const out = []; for (const g of Object.values(linkInfoCache())) { if (!(m.time >= g.room.start - 1e-6 && m.time < g.room.end - 1e-6)) continue; for (const f of g.followers) { const off = f.start - g.room.start; if (m.time - g.room.start < f.end - f.start) out.push(off); } } return out; }
  function notePins(m) { return [notePin(m), ...noteGhosts(m).map((off) => notePin(m, off))]; }
  function notePin(m, off = 0) {
    const n = CB.live(m.replies).length;
    const pin = el('div', 'note-pin' + (CB.nameMatch(m.by, me()) ? ' mine' : '') + (m.resolved ? ' resolved' : '') + (off ? ' linked' : '')); pin.dataset.id = m.id; if (off) pin.dataset.ghost = '1';
    pin.style.left = `${(m.trackId ? 0 : HEAD_W) + (m.time + off) * state.pxPerSec}px`;
    const label = el('span', 'note-label', m.text); if (n) label.append(el('span', 'cnt', `💬${n}`)); pin.append(label);
    const tip = (ev) => { const last = CB.live(m.replies).slice(-2).map((r) => ['tip-text', `${r.by}: ${r.text}`]); showTip(ev.clientX, ev.clientY, [['tip-text', m.text], ...last, ['tip-meta', `${m.by || '?'} · ${posLabel(m.time)}${m.at ? ` · ${timeAgo(m.at)}` : ''}${m.resolved ? ' · resolved' : ''} · click to open the thread`]]); };
    label.addEventListener('mouseenter', tip); label.addEventListener('mousemove', tip); label.addEventListener('mouseleave', hideTip);
    pin.addEventListener('mousedown', (ev) => { ev.stopPropagation(); });
    label.addEventListener('click', (ev) => { ev.stopPropagation(); openThread(m); });
    M.attach(pin, () => { hideTip(); return noteMenu(m); });
    return pin;
  }
  function renderNotesList() {
    const ul = $('#note-list'); if (!ul) return; ul.innerHTML = '';
    const all = liveNotes(); const notes = notesShown().slice().sort((a, b) => a.time - b.time);
    const open = all.filter((m) => !m.resolved).length, done = all.length - open;
    $('#note-list-title').textContent = `Notes on the timeline${all.length ? ` (${open} open${done ? `, ${done} resolved` : ''})` : ''}`;
    // a mention stays "for you" until you've opened its thread or replied after it
    const seenM = (() => { try { return new Set(JSON.parse(localStorage.getItem('bp.seenMentions') || '[]')); } catch (_) { return new Set(); } })();
    const mkey = (x) => `${x.note.id}|${x.at || ''}`;
    const mine = CB.mentionsFor(state.song, me(), { knownNames: people().concat(me()) }).filter((x) => !seenM.has(mkey(x)) && !CB.live(x.note.replies).some((r) => CB.nameMatch(r.by, me()) && String(r.at) > String(x.at || '')));
    renderNotesList.markSeen = (note) => { try { const all = CB.mentionsFor(state.song, me(), { knownNames: people().concat(me()) }).filter((x) => x.note.id === note.id).map(mkey); const set = new Set([...seenM, ...all]); localStorage.setItem('bp.seenMentions', JSON.stringify([...set].slice(-500))); } catch (_) {} };
    const fresh = state.lastSeenAtOpen ? mine.filter((x) => String(x.at || '') > state.lastSeenAtOpen) : mine;
    const fy = $('#for-you'); fy.innerHTML = ''; fy.hidden = !mine.length;
    if (mine.length) { fy.append(el('div', 'fy-title', `For you (${mine.length})`)); const l = el('ul'); for (const x of mine.slice(0, 6)) { const li = el('li'); li.append(el('b', null, `${x.by}: `)); li.append(withMentions(x.text)); li.title = `${posLabel(x.note.time)} — click to open`; li.addEventListener('click', () => { engine.seek(x.note.time); positionPlayhead(); openThread(x.note); }); l.append(li); } fy.append(l); }
    const tb = $('#tb-notes'); tb.textContent = fresh.length ? `@${fresh.length}` : ''; tb.className = 'tab-badge ping';
    if (!notes.length) { ul.append(el('li', 'muted', all.length ? 'all resolved ✓' : 'none yet — right-click a bar or a track and pick "Note here…"')); return; }
    for (const m of notes) {
      const t = m.trackId ? engine.track(m.trackId) : null; const sc = CB.sectionAt(state.song, m.time); const n = CB.live(m.replies).length;
      const ping = mine.some((x) => x.note === m);
      const li = el('li', 'note-row' + (m.resolved ? ' resolved' : '') + (ping ? ' ping' : ''));
      li.append(el('span', 'note-pos mono', posLabel(m.time)), el('span', 'meta', `${sc ? `${sc.name} · ` : ''}${t ? t.name : 'song'} · ${m.by || ''}`));
      const tc = el('span', 'threadcount', n ? `💬 ${n}` : 'reply'); tc.title = 'Open the thread: read the replies to this note and add your own. @Name in a reply pings that bandmate.'; tc.addEventListener('click', (e) => { e.stopPropagation(); openThread(m); }); li.append(tc);
      const tx = el('span', 'note-text'); tx.append(withMentions(m.text)); li.append(tx);
      li.title = 'click: go there · double-click or 💬: thread · right-click: options';
      li.addEventListener('click', () => { engine.seek(m.time); positionPlayhead(); });
      li.addEventListener('dblclick', () => openThread(m));
      M.attach(li, () => noteMenu(m)); ul.append(li);
    }
  }
  $('#show-resolved').addEventListener('change', (e) => { state.showResolved = e.target.checked; renderTracks(); });

  // ---------- parts bin ----------
  const MU = window.BPMusic, ST = window.BPStretch;
  state.parts = [];
  async function refreshParts() { if (!state.settings.sharedFolder) return; try { state.parts = await bp.parts.list(); } catch (_) { state.parts = []; } renderParts(); renderBandFeed(); }
  setInterval(() => { if (document.visibilityState === 'visible') refreshParts().catch(() => {}); }, 60000); setTimeout(() => refreshParts().catch(() => {}), 2500);
  function renderParts() {
    const ul = $('#part-list'); if (!ul) return; ul.innerHTML = '';
    const q = ($('#parts-filter').value || '').trim().toLowerCase(); const sort = $('#parts-sort').value;
    const tagOf = (p) => (Array.isArray(p.tags) ? p.tags : []);
    let list = state.parts.filter((p) => !q || q.split(/\s+/).every((w) => `${p.name} ${p.by} ${p.key || ''} ${p.from || ''} ${p.style || ''} ${tagOf(p).join(' ')} ${(p.timeSig || [4, 4]).join('/')} ${p.bars || ''} bars`.toLowerCase().includes(w)));
    const cmp = { new: (a, b) => String(b.at).localeCompare(String(a.at)), name: (a, b) => a.name.localeCompare(b.name), style: (a, b) => (a.style || '~').localeCompare(b.style || '~') || a.name.localeCompare(b.name), bpm: (a, b) => (a.bpm || 0) - (b.bpm || 0), key: (a, b) => String(a.key || '~').localeCompare(String(b.key || '~')), who: (a, b) => String(a.by).localeCompare(String(b.by)) }[sort] || (() => 0);
    list = list.slice().sort(cmp); let lastGroup = null;
    if (!list.length) ul.append(el('li', 'muted', state.parts.length ? 'nothing matches' : 'Empty. Right-click a section (or a take) → "Save to Parts bin", or use Save part….'));
    for (const p of list) {
      if (sort === 'style' || sort === 'who') { const g = sort === 'style' ? (p.style || 'no style') : p.by; if (g !== lastGroup) { ul.append(el('li', 'pgroup', g)); lastGroup = g; } }
      const li = el('li'); const row = el('div', 'prow'); row.append(el('b', null, p.name));
      const shift = state.song ? MU.keyShift(p.key, state.song.key) : 0; const fits = state.song && p.bpm ? `${p.bpm === engine.bpm ? '' : `→ ${engine.bpm} bpm`}${shift ? ` · ${shift > 0 ? '+' : ''}${shift} st` : ''}` : '';
      const drop = el('button', null, 'Drop'); drop.title = `Drop at the playhead${fits ? ` (fits it: ${fits})` : ''}`; drop.addEventListener('click', () => dropPart(p, { at: engine.playhead }).catch(fail)); drop.disabled = ro() || !state.folder; row.append(drop);
      const keyTxt = p.key ? `${p.key}${p.keySource && p.keySource !== 'song' && p.keySource !== 'set' ? (p.keyConfidence != null && p.keyConfidence < 0.3 ? ' (guess?)' : ' (heard)') : ''}` : 'key ?';
      const ts = Array.isArray(p.timeSig) ? p.timeSig.join('/') : '4/4';
      const sigClash = state.song && ts !== engine.timeSig.join('/');
      const chips = el('div', 'ptags'); for (const tg of [...(p.style ? [p.style] : []), ...tagOf(p)]) { const c = el('button', 'ptag' + (tg === p.style ? ' style' : ''), tg); c.type = 'button'; c.title = `show only "${tg}"`; c.addEventListener('click', (e) => { e.stopPropagation(); $('#parts-filter').value = tg; renderParts(); }); chips.append(c); }
      li.append(row, chips, el('div', 'pmeta' + (sigClash ? ' clash' : ''), `${ts} · ${p.bars ? `${p.bars} bar${p.bars === 1 ? '' : 's'}` : '? bars'} · ${p.bpm} bpm · ${keyTxt} · ${(p.tracks || []).map((t) => t.name).join(', ')} · ${p.by}${p.from ? ` · from "${p.from}"` : ''}`));
      M.attach(li, () => [{ title: p.name }, { label: `Drop at the playhead (${posLabel(engine.playhead)})`, action: () => dropPart(p, { at: engine.playhead }).catch(fail), disabled: ro() || !state.folder },
        { label: 'Drop into section', sub: liveSections().map((sc) => ({ label: sc.name, action: () => dropPart(p, { at: sc.start }).catch(fail) })), disabled: ro() || !liveSections().length },
        { label: 'Drop as-is (no tempo / key change)', action: () => dropPart(p, { at: engine.playhead, conform: false }).catch(fail), disabled: ro() || !state.folder },
        { label: `Time signature: ${(p.timeSig || [4, 4]).join('/')}`, sub: window.BPTemplates.TIME_SIGS.map((t) => ({ label: t.join('/'), checked: (p.timeSig || [4, 4]).join('/') === t.join('/'), action: () => setPartMeta(p, { timeSig: t }).catch(fail) })) },
        { label: `Length: ${p.bars || '?'} bar${p.bars === 1 ? '' : 's'}…`, action: async () => { const v = await promptName('How many measures is this part?', String(p.bars || '')); const n = Math.round(Number(v)); if (v && n >= 1 && n <= 256) await setPartMeta(p, { bars: n }); } },
        { label: `Tags: ${tagOf(p).join(', ') || 'none'}…`, action: async () => { const v = await promptName('Tags (comma-separated) — e.g. riff, heavy, intro, palm-mute', tagOf(p).join(', ')); if (v === null || v === undefined) return; await setPartMeta(p, { tags: [...new Set(String(v).split(',').map((x) => x.trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 12) }); } },
        { label: `Style: ${p.style || 'none'}`, sub: [{ label: 'none', checked: !p.style, action: () => setPartMeta(p, { style: '' }).catch(fail) }, 'sep', ...[...new Set([...TPL.BUILTIN.filter((x) => x.id !== 'blank').map((x) => x.name), ...state.parts.map((x) => x.style).filter(Boolean)])].sort().map((st) => ({ label: st, checked: p.style === st, action: () => setPartMeta(p, { style: st }).catch(fail) }))] },
        { label: `Key: ${p.key || 'unknown'}`, sub: [{ label: 'Listen for the key again', action: () => redetectPartKey(p).catch(fail) }, 'sep', ...window.BPTemplates.KEYS.filter(Boolean).map((k) => ({ label: k, checked: p.key === k, action: () => setPartKey(p, k).catch(fail) }))] },
        'sep', { label: 'Delete from the parts bin', danger: true, action: async () => { const a = await ask('Delete part', `Delete "${p.name}" from the band's parts bin? Songs that already use it keep their copy.`, [['Delete', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a === 'ok') { await bp.parts.remove(p.id); refreshParts(); } } }]);
      ul.append(li);
    }
  }
  $('#parts-filter').addEventListener('input', renderParts); $('#parts-sort').addEventListener('change', () => { try { localStorage.setItem('bp.partsSort', $('#parts-sort').value); } catch (_) {} renderParts(); });
  try { const v = localStorage.getItem('bp.partsSort'); if (v) $('#parts-sort').value = v; } catch (_) {}
  $('#btn-part-save').addEventListener('click', () => { const sel = selected(); const sc = liveSections().find((x) => engine.playhead >= x.start - 1e-6 && engine.playhead < x.end); if (sel && !sel.c.link) savePartFrom({ clip: sel.c, track: sel.t }).catch(fail); else if (sc) savePartFrom({ section: sc }).catch(fail); else status('Put the playhead in a section (or select a take) first.'); });
  async function savePartFrom({ section, clip, track, from, to, name }) {
    if (!state.folder) throw new Error('no song open');
    const song = collectSong(); let w0, w1, label, ex;
    if (section) { w0 = section.start; w1 = section.end; label = `${song.name} – ${section.name}`; }
    else if (clip) { w0 = floorBar(clip.start); w1 = Math.max(barSec(barIdx(w0) + 1), barSec(Math.ceil(barIdx(clip.start + engine.clipLength(clip)) - 1e-6))); label = `${song.name} – ${clip.name}`; }   /* a part is whole measures: the take's window grows to its bar lines */
    else { w0 = floorBar(num(from, 0)); w1 = Math.max(barSec(barIdx(w0) + 1), snapToBar(num(to, barSec(barIdx(w0) + 4)))); label = `${song.name} – bars ${barOf(w0)}-${endBarNo(w1)}`; }
    if (clip) { ex = TPL.extractWindow({ tracks: [{ ...track, clips: [{ ...clip, mute: false }] }], chords: song.chords, lyrics: isVocalTrack(track) ? song.lyrics : [] }, w0, w1, { clipLength: (c) => engine.clipLength(c), newId }); }
    else ex = TPL.extractWindow(song, w0, w1, { clipLength: (c) => engine.clipLength(c), newId });
    if (!ex.tracks.length && !(ex.chords && ex.chords.length) && !(ex.lyrics && ex.lyrics.length)) throw new Error('Nothing recorded there to save (no takes, chords or lyrics).');
    const nm = name || await promptName('Name this part (the whole band sees it)', label); if (!nm) return null;
    // the part's key: whatever the song says at that spot; otherwise listen for it (MIDI notes or the audio itself)
    let key = keyAt(w0 + 0.01), keySource = key ? 'song' : '', keyConfidence = key ? 1 : 0;
    if (!key) { await engine.init(); const det = await detectKeyForTracks(ex.tracks, async (id) => engine.buffers.get(id) || null); key = det.key; keySource = det.source; keyConfidence = Math.round(det.confidence * 100) / 100; }
    if (!key) { key = MU.guessKey(ex.chords.map((x) => x.chord)); keySource = key ? 'chords' : ''; keyConfidence = key ? 0.5 : 0; }
    const part = { id: `part-${newId()}`, name: nm.slice(0, 60), by: me(), at: nowIso(), from: song.name, bpm: engine.bpm, key, keySource, keyConfidence, timeSig: [...engine.timeSig], bars: Math.max(1, Math.round(barIdx(w1) - barIdx(w0))), length: ex.length, tracks: ex.tracks, chords: ex.chords, ...(ex.lyrics && ex.lyrics.length ? { lyrics: ex.lyrics } : {}) };
    { const kinds = [...new Set(ex.tracks.map((t) => ({ guitar: 'guitar', bass: 'bass', drums: 'drums', vocals: 'vocals', keys: 'keys' }[t.type] || (t.instrument === 'drumkit' ? 'drums' : String(t.instrument || '').startsWith('synth:') ? 'synth' : ''))).filter(Boolean))];
      const secType = section ? TPL.sectionType(section.name) : (CB.sectionAt(song, w0 + 0.01) ? TPL.sectionType(CB.sectionAt(song, w0 + 0.01).name) : '');
      part.style = song.style || ''; part.tags = [...new Set([...kinds, ...(secType ? [secType] : []), ...(ex.chords && ex.chords.length && !ex.tracks.length ? ['chords'] : [])])].slice(0, 12); }
    status(`Saving "${part.name}" to the parts bin…`, 0);
    // store only the slice each piece uses (+50 ms either side), not the whole take: parts stay small and drop fast
    for (const t of ex.tracks) for (const c of t.clips) {
      if (c.kind === 'midi') continue;
      const buf = engine.buffers.get(c.src); if (!buf) throw new Error('Some of that audio has not synced in yet — try again in a minute.');
      const sr = buf.sampleRate, pad = 0.05, len = c.duration - c.trimStart - c.trimEnd;
      const a0 = Math.max(0, c.trimStart - pad), a1 = Math.min(buf.duration, c.trimStart + len + pad);
      const i0 = Math.floor(a0 * sr), i1 = Math.max(i0 + 1, Math.ceil(a1 * sr));
      const chans = []; for (let k = 0; k < buf.numberOfChannels; k++) chans.push(buf.getChannelData(k).slice(i0, i1));
      const id = newId(); await bp.parts.writeAudio(id, window.BPWav.encodeWav(chans, sr, 24));
      c.src = id; c.duration = (i1 - i0) / sr; c.trimStart = c.trimStart - i0 / sr; c.trimEnd = Math.max(0, c.duration - c.trimStart - len);
    }
    await bp.parts.save(state.folder, part, []); status(''); questCountPart(); questPopRaw(Q.WORTH.parts[0], Q.WORTH.parts[1]);
    toast(`Saved "${part.name}" to the parts bin (${part.bpm} bpm${key ? `, ${key}` : ''}). Anyone can drop it into a song from the Parts tab.`, { kind: 'ok', ms: 8000 });
    refreshParts(); return part;
  }
  // Drop a part: audio is re-timed to this song's tempo AND shifted to its key (independently, WSOLA + resample),
  // MIDI is re-timed and transposed, chords are transposed. Each take goes on a matching track (or a new one).
  async function dropPart(p, { at = engine.playhead, conform = true } = {}) {
    if (ro()) throw new Error('Read-only — take over first.');
    if (state.ab) await leaveAB({ silent: true });
    if (engine.recording || finishing || tempoBusy) throw new Error('Busy — stop recording first.');
    at = Math.max(0, snapToBar(at));   // parts are whole measures: drop on a bar line
    const pSig = Array.isArray(p.timeSig) ? p.timeSig.join('/') : '4/4';
    if (pSig !== engine.timeSig.join('/')) toast(`"${p.name}" is in ${pSig} and this song is in ${engine.timeSig.join('/')} — it plays as recorded, so its ${p.bars || '?'} bars won't line up with the song's bar lines.`, { kind: 'warn', ms: 10000 });
    let ratio = conform && p.bpm ? engine.bpm / p.bpm : 1; const toKey = keyAt(at + 0.01); const unsure = ['notes', 'audio', 'chords'].includes(p.keySource) && (p.keyConfidence == null || p.keyConfidence < 0.3); let semis = conform && !unsure ? MU.keyShift(p.key, toKey) : 0;
    if (conform && unsure && p.key && toKey && MU.keyShift(p.key, toKey)) toast(`Not sure "${p.name}" is really in ${p.key}, so it wasn't moved to ${toKey}. Right-click the part → Key to set it, then drop again.`, { kind: 'warn', ms: 10000 });
    if (ratio > 2 || ratio < 0.5) { toast(`"${p.name}" is ${p.bpm} bpm — too far from ${engine.bpm} to stretch cleanly; dropped at its own speed.`, { kind: 'warn', ms: 8000 }); ratio = 1; }
    const f = 1 / ratio;
    const rendered = new Map(); let n = 0; const srcs = [...new Set((p.tracks || []).flatMap((t) => t.clips.filter((c) => c.kind !== 'midi').map((c) => c.src)))];
    const drumSrcs = new Set((p.tracks || []).filter((t) => isDrumTrack(t)).flatMap((t) => t.clips.map((c) => c.src)));   /* drums keep their pitch: only re-timed */
    document.body.classList.add('busy');
    try {
      for (const src of srcs) {
        status(`Fitting "${p.name}" to ${engine.bpm} bpm${semis ? ` and ${toKey}` : ''}… ${++n}/${srcs.length}`, 0);
        const buf = await window.BPWav.decodeWav(engine.ctx, await bp.parts.readAudio(src));
        const sm = drumSrcs.has(src) ? 0 : semis; const out = (Math.abs(ratio - 1) < 1e-4 && !sm) ? buf : await ST.conform(buf, { ratio, semis: sm });
        const nid = newId();
        await bp.audio.write(state.folder, nid, window.BPWav.encodeWav(window.BPWav.audioBufferToChannels(out), out.sampleRate, 24), { label: `Part - ${p.name} - ${me()}` });
        engine.buffers.set(nid, out); rendered.set(src, { id: nid, duration: out.duration });
      }
    } finally { document.body.classList.remove('busy'); status(''); }
    const placed = [];
    const did = change(() => {
      for (const pt of p.tracks || []) {
        const isMidi = pt.clips.some((c) => c.kind === 'midi');
        let t = engine.tracks.find((x) => x.type === pt.type && (isMidi ? String(x.instrument).startsWith('synth:') : x.instrument === 'audio') && x.id === state.selectedTrack)
          || engine.tracks.find((x) => x.type === pt.type && (isMidi ? String(x.instrument).startsWith('synth:') : x.instrument === 'audio'));
        if (!t) { t = engine.addTrack(pt.name || 'Part'); const patch = { type: pt.type || 'other', instrument: pt.instrument || 'audio' }; if (pt.fx) patch.fx = JSON.parse(JSON.stringify(pt.fx)); if (pt.preset) patch.preset = pt.preset; engine.updateTrack(t.id, patch); }
        const drums = isDrumTrack(pt);
        for (const c of pt.clips) {
          const nc = { ...c, id: newId(), start: at + c.start * f, trimStart: c.trimStart * f, trimEnd: c.trimEnd * f, fadeIn: (c.fadeIn || 0) * f, fadeOut: (c.fadeOut || 0) * f, takenBy: p.by, takenAt: p.at, mute: false, part: { id: p.id, name: p.name, shift: drums ? 0 : semis, stretch: ratio } };
          if (c.kind === 'midi') { delete nc.src; nc.duration = c.duration * f; nc.notes = (c.notes || []).map((no) => ({ ...no, t: no.t * f, d: no.d * f, n: Math.max(0, Math.min(127, Math.round(no.n + (drums ? 0 : semis)))) })); }
          else { const r = rendered.get(c.src); nc.src = r.id; nc.duration = r.duration; nc.trimEnd = Math.max(0, Math.min(nc.trimEnd, nc.duration - nc.trimStart - 0.01)); }
          t.clips.push(nc); placed.push(nc);
        }
      }
      const flat = MU.isFlatKey(toKey);
      for (const ch of p.chords || []) (state.song.chords = state.song.chords || []).push({ id: newId(), time: at + ch.time * f, chord: MU.transposeChord(ch.chord, semis, flat), by: me(), at: nowIso() });
      for (const l of p.lyrics || []) { const t0 = at + l.time * f; if (liveLyrics().some((x) => typeof x.time === 'number' && Math.abs(x.time - t0) < 0.25 && x.text === l.text)) continue; (state.song.lyrics = state.song.lyrics || []).push({ id: newId(), time: t0, text: l.text, ...(l.words ? { words: l.words.map((w) => ({ w: w.w, t: w.t * f, e: w.e * f })) } : {}), by: p.by || me(), at: nowIso() }); }
    }, { label: `dropped part "${p.name}"` });
    if (!did) return null;
    renderAll();
    toast(`Dropped "${p.name}" at ${posLabel(at)}${ratio !== 1 ? ` — re-timed ${p.bpm} → ${engine.bpm} bpm` : ''}${semis ? `, moved ${semis > 0 ? 'up' : 'down'} ${Math.abs(semis)} semitone${Math.abs(semis) > 1 ? 's' : ''} to ${toKey}` : ''}. ${MOD}+Z undoes.`, { kind: 'ok', ms: 9000 });
    return { clips: placed.length, ratio, semis };
  }

  // ---------- keys & modulations ----------
  // A section can change key (song.sections[].key). Chords, chart, parts drops and melodies use the key at that time.
  function keyAt(t) { const sc = liveSections().filter((x) => t >= x.start - 1e-6 && t < x.end - 1e-6 && x.key).sort((a, b) => b.start - a.start)[0]; return (sc && sc.key) || (state.song && state.song.key) || ''; }
  function setSectionKey(sec, k) { cchange(() => { if (k) sec.key = k; else delete sec.key; }, { label: k ? `${sec.name} → key ${k}` : `${sec.name} back to the song key` }); renderAll(); }
  // A section's key change = transposing it: only keys reachable by moving everything up/down (same mode as now).
  // Major ↔ minor isn't a shift (different notes), so that's only offered as fixing the label (relative major/minor = same notes).
  function sectionKeyItems(sec) {
    const cur = keyAt(sec.start + 0.01), ck = MU.parseKey(cur), sk = MU.parseKey(state.song.key || '');
    const relabel = { label: 'Fix the label only (nothing moves)', sub: [{ label: `Song key${state.song.key ? ` (${state.song.key})` : ''}`, checked: !sec.key, action: () => setSectionKey(sec, null) }, 'sep', ...window.BPTemplates.KEYS.filter(Boolean).map((k) => ({ label: k, checked: sec.key === k, action: () => setSectionKey(sec, k) }))] };
    const head = [{ label: 'Detect from what\'s recorded here', action: () => detectSectionKey(sec).catch(fail) }, 'sep'];
    if (!ck) return [...head, { title: 'No key yet — detect it or set the label first' }, relabel];
    const iv = (k) => { let d = (((MU.parseKey(k).pc - ck.pc) % 12) + 12) % 12; if (d > 6) d -= 12; return d; };
    const same = window.BPTemplates.KEYS.filter((k) => k && MU.parseKey(k) && MU.parseKey(k).minor === ck.minor && MU.parseKey(k).name !== ck.name);
    same.sort((a, b) => Math.abs(iv(a)) - Math.abs(iv(b)) || iv(b) - iv(a));
    const back = sec.key && sk && sk.minor === ck.minor && sk.name !== ck.name ? [{ label: `Back to the song key (${state.song.key})`, action: () => transposeSong(iv(state.song.key), sec).catch(fail) }] : [];
    return [...head, { title: `Move ${sec.name} from ${cur} to — recordings, MIDI and chords shift with it` }, ...back,
      ...same.map((k) => { const d = iv(k); return { label: `${k}   (${d > 0 ? '+' : ''}${d})`, action: () => transposeSong(d, sec).catch(fail) }; }),
      'sep', relabel];
  }


  // ---------- part keys: set by the song, or detected from the notes / audio ----------
  // range = [a, b] in song seconds: only what sounds inside it counts (a section's own key)
  async function detectKeyForTracks(tracks, bufFor, range = null) {
    const notes = [], chroma = new Array(12).fill(0); let audioSecs = 0;
    const [ra, rb] = range || [-Infinity, Infinity];
    for (const t of tracks) for (const c of t.clips) {
      const len = Math.max(0, (Number(c.duration) || 0) - (c.trimStart || 0) - (c.trimEnd || 0));
      const o0 = Math.max(ra, c.start || 0), o1 = Math.min(rb, (c.start || 0) + len); if (range && o1 - o0 < 0.05) continue;
      if (c.kind === 'midi') { const mine = []; for (const n of c.notes || []) { const at = (c.start || 0) + n.t - (c.trimStart || 0); if (!range || (at >= ra && at < rb)) mine.push(n); } if (mine.length) notes.push(mine); continue; }
      if (audioSecs > 90) continue;
      const buf = await bufFor(c.src || c.id); if (!buf) continue;
      const sr = buf.sampleRate; const s0 = (c.trimStart || 0) + (range ? o0 - (c.start || 0) : 0), sl = range ? o1 - o0 : len;
      const i0 = Math.max(0, Math.floor(s0 * sr)), i1 = Math.min(buf.length, Math.ceil((s0 + sl) * sr)); if (i1 - i0 < sr * 0.2) continue;
      const chans = []; for (let k = 0; k < buf.numberOfChannels; k++) chans.push(buf.getChannelData(k).subarray(i0, i1));
      const w = MU.chromaFromChannels(chans, sr); const tot = w.reduce((a, b) => a + b, 0) || 1; w.forEach((x, i) => { chroma[i] += x / tot; }); audioSecs += sl;
    }
    // every clip counts once, MIDI or audio (a few MIDI notes no longer outvote all the recordings)
    for (const clipNotes of notes) { const w = new Array(12).fill(0); for (const x of clipNotes) for (const iv of (x.iv && x.iv.length ? x.iv : [0])) w[((Math.round(x.n + iv) % 12) + 12) % 12] += Math.max(0.05, Number(x.d) || 0.25); const tot = w.reduce((a, b) => a + b, 0) || 1; w.forEach((x, i) => { chroma[i] += x / tot; }); }
    if (!notes.length && !(audioSecs > 0)) return { key: '', confidence: 0, source: '' };
    const r = MU.keyFromPitchClasses(chroma);
    return { ...r, source: notes.length && audioSecs > 0 ? 'mixed' : notes.length ? 'notes' : 'audio' };
  }
  // ---------- song / section key from what's been recorded (guitar, bass, keys, vocals — not drums, not the generated melody) ----------
  function keyEvidenceTracks() {
    return engine.tracks.filter((t) => !t.mute && t.instrument !== 'drumkit' && t.type !== 'drums' && !/drum|perc|kick|snare|hat|cymbal|click/i.test(t.name || ''))
      .map((t) => ({ ...t, clips: t.clips.filter((c) => !engine.clipMuted(c) && !c.melody && !c.link) })).filter((t) => t.clips.length);
  }
  async function hearKey(range = null) {
    await engine.init();
    const tracks = keyEvidenceTracks(); if (!tracks.length) return { key: '', confidence: 0, source: '' };
    const r = await detectKeyForTracks(tracks, async (id) => engine.buffers.get(id) || null, range);
    // the bass line is the best witness: the roots it sits on, bar by bar, say the key more surely than chroma on
    // distorted guitars (a real-song test: chroma said Gm, the bass said B — and it was B)
    try {
      const bass = engine.tracks.filter((t) => t.instrument === 'audio' && window.BPAutoMix.role(t) === 'bass' && engine.audible(t) && t.clips.some((c) => !engine.clipMuted(c)));
      if (bass.length) {
        const len = engine.contentLength(); const from = range ? range.from : 0, to = range ? range.to : len;
        if (to - from > 4) {
          const rr = await engine.render({ soloTrackId: bass[0].id, from, to, unityMaster: true, exact: true, limiter: false });
          const m = mono(rr.channels); const bl = window.BPMeter.beatsIn(engine.meterMap(), from, to).filter((b) => b.beat === 0).map((b) => b.t - from);
          const slots = bl.map((b, i) => [b, bl[i + 1] != null ? bl[i + 1] : b + barLenAt(b + from)]);
          const units = window.BPChordDetect.bassRoots(m, rr.sampleRate, slots).map((root) => ({ root }));
          const hk = window.BPChordDetect.keyFromRoots(units);
          if (hk && hk.confidence >= 0.6 && (hk.confidence > r.confidence || !r.key)) return { key: hk.key, confidence: hk.confidence, source: 'bass', runnerUp: r.key && r.key !== hk.key ? r.key : null, chroma: r };
        }
      }
    } catch (_) { /* no bass evidence: the chroma answer stands */ }
    return r;
  }
  const relKey = (k) => { const p = MU.parseKey(k); if (!p) return ''; return p.minor ? MU.transposeKey(`${MU.noteName(p.pc)}`, 3) : `${MU.transposeKey(MU.noteName(p.pc), -3)}m`; };
  const sameNotes = (a, b) => { const x = MU.parseKey(a), y = MU.parseKey(b); return !!x && !!y && (x.name === y.name || relKey(x.name) === y.name); };
  const sure = (r) => (r.confidence >= 0.3 ? 'pretty sure' : r.confidence >= 0.15 ? 'fairly sure' : 'not sure');
  // how: '' = set by hand, 'heard' / 'bass line' = detected. Kept on the song (keySource) so a hand-set key is never
  // second-guessed loudly, and a detected one can be re-checked when better evidence (a bass take) shows up.
  function setSongKey(k, how = '') { change(() => { if (k) { state.song.key = k; state.song.keySource = how || 'set'; } else { delete state.song.key; delete state.song.keySource; } }, { label: k ? `key ${k}${how ? ` (${how})` : ''}` : 'key cleared' }); state.keyDoubt = null; renderAll(); }
  // A track's type (guitar / bass / vocals / drums / keys) steers Auto mix, key detection and the play-along tab. When
  // nobody picked it by hand, the name decides ("Backing (no drums)" on a vocal-type track was a real case).
  const TYPE_OF_ROLE = { leadVox: 'vocals', backVox: 'vocals', bass: 'bass', drums: 'drums', gtr: 'guitar', keys: 'keys' };
  function fixTrackTypes({ quiet = true } = {}) {
    const fixes = [];
    for (const t of engine.tracks) {
      if (t.typeSet || t.instrument !== 'audio') continue;
      const byName = window.BPAutoMix.role({ name: t.name, preset: t.preset, instrument: 'audio' }); const want = TYPE_OF_ROLE[byName] || (byName === 'other' && /\bbacking\b|\(no drums\)|instrumental|\bbed\b|full mix/i.test(t.name) ? 'other' : null);
      if (want && want !== t.type) fixes.push([t, want]);
    }
    if (!fixes.length) return 0;
    change(() => { for (const [t, ty] of fixes) engine.updateTrack(t.id, { type: ty }); }, { label: `track types from names (${fixes.map(([t, ty]) => `${t.name} → ${ty}`).join(', ')})`, undoable: false, activity: false });
    if (!quiet) status(`Track types set from their names: ${fixes.map(([t, ty]) => `${t.name} → ${ty}`).join(', ')}. Pick a type by hand in Track setup to keep it.`, 9000);
    return fixes.length;
  }
  // Does what's recorded agree with the key label? Runs in the background after a song loads and after a bass take
  // lands; a disagreement shows on the key chip (⚠) with a one-click fix — the label is never changed by itself.
  let keyCheckBusy = false;
  async function keyCheck({ quiet = true } = {}) {
    if (!state.folder || !state.song || keyCheckBusy) return null;
    const hasBass = engine.tracks.some((t) => t.instrument === 'audio' && window.BPAutoMix.role(t) === 'bass' && engine.audible(t) && t.clips.some((c) => !engine.clipMuted(c) && !state.missingClips.has(audioId(c))));
    if (!hasBass) return null;
    keyCheckBusy = true; const folder = state.folder;
    try {
      const hk = await hearKey(); if (state.folder !== folder) return null;
      const cur = state.song.key || '';
      const doubt = hk && hk.source === 'bass' && hk.confidence >= 0.6 && (!cur || !sameNotes(hk.key, cur)) ? { key: hk.key, confidence: hk.confidence, label: cur } : null;
      state.keyDoubt = doubt; renderKeyChip();
      if (doubt && !quiet) toast(`The bass line says ${doubt.key}${cur ? ` — the song is labelled ${cur}` : ' — no key is set'}.`, { kind: 'warn', ms: 15000, buttons: [[`Set ${doubt.key}`, () => setSongKey(doubt.key, 'bass line')]] });
      return doubt;
    } catch (_) { return null; } finally { keyCheckBusy = false; }
  }
  async function detectSongKey() {
    if (!state.folder) return; if (ro()) { status('Read-only — take over first.'); return; }
    status('Listening to the takes for the key…', 0);
    const r = await hearKey(); status('');
    if (!r.key) { toast('Nothing to listen to yet — record or import a guitar, bass, keys or vocal take first (drums don\'t count).', { kind: 'warn', ms: 8000 }); return; }
    const cur = state.song.key || '';
    const btns = [[`Set ${r.key}`, () => setSongKey(r.key, 'heard')], [`${relKey(r.key)} (same notes)`, () => setSongKey(relKey(r.key), 'heard')]];
    if (r.runnerUp && r.runnerUp !== r.key) btns.push([`Set ${r.runnerUp}`, () => setSongKey(r.runnerUp, 'heard')]);
    btns.push(['Leave it', () => {}]);
    toast(`Sounds like ${r.key} (${sure(r)}${r.source === 'bass' ? ', from the bass line' : ''}${r.runnerUp ? ` — next best ${r.runnerUp}` : ''}).${cur ? ` The song is set to ${cur}.` : ''}`, { kind: 'ok', ms: 0, buttons: cur === r.key ? [['OK', () => {}]] : btns });
    return r;
  }
  async function detectSectionKey(sec) {
    if (ro()) { status('Read-only — take over first.'); return; }
    status(`Listening to ${sec.name} for its key…`, 0);
    const r = await hearKey([sec.start, sec.end]); status('');
    if (!r.key) { toast(`Nothing to listen to in ${sec.name} yet (drums don't count).`, { kind: 'warn' }); return; }
    const songKey = state.song.key || ''; const pk = MU.parseKey(songKey), rk = MU.parseKey(r.key);
    if (pk && rk && sameNotes(pk.name, rk.name)) { toast(`${sec.name} uses the same notes as the song key (${songKey}) — no key change.`, { kind: 'ok' }); if (sec.key) setSectionKey(sec, null); return r; }
    toast(`${sec.name} sounds like ${r.key} (${sure(r)}${r.runnerUp ? ` — next best ${r.runnerUp}` : ''}).`, { kind: 'ok', ms: 0, buttons: [[`Set ${sec.name} to ${r.key}`, () => setSectionKey(sec, r.key)], ['Leave it', () => {}]] });
    return r;
  }
  // After takes go in on a song with no key: listen and set it (once per song per session; Undo on the toast or Song menu → Key to change)
  async function maybeAutoKey() {
    try {
      if (!state.folder || ro() || !state.song || state.song.key || state.autoKeyTried === state.folder) return;
      const r = await hearKey(); if (!r.key) return;
      state.autoKeyTried = state.folder;
      // only a sure answer sets the label by itself (the bass line, or chroma that's really clear); a guess is offered, never written —
      // a wrong label silently steers pitch check, melodies and chord names
      if (r.source === 'bass' || r.confidence >= 0.3) { setSongKey(r.key, r.source === 'bass' ? 'bass line' : 'heard'); toast(`Song key set to ${r.key} — heard from ${r.source === 'bass' ? 'the bass line' : 'your takes'} (${sure(r)}). Not right? Click the key up top.`, { kind: 'ok', ms: 10000, buttons: [[`It's ${relKey(r.key)}`, () => setSongKey(relKey(r.key), 'heard')], ...(r.runnerUp ? [[`It's ${r.runnerUp}`, () => setSongKey(r.runnerUp, 'heard')]] : []), ['Undo', () => setSongKey('')]] }); }
      else toast(`Might be ${r.key}${r.runnerUp ? ` or ${r.runnerUp}` : ''} — not sure enough to set it. A bass take settles it.`, { kind: '', ms: 9000, buttons: [[`Set ${r.key}`, () => setSongKey(r.key, 'heard')], ...(r.runnerUp ? [[`Set ${r.runnerUp}`, () => setSongKey(r.runnerUp, 'heard')]] : [])] });
    } catch (_) { /* best effort */ }
  }
  async function setPartMeta(p, patch) { Object.assign(p, patch); await bp.parts.save(state.folder || '', p, []); refreshParts(); }
  async function setPartKey(p, k) { p.key = k; p.keySource = 'set'; p.keyConfidence = 1; await bp.parts.save(state.folder || '', p, []); refreshParts(); }
  async function redetectPartKey(p) {
    status(`Listening to "${p.name}" for its key…`, 0);
    const bufs = new Map(); const bufFor = async (id) => { if (!bufs.has(id)) { try { bufs.set(id, await window.BPWav.decodeWav(engine.ctx, await bp.parts.readAudio(id))); } catch (_) { bufs.set(id, null); } } return bufs.get(id); };
    await engine.init(); const r = await detectKeyForTracks(p.tracks || [], bufFor);
    if (!r.key) { status('Could not hear a key in that part.'); return; }
    p.key = r.key; p.keySource = r.source; p.keyConfidence = Math.round(r.confidence * 100) / 100; await bp.parts.save(state.folder || '', p, []);
    status(`"${p.name}" sounds like ${r.key}${r.confidence < 0.3 ? ` (not sure — maybe ${r.runnerUp}; right-click → Key to set it)` : ''}.`, 9000); refreshParts();
  }

  // ---------- melody generator ----------
  const ML = window.BPMelody;
  state.mel = null;
  function melodyWindowOptions() {
    const fol = new Set(Object.values(TPL.linkInfo({ sections: state.song.sections, linkGroups: state.song.linkGroups })).flatMap((g) => g.followers.map((f) => f.id)));
    const out = liveSections().filter((x) => !fol.has(x.id)).slice().sort((a, b) => a.start - b.start).map((x) => ({ id: x.id, label: `${x.name} (bars ${barOf(x.start)}–${endBarNo(x.end)})`, w0: x.start, w1: x.end, type: TPL.sectionType(x.name) }));
    if (engine.loop.end > engine.loop.start + 0.5) out.push({ id: 'loop', label: `Loop (bars ${barOf(engine.loop.start)}–${endBarNo(engine.loop.end)})`, w0: engine.loop.start, w1: engine.loop.end, type: CB.sectionAt(state.song, engine.loop.start + 0.01) ? TPL.sectionType(CB.sectionAt(state.song, engine.loop.start + 0.01).name) : '' });
    if (!out.length) out.push({ id: 'bars', label: `Bars ${barOf(engine.playhead)}–${barOf(engine.playhead) + 7}`, w0: floorBar(engine.playhead), w1: barSec(Math.floor(barIdx(engine.playhead) + 1e-6) + 8), type: '' });
    return out;
  }
  function melodyTrack(create = true) {
    let t = engine.tracks.find((x) => x.instrument === 'synth:voice' && /melody/i.test(x.name)) || engine.tracks.find((x) => x.instrument === 'synth:voice');
    if (!t && create) { t = engine.addTrack('Melody'); engine.updateTrack(t.id, { type: 'vocals', instrument: 'synth:voice', gainDb: -4 }); }
    return t;
  }
  function renderSyllables() {
    const lines = ML.syllables($('#ml-text').value); const box = $('#ml-syl'); box.innerHTML = '';
    lines.forEach((l) => { const d = el('div'); l.forEach((x, i) => { const sp = el(x.stress ? 'b' : 'span', null, x.text); d.append(sp, document.createTextNode(x.wordEnd ? ' ' : '·')); }); d.append(el('span', 'muted', ` (${l.length})`)); box.append(d); });
    return lines;
  }
  function melodyGenerate(mode) {
    const m = state.mel; const win = m.windows.find((x) => x.id === $('#ml-section').value) || m.windows[0];
    const lines = renderSyllables(); if (!lines.length) throw new Error('Type the lyrics first — one line per phrase.');
    const total = lines.reduce((n, l) => n + l.length, 0);
    const key = keyAt(win.w0 + 0.01) || songKeyOrGuess() || 'C';
    const opts = { lines, seconds: win.w1 - win.w0, bpm: meterAt(win.w0 + 1e-4).bpm, timeSig: meterAt(win.w0 + 1e-4).timeSig, key, sectionType: win.type, voice: $('#ml-voice').value, density: $('#ml-density').value,
      chordAt: (sec) => { const c = CB.chordAt(state.song, win.w0 + sec); return c && !c.deleted ? c.chord : null; }, seed: (Math.random() * 2 ** 32) >>> 0 };
    const prev = m.gen && m.gen.rhythm.length === total && m.gen.win.id === win.id ? m.gen : null;
    if (mode === 'notes' && prev) opts.rhythm = prev.rhythm;
    if (mode === 'rhythm' && prev) opts.pitches = prev.pitches;
    const g = ML.generate(opts); g.win = win; g.key = key; g.text = $('#ml-text').value; g.notes.forEach((x, i) => { x._line = g.rhythm[i] ? g.rhythm[i].line : 0; });
    applyMelodyDraft(g);
    $('#ml-info').textContent = `${total} syllables over ${Math.round(barIdx(win.w1) - barIdx(win.w0))} bars · key ${key}${state.song.key || liveSections().some((x) => x.key) ? '' : ' (guessed from chords)'} · rule score ${g.score.toFixed(1)} · seed ${g.seed}`;
    return g;
  }
  function applyMelodyDraft(g) {
    const m = state.mel; const first = !m.clipId || m.winId !== g.win.id; m.replaced = m.replaced || [];
    if (first && m.clipId) m.done.push(m.clipId);   // the melody for the previous part stays; this part gets its own
    m.winId = g.win.id;
    const did = change(() => {
      if (!melodyTrack(false)) m.madeTrack = true;
      const t = melodyTrack(true); m.trackId = t.id;
      if (m.clipId && !first) for (const tt of engine.tracks) { const old = tt.clips.find((c) => c.id === m.clipId); if (!old) continue; if (m.origIds.has(old.id)) trashClip(tt, old); tt.clips = tt.clips.filter((c) => c !== old); }
      const clip = { id: newId(), kind: 'midi', name: `melody · ${g.win.label.replace(/ \(.*$/, '')}`, start: g.win.w0, duration: g.win.w1 - g.win.w0, trimStart: 0, trimEnd: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, mute: false, takenBy: me(), takenAt: nowIso(), notes: clipNotes(g.notes), melody: { text: g.text, seed: g.seed, section: g.win.id, voice: $('#ml-voice').value } };
      // a melody already on that track in this part (from an earlier session) is replaced by the new one
      if (first) for (const c of t.clips.filter((c) => c.melody && !c.link && Math.abs(c.start - g.win.w0) < 1e-3)) { t.clips = t.clips.filter((y) => y !== c); trashClip(t, c); m.replaced.push({ trackId: t.id, clip: JSON.parse(JSON.stringify(c)) }); }
      t.clips.push(clip); m.clipId = clip.id; state.selectedTrack = t.id;
    }, { label: `melody for ${g.win.label.replace(/ \(.*$/, '')}`, undoable: first, activity: first });
    if (!did) throw new Error('Could not add the melody (read-only or A/B).');
    m.gen = g; m.touched = true; renderAll(); RC = RC_MEL; rollReset();
  }
  async function openMelody(winId = null) {
    if (!state.folder) return; if (ro()) { status('Read-only — take over first.'); return; }
    if (state.ab) await leaveAB({ silent: true });
    const windows = melodyWindowOptions();
    const at = engine.loop.enabled ? engine.loop.start + 0.01 : engine.playhead;   // the part you're looping (else the playhead's)
    const here = windows.find((x) => x.id === winId) || windows.find((x) => x.type && at >= x.w0 - 1e-6 && at < x.w1) || windows.find((x) => at >= x.w0 - 1e-6 && at < x.w1) || windows[0];
    state.mel = { windows, gen: null, clipId: null, kept: [], replaced: [], done: [], origIds: new Set(), undoLen: state.undo.length, gens: new Map() };
    const sel = $('#ml-section'); sel.innerHTML = ''; for (const w of windows) { const o = el('option', null, w.label); o.value = w.id; sel.append(o); } sel.value = here.id;
    const prefill = () => {
      const w = windows.find((x) => x.id === sel.value) || here;
      const m = state.mel;
      if (m.gen && m.gen.win && m.gen.notes && m.gen.notes.length) m.gens.set(m.gen.win.id, m.gen);   // every part you wrote this visit gets its lyrics placed on Done, not just the last one
      m.gen = null;
      if (m.clipId && m.winId !== w.id) { m.done.push(m.clipId); m.clipId = null; m.winId = null; }   // the other part's melody stays (Cancel takes it out)
      const mt = melodyTrack(false); const existing = mt && mt.clips.find((c) => c.melody && !c.link && Math.abs(c.start - w.w0) < 1e-3);
      if (existing) {   // open the melody that's already there in the note editor
        $('#ml-text').value = existing.melody.text; $('#ml-voice').value = existing.melody.voice || 'mid';
        const lines = ML.syllables(existing.melody.text || ''); const lineOf = []; lines.forEach((l, li) => l.forEach(() => lineOf.push(li)));
        const bs = engine.beatLen(); const notes = (existing.notes || []).map((x, i) => ({ ...x, _line: lineOf.length ? lineOf[Math.min(i, lineOf.length - 1)] : 0 })).sort((a, b) => a.t - b.t);
        m.gen = { notes, rhythm: notes.map((x, i) => ({ line: x._line, i, beat: x.t / bs, dur: x.d / bs / 0.92 })), pitches: notes.map((x) => x.n), seed: existing.melody.seed || 0, score: 0, lines, lineSrc: lines.map((l, i) => (l.src != null ? l.src : i)), win: w, key: keyAt(w.w0 + 0.01) || songKeyOrGuess() || 'C', text: existing.melody.text || '' };
        if (!m.done.includes(existing.id) && !m.origIds.has(existing.id)) { m.origIds.add(existing.id); m.replaced.push({ trackId: mt.id, clip: JSON.parse(JSON.stringify(existing)) }); }
        m.clipId = existing.id; m.winId = w.id; m.trackId = mt.id;
        return;
      }
      const pinned = lyricsOrdered().filter((l) => typeof l.time === 'number' && l.time >= w.w0 - 1e-6 && l.time < w.w1).map((l) => l.text);
      $('#ml-text').value = (pinned.length ? pinned : lyricsOrdered().filter((l) => typeof l.time !== 'number').slice(0, 4).map((l) => l.text)).join('\n');
    };
    prefill(); renderSyllables(); $('#ml-info').textContent = state.mel.gen ? 'This part\'s melody — drag the notes to change it, or 🎲 Again for a new one.' : 'Press 🎲 Again to write a melody. Every press is a new one; ☆ Keep the ones you like.'; $('#ml-kept').innerHTML = '';
    sel.onchange = async () => { prefill(); renderSyllables(); RC = RC_MEL; rollReset(); if (engine.playing) { await stop(); const w = melodyLoopOn(); if (w) { engine.seek(w.w0); await play(); } } };
    $('#ml-text').oninput = renderSyllables;
    const d = $('#melody'); d.returnValue = ''; d.showModal(); RC = RC_MEL; rollReset();
    const ok = await new Promise((res) => d.addEventListener('close', function h() { d.removeEventListener('close', h); res(d.returnValue === 'ok'); }));
    speechStop(); if (engine.playing) await stop();
    const m = state.mel; state.mel = null; melodyLoopOff(m); if (roll.raf) { cancelAnimationFrame(roll.raf); roll.raf = 0; }
    if (!m || (!m.clipId && !m.done.length) || !m.touched) return;
    if (!ok) {   // "Remove melody": take out what this visit added and put back any melody it replaced
      change(() => {
        const drop = new Set([m.clipId, ...m.done]); for (const t of engine.tracks) t.clips = t.clips.filter((c) => !drop.has(c.id));
        for (const r of m.replaced) { const t = engine.track(r.trackId); if (t && !t.clips.some((c) => c.id === r.clip.id)) { t.clips.push(r.clip); if (state.song.trash) delete state.song.trash[r.clip.id]; } }
        if (m.madeTrack) { const t = engine.track(m.trackId); if (t && !t.clips.length) engine.removeTrack(t.id); }   // the Melody track this visit made, now empty
      }, { label: 'removed melody', undoable: false, activity: false });
      if (state.undo.length > m.undoLen) state.undo.length = m.undoLen; state.redo = []; updateUndoButtons();   // nothing from this visit is left to undo / redo back in
      state.pendingActivity = state.pendingActivity.filter((a) => !/^(melody for|edited the melody)/.test(a));
      renderAll(); return;
    }
    if ($('#ml-place').checked) { if (m.gen && m.gen.win) m.gens.set(m.gen.win.id, m.gen); for (const g of m.gens.values()) placeMelodyLyrics(g); }
    toast(`Melody on the "${melodyTrack(false).name}" track. It sings the vowels in tune; right-click it → Melody… to re-roll.`, { kind: 'ok', ms: 8000 });
  }
  // the chorus melody (and its lyric lines) into every other chorus — replaces their melody takes, Undo puts them back
  function copyMelodyToType(t, c, src, others) {
    const len = engine.clipLength(c); let n = 0;
    cchange(() => {
      for (const o of others) {
        for (const x of t.clips.filter((y) => y.melody && !y.link && Math.abs(y.start - o.start) < 1e-3)) trashClip(t, x);
        t.clips = t.clips.filter((y) => !(y.melody && !y.link && Math.abs(y.start - o.start) < 1e-3));
        const nc = { ...JSON.parse(JSON.stringify(c)), id: newId(), start: o.start, name: `melody · ${o.name}`, melody: { ...JSON.parse(JSON.stringify(c.melody)), section: o.id } };
        if (o.end - o.start < len - 1e-3) nc.trimEnd = (nc.trimEnd || 0) + (len - (o.end - o.start));
        t.clips.push(nc); n++;
        for (const l of liveLyrics().filter((l) => typeof l.time === 'number' && l.time >= src.start - 1e-6 && l.time < src.end - 1e-6)) {
          const at = o.start + (l.time - src.start); if (at >= o.end - 1e-6) continue;
          if (!liveLyrics().some((x) => x.text === l.text && typeof x.time === 'number' && Math.abs(x.time - at) < 1e-3)) (state.song.lyrics = state.song.lyrics || []).push({ id: newId(), time: at, text: l.text, by: me(), at: nowIso() });
        }
      }
    }, { label: `${src.name} melody → every ${TPL.sectionType(src.name)}` });
    renderAll(); status(`${src.name}'s melody and lyrics are in ${n} more section${n > 1 ? 's' : ''}. ${MOD}+Z undoes.`, 7000);
  }
  function placeMelodyLyrics(g) {
    const lines = String(g.text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    // "ar-gue" (a split typed for the melody) → "argue"; real hyphenated words (self-destruct, twenty-one) stay
    const unhyphen = (t) => t.replace(/\b(\w{1,3})-(\w{1,4})\b/g, (m0, a, b) => (/^(self|ex|re|co|non|pre)$/i.test(a) ? m0 : a + b));
    const used = new Set();
    cchange(() => {
      (g.lineSrc || lines.map((_, i) => i)).forEach((src, li) => {
        const text = lines[src]; if (!text) return;
        const first = g.rhythm.findIndex((e) => e.line === li); if (first < 0) return;
        const at = g.win.w0 + g.notes[first].t; const clean = unhyphen(text.replace(/_/g, ' '));
        const ex = liveLyrics().find((l) => !used.has(l.id) && l.text === clean && (typeof l.time !== 'number' || (l.time >= g.win.w0 - 1e-6 && l.time < g.win.w1)));
        if (ex) { ex.time = at; used.add(ex.id); } else { const nl = { id: newId(), time: at, text: clean, by: me(), at: nowIso() }; (state.song.lyrics = state.song.lyrics || []).push(nl); used.add(nl.id); }
      });
    }, { label: `lyrics placed for the melody` });
    renderAll();
  }
  // "Say it": the computer's own voice speaks each line in time with playback (for checking where words fall).
  let speechTimers = [];
  function speechStop() { for (const t of speechTimers) clearTimeout(t); speechTimers = []; try { window.speechSynthesis.cancel(); } catch (_) {} }
  async function sayMelody() {
    const m = state.mel; if (!m || !m.gen) { status('Roll a melody first.'); return; }
    speechStop(); const g = m.gen; const lines = String(g.text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (engine.playing) await stop(); melodyLoopOn(); engine.seek(g.win.w0); await play(); rollLive();
    (g.lineSrc || lines.map((_, i) => i)).forEach((src, li) => {
      const text = lines[src] || '';
      const ix = g.rhythm.map((e, i) => (e.line === li ? i : -1)).filter((i) => i >= 0); if (!ix.length) return;
      const t0 = g.notes[ix[0]].t, t1 = g.notes[ix[ix.length - 1]].t + g.notes[ix[ix.length - 1]].d; const sylPerSec = ix.length / Math.max(0.3, t1 - t0);
      speechTimers.push(setTimeout(() => { try { const u = new SpeechSynthesisUtterance(text.replace(/[_-]/g, ' ')); u.rate = Math.max(0.6, Math.min(2.2, sylPerSec / 3.2)); u.pitch = 1; window.speechSynthesis.speak(u); } catch (_) {} }, t0 * 1000));
    });
  }
  $('#btn-melody').addEventListener('click', () => openMelody().catch(fail));
  $('#ml-again').addEventListener('click', () => { try { melodyGenerate('all'); } catch (err) { fail(err); } });
  $('#ml-notes').addEventListener('click', () => { try { melodyGenerate('notes'); } catch (err) { fail(err); } });
  $('#ml-rhythm').addEventListener('click', () => { try { melodyGenerate('rhythm'); } catch (err) { fail(err); } });
  // Play / Say it loop the part being written (not whatever loop was set before); the old loop comes back when the dialog closes
  function melodyLoopOn() {
    const m = state.mel; if (!m) return null; const w = m.windows.find((x) => x.id === $('#ml-section').value) || (m.gen && m.gen.win); if (!w) return null;
    if (!m.prevLoop) m.prevLoop = { ...engine.loop };
    engine.setLoop({ enabled: true, start: w.w0, end: w.w1 }); $('#loop-on').checked = true; loopBarsFromEngine(); drawRuler();
    return w;
  }
  function melodyLoopOff(m) { if (m && m.prevLoop) { engine.setLoop(m.prevLoop); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); drawRuler(); m.prevLoop = null; } }
  $('#ml-play').addEventListener('click', async () => { const m = state.mel; if (!m) return; if (engine.playing) { await stop(); return; } const w = melodyLoopOn(); if (!w) return; engine.seek(w.w0); await play(); rollLive(); });
  $('#ml-say').addEventListener('click', () => sayMelody().catch(fail));
  $('#ml-star').addEventListener('click', () => {
    const m = state.mel; if (!m || !m.gen) return; const g = cloneGen(m.gen); m.kept.push(g); const n = m.kept.length;
    const b = el('button', null, `☆ ${n}: ${g.notes.slice(0, 5).map((x) => MU.noteName(x.n)).join(' ')}…`); b.type = 'button'; b.title = `A melody you kept earlier — click to bring it back into the editor (seed ${g.seed} · score ${g.score.toFixed(1)}; a higher score fits the words and chords better)`; b.addEventListener('click', () => { try { applyMelodyDraft(cloneGen(g)); } catch (err) { fail(err); } });
    $('#ml-kept').append(b);
  });

  // ---------- melody note editor: a small piano roll inside the melody dialog ----------
  // Edits the draft (state.mel.gen.notes) and writes it straight to the melody take, so ▶ Play hears it at once.
  // Each note keeps its syllable (l) and which lyric line it belongs to (_line, draft-only) so lyric placement / Say it still line up.
  const roll = { sel: -1, drag: null, hist: [], lo: 55, hi: 79, raf: 0, zoom: 7 };   // zoom: note editor px per 1/32
  // The roll serves two editors: the melody dialog and the note editor (any MIDI take). RC = whichever is in use.
  const RC_MEL = { cv: () => $('#ml-roll'), inkey: () => $('#ml-inkey'), undo: () => $('#ml-undo'), gen: () => state.mel && state.mel.gen, track: () => (state.mel && state.mel.trackId ? engine.track(state.mel.trackId) : melodyTrack(false)), commit: () => melRollCommit() };
  const RC_NED = { draw: true, grid: (pps) => ($('#ne-grid').value === 'auto' ? Math.min(engine.beatLen(), gridStep(pps, 6, 'auto')) : engine.beatLen() / (Number($('#ne-grid').value) || 8)), cv: () => $('#ne-roll'), inkey: () => $('#ne-inkey'), undo: () => $('#ne-undo'), gen: () => state.ned && state.ned.gen, track: () => state.ned && engine.track(state.ned.trackId), commit: () => nedCommit() };
  let RC = RC_MEL;
  const cloneGen = (g) => ({ ...g, notes: g.notes.map((x) => ({ ...x })), rhythm: g.rhythm.map((x) => ({ ...x })), pitches: g.pitches.slice() });
  const clipNotes = (notes) => notes.map((x) => { const o = { t: x.t, d: x.d, n: x.n, v: x.v == null ? 0.8 : x.v }; if (x.l) o.l = x.l; if (Array.isArray(x.iv) && x.iv.length) o.iv = x.iv.slice(); return o; });
  function rollFit() {
    const g = RC.gen(); const ns = g ? g.notes.flatMap((x) => [x.n, ...(x.iv || []).map((i) => x.n + i)]) : [];
    let lo = ns.length ? Math.min(...ns) - 4 : 55, hi = ns.length ? Math.max(...ns) + 4 : 76;
    if (hi - lo < 20) { const c = Math.round((hi + lo) / 2); lo = c - 10; hi = c + 10; }
    roll.lo = Math.max(24, lo); roll.hi = Math.min(100, hi);
    if (RC === RC_NED && g) {   // the note editor scrolls: every pitch E1..E7 at a fixed row height, time as wide as it needs
      roll.lo = 28; roll.hi = 100; const cv = RC.cv(), box = $('#ne-scroll');
      const W = g.win.w1 - g.win.w0, g32 = engine.beatLen() / 8;
      cv.style.height = `${14 + (roll.hi - roll.lo + 1) * 14}px`; cv.style.width = `${Math.max(box.clientWidth - 2, Math.ceil(W / g32) * (roll.zoom || 7) + 40)}px`;
      const mid = ns.length ? (Math.min(...ns) + Math.max(...ns)) / 2 : 52; requestAnimationFrame(() => { box.scrollTop = Math.max(0, 14 + (roll.hi - mid) * 14 - box.clientHeight / 2); });
    }
  }
  function rollGeom() {
    const cv = RC.cv(); const g = RC.gen(); if (!cv || !g) return null;
    const w = cv.clientWidth || 900, h = cv.clientHeight || 240, gut = 36, top = 14;
    const W = Math.max(0.5, g.win.w1 - g.win.w0), rows = roll.hi - roll.lo + 1, rowH = (h - top) / rows;
    const beatSec = beatLenAt(g.win.w0 + 1e-4), pps = (w - gut) / W, grid = RC.grid ? RC.grid(pps) * (beatSec / engine.beatLen()) : Math.min(beatSec, gridStep(pps, 8, 'auto') * (beatSec / engine.beatLen()));
    return { cv, g, w, h, gut, top, W, rowH, beatSec, grid, sc: MU.scaleOf(g.key || 'C'),
      xOf: (t) => gut + (t / W) * (w - gut), tOf: (x) => ((x - gut) / (w - gut)) * W,
      yOf: (n) => top + (roll.hi - n) * rowH, nOf: (y) => roll.hi - Math.floor((y - top) / rowH) };
  }
  const inKey = (G, n) => !G.sc || G.sc.pcs.includes(((n % 12) + 12) % 12);
  function keySnap(G, n, dir = 0) {
    if (!RC.inkey().checked || !G.sc || inKey(G, n)) return n;
    if (dir) { for (let k = 1; k < 3; k++) if (inKey(G, n + dir * k)) return n + dir * k; }
    return inKey(G, n - 1) ? n - 1 : n + 1;
  }
  function stepNote(G, n, dir) { if (!RC.inkey().checked || !G.sc) return n + dir; let x = n + dir; while (!inKey(G, x)) x += dir; return x; }
  function floorT(G, x) { const w0 = G.g.win.w0; const o = MT.segAt(meter(), w0 + 1e-4).t0; return o + Math.floor((w0 + G.tOf(x) - o) / G.grid + 1e-6) * G.grid - w0; }
  function snapT(G, t, alt) { if (alt) return t; const w0 = G.g.win.w0; const o = MT.segAt(meter(), w0 + 1e-4).t0; return o + Math.round((w0 + t - o) / G.grid) * G.grid - w0; }
  function drawRoll() {
    const cv = RC.cv(); if (!cv) return; cv.classList.toggle('empty', !RC.gen()); const G = rollGeom();   /* size first: geometry reads the canvas size */
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    if (!G) { c.fillStyle = '#8b91a0'; c.font = '12px system-ui, sans-serif'; c.fillText('Roll a melody (🎲 Again) — then drag its notes around here.', 12, 34); return; }
    const { g } = G; const flat = MU.isFlatKey(g.key || '');
    // rows: notes in the key are lighter, the key's root brighter; names in the gutter
    for (let n = roll.lo; n <= roll.hi; n++) {
      const y = G.yOf(n), pc = ((n % 12) + 12) % 12, root = G.sc && pc === G.sc.root;
      c.fillStyle = root ? '#2c3445' : inKey(G, n) ? '#20242c' : '#16181d'; c.fillRect(G.gut, y, w - G.gut, G.rowH);
      c.fillStyle = root ? '#e6e8ee' : inKey(G, n) ? '#aab0bd' : '#5d6370'; c.font = `${Math.min(11, Math.max(8, G.rowH - 1))}px system-ui, sans-serif`;
      if (G.rowH >= 8 || root || pc === 0) c.fillText(`${MU.noteName(pc, flat)}${pc === 0 || root ? Math.floor(n / 12) - 1 : ''}`, 3, y + G.rowH - 2);
    }
    // beat / bar lines (song bars), 16ths when there's room
    const w0 = g.win.w0, bar = barLenAt(g.win.w0 + 1e-4), sub = (G.grid / G.W) * (w - G.gut) >= 7;
    const o = MT.segAt(meter(), w0 + 1e-4).t0;   // the part's own bar 1 (parts can have their own tempo / meter)
    for (let k = Math.ceil((w0 - o) / G.grid - 1e-6); o + k * G.grid <= g.win.w1 + 1e-6; k++) {
      const at = o + k * G.grid, rel = at - o, x = G.xOf(at - w0), isBar = Math.abs(rel / bar - Math.round(rel / bar)) < 1e-4, isBeat = Math.abs(rel / G.beatSec - Math.round(rel / G.beatSec)) < 1e-4;
      if (!isBar && !isBeat && !sub) continue;
      c.fillStyle = isBar ? '#4a5160' : isBeat ? '#2e333d' : '#22262e'; c.fillRect(Math.round(x), G.top, 1, h - G.top);
      if (isBar) { c.fillStyle = '#8b91a0'; c.font = '10px system-ui, sans-serif'; c.fillText(String(Math.round(at / bar) + 1), x + 3, 10); }
    }
    // chords along the top (what the melody sits over)
    c.font = 'bold 10px system-ui, sans-serif'; c.fillStyle = '#e5b04b';
    for (const ch of liveChords()) if (ch.time >= w0 - 1e-6 && ch.time < g.win.w1) c.fillText(ch.chord, G.xOf(ch.time - w0) + 22, 10);
    // notes
    g.notes.forEach((x, i) => {
      const x0 = G.xOf(x.t), x1 = Math.max(x0 + 3, G.xOf(x.t + x.d)), y = G.yOf(x.n) + 1, hh = Math.max(3, G.rowH - 2), sel = i === roll.sel;
      if (x.iv && x.iv.length) {   // chord: the other tones as faint ghosts, the root block carries the name
        c.fillStyle = sel ? 'rgba(143,179,255,.35)' : 'rgba(91,141,239,.28)'; for (const iv of x.iv) if (iv) { const yy = G.yOf(x.n + iv) + 1; if (yy > G.top - 2 && yy < h) c.fillRect(x0, yy, x1 - x0, hh); }
        c.fillStyle = '#e5b04b'; c.font = 'bold 10px system-ui, sans-serif'; c.fillText(chordLabel(x, flat), x0 + 1, y - 2 < G.top + 8 ? y + hh + 9 : y - 2);
      }
      c.fillStyle = sel ? '#8fb3ff' : '#5b8def'; c.fillRect(x0, y, x1 - x0, hh);
      if (!inKey(G, x.n)) { c.strokeStyle = '#e5b04b'; c.lineWidth = 1.5; c.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, hh - 1); }
      if (sel) { c.fillStyle = '#ffffff'; c.fillRect(x1 - 3, y, 3, hh); }
      if (x.l) { c.fillStyle = '#e6e8ee'; c.font = '10px system-ui, sans-serif'; c.fillText(x.l, x0 + 1, y - 2 < G.top + 8 ? y + hh + 9 : y - 2); }
    });
    if (engine.playing && engine.playhead >= w0 && engine.playhead <= g.win.w1) { c.fillStyle = '#e04b4b'; c.fillRect(G.xOf(engine.playhead - w0), G.top, 1.5, h - G.top); }
  }
  function rollTick() { roll.raf = 0; if (!RC.gen()) return; drawRoll(); if (engine.playing) roll.raf = requestAnimationFrame(rollTick); }
  function rollLive() { if (!roll.raf) roll.raf = requestAnimationFrame(rollTick); }
  function hearNote(n, l, iv) { const t = RC.track(); if (t) { engine.init().then(() => { for (const i of (iv && iv.length ? iv : [0])) engine.playNote(t.id, n + i, 0.8, 0.35, l ? { syl: l } : undefined); }).catch(() => {}); } }
  function rollPush() { const g = RC.gen(); roll.hist.push(g.notes.map((x) => ({ ...x, ...(x.iv ? { iv: x.iv.slice() } : {}) }))); if (roll.hist.length > 100) roll.hist.shift(); RC.undo().disabled = false; }
  // the draft changed: re-sort, re-derive rhythm/pitches (so New notes / New rhythm build on the edit), write it to the take
  function rollCommit() {
    const g = RC.gen(); if (!g) return;
    const selNote = g.notes[roll.sel]; g.notes.sort((a, b) => a.t - b.t); roll.sel = selNote ? g.notes.indexOf(selNote) : -1;
    RC.commit();
  }
  function melRollCommit() {
    const m = state.mel, g = m && m.gen; if (!g) return;
    g.rhythm = g.notes.map((x, i) => ({ line: x._line || 0, i, beat: x.t / roll.beatSec(), dur: x.d / roll.beatSec() / 0.92 })); g.pitches = g.notes.map((x) => x.n); g.edited = true;
    const did = change(() => { for (const t of engine.tracks) { const c = t.clips.find((y) => y.id === m.clipId); if (c) c.notes = clipNotes(g.notes); } }, { label: 'edited the melody', undoable: !m.editUndo, activity: !m.editUndo });
    if (did) { m.editUndo = true; m.touched = true; }
    renderAll(); drawRoll();
    const info = $('#ml-info'); if (!/· edited$/.test(info.textContent)) info.textContent += ' · edited';
  }
  roll.beatSec = () => engine.beatLen();
  function rollHit(G, x, y) {
    const n = G.nOf(y); let best = -1;
    G.g.notes.forEach((z, i) => { if (z.n === n && x >= G.xOf(z.t) - 2 && x <= Math.max(G.xOf(z.t) + 3, G.xOf(z.t + z.d)) + 2) best = i; });
    return best;
  }
  const rollPos = (e) => { const r = RC.cv().getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function attachRoll(cvEl, ctx) {
  const use = () => { RC = ctx; };
  cvEl.addEventListener('pointerdown', (e) => {
    use();
    const G = rollGeom(); if (!G || e.button !== 0) return; RC.cv().focus();
    const [x, y] = rollPos(e); const i = rollHit(G, x, y); roll.sel = i;
    if (i >= 0) {
      let z = G.g.notes[i]; const edge = G.xOf(z.t + z.d) - x <= 6 && G.xOf(z.t + z.d) - G.xOf(z.t) > 10;
      let pushed = false;
      if (e.shiftKey && !edge) { rollPush(); pushed = true; const cp = { ...z, ...(z.iv ? { iv: z.iv.slice() } : {}) }; G.g.notes.push(cp); roll.sel = G.g.notes.length - 1; z = cp; }   // Shift-drag: drag a copy
      roll.drag = { mode: edge ? 'len' : 'move', x, y, t: z.t, d: z.d, n: z.n, note: z, pushed, moved: false };
      try { RC.cv().setPointerCapture(e.pointerId); } catch (_) {} hearNote(z.n, z.l, z.iv);
    } else if (RC.draw && x > G.gut && y > G.top) {   // note editor: click-drag on empty space draws a note
      rollPush(); const t0 = Math.max(0, Math.min(G.W - G.grid, floorT(G, x)));
      const z = { t: t0, d: G.grid, n: keySnap(G, G.nOf(y), 0), v: 0.8 }; G.g.notes.push(z); roll.sel = G.g.notes.length - 1;
      roll.drag = { mode: 'len', x, y, t: z.t, d: z.d, n: z.n, note: z, pushed: true, moved: true }; hearNote(z.n);
      try { RC.cv().setPointerCapture(e.pointerId); } catch (_) {}
    }
    drawRoll();
  });
  cvEl.addEventListener('pointermove', (e) => {
    use();
    const G = rollGeom(); if (!G) return; const [x, y] = rollPos(e); const dr = roll.drag;
    if (!dr) { const i = rollHit(G, x, y); const z = i >= 0 ? G.g.notes[i] : null; RC.cv().style.cursor = z ? (G.xOf(z.t + z.d) - x <= 6 && G.xOf(z.t + z.d) - G.xOf(z.t) > 10 ? 'ew-resize' : 'grab') : 'default'; return; }
    const dt = ((x - dr.x) / (G.w - G.gut)) * G.W, z = dr.note;
    if (!dr.moved && Math.abs(x - dr.x) < 3 && Math.abs(y - dr.y) < 3) return;
    if (!dr.pushed) { rollPush(); dr.pushed = true; } dr.moved = true;
    if (dr.mode === 'move') {
      z.t = Math.max(0, Math.min(G.W - Math.min(z.d, G.grid), snapT(G, dr.t + dt, e.altKey)));
      const raw = Math.max(roll.lo, Math.min(roll.hi, dr.n + Math.round((dr.y - y) / G.rowH)));
      let nn = keySnap(G, raw, Math.sign(raw - z.n)); if (nn > roll.hi) nn = keySnap(G, roll.hi, -1); if (nn < roll.lo) nn = keySnap(G, roll.lo, 1); if (nn !== z.n) { z.n = nn; hearNote(nn, z.l); }
      z.d = Math.min(z.d, G.W - z.t);
    } else {
      const end = Math.min(G.W, snapT(G, dr.t + dr.d + dt, e.altKey)); z.d = Math.max(e.altKey ? 0.03 : G.grid, end - z.t);
    }
    drawRoll();
  });
  const rollUp = () => { const dr = roll.drag; roll.drag = null; if (dr && dr.moved) rollCommit(); };
  cvEl.addEventListener('pointerup', () => { use(); rollUp(); }); cvEl.addEventListener('pointercancel', () => { use(); rollUp(); });
  cvEl.addEventListener('dblclick', (e) => {
    use();
    const G = rollGeom(); if (!G) return; const [x, y] = rollPos(e); const i = rollHit(G, x, y);
    rollPush();
    if (i >= 0) { G.g.notes.splice(i, 1); roll.sel = -1; }
    else {
      if (x < G.gut || y < G.top || RC.draw) { roll.hist.pop(); return; }
      const t = Math.max(0, Math.min(G.W - G.grid, floorT(G, x)));
      const prev = G.g.notes.filter((z) => z.t <= t).pop() || G.g.notes[0];
      const z = { t, d: Math.min(G.beatSec / 2, G.W - t), n: keySnap(G, G.nOf(y), 0), v: 0.75, l: '', _line: prev ? prev._line || 0 : 0 };
      G.g.notes.push(z); roll.sel = G.g.notes.length - 1; hearNote(z.n);
    }
    rollCommit();
  });
  cvEl.addEventListener('keydown', (e) => {
    use();
    const G = rollGeom(); if (!G) return; const z = G.g.notes[roll.sel];
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); rollUndo(); return; }
    if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); (RC === RC_NED ? $('#ne-play') : $('#ml-play')).click(); return; }
    if (!z) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); e.stopPropagation(); dupNote(G, roll.sel); return; }
    let hit = true;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { rollPush(); const dir = e.key === 'ArrowUp' ? 1 : -1; z.n = Math.max(21, Math.min(108, e.shiftKey ? z.n + 12 * dir : stepNote(G, z.n, dir))); if (z.n > roll.hi || z.n < roll.lo) rollFit(); hearNote(z.n, z.l); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { rollPush(); z.t = Math.max(0, Math.min(G.W - z.d, z.t + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? G.beatSec : G.grid))); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { rollPush(); G.g.notes.splice(roll.sel, 1); roll.sel = -1; }
    else hit = false;
    if (hit) { e.preventDefault(); e.stopPropagation(); rollCommit(); }
  });
  cvEl.addEventListener('contextmenu', (e) => {
    use(); e.preventDefault(); const G = rollGeom(); if (!G) return; const [x, y] = rollPos(e); const i = rollHit(G, x, y); if (i < 0) return;
    roll.sel = i; drawRoll(); const z = G.g.notes[i]; const flat = MU.isFlatKey(G.g.key || '');
    M.show(e.clientX, e.clientY, chordMenu(G, z, flat));
  });
  }
  // ---- chord notes: one block (the root) that plays a whole chord; right-click it to pick what it plays ----
  const CHORD_TYPES = [
    ['', 'single note', [0]], ['5', 'power chord (root + 5th)', [0, 7]], ['5(8)', 'power chord + octave', [0, 7, 12]], ['oct', 'octave', [0, 12]],
    ['maj', 'major', [0, 4, 7]], ['m', 'minor', [0, 3, 7]], ['dim', 'diminished', [0, 3, 6]], ['aug', 'augmented', [0, 4, 8]],
    ['sus2', 'sus2', [0, 2, 7]], ['sus4', 'sus4', [0, 5, 7]], ['6', '6', [0, 4, 7, 9]], ['m6', 'minor 6', [0, 3, 7, 9]],
    ['7', '7 (dominant)', [0, 4, 7, 10]], ['maj7', 'major 7', [0, 4, 7, 11]], ['m7', 'minor 7', [0, 3, 7, 10]], ['m7b5', 'half-diminished (m7♭5)', [0, 3, 6, 10]],
    ['dim7', 'diminished 7', [0, 3, 6, 9]], ['mMaj7', 'minor-major 7', [0, 3, 7, 11]], ['7sus4', '7sus4', [0, 5, 7, 10]], ['add9', 'add9', [0, 4, 7, 14]],
    ['madd9', 'minor add9', [0, 3, 7, 14]], ['6/9', '6/9', [0, 4, 7, 9, 14]], ['9', '9', [0, 4, 7, 10, 14]], ['maj9', 'major 9', [0, 4, 7, 11, 14]],
    ['m9', 'minor 9', [0, 3, 7, 10, 14]], ['7b9', '7♭9', [0, 4, 7, 10, 13]], ['7#9', '7♯9 (Hendrix)', [0, 4, 7, 10, 15]], ['11', '11', [0, 4, 7, 10, 14, 17]],
    ['m11', 'minor 11', [0, 3, 7, 10, 14, 17]], ['13', '13', [0, 4, 7, 10, 14, 21]], ['maj13', 'major 13', [0, 4, 7, 11, 14, 21]],
  ];
  const ivKey = (iv) => (iv && iv.length ? iv.join(',') : '0');
  function chordLabel(z, flat) {
    const root = MU.noteName(((z.n % 12) + 12) % 12, flat); const iv = z.iv && z.iv.length ? z.iv : [0];
    const ct = CHORD_TYPES.find((c) => ivKey(c[2]) === ivKey(iv)); if (ct) return ct[0] === 'maj' ? root : ct[0] === '' ? root : `${root}${ct[0] === 'oct' ? ' oct' : ct[0]}`;
    return `${root}(${iv.filter(Boolean).map((i) => `+${i}`).join('')})`;
  }
  // diatonic interval above the root inside the key (3rd = 2 scale steps, 5th = 4, …)
  function inKeyInterval(G, n, steps) { if (!G.sc) return [0, 2, 4, 5, 7, 9, 11, 12, 14][steps] || 0; const pcs = [...G.sc.pcs].sort((a, b) => a - b); const pc = ((n % 12) + 12) % 12; let idx = pcs.indexOf(pc); if (idx < 0) { idx = pcs.findIndex((p) => p > pc); if (idx < 0) idx = 0; } const target = pcs[(idx + steps) % 7] + 12 * Math.floor((idx + steps) / 7); return target - pcs[idx] + (pcs[idx] - pc); }
  // duplicate a note (chord and all) right after itself — Ctrl+D again keeps stamping copies along
  function dupNote(G, i) {
    const z = G.g.notes[i]; if (!z) return; const w0 = G.g.win.w0;
    // on the grid: the first grid line at/after the note's end (a staccato 8th repeats on the next 8th, not mid-gap)
    const step = Math.max(G.grid, Math.ceil(z.d / G.grid - 1e-6) * G.grid); let t = Math.ceil((w0 + z.t + z.d) / G.grid - 1e-6) * G.grid - w0;
    if (t - z.t < step - 1e-6) t = z.t + step;
    if (t > G.W - 0.01) { status('No room after that note inside this part.'); return; }
    rollPush(); const cp = { ...z, ...(z.iv ? { iv: z.iv.slice() } : {}), t, d: Math.min(z.d, G.W - t) }; G.g.notes.push(cp); roll.sel = G.g.notes.length - 1; hearNote(cp.n, cp.l, cp.iv); rollCommit();
  }
  function chordMenu(G, z, flat) {
    const setIv = (iv, label) => { rollPush(); const clean = [...new Set(iv)].sort((a, b) => a - b); if (clean.length <= 1 && !clean[0]) delete z.iv; else z.iv = clean; hearNote(z.n, z.l, z.iv); rollCommit(); status(label ? `${chordLabel(z, flat)} — ${label}` : chordLabel(z, flat)); };
    const cur = z.iv && z.iv.length ? z.iv : [0];
    const has = (i) => cur.includes(i);
    const third = inKeyInterval(G, z.n, 2), fifth = inKeyInterval(G, z.n, 4);
    const tones = cur.map((i) => MU.noteName((((z.n + i) % 12) + 12) % 12, flat)).join(' · ');
    return [
      { title: `${chordLabel(z, flat)}  —  ${tones}` },
      { label: 'Duplicate (right after)', hint: `${MOD}+D`, action: () => dupNote(G, G.g.notes.indexOf(z)) },
      'sep',
      { label: 'Power chord (root + 5th)', checked: ivKey(cur) === '0,7', action: () => setIv([0, 7]) },
      { label: 'Add 5th', action: () => setIv([...cur, 7]), disabled: has(7) },
      { label: `Add 3rd (in key: ${third === 3 ? 'minor' : third === 4 ? 'major' : `+${third}`})`, action: () => setIv([...cur, third]), disabled: has(third) },
      { label: 'Add octave', action: () => setIv([...cur, 12]), disabled: has(12) },
      { label: `Triad in key (${third === 3 && fifth === 7 ? 'minor' : third === 4 && fifth === 7 ? 'major' : third === 3 && fifth === 6 ? 'diminished' : 'in key'})`, action: () => setIv([0, third, fifth]) },
      { label: 'Harmony a 3rd above (in key)', action: () => setIv([0, third]) },
      { label: 'Harmony a 6th below (in key)', action: () => setIv([0, inKeyInterval(G, z.n, 2) - 12]) },
      { label: 'Chord type', sub: CHORD_TYPES.map(([id, name, iv]) => ({ label: `${chordLabel({ n: z.n, iv }, flat)}  ${name}`, checked: ivKey(cur) === ivKey(iv), action: () => setIv(iv) })) },
      'sep',
      { label: 'Back to a single note', action: () => setIv([0]), disabled: cur.length <= 1 },
      { label: 'Split into separate notes', action: () => { rollPush(); const g = G.g; for (const i of cur) if (i) g.notes.push({ ...z, n: z.n + i, iv: undefined }); delete z.iv; rollCommit(); }, disabled: cur.length <= 1 },
    ];
  }
  attachRoll($('#ml-roll'), RC_MEL);
  function rollUndo() { const g = RC.gen(); if (!g || !roll.hist.length) return; g.notes = roll.hist.pop(); roll.sel = -1; RC.undo().disabled = !roll.hist.length; rollCommit(); }
  $('#ml-undo').addEventListener('click', () => { RC = RC_MEL; rollUndo(); });
  $('#ml-inkey').addEventListener('change', () => { RC = RC_MEL; drawRoll(); });
  window.addEventListener('resize', () => { if (RC.gen()) drawRoll(); });
  // a new draft (rolled, kept one brought back, or the existing take loaded): fresh editor
  function rollReset() { roll.sel = -1; roll.drag = null; roll.hist = []; const u = RC.undo(); if (u) u.disabled = true; rollFit(); drawRoll(); }

  // ---------- note editor: any MIDI take (synth bass, keys, guitar-synth, guide voice) in the piano roll ----------
  state.ned = null;
  function nedCommit() {
    const n = state.ned; if (!n) return;
    const did = change(() => {
      let f = n.clipId && findClip(n.clipId);
      if (!f) { const t = engine.track(n.trackId); if (!t) return; const c = { id: newId(), kind: 'midi', name: n.name, start: n.gen.win.w0, duration: n.gen.win.w1 - n.gen.win.w0, trimStart: 0, trimEnd: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, mute: false, takenBy: me(), takenAt: nowIso(), notes: [] }; t.clips.push(c); n.clipId = c.id; n.created = true; f = { t, c }; }
      f.c.notes = clipNotes(n.gen.notes.map((x) => ({ ...x, t: x.t + n.trim })));
    }, { label: `edited notes of ${n.name}`, undoable: !n.editUndo, activity: !n.editUndo });
    if (did) { n.editUndo = true; n.touched = true; }
    renderAll(); drawRoll(); engine.refreshTrack(n.trackId);
  }
  // window for drawing on an empty MIDI lane: the loop if it's on, else the section under the click, else 4 bars
  function drawWindowAt(sec) {
    if (engine.loop.enabled && engine.loop.end > engine.loop.start + 0.1) return { w0: engine.loop.start, w1: engine.loop.end };
    const sc = liveSections().find((x) => sec >= x.start - 1e-6 && sec < x.end); if (sc) return { w0: sc.start, w1: sc.end };
    const a = floorBar(sec); return { w0: a, w1: barSec(barIdx(a) + 4) };
  }
  async function openNoteEditor(t0, c0, at = null, forceWin = null) {
    if (ro()) { status('Read-only — take over first.'); return; }
    if (state.ab) await leaveAB({ silent: true });
    let t, c = null;
    if (c0) { const f = findClip(c0.id); if (!f) return; t = f.t; c = f.c; } else { t = engine.track(t0.id); if (!t) return; const w = forceWin || drawWindowAt(at == null ? engine.playhead : at); c = t.clips.find((x) => x.kind === 'midi' && !x.link && x.start < w.w1 - 1e-6 && x.start + engine.clipLength(x) > w.w0 + 1e-6) || null; if (!c) c = { _new: true, start: w.w0, len: w.w1 - w.w0 }; }
    const fresh = !!c._new; const len = fresh ? c.len : engine.clipLength(c); const trim = fresh ? 0 : (c.trimStart || 0);
    const notes = fresh ? [] : (c.notes || []).filter((x) => x.t >= trim - 1e-6 && x.t < trim + len).map((x) => ({ ...x, t: x.t - trim, ...(x.iv ? { iv: x.iv.slice() } : {}) }));
    const name = fresh ? `notes ${barOf(c.start)}–${endBarNo(c.start + len)}` : c.name;
    state.ned = { clipId: fresh ? null : c.id, trackId: t.id, name, trim, orig: fresh ? null : JSON.parse(JSON.stringify(c.notes || [])), undoLen: state.undo.length, gen: { notes, win: { id: 'clip', w0: c.start, w1: c.start + len }, key: keyAt(c.start + 0.01) || songKeyOrGuess() || 'C' } };
    $('#ne-title').textContent = `${name} — ${t.name}`; $('#rf-low').value = /bass/.test(t.instrument) || t.type === 'bass' ? '28' : t.instrument === 'synth:voice' ? '52' : /gtr|acoustic/.test(t.instrument) || t.type === 'guitar' ? '40' : '52'; $('#rf-power').checked = /distgtr|mutegtr|crunchgtr/.test(t.instrument); $('#ne-info').textContent = `${notes.length} notes · key ${state.ned.gen.key} · right-click a note for chords · Ctrl+D or Shift-drag duplicates · Ctrl+wheel zooms`;
    { // which part of the song to write in: any section, the whole song, or the loop — switching keeps what you did here
      const ps = $('#ne-part'); ps.innerHTML = ''; const b = barLen(); const endBar = Math.max(1, Math.ceil(barIdx(Math.max(engine.arrangementEnd || 0, engine.songLength(), b * 4)) - 0.02));
      const opts = [...liveSections().slice().sort((x, y) => x.start - y.start).map((x) => ({ id: x.id, label: `${x.name} (bars ${barOf(x.start)}–${endBarNo(x.end)})`, w0: x.start, w1: x.end })), { id: 'song', label: `Whole song (bars 1–${endBar})`, w0: 0, w1: barSec(endBar) }];
      if (engine.loop.enabled && engine.loop.end > engine.loop.start + 0.1) opts.push({ id: 'loop', label: `Loop (bars ${barOf(engine.loop.start)}–${endBarNo(engine.loop.end)})`, w0: engine.loop.start, w1: engine.loop.end });
      const cur = { w0: c.start, w1: c.start + len }; let hit = opts.find((o) => Math.abs(o.w0 - cur.w0) < 1e-3 && Math.abs(o.w1 - cur.w1) < 1e-3);
      if (!hit) { hit = { id: 'here', label: `bars ${barOf(cur.w0)}–${endBarNo(cur.w1)}`, ...cur }; opts.unshift(hit); }
      for (const o of opts) { const op = el('option', null, o.label); op.value = o.id; ps.append(op); } ps.value = hit.id;
      ps.onchange = () => { const o = opts.find((x) => x.id === ps.value); if (!o) return; $('#noteed').returnValue = 'ok'; state.nedSwitch = o; $('#noteed').close('ok'); };
    }
    RC = RC_NED; const d = $('#noteed'); d.returnValue = ''; d.showModal(); rollReset();
    const ok = await new Promise((res) => d.addEventListener('close', function h() { d.removeEventListener('close', h); res(d.returnValue === 'ok'); }));
    if (engine.playing) await stop();
    const n = state.ned; state.ned = null; if (n && n.prevLoop) { engine.setLoop(n.prevLoop); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); drawRuler(); }
    RC = RC_MEL;
    if (n) engine.refreshTrack(n.trackId);
    if (state.nedSwitch) { const o = state.nedSwitch; state.nedSwitch = null; renderAll(); const tt = engine.track(t.id); if (tt) setTimeout(() => openNoteEditor(tt, null, o.w0, o).catch(fail), 0); return; }
    if (!n || !n.touched || ok) return;
    change(() => { const ff = n.clipId && findClip(n.clipId); if (!ff) return; if (n.created) ff.t.clips = ff.t.clips.filter((x) => x !== ff.c); else ff.c.notes = n.orig; }, { label: 'note edits cancelled', undoable: false, activity: false });
    if (state.undo.length > n.undoLen) state.undo.length = n.undoLen; state.redo = []; updateUndoButtons();
    state.pendingActivity = state.pendingActivity.filter((a) => !/^edited notes of /.test(a)); renderAll();
  }
  $('#ne-undo').addEventListener('click', () => { RC = RC_NED; rollUndo(); });
  $('#ne-inkey').addEventListener('change', () => { RC = RC_NED; drawRoll(); });
  $('#ne-play').addEventListener('click', async () => { const n = state.ned; if (!n) return; if (engine.playing) { await stop(); return; } if (!n.prevLoop) n.prevLoop = { ...engine.loop }; engine.setLoop({ enabled: true, start: n.gen.win.w0, end: n.gen.win.w1 }); $('#loop-on').checked = true; loopBarsFromEngine(); drawRuler(); engine.seek(n.gen.win.w0); await play(); RC = RC_NED; rollLive(); });
  attachRoll($('#ne-roll'), RC_NED);
  $('#ne-grid').addEventListener('change', () => { RC = RC_NED; drawRoll(); });
  // Ctrl+wheel in the note editor zooms time; with snap on "auto" the grid follows (1/4 → 1/8 → 1/16 → 1/32)
  $('#ne-scroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); RC = RC_NED;
    const box = $('#ne-scroll'), cv = $('#ne-roll'); const r = cv.getBoundingClientRect(); const frac = (e.clientX - r.left) / Math.max(1, r.width);
    roll.zoom = Math.min(40, Math.max(1.5, roll.zoom * (e.deltaY < 0 ? 1.2 : 0.83)));
    const sTop = box.scrollTop; rollFit(); box.scrollTop = sTop; drawRoll();
    const nr = cv.getBoundingClientRect(); box.scrollLeft = Math.max(0, frac * nr.width - (e.clientX - box.getBoundingClientRect().left));
    const G = rollGeom(); if (G) $('#ne-snapnow') && ($('#ne-snapnow').textContent = $('#ne-grid').value === 'auto' ? `(${gridLabel(G.grid)})` : '');
  }, { passive: false });
  function nedRiff(mode) {
    const n = state.ned; if (!n) return; RC = RC_NED; rollPush();
    const w = n.gen.win; const prev = n.riff;
    const opts = { seconds: w.w1 - w.w0, bpm: meterAt(w.w0 + 1e-4).bpm, timeSig: meterAt(w.w0 + 1e-4).timeSig, rate: Number($('#rf-rate').value), notes: (() => { const v = Math.max(1, Math.min(7, Math.round(Number($('#rf-count').value) || 3))); $('#rf-count').value = v; return v; })(), key: n.gen.key,
      low: Number($('#rf-low').value), density: Number($('#rf-density').value), sync: Number($('#rf-sync').value), gate: Number($('#rf-gate').value), power: $('#rf-power').checked,
      follow: $('#rf-follow').checked ? (sec) => { const ch = CB.chordAt(state.song, w.w0 + sec); return ch && !ch.deleted ? ch.chord : null; } : null };
    if (mode === 'notes' && prev && prev.opts.rate === opts.rate) opts.rhythm = prev.rhythm;
    if (mode === 'rhythm' && prev) opts.pitches = prev.pitches;
    const g = window.BPRiff.generate(opts);
    n.riff = { rhythm: g.rhythm, pitches: g.pitches, opts }; n.gen.notes = g.notes.map((x) => ({ ...x }));
    roll.sel = -1; rollFit(); rollCommit();
    $('#ne-info').textContent = `riff: ${g.notes.length} notes · ${$('#rf-rate').selectedOptions[0].textContent} · ${opts.notes} different note${opts.notes > 1 ? 's' : ''} · key ${n.gen.key}${opts.follow ? ' · following the chords' : ''} · seed ${g.seed} — drag / right-click notes to change it`;
  }
  $('#rf-roll').addEventListener('click', () => { try { nedRiff('all'); } catch (err) { fail(err); } });
  $('#rf-notes').addEventListener('click', () => { try { nedRiff('notes'); } catch (err) { fail(err); } });
  $('#rf-rhythm').addEventListener('click', () => { try { nedRiff('rhythm'); } catch (err) { fail(err); } });

  // ---------- drum editor + generator ----------
  // A drum part = a MIDI clip (GM notes) on the drum-machine track covering one section; it replaces the track's groove
  // there. The editor shows every 1/16 (or triplet) step of the section, one row per drum; rows can be filled in one go.
  const DR = window.BPDrums;
  state.dr = null;
  function drumTrack(create = true) {
    let t = engine.tracks.find((x) => x.instrument === 'drumkit');
    if (!t && create) { t = engine.addTrack('Drums'); engine.updateTrack(t.id, { type: 'drums', instrument: 'drumkit', drum: { ...window.BPEngine.DEFAULT_DRUM(), bars: 0 } }); }
    return t;
  }
  const drumClipAt = (t, w) => t && t.clips.find((c) => c.kind === 'midi' && !c.link && Math.abs(c.start - w.w0) < 1e-3);
  function drGeom() {
    const d = state.dr; if (!d) return null;
    const per = Number($('#dr-grid').value) || 4, beat = beatLenAt(d.win.w0 + 1e-4), stepT = beat / per, W = d.win.w1 - d.win.w0;
    const steps = Math.max(1, Math.round(W / stepT)); const cell = Math.max(10, Math.min(26, Math.floor(1000 / Math.min(steps, 64))));
    return { per, beat, stepT, W, steps, cell, rowH: 28, top: 18, bpb: meterAt(d.win.w0 + 1e-4).timeSig[0] };
  }
  const drHitAt = (d, voice, t0, t1) => d.hits.findIndex((h) => h.voice === voice && h.t >= t0 - 1e-6 && h.t < t1 - 1e-6);
  function drDraw() {
    const d = state.dr; const cv = $('#dr-canvas'); const G = drGeom(); if (!d || !G) return;
    const w = G.steps * G.cell, h = G.top + DR.VOICES.length * G.rowH, dpr = window.devicePixelRatio || 1;
    cv.style.width = `${w}px`; cv.style.height = `${h}px`; if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const stepsPerBar = G.per * G.bpb;
    for (let i = 0; i < G.steps; i++) {
      const x = i * G.cell, bar = i % stepsPerBar === 0, beat = i % G.per === 0;
      for (let r = 0; r < DR.VOICES.length; r++) { c.fillStyle = Math.floor(i / G.per) % 2 ? '#1b1e25' : '#20242c'; c.fillRect(x + 1, G.top + r * G.rowH + 1, G.cell - 2, G.rowH - 2); }
      if (bar) { c.fillStyle = '#8b91a0'; c.font = '10px system-ui, sans-serif'; c.fillText(String(barOf(d.win.w0 + i * G.stepT + 1e-4)), x + 3, 12); c.fillStyle = '#4a5160'; c.fillRect(x, G.top, 1, h - G.top); }
      else if (beat) { c.fillStyle = '#30353f'; c.fillRect(x, G.top, 1, h - G.top); }
    }
    for (const hit of d.hits) {
      const r = DR.VOICES.findIndex((v) => v.id === hit.voice); if (r < 0) continue;
      const x = (hit.t / G.stepT) * G.cell, y = G.top + r * G.rowH;
      c.fillStyle = hit.vel >= 0.95 ? '#ff9f43' : hit.vel < 0.5 ? '#3d5a96' : '#5b8def';
      c.fillRect(x + 2, y + 4, Math.max(4, G.cell - 4), G.rowH - 8);
    }
    if (engine.playing && engine.playhead >= d.win.w0 && engine.playhead < d.win.w1) { c.fillStyle = '#e04b4b'; c.fillRect(((engine.playhead - d.win.w0) / G.stepT) * G.cell, G.top, 2, h - G.top); }
    $('#dr-undo').disabled = !d.hist.length;
    $('#dr-info').textContent = `${d.hits.length} hits · ${Math.round(barIdx(d.win.w0 + G.W) - barIdx(d.win.w0))} bars${d.gen ? ` · ${DR.STYLES[d.gen.style] ? DR.STYLES[d.gen.style].name : d.gen.style} seed ${d.gen.seed}` : ''}`;
  }
  function drRows() {
    const box = $('#dr-rows'); box.innerHTML = '';
    for (const v of DR.VOICES) {
      const row = el('div', 'dr-row'); const fill = el('button', null, 'fill ▾'); fill.type = 'button'; fill.title = `Fill the whole part with ${v.name}`;
      fill.addEventListener('click', (e) => { const r = fill.getBoundingClientRect(); M.show(r.left, r.bottom, [{ title: `${v.name}: fill the whole part` }, ...DR.FILLS.map((f) => ({ label: f.label, action: () => drFill(v.id, f.id) }))]); e.preventDefault(); });
      row.append(el('span', null, v.name), fill); box.append(row);
    }
  }
  function drPush() { const d = state.dr; d.hist.push(d.hits.map((h) => ({ ...h }))); if (d.hist.length > 100) d.hist.shift(); }
  // write the hits into the drum clip of this part (creating the track / clip on the first edit)
  function drCommit() {
    const d = state.dr; if (!d) return;
    d.hits.sort((a, b) => a.t - b.t);
    const first = !d.edited.has(d.win.id);
    const did = change(() => {
      if (!drumTrack(false)) d.madeTrack = true;
      const t = drumTrack(true); d.trackId = t.id;
      let c = drumClipAt(t, d.win);
      if (!c) { c = { id: newId(), kind: 'midi', name: `drums · ${d.win.label.replace(/ \(.*$/, '')}`, start: d.win.w0, duration: d.win.w1 - d.win.w0, trimStart: 0, trimEnd: 0, gainDb: 0, fadeIn: 0, fadeOut: 0, mute: false, takenBy: me(), takenAt: nowIso(), notes: [] }; t.clips.push(c); if (!(c.id in d.orig)) d.orig[c.id] = null; }
      else if (!(c.id in d.orig)) d.orig[c.id] = JSON.parse(JSON.stringify(c.notes || []));
      c.duration = d.win.w1 - d.win.w0; c.notes = DR.toNotes(d.hits);
    }, { label: `drums for ${d.win.label.replace(/ \(.*$/, '')}`, undoable: first, activity: first });
    if (did) { d.edited.add(d.win.id); d.touched = true; }
    renderAll(); drDraw(); if (d.trackId) engine.refreshTrack(d.trackId);
  }
  function drFill(voice, fillId) {
    const d = state.dr; if (!d) return; drPush();
    const G = drGeom(); d.hits = d.hits.filter((h) => h.voice !== voice);
    for (const t of DR.fillTimes(fillId, { seconds: G.W, beatSec: G.beat, beatsPerBar: G.bpb })) d.hits.push({ t, voice, vel: voice === 'crash' ? 1 : 0.8 });
    drCommit();
  }
  function drLoad() {
    const d = state.dr; const w = d.windows.find((x) => x.id === $('#dr-section').value) || d.windows[0]; d.win = w; d.hist = []; d.gen = null;
    const c = drumClipAt(drumTrack(false), w);
    d.hits = c ? DR.fromNotes(c.notes).filter((h) => h.t < w.w1 - w.w0) : [];
    drDraw(); $('#dr-scroll').scrollLeft = 0;
  }
  function drGenerate() {
    const d = state.dr; if (!d) return; drPush();
    const seed = (Math.random() * 2 ** 32) >>> 0; const style = $('#dr-style').value;
    d.hits = DR.generate({ seconds: d.win.w1 - d.win.w0, bpm: meterAt(d.win.w0 + 1e-4).bpm, timeSig: meterAt(d.win.w0 + 1e-4).timeSig, style, sectionType: d.win.type, intensity: $('#dr-feel').value, seed });
    drCommit(); d.gen = { style, seed }; drDraw();
  }
  async function openDrums(winId = null) {
    if (!state.folder) return; if (ro()) { status('Read-only — take over first.'); return; }
    if (state.ab) await leaveAB({ silent: true });
    const windows = melodyWindowOptions();
    { const b = barLen(); const end = Math.max(engine.arrangementEnd || 0, engine.songLength(), b * 8); const nb = Math.max(1, Math.ceil(barIdx(end) - 0.02));   /* a ring-out a hair past the last bar isn't a whole extra bar */ windows.push({ id: 'song', label: `Whole song (bars 1–${nb})`, w0: 0, w1: barSec(nb), type: '' }); }
    const loopOn = engine.loop.enabled && engine.loop.end > engine.loop.start + 0.1;
    const here = windows.find((x) => x.id === winId) || (loopOn && windows.find((x) => Math.abs(x.w0 - engine.loop.start) < 1e-3 && Math.abs(x.w1 - engine.loop.end) < 1e-3)) || (loopOn && windows.find((x) => x.id === 'loop')) || windows.find((x) => x.type && engine.playhead >= x.w0 - 1e-6 && engine.playhead < x.w1) || windows.find((x) => engine.playhead >= x.w0 - 1e-6 && engine.playhead < x.w1) || windows[0];
    state.dr = { windows, win: here, hits: [], hist: [], orig: {}, edited: new Set(), undoLen: state.undo.length, touched: false };
    const sel = $('#dr-section'); sel.innerHTML = ''; for (const w of windows) { const o = el('option', null, w.label); o.value = w.id; sel.append(o); } sel.value = here.id;
    const ss = $('#dr-style'); if (!ss.options.length) for (const id of DR.STYLE_IDS) { const o = el('option', null, DR.STYLES[id].name); o.value = id; ss.append(o); }
    ss.value = DR.styleFor(state.song.style || '');
    drRows(); sel.onchange = async () => { drLoad(); if (engine.playing) { await stop(); drLoopOn(); engine.seek(state.dr.win.w0); await play(); drLive(); } };
    $('#dr-grid').onchange = drDraw;
    const dlg = $('#drumed'); dlg.returnValue = ''; dlg.showModal(); drLoad();
    if (!state.dr.hits.length) $('#dr-info').textContent = 'Empty part — 🎲 Generate writes one, or click squares / use a row\'s fill menu.';
    const ok = await new Promise((res) => dlg.addEventListener('close', function h() { dlg.removeEventListener('close', h); res(dlg.returnValue === 'ok'); }));
    if (engine.playing) await stop();
    const d = state.dr; state.dr = null; drLoopOff(d);
    if (!d || !d.touched) return;
    if (!ok) {   // Cancel: every part this visit touched goes back exactly as it was
      change(() => {
        const t = engine.track(d.trackId);
        if (t) { for (const [id, notes] of Object.entries(d.orig)) { const c = t.clips.find((x) => x.id === id); if (!c) continue; if (notes === null) t.clips = t.clips.filter((x) => x !== c); else c.notes = notes; } if (d.madeTrack && !t.clips.length) engine.removeTrack(t.id); }
      }, { label: 'drums cancelled', undoable: false, activity: false });
      if (state.undo.length > d.undoLen) state.undo.length = d.undoLen; state.redo = []; updateUndoButtons();
      state.pendingActivity = state.pendingActivity.filter((a) => !/^drums for /.test(a));
      renderAll(); return;
    }
    toast(`Drums written for ${d.edited.size} part${d.edited.size === 1 ? '' : 's'}. Right-click the drum part → Drums… to change it again.`, { kind: 'ok', ms: 7000 });
  }
  function drLoopOn() { const d = state.dr; if (!d) return; if (!d.prevLoop) d.prevLoop = { ...engine.loop }; engine.setLoop({ enabled: true, start: d.win.w0, end: d.win.w1 }); $('#loop-on').checked = true; loopBarsFromEngine(); drawRuler(); }
  function drLoopOff(d) { if (d && d.prevLoop) { engine.setLoop(d.prevLoop); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); drawRuler(); } }
  let drRaf = 0; function drLive() { if (drRaf) return; const tick = () => { drRaf = 0; if (!state.dr) return; drDraw(); if (engine.playing) drRaf = requestAnimationFrame(tick); }; drRaf = requestAnimationFrame(tick); }
  $('#dr-gen').addEventListener('click', () => { try { drGenerate(); } catch (err) { fail(err); } });
  $('#dr-play').addEventListener('click', async () => { if (!state.dr) return; if (engine.playing) { await stop(); return; } drLoopOn(); engine.seek(state.dr.win.w0); await play(); drLive(); });
  $('#dr-undo').addEventListener('click', () => { const d = state.dr; if (!d || !d.hist.length) return; d.hits = d.hist.pop(); drCommit(); });
  $('#dr-clear').addEventListener('click', () => { const d = state.dr; if (!d || !d.hits.length) return; drPush(); d.hits = []; drCommit(); });
  (function drPointer() {
    const cv = $('#dr-canvas'); let paint = null;
    const cellAt = (e) => { const G = drGeom(); const r = cv.getBoundingClientRect(); const i = Math.floor((e.clientX - r.left) / G.cell), row = Math.floor((e.clientY - r.top - G.top) / G.rowH); if (i < 0 || i >= G.steps || row < 0 || row >= DR.VOICES.length) return null; return { G, i, voice: DR.VOICES[row].id, t0: i * G.stepT, t1: (i + 1) * G.stepT }; };
    const hear = (voice, vel) => { const t = drumTrack(false); if (t) engine.init().then(() => engine.playNote(t.id, DR.NOTE[voice], vel)).catch(() => {}); };
    cv.addEventListener('pointerdown', (e) => {
      const d = state.dr; const p = d && cellAt(e); if (!p || e.button !== 0) return; cv.focus(); drPush();
      const k = drHitAt(d, p.voice, p.t0, p.t1);
      if (k < 0) { d.hits.push({ t: p.t0, voice: p.voice, vel: 0.8 }); paint = { voice: p.voice, mode: 'add' }; hear(p.voice, 0.8); }
      else if (d.hits[k].vel < 0.95) { d.hits[k].vel = 1; paint = { voice: p.voice, mode: 'none' }; hear(p.voice, 1); }
      else { d.hits.splice(k, 1); paint = { voice: p.voice, mode: 'del' }; }
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      drDraw();
    });
    cv.addEventListener('pointermove', (e) => {
      const d = state.dr; if (!d || !paint || paint.mode === 'none') return; const p = cellAt(e); if (!p || p.voice !== paint.voice) return;
      const k = drHitAt(d, p.voice, p.t0, p.t1);
      if (paint.mode === 'add' && k < 0) { d.hits.push({ t: p.t0, voice: p.voice, vel: 0.8 }); drDraw(); }
      if (paint.mode === 'del' && k >= 0) { d.hits.splice(k, 1); drDraw(); }
    });
    const up = () => { if (paint) { paint = null; drCommit(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); $('#dr-undo').click(); } if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); $('#dr-play').click(); } });
  })();

  // ---------- writing mode ----------
  function setWriting(on) { setWorkspace(on ? 'write' : 'record'); if (state.folder) positionPlayhead(); }   /* Writing mode = the Write workspace */
  $('#btn-writing').addEventListener('click', () => setWriting(state.ws !== 'write'));
  setTimeout(() => { let w = 'write'; try { w = localStorage.getItem('bp.ws') || (localStorage.getItem('bp.writing') === '0' ? 'record' : 'write'); } catch (_) {} setWorkspace(w); }, 0);   // songwriting first by default

  // ---------- practice speed ----------
  // Renders the part (section or loop) once, slows it down WITHOUT changing pitch (so you can play along in tune),
  // and loops it outside the song. Nothing in the song changes.
  let practice = null;
  async function startPractice(from, to, pct, label) {
    stopPractice(); if (engine.playing) await stop();
    if (to - from > 120) toast('Long stretch — preparing the slow version takes a few seconds.', { kind: '', ms: 5000 });
    await engine.init();
    status(`Preparing ${label} at ${pct}%…`, 0); document.body.classList.add('busy');
    let r; try { r = await engine.render({ from, to, limiter: true }); } finally { document.body.classList.remove('busy'); }
    const slow = window.BPStretch.stretchChannels(r.channels, 100 / pct, { sampleRate: r.sampleRate });
    const buf = engine.ctx.createBuffer(slow.length, slow[0].length, r.sampleRate); slow.forEach((c, i) => buf.copyToChannel(c, i));
    const src = engine.ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(engine.ctx.destination); await engine.resume(); const startAt = engine.ctx.currentTime + 0.02; src.start(startAt);
    practice = { src, from, to, pct, startAt }; $('#practice-bar').hidden = false; $('#practice-info').textContent = `${label} at ${pct}% speed, same pitch — looping. Space or Stop practice ends it.`; status('');
  }
  function stopPractice() { if (!practice) return; try { practice.src.stop(); } catch (_) {} practice = null; $('#practice-bar').hidden = true; }
  $('#btn-practice-stop').addEventListener('click', stopPractice);
  const practiceItems = (from, to, label) => [50, 70, 80, 90].map((p) => ({ label: `${p}%`, action: () => startPractice(from, to, p, label).catch(fail) }));

  // ---------- chord chart / lyric sheet ----------
  // By section: the chords bar by bar, then the lyric lines with the chord they start on. Transposable for practice.
  function showChartShifted(k) { setWorkspace('write'); showTab('chart'); renderChart(); const sel = $('#chart-transpose'); if (sel) { sel.value = String(k); sel.dispatchEvent(new Event('change')); } status(k ? `Chart shown ${k > 0 ? '+' : ''}${k} — the recordings are untouched. Change it with the transpose box in the Chords tab.` : 'Chart as written.', 6000); }
  function chartText(semis = 0) {
    const song = collectSong(); const b = barLen(); const flat = MU.isFlatKey(semis ? MU.transposeKey(state.song.key || 'C', semis) : (state.song.key || ''));
    const tp = (c) => (semis ? MU.transposeChord(c, semis, flat) : c);
    const chords = CB.byTime(CB.list(song, 'chords')); const lyrics = lyricsOrdered();
    const chordAtT = (t) => { let cur = null; for (const c of chords) { if (c.time <= t + 1e-6) cur = c; else break; } return cur; };
    const key = state.song.key ? (semis ? MU.transposeKey(state.song.key, semis) : state.song.key) : '';
    const out = [`${song.name}`, `${engine.bpm} bpm · ${engine.timeSig.join('/')}${key ? ` · key ${key}` : ''}${semis ? ` (transposed ${semis > 0 ? '+' : ''}${semis})` : ''}`, ''];
    const secs = liveSections().slice().sort((x, y) => x.start - y.start);
    const blocks = secs.length ? secs : [{ name: 'Song', start: 0, end: Math.max(b, engine.contentLength()) }];
    for (const sc of blocks) {
      const a = Math.round(barIdx(sc.start)) + 1, z = endBarNo(sc.end); const b = barLenAt(sc.start + 1e-4);
      out.push(`[${sc.name.toUpperCase()}]  bars ${a}–${z}${sc.bpm || sc.timeSig ? `  · ${sc.bpm || engine.bpm} bpm ${MT.tsLabel(sc.timeSig || engine.timeSig)}` : ''}${sc.key ? `  · key ${semis ? MU.transposeKey(sc.key, semis) : sc.key}` : ''}`);
      const bars = []; for (let t = sc.start; t < sc.end - 1e-6; t += b) { const inBar = chords.filter((c) => c.time >= t - 1e-6 && c.time < t + b - 1e-6).map((c) => tp(c.chord)); const held = chordAtT(t) && chords.some((c) => c.time >= sc.start - 1e-6 && c.time < t - 1e-6); bars.push(inBar.length ? inBar.join(' ') : held ? '%' : '-'); }
      if (bars.some((x) => x !== '-')) for (let i = 0; i < bars.length; i += 4) out.push(`| ${bars.slice(i, i + 4).join(' | ')} |`);
      for (const l of lyrics.filter((x) => typeof x.time === 'number' && x.time >= sc.start - 1e-6 && x.time < sc.end - 1e-6)) { const c = chordAtT(l.time); out.push(`  ${c ? `[${tp(c.chord)}] ` : ''}${l.text}`); }
      out.push('');
    }
    const outside = secs.length ? lyrics.filter((x) => typeof x.time === 'number' && !secs.some((sc) => x.time >= sc.start - 1e-6 && x.time < sc.end - 1e-6)) : [];
    if (outside.length) { out.push('[LYRICS OUTSIDE THE LABELLED PARTS]'); for (const l of outside) { const c = chordAtT(l.time); out.push(`  ${posLabel(l.time)}: ${c ? `[${tp(c.chord)}] ` : ''}${l.text}`); } out.push(''); }
    const loose = lyrics.filter((x) => typeof x.time !== 'number'); if (loose.length) { out.push('[LYRICS NOT PLACED YET]'); for (const l of loose) out.push(`  ${l.text}`); out.push(''); }
    const needs = liveNeeds().filter((n) => !n.done); if (needs.length) { out.push('[STILL NEEDS]'); for (const n of needs) out.push(`  - ${n.text}${n.who ? ` (@${n.who})` : ''}`); }
    return out.join('\n');
  }
  function renderChart() {
    if (!state.folder) return; const sel = $('#chart-transpose');
    if (!sel.options.length) for (let k = -6; k <= 6; k++) { const o = el('option', null, k ? `transpose ${k > 0 ? '+' : ''}${k}` : 'as written'); o.value = String(k); if (!k) o.selected = true; sel.append(o); }
    const txt = chartText(Number(sel.value) || 0); const v = $('#chart-view'); v.innerHTML = '';
    for (const line of txt.split('\n')) { const d = el('div', /^\[/.test(line) ? 'sec' : /^\|/.test(line) ? 'ch' : null, line || ' '); v.append(d); }
  }
  $('#chart-transpose').addEventListener('change', renderChart);
  $('#btn-chart-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(chartText(Number($('#chart-transpose').value) || 0)); status('Chart copied — paste it in the group chat.'); } catch (err) { fail(err); } });
  $('#btn-chart-save').addEventListener('click', async () => {
    try {
      const txt = chartText(Number($('#chart-transpose').value) || 0); const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<!doctype html><meta charset="utf-8"><title>${esc(state.song.name)} — chart</title><style>body{font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;margin:32px;white-space:pre-wrap}b{color:#b4500f}i{color:#1d5fb4;font-style:normal;font-weight:600}@media print{body{margin:12mm}}</style><body>${txt.split('\n').map((l) => (/^\[/.test(l) ? `<b>${esc(l)}</b>` : /^\|/.test(l) ? `<i>${esc(l)}</i>` : esc(l))).join('\n')}</body>`;
      const r = await bp.bounce.exportWrite(state.folder, `${state.song.name} chart`, [{ path: `${state.song.name} chart.html`.replace(/[\\/:*?"<>|]/g, ' '), data: html }, { path: `${state.song.name} chart.txt`.replace(/[\\/:*?"<>|]/g, ' '), data: txt }]);
      toast(`Saved the chart (HTML to print + text) in ${r.folder.split(/[\\/]/).slice(-2).join('/')}.`, { kind: 'ok', ms: 8000 });
    } catch (err) { fail(err); }
  });

  // ---------- side panel tabs ----------
  function showTab(name) {
    if (name === 'band') { setWorkspace('band'); return; }
    if (name === 'files') name = 'versions';
    { const b0 = document.querySelector(`#side-tabs button[data-tab="${name}"]`); const allowed = b0 && String(b0.dataset.ws || '').split(' ').includes(state.ws || 'write');
      if (b0 && !allowed && state.ws !== 'band') { const want = String(b0.dataset.ws || '').split(' ')[0]; if (want && want !== 'none' && want !== state.ws) setWorkspace(want, { tab: false }); } }
    for (const b of document.querySelectorAll('#side-tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const t of document.querySelectorAll('.side-tab')) t.hidden = t.dataset.tab !== name;
    try { localStorage.setItem('bp.tab', name); } catch (_) {}
    if (name === 'lyrics') followLyric(true);
    if (name === 'parts') refreshParts().catch(() => {});
    if (name === 'chart') renderChart();
    if (name === 'takes') renderTakes();
    try { const m = JSON.parse(localStorage.getItem('bp.wsTab') || '{}'); m[state.ws || 'write'] = name; localStorage.setItem('bp.wsTab', JSON.stringify(m)); } catch (_) {}
  }
  // ---------- workspaces: Write · Record · Mix · Practice · Band ----------
  // One screen per job. Write: the song (timeline + lyrics, chords, notes, needs, ideas, parts, history, versions).
  // Record: input / monitoring / punch / tuner up top, the selected track's channel + FX and its takes below.
  // Mix: mixer, FX, master, Auto mix / Auto master / A/B. Practice: the full-screen view. Band: the band page.
  const WS = ['write', 'record', 'mix', 'band'];
  state.ws = 'write';
  function setWorkspace(ws, { tab = true } = {}) {
    if (ws === 'practice') { openKaraoke().catch(fail); return; }
    if (!WS.includes(ws)) ws = 'write';
    try { if (kara.open) closeKaraoke(); } catch (_) { /* before practice mode exists (startup) */ }
    const prev = state.ws; state.ws = ws;
    for (const w of WS) document.body.classList.toggle(`ws-${w}`, w === ws);
    document.body.classList.toggle('writing', ws === 'write');   // older CSS hooks: Write hides the mixer / FX
    for (const b of document.querySelectorAll('#ws-tabs button')) b.classList.toggle('active', b.dataset.ws === ws);
    $('#btn-writing').classList.toggle('active', ws === 'write');
    const band = ws === 'band';
    $('#band-page').hidden = !band;
    if (band) { $('#song').hidden = true; $('#no-song').hidden = true; quest.open = true; loadQuest().catch(() => {}); renderBandPage(); }
    else { quest.open = false; $('#song').hidden = !state.folder; $('#no-song').hidden = !!state.folder; }
    for (const b of document.querySelectorAll('#side-tabs button')) b.hidden = !String(b.dataset.ws || '').split(' ').includes(ws);
    if (tab && !band) {
      const cur = document.querySelector('#side-tabs button.active'); const ok = (b) => b && !b.hidden;
      let want = null; try { want = JSON.parse(localStorage.getItem('bp.wsTab') || '{}')[ws]; } catch (_) {}
      const wb = want && document.querySelector(`#side-tabs button[data-tab="${want}"]`);
      if (ok(wb)) showTab(want); else if (!ok(cur)) { const first = [...document.querySelectorAll('#side-tabs button')].find(ok); if (first) showTab(first.dataset.tab); }
    }
    try { localStorage.setItem('bp.ws', ws); } catch (_) {}
    if (!band) applyBottomH();
    if (prev !== ws && state.folder && !band) { renderTracks(); renderFx(); renderMixer && renderMixer(); }
  }
  for (const b of document.querySelectorAll('#ws-tabs button')) if (b.dataset.ws !== 'practice') b.addEventListener('click', () => setWorkspace(b.dataset.ws));
  // each workspace remembers its own bottom-panel height (Mix wants the mixer tall, Write wants the timeline)
  function applyBottomH() {
    const b = $('#bottom'); if (!b) return; let v = 0; try { v = Number(localStorage.getItem(`bp.bottomH.${state.ws || 'write'}`)) || Number(localStorage.getItem('bp.bottomH')) || 0; } catch (_) {}
    const def = { write: 300, record: 320, mix: 440 }[state.ws] || 300;
    b.style.height = `${Math.max(120, Math.min(v >= 120 ? v : def, window.innerHeight - 160))}px`;
  }
  function renderBandPage() {
    if (state.ws !== 'band') return;
    const rows = bandFeedRows(); fillFeed($('#bp-feed'), rows.filter((r) => !r.now), 200);
    const live = $('#bp-live'); live.innerHTML = ''; const now = rows.filter((r) => r.now);
    if (!now.length) live.append(el('li', 'muted', 'Nobody\'s noodling right now.'));
    for (const r of now) { const li = el('li', 'now'); li.append(el('span', 'bf-who', r.by), document.createTextNode(' '), el('span', 'bf-song', r.song ? r.song.name : ''), el('span', 'bf-what', r.what)); if (r.song && r.song.folder) li.addEventListener('click', () => { setWorkspace('write'); openSong(r.song.folder).catch(fail); }); live.append(li); }
    renderPracticeLog();
  }
  function renderPracticeLog() {
    const ul = $('#bp-practice'); if (!ul) return; ul.innerHTML = '';
    const b = quest && quest.board; const rows = b && b.practice ? b.practice : null;
    if (!rows || !rows.members.length) { ul.append(el('li', 'muted', 'No practice logged yet — time spent playing in 🎙 Practice counts here (and earns XP).')); return; }
    for (const m of rows.members) { const li = el('li'); li.append(el('b', null, m.name), el('span', 'muted', ` ${fmtMins(m.week)} this week · ${fmtMins(m.total)} total`)); if (m.top) li.append(el('div', 'muted small', `most: ${m.top.map((x) => `${x.song} ${fmtMins(x.mins)}`).join(', ')}`)); ul.append(li); }
  }
  const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} m` : `${Math.round(m)} min`);
  for (const b of document.querySelectorAll('#side-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  try { const t = localStorage.getItem('bp.tab'); if (t && document.querySelector(`#side-tabs button[data-tab="${t}"]`)) showTab(t); } catch (_) {}
  const tabShown = (name) => { const t = document.querySelector(`.side-tab[data-tab="${name}"]`); return t && !t.hidden; };

  // ---------- sections (song structure on the master timeline) ----------
  const liveSections = () => CB.live(CB.list(state.song, 'sections')).slice().sort((a, b) => a.start - b.start);
  const barStart = (sec) => floorBar(sec);
  const snapBar = (sec) => snapToBar(sec);
  function addSection(name, at) {
    if (ro()) { status('Read-only — take over to add sections.'); return null; }
    const start = barStart(Math.max(0, at)); const b = barLenAt(start);
    const inside = liveSections().find((s) => start >= s.start - 1e-6 && start < s.end - 1e-6);
    const next = liveSections().find((s) => s.start > start + 1e-6);
    let end = barSec(barIdx(start) + 8); if (inside) end = Math.min(end, inside.end); if (next) end = Math.min(end, next.start);
    if (end - start < b - 1e-6) end = start + b;
    const nm = CB.nextSectionName(state.song, name); let made = null;
    cchange(() => {
      if (inside && Math.abs(inside.start - start) < 1e-6) { inside.name = nm; made = inside; return; }   // clicked the first bar of a section: rename it
      if (inside) inside.end = start;
      made = { id: newId(), name: nm, start, end, by: me(), at: nowIso() }; (state.song.sections = state.song.sections || []).push(made);
    }, { label: `section ${nm} at bar ${barOf(start)}` });
    renderAll(); return made;
  }
  function loopSection(s) { setLoopBars(barOf(s.start), Math.max(barOf(s.start), endBarNo(s.end))); status(`Looping ${s.name} (bars ${barOf(s.start)}–${endBarNo(s.end)}).`); }
  function sectionMenu(s0) {
    const s = liveSections().find((x) => x.id === s0.id); if (!s) return [{ title: 'section is gone' }];
    const a = barOf(s.start), z = endBarNo(s.end);
    return [
      { title: `${s.name} · bars ${a}–${z}` },
      { label: 'Play from here', action: () => { engine.seek(s.start); play().catch(fail); } },
      { label: `Loop ${s.name}`, hint: 'double-click', action: () => loopSection(s) },
      { label: `Note in ${s.name}…`, action: () => addNote(null, s.start) },
      'sep',
      { label: 'Rename', sub: [...CB.SECTION_NAMES.map((n) => ({ label: n, action: () => { const nm = CB.nextSectionName({ sections: liveSections().filter((x) => x !== s) }, n); cchange(() => { s.name = nm; }, { label: `rename section to ${nm}` }); renderAll(); } })), 'sep', { label: 'Custom…', action: async () => { const n0 = await promptName('Section name', s.name); const n = n0 && n0.trim().slice(0, 40); if (n && n !== s.name) { const others = liveSections().filter((x) => x !== s); const nm = others.some((x) => x.name.toLowerCase() === n.toLowerCase()) ? CB.nextSectionName({ sections: others }, n) : n; cchange(() => { s.name = nm; }, { label: `rename section to ${nm}` }); renderAll(); if (nm !== n) status(`There's already a ${n} — named it ${nm}.`, 6000); } } }], disabled: ro() },
      { label: 'Bars…', action: async () => { const v = await promptName(`${s.name}: bars (from-to)`, `${a}-${z}`); const m = v && /^(\d+)\s*[-–]\s*(\d+)$/.exec(v.trim()); if (m) setSectionBars(s, Number(m[1]), Number(m[2])); }, disabled: ro() },
      ...(() => { const zEnd = Math.max(a, Math.round(barIdx(engine.playhead))); return [{ label: `End at the playhead (bar ${zEnd})`, action: () => setSectionBars(s, a, zEnd), disabled: ro() || engine.playhead <= s.start }]; })(),
      'sep',
      ...partItems(s),
      'sep',
      { label: `Write a melody for ${s.name}…`, action: () => openMelody(s.id).catch(fail), disabled: ro() },
      { label: `Key change${s.key ? `: ${s.key}` : ''}`, hint: 'moves the recordings too', sub: sectionKeyItems(s), disabled: ro() },
      { label: `Drums for ${s.name}…`, hint: 'generate or edit hit by hit', action: () => openDrums(s.id).catch(fail), disabled: ro() },
      { label: `Practice ${s.name} slower`, sub: practiceItems(s.start, s.end, s.name) },
      { label: `Save ${s.name} to the Parts bin…`, action: () => savePartFrom({ section: s }).catch(fail) },
      { label: `Share ${s.name} (mix + chart)`, hint: 'a quick bounce for the group chat', action: () => sharePart(s).catch(fail) },
      'sep',
      ...linkMenuItems(s),
      'sep',
      { label: 'Restructure song…', hint: 'move the parts into a new structure', action: () => openRestructure().catch(fail), disabled: ro() },
    ];
  }
  // ---------- parts with everything in them: slice, delete (and close the gap), duplicate, move, insert bars, split, merge ----------
  // All of these work on every track at once (so with track locks they need "Unlock all"), are one Undo step, and skip
  // linked copies (those are rebuilt from their room afterwards).
  const PEPS = 1e-4;
  // Part tails & pickups: while a part operation runs, every take that belongs to a part (mostly inside it, up to a bar
  // of lead-in / ring-out — TPL.ownerOf) moves with that part whole: it is never cut at a part edge, and a neighbour's
  // pickup or tail is never taken along with this part.
  let partOwners = null;
  function ownerMapNow() { const secs = liveSections(); const m = new Map(); for (const t of engine.tracks) for (const c of t.clips) { if (c.link) continue; const o = TPL.ownerOf(secs, c.start, clipEnd(c), partEdge); if (o) m.set(c, o); } return m; }
  function cutAllAt(at) {
    for (const t of engine.tracks) {
      const next = [];
      for (const c of t.clips) {
        const st = c.start, en = clipEnd(c);
        if (c.link || !(at > st + 0.01 && at < en - 0.01) || (partOwners && partOwners.has(c))) { next.push(c); continue; }
        const leftLen = at - st, ts = c.trimStart || 0, full = fullLen(c);
        const left = { ...c, trimEnd: Math.max(0, full - ts - leftLen), fadeOut: 0.004 };
        const right = cloneClip(c, at); right.trimStart = ts + leftLen; right.fadeIn = 0.004;
        if (c.kind === 'midi') { left.notes = (c.notes || []).filter((n) => n.t - ts < leftLen); right.notes = (c.notes || []).filter((n) => n.t - ts >= leftLen).map((n) => ({ ...n })); }
        next.push(left, right);
      }
      t.clips = next;
    }
  }
  const inRange = (x, a, b) => x >= a - PEPS && x < b - PEPS;
  function clipsInside(a, b) { const out = []; for (const t of engine.tracks) for (const c of t.clips) { if (c.link) continue; const o = partOwners && partOwners.get(c); if (o ? o.start >= a - PEPS && o.end <= b + PEPS : c.start >= a - PEPS && clipEnd(c) <= b + PEPS) out.push([t, c]); } return out; }
  function shiftAfter(at, d) {
    for (const t of engine.tracks) for (const c of t.clips) { if (c.link) continue; const o = partOwners && partOwners.get(c); if (o ? o.start >= at - PEPS : c.start >= at - PEPS) c.start = Math.max(0, c.start + d); }   /* a part's pickup moves with its part */
    for (const x of liveSections()) if (x.start >= at - PEPS) { x.start += d; x.end += d; }
    for (const k of ['chords', 'markers']) for (const x of CB.live(CB.list(state.song, k))) if (x.time >= at - PEPS) x.time += d;
    for (const l of liveLyrics()) if (typeof l.time === 'number' && l.time >= at - PEPS) l.time += d;
  }
  function clearRange(a, b, { trash = true } = {}) {
    for (const [t, c] of clipsInside(a, b)) { if (trash) trashClip(t, c); t.clips = t.clips.filter((x) => x !== c); }
    for (const ch of CB.live(CB.list(state.song, 'chords'))) if (inRange(ch.time, a, b)) { ch.deleted = true; ch.deletedBy = me(); }
    for (const l of liveLyrics()) if (typeof l.time === 'number' && inRange(l.time, a, b)) l.time = null;   // back to "not pinned", not lost
    for (const m of CB.live(CB.list(state.song, 'markers'))) if (inRange(m.time, a, b)) m.time = a;
  }
  // the room is going away (deleted / moved after a copy): its takes, chords and notes move to the first copy, which becomes the room
  function handOffRoom(s, { onlyIfPast } = {}) {
    const g = Object.values(TPL.linkInfo({ sections: state.song.sections, linkGroups: state.song.linkGroups })).find((x) => x.room.id === s.id && x.followers.length);
    if (!g) return null; const f = g.followers[0]; if (onlyIfPast != null && onlyIfPast <= f.start + PEPS) return null;
    const a = s.start, b = s.end, d = f.start - a; cutAllAt(a); cutAllAt(b);
    for (const t of engine.tracks) t.clips = t.clips.filter((c) => !(c.link && c.link.section === f.id));
    for (const [, c] of clipsInside(a, b)) { c.start += d; if (partOwners) partOwners.set(c, f); }   // they belong to the new room now
    for (const k of ['chords', 'markers']) for (const x of CB.live(CB.list(state.song, k))) if (!x.link && inRange(x.time, a, b)) x.time += d;
    for (const l of liveLyrics()) if (!l.link && typeof l.time === 'number' && inRange(l.time, a, b)) l.time += d;   // the words go with the takes
    return f;
  }
  function roomBlock(s, what) { void s; void what; return false; }   // 0.11: rooms hand their takes to the next copy instead (handOffRoom)
  function _roomBlockOld(s, what) {
    const g = Object.values(TPL.linkInfo({ sections: state.song.sections, linkGroups: state.song.linkGroups })).find((x) => x.room.id === s.id && x.followers.length);
    if (!g) return false;
    toast(`${s.name} is the room for the linked ${plural(cap(g.type))} — ${what} it would take their takes with it. Unlink it first (right-click → Unlink), or work on one of the copies.`, { kind: 'warn', ms: 10000 }); return true;
  }
  function partOp(label, fn, { cutOwned = false } = {}) { if (engine.recording || finishing) { status('Stop recording first.'); return false; } if (engine.playing) engine.stop(); const ok = change(() => { partOwners = cutOwned ? null : ownerMapNow(); try { return fn(); } finally { partOwners = null; } }, { label }); if (ok) { renderAll(); status(`${label}. ${MOD}+Z undoes.`, 6000); } return ok; }
  function slicePart(s) { return partOp(`sliced every track at the edges of ${s.name}`, () => { cutAllAt(s.start); cutAllAt(s.end); }, { cutOwned: true }); }   // an explicit slice cuts tails / pickups too
  function deletePart(s, { close = true } = {}) {
    if (roomBlock(s, 'deleting')) return false; const len = s.end - s.start, a = s.start, b = s.end;
    return partOp(close ? `deleted ${s.name} and closed the gap` : `deleted ${s.name} and its takes`, () => {
      handOffRoom(s); cutAllAt(a); cutAllAt(b); clearRange(a, b); s.deleted = true; s.deletedBy = me();
      if (close) { shiftAfter(b, -len); if (engine.loop.enabled && engine.loop.start >= b - PEPS) engine.setLoop({ start: engine.loop.start - len, end: engine.loop.end - len }); }
    });
  }
  function duplicatePart(s) {
    const len = s.end - s.start, a = s.start, b = s.end;
    const ty = TPL.sectionType(s.name); const linked = !s.unlinked && (state.song.linkGroups || {})[ty] !== false;   // the copy is linked: it plays the room, nothing to copy
    return partOp(`duplicated ${s.name}`, () => {
      cutAllAt(a); cutAllAt(b); shiftAfter(b, len);
      if (!linked) for (const [t, c] of clipsInside(a, b)) t.clips.push(cloneClip(c, c.start + len));
      if (!linked) for (const ch of CB.live(CB.list(state.song, 'chords')).filter((x) => !x.link && inRange(x.time, a, b))) state.song.chords.push({ ...ch, id: newId(), time: ch.time + len, by: me(), at: nowIso() });
      for (const l of liveLyrics().filter((x) => typeof x.time === 'number' && inRange(x.time, a, b))) state.song.lyrics.push({ ...l, id: newId(), time: l.time + len, by: me(), at: nowIso() });
      const nm = nextPartName(s.name.replace(/\s*\d+$/, '').trim() || cap(TPL.sectionType(s.name)));
      state.song.sections.push({ id: newId(), name: nm, start: b, end: b + len, ...(s.key ? { key: s.key } : {}), ...(s.bpm ? { bpm: s.bpm } : {}), ...(s.timeSig ? { timeSig: s.timeSig } : {}), ...(s.unlinked ? { unlinked: true } : {}), by: me(), at: nowIso() });
      if (linked) state.song.linkGroups = { ...(state.song.linkGroups || {}), [ty]: true };
    });
  }
  // ---------- this song's parts bin: every part of the song, drag one in (or right-click → add) for another linked copy ----------
  // Verse 1, Verse 2 → "Verse 3" (CB.nextSectionName alone would hand back a bare "Verse")
  function nextPartName(base) {
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const re = new RegExp(`^${esc}(?:\\s+(\\d+))?$`, 'i'); let max = 0, any = false;
    for (const s of liveSections()) { const m = re.exec(s.name.trim()); if (m) { any = true; max = Math.max(max, m[1] ? Number(m[1]) : 1); } }
    return any ? `${base} ${max + 1}` : base;
  }
  function songPartList() {
    const seen = new Map();
    for (const s of liveSections().slice().sort((x, y) => x.start - y.start)) {
      const ty = TPL.sectionType(s.name); if (!ty) continue;
      if (!seen.has(ty)) seen.set(ty, { ty, room: null, count: 0, unl: [] });
      const e = seen.get(ty); e.count++; if (s.unlinked) e.unl.push(s); else if (!e.room) e.room = s;
    }
    const out = [];
    for (const e of seen.values()) { if (e.room) out.push({ ty: e.ty, sec: e.room, count: e.count, linked: (state.song.linkGroups || {})[e.ty] !== false }); for (const u of e.unl) out.push({ ty: e.ty, sec: u, count: 1, own: true }); }
    return out;
  }
  // where a dropped part goes: on the nearest bar line, never inside another part (it goes before / after whichever edge is closer)
  function songPartDropAt(sec) {
    let at = snapToBar(Math.max(0, sec));
    const inside = liveSections().find((x) => at > x.start + PEPS && at < x.end - PEPS);
    if (inside) at = at - inside.start < inside.end - at ? inside.start : inside.end;
    return at;
  }
  function insertSongPart(secId, rawAt) {
    if (ro()) return false; const src = liveSections().find((x) => x.id === secId); if (!src) return false;
    const ty = TPL.sectionType(src.name); const at = songPartDropAt(rawAt); const len = src.end - src.start;
    const linked = !src.unlinked && (state.song.linkGroups || {})[ty] !== false;
    const base = src.name.replace(/\s*\d+$/, '').trim() || cap(ty);   /* named after the part you dragged: Post-chorus → Post-chorus 2 */
    const nm = nextPartName(base);
    return partOp(`added ${nm} at bar ${barOf(at)}${linked ? ` (plays ${src.name})` : ''}`, () => {
      cutAllAt(at); shiftAfter(at, len);
      const a = src.start, b = src.end;   // (src moved if it was after `at`; read it after the shift)
      if (!linked) {
        for (const [t, c] of clipsInside(a, b)) t.clips.push(cloneClip(c, at + (c.start - a)));
        for (const ch of CB.live(CB.list(state.song, 'chords')).filter((x) => !x.link && inRange(x.time, a, b))) state.song.chords.push({ ...ch, id: newId(), time: at + (ch.time - a), by: me(), at: nowIso() });
      }
      state.song.sections.push({ id: newId(), name: nm, start: at, end: at + len, ...(src.key ? { key: src.key } : {}), ...(src.bpm ? { bpm: src.bpm } : {}), ...(src.timeSig ? { timeSig: src.timeSig } : {}), ...(src.unlinked ? { unlinked: true } : {}), by: me(), at: nowIso() });
      if (linked) state.song.linkGroups = { ...(state.song.linkGroups || {}), [ty]: true };
    });
  }
  function laneTimeAt(clientX) {
    const lane = document.querySelector('#tracks .track .lane') || document.querySelector('#section-lane');
    return lane ? Math.max(0, (clientX - lane.getBoundingClientRect().left) / state.pxPerSec) : engine.playhead;
  }
  function renderSongParts() {
    const ul = $('#song-parts'); if (!ul) return; ul.innerHTML = '';
    if (!state.song) { ul.append(el('li', 'muted', 'Open a song.')); return; }
    const list = songPartList();
    if (!list.length) { ul.append(el('li', 'muted', 'No parts yet — right-click the sections strip to add Intro / Verse / Chorus…')); return; }
    for (const p of list) {
      const s = p.sec; const bars = Math.round(barIdx(s.end) - barIdx(s.start));
      const li = el('li', 'songpart'); li.draggable = !ro(); li.dataset.sec = s.id; li.style.borderLeftColor = CB.sectionColor(s.name);
      const takes = clipsIn(s).length;
      li.append(el('b', null, p.own ? s.name : cap(p.ty)), el('span', 'pmeta', ` ${bars} bar${bars === 1 ? '' : 's'}${s.bpm || s.timeSig ? ` · ${Math.round(s.bpm || engine.bpm)} ${MT.tsLabel(s.timeSig || engine.timeSig)}` : ''} · ${takes ? `${takes} take${takes === 1 ? '' : 's'}` : 'empty'}${p.count > 1 ? ` · ×${p.count}` : ''}${p.own ? ' · its own (unlinked)' : p.linked && p.count > 1 ? ' · linked' : ''}`));
      li.title = `Drag onto the song (or right-click) to add another ${p.own ? `copy of ${s.name}` : cap(p.ty)}${p.own ? ' — a copy of its takes' : p.linked ? ` — linked: it plays ${s.name}, and recording / editing in any of them changes them all` : ''}`;
      li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-bp-songpart', s.id); e.dataTransfer.effectAllowed = 'copy'; document.body.classList.add('dragging-part'); });
      li.addEventListener('dragend', () => document.body.classList.remove('dragging-part'));
      li.addEventListener('dblclick', () => { engine.seek(s.start); positionPlayhead(); });
      const secs = () => liveSections().slice().sort((x, y) => x.start - y.start);
      M.attach(li, () => [{ title: `${p.own ? s.name : cap(p.ty)} — add another` }, { label: `At the playhead (bar ${barOf(songPartDropAt(engine.playhead))})`, action: () => insertSongPart(s.id, engine.playhead), disabled: ro() },
        { label: 'After…', sub: secs().map((x) => ({ label: x.name, action: () => insertSongPart(s.id, x.end) })), disabled: ro() },
        { label: 'At the end', action: () => insertSongPart(s.id, Math.max(0, ...liveSections().map((x) => x.end))), disabled: ro() },
        'sep', { label: `Go to ${s.name}`, action: () => { engine.seek(s.start); positionPlayhead(); } }, { label: `Loop ${s.name}`, action: () => loopSection(s) }]);
      ul.append(li);
    }
  }
  // drop a song part onto the timeline (tracks or the sections strip)
  for (const target of ['#tracks', '#ruler-row']) {
    const node = $(target); if (!node) continue;
    node.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('text/x-bp-songpart')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const at = songPartDropAt(laneTimeAt(e.clientX)); status(`Drop to add it at bar ${barOf(at)}`, 1500); } }, true);
    node.addEventListener('drop', (e) => { const id = e.dataTransfer.getData('text/x-bp-songpart'); if (!id) return; e.preventDefault(); e.stopPropagation(); document.body.classList.remove('dragging-part'); insertSongPart(id, laneTimeAt(e.clientX)); }, true);
  }
  // move a part (with everything in it) so it starts at `to` (a time in the song as it is now); the rest closes up / makes room
  function movePartTo(s, to, label) {
    if (roomBlock(s, 'moving')) return false; const len = s.end - s.start, a = s.start, b = s.end;
    return partOp(label, () => {
      handOffRoom(s, { onlyIfPast: to });
      cutAllAt(a); cutAllAt(b); cutAllAt(to);
      const pieces = clipsInside(a, b).map(([t, c]) => [t, c, c.start - a]);
      const chs = CB.live(CB.list(state.song, 'chords')).filter((x) => inRange(x.time, a, b)).map((x) => [x, x.time - a]);
      const lys = liveLyrics().filter((x) => typeof x.time === 'number' && inRange(x.time, a, b)).map((x) => [x, x.time - a]);
      const mks = CB.live(CB.list(state.song, 'markers')).filter((x) => inRange(x.time, a, b)).map((x) => [x, x.time - a]);
      for (const [t, c] of pieces) t.clips = t.clips.filter((x) => x !== c);
      for (const [x] of [...chs, ...lys, ...mks]) x.time = -1e6;   // parked while the song closes up
      s.start = -1e6; s.end = -1e6 + len;
      shiftAfter(b, -len); let dest = to > a ? to - len : to;
      shiftAfter(dest, len);
      for (const [t, c, off] of pieces) { c.start = dest + off; t.clips.push(c); }
      for (const [x, off] of [...chs, ...lys, ...mks]) x.time = dest + off;
      s.start = dest; s.end = dest + len;
    });
  }
  function movePart(s, dir) {
    const secs = liveSections().slice().sort((x, y) => x.start - y.start); const i = secs.findIndex((x) => x.id === s.id);
    const n = secs[i + dir]; if (!n) { status(`${s.name} is already the ${dir < 0 ? 'first' : 'last'} part.`); return false; }
    return movePartTo(s, dir < 0 ? n.start : n.end, `moved ${s.name} ${dir < 0 ? `before ${n.name}` : `after ${n.name}`}`);
  }
  function insertBars(at, bars, where) { const d = bars * barLenAt(Math.max(0, at - 1e-3)); return partOp(`inserted ${bars} empty bar${bars > 1 ? 's' : ''} ${where}`, () => { cutAllAt(at); shiftAfter(at, d); }); }
  function splitPart(s, at) {
    const b = barLenAt(s.start); const mid = at != null && at > s.start + b * 0.5 && at < s.end - b * 0.5 ? snapToBar(at) : barSec(barIdx(s.start) + Math.round((barIdx(s.end) - barIdx(s.start)) / 2));
    if (mid <= s.start + PEPS || mid >= s.end - PEPS) { status(`${s.name} is too short to split.`); return false; }
    return partOp(`split ${s.name} at bar ${barOf(mid)}`, () => { cutAllAt(mid); const end = s.end; s.end = mid; state.song.sections.push({ id: newId(), name: CB.nextSectionName({ sections: liveSections() }, s.name.replace(/\s*\d+$/, '')), start: mid, end, ...(s.key ? { key: s.key } : {}), by: me(), at: nowIso() }); });
  }
  function mergeWithNext(s) {
    const secs = liveSections().slice().sort((x, y) => x.start - y.start); const n = secs[secs.findIndex((x) => x.id === s.id) + 1];
    if (!n) { status(`${s.name} is the last part.`); return false; }
    return partOp(`merged ${n.name} into ${s.name}`, () => { s.end = n.end; n.deleted = true; n.deletedBy = me(); });
  }
  // a part with its own tempo / time signature: it keeps its number of bars, so its length changes and everything after
  // it moves; MIDI, chords and lyrics inside are re-timed to the new grid (recorded audio isn't stretched — re-track it)
  function setPartMeter(s, bpm, ts) {
    const songTs = MT.normTs(engine.timeSig);
    const nb = bpm && Math.abs(bpm - engine.bpm) > 1e-6 ? Math.max(20, Math.min(400, bpm)) : null;
    const nts = ts && MT.tsLabel(ts) !== MT.tsLabel(songTs) ? MT.normTs(ts) : null;
    const bars = Math.max(1, Math.round(barIdx(s.end) - barIdx(s.start)));
    const oldLen = s.end - s.start, newLen = bars * MT.barLenOf(nb || engine.bpm, nts || songTs), ratio = newLen / oldLen, a = s.start, b = s.end;
    const label = nb || nts ? `${s.name}: ${Math.round(nb || engine.bpm)} bpm ${MT.tsLabel(nts || songTs)}` : `${s.name} follows the song tempo again`;
    return partOp(label, () => {
      cutAllAt(a); cutAllAt(b);
      const inside = clipsInside(a, b);
      const chs = CB.live(CB.list(state.song, 'chords')).filter((x) => inRange(x.time, a, b));
      const lys = liveLyrics().filter((x) => typeof x.time === 'number' && inRange(x.time, a, b));
      const mks = CB.live(CB.list(state.song, 'markers')).filter((x) => inRange(x.time, a, b));
      shiftAfter(b, newLen - oldLen);
      const sc = (t) => a + (t - a) * ratio;
      for (const [, c] of inside) {
        if (c.kind === 'midi') { const f = ratio; c.start = sc(c.start); c.duration = (c.duration || 0) * f; c.trimStart = (c.trimStart || 0) * f; c.trimEnd = (c.trimEnd || 0) * f; c.notes = (c.notes || []).map((n) => ({ ...n, t: n.t * f, d: n.d * f })); }
        else c.start = sc(c.start);   // audio keeps its speed; it just starts where its beat is now
      }
      for (const x of [...chs, ...mks]) x.time = sc(x.time);
      for (const l of lys) { l.time = sc(l.time); if (Array.isArray(l.words)) l.words = l.words.map((w) => ({ ...w, t: w.t * ratio, e: w.e * ratio })); }   // word timings are relative to the line
      s.end = a + newLen; if (nb) s.bpm = nb; else delete s.bpm; if (nts) s.timeSig = nts; else delete s.timeSig;
    });
  }
  async function partMeterPrompt(s) {
    const cur = `${Math.round((s.bpm || engine.bpm) * 100) / 100} ${MT.tsLabel(s.timeSig || engine.timeSig)}`;
    const v = await promptName(`${s.name}: tempo and time signature (e.g. "90 6/8", "140", "7/8", or "song" to follow the song)`, cur);
    if (v === null) return; const txt = v.trim();
    if (!txt || /^song$/i.test(txt)) { setPartMeter(s, null, null); return; }
    let bpm = s.bpm || engine.bpm, ts = s.timeSig || engine.timeSig; let ok = false;
    for (const tok of txt.split(/\s+/)) { if (tok.includes('/')) { const p = MT.parseTimeSig(tok); if (!p) { status(`"${tok}" isn't a time signature.`, 6000); return; } ts = p; ok = true; } else if (Number(tok) > 0) { bpm = Number(tok); ok = true; } else if (!/^bpm$/i.test(tok)) { status(`Didn't get "${tok}" — try "90 6/8".`, 6000); return; } }
    if (ok) setPartMeter(s, bpm, ts);
  }
  function partItems(s) {
    const len = Math.round(barIdx(s.end) - barIdx(s.start)); const ro2 = ro();
    return [
      { label: `Delete ${s.name} + its takes (close the gap)`, danger: true, hint: 'everything after moves up', action: () => deletePart(s, { close: true }), disabled: ro2 },
      { label: `Delete ${s.name} + its takes (leave ${len} empty bars)`, danger: true, action: () => deletePart(s, { close: false }), disabled: ro2 },
      { label: 'Delete just the part marker (keep the takes)', danger: true, action: () => { cchange(() => { s.deleted = true; s.deletedBy = me(); }, { label: `delete section ${s.name}` }); renderAll(); }, disabled: ro2 },
      'sep',
      { label: `Slice every track at ${s.name}'s edges`, action: () => slicePart(s), disabled: ro2 },
      { label: s.carry ? `✓ Takes move with ${s.name} (on)` : `Takes move with ${s.name} when you drag it`, action: () => { cchange(() => { if (s.carry) delete s.carry; else s.carry = true; }, { label: `${s.name}: takes ${s.carry ? 'stay' : 'move with the part'}` }); renderAll(); }, disabled: ro2 },
      { label: 'Takes move with every part', action: () => { cchange(() => { for (const x of liveSections()) x.carry = true; }, { label: 'takes move with their parts' }); renderAll(); }, disabled: ro2 },
      'sep',
      { label: `Tempo & time signature${s.bpm || s.timeSig ? `: ${Math.round(s.bpm || engine.bpm)} · ${MT.tsLabel(s.timeSig || engine.timeSig)}` : ' (follows the song)'}…`, hint: 'this part only', action: () => partMeterPrompt(s).catch(fail), disabled: ro2 },
      ...(s.bpm || s.timeSig ? [{ label: 'Back to the song tempo / time signature', action: () => setPartMeter(s, null, null), disabled: ro2 }] : []),
      { label: `Duplicate ${s.name} (insert a copy after it)`, action: () => duplicatePart(s), disabled: ro2 },
      { label: 'Move earlier (swap with the part before)', action: () => movePart(s, -1), disabled: ro2 },
      { label: 'Move later (swap with the part after)', action: () => movePart(s, 1), disabled: ro2 },
      { label: `Split ${s.name} in two${engine.playhead > s.start && engine.playhead < s.end ? ` at bar ${barOf(snapToBar(engine.playhead))}` : ''}`, action: () => splitPart(s, engine.playhead > s.start && engine.playhead < s.end ? engine.playhead : null), disabled: ro2 },
      { label: 'Merge with the next part', action: () => mergeWithNext(s), disabled: ro2 },
      { label: 'Insert empty bars', sub: [1, 2, 4, 8].flatMap((n) => [{ label: `${n} bar${n > 1 ? 's' : ''} before ${s.name}`, action: () => insertBars(s.start, n, `before ${s.name}`) }, { label: `${n} bar${n > 1 ? 's' : ''} after ${s.name}`, action: () => insertBars(s.end, n, `after ${s.name}`) }]), disabled: ro2 },
    ];
  }
  // the room a section has between its neighbours (sections never overlap: a covered one couldn't be clicked)
  function secBounds(s) {
    const others = liveSections().filter((x) => x.id !== s.id);
    const lo = Math.min(s.start, Math.max(0, ...others.filter((x) => x.start < s.start - 1e-6).map((x) => x.end)));
    const nx = others.filter((x) => x.start > s.start + 1e-6).map((x) => x.start);
    const hi = nx.length ? Math.max(s.end, Math.min(...nx)) : Infinity;
    return { lo, hi };
  }
  // where a moved section can land: the nearest free gap (between the other sections) that fits it
  function freeSpot(s, want, len) {
    const others = liveSections().filter((x) => x.id !== s.id).sort((a, b) => a.start - b.start);
    const gaps = []; let at = 0; for (const x of others) { if (x.start > at + 1e-6) gaps.push([at, x.start]); at = Math.max(at, x.end); } gaps.push([at, Infinity]);
    let best = null; for (const [g0, g1] of gaps) { if (g1 - g0 < len - 1e-6) continue; const c = Math.max(g0, Math.min(g1 - len, want)); if (!best || Math.abs(c - want) < Math.abs(best - want)) best = c; }
    return best == null ? s.start : best;
  }
  function setSectionBars(s, from, to) {
    if (to < from) [from, to] = [to, from]; let a = Math.max(1, from), z = Math.max(a, to);
    const { lo, hi } = secBounds(s); let clipped = false;
    if (barSec(a - 1) < lo - 1e-6) { a = Math.round(barIdx(lo)) + 1; clipped = true; }
    if (barSec(z) > hi + 1e-6) { z = Math.floor(barIdx(hi) + 1e-6); clipped = true; }
    if (z < a) { status(`No room for ${s.name} there — move the next section first.`, 6000); return; }
    cchange(() => { s.start = barSec(a - 1); s.end = barSec(z); }, { label: `${s.name} bars ${a}–${z}` }); renderAll();
    if (clipped) status(`${s.name} stops where the next section starts (bars ${a}–${z}) — sections can't overlap.`, 6000);
  }
  function sectionAddItems(sec) { const bar = barOf(sec); return [{ title: `New section at bar ${bar}` }, ...CB.SECTION_NAMES.map((n) => ({ label: n, action: () => addSection(n, sec), disabled: ro() })), { label: 'Custom…', action: async () => { const n = await promptName(`Section name (bar ${bar})`, ''); if (n) addSection(n.slice(0, 40), sec); }, disabled: ro() }, ...(liveSections().length ? ['sep', { label: 'Restructure song…', action: () => openRestructure().catch(fail), disabled: ro() }] : [])]; }
  const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  function renderSectionLane(w) {
    const lane = $('#section-lane'); lane.innerHTML = ''; lane.style.width = `${w}px`;
    const secs = liveSections();
    if (!secs.length) lane.append(el('span', 'lane-hint', ro() ? 'no sections yet' : 'click to mark Intro / Verse / Chorus…'));
    for (const s of secs) {
      const b = el('div', 'section-block'); b.dataset.id = s.id; b.textContent = s.name; if (s.key) b.append(el('span', 'skey', s.key)); if (s.bpm || s.timeSig) b.append(el('span', 'skey smeter', `${Math.round(s.bpm || engine.bpm)} · ${MT.tsLabel(s.timeSig || engine.timeSig)}`));
      { const g = linkOn(TPL.sectionType(s.name)) ? linkInfoCache()[TPL.sectionType(s.name)] : null; if (g) { if (g.room && g.room.id === s.id) b.classList.add('room', 'linked'); else if (s.unlinked) b.classList.add('unlinked'); else b.classList.add('linked'); } }
      b.style.left = `${s.start * state.pxPerSec}px`; b.style.width = `${Math.max(6, (s.end - s.start) * state.pxPerSec)}px`; b.style.background = s.color || CB.sectionColor(s.name);
      b.title = `${s.name} · bars ${barOf(s.start)}–${endBarNo(s.end)}${s.bpm || s.timeSig ? ` · ${s.bpm || engine.bpm} bpm ${MT.tsLabel(s.timeSig || engine.timeSig)}` : ''} · click: go there · drag: move · drag an edge: resize · double-click: loop · right-click: options`;
      const hl = el('div', 'edge left'), hr = el('div', 'edge right'); b.append(hl, hr);
      b.addEventListener('click', (e) => { e.stopPropagation(); if (b._dragged) return; engine.seek(s.start); positionPlayhead(); });
      b.addEventListener('dblclick', (e) => { e.stopPropagation(); loopSection(s); });
      // Smooth dragging: the block follows the mouse exactly; a ghost shows where it will land (bars), and it
      // settles there on release. Drag the body to move, drag an edge to resize. A plain click still jumps there.
      const dragSection = (e, mode) => {
        if (e.button !== 0 || ro()) return; e.stopPropagation(); e.preventDefault();
        const x0 = e.clientX, a0 = s.start, z0 = s.end, len = z0 - a0, bar = barLen(), pps = state.pxPerSec; let moved = false, na = a0, nz = z0; let gs = gridStep(); let free = false;
        const sn = (v) => snapG(v, free, gs);
        const { lo: loB, hi: hiB } = secBounds(s);   // stays between its neighbours
        const ghost = el('div', 'sec-ghost'); const tip = el('div', 'sec-tip');
        const show = (ra, rz) => {
          b.style.left = `${ra * pps}px`; b.style.width = `${Math.max(6, (rz - ra) * pps)}px`;
          ghost.style.left = `${na * pps}px`; ghost.style.width = `${(nz - na) * pps}px`;
          tip.textContent = `${s.name}: ${posFine(na, gs)} → ${posFine(nz, gs)}${free ? ' (no snap)' : ` · snap ${gridLabel(gs)}`}`; tip.style.left = `${na * pps}px`;
          if (!ghost.isConnected) { lane.append(ghost); lane.append(tip); }
        };
        const move = (ev) => {
          const dx = (ev.clientX - x0) / pps; if (!moved && Math.abs(ev.clientX - x0) < 3) return; moved = true; b._dragged = true; b.classList.add('dragging'); document.body.classList.add('sec-dragging');
          let ra = a0, rz = z0; free = ev.altKey; const minL = free ? 0.05 : gs;
          if (mode === 'move') { ra = Math.max(0, a0 + dx); rz = ra + len; na = freeSpot(s, sn(ra), len); nz = na + len; }
          else if (mode === 'start') { ra = Math.max(0, Math.min(z0 - minL, a0 + dx)); na = Math.max(loB, Math.min(z0 - minL, sn(ra))); nz = z0; }
          else { rz = Math.max(a0 + minL, z0 + dx); nz = Math.min(hiB, Math.max(a0 + minL, sn(rz))); na = a0; }
          show(ra, rz);
        };
        const up = () => {
          window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); ghost.remove(); tip.remove(); b.classList.remove('dragging'); document.body.classList.remove('sec-dragging');
          if (moved && mode === 'move' && s.carry && Math.abs(na - a0) > 1e-6) {   // "takes move with this part": the part and everything in it go to the new spot
            const d = na - a0; partOp(`moved ${s.name} with its takes to ${posFine(na, gs)}`, () => {
              cutAllAt(a0); cutAllAt(z0);
              for (const [, c] of clipsInside(a0, z0)) c.start += d;
              for (const k of ['chords', 'markers']) for (const x of CB.live(CB.list(state.song, k))) if (inRange(x.time, a0, z0)) x.time += d;
              for (const l of liveLyrics()) if (typeof l.time === 'number' && inRange(l.time, a0, z0)) l.time += d;
              s.start = na; s.end = nz;
            });
          } else if (moved && (Math.abs(na - a0) > 1e-6 || Math.abs(nz - z0) > 1e-6)) { cchange(() => { s.start = na; s.end = nz; }, { label: mode === 'move' ? `move ${s.name} to ${posFine(na, gs)}` : `resize ${s.name} (${posFine(na, gs)} → ${posFine(nz, gs)})` }); renderAll(); if (mode === 'move') status(`${s.name} moved to ${posFine(na, gs)} → ${posFine(nz, gs)}. Only the marker moved — Restructure (right-click) moves the takes too.`, 6000); }
          else { b.style.left = `${a0 * pps}px`; b.style.width = `${Math.max(6, len * pps)}px`; }
          setTimeout(() => { b._dragged = false; }, 0);
        };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      };
      hl.addEventListener('mousedown', (e) => dragSection(e, 'start'));
      hr.addEventListener('mousedown', (e) => dragSection(e, 'end'));
      b.addEventListener('mousedown', (e) => { if (e.target === hl || e.target === hr) return; dragSection(e, 'move'); });
      M.attach(b, () => sectionMenu(s));
      lane.append(b);
    }
  }
  (function wireSectionLane() {
    const lane = $('#section-lane');
    const secAt = (e) => Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / state.pxPerSec);
    lane.addEventListener('click', (e) => { if (e.target !== lane && !e.target.classList.contains('lane-hint')) return; if (!state.folder) return; M.show(e.clientX, e.clientY, sectionAddItems(secAt(e))); });
    M.attach(lane, (e) => (e.target.closest && e.target.closest('.section-block') ? null : state.folder ? sectionAddItems(secAt(e)) : null));
  })();

  // ---------- chord lane ----------
  const liveChords = () => CB.byTime(CB.list(state.song, 'chords'));
  const snapBeat = (sec) => snapG(sec, false, Math.min(engine.beatLen(), gridStep()));   // chords: the zoom's grid (never coarser than a beat)
  // Chord picker: the chords that fit the song's key (or the key the existing chords suggest), common progressions
  // laid bar by bar from here, or type anything.
  function songKeyOrGuess() { return (state.song && state.song.key) || MU.guessKey(liveChords().map((c) => c.chord)) || ''; }
  function setChordAt(at, chord) {
    at = toRoomTime(at);   // a chord set in a linked copy goes in the room: every copy gets it
    const existing = liveChords().find((c) => Math.abs(c.time - at) < 1e-3);
    cchange(() => { if (existing) { existing.chord = chord; delete existing.det; delete existing.conf; } else (state.song.chords = state.song.chords || []).push({ id: newId(), time: at, chord, by: me(), at: nowIso() }); }, { label: `chord ${chord} at ${posLabel(at)}` });
    renderAll();
  }
  function chordPickItems(sec) {
    const at = snapBeat(sec); const key = keyAt(at) || songKeyOrGuess(); const dia = MU.diatonic(key); const bar = barOf(at);
    const items = [{ title: `Chord at ${posLabel(at)}${key ? ` · key ${key}${state.song.key ? '' : ' (guessed)'}` : ''}` }];
    if (dia.length) for (const d of dia) items.push({ label: `${d.chord}`, hint: d.roman, action: () => setChordAt(at, d.chord) });
    if (dia.length) items.push({ label: 'Progression from here (4 bars)', sub: MU.progressionsFor(key).map((p) => ({ label: `${p.name}: ${p.chords.join(' ')}`, action: () => { setChordBars(bar, p.chords.join(' | ')); } })) });
    items.push('sep', { label: 'Type a chord…', action: () => addChordAt(sec) });
    if (!state.song.key) items.push({ label: 'Set the song key…', sub: MU.diatonic('C').length ? window.BPTemplates.KEYS.filter(Boolean).map((k) => ({ label: k, checked: k === key, action: () => { change(() => { state.song.key = k; }, { label: `key ${k}` }); renderAll(); } })) : [] });
    return items;
  }
  async function addChordAt(sec) {
    if (ro()) { status('Read-only — take over to add chords.'); return; }
    const at = toRoomTime(snapBeat(sec)); const existing = liveChords().find((c) => Math.abs(c.time - at) < 1e-3);
    const v = await promptName(`Chord at ${posLabel(at)} (e.g. G, Em7, D/F#)`, existing ? existing.chord : '');
    if (v === null) return;
    let chord = v.trim(); chord = chord ? chord.charAt(0).toUpperCase() + chord.slice(1) : '';
    if (chord && !/^([A-G][#b♯♭]?[A-Za-z0-9#b♯♭+°ø()\-]{0,10}(\/[A-G][#b♯♭]?)?|N\.?C\.?)$/.test(chord)) { status(`"${v.trim().slice(0, 20)}" doesn't look like a chord — try G, Em7, Dsus4, D/F# or N.C.`, 7000); return; }
    cchange(() => { if (existing) { if (chord) { existing.chord = chord; delete existing.det; delete existing.conf; } else { existing.deleted = true; existing.deletedBy = me(); } } else if (chord) (state.song.chords = state.song.chords || []).push({ id: newId(), time: at, chord, by: me(), at: nowIso() }); }, { label: chord ? `chord ${chord} at ${posLabel(at)}` : 'delete chord' });
    renderAll();
  }
  function setChordBars(fromBar, text) {
    fromBar = Math.round(barIdx(toRoomTime(barSec(fromBar - 1)))) + 1;   // in a linked copy: the room's bars
    const parsed = CB.parseChordBars(text); if (!parsed.length) { status('No chords recognised — use names like G D Em C (a "|" separates bars).', 8000); return 0; }
    const t0 = barSec(fromBar - 1); const nBars = Math.max(...parsed.map((x) => x.bar)) + 1; const t1 = barSec(fromBar - 1 + nBars);
    cchange(() => {
      for (const c of liveChords()) if (c.time >= t0 - 1e-6 && c.time < t1 - 1e-6) { c.deleted = true; c.deletedBy = me(); }
      for (const x of parsed) (state.song.chords = state.song.chords || []).push({ id: newId(), time: barSec(fromBar - 1 + x.bar + x.frac), chord: x.chord, by: me(), at: nowIso() });
    }, { label: `chords bars ${fromBar}–${fromBar + nBars - 1}` });
    renderAll(); return parsed.length;
  }
  async function typeChords(fromBar) { const v = await promptName(`Chords from bar ${fromBar} — one per bar, "|" between bars for two in a bar (e.g. G D Em C  or  G | D A | Em)`, ''); if (v) { const n = setChordBars(fromBar, v); if (n) status(`${n} chord${n > 1 ? 's' : ''} from bar ${fromBar}.`); } }
  function chordLaneItems(sec) { const bar = barOf(sec); return [{ title: `Chords · ${posLabel(snapBeat(sec))}` }, { label: 'Chord here', sub: chordPickItems(sec).slice(1), disabled: ro() }, { label: `Type chords from bar ${bar}…`, action: () => typeChords(bar), disabled: ro() }, ...(CB.sectionAt(state.song, sec) ? [{ label: `Type chords for ${CB.sectionAt(state.song, sec).name}…`, action: () => typeChords(barOf(CB.sectionAt(state.song, sec).start)), disabled: ro() }] : []), 'sep', { label: 'Clear all chords', danger: true, action: async () => { const a = await ask('Clear chords', `Remove all ${liveChords().length} chords? (${MOD}+Z undoes)`, [['Clear', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a === 'ok') { cchange(() => { for (const c of liveChords()) { c.deleted = true; c.deletedBy = me(); } }, { label: 'clear chords' }); renderAll(); } }, disabled: ro() || !liveChords().length }]; }
  function renderChordLane(w) {
    const lane = $('#chord-lane'); lane.innerHTML = ''; lane.style.width = `${w}px`;
    const cs = liveChords();
    if (!cs.length) lane.append(el('span', 'lane-hint', ro() ? 'no chords yet' : 'click a beat to add a chord · right-click to type a whole progression'));
    cs.forEach((c, i) => {
      const next = cs[i + 1]; const wpx = Math.max(18, ((next ? next.time : c.time + barLenAt(c.time)) - c.time) * state.pxPerSec);
      const chip = el('div', 'chord-chip' + (c.det ? ' det' : ''), c.chord); chip.dataset.id = c.id; if (c.det) chip.title = `heard from the recordings${c.conf != null ? ` (${Math.round(c.conf * 100)}% sure)` : ''} — click to change it`; chip.style.left = `${c.time * state.pxPerSec}px`; chip.style.width = `${Math.min(wpx, 400)}px`;
      chip.title = `${c.chord} at ${posLabel(c.time)} · click to change · right-click: options`;
      chip.addEventListener('click', (e) => { e.stopPropagation(); addChordAt(c.time); });
      M.attach(chip, () => [{ title: `${c.chord} · ${posLabel(c.time)}` }, { label: 'Change…', action: () => addChordAt(c.time), disabled: ro() }, { label: 'Move to playhead', action: () => { cchange(() => { c.time = snapBeat(engine.playhead); delete c.det; delete c.conf; }, { label: `move chord ${c.chord}` }); renderAll(); }, disabled: ro() }, { label: 'Go there', action: () => { engine.seek(c.time); positionPlayhead(); } }, { label: 'Delete', danger: true, action: () => { cchange(() => { c.deleted = true; c.deletedBy = me(); }, { label: `delete chord ${c.chord}` }); renderAll(); }, disabled: ro() }]);
      lane.append(chip);
    });
  }
  (function wireChordLane() {
    const lane = $('#chord-lane');
    const secAt = (e) => Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / state.pxPerSec);
    lane.addEventListener('click', (e) => { if (e.target !== lane && !e.target.classList.contains('lane-hint')) return; if (!state.folder) return; if (ro()) { status('Read-only — take over to add chords.'); return; } M.show(e.clientX, e.clientY, chordPickItems(secAt(e))); });
    M.attach(lane, (e) => (e.target.closest && e.target.closest('.chord-chip') ? null : state.folder ? chordLaneItems(secAt(e)) : null));
  })();

  // ---------- lyrics with timestamps ----------
  const liveLyrics = () => CB.live(CB.list(state.song, 'lyrics'));
  const lyricsOrdered = () => { const all = liveLyrics(); return [...all.filter((l) => typeof l.time === 'number').sort((a, b) => a.time - b.time), ...all.filter((l) => typeof l.time !== 'number')]; };
  const nextUnpinned = () => liveLyrics().find((l) => typeof l.time !== 'number') || null;
  function linesDialog(title, hint, initial = '') {
    return new Promise((resolve) => { const d = $('#lines'); $('#lines-title').textContent = title; $('#lines-hint').textContent = hint; $('#lines-input').value = initial; d.returnValue = ''; d.showModal(); setTimeout(() => $('#lines-input').focus(), 0); d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? $('#lines-input').value : null), { once: true }); });
  }
  function addLyricLines(text, { time = null } = {}) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.slice(0, 200));
    if (!lines.length) return 0;
    cchange(() => { const arr = state.song.lyrics = state.song.lyrics || []; lines.forEach((l, i) => arr.push({ id: newId(), time: time !== null && i === 0 ? time : null, text: l, by: me(), at: nowIso() })); }, { label: `${lines.length} lyric line${lines.length > 1 ? 's' : ''}` });
    renderAll(); return lines.length;
  }
  function pinNextLyric() {
    if (ro()) { status('Read-only — take over to pin lyrics.'); return; }
    const l = nextUnpinned(); if (!l) { status(liveLyrics().length ? 'Every lyric line is pinned. Right-click a line to re-pin it.' : 'No lyrics yet — "Add lines…" in the Lyrics tab first.'); return; }
    const at = Math.max(0, engine.playhead - (engine.playing ? 0.12 : 0));   // a pin pressed while listening lands a hair late; pull it back
    cchange(() => { l.time = at; }, { label: `pin lyric "${l.text.slice(0, 30)}"` });
    renderAll(); status(`Pinned "${l.text.slice(0, 40)}" at ${posLabel(at)}${nextUnpinned() ? ` — next: "${nextUnpinned().text.slice(0, 40)}"` : ' — all lines pinned'}.`);
  }
  function lyricMenu(l0) {
    const l = liveLyrics().find((x) => x.id === l0.id); if (!l) return [{ title: 'line is gone' }];
    return [
      { title: typeof l.time === 'number' ? posLabel(l.time) : 'not pinned yet' },
      ...(typeof l.time === 'number' ? [{ label: 'Go there', action: () => { engine.seek(l.time); positionPlayhead(); } }] : []),
      { label: 'Pin at the playhead', action: () => { cchange(() => { l.time = engine.playhead; }, { label: 'pin lyric' }); renderAll(); }, disabled: ro() },
      { label: 'Unpin', action: () => { cchange(() => { l.time = null; }, { label: 'unpin lyric' }); renderAll(); }, disabled: ro() || typeof l.time !== 'number' },
      { label: 'Edit…', action: async () => { const v = await promptName('Lyric line', l.text); if (v) { cchange(() => { const old = Array.isArray(l.words) && l.words.length ? l.words : null; l.text = v.slice(0, 200); if (old) { const w = ASR.alignWords(old, l.text); if (w) l.words = w; } if (l.asr) { l.edited = true; l.by = me(); } }, { label: 'edit lyric' }); renderAll(); } }, disabled: ro() },   /* word timings follow the fix (relative times in, relative out) */
      { label: 'Insert a line after…', action: async () => { const v = await promptName('New lyric line', ''); if (!v) return; cchange(() => { const arr = state.song.lyrics; const i = arr.indexOf(l); arr.splice(i + 1, 0, { id: newId(), time: null, text: v.slice(0, 200), by: me(), at: nowIso() }); }, { label: 'add lyric line' }); renderAll(); }, disabled: ro() },
      { label: 'Note here…', action: () => addNote(null, typeof l.time === 'number' ? l.time : engine.playhead) },
      { label: 'Delete line', danger: true, action: () => { cchange(() => { l.deleted = true; l.deletedBy = me(); }, { label: 'delete lyric line' }); renderAll(); }, disabled: ro() },
    ];
  }
  function renderLyrics() {
    const ul = $('#lyric-list'); ul.innerHTML = ''; const ls = lyricsOrdered(); const nx = nextUnpinned(); const now = CB.lyricAt(state.song, engine.playhead);
    const pinned = ls.filter((l) => typeof l.time === 'number').length;
    $('#lyrics-hint').textContent = !ls.length ? 'No lyrics yet. "Add lines…", then play the song and press P as each line starts.' : pinned < ls.length ? `${pinned}/${ls.length} lines pinned. Play and press P (or "Pin next") when the dashed line starts.` : `${ls.length} lines, all pinned. Click a line to jump there.`;
    $('#btn-lyric-pin').disabled = ro() || !nx; $('#btn-lyrics-paste').disabled = ro();
    for (const l of ls) {
      const pinnedL = typeof l.time === 'number';
      const li = el('li', (pinnedL ? '' : 'unpinned') + (now && now.id === l.id ? ' now' : '') + (nx && nx.id === l.id ? ' next' : '')); li.dataset.id = l.id;
      li.append(el('span', 'lt', pinnedL ? posLabel(l.time).replace('bar ', '') : '—'), el('span', 'ltext', l.text));
      li.title = pinnedL ? `${posLabel(l.time)} — click to jump, right-click for options` : 'not pinned yet — press P while playing, or right-click → Pin at the playhead';
      li.addEventListener('click', () => { if (pinnedL) { engine.seek(l.time); positionPlayhead(); } });
      M.attach(li, () => lyricMenu(l)); ul.append(li);
    }
    lyricShownId = now ? now.id : null;
  }
  let lyricShownId = null;
  function followLyric(force = false) {
    if (!state.song) return;
    const now = CB.lyricAt(state.song, engine.playhead); const id = now ? now.id : null;
    if (id === lyricShownId && !force) return; lyricShownId = id;
    const ul = $('#lyric-list'); for (const li of ul.children) li.classList.toggle('now', li.dataset.id === id);
    if (id && tabShown('lyrics')) { const li = ul.querySelector(`li[data-id="${id}"]`); if (li) li.scrollIntoView({ block: 'nearest' }); }
  }
  $('#btn-lyrics-paste').addEventListener('click', async () => { if (ro()) return; const v = await linesDialog('Add lyric lines', 'One line per row. They start unpinned: play the song and press P (or "Pin next") as each line is sung.'); if (v) { const n = addLyricLines(v); if (n) status(`${n} line${n > 1 ? 's' : ''} added — play and press P to pin each one.`); } });
  $('#btn-lyric-pin').addEventListener('click', () => pinNextLyric());
  // ---------- speech-to-text: lyrics from vocal takes (asr.js — Whisper on this computer) ----------
  const ASR = window.BPAsr;
  let asrBusy = null;
  const asrModel = () => (state.settings && state.settings.asrModel) || 'small.en';
  const isVocalTrack = (t) => t && (t.type === 'vocals' || /vox|vocal|voice|sing/i.test(t.name || '')) && t.instrument === 'audio';
  // transcribe takes (audio clips) → timed lyric lines (each with word timings for karaoke); replaces lines this take made before
  async function transcribeClips(list, { replace = true } = {}) {
    if (asrBusy) { status('Already transcribing — one at a time.'); return asrBusy; }
    // works read-only too: lyrics are a band collection (a bandmate's open copy folds them in, like notes)
    const items = list.filter(({ c }) => c && c.kind !== 'midi' && engine.buffers.get(audioId(c)));
    if (!items.length) { status('Nothing to transcribe: pick an audio take with singing on it.', 6000); return null; }
    const closeProg = toast('Speech-to-text: getting ready…', { ms: 900000 }); const progEl = $('#toasts').lastElementChild;
    const setP = (txt) => { const n = progEl && progEl.querySelector('.toast-text'); if (n) n.textContent = txt; };
    asrBusy = (async () => {
      let made = 0; const all = [];
      try {
        for (let i = 0; i < items.length; i++) {
          const { t, c } = items[i]; const buf = engine.buffers.get(audioId(c));
          const from = c.trimStart || 0, to = Math.max(from, (c.duration || buf.duration) - (c.trimEnd || 0));
          setP(`Speech-to-text: ${c.name} on ${t.name} (${i + 1}/${items.length})…`);
          const r = await ASR.transcribe(buf, { from, to, model: asrModel(), bridge: bp.asr, onProgress: (p) => setP(`Downloading the speech model (once per computer): ${Math.round(p.pct || 0)}% of ${p.file || ''}`) });
          for (const l of r.lines) all.push({ ...l, t, c, at: c.start + l.time, words: l.words.map((w) => ({ w: w.w, t: Math.round((w.t - l.time) * 1000) / 1000, e: Math.round((w.e - l.time) * 1000) / 1000 })) });   // word times relative to the line: every lyric mover just works
        }
        if (!all.length) { status("Didn't hear any words — is there singing on that take (and not just instruments)?", 8000); return 0; }
        all.sort((a, b) => a.at - b.at);
        const srcIds = new Set(items.map(({ c }) => c.src || c.id));
        // words someone already typed win: those lines get pinned where they're sung (with word timings) instead of
        // being duplicated; only what nobody typed is added as new lines
        const lo = Math.min(...items.map(({ c }) => c.start)) - 2, hi = Math.max(...items.map(({ c }) => clipEnd(c))) + 2;
        const typed = liveLyrics().filter((l) => !l.asr && String(l.text || '').trim() && (typeof l.time !== 'number' || (l.time >= lo && l.time <= hi)))   /* typed lines here (pinned before or not) are re-pinned, never duplicated */
          .map((l, k) => ({ l, k })).sort((a, b) => (typeof a.l.time === 'number' ? a.l.time : Infinity) - (typeof b.l.time === 'number' ? b.l.time : Infinity) || a.k - b.k).map((x) => x.l);
        const heard = all.map((l) => ({ ...l, time: l.at, end: l.at + (l.end - l.time), words: l.words.map((w) => ({ w: w.w, t: l.at + w.t, e: l.at + w.e })) }));
        const al = ASR.alignToTyped(typed.map((l) => ({ id: l.id, text: l.text })), heard);
        const extra = new Set(al.extra); const pinned = al.matches.length; const added = all.filter((_, i) => extra.has(heard[i])).length; made = pinned + added;
        cchange(() => {
          const arr = state.song.lyrics = state.song.lyrics || [];
          if (replace) for (const l of arr) if (!l.deleted && l.asr && srcIds.has(l.asr)) { l.deleted = true; l.deletedBy = me(); }
          for (const m of al.matches) { const l = arr.find((x) => x.id === m.id); if (!l) continue; l.time = Math.max(0, m.time); l.words = m.words.slice(0, 60).map((w) => ({ w: w.w, t: Math.round((w.t - l.time) * 1000) / 1000, e: Math.round((w.e - l.time) * 1000) / 1000 })); { const h = heard.find((x) => m.time >= x.time - 0.05 && m.time <= x.end + 0.05); l.heardFrom = h ? (h.c.src || h.c.id) : null; } }
          all.forEach((l, i) => { if (!extra.has(heard[i])) return; arr.push({ id: newId(), time: Math.max(0, l.at), text: l.text.slice(0, 200), words: l.words.slice(0, 40), asr: l.c.src || l.c.id, by: me(), at: nowIso() }); });
        }, { label: `lyrics from ${items.length === 1 ? items[0].c.name : `${items.length} takes`} (speech-to-text, ${made} lines)` });
        renderAll(); showTab('lyrics');
        status(`${pinned ? `${pinned} of your typed line${pinned === 1 ? '' : 's'} pinned where ${pinned === 1 ? "it's" : "they're"} sung` : ''}${pinned && added ? ', ' : ''}${added ? `${added} new line${added === 1 ? '' : 's'} from the singing` : ''}${!made ? 'Nothing new heard' : ''}. Fix any word: right-click the line → Edit. ${MOD}+Z undoes.`, 10000);
        return made;
      } catch (err) { fail(new Error(`Speech-to-text failed: ${err.message || err}`)); return 0; }
      finally { asrBusy = null; closeProg(); }
    })();
    return asrBusy;
  }
  const audibleTakes = (t) => t.clips.filter((c) => !c.link && !engine.clipMuted(c) && c.kind !== 'midi');
  function transcribeTrack(t) { return transcribeClips(audibleTakes(t).map((c) => ({ t, c }))); }
  // the lead vocal first; harmony / double / backing tracks only where the lead isn't singing (no duplicate lines)
  const isBackingVocal = (t) => /harm|backing|bgv|\bbv\b|double|dbl|oohs?|choir|gang/i.test(`${t.name} ${t.preset || ''}`);
  function vocalPlan() {
    const vt = engine.tracks.filter(isVocalTrack); if (!vt.length) return [];
    const lead = vt.filter((t) => !isBackingVocal(t)); const back = vt.filter(isBackingVocal);
    const out = []; const covered = [];
    for (const t of lead.length ? lead : back.slice(0, 1)) for (const c of audibleTakes(t)) { if (covered.some(([a, b]) => c.start < b - 0.5 && clipEnd(c) > a + 0.5)) continue; out.push({ t, c }); covered.push([c.start, clipEnd(c)]); }
    for (const t of lead.length ? back : back.slice(1)) for (const c of audibleTakes(t)) if (!covered.some(([a, b]) => c.start < b - 0.5 && clipEnd(c) > a + 0.5)) { out.push({ t, c }); covered.push([c.start, clipEnd(c)]); }
    return out.sort((a, b) => a.c.start - b.c.start);
  }
  async function transcribeSong() {
    const plan = vocalPlan();
    if (!plan.length) { status(engine.tracks.some(isVocalTrack) ? 'The vocal tracks have no audible takes to listen to.' : 'No vocal track found — right-click the take you want transcribed → Lyrics from this take.', 8000); return null; }
    return transcribeClips(plan);
  }
  $('#btn-lyrics-asr').addEventListener('click', () => transcribeSong());
  // ---------- chords heard from the recordings (chordsdetect.js) ----------
  // Guitar / keys / bass takes → a chord per half bar (Viterbi-smoothed, key-aware, slash chords from the bass), drafted
  // into the chord lane only where nobody has put chords yet (or over earlier drafts). MIDI parts are read note by note.
  const CD = window.BPChordDetect, AMX = window.BPAutoMix, TG = window.BPTighten, PC = window.BPPitchCheck;
  const harmonicTrack = (t) => { const r = AMX.role(t); return r === 'gtr' || r === 'keys' || r === 'synth' || r === 'other'; };
  const bassTrack = (t) => AMX.role(t) === 'bass';
  const mono = (chs) => { if (chs.length === 1) return chs[0]; const n = chs[0].length, m = new Float32Array(n); for (const c of chs) for (let i = 0; i < n; i++) m[i] += c[i] / chs.length; return m; };
  let chordBusy = null;
  async function chordsFromTracks(list = null, { replaceDrafts = true } = {}) {
    if (chordBusy) { status('Already listening for chords — one moment.'); return chordBusy; }
    if (!state.folder) throw new Error('no song open');
    await engine.init();
    const len = engine.contentLength(); if (!len) { status('Nothing recorded yet.'); return 0; }
    const tracks = (list || engine.tracks.filter((t) => harmonicTrack(t) || bassTrack(t))).filter((t) => engine.audible(t) && t.clips.some((c) => !engine.clipMuted(c)));
    const harm = tracks.filter((t) => !bassTrack(t)); const bass = tracks.filter(bassTrack);
    if (!harm.length && !bass.length) { status('No guitar / keys / bass track with audible takes to listen to.', 7000); return 0; }
    chordBusy = (async () => {
      const close = toast('Listening for chords…', { ms: 600000 });
      try {
        const map = engine.meterMap(); const bl = window.BPMeter.beatsIn(map, 0, len); const beats = bl.map((b) => b.t); const barStarts = bl.filter((b) => b.beat === 0).map((b) => b.t);
        let found = [];
        const midiTracks = harm.filter((t) => t.clips.some((c) => c.kind === 'midi')); const audioHarm = harm.filter((t) => t.instrument === 'audio');
        const sum = async (ts) => { let acc = null, sr = 48000; for (const t of ts) { const r = await engine.render({ soloTrackId: t.id, from: 0, to: len, unityMaster: true, exact: true, limiter: false }); const m = mono(r.channels); sr = r.sampleRate; if (!acc) acc = new Float32Array(m.length); for (let i = 0; i < Math.min(acc.length, m.length); i++) acc[i] += m[i]; } return acc ? { x: acc, sr } : null; };
        const H = await sum(audioHarm.length ? audioHarm : bass); const B = bass.length && audioHarm.length ? await sum(bass) : null;
        if (H) found = CD.detect({ audio: H.x, sr: H.sr, beats, barStarts, bassAudio: B ? B.x : null, key: state.song.key || null });
        if (!found.length && midiTracks.length) {
          const notes = []; for (const t of midiTracks) for (const c of t.clips) if (c.kind === 'midi' && !engine.clipMuted(c)) for (const n of c.notes || []) { const at = c.start + n.t - (c.trimStart || 0); if (at >= c.start - 1e-6 && at < clipEnd(c)) notes.push({ t: at, d: n.d, n: n.n, v: n.v }); }
          found = CD.fromNotes(notes, { beats, barStarts, key: state.song.key || null });
        }
        if (!found.length) { status("Couldn't hear clear chords in those takes.", 7000); return 0; }
        const kh = found.keyHeard; const keyNow = state.song.key || '';
        if (kh && kh.confidence >= 0.6 && kh.key !== keyNow && !sameNotes(kh.key, keyNow)) toast(`The bass line says this song is in ${kh.key}${keyNow ? `, not ${keyNow}` : ''} — the chords were named in ${kh.key}.`, { kind: 'warn', ms: 20000, buttons: [[`Set the key to ${kh.key}`, () => setSongKey(kh.key, 'bass line')], ...(keyNow ? [[`Keep ${keyNow}`, () => {}]] : [])] });
        const have = liveChords(); const barOfT = (t) => { let k = -1; for (let i = 0; i < barStarts.length; i++) if (barStarts[i] <= t + 1e-3) k = i; else break; return k; };
        const keptBars = new Set(have.filter((c) => !(replaceDrafts && c.det)).map((c) => barOfT(c.time)));
        // linked copies take their chords from the room (a chord of their own would unlink them): listen there only
        const followers = Object.values(TPL.linkInfo(collectSong()) || {}).flatMap((g) => g.followers);
        const inFollower = (t) => followers.some((f) => t >= f.start - 1e-3 && t < f.end - 1e-3);
        // bars where none of the listened tracks has an audible take stay blank — no guessing over silence
        const covered = (t) => tracks.some((tr) => tr.clips.some((c) => !engine.clipMuted(c) && c.start - 0.05 <= t && clipEnd(c) + 0.05 > t));
        const add = found.filter((f) => !keptBars.has(barOfT(f.time)) && !inFollower(f.time) && covered(f.time + 0.1));
        if (!add.length) { status('Every bar already has chords — nothing to add (chords you typed always win).', 7000); return 0; }
        cchange(() => {
          const arr = state.song.chords = state.song.chords || [];
          if (replaceDrafts) for (const c of arr) if (!c.deleted && c.det && !keptBars.has(barOfT(c.time))) { c.deleted = true; c.deletedBy = me(); }
          for (const f of add) arr.push({ id: newId(), time: Math.round(f.time * 1000) / 1000, chord: f.chord, by: me(), at: nowIso(), det: true, conf: Math.round((f.conf || 0) * 100) / 100 });
        }, { label: `chords from the recordings (${add.length})` });
        renderAll(); if (tabShown('chart')) renderChart();
        toast(`${add.length} chord${add.length === 1 ? '' : 's'} heard from ${tracks.map((t) => t.name).join(', ')} — drafted in the chord lane (dotted until someone edits them). Chords you typed were left alone. ${MOD}+Z undoes.`, { kind: 'ok', ms: 10000 });
        if (!state.song.key && add.length >= 4) maybeAutoKey && maybeAutoKey();
        return add.length;
      } finally { close(); chordBusy = null; }
    })();
    return chordBusy;
  }

  // ---------- your phone as a practice screen (main.js serves phone.html on the home network) ----------
  async function openPhoneLink() {
    const inf = await bp.phone.start(); const urls = (inf && inf.urls) || [];
    if (!urls.length) { toast('No home-network connection found on this computer (Wi-Fi or Ethernet) — the phone page needs both on the same network.', { kind: 'warn', ms: 12000 }); return null; }
    const url = urls[0].url;
    const d = $('#ask'); $('#ask-title').textContent = '📱 Practice on your phone';
    const box = $('#ask-text'); box.textContent = '';
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    const pic = el('div', 'qr'); pic.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    box.append(el('div', null, 'Point your phone camera at this (same Wi-Fi as this computer). It follows the song live — words, chords, the part you\'re in — and has play / pause and part skips.'), pic, el('div', 'mono small', url));
    if (urls.length > 1) box.append(el('div', 'muted small', `Other addresses: ${urls.slice(1).map((u) => u.url.replace(/\?k=.*/, '')).join(', ')}`));
    box.append(el('div', 'muted small', 'Windows may ask to let Cobander on the network the first time — allow it on Private networks. Anyone with this link on your Wi-Fi can follow along; "New link" retires it.'));
    const menu = $('#ask-menu'); menu.innerHTML = '';
    for (const [label, value, cls] of [['Copy link', 'copy', ''], ['New link', 'new', ''], ['Turn off', 'off', ''], ['Done', '', 'primary']]) { const b = el('button', cls, label); b.value = value; menu.append(b); }
    d.returnValue = ''; d.showModal();
    const v = await new Promise((r) => d.addEventListener('close', () => r(d.returnValue), { once: true }));
    if (v === 'copy') { await navigator.clipboard.writeText(url); status('Phone link copied.'); }
    else if (v === 'new') { await bp.phone.newKey(); return openPhoneLink(); }
    else if (v === 'off') { await bp.phone.stop(); status('Phone page off.'); }
    return url;
  }
  // ---------- Auto mix / Auto master (automix.js) + A/B before ⇄ after ----------
  const mixSnap = () => ({ tracks: engine.tracks.map((t) => ({ id: t.id, gainDb: t.gainDb, pan: t.pan, fx: JSON.parse(JSON.stringify(t.fx || {})) })), master: JSON.parse(JSON.stringify(engine.master)) });
  function applyMixSnap(sn) { for (const x of sn.tracks) if (engine.track(x.id)) engine.updateTrack(x.id, { gainDb: x.gainDb, pan: x.pan, fx: JSON.parse(JSON.stringify(x.fx)) }); engine.setMaster(JSON.parse(JSON.stringify(sn.master))); }
  state.mixAB = null;   // { before, after, showing: 'after'|'before', what }
  function mixABRender() { const b = $('#btn-mixab'); const ab = state.mixAB; b.disabled = !ab; b.classList.toggle('active', !!ab && ab.showing === 'before'); $('#mix-ab-state').textContent = ab ? (ab.showing === 'after' ? `hearing: ${ab.what}` : 'hearing: before') : ''; }
  function mixABToggle() {
    const ab = state.mixAB; if (!ab) return;
    // only while the mix is still exactly one of the two: a fader moved since, another song, an undo → the A/B is over
    if (ab.folder !== state.folder || JSON.stringify(mixSnap()) !== JSON.stringify(ab[ab.showing])) { state.mixAB = null; mixABRender(); status('The mix changed since Auto mix — A/B is off (Undo still steps back).', 6000); return; }
    const next = ab.showing === 'after' ? 'before' : 'after';
    if (!change(() => applyMixSnap(ab[next]), { label: `A/B: ${next}`, undoable: false, activity: false })) return;
    ab.showing = next; ab[next] = mixSnap(); renderMixer(); renderFx(); mixABRender();
  }
  $('#btn-mixab').addEventListener('click', mixABToggle);
  let mixBusy = false;
  async function autoMix() {
    if (mixBusy) return; if (!state.folder) throw new Error('no song open'); if (ro()) throw new Error('Read-only — take over first.');
    if (engine.tracks.some((t) => !mineT(t.id))) { status('Auto mix changes every track — Unlock all first.', 7000); return null; }
    await engine.init(); const len = engine.contentLength(); if (!len) { status('Nothing to mix yet.'); return null; }
    mixBusy = true; const close = toast('Auto mix: listening to each track…', { ms: 600000 }); const prog = $('#toasts').lastElementChild;
    try {
      if (engine.playing) await stop();
      const before = mixSnap(); const analysis = {};
      const live = engine.tracks.filter((t) => engine.audible(t) && (t.instrument === 'drumkit' || t.clips.some((c) => !engine.clipMuted(c))));
      for (let i = 0; i < live.length; i++) {
        const t = live[i]; const n = prog && prog.querySelector('.toast-text'); if (n) n.textContent = `Auto mix: listening to ${t.name} (${i + 1}/${live.length})…`;
        const r = await engine.render({ soloTrackId: t.id, from: 0, to: len, unityMaster: true, exact: true, limiter: false });
        const an = await engine.analyzeBuffer(engine.bufferFromRender(r));
        const g0 = Number(t.gainDb) || 0;   /* the render ran through the fader: take it back out so the plan's absolute fader values are right */
        analysis[t.id] = { lufs: an.lufsApprox - g0, peakDb: an.peakDbfs - g0, bands: an.bandsDbfs, shortTerm: AMX.shortTermLufs(r.channels, r.sampleRate).map((v) => (v <= -119 ? v : v - g0)) };
      }
      const plan = AMX.planMix(engine.tracks, analysis, { style: state.song.style || '' });
      const okm = change(() => { for (const [id, p] of Object.entries(plan.tracks)) { const t = engine.track(id); if (!t) continue; const nt = AMX.applyPlan(t, p); engine.updateTrack(id, { gainDb: nt.gainDb, pan: nt.pan, fx: nt.fx }); } }, { label: `auto mix (${Object.keys(plan.tracks).length} tracks)` });
      if (!okm) return null;
      const after = mixSnap(); state.mixAB = { before, after, showing: 'after', what: 'Auto mix', folder: state.folder }; mixABRender();
      renderMixer(); renderFx();
      const lines = AMX.diff(before.tracks.map((x) => ({ ...engine.track(x.id), ...x })), after.tracks.map((x) => ({ ...engine.track(x.id), ...x })));
      toast(`Auto mix done — a rough mix to start from. ${lines.slice(0, 6).join(' · ')}${lines.length > 6 ? ' …' : ''}`, { kind: 'ok', ms: 20000, buttons: [['A/B before ⇄ after', mixABToggle], ['Auto master too', () => autoMaster().catch(fail)], ['Undo', () => undo().catch(fail)]] });
      return { plan, lines };
    } finally { close(); mixBusy = false; }
  }
  async function autoMaster({ target = -14 } = {}) {
    if (mixBusy) return; if (!state.folder) throw new Error('no song open'); if (ro()) throw new Error('Read-only — take over first.');
    await engine.init(); const len = engine.contentLength(); if (!len) { status('Nothing to master yet.'); return null; }
    mixBusy = true; const close = toast('Auto master: measuring the mix…', { ms: 600000 });
    try {
      if (engine.playing) await stop();
      const before = state.mixAB && state.mixAB.folder === state.folder && state.mixAB.showing === 'after' && JSON.stringify(mixSnap()) === JSON.stringify(state.mixAB.after) ? state.mixAB.before : mixSnap();
      const r = await engine.render({ from: 0, to: len, unityMaster: true, exact: true, limiter: false });
      const an = await engine.analyzeBuffer(engine.bufferFromRender(r));
      const plan = AMX.planMaster({ lufs: an.lufsApprox, peakDb: an.peakDbfs }, { target });
      const okm = change(() => engine.setMaster({ gainDb: Math.round(plan.gainDb * 10) / 10, limiter: true }), { label: `auto master (${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)} dB → about ${Math.round(plan.expectedLufs)} LUFS)` });
      if (!okm) return null;
      state.mixAB = { before, after: mixSnap(), showing: 'after', what: state.mixAB ? 'Auto mix + master' : 'Auto master', folder: state.folder }; mixABRender(); renderMixer();
      toast(`Auto master: master ${plan.gainDb >= 0 ? '+' : ''}${plan.gainDb.toFixed(1)} dB, limiter on — about ${Math.round(plan.expectedLufs)} LUFS (streaming loud). ${plan.notes.slice(0, 2).join(' ')}`, { kind: 'ok', ms: 15000, buttons: [['A/B', mixABToggle], ['Undo', () => undo().catch(fail)]] });
      return plan;
    } finally { close(); mixBusy = false; }
  }
  $('#btn-automix').addEventListener('click', () => autoMix().catch(fail));
  $('#btn-chords-detect').addEventListener('click', () => chordsFromTracks().catch(fail));
  $('#btn-automaster').addEventListener('click', () => autoMaster().catch(fail));

  // ---------- tighten to the grid (tighten.js) ----------
  const GRIDS = [['1/4', 1], ['1/8', 2], ['1/16', 4], ['1/8 triplets', 3], ['1/16 triplets', 6]];
  const gridTimes = (sub) => (a, b) => { const out = []; for (const bt of window.BPMeter.beatsIn(engine.meterMap(), Math.max(0, a - 1), b + 1)) for (let k = 0; k < sub; k++) out.push(bt.t + k * bt.beatLen / sub); return out.filter((t) => t >= a - 0.2 && t <= b + 0.2); };
  async function tightenClipNow(t, c, { sub, strength, window: win }) {
    if (c.kind === 'midi') {
      const g = gridTimes(sub)(c.start - 1, clipEnd(c) + 1); const off = c.start - (c.trimStart || 0);
      const moved = TG.quantizeNotes((c.notes || []).map((n) => ({ ...n, t: off + n.t })), g, { strength }).map((n) => ({ ...n, t: Math.max(0, n.t - off) }));
      return { midi: moved };
    }
    const srcId = c.tt ? c.tt.src : audioId(c);   // always tighten from the original take, never a tightened copy
    let buf = engine.buffers.get(srcId); if (!buf) buf = await window.BPWav.decodeWav(engine.ctx, await bp.audio.read(state.folder, srcId));
    const chans = window.BPWav.audioBufferToChannels(buf);
    const res = TG.tightenClip({ channels: chans, sr: buf.sampleRate, clipStartInSong: c.start, trimStart: c.trimStart || 0, grid: gridTimes(sub), strength, window: win });
    return { res, srcId, sr: buf.sampleRate };
  }
  async function openTighten(t, clip) {
    if (!state.folder || !t) return; if (!canTouch(t)) { status('Unlock the track first.'); return; }
    const targets = (clip ? [clip] : t.clips.filter((c) => !c.link && !engine.clipMuted(c))).filter((c) => (c.kind === 'midi') === (t.instrument !== 'audio') || c.kind === 'midi');
    if (!targets.length) { status('No audible takes on that track to tighten.'); return; }
    let sub = 2, strength = 0.6; try { sub = Number(localStorage.getItem('bp.tgSub')) || 2; strength = Number(localStorage.getItem('bp.tgStr')) || 0.6; } catch (_) {}
    const g = await new Promise((resolve) => {
      const d = $('#ask'); $('#ask-title').textContent = `Tighten ${clip ? clip.name : `${t.name} (${targets.length} take${targets.length === 1 ? '' : 's'})`} to the grid`;
      const box = $('#ask-text'); box.textContent = ''; const row = el('div', 'tg-row');
      const sel = document.createElement('select'); for (const [l, v] of GRIDS) sel.append(new Option(l, String(v))); sel.value = String(sub);
      const rng = document.createElement('input'); rng.type = 'range'; rng.min = '10'; rng.max = '100'; rng.step = '5'; rng.value = String(Math.round(strength * 100)); const lab = el('span', 'mono', `${rng.value}%`); rng.addEventListener('input', () => { lab.textContent = `${rng.value}%`; });
      row.append(document.createTextNode('grid '), sel, document.createTextNode('  strength '), rng, lab);
      box.append(el('div', 'small muted', 'Pulls each hit part of the way onto the nearest grid line (only hits within ~70 ms of one). The original take stays in the folder — right-click → Undo tighten any time.'), row);
      const menu = $('#ask-menu'); menu.innerHTML = '';
      for (const [label, value, cls] of [['Preview', 'preview', ''], ['Tighten', 'ok', 'primary'], ['Cancel', '', '']]) { const b = el('button', cls, label); b.value = value; menu.append(b); }
      d.returnValue = ''; d.showModal();
      d.addEventListener('close', function h() { d.removeEventListener('close', h); resolve({ how: d.returnValue, sub: Number(sel.value), strength: Number(rng.value) / 100 }); });
    });
    if (!g.how) return;
    try { localStorage.setItem('bp.tgSub', String(g.sub)); localStorage.setItem('bp.tgStr', String(g.strength)); } catch (_) {}
    return doTighten(t, targets, g, clip);
  }
  async function doTighten(t, targets, g, clip = null) {
    const close = toast('Tightening…', { ms: 600000 }); const done = [];
    try { for (const c of targets) done.push({ c, r: await tightenClipNow(t, c, { sub: g.sub, strength: g.strength, window: 0.07 }) }); } finally { close(); }
    const gl = GRIDS.find((x) => x[1] === g.sub)[0];
    if (g.how === 'preview') {   // hear it in place without changing anything: playback-only stand-in buffers (engine.previewSrc), the song never sees them
      engine.previewSrc = new Map(); for (const { c, r } of done) { if (!r.res) continue; const id = `pv${c.id}`; const b = engine.ctx.createBuffer(r.res.channels.length, r.res.channels[0].length, r.sr); r.res.channels.forEach((x, i) => b.copyToChannel(x, i)); engine.buffers.set(id, b); engine.previewSrc.set(c.id, id); }
      const restore = () => { if (engine.previewSrc) for (const id of engine.previewSrc.values()) engine.buffers.delete(id); engine.previewSrc = null; };
      let off = null;
      try { engine.seek(Math.max(0, targets[0].start - 0.5)); await play(); off = engine.on((ev, data) => { if (ev === 'transport' && !data.playing) { off(); restore(); toast(`That was ${gl} at ${Math.round(g.strength * 100)}%.`, { kind: '', ms: 12000, buttons: [['Tighten it', () => openTighten(t, clip)]] }); } }); }
      catch (err) { restore(); throw err; }
      return { preview: true };
    }
    // a take that's late / early as a whole is a latency offset, not loose playing: one nudge fixes it with no warping
    { const offs = done.map(({ c, r }) => (r.res ? { c, o: TG.offsetOf(r.res.anchors) } : null)).filter((x) => x && x.o && Math.abs(x.o.ms) >= 12 && x.o.spreadMs <= 10);
      if (offs.length && !g.fromOffset) { const x = offs[0]; const v = await ask('Late as a whole', `${x.c.name} is ${Math.abs(x.o.ms).toFixed(0)} ms ${x.o.ms > 0 ? 'late' : 'early'} on ${x.o.n} hits, consistently — that's recording latency, not the playing. Nudge the whole take ${x.o.ms > 0 ? 'earlier' : 'later'} by ${Math.abs(x.o.ms).toFixed(0)} ms instead? (Settings → Measure fixes it for the next takes.)`, [['Nudge it', 'nudge', 'primary'], ['Tighten anyway', 'tighten'], ['Cancel', '']]);
        if (!v) return { takes: 0 }; if (v === 'nudge') { change(() => { for (const x of offs) x.c.start = Math.max(0, x.c.start - x.o.ms / 1000); }, { label: `nudged ${offs.length === 1 ? offs[0].c.name : `${offs.length} takes`} by ${Math.abs(offs[0].o.ms).toFixed(0)} ms` }); renderAll(); status(`Nudged — hits now sit on the grid without any warping.`); return { takes: offs.length, nudged: true }; } } }
    const wrote = [];
    for (const { c, r } of done) {
      if (r.midi) { wrote.push({ c, midi: r.midi }); continue; }
      if (!r.res.moved) continue;
      const nid = newId(); const b = engine.ctx.createBuffer(r.res.channels.length, r.res.channels[0].length, r.sr); r.res.channels.forEach((x, i) => b.copyToChannel(x, i));
      await bp.audio.write(state.folder, nid, window.BPWav.encodeWav(r.res.channels, r.sr, 24), { label: `${takeLabel(t, c)} - tight ${gl.replace('/', 'of')}` });
      engine.buffers.set(nid, b); wrote.push({ c, nid, srcId: r.srcId, moved: r.res.moved, before: r.res.meanErrBefore, after: r.res.meanErrAfter });
    }
    if (!wrote.length) { status('Nothing was far enough off the grid to move.', 6000); return { takes: 0 }; }
    const okt = change(() => { for (const w of wrote) { if (w.midi) { w.c.notes = w.midi; w.c.qz = { grid: gl, strength: g.strength }; continue; } w.c.tt = { src: w.srcId, grid: gl, strength: g.strength }; w.c.src = w.nid; } }, { label: `tightened ${wrote.length === 1 ? wrote[0].c.name : `${wrote.length} takes`} to ${gl} (${Math.round(g.strength * 100)}%)` });
    if (!okt) return { takes: 0, refused: true };
    for (const w of wrote) if (state.pitch) state.pitch.delete(w.c.id);
    renderAll(); await save();
    const a = wrote.filter((w) => w.before != null); const msg = a.length ? ` — the moved hits were off by ${(a.reduce((n, w) => n + w.before, 0) / a.length * 1000).toFixed(0)} ms on average, now ${(a.reduce((n, w) => n + w.after, 0) / a.length * 1000).toFixed(0)} ms` : '';
    toast(`Tightened to ${gl} at ${Math.round(g.strength * 100)}%${msg}. Right-click a take → Undo tighten to get the original back.`, { kind: 'ok', ms: 12000 });
    return { takes: wrote.length, before: a.length ? a.reduce((n, w) => n + w.before, 0) / a.length : null, after: a.length ? a.reduce((n, w) => n + w.after, 0) / a.length : null };
  }
  // ---------- timing report (timing.js): every take, per bar, how far off the click — shown, nothing changed ----------
  const TMG = window.BPTiming;
  async function timingReport(t, clip = null) {
    if (!state.folder || !t) return null; await engine.init();
    const clips = (clip ? [clip] : t.clips.filter((c) => !c.link && !engine.clipMuted(c))); if (!clips.length) { status('No audible takes on that track.'); return null; }
    let sub = 2; try { sub = Number(localStorage.getItem('bp.tgSub')) || 2; } catch (_) {}
    const onsets = [], notes = []; let a = Infinity, z = 0;
    for (const c of clips) {
      a = Math.min(a, c.start); z = Math.max(z, clipEnd(c));
      if (c.kind === 'midi') { for (const n of c.notes || []) { const at = c.start + n.t - (c.trimStart || 0); if (at >= c.start - 1e-6 && at < clipEnd(c)) notes.push({ t: at }); } continue; }
      const buf = engine.buffers.get(audioId(c)); if (!buf) continue;
      const sr = buf.sampleRate; const i0 = Math.floor((c.trimStart || 0) * sr), i1 = Math.min(buf.length, i0 + Math.floor((engine.clipLength(c) || 0) * sr));
      const m = mono(window.BPWav.audioBufferToChannels(buf).map((ch) => ch.subarray(i0, i1)));
      for (const o of TG.onsets(m, sr)) onsets.push({ t: c.start + o.t, strength: o.strength });
    }
    if (!(z > a)) return null;
    const grid = gridTimes(sub)(a, z); const barStarts = window.BPMeter.beatsIn(engine.meterMap(), Math.max(0, a - 1), z + 1).filter((b) => b.beat === 0).map((b) => b.t);
    const rep = notes.length && !onsets.length ? TMG.reportNotes({ notes, gridTimes: grid, barStarts }) : TMG.report({ onsets, gridTimes: grid, barStarts });
    if (!rep.overall.n) { status("Couldn't find hits to time on that take (sustained sounds don't give much to measure)."); return null; }
    const line = TMG.summaryText(rep, { fmtBar: (x) => `bar ${barOf(x)}` });
    // the panel: a bar chart + the worst bars, with Nudge / Tighten from there
    const node = el('li', 'timing-box'); node.append(el('b', null, `⏱ ${clip ? clip.name : t.name}: `), el('span', null, line));
    const cv = document.createElement('canvas'); cv.width = 600; cv.height = 70; cv.style.width = '100%'; cv.style.height = '35px'; cv.title = 'Timing map: one column per bar of the song. A tall column means that bar is well off the click; amber means it was played late, blue means early. Short columns everywhere = a tight take.'; node.append(cv);
    TMG.barChart(cv.getContext('2d'), rep, { w: 600, h: 70 });
    const worst = el('div', 'small muted', rep.overall.worstBars.map((w) => `bar ${w.bar}: ${Math.abs(w.meanMs).toFixed(0)} ms ${w.meanMs > 0 ? 'late' : 'early'}`).join(' · '));
    node.append(worst);
    const row = el('div', 'tg-row');
    if (rep.overall.offsetLikely && !ro() && clips.every((c) => c.kind !== 'midi')) { const b = el('button', 'small', `Nudge ${rep.overall.medianMs > 0 ? 'earlier' : 'later'} ${Math.abs(rep.overall.medianMs).toFixed(0)} ms`); b.title = 'The whole take is off by a fixed amount (latency) — move it, no warping'; b.addEventListener('click', () => { change(() => { for (const c of clips) c.start = Math.max(0, c.start - rep.overall.medianMs / 1000); }, { label: `nudged ${clip ? clip.name : t.name} by ${Math.abs(rep.overall.medianMs).toFixed(0)} ms` }); renderAll(); timingReport(t, clip); }); row.append(b); }
    if (!ro()) { const b = el('button', 'small', '⇥ Tighten…'); b.addEventListener('click', () => openTighten(t, clip).catch(fail)); row.append(b); }
    { const b = el('button', 'small', 'Hear the worst bar'); b.addEventListener('click', () => { const w = rep.overall.worstBars[0]; if (!w) return; const bt = barStarts[w.bar - 1]; engine.setLoop({ enabled: true, start: bt, end: bt + barLenAt(bt + 1e-3) }); karaLoopSync(); engine.seek(bt); play().catch(fail); }); row.append(b); }
    { const b = el('button', 'small', '✕'); b.addEventListener('click', () => { state.timing = null; renderTakes(); }); row.append(b); }
    node.append(row);
    state.timing = { trackId: t.id, node, rep }; state.selectedTrack = t.id;
    if (state.ws !== 'record') setWorkspace('record'); showTab('takes'); renderTakes();
    status(`${clip ? clip.name : t.name}: ${line}`, 10000);
    return rep;
  }
  function untighten(t, c) { if (!c.tt) return; change(() => { c.src = c.tt.src; delete c.tt; }, { label: `undo tighten on ${c.name}` }); renderAll(); }

  // ---------- pitch check (pitchcheck.js): where the singing is sharp / flat — shown, never changed ----------
  state.pitch = new Map();   // clipId → results (song times)
  async function pitchCheckTrack(t, only = null) {
    await engine.init(); const clips = (only ? [only] : t.clips.filter((c) => !c.link && !engine.clipMuted(c) && c.kind !== 'midi'));
    if (!clips.length) { status('No audible vocal takes on that track.'); return null; }
    const close = toast('Pitch check: listening…', { ms: 600000 }); const all = []; let keyNote = '';
    try {
      // the melody to check against: any MIDI melody / guide voice notes in the song (else the key's scale)
      const melody = []; for (const x of engine.tracks) for (const c of x.clips) if (c.kind === 'midi' && (c.melody || x.instrument === 'synth:voice') && !engine.clipMuted(c)) for (const n of c.notes || []) { const at = c.start + n.t - (c.trimStart || 0); melody.push({ t: at, d: n.d, n: n.n }); }
      for (const c of clips) {
        const buf = engine.buffers.get(audioId(c)); if (!buf) continue;
        const sr = buf.sampleRate; const a = Math.floor((c.trimStart || 0) * sr), b = Math.min(buf.length, a + Math.floor((engine.clipLength(c) || 0) * sr));
        const m = mono(window.BPWav.audioBufferToChannels(buf).map((ch) => ch.subarray(a, b)));
        const notes = PC.notes(PC.track(m, sr)).map((n) => ({ ...n, t0: n.t0 + c.start, t1: n.t1 + c.start }));
        let key = keyAt(c.start + 0.01) || null;
        let res = PC.check(notes, { key, melody: melody.length ? melody : null });
        // a key label the singing doesn't fit (most notes "wrong") is more likely a wrong label than a wrong singer:
        // ask the bass line, and fall back to plain nearest-note checking
        if (key && !melody.length && res.summary.notes >= 6 && res.summary.wrong / res.summary.notes > 0.35) {
          const hk = await hearKey().catch(() => null); const alt = hk && hk.key && hk.confidence >= 0.3 && !sameNotes(hk.key, key) ? hk.key : null;
          const res2 = PC.check(notes, { key: alt, melody: null });
          if (res2.summary.wrong < res.summary.wrong) { res = res2; keyNote = alt ? `Most notes fall outside ${key}; the takes sound like ${alt}, so that's what was used — check the song key.` : `Most notes fall outside ${key} — the song key may be wrong; checked against the nearest note instead.`; }
        }
        state.pitch.set(c.id, { ...res, start: c.start, ok: res.summary.notes ? Math.round(100 * res.summary.ok / res.summary.notes) : 100 }); all.push(...res.results);   /* shown only — nothing written into the song */
      }
    } finally { close(); }
    if (!all.length) { status("Didn't hear sung notes on that take.", 6000); return null; }
    renderTracks(); if (tabShown('takes')) renderTakes();
    const rep = PC.sectionReport(all, liveSections(), (x) => fmtBar(x)); const judged = all.filter((r) => r.flag !== 'short'); const bad = judged.filter((r) => ['sharp', 'flat', 'wrong-note'].includes(r.flag));
    const lines = Object.entries(rep).map(([k, v]) => `${k}: ${v.ok}% in tune${v.worst ? ` (worst ${v.worst})` : ''}`);
    toast(`${keyNote ? `${keyNote} ` : ''}Pitch check: ${judged.length - bad.length} of ${judged.length} notes in tune (within 25 cents; ${all.length - judged.length} too short to judge). ${bad.filter((r) => r.flag === 'flat').length} flat · ${bad.filter((r) => r.flag === 'sharp').length} sharp · ${bad.filter((r) => r.flag === 'wrong-note').length} wrong note · ${judged.filter((r) => r.flag === 'between').length} between two notes. ${lines.slice(0, 4).join(' · ')}. Marks on the take: blue flat, red sharp, amber wrong note, grey between.`, { kind: 'ok', ms: 30000, buttons: bad.length ? [['Go to the worst', () => { const w = bad.slice().sort((x, y) => Math.abs(y.off) - Math.abs(x.off))[0]; engine.seek(Math.max(0, w.t0 - 1)); positionPlayhead(); }], ['Clear marks', () => { state.pitch.clear(); renderTracks(); }]] : [] });
    return { results: all, report: rep };
  }

  // ---------- karaoke / practice view (karaoke.js) ----------
  // Full-screen lyrics: the line being sung big, its words lighting up as they're sung, chords over the words, the part
  // you're in, the next lines underneath. Vocals as a guide or muted, slower at the same pitch, loop the part, record
  // while you practice, or rehearse the whole setlist back to back.
  const KA = window.BPKaraoke;
  try { $('#main').append($('#karaoke')); } catch (_) {}   // Practice lives in the song area (top bar + songs list stay put), not over the whole window
  const kara = { open: false, lines: [], key: '', raf: 0, size: 1, setlist: null, lastPos: 0, wasPlaying: false, prevLine: -2, partsKey: '', barsKey: '', mutes: new Set(), solo: null, starting: false, practiced: 0, lastTick: 0, wasPracticing: false };
  try { kara.mutes = new Set(JSON.parse(localStorage.getItem('bp.kMutes') || '[]')); kara.solo = localStorage.getItem('bp.kSolo') || null; } catch (_) {}
  function karaLines() {
    const sg = state.song; if (!sg) return [];
    const key = JSON.stringify([CB.live(CB.list(sg, 'lyrics')).map((l) => [l.id, l.time, l.text, (l.words || []).length]), liveSections().map((s) => [s.id, s.start, s.end, s.name, !!s.unlinked]), liveChords().map((c) => [c.id, c.time, c.chord]), sg.linkGroups]);
    const audible = new Set(engine.tracks.flatMap((t) => t.clips.filter((c) => c.kind !== 'midi' && !engine.clipMuted(c)).map((c) => audioId(c))));
    const fullKey = key + [...audible].sort().join(',');
    if (fullKey !== kara.key) {
      kara.key = fullKey;
      // two takes with different words over the same bars (alt lyrics): show the words of the one that's playing
      const ly = CB.live(CB.list(sg, 'lyrics')); const heard = ly.filter((l) => l.asr && typeof l.time === 'number');
      const lyrics = ly.filter((l) => !(l.asr && !audible.has(l.asr) && heard.some((o) => o !== l && audible.has(o.asr) && Math.abs(o.time - l.time) < 2.5)));
      kara.lines = KA.lines({ lyrics, sections: sg.sections, chords: sg.chords, linkGroups: sg.linkGroups }, { linkInfo: TPL.linkInfo, end: engine.contentLength() || null });
    }
    return kara.lines;
  }
  const fmtClock = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  const karaTime = () => { if (practice && practice.startAt != null && engine.ctx) { const len = practice.to - practice.from; return practice.from + (((engine.ctx.currentTime - practice.startAt) * practice.pct / 100) % len + len) % len; } return engine.playing ? engine.currentPos() : engine.playhead; };
  const karaEnd = () => Math.max(engine.contentLength() || 0, ...liveSections().map((x) => x.end), 1);
  const karaView = () => $('#k-view').value;
  // chords as shown: moved up/down for a capo or another tuning (what you hear doesn't change)
  const karaTp = () => Number($('#k-tp').value) || 0;
  function tpChord(c) { const n = karaTp(); if (!n || !c) return c; return MU.transposeChord(c, n, MU.isFlatKey(MU.transposeKey(keyAt(0.01) || 'C', n))); }
  function karaRenderLine(node, l, t, { big = false } = {}) {
    node.innerHTML = ''; if (!l) return;
    const row = el('div', 'k-words'); const showChords = karaView() !== 'words';
    l.words.forEach((w, k) => {
      const span = el('span', 'k-w'); const ch = showChords ? l.chords.filter((c) => c.wi === k) : [];
      if (ch.length) span.append(el('span', 'k-chord', ch.map((x) => tpChord(x.chord)).join(' ')));
      const word = el('span', 'k-wt', w.w); span.append(word);
      if (big && t != null) { if (t >= w.e) span.classList.add('sung'); else if (t >= w.t) { span.classList.add('now'); const f = Math.max(0, Math.min(1, (t - w.t) / Math.max(0.05, w.e - w.t))); word.style.setProperty('--f', `${(f * 100).toFixed(0)}%`); } }
      row.append(span, document.createTextNode(' '));
    });
    node.append(row); if (l.ghost) node.title = 'from the first copy of this part (linked)';
  }
  // chords-only view: the part you're in as bars, the bar you're in lit (the next part's first bar shows when you're close)
  function karaBars(t) {
    const box = $('#k-bars'); const sc = CB.sectionAt(state.song, t);
    const a = sc ? sc.start : floorBar(t), z = sc ? sc.end : barSec(barIdx(floorBar(t)) + 8);
    const chords = liveChords().slice().sort((x, y) => x.time - y.time);
    const key = JSON.stringify([a, z, chords.map((c) => [c.time, c.chord]), karaTp(), sc && sc.name]);
    if (key !== kara.barsKey) {
      kara.barsKey = key; box.innerHTML = '';
      box.append(el('div', 'k-sec', sc ? sc.name.toUpperCase() : `bars ${barOf(a)}–${endBarNo(z)}`));
      let held = null; for (const c of chords) if (c.time <= a + 1e-6) held = c.chord;
      for (let s = a; s < z - 1e-3;) {
        const b = barLenAt(s + 1e-4); const e = Math.min(z, s + b);
        const inBar = chords.filter((c) => c.time >= s - 1e-6 && c.time < e - 1e-6).map((c) => c.chord);
        const label = inBar.length ? inBar.map(tpChord).join(' ') : held ? '–' : ''; if (inBar.length) held = inBar[inBar.length - 1];
        const d = el('div', 'k-bar', label); d.dataset.s = String(s); d.dataset.e = String(e); box.append(d); s = e;
      }
    }
    for (const d of box.querySelectorAll('.k-bar')) { const s = Number(d.dataset.s), e = Number(d.dataset.e); d.classList.toggle('now', t >= s - 1e-3 && t < e - 1e-3); d.classList.toggle('done', t >= e - 1e-3); }
  }
  // the scrub bar: parts drawn in it, the loop highlighted; the loop picker lists the same parts
  function karaParts() {
    const end = karaEnd(); const secs = liveSections().slice().sort((a, b) => a.start - b.start);
    const lp = engine.loop.enabled ? [engine.loop.start, engine.loop.end] : null;
    const key = JSON.stringify([end, secs.map((x) => [x.id, x.start, x.end, x.name]), lp]);
    if (key === kara.partsKey) return; kara.partsKey = key;
    const box = $('#k-parts'); box.innerHTML = '';
    for (const x of secs) { const sp = el('span', null, x.name); sp.style.left = `${(100 * x.start / end).toFixed(3)}%`; sp.style.width = `${(100 * (x.end - x.start) / end).toFixed(3)}%`; if (lp && Math.abs(lp[0] - x.start) < 0.01 && Math.abs(lp[1] - x.end) < 0.01) sp.classList.add('loop'); box.append(sp); }
    const sel = $('#k-loopsel'); const cur = lp ? (secs.find((x) => Math.abs(x.start - lp[0]) < 0.01 && Math.abs(x.end - lp[1]) < 0.01) || { id: '__custom' }).id : '';
    sel.innerHTML = ''; sel.append(new Option('off', ''));
    secs.forEach((x, i) => sel.append(new Option(`${i < 9 ? `${i + 1} · ` : ''}${x.name}`, x.id)));
    if (cur === '__custom') sel.append(new Option(`bars ${barOf(lp[0])}–${endBarNo(lp[1])}`, '__custom'));
    sel.value = cur;
    $('#k-len').textContent = fmtClock(end);
  }
  // Words flying at you: every line sits on a 3D plane, far away when it's a while off, hitting the glowing line at
  // the bottom when it's time to sing it, then sliding under you. Lines are DOM nodes reused frame to frame.
  const crawl = { key: '', nodes: new Map(), lookahead: 9, back: 1.6, hold: 0.7 };   // hold: how long a word sits on the line after it's been sung
  { const v = $('#k-vol'); let saved = 100; try { saved = Number(localStorage.getItem('bp.practiceVol') ?? 100); } catch (_) {} v.value = String(saved); engine.setListen(saved / 100);
    v.addEventListener('input', () => { engine.setListen(v.value / 100); try { localStorage.setItem('bp.practiceVol', v.value); } catch (_) {} }); }
  function karaCrawl(t, ls, a) {
    const plane = $('#k-plane'); if (!plane) return;
    // one flyer per WORD: each comes down the lane at its own time and lands in its place on the line, so the lyric
    // assembles as it arrives. x = the word's slot in its line (measured once); y = how far off its time is.
    if (crawl.key !== kara.key) {
      crawl.key = kara.key; plane.innerHTML = ''; crawl.nodes.clear();
      const meas = el('div', 'k-cw meas'); plane.append(meas);
      ls.forEach((l, i) => {
        const words = l.words && l.words.length ? l.words : [{ w: l.text || '', t: l.time, e: l.time + 2 }];
        const widths = words.map((w) => { meas.textContent = w.w; return meas.offsetWidth; }); const gap = 14; const total = widths.reduce((n, w) => n + w, 0) + gap * (words.length - 1);
        let x = -total / 2;
        words.forEach((w, k) => { const n = el('div', 'k-cw'); n.textContent = w.w; const ch = (l.chords || []).filter((c) => c.wi === k); if (ch.length) { const c = el('span', 'k-chord', ch.map((x) => x.chord).join(' ')); n.prepend(c); } n.style.left = `calc(50% + ${x.toFixed(0)}px)`; n.dataset.t = String(w.t); n.dataset.e = String(w.e); n.dataset.line = String(i); crawl.nodes.set(`${i}:${k}`, n); plane.append(n); x += widths[k] + gap; });
      });
      meas.remove();
    }
    const H = plane.clientHeight || 600; const px = H / crawl.lookahead;
    for (const [, n] of crawl.nodes) {
      const wt = Number(n.dataset.t), we = Number(n.dataset.e); const dt = wt - t;
      const gone = we + crawl.hold;   // leaves the line only after it has been sung AND held a beat
      if (dt > crawl.lookahead || gone < t - crawl.back) { n.style.display = 'none'; continue; }
      n.style.display = ''; const y = dt > 0 ? dt * px : Math.max(-crawl.back, Math.min(0, gone - t)) * px;   // flies in, SNAPS to the line at its time, hangs, then drops away
      const now = dt <= 0 && t <= gone, sung = t > gone;
      n.className = 'k-cw' + (now ? ' now' : sung ? ' sung' : '');
      n.style.transform = `translateY(${(-y).toFixed(1)}px) translateY(50%)`;
      n.style.opacity = sung ? String(Math.max(0, 1 + (gone - t) / crawl.back)) : String(Math.min(1, 0.3 + (1 - Math.max(0, dt) / crawl.lookahead)));
    }
  }
  function karaFrame() {
    kara.raf = 0; if (!kara.open || !state.song) return;
    const t = karaTime(); const ls = karaLines(); const a = KA.at(ls, t); const view = karaView();
    const sc = CB.sectionAt(state.song, t);
    $('#k-part').textContent = sc ? sc.name.toUpperCase() : '';
    const setInfo = kara.setlist ? ` · set ${fmtClock((Date.now() - kara.setlist.startedAt) / 1000)} · song ${kara.setlist.i + 1}/${kara.setlist.order.length}` : '';
    $('#k-pos').textContent = `${posLabel(t)}${practice ? ` · ${practice.pct}%` : ''}${setInfo}`;
    const along = $('#k-along').value; const chordsOnly = view === 'chords' && !along; const crawl = view === 'crawl';
    for (const id of ['#k-prev', '#k-cur', '#k-next', '#k-next2']) $(id).hidden = chordsOnly || !!along || crawl;
    $('#k-bars').hidden = !chordsOnly; $('#k-hw').hidden = !along; $('#k-hw').classList.add('persp'); $('#k-crawl').hidden = !crawl; $('#k-hw-line').hidden = crawl;
    if (crawl) { karaCrawl(t, ls, a); const em = $('#k-crawl-empty'); if (em) em.hidden = !!ls.length; }
    const nextIdx = a.i + 1; const nl = ls[nextIdx]; const cnt = $('#k-count');
    if (along) { karaHighway(t, along); karaRenderLine($('#k-hw-line'), a.cur || null, t, { big: true }); }
    else if (chordsOnly) karaBars(t);
    else {
      karaRenderLine($('#k-cur'), a.cur || null, t, { big: true });
      karaRenderLine($('#k-prev'), a.cur ? ls[a.i - 1] : ls[a.i] || null, null);
      karaRenderLine($('#k-next'), nl || null, null); karaRenderLine($('#k-next2'), ls[nextIdx + 1] || null, null);
      if (!ls.length) { $('#k-cur').innerHTML = ''; $('#k-cur').append(el('span', 'k-empty', 'No timed lyrics yet — Lyrics tab → 🎤 From the vocals, or add lines and pin them with P. "Chords only" shows the bars.')); }
    }
    if (!a.cur && nl) { const s = nl.time - t; cnt.textContent = s <= 3.2 ? `${Math.max(1, Math.ceil(s))}` : `${nl.section && nl.section !== (sc && sc.name) ? `${nl.section} — ` : ''}♪ ${Math.round(s)} s`; cnt.className = 'k-count' + (s <= 3.2 ? ' soon' : ''); }
    else cnt.textContent = '';
    if (!chordsOnly && !a.cur && sc && /^(verse|chorus|pre-chorus|post-chorus|bridge|hook|refrain)$/.test(TPL.sectionType(sc.name)) && !ls.some((l) => l.time >= sc.start - 1e-6 && l.time < sc.end - 1e-6)) { cnt.textContent = `${sc.name}: no words yet`; cnt.className = 'k-count'; }
    if (kara.starting) { cnt.textContent = kara.starting; cnt.className = 'k-count soon'; }
    karaParts();
    const end = karaEnd(); const pct = Math.min(100, 100 * t / end);
    $('#k-progress i').style.width = `${pct.toFixed(2)}%`; $('#k-progress b').style.left = `${pct.toFixed(2)}%`; $('#k-time').textContent = fmtClock(t);
    $('#k-play').textContent = engine.playing || practice ? '❚❚' : '▶';
    $('#k-rec').classList.toggle('active', !!engine.recording);
    $('#k-setnav').hidden = !kara.setlist;
    // setlist: a song that ran to its end opens the next one and plays it
    if (kara.setlist && !kara.show && !kara.starting && kara.wasPlaying && !engine.playing && !engine.recording && kara.lastPos > (engine.contentLength() || end) - 1.5) karaNextSong().catch(fail);
    if (kara.show && kara.wasPlaying && !engine.playing && kara.lastPos > (engine.contentLength() || end) - 1.5) { engine.seek(0); kara.lastPos = 0; showNextUp(); }
    kara.wasPlaying = engine.playing; kara.lastPos = engine.playing ? t : kara.lastPos;
    { const nowMs = performance.now(); const dt = kara.lastTick ? Math.min(0.5, (nowMs - kara.lastTick) / 1000) : 0; kara.lastTick = nowMs; if (engine.playing || practice) { kara.practiced += dt; if (!kara.wasPracticing) { kara.wasPracticing = true; sendPresence(); } } else if (kara.wasPracticing) { kara.wasPracticing = false; sendPresence(); } if (kara.practiced >= 60) practiceFlush(); }
    kara.raf = requestAnimationFrame(karaFrame);
  }
  // ---- play along (highway.js): what to play scrolls down to the hit line — chord grips, the bass line as a tab, a MIDI part ----
  const HW = window.BPHighway;
  const hw = { key: '', events: [], mode: '', bassNotes: null, bassKey: '', loading: false, ctx: null };
  async function hwBassNotes() {   // the bass line, read off the bass takes (pitch-tracked), cached per song state
    const bass = engine.tracks.filter((t) => t.instrument === 'audio' && window.BPAutoMix.role(t) === 'bass' && engine.audible(t));
    const key = state.folder + '|' + bass.map((t) => t.clips.filter((c) => !engine.clipMuted(c)).map((c) => `${audioId(c)}@${c.start}:${c.trimStart}:${c.trimEnd}`).join(',')).join(';');
    if (hw.bassKey === key) return hw.bassNotes;
    if (hw.loading) return null; hw.loading = true;
    try {
      const out = [];
      for (const t of bass) for (const c of t.clips) {
        if (engine.clipMuted(c) || c.kind === 'midi') continue; const buf = engine.buffers.get(audioId(c)); if (!buf) continue;
        const sr = buf.sampleRate; const i0 = Math.floor((c.trimStart || 0) * sr), i1 = Math.min(buf.length, i0 + Math.floor((engine.clipLength(c) || 0) * sr));
        const m = mono(window.BPWav.audioBufferToChannels(buf).map((ch) => ch.subarray(i0, i1)));
        const pts = PC.track(m, sr, { minHz: 28, maxHz: 500 });
        for (const n of HW.notesFromPitchTrack(pts, { minDur: 0.09 })) out.push({ t: n.t + c.start, d: n.d, midi: n.midi });
        await new Promise((r) => setTimeout(r, 0));
      }
      out.sort((x, y) => x.t - y.t); hw.bassNotes = HW.bassTab(out); hw.bassKey = key; return hw.bassNotes;
    } finally { hw.loading = false; }
  }
  function hwEvents(mode, t) {
    const k = karaTp(); const capo = Math.max(0, -k);
    if (mode === 'chords') {
      const chords = liveChords().slice().sort((a, b) => a.time - b.time).map((c) => ({ time: c.time, chord: k > 0 ? tpChord(c.chord) : c.chord }));
      const key = `chords|${k}|${chords.map((c) => `${c.time}:${c.chord}`).join(',')}`;
      if (key !== hw.key) { hw.key = key; hw.events = HW.events({ mode: 'chords', chords, from: 0, to: karaEnd(), capo }); }
      return hw.events;
    }
    if (mode === 'bass') {
      const notes = hw.bassNotes; const key = `bass|${k}|${hw.bassKey}`;
      if (!notes) { hwBassNotes().then(() => { hw.key = ''; }).catch(() => {}); $('#k-hw-msg').textContent = hw.loading ? 'Reading the bass line off the bass takes…' : engine.tracks.some((x) => window.BPAutoMix.role(x) === 'bass') ? '' : 'No bass track in this song.'; return []; }
      $('#k-hw-msg').textContent = notes.length ? '' : "Couldn't hear notes on the bass takes.";
      if (key !== hw.key) { hw.key = key; const shifted = k ? HW.bassTab(notes.map((n) => ({ t: n.t, d: n.d, midi: n.midi + k }))) : notes; hw.events = HW.events({ mode: 'bass', notes: shifted, from: 0, to: karaEnd() }); }
      return hw.events;
    }
    // midi: the selected (or first) MIDI track's notes as a tab, bass or guitar by role
    const tr = engine.track(state.selectedTrack); const mt = tr && tr.clips.some((c) => c.kind === 'midi') ? tr : engine.tracks.find((x) => x.clips.some((c) => c.kind === 'midi') && x.instrument !== 'drumkit');
    if (!mt) { $('#k-hw-msg').textContent = 'No MIDI part in this song (pick a MIDI track in Write first).'; return []; }
    const notes = []; for (const c of mt.clips) if (c.kind === 'midi' && !engine.clipMuted(c)) for (const n of c.notes || []) { const at = c.start + n.t - (c.trimStart || 0); if (at >= c.start - 1e-6 && at < clipEnd(c)) notes.push({ t: at, d: n.d, midi: n.n + k }); }
    const key = `midi|${k}|${mt.id}|${notes.length}|${notes.slice(0, 50).map((n) => n.t).join(',')}`;
    if (key !== hw.key) { hw.key = key; const isBass = window.BPAutoMix.role(mt) === 'bass'; notes.sort((a, b) => a.t - b.t); hw.events = HW.events({ mode: isBass ? 'bass' : 'guitar', notes: isBass ? HW.bassTab(notes) : HW.guitarTab(notes), from: 0, to: karaEnd() }); hw.mode = isBass ? 'bass' : 'guitar'; $('#k-hw-msg').textContent = `${mt.name} as a ${isBass ? 'bass' : 'guitar'} tab`; }
    return hw.events;
  }
  function karaHighway(t, mode) {
    const cv = $('#k-highway'); const r = cv.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const W = Math.max(200, Math.round(r.width)), H = Math.max(120, Math.round(r.height));
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); hw.ctx = null; }
    if (!hw.ctx) { hw.ctx = cv.getContext('2d'); }
    const ctx = hw.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const events = hwEvents(mode, t); const lanes = mode === 'chords' ? 1 : (mode === 'bass' || hw.mode === 'bass') ? 4 : 6;
    HW.draw(ctx, { w: W, h: H, now: t, events, lookahead: 4, lanes, labels: lanes === 4 ? HW.BASS.labels || ['E', 'A', 'D', 'G'] : lanes === 6 ? HW.GUITAR.labels || ['E', 'A', 'D', 'G', 'B', 'e'] : null });
  }
  $('#k-along').addEventListener('change', (e) => { hw.key = ''; try { localStorage.setItem('bp.kAlong', e.target.value); } catch (_) {} e.target.blur(); });
  // who you hear: vocals (guide / off) + tracks you've taken out (by name, so it carries through the setlist) or one soloed
  function karaApplyMix() {
    const vox = $('#k-vox').value; const out = new Set();
    const clickOnly = kara.show && $('#k-backing').value === 'click';
    for (const t of engine.tracks) {
      if (clickOnly) { out.add(t.id); continue; }
      if (vox === 'off' && (isVocalTrack(t) || t.instrument === 'synth:voice')) out.add(t.id);
      if (kara.mutes.has(String(t.name).toLowerCase())) out.add(t.id);
      if (kara.solo && String(t.name).toLowerCase() !== kara.solo) out.add(t.id);
    }
    engine.tempMute = out; engine.applyAll();
    const names = engine.tracks.filter((t) => out.has(t.id) && !(vox === 'off' && isVocalTrack(t))).map((t) => t.name);
    const solo = kara.solo && engine.tracks.find((t) => String(t.name).toLowerCase() === kara.solo);
    $('#k-mix').textContent = solo ? `🎚 only: ${solo.name}` : names.length ? `🎚 without: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}` : '🎚 mix: everyone';
    $('#k-mix').classList.toggle('active', !!(solo || names.length));
    try { localStorage.setItem('bp.kMutes', JSON.stringify([...kara.mutes])); if (kara.solo) localStorage.setItem('bp.kSolo', kara.solo); else localStorage.removeItem('bp.kSolo'); } catch (_) {}
  }
  function setVox(mode) { $('#k-vox').value = mode; try { localStorage.setItem('bp.kVox', mode); } catch (_) {} karaApplyMix(); karaRerender(); }
  function karaMixMenu() {
    const r = $('#k-mix').getBoundingClientRect(); const nm = (t) => String(t.name).toLowerCase();
    const changed = () => { karaApplyMix(); karaRerender(); };
    M.show(r.left, r.bottom + 4, [{ title: 'Who you hear (practice only — the song is untouched)' },
      { label: 'Everyone', checked: !kara.solo && !kara.mutes.size, action: () => { kara.mutes.clear(); kara.solo = null; changed(); } },
      ...(state.armedTrack && engine.track(state.armedTrack) ? [{ label: `Take me out (${engine.track(state.armedTrack).name})`, action: () => { kara.solo = null; kara.mutes.add(nm(engine.track(state.armedTrack))); changed(); } }] : []),
      'sep', { title: 'Hear (click to take a track out)' },
      ...engine.tracks.map((t) => ({ label: t.name, checked: !kara.mutes.has(nm(t)) && (!kara.solo || kara.solo === nm(t)), action: () => { kara.solo = null; if (kara.mutes.has(nm(t))) kara.mutes.delete(nm(t)); else kara.mutes.add(nm(t)); changed(); } })),
      'sep', { label: 'Only one track', sub: engine.tracks.map((t) => ({ label: t.name, checked: kara.solo === nm(t), action: () => { kara.solo = kara.solo === nm(t) ? null : nm(t); changed(); } })) }]);
  }
  // slowed playback is a rendered copy: anything that changes what's heard renders it again from the same spot
  let karaRerenderTimer = null;
  function karaRerender() { if (!practice) return; clearTimeout(karaRerenderTimer); karaRerenderTimer = setTimeout(() => { if (!practice) return; const t = karaTime(); karaStartSlow(t).catch(fail); }, 250); }
  function karaRange(t) {   // what slowed playback covers: the loop, or the whole song
    if (engine.loop.enabled && engine.loop.end > engine.loop.start + 0.25) { const sc = liveSections().find((x) => Math.abs(x.start - engine.loop.start) < 0.01 && Math.abs(x.end - engine.loop.end) < 0.01); return { from: engine.loop.start, to: engine.loop.end, label: sc ? sc.name : `bars ${barOf(engine.loop.start)}–${endBarNo(engine.loop.end)}` }; }
    void t; return { from: 0, to: karaEnd(), label: 'the whole song' };
  }
  async function karaStartSlow(at) {
    const sp = Number($('#k-speed').value) || 100; const r = karaRange(at);
    await startPractice(r.from, r.to, sp, r.label);
    if (practice && at > r.from + 0.05 && at < r.to - 0.05) practiceSeek(at);
  }
  function practiceSeek(T) {
    if (!practice) return; const p = practice; const len = p.to - p.from; const into = Math.max(0, Math.min(len - 0.01, T - p.from)) * 100 / p.pct;
    try { p.src.onended = null; p.src.stop(); } catch (_) {}
    const src = engine.ctx.createBufferSource(); src.buffer = p.src.buffer; src.loop = true; src.connect(engine.ctx.destination);
    const now = engine.ctx.currentTime + 0.02; src.start(now, into); p.src = src; p.startAt = now - into;
  }
  // jump anywhere: works while playing (normal or slowed) or stopped
  function karaSeek(T) {
    T = Math.max(0, Math.min(karaEnd() - 0.01, T));
    if (practice) { if (T < practice.from - 0.01 || T > practice.to + 0.01) { if (engine.loop.enabled) { engine.setLoop({ enabled: false }); karaLoopSync(); } karaStartSlow(T).catch(fail); } else practiceSeek(T); return; }
    if (engine.recording) return;
    engine.seek(T); positionPlayhead();
  }
  const karaPartStarts = () => liveSections().map((x) => x.start).sort((a, b) => a - b);
  function karaPart(dir) {
    const t = karaTime(); const ps = karaPartStarts(); if (!ps.length) { karaSeek(t + dir * 4 * barLenAt(t)); return; }
    if (dir < 0) { const prev = ps.filter((s) => s < t - 1.0); karaSeek(prev.length ? prev[prev.length - 1] : 0); }
    else { const nx = ps.find((s) => s > t + 0.05); if (nx != null) karaSeek(nx); }
  }
  function karaBar(dir) { const t = karaTime(); const b = barLenAt(Math.max(0, t + (dir < 0 ? -0.01 : 0.01))); const cur = floorBar(t + 1e-3); karaSeek(dir < 0 ? (t - cur > 0.25 ? cur : cur - b) : cur + b); }
  function karaLoopSync() { $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); drawRuler(); kara.partsKey = ''; }
  function karaLoopTo(id) {
    if (!id) engine.setLoop({ enabled: false });
    else if (id !== '__custom') { const sc = liveSections().find((x) => x.id === id); if (sc) { loopSection(sc); if (!engine.playing && !practice) { engine.seek(sc.start); positionPlayhead(); } } }
    karaLoopSync();
    if (practice) karaStartSlow(id && id !== '__custom' ? (liveSections().find((x) => x.id === id) || {}).start || 0 : karaTime()).catch(fail);
  }
  function karaLoopPart() { const t = karaTime(); const sc = CB.sectionAt(state.song, t); if (engine.loop.enabled) karaLoopTo(''); else if (sc) karaLoopTo(sc.id); else { engine.setLoop({ enabled: true, start: floorBar(t), end: barSec(barIdx(floorBar(t)) + 4) }); karaLoopSync(); if (practice) karaStartSlow(t).catch(fail); } }
  async function openKaraoke({ setlist = false } = {}) {
    if (!state.folder) { status('Open a song first — then 🎙 Practice (or K).'); return; }
    await engine.init(); kara.open = true; $('#btn-karaoke').classList.add('active'); $('#karaoke').hidden = false; $('#k-song').textContent = state.song.name;
    let vox = 'guide'; try { vox = localStorage.getItem('bp.kVox') || 'guide'; } catch (_) {} $('#k-vox').value = vox;
    try { const v = localStorage.getItem('bp.kView'); if (v) $('#k-view').value = v; const al = localStorage.getItem('bp.kAlong'); if (al != null) $('#k-along').value = al; hw.key = ''; const c = localStorage.getItem('bp.kCountIn'); $('#k-countin').checked = c == null ? true : c === '1'; } catch (_) {}
    const tp = $('#k-tp'); if (!tp.options.length) { for (let k = -6; k <= 6; k++) tp.append(new Option(k ? `chords ${k > 0 ? '+' : ''}${k}${k < 0 ? ` (capo ${-k})` : ''}` : 'chords as written', String(k))); tp.value = '0'; }
    $('#k-click').checked = engine.click.on; $('#k-clickvol').value = String(engine.click.gainDb);
    karaApplyMix();
    $('#k-speed').value = '100'; kara.key = ''; kara.partsKey = ''; kara.barsKey = ''; kara.wasPlaying = engine.playing; kara.setlist = setlist ? kara.setlist || karaSetlist() : null;
    $('#k-set').classList.toggle('active', !!kara.setlist);
    $('#k-hint').textContent = 'Space play · ← → bar · PgUp/PgDn part · 1–9 part · L loop · M mix · V vocals · - + speed · C click · R record · ↑↓ size · Esc back';
    if (!kara.raf) kara.raf = requestAnimationFrame(karaFrame);
  }
  function closeKaraoke() { engine.pedalNotes = null; if (kara.show) { kara.show = false; $('#karaoke').classList.remove('show'); $('#k-showbar').hidden = true; } practiceFlush(); $('#btn-karaoke').classList.remove('active'); kara.open = false; kara.wasPracticing = false; setTimeout(sendPresence, 0); kara.setlist = null; kara.starting = false; $('#karaoke').hidden = true; engine.tempMute = new Set(); engine.applyAll(); if (practice) stopPractice(); }
  // practice time → the board (1 XP a minute, up to 60 a day), written to my own _quest file per song per day
  function practiceFlush() {
    const secs = kara.practiced || 0; kara.practiced = 0; if (secs < 5 || !state.folder || !quest || !quest.fields) return;
    const q = songQuest(state.folder); const qid = q ? q.qid : `f:${state.folder}`; const day = new Date().toISOString().slice(0, 10);
    const key = `practice:${me()}:${day}:${qid}`; kara.written = kara.written || {}; const cur = Math.max(quest.fields.has(key) ? Number(quest.fields.get(key).v) || 0 : 0, kara.written[key] || 0);
    const mins = Math.round((cur + secs / 60) * 10) / 10; kara.written[key] = mins;
    questWrite({ [key]: mins }).catch(() => {});
    if (Math.floor(cur) < Math.floor(mins) && Math.round(cur) < 60) questPopRaw(Math.min(60, Math.floor(mins)) - Math.floor(cur), 'practice');
  }
  // ---- Show mode: the gig. Setlist locked in order (the next boss battle's songs if one is set), big text, the click
  // (and optionally backing tracks), next / previous song from a foot pedal, nothing editable ----
  function showSetlist() {
    const b = quest && quest.board; const boss = b && b.boss && b.boss.songs && b.boss.songs.length ? b.boss.songs : null;
    let order = b ? b.songs.filter((x) => x.folder && (!boss || boss.includes(x.qid) || boss.includes(x.folder) || boss.includes(x.name))).map((x) => x.folder) : [];
    if (!order.length || !order.includes(state.folder)) order = karaSetlist().order;   /* the boss set only when you start from one of its songs */
    const i = Math.max(0, order.indexOf(state.folder)); return { order, i, startedAt: Date.now(), show: true };
  }
  function showNextUp() { const sl = kara.setlist; const nx = sl && sl.order[sl.i + 1]; $('#k-hint').textContent = `SHOW · ${sl ? `song ${sl.i + 1} of ${sl.order.length}` : ''}${nx ? ` · next: ${nx}` : ' · last song'} · pedal / → next song · ← previous · Space start / stop`; }
  async function setShow(on) {
    kara.show = !!on; $('#karaoke').classList.toggle('show', kara.show); $('#k-showbar').hidden = !kara.show;
    engine.pedalNotes = kara.show ? new Set(Object.values(pedal()).filter((p) => p && p.kind === 'note').map((p) => Number(p.code))) : null;   /* pedal notes don't sound only in Show */
    if (kara.show) {
      if (practice) stopPractice(); if (engine.playing) await stop();
      kara.setlist = showSetlist(); $('#k-set').classList.add('active');
      engine.setLoop({ enabled: false }); karaLoopSync(); $('#k-speed').value = '100'; $('#k-countin').checked = true;
      engine.click.on = true; $('#k-click').checked = true; $('#click-on').checked = true;
      if (!state.readOnly && state.dirty) await save();
      karaApplyMix(); engine.seek(0); positionPlayhead(); showNextUp();
      toast(`Show mode: ${kara.setlist.order.length} songs${quest && quest.board && quest.board.boss && quest.board.boss.songs && quest.board.boss.songs.length ? ` (the ${quest.board.boss.title} set)` : ''}. Pedal or → for the next song, Space to start. ${state.settings.clickOutputId ? 'The click goes to its own output.' : 'Settings → Click output sends the click to in-ears.'}`, { kind: 'ok', ms: 9000 });
    } else { kara.setlist = null; $('#k-set').classList.remove('active'); karaApplyMix(); $('#k-hint').textContent = ''; }
  }
  async function showStep(d) { if (!kara.setlist) kara.setlist = showSetlist(); if (engine.playing) await stop(); const sl = kara.setlist; if (sl.i + d < 0 || sl.i + d >= sl.order.length) { status(d > 0 ? 'That was the last song. 🤘' : 'First song.'); return; } const g = $('#k-gap').value; $('#k-gap').value = '0'; try { await karaGoSongNoPlay(d); } finally { $('#k-gap').value = g; } showNextUp(); }
  async function karaGoSongNoPlay(step) { practiceFlush(); const sl = kara.setlist; const target = sl.order[sl.i + step]; if (!target) return; const keep = sl; await openSong(target); kara.setlist = keep; if (state.folder !== target) { status(`Couldn't open ${target}.`); return; } sl.i += step; $('#k-song').textContent = state.song ? state.song.name : ''; kara.key = ''; kara.partsKey = ''; kara.barsKey = ''; engine.setLoop({ enabled: false }); karaLoopSync(); karaApplyMix(); engine.seek(0); kara.lastPos = 0; }
  // pedal: learn which key / MIDI note / CC means next, previous, start-stop
  const pedal = () => state.settings.showPedal || {};
  const pedalHit = (kind, code) => { for (const [act, p] of Object.entries(pedal())) if (p && p.kind === kind && String(p.code) === String(code)) return act; return null; };
  function pedalAct(act) { if (act === 'next') showStep(1).catch(fail); else if (act === 'prev') showStep(-1).catch(fail); else if (act === 'go') karaToggle().catch(fail); }
  engine.on((ev, data) => { if (!kara.open || !kara.show || kara.learning) return; if (ev === 'midi' && data.on) { const a = pedalHit('note', data.note); if (a) pedalAct(a); } if (ev === 'midi:cc' && data.val >= 64) { const a = pedalHit('cc', data.cc); if (a) pedalAct(a); } });
  async function learnPedal() {
    const got = {}; kara.learning = true;
    try {
      for (const [act, label] of [['next', 'NEXT SONG'], ['prev', 'PREVIOUS SONG'], ['go', 'START / STOP (or Skip)']]) {
        const hit = await new Promise((resolve) => {
          const d = $('#ask'); $('#ask-title').textContent = '🦶 Pedal'; $('#ask-text').textContent = `Press the pedal for ${label} now.`;
          const menu = $('#ask-menu'); menu.innerHTML = ''; const sk = el('button', null, 'Skip'); sk.value = 'skip'; const cn = el('button', null, 'Cancel'); cn.value = ''; menu.append(sk, cn);
          let done = false; const fin = (v) => { if (done) return; done = true; window.removeEventListener('keydown', kh, true); off(); if (d.open) d.close(v && v.kind ? 'hit' : (v || '')); resolve(v); };
          const kh = (e) => { if (['Tab'].includes(e.key)) return; if (e.target && e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return; e.preventDefault(); e.stopPropagation(); fin({ kind: 'key', code: e.code || e.key }); };
          const off = engine.on((ev, x) => { if (ev === 'midi' && x.on) fin({ kind: 'note', code: x.note }); if (ev === 'midi:cc' && x.val >= 64) fin({ kind: 'cc', code: x.cc }); });
          window.addEventListener('keydown', kh, true);
          d.returnValue = ''; d.showModal(); d.addEventListener('close', () => fin(d.returnValue === 'skip' ? 'skip' : d.returnValue === 'hit' ? null : ''), { once: true });
        });
        if (hit === '') return null; if (hit && hit.kind) got[act] = hit;
      }
    } finally { kara.learning = false; }
    state.settings = await bp.settings.set({ showPedal: got });
    engine.pedalNotes = kara.show ? new Set(Object.values(got).filter((p) => p.kind === 'note').map((p) => Number(p.code))) : null;
    toast(`Pedal set: ${Object.entries(got).map(([a, p]) => `${a === 'go' ? 'start/stop' : a} = ${p.kind === 'key' ? p.code.replace(/^Key/, '') : p.kind === 'note' ? `MIDI note ${p.code}` : `MIDI CC ${p.code}`}`).join(' · ') || 'nothing'}.`, { kind: 'ok', ms: 8000 });
    return got;
  }
  $('#k-show').addEventListener('click', () => setShow(!kara.show).catch(fail));
  $('#k-pedal').addEventListener('click', () => learnPedal().catch(fail));
  $('#k-backing').addEventListener('change', (e) => { karaApplyMix(); try { localStorage.setItem('bp.kBacking', e.target.value); } catch (_) {} e.target.blur(); });
  $('#k-phone').addEventListener('click', () => openPhoneLink().catch(fail));
  try { const v = localStorage.getItem('bp.kBacking'); if (v) $('#k-backing').value = v; } catch (_) {}
  function karaSetlist() {
    const b = quest && quest.board; const order = b ? b.songs.filter((s) => s.folder).map((s) => s.folder) : (state.songs || []).filter((s) => !/^Noodle pad/.test(s.folder)).map((s) => s.folder);
    const i = Math.max(0, order.indexOf(state.folder)); return { order: order.slice(i).concat(order.slice(0, i)), i: 0, startedAt: Date.now() };
  }
  async function karaGoSong(step) {
    practiceFlush(); const sl = kara.setlist; if (!sl) return; sl.i += step; kara.wasPlaying = false; if (practice) stopPractice();
    if (sl.i < 0) sl.i = 0;
    if (sl.i >= sl.order.length) { kara.setlist = null; $('#k-set').classList.remove('active'); const mins = Math.round((Date.now() - sl.startedAt) / 60000); logActivity(`rehearsed the setlist (${sl.order.length} songs, ${mins} min)`); { const key = `setlist:${me()}:${new Date().toISOString().slice(0, 10)}`; const cur = quest.fields && quest.fields.has(key) ? Number(quest.fields.get(key).v) || 0 : 0; questWrite({ [key]: cur + 1 }).catch(() => {}); } if (!state.readOnly && state.dirty) save(); toast(`End of the setlist — ${sl.order.length} songs in ${mins} min. 🤘`, { kind: 'ok', ms: 12000 }); return; }
    const folder = sl.order[sl.i]; const auto = step > 0 && kara.lastPos > 0;
    if (engine.playing) await stop();
    const keep = sl; await openSong(folder); kara.setlist = keep;
    if (state.folder !== folder) { sl.i -= step; status(`Couldn't open ${folder} — the setlist stays where it was.`); return; } $('#k-song').textContent = state.song ? state.song.name : folder; kara.key = ''; kara.partsKey = ''; kara.barsKey = '';
    engine.setLoop({ enabled: false }); karaLoopSync(); karaApplyMix(); engine.seek(0); kara.lastPos = 0;
    const gap = Number($('#k-gap').value) || 0;
    for (let s = gap; s > 0 && kara.open && kara.setlist === keep; s--) { kara.starting = `${state.song.name} in ${s}…`; await new Promise((r) => setTimeout(r, 1000)); }
    kara.starting = false; void auto;
    if (kara.open && kara.setlist === keep) await karaPlay();
  }
  const karaNextSong = () => karaGoSong(1);
  // play from where you are, with a bar of count-in first when that's on
  async function karaPlay() {
    const sp = Number($('#k-speed').value) || 100;
    if ($('#k-countin').checked) {
      await engine.resume(); const pos = sp < 100 ? karaRange(engine.playhead).from : engine.playhead; const plan = engine.countInPlan(pos); const n0 = engine.ctx.currentTime + 0.05;
      const per = engine.click.countIn ? plan : (() => { const was = engine.click.countIn; engine.click.countIn = true; const p = engine.countInPlan(pos); engine.click.countIn = was; return p; })();
      for (const c of per.clicks) engine.clickAt(n0 + c.dt * 100 / sp, c.accent, true);
      kara.starting = '♩'; await new Promise((r) => setTimeout(r, (per.length * 100 / sp) * 1000 + 50)); kara.starting = false;
      if (!kara.open) return;
    }
    if (sp < 100) { await karaStartSlow(engine.playhead); return; }
    await play();
  }
  async function karaToggle() {
    if (kara.starting) return;
    if (practice) { const t = karaTime(); stopPractice(); engine.seek(t); positionPlayhead(); return; }
    if (engine.recording) { await finishRecording(); return; }
    if (engine.playing) { engine.pause(); positionPlayhead(); return; }
    await karaPlay();
  }
  function karaSpeed(d) { const sel = $('#k-speed'); const opts = [...sel.options].map((o) => o.value); const i = opts.indexOf(sel.value); const j = Math.max(0, Math.min(opts.length - 1, i - d)); if (j === i) return; sel.value = opts[j]; sel.dispatchEvent(new Event('change')); }
  function karaSpeedChanged() {
    const sp = Number($('#k-speed').value) || 100; const t = karaTime(); const was = !!practice || engine.playing;
    if (practice) stopPractice();
    if (!was) { engine.seek(t); return; }
    if (sp < 100) { if (engine.playing) engine.pause(); karaStartSlow(t).catch(fail); } else { engine.seek(t); play().catch(fail); }
  }
  $('#btn-karaoke').addEventListener('click', () => openKaraoke().catch(fail));
  $('#k-close').addEventListener('click', closeKaraoke);
  $('#k-play').addEventListener('click', () => karaToggle().catch(fail));
  $('#k-back').addEventListener('click', () => karaBar(-1)); $('#k-fwd').addEventListener('click', () => karaBar(1));
  $('#k-prevpart').addEventListener('click', () => karaPart(-1)); $('#k-nextpart').addEventListener('click', () => karaPart(1));
  $('#k-loopsel').addEventListener('change', (e) => { karaLoopTo(e.target.value); e.target.blur(); });
  $('#k-mix').addEventListener('click', karaMixMenu);
  $('#k-vox').addEventListener('change', (e) => { setVox(e.target.value); e.target.blur(); });
  $('#k-speed').addEventListener('change', (e) => { karaSpeedChanged(); e.target.blur(); });
  $('#k-view').addEventListener('change', (e) => { try { localStorage.setItem('bp.kView', e.target.value); } catch (_) {} kara.barsKey = ''; e.target.blur(); });
  $('#k-tp').addEventListener('change', (e) => { kara.barsKey = ''; hw.key = ''; e.target.blur(); });
  $('#k-countin').addEventListener('change', (e) => { try { localStorage.setItem('bp.kCountIn', e.target.checked ? '1' : '0'); } catch (_) {} e.target.blur(); });
  $('#k-click').addEventListener('change', (e) => { engine.click.on = e.target.checked; $('#click-on').checked = engine.click.on; if (engine.playing) { const t = engine.currentPos(); engine.seek(t); play().catch(fail); } karaRerender(); e.target.blur(); });
  $('#k-clickvol').addEventListener('input', (e) => { engine.click.gainDb = Number(e.target.value); engine.applyAll(); });
  $('#k-clickvol').addEventListener('change', async (e) => { state.settings = await bp.settings.set({ clickDb: engine.click.gainDb }); e.target.blur(); });
  $('#k-rec').addEventListener('click', () => (engine.recording ? finishRecording() : record()).catch(fail));
  $('#k-set').addEventListener('click', () => { if (kara.setlist) { kara.setlist = null; $('#k-set').classList.remove('active'); } else { kara.setlist = karaSetlist(); $('#k-set').classList.add('active'); status(`Setlist rehearsal: ${kara.setlist.order.length} songs, starting with ${kara.setlist.order[0]}. Each one opens and plays when the last ends.`, 8000); if (practice) stopPractice(); engine.setLoop({ enabled: false }); karaLoopSync(); engine.seek(0); karaPlay().catch(fail); } });
  $('#k-prevsong').addEventListener('click', () => karaGoSong(-1).catch(fail)); $('#k-nextsong').addEventListener('click', () => karaGoSong(1).catch(fail));
  { // scrub: click or drag anywhere on the bar
    const bar = $('#k-progress'); const at = (ev) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * karaEnd(); };
    bar.addEventListener('mousedown', (e) => { e.preventDefault(); karaSeek(at(e)); const mv = (ev) => { if (!practice && !engine.playing) karaSeek(at(ev)); }; const up = (ev) => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); karaSeek(at(ev)); }; window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); });
  }
  const karaSize = (d) => { kara.size = Math.max(0.6, Math.min(2.2, kara.size + d)); $('#k-stage').style.setProperty('--ks', kara.size); };
  $('#k-size').addEventListener('click', () => karaSize(kara.size >= 2 ? -1.4 : 0.2));
  $('#karaoke').addEventListener('keydown', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (!kara.open || document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') && !(e.target.type === 'checkbox' || e.target.type === 'range')) return;
    if (e.target && /^(INPUT|SELECT|BUTTON)$/.test(e.target.tagName)) e.target.blur();
    const k = e.key.toLowerCase(); let used = true;
    if (kara.show) {   // the gig: pedal keys first, then only start / stop, next / previous song, Esc
      const pa = pedalHit('key', e.code || e.key);
      if (pa) pedalAct(pa);
      else if (e.code === 'Space' || e.key === 'Enter') karaToggle().catch(fail);
      else if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) showStep(1).catch(fail);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) showStep(-1).catch(fail);
      else if (e.key === 'Escape') setShow(false).catch(fail);
      else used = false;
      if (used || !((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) { e.preventDefault(); e.stopPropagation(); }   /* nothing editable leaks through in a gig */
      return;
    }
    if (e.code === 'Space') karaToggle().catch(fail);
    else if (e.key === 'Escape') closeKaraoke();
    else if (e.key === 'ArrowLeft' || e.key === ',') karaBar(-1);
    else if (e.key === 'ArrowRight' || e.key === '.') karaBar(1);
    else if (e.key === 'PageUp') karaPart(-1);
    else if (e.key === 'PageDown') karaPart(1);
    else if (e.key === 'Home') karaSeek(0);
    else if (/^Digit[1-9]$/.test(e.code) && !e.ctrlKey && !e.metaKey) { const x = liveSections().slice().sort((a, b) => a.start - b.start)[Number(e.code.slice(5)) - 1]; if (x) { if (e.shiftKey) karaLoopTo(x.id); else karaSeek(x.start); } }
    else if (k === 'l') karaLoopPart();
    else if (k === 'm') karaMixMenu();
    else if (k === 'v') setVox($('#k-vox').value === 'off' ? 'guide' : 'off');
    else if (k === 'c') { $('#k-click').checked = !$('#k-click').checked; $('#k-click').dispatchEvent(new Event('change')); }
    else if (e.key === '-' || e.key === '_') karaSpeed(-1);
    else if (e.key === '=' || e.key === '+') karaSpeed(1);
    else if (k === 'r') (engine.recording ? finishRecording() : record()).catch(fail);
    else if (e.key === 'ArrowUp' && e.shiftKey) karaGoSong(-1).catch(fail);
    else if (e.key === 'ArrowDown' && e.shiftKey) karaGoSong(1).catch(fail);
    else if (e.key === 'ArrowUp') karaSize(0.15);
    else if (e.key === 'ArrowDown') karaSize(-0.15);
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }, true);


  // ---------- "needs" checklist ----------
  const liveNeeds = () => CB.live(CB.list(state.song, 'needs'));
  // "needs bass on the chorus @Logan" → who: Logan, section: the first Chorus (when one exists)
  function addNeed(text, { who = null, sectionId = null } = {}) {
    const t = String(text || '').trim().slice(0, 120); if (!t) return null;
    const people = CB.knownPeople(collectSong(), [me()]); const ment = CB.mentionsIn(t, people);
    const w = who || ment[0] || null;
    let sid = sectionId; if (!sid) { const low = t.toLowerCase(); const sc = liveSections().slice().sort((a, b) => b.name.length - a.name.length).find((x) => low.includes(x.name.toLowerCase())) || liveSections().find((x) => low.includes(TPL.sectionType(x.name))); if (sc) sid = sc.id; }
    let n = null; cchange(() => { n = { id: newId(), text: t, by: me(), at: nowIso(), done: null, ...(w ? { who: w } : {}), ...(sid ? { sectionId: sid } : {}) }; (state.song.needs = state.song.needs || []).push(n); }, { label: `needs: ${t}${w ? ` → ${w}` : ''}` }); renderAll(); return n;
  }
  function assignNeed(n, who) { cchange(() => { if (who) n.who = who; else delete n.who; }, { label: `${who ? `assigned to ${who}` : 'unassigned'}: ${n.text}` }); renderAll(); }
  function needSection(n, sid) { cchange(() => { if (sid) n.sectionId = sid; else delete n.sectionId; }, { label: `needs in section: ${n.text}` }); renderAll(); }
  function setNeedDone(n, yes) { cchange(() => { n.done = yes ? { by: me(), at: nowIso() } : null; }, { label: `${yes ? 'done' : 'not done'}: ${n.text}` }); renderAll(); }
  function renderNeeds() {
    const ul = $('#need-list'); ul.innerHTML = ''; const all = liveNeeds(); const open = all.filter((n) => !n.done), done = all.filter((n) => n.done);
    $('#tb-needs').textContent = open.length ? String(open.length) : '';
    $('#need-input').disabled = false;
    if (!all.length) ul.append(el('li', 'muted', 'What does this song still need? e.g. "needs bass", "needs a harmony on the chorus", "needs a real drummer". Open items show as a badge on the song list.'));
    // stable order (the order they were added): a ticked item stays where it is, so the next click can't land on a different one
    for (const n of all) {
      const li = el('li', n.done ? 'done' : ''); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!n.done; cb.addEventListener('change', () => setNeedDone(n, cb.checked));
      const tx = el('span', 'ntext'); tx.append(withMentions(n.text));
      const sec = n.sectionId && liveSections().find((x) => x.id === n.sectionId);
      if (n.who || sec) { const tg = el('span', 'ntag' + (n.who && CB.nameMatch(n.who, me()) ? ' mine' : ''), `${n.who ? `→ ${n.who}` : ''}${n.who && sec ? ' · ' : ''}${sec ? sec.name : ''}`); if (sec) { tg.title = `go to ${sec.name}`; tg.addEventListener('click', () => { engine.seek(sec.start); positionPlayhead(); }); } tx.append(' ', tg); }
      li.append(cb, tx, el('span', 'nby', n.done ? `✓ ${n.done.by}` : n.by || ''));
      { const x = el('button', null, '✕'); x.title = 'Remove this need from the list — it got done, or the song does not need it any more. Ctrl/Cmd+Z brings it back.'; x.addEventListener('click', () => { cchange(() => { n.deleted = true; n.deletedBy = me(); }, { label: `removed need: ${n.text}` }); renderAll(); }); li.append(x); }
      M.attach(li, () => [{ title: n.text }, { label: n.done ? 'Mark not done' : 'Mark done ✓', action: () => setNeedDone(n, !n.done) },
        { label: 'Assign to', sub: [...CB.knownPeople(collectSong(), [me()]).map((p) => ({ label: p, checked: !!n.who && CB.nameMatch(n.who, p), action: () => assignNeed(n, p) })), 'sep', { label: 'Someone else…', action: async () => { const v = await promptName('Assign to (their Cobander name)', n.who || ''); if (v) assignNeed(n, v.slice(0, 40)); } }, { label: 'Nobody', action: () => assignNeed(n, null) }], disabled: ro() },
        { label: 'For section', sub: [...liveSections().map((sc) => ({ label: sc.name, checked: n.sectionId === sc.id, action: () => needSection(n, sc.id) })), 'sep', { label: 'Whole song', action: () => needSection(n, null) }], disabled: ro() || !liveSections().length }, { label: 'Edit…', action: async () => { const v = await promptName('Needs…', n.text); if (v) { cchange(() => { n.text = v.slice(0, 120); }, { label: 'edit need' }); renderAll(); } }, disabled: ro() }, { label: 'Remove', danger: true, action: () => { cchange(() => { n.deleted = true; }, { label: `removed need: ${n.text}` }); renderAll(); }, disabled: ro() }]);
      ul.append(li);
    }
  }
  $('#need-form').addEventListener('submit', (e) => { e.preventDefault(); if (addNeed($('#need-input').value)) $('#need-input').value = ''; });

  // ---------- idea scratchpad: sketches / voice memos that are not on the timeline ----------
  const liveIdeas = () => CB.live(CB.list(state.song, 'ideas'));
  const ideaBufs = new Map(); let ideaPlaying = null; let sketchRec = null;
  async function ideaBuffer(i) { if (ideaBufs.has(i.audioId)) return ideaBufs.get(i.audioId); await engine.init(); const ab = await bp.audio.read(state.folder, i.audioId); const buf = await window.BPWav.decodeWav(engine.ctx, ab); ideaBufs.set(i.audioId, buf); return buf; }
  async function saveIdeaAudio(arrayBuffer, title) {
    if (ro()) throw new Error('Read-only — take over to add ideas.');
    await engine.init();
    let buf; try { buf = await engine.ctx.decodeAudioData(arrayBuffer.slice(0)); } catch (err) { throw new Error(`Could not read that audio (${err.message || 'unsupported format'}). WAV, MP3, M4A/AAC, OGG and FLAC work.`); }
    if (buf.duration > 20 * 60) throw new Error('That file is over 20 minutes — trim it first.');
    const chans = window.BPWav.audioBufferToChannels(buf).slice(0, 2);
    const audioId = newId(); const name = String(title || 'sketch').replace(/\.[^.]+$/, '').slice(0, 60) || 'sketch';
    await bp.audio.write(state.folder, audioId, window.BPWav.encodeWav(chans, buf.sampleRate, 16), { label: `Idea - ${name} - ${me()}` });
    ideaBufs.set(audioId, buf);
    let idea = null;
    cchange(() => { idea = { id: newId(), title: name, kind: 'audio', audioId, seconds: Math.round(buf.duration * 10) / 10, by: me(), at: nowIso() }; (state.song.ideas = state.song.ideas || []).push(idea); }, { label: `idea "${name}"` });
    renderAll(); save();
    return idea;
  }
  function stopIdea() { if (!ideaPlaying) return; const p = ideaPlaying; ideaPlaying = null; try { p.src.onended = null; p.src.stop(); } catch (_) {} renderIdeas(); }
  async function playIdea(i) {
    if (ideaPlaying && ideaPlaying.id === i.id) { stopIdea(); return; }
    stopIdea(); stopPreview(); if (engine.playing && !engine.recording) await stop();
    const buf = await ideaBuffer(i); const src = engine.ctx.createBufferSource(); src.buffer = buf; src.connect(engine.ctx.destination);
    src.onended = () => { if (ideaPlaying && ideaPlaying.src === src) { ideaPlaying = null; renderIdeas(); } };
    engine.resume && engine.resume(); src.start(); ideaPlaying = { id: i.id, src }; renderIdeas();
  }
  // a sung / hummed sketch's words become unpinned lyric lines: when the real vocal is transcribed later they get
  // pinned where they're sung (speech-to-text matches typed lines first)
  async function ideaToLyrics(i) {
    const buf = await ideaBuffer(i); const closeProg = toast(`Speech-to-text: ${i.title}…`, { ms: 900000 });
    let r; try { r = await ASR.transcribe(buf, { model: asrModel(), bridge: bp.asr }); } finally { closeProg(); }
    if (!r.lines.length) { status("Didn't hear any words in that sketch.", 6000); return 0; }
    return textToLyrics(r.lines.map((l) => l.text).join('\n'), i.title);
  }
  function textToLyrics(text, from) {
    const lines = String(text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 200); if (!lines.length) return 0;
    const have = new Set(liveLyrics().map((l) => String(l.text).trim().toLowerCase()));
    const add = lines.filter((x) => !have.has(x.toLowerCase()));
    if (!add.length) { status('Those lines are already in the lyrics.'); return 0; }
    cchange(() => { const arr = state.song.lyrics = state.song.lyrics || []; for (const x of add) arr.push({ id: newId(), time: null, text: x.slice(0, 200), by: me(), at: nowIso() }); }, { label: `lyrics from "${from}" (${add.length} lines)` });
    renderAll(); showTab('lyrics'); status(`${add.length} line${add.length === 1 ? '' : 's'} added unpinned — P pins the next one while the song plays, or 🎤 From the vocals pins them once a vocal is recorded.`, 10000);
    return add.length;
  }
  async function ideaToTimeline(i) {
    if (ro()) { status('Read-only — take over first.'); return; }
    const buf = await ideaBuffer(i); engine.buffers.set(i.audioId, buf);
    let t = engine.track(state.selectedTrack); if (!t || t.instrument !== 'audio') t = engine.tracks.find((x) => x.instrument === 'audio') || null;
    const clip = { id: newId(), src: i.audioId, name: i.title, start: engine.playhead, gainDb: 0, trimStart: 0, trimEnd: 0, fadeIn: 0, fadeOut: 0, duration: buf.duration, channels: buf.numberOfChannels, takenBy: i.by || null, takenAt: i.at || null, mute: false };
    change(() => { if (!t) t = engine.addTrack(i.title); t.clips.push(clip); state.selectedTrack = t.id; state.selectedClip = clip.id; }, { label: `idea "${i.title}" onto ${t ? t.name : 'a new track'}` });
    renderAll(); status(`"${i.title}" is on ${t.name} at ${posLabel(clip.start)} (it stays in Ideas too).`);
  }
  // Stop an idea sketch in progress and wait until it is saved (close song, quit, update).
  async function flushSketch() { if (!sketchRec) return; await new Promise((r) => { const o = sketchRec.rec.onstop; sketchRec.rec.onstop = async (e) => { try { await o(e); } finally { r(); } }; sketchRec.rec.stop(); }); }
  async function toggleSketch() {
    if (sketchRec) { sketchRec.rec.stop(); return; }
    if (!state.folder) return; if (ro()) { status('Read-only — take over to record a sketch.'); return; }
    if (engine.recording) { status('Stop recording first.'); return; }
    await bp.mic.ensure();
    const dev = state.settings.inputDeviceId;
    const want = (id) => navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    let stream; try { stream = await want(dev).catch((err) => { if (dev && /Overconstrained|NotFound|NotReadable/.test(err.name || '')) return want(null); throw err; }); } catch (err) { fail(new Error(`Could not open the mic (${err.message || err.name}).${bp.platform === 'darwin' ? ' Check System Settings → Privacy & Security → Microphone → Cobander.' : ''}`)); return; }
    const chunks = []; const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const startedAt = Date.now(); const btn = $('#btn-idea-rec'); btn.classList.add('active');
    const tick = setInterval(() => { btn.textContent = `■ Stop ${Math.floor((Date.now() - startedAt) / 1000)}s`; }, 250);
    rec.onstop = async () => {
      clearInterval(tick); stream.getTracks().forEach((tr) => tr.stop()); sketchRec = null; btn.classList.remove('active'); btn.textContent = '● Sketch';
      if (Date.now() - startedAt < 700) { status('Sketch too short — nothing saved.'); return; }
      try { const n = liveIdeas().filter((x) => x.kind === 'audio').length + 1; const ab = await new Blob(chunks, { type: rec.mimeType || 'audio/webm' }).arrayBuffer(); const i = await saveIdeaAudio(ab, `sketch ${n}`); toast(`Saved "${i.title}" (${i.seconds} s) to Ideas. Right-click it to rename or put it on the timeline.`, { kind: 'ok', ms: 6000 }); } catch (err) { fail(err); }
    };
    sketchRec = { rec }; rec.start(); status('Recording a sketch for Ideas — it does not go on the timeline. Click ■ to stop.', 0);
  }
  function renderIdeas() {
    const ul = $('#idea-list'); ul.innerHTML = ''; const ideas = liveIdeas().slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
    $('#tb-ideas').textContent = ideas.length ? String(ideas.length) : ''; $('#tb-ideas').className = 'tab-badge';
    for (const b of ['#btn-idea-rec', '#btn-idea-file', '#btn-idea-text']) $(b).disabled = ro() && !(b === '#btn-idea-rec' && sketchRec);
    if (!ideas.length) ul.append(el('li', 'muted', 'none yet'));
    for (const i of ideas) {
      const li = el('li');
      if (i.kind === 'audio') { const p = el('button', null, ideaPlaying && ideaPlaying.id === i.id ? '■' : '▶'); p.title = 'Play this idea back so you can hear it (the song pauses). Press again to stop.'; p.addEventListener('click', () => playIdea(i).catch(fail)); li.append(p); }
      else li.append(el('span', null, '📝'));
      const tx = el('span', 'itext'); tx.append(withMentions(i.kind === 'text' ? i.text : i.title)); tx.title = i.kind === 'text' ? i.text : i.title; li.append(tx);
      li.append(el('span', 'imeta', `${i.by || ''} · ${i.at ? timeAgo(i.at) : ''}${i.seconds ? ` · ${Math.floor(i.seconds / 60)}:${String(Math.round(i.seconds % 60)).padStart(2, '0')}` : ''}`));
      M.attach(li, () => [{ title: i.title }, ...(i.kind === 'audio' ? [{ label: ideaPlaying && ideaPlaying.id === i.id ? 'Stop' : 'Listen', action: () => playIdea(i).catch(fail) }, { label: 'Put on the timeline at the playhead', action: () => ideaToTimeline(i).catch(fail), disabled: ro() }, { label: '🎤 Words from this sketch → Lyrics (unpinned)', action: () => ideaToLyrics(i).catch(fail), disabled: !!asrBusy }] : [{ label: 'Use as lyrics (one line per row, unpinned)', action: () => textToLyrics(i.text, i.title) }, { label: 'Edit…', action: async () => { const v = await promptName('Idea', i.text); if (v) { cchange(() => { i.text = v.slice(0, 2000); i.title = v.slice(0, 40); }, { label: 'edit idea' }); renderAll(); } }, disabled: ro() }]), { label: 'Rename…', action: async () => { const v = await promptName('Idea name', i.title); if (v) { cchange(() => { i.title = v.slice(0, 60); }, { label: `rename idea to ${v}` }); renderAll(); } }, disabled: ro() || i.kind === 'text' }, { label: 'Delete', danger: true, action: () => { if (ideaPlaying && ideaPlaying.id === i.id) stopIdea(); cchange(() => { i.deleted = true; i.deletedBy = me(); }, { label: `deleted idea "${i.title}"` }); renderAll(); refreshUnreferenced(); }, disabled: ro() }]);
      ul.append(li);
    }
  }
  $('#btn-idea-rec').addEventListener('click', () => toggleSketch().catch(fail));
  $('#btn-idea-file').addEventListener('click', () => { if (!ro()) $('#idea-file').click(); });
  $('#idea-file').addEventListener('change', async (e) => { const files = [...e.target.files]; e.target.value = ''; for (const f of files) { try { status(`Adding ${f.name}…`, 0); const i = await saveIdeaAudio(await f.arrayBuffer(), f.name); status(`Added "${i.title}" to Ideas.`); } catch (err) { fail(err); } } });
  $('#btn-idea-text').addEventListener('click', async () => { if (ro()) return; const v = await promptName('Idea (a riff description, a lyric line, a reference song…)', ''); if (!v) return; cchange(() => { (state.song.ideas = state.song.ideas || []).push({ id: newId(), title: v.slice(0, 40), kind: 'text', text: v.slice(0, 2000), by: me(), at: nowIso() }); }, { label: `idea "${v.slice(0, 30)}"` }); renderAll(); pingToast(v); });

  // ---------- activity feed ----------
  async function refreshHistoryIds() { if (!state.folder) return; try { state.historyIds = new Set((await bp.song.listHistory(state.folder)).map((h) => h.saveId)); } catch (_) { state.historyIds = null; } }
  function renderFeed() {
    const ul = $('#feed-list'); ul.innerHTML = '';
    if (state.pendingActivity.length) { const li = el('li'); li.append(el('span', 'fwho', 'you'), el('span', 'fwhen', 'not saved yet')); li.append(el('div', 'fitems muted', CB.activityEntry(state.pendingActivity, me(), nowIso(), 'x').items.join(' · '))); ul.append(li); }
    const items = CB.feed(state.song).slice(0, 150);
    if (!items.length && !state.pendingActivity.length) ul.append(el('li', 'muted', 'Every save adds a line here: who changed what.'));
    for (const a of items) {
      const li = el('li'); li.append(el('span', 'fwho', a.by), el('span', 'fwhen', timeAgo(a.at)));
      li.title = `${new Date(a.at).toLocaleString()}${a.base ? ' — right-click to hear or roll back to the song as it was before this' : ''}`;
      li.append(el('div', 'fitems', a.items.join(' · ')));
      if (a.base && (!state.historyIds || state.historyIds.has(a.base))) {
        li.classList.add('rollable');
        const hv = { id: `h-${a.base}`, history: a.base, name: `before ${a.by}'s change (${timeAgo(a.at)})`, by: a.by, at: a.at };
        M.attach(li, () => [{ title: `${a.by} · ${new Date(a.at).toLocaleString()}` },
          { label: state.ab && state.ab.id === hv.id ? 'Back to now' : 'Listen: A/B the song before this', action: () => enterAB(hv).catch(fail) },
          { label: 'Roll back to before this…', action: () => rollBack(a).catch(fail), disabled: ro() }]);
      }
      ul.append(li);
    }
  }
  // Roll back to the save an activity entry replaced (history/rev-*.json). Undoable; the feed itself is never rolled back.
  async function rollBack(a) {
    if (ro()) { status('Read-only — take over first.'); return; }
    if (engine.recording || finishing) { status('Stop recording first.'); return; }
    const choice = await ask('Roll back', `Put the song back the way it was before ${a.by}'s change (${new Date(a.at).toLocaleString()})?\n\n"Tracks & takes" brings back the takes, mix and tempo but keeps today's notes, lyrics, chords, sections and needs. "Everything" rolls those back too.\n\nNo audio is ever deleted, and ${MOD}+Z undoes the roll-back.`, [['Tracks & takes', 'audio', 'primary'], ['Everything', 'all'], ['Cancel', 'cancel']]);
    if (choice !== 'audio' && choice !== 'all') return;
    if (state.ab) await leaveAB({ silent: true });
    const body = await bp.song.readHistory(state.folder, a.base);
    { // takes that exist now but not in the roll-back point go to Deleted takes (restorable); current trash is kept
      const keep = new Set((body.tracks || []).flatMap((t) => (t.clips || []).map((c) => c.id)));
      const trash = { ...(body.trash || {}), ...(state.song.trash || {}) };
      for (const t of engine.tracks) for (const c of t.clips) if (!c.link && !keep.has(c.id)) trash[c.id] = { clip: JSON.parse(JSON.stringify(c)), name: c.name, trackId: t.id, trackName: t.name, start: c.start, takenBy: c.takenBy, at: new Date().toISOString() };
      body.trash = trash; body.trashTracks = { ...(body.trashTracks || {}), ...(state.song.trashTracks || {}) };
    }
    pushUndo(`roll back to before ${a.by}'s change`);
    await loadAudio(state.folder, body);
    await restoreSnapshot(JSON.stringify(choice === 'all' ? body : takesOnly(body)));
    logActivity(`rolled back${choice === 'all' ? ' everything' : ''} to before ${a.by}'s change of ${new Date(a.at).toLocaleString()}`);
    status(`Rolled back. ${MOD}+Z undoes it; it saves in a few seconds like any edit.`, 10000);
  }

  // ---------- version tags + A/B ----------
  const liveVersions = () => CB.live(CB.list(state.song, 'versions')).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  let abLast = null;
  async function tagVersion(name) {
    if (ro()) throw new Error('Read-only — take over to tag a version.');
    if (state.ab) await leaveAB({ silent: true });
    const nm = String(name || '').trim().slice(0, 60); if (!nm) return null;
    const id = newId(); await bp.song.writeVersion(state.folder, id, collectSong());
    let v = null; change(() => { v = { id, name: nm, by: me(), at: nowIso(), rev: state.song.rev }; (state.song.versions = state.song.versions || []).push(v); }, { undoable: false, label: `tagged version "${nm}"` });
    abLast = id; renderAll(); save(); return v;
  }
  async function enterAB(v) {
    if (engine.recording || finishing) { status('Stop recording first.'); return; }
    if (tempoBusy) { status('Still re-speeding the takes — one moment.'); return; }
    if (state.ab && state.ab.id === v.id) return leaveAB();
    if (state.ab) await leaveAB({ silent: true });
    const vs = v.history ? await bp.song.readHistory(state.folder, v.history) : await bp.song.readVersion(state.folder, v.id);
    const current = JSON.stringify(collectSong());
    const pos = engine.playhead, was = engine.playing; if (was) engine.stop();
    await loadAudio(state.folder, vs);
    state.ab = { id: v.id, name: v.name, current }; abLast = v.id;
    engine.loadSong(vs); engine.playhead = pos;
    $('#song').classList.add('ab'); $('#bottom').classList.add('ab'); $('#notes').readOnly = true; renderAll();
    if (was) await play();
    status(`B: "${v.name}" (${v.by}, ${timeAgo(v.at)}). Press A/B (or B) to flip back to what you have now — playback keeps its place.`, 0);
  }
  async function leaveAB({ silent = false } = {}) {
    if (!state.ab) return;
    const cur = JSON.parse(state.ab.current); state.ab = null;
    const pos = engine.playhead, was = engine.playing; if (was) engine.stop();
    engine.loadSong(cur); engine.playhead = pos;
    $('#song').classList.remove('ab'); $('#bottom').classList.remove('ab'); $('#notes').readOnly = state.readOnly; renderAll();
    if (was && !silent) await play();
    if (!silent) status('A: back to the current song.');
  }
  async function toggleAB() { if (state.ab) return leaveAB(); const v = liveVersions().find((x) => x.id === abLast) || liveVersions()[0]; if (!v) { status('Tag a version first (Versions tab) — then A/B flips between it and now.'); return; } return enterAB(v); }
  async function restoreVersion(v) {
    if (ro()) { status('Read-only — take over first.'); return; }
    const a = await ask('Restore version', `Replace the tracks, takes and mix with "${v.name}"? Notes, lyrics, chords, sections, needs and ideas stay as they are now. ${MOD}+Z undoes.`, [['Restore', 'ok', 'primary'], ['Cancel', 'cancel']]); if (a !== 'ok') return;
    if (state.ab) await leaveAB({ silent: true });
    const vs = await bp.song.readVersion(state.folder, v.id);
    pushUndo(`restore version ${v.name}`);
    await loadAudio(state.folder, vs);
    await restoreSnapshot(JSON.stringify({ ...takesOnly(vs), notes: $('#notes').value }));
    logActivity(`restored version "${v.name}"`); status(`Restored "${v.name}". ${MOD}+Z undoes.`);
  }
  function renderVersions() {
    const ul = $('#version-list'); ul.innerHTML = ''; const vs = liveVersions();
    $('#btn-version-tag').disabled = ro() || !!state.ab;
    const ab = $('#btn-ab'); ab.hidden = !vs.length; ab.classList.toggle('active', !!state.ab); ab.textContent = state.ab ? `B: ${state.ab.name} — back to now (B)` : 'A/B (B)';
    if (!vs.length) ul.append(el('li', 'muted', 'none yet — tag one before a big change ("before new drums"), then A/B to compare.'));
    for (const v of vs) {
      const li = el('li'); const b = el('button', state.ab && state.ab.id === v.id ? 'active' : null, state.ab && state.ab.id === v.id ? 'B ◀' : 'A/B'); b.title = 'flip playback between this version and now'; b.addEventListener('click', () => enterAB(v).catch(fail));
      li.append(b, el('span', 'vname', v.name), el('span', 'vmeta', `${v.by} · ${timeAgo(v.at)}`)); li.title = `rev ${v.rev} · ${new Date(v.at).toLocaleString()}`;
      M.attach(li, () => [{ title: v.name }, { label: state.ab && state.ab.id === v.id ? 'Back to now' : 'A/B against now', action: () => enterAB(v).catch(fail) }, { label: 'Restore this version…', action: () => restoreVersion(v).catch(fail), disabled: ro() }, { label: 'Rename…', action: async () => { const n = await promptName('Version name', v.name); if (n) { change(() => { v.name = n.slice(0, 60); }, { undoable: false, label: `renamed version to ${n}` }); renderAll(); } }, disabled: ro() }, { label: 'Delete tag', danger: true, action: () => { change(() => { v.deleted = true; v.deletedBy = me(); }, { undoable: false, label: `deleted version tag "${v.name}"` }); renderAll(); }, disabled: ro() }]);
      ul.append(li);
    }
  }
  $('#btn-version-tag').addEventListener('click', async () => { if (ro()) return; const n = await promptName('Name this version (e.g. "before new drums")', `rev ${state.song.rev} · ${new Date().toLocaleDateString()}`); if (n) { const v = await tagVersion(n).catch(fail); if (v) toast(`Tagged "${v.name}". A/B in the Versions tab flips between it and whatever you do next.`, { kind: 'ok', ms: 6000 }); } });
  $('#btn-ab').addEventListener('click', () => toggleAB().catch(fail));

  // ---------- take voting ----------
  const myVote = (clipId) => CB.votesFor(state.song, clipId).find((v) => CB.nameMatch(v.by, me())) || null;
  function toggleVote(t0, c0) {
    const f = findClip(c0.id); if (!f) return; const { t, c } = f;
    let hero = false;
    change(() => {
      const mine = myVote(c.id);
      if (mine) mine.deleted = true; else (state.song.votes = state.song.votes || []).push({ id: newId(), clipId: c.id, by: me(), at: nowIso() });
      const group = [c, ...overlapping(t, c)];
      if (group.length > 1) { const top = CB.topVoted(state.song, group.map((x) => x.id)); const w = group.find((x) => x.id === top); if (w && (w.mute || group.some((x) => x !== w && !x.mute))) { w.mute = false; for (const x of group) if (x !== w) x.mute = true; hero = w; } }
    }, { label: `${myVote(c.id) ? 'unstarred' : '★'} ${c.name}` });
    renderAll();
    if (hero) toast(`Band's pick: ${hero.name} (${CB.votesFor(state.song, hero.id).length}★) now plays; the other takes there are muted underneath.`, { kind: 'ok', ms: 7000 });
  }

  // ---------- presence + "now" line ----------
  let presenceSent = '';
  function sendPresence() {
    if (!state.folder) return;
    const p = { mode: engine.recording ? 'recording' : kara.open && (engine.playing || practice) ? 'practicing' : state.readOnly ? 'listening' : 'editing', playing: !!(engine.playing || practice) };
    const k = JSON.stringify(p); if (k === presenceSent) return; presenceSent = k; bp.presence.set(p).catch(() => {});
  }
  function renderPresence() {
    const s = state.songs.find((x) => x.folder === state.folder); const line = s ? CB.presenceLine(s.presence || [], state.settings.identity) : '';
    const elp = $('#presence-line'); elp.hidden = !line; elp.textContent = line ? `● ${line}` : '';
  }
  let nowKey = '';
  function updateNowLine() {
    if (!state.song) return;
    const t = engine.playhead; const sc = CB.sectionAt(state.song, t), ch = CB.chordAt(state.song, t), ly = CB.lyricAt(state.song, t);
    const k = `${sc && sc.id}|${ch && ch.id}|${ly && ly.id}`; if (k === nowKey) return; nowKey = k;
    $('#now-section').textContent = sc ? sc.name : ''; $('#now-chord').textContent = ch ? ch.chord : (state.song && state.song.key ? `key ${state.song.key}` : ''); $('#now-lyric').textContent = ly ? `“${ly.text}”` : '';
    $('#now-line').classList.toggle('empty', !sc && !ch && !ly);
    for (const b of document.querySelectorAll('#section-lane .section-block')) b.classList.toggle('now', !!sc && b.dataset.id === sc.id);
    for (const b of document.querySelectorAll('#chord-lane .chord-chip')) b.classList.toggle('now', !!ch && b.dataset.id === ch.id);
    followLyric();
  }
  function renderCollab(w) {
    if (!state.song) return;
    renderSectionLane(w); renderChordLane(w); renderNotesList(); renderLyrics(); renderNeeds(); renderIdeas(); renderFeed(); renderVersions(); renderPresence(); try { renderBandPane(); } catch (_) {} if (!$('.side-tab[data-tab=chart]').hidden) renderChart(); if (!$('.side-tab[data-tab=parts]').hidden) renderParts();
    nowKey = ''; updateNowLine();
  }

  // ---------- arrangement ----------
  const tracksEl = $('#tracks'), ruler = $('#ruler'), arrange = $('#arrange');
  const playheadEl = el('div'); playheadEl.id = 'playhead'; arrange.appendChild(playheadEl);
  // #playhead / #room-shade are absolute inside the scrolling #arrange: top/bottom resolve to the VISIBLE box, so with more
  // tracks than fit, the line stopped partway down. Stretch them to the content height whenever it changes.
  const fitOverlays = () => { const h = Math.max(arrange.clientHeight, tracksEl.offsetTop + tracksEl.offsetHeight); playheadEl.style.height = `${h}px`; const sh = $('#room-shade'); if (sh) sh.style.height = `${h}px`; };
  new ResizeObserver(fitOverlays).observe(tracksEl); new ResizeObserver(fitOverlays).observe(arrange);
  const loopEl = el('div'); loopEl.id = 'loop-region'; $('#ruler-row').appendChild(loopEl);

  function timelineWidth() { return Math.max(arrange.clientWidth - HEAD_W, (engine.songLength() + 30) * state.pxPerSec); }
  // the song's arranged length (sections / chords / lyrics): playback runs to the end of the arrangement even before anything is recorded
  function syncArrangementEnd() { if (!state.song) { engine.arrangementEnd = 0; return; } let e = 0; for (const x of liveSections()) e = Math.max(e, x.end || 0); for (const c of liveChords()) e = Math.max(e, (c.time || 0) + barLenAt(c.time || 0)); for (const l of liveLyrics()) if (typeof l.time === 'number') e = Math.max(e, l.time + barLen()); engine.arrangementEnd = e; }
  function renderAll() { syncArrangementEnd(); renderTracks(); renderMixer(); renderFx(); drawRuler(); positionPlayhead(); updateBadges(); positionRoomShade(); renderKeyChip(); if (tabShown('takes')) renderTakes(); }

  function renderUnlockBtn() { const b = $('#btn-unlock-all'); if (!b) return; const all = engine.tracks.length && engine.tracks.every((t) => mineT(t.id)); const anyMine = engine.tracks.some((t) => mineT(t.id)); b.textContent = all ? '🔒 Lock all' : '🔓 Unlock all'; b.title = all ? 'Lock your tracks again (frees them for the band)' : anyMine ? 'Unlock the rest of the tracks nobody else has' : 'Unlock every track nobody else has (they lock again after 10 min untouched)'; b.classList.toggle('active', anyMine); }
  function renderTracks() {
    if (engine.ctx) engine.setMonitorTrack(state.armedTrack || state.selectedTrack || null);   // monitoring follows the armed track's FX
    try { renderSongParts(); } catch (_) { /* the bin never breaks the timeline */ }
    renderSnapChip(); renderUnlockBtn();
    const keepTop = arrange.scrollTop; requestAnimationFrame(() => { if (Math.abs(arrange.scrollTop - keepTop) > 1) arrange.scrollTop = Math.min(keepTop, arrange.scrollHeight); });   /* re-render must not jump the track list to the top */
    tracksEl.innerHTML = '';
    const w = timelineWidth();
    for (const t of engine.tracks) {
      const row = el('div', 'track'); row.dataset.id = t.id; if (t.id === state.selectedTrack) row.classList.add('selected');
      const head = el('div', 'track-head');
      const nameRow = el('div', 'name-row');
      const sw = el('span', 'swatch'); sw.style.background = t.color; sw.title = 'Track colour: click to pick another one. It only helps you tell tracks apart on the timeline — it changes nothing in the sound.';
      sw.addEventListener('click', (e) => { e.stopPropagation(); if (state.readOnly) return; pickColor(t, e.clientX, e.clientY); });
      const nm = el('span', 'tname', t.name); nm.title = 'Track name — double-click to rename it. Names like Bass, Vox or Kick help, because Auto mix and the quick fixes guess what the track is from its name.';
      const ty = el('span', 'ttype', (t.instrument === 'drumkit' ? 'drum machine' : t.instrument.startsWith('synth:') ? t.instrument.slice(6) : t.type) + (t.preset ? ` · ${presetLabel(t)}` : '')); ty.title = 'What kind of track this is (guitar, vocals, drum machine…) and the sound preset on it (amp, vocal chain…). Change the preset in Track FX on the right.';
      nm.addEventListener('dblclick', async (e) => { e.stopPropagation(); if (state.readOnly) return; const n = await promptName('Track name', t.name); if (n) { change(() => engine.updateTrack(t.id, { name: n }), { label: `rename track to ${n}` }); fixTrackTypes({ quiet: false }); renderAll(); } });
      nameRow.append(sw, nm);
      const btns = el('div', 'btns');
      // track lock: 🔒 locked (click to unlock it for you) · 🔓 yours · 🔒 Dan (someone else has it)
      const hb = heldBy(t.id), mine = mineT(t.id);
      const lk = el('button', 'tlock' + (mine ? ' mine' : hb ? ' theirs' : ''), mine ? '🔓' : hb ? `🔒 ${hb}` : '🔒');
      lk.title = mine ? 'Unlocked for you — click to lock it again (frees it for the band). It locks by itself after 10 min untouched.' : hb ? `${hb} has this track unlocked (it frees up when they lock it or leave it for 10 min)` : 'Locked — click to unlock it and work on it';
      lk.addEventListener('click', (e) => { e.stopPropagation(); if (mine) lockTrack(t.id).catch(fail); else if (!hb) unlockTrack(t.id).catch(fail); else status(lk.dataset.tip || lk.title, 6000); });
      if (!mine) row.classList.add('locked');
      const arm = el('button', 'arm' + (state.armedTrack === t.id ? ' active' : ''), '●'); arm.title = 'Arm: record onto this track next. Hit R (or ● up top) and this is where the take goes. Only one track at a time.';
      arm.addEventListener('click', (e) => { e.stopPropagation(); if (!mine) { if (hb) status(lk.dataset.tip || lk.title, 6000); else lockNudge(t.id); return; } state.armedTrack = state.armedTrack === t.id ? null : t.id; renderTracks(); });
      // mute / solo on a track that isn't yours: just for your ears (not saved)
      const ms = (k) => (e) => { e.stopPropagation(); if (mine) change(() => engine.updateTrack(t.id, { [k]: !t[k] }), { undoable: false }); else { engine.updateTrack(t.id, { [k]: !t[k] }); status(`${k === 'mute' ? 'Muted' : 'Soloed'} just for you — it's not your track, so it isn't saved.`, 4000); } renderAll(); };
      const mute = el('button', 'mute' + (t.mute ? ' active' : ''), 'M'); mute.title = 'Mute: silence this track (it stays in the song). On someone else\'s track it\'s just for your ears.'; mute.addEventListener('click', ms('mute'));
      const solo = el('button', 'solo' + (t.solo ? ' active' : ''), 'S'); solo.title = 'Solo: hear only this track (and any other soloed ones). Handy for checking one part.'; solo.addEventListener('click', ms('solo'));
      const del = el('button', null, '✕'); del.title = `Delete this track from the song. The recordings stay on disk; ${MOD}+Z brings it back.`;
      del.addEventListener('click', async (e) => { e.stopPropagation(); if (engine.recording || finishing) { status('Stop recording first.'); return; } if (state.readOnly) { status('Read-only — "Take over" (banner above) to edit.', 6000); return; } const a = await ask('Delete track', `Delete track "${t.name}" and its ${t.clips.length} take(s) from the song? The audio files stay in the folder and can be recovered; ${MOD}+Z undoes this.`, [['Delete', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a !== 'ok') return; change(() => { for (const c of t.clips) trashClip(t, c); state.song.trashTracks = { ...(state.song.trashTracks || {}), [t.id]: t.name }; engine.removeTrack(t.id); if (state.selectedTrack === t.id) state.selectedTrack = null; if (state.armedTrack === t.id) state.armedTrack = null; }, { label: `delete track ${t.name}` }); renderAll(); refreshUnreferenced(); });
      // what the head shows depends on the job: Write = what this track covers; Record = arm first, last take
      const info = el('div', 'tinfo'); const live = t.clips.filter((c) => !c.mute);
      if (state.ws === 'mix') {   // mini channel strip: volume, pan, the FX on/off chips, seasoning
        const mr = el('div', 'mixrow'); const f = document.createElement('input'); f.type = 'range'; f.min = -60; f.max = 12; f.step = 0.5; f.value = t.gainDb; f.title = 'Volume (dB). 0 is as recorded; −6 is about half as loud. Double-click = 0.';
        const db = el('span', 'db', `${t.gainDb} dB`); gestureUndo(f, () => `${t.name} fader`);
        f.addEventListener('input', () => { if (state.readOnly) return; engine.updateTrack(t.id, { gainDb: Number(f.value) }); db.textContent = `${f.value} dB`; markDirty(); const st = document.querySelector(`#mixer .strip[data-id="${t.id}"] .fader`); if (st) st.value = f.value; });
        f.addEventListener('change', () => { renderMixer(); if (t.id === state.selectedTrack) renderFx(); });
        f.addEventListener('dblclick', () => { f.value = 0; f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); });
        f.addEventListener('mousedown', (e) => e.stopPropagation());
        const pan = document.createElement('input'); pan.type = 'range'; pan.className = 'pan'; pan.min = -1; pan.max = 1; pan.step = 0.05; pan.value = t.pan; pan.title = 'Pan: left / right position. Double-click = centre.'; gestureUndo(pan, () => `${t.name} pan`);
        pan.addEventListener('input', () => { if (state.readOnly) return; engine.updateTrack(t.id, { pan: Number(pan.value) }); markDirty(); }); pan.addEventListener('change', () => renderMixer()); pan.addEventListener('dblclick', () => { pan.value = 0; pan.dispatchEvent(new Event('input')); pan.dispatchEvent(new Event('change')); }); pan.addEventListener('mousedown', (e) => e.stopPropagation());
        mr.append(f, db, pan);
        const mc = el('div', 'mixchips');
        for (const [k, label, tip] of [['hpf', 'LC', 'Low-cut (high-pass): takes out rumble and boom below the note — cleans up vocals and guitars'], ['eq', 'EQ', 'EQ: tone — low / mid / high'], ['comp', 'CMP', 'Compressor: evens out loud and quiet moments so the part sits steady']]) { const c = el('button', 'chip-fx' + (t.fx[k] && t.fx[k].on ? ' on' : ''), label); c.title = `${tip} — click to turn ${t.fx[k] && t.fx[k].on ? 'off' : 'on'}`; c.addEventListener('click', (e) => { e.stopPropagation(); if (ro()) return; change(() => engine.updateTrack(t.id, { fx: { [k]: { on: !(t.fx[k] && t.fx[k].on) } } }), { label: `${t.name} ${label}` }); state.selectedTrack = t.id; renderAll(); }); mc.append(c); }
        const qf = el('button', 'quickfix'); qf.append(el('i', 'om om-spoon'), document.createTextNode(' fix')); qf.title = 'Quick fixes: common mixing moves in plain words (sit the vocal, less mud, more punch, brighter…). Each one is undoable.'; qf.addEventListener('click', (e) => { e.stopPropagation(); state.selectedTrack = t.id; menuAt(qf, quickFixMenu(t)); }); mc.append(mute, solo, qf);
        head.append(nameRow, mr, mc);
      } else if (state.ws === 'record') {
        btns.append(arm, lk, mute, solo);
        const last = t.clips.slice().sort((a, b) => String(b.takenAt || '').localeCompare(String(a.takenAt || '')))[0];
        info.textContent = !t.clips.length ? 'no takes yet — arm it and hit R' : `${t.clips.length} take${t.clips.length === 1 ? '' : 's'} · last: ${last.name}${last.takenBy ? ` · ${last.takenBy}` : ''}${last.takenAt ? ` · ${ago(last.takenAt)}` : ''}${state.armedTrack === t.id && engine.monitorInput ? ' · 🎧 monitoring' : ''}`;
        info.title = 'Takes on this track and who recorded the latest one. Record → Takes lists them all.';
        head.append(nameRow, btns, info, reactionChips(t.id, t.name, { compact: true }));
      } else {
        btns.append(lk, arm, mute, solo, del);
        const secs = liveSections(); const covered = secs.filter((sc) => live.some((c) => c.start < sc.end - 1e-3 && clipEnd(c) > sc.start + 1e-3)).map((sc) => sc.name);
        info.textContent = !t.clips.length ? (t.instrument === 'drumkit' ? 'drum machine' : 'nothing recorded yet') : !secs.length ? `${t.clips.length} take${t.clips.length === 1 ? '' : 's'}` : covered.length === secs.length ? `covers every part (${t.clips.length} take${t.clips.length === 1 ? '' : 's'})` : covered.length ? `covers ${covered.join(', ')}` : 'takes outside the parts';
        info.title = 'Which parts of the song this track has takes for. Empty parts show where a recording is still needed.';
        head.append(nameRow, ty, btns, info, reactionChips(t.id, t.name, { compact: true }));
      }
      head.addEventListener('click', () => { selectTrack(t.id); });
      head.addEventListener('mousedown', (e) => trackDragStart(e, t, row));
      M.attach(head, () => { selectTrack(t.id); return [{ title: t.name }, ...trackItems(t)]; });
      const lane = el('div', 'lane'); lane.style.minWidth = `${w}px`;
      M.attach(lane, (e) => { if (e.target && e.target.closest && e.target.closest('.clip:not(.drumlane)')) return null; selectTrack(t.id); const r = lane.getBoundingClientRect(); return laneMenu(t, Math.max(0, ((e.clientX || 0) - r.left) / state.pxPerSec)); });
      // Overlapping takes go in sub-lanes so a second pass over the same bars is visible, not hidden underneath.
      const rows = layoutClips(t.clips); const nRows = Math.max(1, ...t.clips.map((c) => rows.get(c.id) + 1));
      const base = state.trackH || 84; const rowH = nRows > 1 ? Math.max(16, Math.round((base - 22) / 2)) : base - 13; const trackH = nRows > 1 ? 6 + nRows * (rowH + 3) + 4 : base;
      row.style.height = `${trackH}px`; row.style.minHeight = `${trackH}px`;
      const grid = document.createElement('canvas'); grid.className = 'grid'; lane.appendChild(grid); requestAnimationFrame(() => drawGrid(grid, w));
      lane.addEventListener('mousedown', (e) => { if (e.target === lane || e.target === grid) { const was = state.selectedTrack; state.selectedTrack = t.id; state.selectedClip = null; engine.seek(snap(Math.max(0, e.offsetX / state.pxPerSec))); markSelection(); positionPlayhead(); if (was !== t.id) renderFx(); } });   /* no re-render: the lane must survive so double-click (draw notes) fires */
      if (String(t.instrument).startsWith('synth:')) { lane.addEventListener('dblclick', (e) => { if (e.target !== lane && e.target !== grid) return; openNoteEditor(t, null, Math.max(0, e.offsetX / state.pxPerSec)).catch(fail); }); lane.title = 'double-click to draw notes here (piano roll + riff generator)'; }
      if (t.instrument === 'drumkit' && t.drum) { const dl = el('div', 'clip drumlane'); const x0 = barSec(t.drum.offsetBars || 0); const len = t.drum.bars ? barSec((t.drum.offsetBars || 0) + t.drum.bars) - x0 : Math.max(engine.contentLength(), engine.recording ? engine.playhead : 0, barSec(4)); if (!t.drum.bars) dl.dataset.follow = '1'; dl.style.left = `${x0 * state.pxPerSec}px`; dl.style.width = `${Math.max(4, len * state.pxPerSec)}px`; dl.style.background = hexA(t.color, .25); dl.style.borderColor = t.color; dl.appendChild(el('div', 'label', `${t.drum.kit} · ${t.drum.custom ? 'custom pattern' : t.drum.pattern}${t.drum.bars ? '' : ' · follows song length'}`)); dl.addEventListener('mousedown', (e) => { e.stopPropagation(); selectTrack(t.id); }); lane.appendChild(dl); }
      for (const c of t.clips) { const ce = makeClipEl(t, c); if (nRows > 1) { ce.classList.add('stacked'); ce.style.top = `${6 + rows.get(c.id) * (rowH + 3)}px`; ce.style.height = `${rowH}px`; } lane.appendChild(ce); }
      if (engine.recording && engine.recording.trackId === t.id) { const rc = el('div', 'clip recording'); rc.style.left = `${engine.recording.startPos * state.pxPerSec}px`; rc.style.width = `${Math.max(2, (engine.playhead - engine.recording.startPos) * state.pxPerSec)}px`; rc.dataset.recording = '1'; if (nRows > 1) { rc.classList.add('stacked'); rc.style.top = `${6 + nRows * (rowH + 3)}px`; rc.style.height = `${rowH}px`; row.style.height = row.style.minHeight = `${trackH + rowH + 3}px`; } rc.appendChild(el('div', 'label', 'recording…')); lane.appendChild(rc); }
      for (const m of liveNotes()) if (m.trackId === t.id) lane.append(...notePins(m));
      row.append(head, lane);
      tracksEl.appendChild(row);
    }
    ruler.width = w; ruler.style.width = `${w}px`;
    for (const x of $('#ruler-row').querySelectorAll('.note-pin')) x.remove();
    for (const m of liveNotes()) if (!m.trackId) $('#ruler-row').append(...notePins(m));
    $('#song-reactions').replaceChildren(reactionChips('song', state.song ? state.song.name : 'song'));
    renderCollab(w);
    drawRuler();
  }

  function makeClipEl(t, c) {
    const d = el('div', 'clip'); const len = engine.clipLength(c) || c.duration || 1;
    d.dataset.id = c.id;
    d.style.left = `${c.start * state.pxPerSec}px`; d.style.width = `${Math.max(4, len * state.pxPerSec)}px`; d.style.background = hexA(t.color, .35); d.style.borderColor = t.color;
    if (c.id === state.selectedClip) d.classList.add('selected');
    if (state.pitch && state.pitch.has(c.id)) { const pe = state.pitch.get(c.id); for (const r of pe.results) { if (r.flag === 'ok' || r.flag === 'short' || r.flag === 'wobbly') continue; const mk = el('span', `pitch-mark ${r.flag}`); mk.style.left = `${(r.t0 - pe.start) * state.pxPerSec}px`; mk.style.width = `${Math.max(3, (r.t1 - r.t0) * state.pxPerSec)}px`; mk.title = `${PC.noteLabel(r.target)} ${r.off > 0 ? '+' : ''}${Math.round(r.off)} cents — ${r.why || r.flag}`; d.append(mk); } }
    if (state.freshClips && state.freshClips.has(c.id)) { d.classList.add('fresh'); d.title = `new since you were last here${c.takenBy ? ` — ${c.takenBy}` : ''}`; }
    if (engine.clipMuted(c)) d.classList.add('muted'); if (engine.audition && engine.audition.unmute.has(c.id)) d.classList.add('auditioning');
    if (state.missingClips.has(audioId(c))) d.classList.add('missing');
    const cv = document.createElement('canvas'); d.appendChild(cv);
    const rx = reactionsFor(c.id); const nv = CB.votesFor(state.song, c.id).length; const rxTxt = (nv ? ` ★${nv}` : '') + (rx.length ? ' ' + [...new Set(rx.map((r) => r.emoji))].join('') : '');
    const label = el('div', 'label', (state.missingClips.has(audioId(c)) ? `${c.name} (not synced yet)` : `${c.name}${c.mute ? ' (muted)' : ''}${c.gainDb ? ` ${c.gainDb > 0 ? '+' : ''}${c.gainDb} dB` : ''}`) + rxTxt); if (rx.length) label.title = rx.map((r) => `${r.emoji} ${r.by}`).join('  '); d.appendChild(label);
    if (c.kind === 'midi') d.classList.add('midi');
    if (c.link) { d.classList.add('linked'); d.title = 'Linked — the same take plays in every copy of this part. Move, trim, delete or re-record it here and they all change. Right-click → Unlink to make just this one different.'; }
    requestAnimationFrame(() => (c.kind === 'midi' ? drawNotes(cv, c) : drawWave(cv, engine.buffers.get(audioId(c)), c)));
    M.attach(d, () => { state.selectedClip = c.id; state.selectedTrack = t.id; renderTracks(); renderFx(); return clipMenu(t, c); });
    const hl = el('div', 'edge left'), hr = el('div', 'edge right'); hl.title = 'Drag to trim the start of the take — hides the bit before, nothing is deleted. Drag it back out to get it back.'; hr.title = 'Drag to trim the end of the take — hides the bit after, nothing is deleted. Drag it back out to get it back.'; d.append(hl, hr);
    if (c.fadeIn > 0) { const f = el('div', 'fade in'); f.style.width = `${c.fadeIn * state.pxPerSec}px`; d.appendChild(f); }
    if (c.fadeOut > 0) { const f = el('div', 'fade out'); f.style.width = `${c.fadeOut * state.pxPerSec}px`; d.appendChild(f); }
    // Mix: the edits you make while mixing, right on the take — drag the top corners for fades, the gain line up/down for level
    if (state.ws === 'mix' && c.kind !== 'midi' && canTouch(t)) {
      const len = engine.clipLength(c);
      for (const which of ['fadeIn', 'fadeOut']) {
        const hd = el('div', `fh ${which === 'fadeIn' ? 'in' : 'out'}`); hd.title = `Drag: ${which === 'fadeIn' ? 'fade in' : 'fade out'} (${((c[which] || 0) * 1000).toFixed(0)} ms)`;
        hd.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); const x0 = e.clientX, v0 = c[which] || 0; let v = v0;
          const mv = (ev) => { const dx = (ev.clientX - x0) / state.pxPerSec; v = Math.max(0, Math.min(len / 2, v0 + (which === 'fadeIn' ? dx : -dx))); c[which] = v; const f = d.querySelector(`.fade.${which === 'fadeIn' ? 'in' : 'out'}`) || d.appendChild(el('div', `fade ${which === 'fadeIn' ? 'in' : 'out'}`)); f.style.width = `${v * state.pxPerSec}px`; hd.title = `${which === 'fadeIn' ? 'fade in' : 'fade out'} ${(v * 1000).toFixed(0)} ms`; };
          const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); c[which] = v0; if (Math.abs(v - v0) > 1e-4) { change(() => { c[which] = v; }, { label: `${c.name} ${which === 'fadeIn' ? 'fade in' : 'fade out'}` }); } renderAll(); };
          window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); });
        d.appendChild(hd);
      }
      const gl = el('div', 'gl'); const gY = (db) => `${Math.round(100 - ((Math.max(-24, Math.min(12, db)) + 24) / 36) * 100)}%`; gl.style.top = gY(c.gainDb || 0); gl.title = `Take level ${c.gainDb > 0 ? '+' : ''}${c.gainDb || 0} dB — drag up / down (on top of the track's fader)`;
      gl.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); const y0 = e.clientY, v0 = c.gainDb || 0; let v = v0;
        const mv = (ev) => { v = Math.round((v0 - (ev.clientY - y0) * 36 / Math.max(40, d.clientHeight)) * 2) / 2; v = Math.max(-24, Math.min(12, v)); gl.style.top = gY(v); gl.title = `${v > 0 ? '+' : ''}${v} dB`; const lb = d.querySelector('.label'); if (lb) lb.textContent = `${c.name} ${v > 0 ? '+' : ''}${v} dB`; };
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); if (v !== v0) { change(() => { c.gainDb = v; }, { label: `${c.name} level ${v > 0 ? '+' : ''}${v} dB` }); } renderAll(); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up); });
      d.appendChild(gl);
    }
    let drag = null;
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      // clicking a take on the track that's already selected also moves the playhead there (a click, not a drag)
      const wasSel = state.selectedTrack === t.id, clickAt = Math.max(0, c.start + (e.clientX - d.getBoundingClientRect().left) / state.pxPerSec);
      const seekHere = () => { if (!wasSel || engine.recording) return; engine.seek(snap(clickAt)); positionPlayhead(); };
      state.selectedClip = c.id; state.selectedTrack = t.id; markSelection(); renderFx();   /* no full re-render: the drag moves THIS element, and double-click needs it to survive */
      if (!canTouch(t) || engine.recording) {
        const up0 = (ev) => { window.removeEventListener('mouseup', up0); if (Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) seekHere(); };
        window.addEventListener('mouseup', up0); return;
      }
      const edge = e.target === hl ? 'left' : e.target === hr ? 'right' : null;
      const full = fullLen(c); const len0 = engine.clipLength(c);
      const dr0 = d.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, start: c.start, edge, trimStart: c.trimStart, trimEnd: c.trimEnd, len0, offX: e.clientX - dr0.left, offY: e.clientY - dr0.top, w: dr0.width, h: dr0.height, ghost: null, drop: null };
      const okOn = (to) => (c.kind === 'midi' ? String(to.instrument).startsWith('synth:') : to.instrument === 'audio');
      // the take "in your hand": a copy of the block (waveform and all) that follows the mouse between tracks
      const makeGhost = () => {
        const gh = d.cloneNode(true); gh.classList.add('clip-ghost'); gh.classList.remove('selected'); gh.style.width = `${drag.w}px`; gh.style.height = `${drag.h}px`; gh.style.top = '0'; gh.style.left = '0';
        const src = d.querySelector('canvas'), dst = gh.querySelector('canvas'); if (src && dst) { dst.width = src.width; dst.height = src.height; dst.style.width = src.style.width; dst.style.height = src.style.height; try { dst.getContext('2d').drawImage(src, 0, 0); } catch (_) {} }
        document.body.appendChild(gh); return gh;
      };
      const clearDrag = () => { if (drag && drag.ghost) { drag.ghost.remove(); drag.ghost = null; } if (drag && drag.drop) { drag.drop.remove(); drag.drop = null; } d.classList.remove('drag-src'); document.body.classList.remove('clip-dragging', 'clip-copying'); };
      const move = (ev) => {
        if (!drag) return; const dx = (ev.clientX - drag.x) / state.pxPerSec;
        if (drag.edge === 'left') { let ns = Math.max(drag.start - drag.trimStart, Math.min(drag.start + drag.len0 - 0.05, drag.start + dx)); if (!ev.altKey) ns = snap(ns); drag.ns = ns; const nl = drag.start + drag.len0 - ns; d.style.left = `${ns * state.pxPerSec}px`; d.style.width = `${Math.max(4, nl * state.pxPerSec)}px`; return; }
        if (drag.edge === 'right') { let ne = Math.max(drag.start + 0.05, Math.min(drag.start - drag.trimStart + full, drag.start + drag.len0 + dx)); if (!ev.altKey) ne = snap(ne); drag.ne = ne; d.style.width = `${Math.max(4, (ne - drag.start) * state.pxPerSec)}px`; return; }
        if (!drag.moving && Math.abs(ev.clientX - drag.x) < 4 && Math.abs(ev.clientY - drag.y) < 4) return;
        drag.moving = true;
        let ns = Math.max(0, drag.start + dx); if (!ev.altKey) ns = snap(ns); drag.ns = ns;
        if (drag.ghost) drag.ghost.style.display = 'none';
        const hit = document.elementFromPoint(ev.clientX, ev.clientY); const tr = hit && hit.closest ? hit.closest('.track') : null; drag.toTrack = tr ? tr.dataset.id : null;
        const copy = ev.shiftKey; drag.copy = copy; document.body.classList.toggle('clip-copying', copy);
        const cross = drag.toTrack && drag.toTrack !== t.id;
        if (!cross && !copy) {   // same track: the block itself slides (snapped)
          if (drag.ghost) { drag.ghost.remove(); drag.ghost = null; } if (drag.drop) { drag.drop.remove(); drag.drop = null; }
          d.classList.remove('drag-src'); d.style.left = `${ns * state.pxPerSec}px`; return;
        }
        // another track (or Shift = copy): the original stays put, faded; the ghost rides the mouse; an outline shows where it lands
        d.style.left = `${drag.start * state.pxPerSec}px`; d.classList.add('drag-src'); document.body.classList.add('clip-dragging');
        if (!drag.ghost) drag.ghost = makeGhost();
        drag.ghost.style.display = ''; drag.ghost.style.transform = `translate(${ev.clientX - drag.offX}px, ${ev.clientY - drag.offY}px)`;
        const to = drag.toTrack ? engine.track(drag.toTrack) : null; const lane = tr ? tr.querySelector('.lane') : null;
        if (lane && to) {
          if (!drag.drop || drag.drop.parentElement !== lane) { if (drag.drop) drag.drop.remove(); drag.drop = el('div', 'clip-drop'); lane.appendChild(drag.drop); }
          drag.drop.classList.toggle('bad', !okOn(to)); drag.drop.style.left = `${ns * state.pxPerSec}px`; drag.drop.style.width = `${Math.max(4, drag.len0 * state.pxPerSec)}px`;
          drag.drop.textContent = !okOn(to) ? `✕ ${to.name} is a different kind of track` : `${copy ? 'copy' : 'move'} → ${to.name} · ${posFine(ns)}`;
        } else if (drag.drop) { drag.drop.remove(); drag.drop = null; }
      };
      const up = (ev) => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        if (!drag) return; clearDrag(); const g = drag; drag = null;
        if (!g.edge && !g.moving) { renderTracks(); seekHere(); return; }   /* a click, not a move */
        if (!g.edge && g.copy && g.ns !== undefined) {   // Shift-drag: a copy where it was dropped (this track or another)
          const to = g.toTrack ? engine.track(g.toTrack) : t; if (!to || !okOn(to)) { if (to) status(`${to.name} is a different kind of track.`); renderTracks(); return; }
          let made = null; change(() => { made = { ...JSON.parse(JSON.stringify(c)), id: newId(), start: g.ns, src: audioId(c) }; if (c.kind === 'midi') delete made.src; delete made.link; to.clips.push(made); }, { label: `copy ${c.name}${to !== t ? ` to ${to.name}` : ''}` });
          state.selectedTrack = to.id; state.selectedClip = made && made.id; renderAll(); return;
        }
        if (g.edge === 'left' && g.ns !== undefined && Math.abs(g.ns - g.start) > 1e-6) { change(() => { c.trimStart = g.trimStart + (g.ns - g.start); c.start = g.ns; }, { label: `trim ${c.name}` }); renderAll(); return; }
        if (g.edge === 'right' && g.ne !== undefined) { change(() => { c.trimEnd = Math.max(0, full - c.trimStart - (g.ne - c.start)); }, { label: `trim ${c.name}` }); renderAll(); return; }
        if (g.toTrack && g.toTrack !== t.id) { const to = engine.track(g.toTrack); if (to) { const ns = g.ns !== undefined ? g.ns : c.start; if (c.kind === 'midi' ? !String(to.instrument).startsWith('synth:') : to.instrument !== 'audio') { status(`${to.name} is a different kind of track.`); renderTracks(); return; } change(() => { c.start = ns; t.clips = t.clips.filter((x) => x !== c); to.clips.push(c); }, { label: `move ${c.name} to ${to.name}` }); state.selectedTrack = to.id; renderAll(); return; } }
        if (g.ns !== undefined && g.ns !== g.start) { const ns = g.ns; change(() => { c.start = ns; }, { label: `move ${c.name}` }); renderAll(); } else renderTracks();
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    d.addEventListener('dblclick', async (e) => { e.stopPropagation(); if (state.readOnly) return; const n = await promptName('Take name', c.name); if (n) { change(() => { c.name = n; }, { label: `rename take to ${n}` }); renderAll(); } });
    return d;
  }

  // Greedy sub-lane assignment: a clip goes in the first row where it doesn't overlap an earlier clip.
  function layoutClips(clips) {
    const rows = new Map(); const ends = [];
    for (const c of [...clips].sort((a, b) => a.start - b.start)) {
      const s0 = c.start, e0 = c.start + (engine.clipLength(c) || c.duration || 1);
      let r = ends.findIndex((e) => e <= s0 + 0.02); if (r < 0) { r = ends.length; ends.push(0); }
      ends[r] = e0; rows.set(c.id, r);
    }
    return rows;
  }
  function markSelection() {
    for (const r of tracksEl.querySelectorAll('.track')) r.classList.toggle('selected', r.dataset.id === state.selectedTrack);
    for (const x of tracksEl.querySelectorAll('.clip[data-id]')) x.classList.toggle('selected', x.dataset.id === state.selectedClip);
  }
  function selectTrack(id) { state.selectedTrack = id; engine.setLiveMidiTrack && engine.setLiveMidiTrack(id); renderTracks(); renderFx(); if (tabShown('takes')) renderTakes(); }
  // ---- Record workspace: the selected track's takes, with everything you'd do to one ----
  function renderTakes() {
    const ul = $('#take-list'); if (!ul) return; ul.innerHTML = '';
    const t = engine.track(state.selectedTrack) || engine.track(state.armedTrack);
    $('#takes-track').textContent = t ? `${t.name} — ${t.clips.filter((c) => !c.link).length} take${t.clips.filter((c) => !c.link).length === 1 ? '' : 's'}` : 'Select a track';
    if (!t) { ul.append(el('li', 'muted', 'Click a track to see its takes here.')); return; }
    const ro = () => !canTouch(t);
    const tools = el('li', 'take-tools');
    const mk = (label, fn, title, dis) => { const b = el('button', 'small', label); b.title = title || ''; b.disabled = !!dis; b.addEventListener('click', () => Promise.resolve(fn()).catch(fail)); tools.append(b); };
    if (t.instrument === 'audio') {
      if (isVocalTrack(t)) mk('🎤 Words', () => transcribeTrack(t), 'Lyrics from this track (speech-to-text)', !!asrBusy);
      if (harmonicTrack(t) || bassTrack(t)) mk('🎸 Chords', () => chordsFromTracks([t]), 'Chords from this track — drafted into the chord lane', ro());
      mk('⇥ Tighten…', () => openTighten(t, null), 'Pull the hits onto the grid (strength slider, preview)', ro());
      if (isVocalTrack(t)) mk('🎯 Pitch check', () => pitchCheckTrack(t), 'Where the singing is sharp / flat (nothing is changed)');
    } else if (t.clips.some((c) => c.kind === 'midi')) mk('⇥ Tighten…', () => openTighten(t, null), 'Quantize the notes toward the grid with a strength', ro());
    mk('⏱ Timing', () => timingReport(t, null), 'How far off the click each bar is, for every take on this track');
    ul.append(tools);
    if (state.timing && state.timing.trackId === t.id) ul.append(state.timing.node);
    const clips = t.clips.filter((c) => !c.link).slice().sort((a, b) => a.start - b.start || String(a.takenAt || '').localeCompare(String(b.takenAt || '')));
    if (!clips.length) { ul.append(el('li', 'muted', 'No takes yet — arm the track (●) and hit R.')); return; }
    for (const c of clips) {
      const li = el('li', 'take-row' + (engine.clipMuted(c) ? ' muted' : '') + (c.id === state.selectedClip ? ' sel' : ''));
      const stars = CB.votesFor(state.song, c.id).length; const len = engine.clipLength(c) || c.duration || 0;
      li.append(el('b', null, c.name), el('span', 'muted', ` ${c.takenBy || ''} · ${fmtBar(c.start)}–${fmtBar(c.start + len)} · ${len.toFixed(1)} s${stars ? ` · ${stars}★` : ''}${c.tt ? ' · tightened' : ''}${state.pitch && state.pitch.has(c.id) ? ` · pitch ${state.pitch.get(c.id).ok}% in tune` : ''}`));
      const bx = el('span', 'take-btns');
      const b = (label, fn, title, dis) => { const x = el('button', 'small', label); x.title = title; x.disabled = !!dis; x.addEventListener('click', (e) => { e.stopPropagation(); Promise.resolve(fn()).catch(fail); }); bx.append(x); };
      b('▶', () => auditionTake(t, c), 'Listen to this take alone');
      b('⏱', () => timingReport(t, c), 'Timing: early / late per bar');
      if (overlapping(t, c).length) b('Keep', () => keepTake(t, c), 'This one plays; the overlapping takes are muted', ro());
      b(engine.clipMuted(c) ? 'Un-mute' : 'Mute', () => { change(() => { c.mute = !c.mute; }, { label: `${c.mute ? 'un-mute' : 'mute'} ${c.name}` }); renderAll(); }, 'M', ro());
      b(myVote(c.id) ? '★' : '☆', () => toggleVote(t, c), 'Star it — most stars plays', ro());
      b('⋯', () => { const r = bx.getBoundingClientRect(); M.show(r.left, r.bottom, clipMenu(t, c)); }, 'everything else (comp, split, fades…)');
      li.append(bx);
      li.addEventListener('click', () => { state.selectedClip = c.id; engine.seek(c.start); positionPlayhead(); markSelection && markSelection(); renderTakes(); });
      M.attach(li, () => clipMenu(t, c));
      ul.append(li);
    }
  }
  // Bar/beat grid behind the clips, derived from bpm + time signature.
  function drawGrid(cv, w) {
    const h = cv.parentElement ? cv.parentElement.clientHeight : 84; cv.width = w; cv.height = h; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
    const pps = state.pxPerSec, map = meter(), gsong = gridStep();
    for (const sg of map.segs) {   // each part draws its own beats / bars (own tempo, own meter)
      if (sg.t0 * pps > w) break;
      const beat = MT.beatLenOf(sg.bpm) * pps, nb = MT.normTs(sg.ts)[0], acc = MT.accents(sg.ts), bar = beat * nb; if (beat < 3) continue;
      const x0 = sg.t0 * pps, x1 = Math.min(w, Number.isFinite(sg.t1) ? sg.t1 * pps : w);
      const gs = localStep(sg.t0 + 1e-6, gsong).g * pps;
      if (gs < beat - 1e-6 && gs >= 5) { g.fillStyle = 'rgba(255,255,255,0.05)'; for (let x = x0; x < x1; x += gs) g.fillRect(Math.round(x), 0, 1, h); }
      for (let x = x0, i = 0; x < x1 - 0.5; x += beat, i++) {
        const k = i % nb, isBar = k === 0;
        if (!isBar && beat < 10) continue;
        g.fillStyle = isBar ? 'rgba(255,255,255,0.30)' : acc[k] ? 'rgba(255,255,255,0.17)' : 'rgba(255,255,255,0.10)';
        g.fillRect(Math.round(x), 0, isBar ? 2 : 1, h);
        if (isBar && bar >= 48) { g.fillStyle = 'rgba(255,255,255,0.28)'; g.font = '9px sans-serif'; g.fillText(String(Math.floor(sg.bar0 + 1e-6) + i / nb + 1), Math.round(x) + 3, h - 3); }
      }
    }
  }
  // ---- one snap grid for the whole arrangement: follows the zoom (bars → 1/4 → 1/8 → 1/16 → 1/32 as you zoom in),
  // or a fixed value picked from the "snap" chip under + track. Hold Alt while dragging for no snap.
  const SNAP_DIVS = [8, 4, 2, 1];   // subdivisions of a beat, finest first
  function gridStep(pps = state.pxPerSec, minPx = 10, mode = state.snapMode || 'auto') {
    const beat = engine.beatLen(), bar = beat * engine.timeSig[0];
    if (mode === 'bar') return bar;
    if (mode !== 'auto' && Number(mode)) return beat / Number(mode);
    for (const k of SNAP_DIVS) if ((beat / k) * pps >= minPx) return beat / k;
    for (const m of [1, 2, 4, 8, 16]) if (bar * m * pps >= minPx) return bar * m;
    return bar * 16;
  }
  function gridLabel(g = gridStep()) {
    const beat = engine.beatLen(), bar = beat * engine.timeSig[0], den = engine.timeSig[1] || 4;
    if (g >= bar - 1e-9) { const m = Math.round(g / bar); return m > 1 ? `${m} bars` : 'bar'; }
    return `1/${Math.round(den * beat / g)}`;
  }
  // a step measured in the song's beats, laid on the grid of the part at `sec` (its own tempo / meter, starting at its own bar 1)
  function localStep(sec, g) { const map = meter(); if (map.uniform) return { o: 0, g }; const sg = MT.segAt(map, Math.max(0, sec)); return { o: sg.t0, g: g * (MT.beatLenOf(sg.bpm) / engine.beatLen()) }; }
  function snapG(sec, alt = false, g = gridStep()) { if (alt) return Math.max(0, sec); const L = localStep(sec, g); return Math.max(0, L.o + Math.round((sec - L.o) / L.g) * L.g); }
  const floorG = (sec, g) => { const L = localStep(sec, g); return L.o + Math.floor((sec - L.o) / L.g + 1e-6) * L.g; };
  const ceilG = (sec, g) => { const L = localStep(sec, g); return L.o + (Math.floor((sec - L.o) / L.g + 1e-6) + 1) * L.g; };
  function snap(sec) { return snapG(sec); }
  const posFine = (sec, g = gridStep()) => { const p = MT.posAt(meter(), Math.max(0, sec)); const L = localStep(sec, g); const base = posLabel(sec); if (L.g >= p.beatLen - 1e-9) return base; const sub = Math.floor(((sec - p.barStart - (p.beat - 1) * p.beatLen) + 1e-9) / L.g) + 1; return `${p.beat > 1 ? base : `${base}.1`}.${sub}`; };
  function renderSnapChip() { const b = $('#snap-ind'); if (!b) return; const auto = (state.snapMode || 'auto') === 'auto'; b.textContent = `${gridLabel()}${auto ? '' : '🔒'}`; b.title = auto ? 'Snap (grid) — follows the zoom (Ctrl+wheel). Click to lock a value. Hold Alt while dragging for no snap.' : 'Snap is locked — click to change, or set it back to follow the zoom. Hold Alt while dragging for no snap.'; }

  // colour picker that opens next to where you clicked (a detached <input type=color> opens at the window corner)
  function pickColor(t, x, y) {
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = t.color;
    Object.assign(inp.style, { position: 'fixed', left: `${Math.max(0, (x || 100) - 10)}px`, top: `${Math.max(0, (y || 100) - 10)}px`, width: '1px', height: '1px', opacity: '0', border: '0', padding: '0' });
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { change(() => engine.updateTrack(t.id, { color: inp.value }), { label: `${t.name} colour` }); renderAll(); inp.remove(); });
    inp.addEventListener('blur', () => setTimeout(() => inp.remove(), 500));
    inp.click();
  }
  function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

  function drawNotes(cv, c) {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 1; cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
    const len = engine.clipLength(c) || 1; const notes = c.notes || [];
    if (!notes.length) return;
    let lo = 127, hi = 0; for (const n of notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    lo -= 2; hi += 2; const span = Math.max(12, hi - lo);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (const n of notes) { const x = (n.t - c.trimStart) / len * w; if (x < 0 || x > w) continue; const y = h - ((n.n - lo) / span) * h; g.fillRect(x, y - 2, Math.max(2, n.d / len * w), 3); }
    // sung syllables under their notes (melody clips), when there is room to read them
    if (notes.some((n) => n.l) && w / notes.length > 14) { g.font = '10px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.75)'; let lastX = -1e9; for (const n of notes) { if (!n.l) continue; const x = (n.t - c.trimStart) / len * w; if (x < lastX + 4 || x < 0 || x > w) continue; g.fillText(n.l, x, h - 3); lastX = x + g.measureText(n.l).width; } }
  }
  function drawWave(cv, buf, c) {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 1; cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
    if (!buf) { g.fillStyle = '#ffffff22'; g.fillRect(0, h / 2 - 1, w, 2); return; }
    const data = buf.getChannelData(0); const sr = buf.sampleRate;
    const s0 = Math.floor(c.trimStart * sr), s1 = Math.min(data.length, Math.floor((buf.duration - c.trimEnd) * sr));
    const spp = Math.max(1, (s1 - s0) / w); const gain = dbToGain(c.gainDb);
    // Two-tone like a real DAW: translucent peak envelope with a solid RMS core, so dense audio reads as a waveform, not a slab.
    const cols = [];
    for (let x = 0; x < w; x++) {
      const a = Math.floor(s0 + x * spp), b = Math.min(s1, Math.floor(s0 + (x + 1) * spp)); let mn = 1, mx = -1, sq = 0, n = 0;
      const step = Math.max(1, Math.floor(spp / 64));
      for (let i = a; i < b; i += step) { const v = data[i] * gain; if (v < mn) mn = v; if (v > mx) mx = v; sq += v * v; n++; }
      cols.push(mx < mn ? null : [mn, mx, n ? Math.sqrt(sq / n) : 0]);
    }
    g.fillStyle = 'rgba(255,255,255,0.45)';
    for (let x = 0; x < w; x++) { const c0 = cols[x]; if (!c0) continue; g.fillRect(x, (1 - c0[1]) * h / 2, 1, Math.max(1, (c0[1] - c0[0]) * h / 2)); }
    g.fillStyle = 'rgba(255,255,255,0.95)';
    for (let x = 0; x < w; x++) { const c0 = cols[x]; if (!c0) continue; const r = c0[2]; g.fillRect(x, (1 - r) * h / 2, 1, Math.max(1, r * h)); }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, h / 2, w, 1);
  }

  function drawRuler() {
    const w = ruler.width, h = ruler.height = 26; const g = ruler.getContext('2d');
    g.fillStyle = '#1d2027'; g.fillRect(0, 0, w, h); g.fillStyle = '#8b91a0'; g.font = '10px sans-serif'; g.strokeStyle = '#30353f';
    // bar lines from the tempo map: a part with its own tempo / time signature gets its own bar length (and a label)
    const map = meter(); const pps = state.pxPerSec; const minBar = Math.min(...map.segs.map((sg) => MT.barLenOf(sg.bpm, sg.ts)));
    const step = minBar * pps < 40 ? Math.ceil(40 / (minBar * pps)) : 1;
    for (const bl of MT.barsIn(map, 0, w / pps)) {
      const x = bl.t * pps, first = Math.abs(bl.t - bl.seg.t0) < 1e-6 && bl.seg !== map.segs[0];
      const lab = (bl.bar - 1) % step === 0 || first;
      g.strokeStyle = first ? '#e5b04b' : '#6b7280'; g.beginPath(); g.moveTo(x, lab ? 4 : 16); g.lineTo(x, h); g.stroke();
      if (lab) { g.fillStyle = '#c9cdd6'; g.font = 'bold 11px sans-serif'; g.fillText(String(bl.bar), x + 4, 12); }
      if (first) { g.fillStyle = '#e5b04b'; g.font = '9px sans-serif'; g.fillText(`${Math.round(bl.seg.bpm)} · ${MT.tsLabel(bl.seg.ts)}`, x + 4 + 8 * String(bl.bar).length, 12); }
      const bt = MT.beatLenOf(bl.seg.bpm); const nb = MT.normTs(bl.seg.ts)[0];
      if (bt * pps >= 12 && step === 1) { const acc = MT.accents(bl.seg.ts); for (let k = 1; k < nb; k++) { const bx = x + k * bt * pps; g.strokeStyle = acc[k] ? '#4a505c' : '#3a3f4a'; g.beginPath(); g.moveTo(bx, acc[k] ? 16 : 19); g.lineTo(bx, h); g.stroke(); } }
    }
    if (![$('#loop-from'), $('#loop-to')].includes(document.activeElement)) loopBarsFromEngine();   /* tempo / time-sig changes move bar numbers */
    loopEl.style.display = engine.loop.enabled ? 'block' : 'none';
    loopEl.style.left = `${HEAD_W + engine.loop.start * state.pxPerSec}px`; loopEl.style.width = `${(engine.loop.end - engine.loop.start) * state.pxPerSec}px`;
  }
  (function rulerDrag() {
    let d = null;
    // click = move the playhead; drag across the bars = loop those bars (whole bars; hold Alt for beats)
    ruler.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r0 = ruler.getBoundingClientRect(); const x0 = e.clientX; const at = (cx) => Math.max(0, (cx - r0.left) / state.pxPerSec);
      const range = (p, q, free) => {
        if (free) { const a = Math.min(p, q), b = Math.max(p, q); return [a, Math.max(b, a + 0.05)]; }
        const gl = gridStep(); return [floorG(Math.min(p, q), gl), ceilG(Math.max(p, q), gl)];
      };
      const p0 = at(x0); d = null;
      const move = (ev) => {
        if (!d) { if (Math.abs(ev.clientX - x0) < 5) return; d = {}; document.body.classList.add('loop-dragging'); }
        const [a, b] = range(p0, at(ev.clientX), ev.altKey); d.a = a; d.b = b;
        loopEl.style.display = 'block'; loopEl.style.left = `${HEAD_W + a * state.pxPerSec}px`; loopEl.style.width = `${(b - a) * state.pxPerSec}px`;
        status(`Loop ${posFine(a)} → ${posFine(b)}${ev.altKey ? ' (no snap)' : ` · snap ${gridLabel()} (zoom for finer, Alt = no snap)`}`, 0);
      };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('loop-dragging');
        if (!d) { engine.seek(snap(p0)); positionPlayhead(); return; }
        const { a, b } = d; d = null; status('');
        if (state.ab || state.readOnly) engine.setLoop({ enabled: true, start: a, end: b });   /* local only: listening / A/B */
        else change(() => engine.setLoop({ enabled: true, start: a, end: b }), { label: 'loop range' });
        $('#loop-on').checked = true; loopBarsFromEngine(); drawRuler();
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    ruler.title = 'click to move the playhead · drag to loop (snaps to the grid — zoom in with Ctrl+wheel for finer, Alt = no snap) · right-click for loop options';
    M.attach(ruler, (e) => loopMenu(Math.max(0, (e.clientX - ruler.getBoundingClientRect().left) / state.pxPerSec)));
  })();

  // ---------- track height (thin / regular / thick noodles) ----------
  const TRACK_H = [{ h: 44, n: 'thin' }, { h: 84, n: 'regular' }, { h: 132, n: 'thick' }];
  function setTrackH(h, { quiet = false } = {}) {
    h = Math.max(36, Math.min(200, Math.round(Number(h) || 84))); state.trackH = h;
    document.documentElement.style.setProperty('--track-h', `${h}px`); document.body.classList.toggle('tracks-thin', h < 72); document.body.classList.toggle('tracks-short', h >= 72 && h < 100);   // short: two rows (name + buttons); thin: one row
    try { localStorage.setItem('bp.trackH', String(h)); } catch (_) {}
    const b = $('#btn-track-h'); if (b) { const lv = TRACK_H.find((x) => x.h === h); b.textContent = '↕'; b.title = `Track height: ${lv ? lv.n + ' noodles' : h + 'px'} — click to cycle, Alt+wheel over the tracks for any size`; }
    renderTracks(); positionPlayhead(); if (!quiet) status(`Tracks: ${TRACK_H.find((x) => x.h === h) ? TRACK_H.find((x) => x.h === h).n + ' noodles' : h + 'px'}`, 1500);
  }
  $('#btn-track-h').addEventListener('click', () => { const i = TRACK_H.findIndex((x) => x.h >= state.trackH); setTrackH(TRACK_H[(i < 0 ? 0 : i + 1) % TRACK_H.length].h); });
  arrange.addEventListener('wheel', (e) => { if (!e.altKey || e.ctrlKey || e.metaKey) return; e.preventDefault(); setTrackH(state.trackH * (e.deltaY < 0 ? 1.12 : 0.89), { quiet: true }); }, { passive: false });
  try { const v = Number(localStorage.getItem('bp.trackH')); if (v) setTrackH(v, { quiet: true }); } catch (_) {}
  arrange.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); state.pxPerSec = Math.min(400, Math.max(8, state.pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87))); renderTracks(); positionPlayhead(); renderSnapChip(); }, { passive: false });

  function positionPlayhead() {
    // #playhead and #loop-region sit inside the scrolling timeline, so they take timeline (content) x, not viewport x.
    const x = HEAD_W + engine.playhead * state.pxPerSec; const vx = x - arrange.scrollLeft;
    playheadEl.style.left = `${x}px`; playheadEl.style.display = vx < HEAD_W ? 'none' : '';   // hidden under the sticky track heads
    const vis = arrange.clientWidth;
    if (engine.playing) { if (vx > vis - 40 || vx < HEAD_W) arrange.scrollLeft = Math.max(0, engine.playhead * state.pxPerSec - 100); }
    else if (positionPlayhead.last != null && Math.abs(positionPlayhead.last - engine.playhead) > 1e-6 && (vx > vis - 20 || vx < HEAD_W)) arrange.scrollLeft = Math.max(0, engine.playhead * state.pxPerSec - 100);   // stop / Home / ⏮ / a jump: bring it into view
    positionPlayhead.last = engine.playhead;
    const ph = engine.playhead; const m = Math.floor(ph / 60), s = ph - m * 60;
    $('#time').textContent = `${m}:${s.toFixed(2).padStart(5, '0')}`;
    const pp = MT.posAt(meter(), Math.max(0, ph) + 1e-4);
    $('#bars').textContent = `${pp.bar}.${pp.beat}`;
    updateNowLine();
  }
  arrange.addEventListener('scroll', () => { positionPlayhead(); drawRuler(); });

  // "+ track" asks what you're recording and sets up type, a sensible default preset, source and arming.
  const TRACK_KINDS = {
    guitar: { name: 'Guitar', type: 'guitar', preset: 'Crunch', instrument: 'audio', arm: true },
    bass:   { name: 'Bass', type: 'bass', preset: 'Clean Round', instrument: 'audio', arm: true },
    vocals: { name: 'Vox', type: 'vocals', preset: 'Rock Lead Vox', instrument: 'audio', arm: true },
    other:  { name: 'Audio', type: 'other', preset: 'Flat', instrument: 'audio', arm: true },
    drumsMic: { name: 'Drums', type: 'drums', preset: 'Rock Room', instrument: 'audio', arm: true },   // a real kit with mics / an e-kit's audio out
    drums:  { name: 'Drum machine', type: 'drums', preset: 'Punk Kit', instrument: 'drumkit', drum: { pattern: 'Punk', kit: 'punk' }, arm: false },
    keys:   { name: 'Keys', type: 'keys', preset: 'Warm Rhodes', instrument: 'synth:keys', arm: true },
    midiGuitar: { name: 'Guitar (MIDI)', type: 'guitar', preset: 'Flat', instrument: 'synth:distgtr', arm: false },
    midiBass: { name: 'Bass (MIDI)', type: 'bass', preset: 'Flat', instrument: 'synth:bassgtr', arm: false },
  };
  // ---- my track setups: each bandmate's own rigs (kept on their computer), offered first when adding a track ----
  const SETUP_SKIP = ['id', 'clips', 'mute', 'solo', 'armed', 'link', 'lockedBy'];
  const trackSetups = () => (Array.isArray(state.settings.trackSetups) ? state.settings.trackSetups : []);
  async function saveTrackSetup(t) {
    const name = await promptName('Name this setup (e.g. "My Strat — crunch")', t.name); if (!name) return;
    const body = JSON.parse(JSON.stringify(t)); for (const k of SETUP_SKIP) delete body[k];
    const list = trackSetups().filter((x) => x.name.toLowerCase() !== name.toLowerCase()); list.unshift({ name: name.slice(0, 60), track: body, at: new Date().toISOString() });
    state.settings = await bp.settings.set({ trackSetups: list.slice(0, 24) });
    status(`Saved "${name}" — it's at the top of Add track from now on.`);
  }
  function renderSetupButtons() {
    const box = $('#addtrack-mine'); if (!box) return; box.innerHTML = ''; const list = trackSetups(); box.hidden = !list.length;
    if (!list.length) return;
    box.append(el('div', 'panel-title', 'My setups'));
    list.forEach((x, i) => { const b = el('button'); b.value = `setup:${i}`; b.append(el('b', null, x.name), el('span', null, `${x.track.instrument === 'audio' ? (x.track.preset || x.track.type || 'audio') : String(x.track.instrument).replace('synth:', 'synth ')}`)); b.addEventListener('contextmenu', async (e) => { e.preventDefault(); const v = await ask('Track setup', `Forget "${x.name}"?`, [['Forget it', 'ok', 'danger'], ['Keep', '']]); if (v === 'ok') { state.settings = await bp.settings.set({ trackSetups: trackSetups().filter((y) => y !== x) }); renderSetupButtons(); } }); box.append(b); });
  }
  function pickTrackKind() {
    return new Promise((resolve) => {
      renderSetupButtons();
      const d = $('#addtrack'); d.returnValue = ''; d.showModal();
      d.addEventListener('close', function h() { d.removeEventListener('close', h); const v = d.returnValue; resolve(TRACK_KINDS[v] || (/^setup:\d+$/.test(v) && trackSetups()[Number(v.slice(6))]) ? v : null); });
    });
  }
  function addTrackFromSetup(x, name) {
    let made = null; const taken = new Set(engine.tracks.map((t) => String(t.name).toLowerCase()));
    let base = name || x.track.name || x.name; let nm = base, k = 2; while (taken.has(nm.toLowerCase())) nm = `${base} ${k++}`;
    change(() => { made = engine.addTrack(nm); const patch = JSON.parse(JSON.stringify(x.track)); delete patch.name; engine.updateTrack(made.id, patch); state.selectedTrack = made.id; if (made.instrument !== 'drumkit') state.armedTrack = made.id; }, { label: `add ${nm} (${x.name})` });
    engine.setLiveMidiTrack && engine.setLiveMidiTrack(made.id); renderAll(); return made;
  }
  function addTrackOfKind(kind, name) {
    if (/^setup:\d+$/.test(String(kind))) { const x = trackSetups()[Number(String(kind).slice(6))]; if (!x) throw new Error('that track setup is gone'); return addTrackFromSetup(x, name); }
    const k = TRACK_KINDS[kind]; if (!k) throw new Error(`unknown track kind ${kind}`);
    const PR = window.BPPresets;
    const taken = new Set(engine.tracks.map((t) => String(t.name).toLowerCase())); let nn = 1; while (taken.has((nn > 1 ? `${k.name} ${nn}` : k.name).toLowerCase())) nn++;
    let made = null;
    change(() => {
      made = engine.addTrack(name || (nn > 1 ? `${k.name} ${nn}` : k.name));
      const patch = { type: k.type, instrument: k.instrument, gainDb: k.instrument === 'drumkit' ? -3 : -6, typeSet: true };   // picked by hand in Add track   // start with headroom so a few tracks don't pin the master
      if (k.instrument === 'drumkit') { const drum = window.BPEngine.DEFAULT_DRUM(); if (k.drum) Object.assign(drum, k.drum); if (!PR.DRUM_PATTERNS[drum.pattern]) drum.pattern = 'Rock 4/4'; if (!window.BPSynth.KITS[drum.kit]) drum.kit = 'rock'; patch.drum = drum; }
      engine.updateTrack(made.id, patch);
      state.selectedTrack = made.id;
      if (k.arm) state.armedTrack = made.id; else if (state.armedTrack === made.id) state.armedTrack = null;
    }, { label: `add ${k.name} track` });
    if (!made) return null;
    if (made && k.preset && (PR.PRESETS[k.type] || []).some((p) => p.name === k.preset)) { const u = state.undo.pop(); applyPreset(made.id, k.preset, k.type); state.undo.pop(); if (u) state.undo.push(u); }   // one undo step for the whole add
    engine.setLiveMidiTrack && engine.setLiveMidiTrack(made.id);
    renderAll();
    return made;
  }
  $('#btn-noodle').addEventListener('click', () => openNoodle().catch(fail));
  $('#btn-unlock-all').addEventListener('click', () => { const all = engine.tracks.length && engine.tracks.every((t) => mineT(t.id)); (all ? lockAll() : unlockAll()).catch(fail); });
  { const sb = $('#snap-ind'); const setSnap = (m) => { state.snapMode = m; try { localStorage.setItem('bp.snapMode', m); } catch (_) {} renderTracks(); drawRuler(); status(m === 'auto' ? `Snap follows the zoom (now ${gridLabel()}).` : `Snap locked to ${gridLabel()}.`); };
    const items = () => [{ title: 'Snap (hold Alt while dragging for none)' }, { label: `Follow the zoom (now ${gridLabel(gridStep(state.pxPerSec, 12, 'auto'))})`, checked: (state.snapMode || 'auto') === 'auto', action: () => setSnap('auto') }, 'sep',
      ...[['bar', 'Bar'], ['1', 'Beat'], ['2', '1/2 beat'], ['4', '1/4 beat'], ['8', '1/8 beat']].map(([m, l]) => ({ label: `${l} (${gridLabel(gridStep(state.pxPerSec, 12, m))})`, checked: state.snapMode === m, action: () => setSnap(m) }))];
    sb.addEventListener('click', (e) => { e.stopPropagation(); const r = sb.getBoundingClientRect(); M.show(r.left, r.bottom + 2, items()); });
    M.attach(sb, items); }
  $('#btn-drums').addEventListener('click', () => { if (!state.folder) { status('Open a song first.'); return; } openDrums().catch(fail); });
  $('#btn-import-audio').addEventListener('click', () => { if (!state.folder) { status('Open a song first.'); return; } if (ro()) { status('Read-only — take over to add tracks.'); return; } window.pickAudioFiles(0); });
  $('#btn-add-track').addEventListener('click', async () => { if (state.readOnly) return; if (state.ab) await leaveAB({ silent: true }); const kind = await pickTrackKind(); if (!kind) return; const t = addTrackOfKind(kind); if (!t) return; if (kind === 'drums' && document.body.classList.contains('writing')) setWriting(false); status(kind === 'drums' || t.instrument === 'drumkit' ? `${t.name}: drum machine — pick a pattern in Track FX, it plays along with the song.` : `${t.name} added and armed — hit R to record.`); });

  // ---------- mixer ----------
  function renderMixer() {
    const m = $('#mixer'); m.innerHTML = '';
    for (const t of engine.tracks) m.appendChild(makeStrip(t));
    const ma = $('#master-area'); ma.innerHTML = ''; ma.appendChild(makeStrip(null));
  }
  let clipHeld = false, peakHold = { v: -Infinity, at: 0 }, lufsEma = null;
  const ROLE_LABEL = { drums: 'drums', bass: 'bass', gtr: 'guitar', keys: 'keys', leadVox: 'lead vocal', backVox: 'backing vox', synth: 'synth', other: 'bed / other' };
  // Quick fixes: the mixing moves people reach for most, as whole-FX patches (merged over what's there). Plain names, undoable.
  const QUICK_FIXES = [
    ['vocal', 'Sit the vocal in the mix', 'low-cut 100 Hz, a little less mud, presence up, gentle compression, a touch of reverb', { hpf: { on: true, hz: 100 }, eq: { on: true, low: { hz: 300, db: -2 }, high: { hz: 3500, db: 3 } }, comp: { on: true, threshold: -22, ratio: 3, attack: 0.01, release: 0.12, makeup: 3 }, reverbSend: 0.2 }],
    ['vocal', 'Vocal: tame the harshness', 'pull 2.5–4 kHz down a bit, soften the top', { eq: { on: true, mid: { hz: 3000, db: -3, q: 1.5 }, high: { hz: 9000, db: -1.5 } } }],
    ['bass', 'Bass: tight and even', 'low-cut 35 Hz, roll off the fizz, firm compression so every note is the same size', { hpf: { on: true, hz: 35 }, lpf: { on: true, hz: 5000 }, eq: { on: true, low: { hz: 80, db: 1.5 } }, comp: { on: true, threshold: -20, ratio: 4, attack: 0.008, release: 0.1, makeup: 3 } }],
    ['guitar', 'Guitar: less mud', 'low-cut 90 Hz and dip 300 Hz so it stops fighting the bass', { hpf: { on: true, hz: 90 }, eq: { on: true, mid: { hz: 300, db: -3, q: 1 } } }],
    ['guitar', 'Guitar: make room for the vocal', 'a small dip where the voice lives (2.5 kHz)', { eq: { on: true, mid: { hz: 2500, db: -2.5, q: 1.2 } } }],
    ['drums', 'Drums: more punch', 'compression that lets the hit through, a bit of thump and snap', { comp: { on: true, threshold: -18, ratio: 3, attack: 0.025, release: 0.12, makeup: 2 }, eq: { on: true, low: { hz: 70, db: 1.5 }, high: { hz: 8000, db: 2 } } }],
    ['keys', 'Keys: make room for the vocal', 'a small dip at 2.5 kHz and a low-cut so the left hand stays out of the bass', { hpf: { on: true, hz: 80 }, eq: { on: true, mid: { hz: 2500, db: -2.5, q: 1.2 } } }],
    ['*', 'Brighter', 'high shelf +2 dB', { eq: { on: true, high: { db: 2 } } }],
    ['*', 'Darker', 'high shelf −2 dB', { eq: { on: true, high: { db: -2 } } }],
    ['*', 'Warmer', 'low shelf +2 dB', { eq: { on: true, low: { db: 2 } } }],
    ['*', 'Thinner', 'low shelf −2 dB and a low-cut', { hpf: { on: true }, eq: { on: true, low: { db: -2 } } }],
    ['*', 'Even it out (compress)', 'medium compression', { comp: { on: true, threshold: -20, ratio: 3, attack: 0.015, release: 0.15, makeup: 2 } }],
    ['*', 'Add space (reverb)', 'reverb send 25%', { reverbSend: 0.25 }],
    ['*', 'Dry it up (no reverb)', 'reverb send 0', { reverbSend: 0 }],
  ];
  function quickFixMenu(t) {
    const role = window.BPAutoMix.role(t); const want = { leadVox: 'vocal', backVox: 'vocal', gtr: 'guitar', synth: 'keys' }[role] || role; const mine = QUICK_FIXES.filter(([r]) => r === want); const any = QUICK_FIXES.filter(([r]) => r === '*');
    const item = ([, label, desc, patch]) => ({ label, hint: desc, disabled: ro(), action: () => { change(() => engine.updateTrack(t.id, { fx: patch }), { label: `${t.name}: ${label.toLowerCase()}` }); renderAll(); status(`${t.name}: ${label} — ${desc}. ${MOD}+Z undoes it.`, 7000); } });
    const others = engine.tracks.filter((x) => x.id !== t.id);
    return [{ title: `${t.name} — quick fixes` }, ...mine.map(item), ...(mine.length ? ['sep'] : []), ...any.map(item), 'sep',
      { label: 'Copy the sound from…', sub: others.length ? others.map((o) => ({ label: o.name, action: () => { change(() => engine.updateTrack(t.id, { fx: JSON.parse(JSON.stringify(o.fx)) }), { label: `${t.name}: FX from ${o.name}` }); renderAll(); } })) : [{ label: 'no other tracks', disabled: true }], disabled: ro() },
      { label: 'Start over (flat: no EQ, no compression, no reverb)', disabled: ro(), action: () => { change(() => engine.updateTrack(t.id, { fx: window.BPEngine.DEFAULT_FX() }), { label: `${t.name}: FX reset` }); renderAll(); } },
      { label: 'Fader 0 dB · pan centre', disabled: ro(), action: () => { change(() => engine.updateTrack(t.id, { gainDb: 0, pan: 0 }), { label: `${t.name}: level reset` }); renderAll(); } },
      { label: 'Open Track FX (all the knobs)', action: () => { state.selectedTrack = t.id; renderAll(); } }];
  }
  function makeStrip(t) {
    const s = el('div', 'strip' + (t ? '' : ' master')); s.dataset.id = t ? t.id : 'master';
    M.attach(s, () => stripMenu(t));
    s.appendChild(el('div', 'sname', t ? t.name : 'MASTER'));
    if (t) { const pan = document.createElement('input'); pan.type = 'range'; pan.className = 'pan'; pan.min = -1; pan.max = 1; pan.step = 0.05; pan.value = t.pan; pan.title = 'Pan: left / right position in the speakers. Double-click = centre.';
      gestureUndo(pan, () => `${t.name} pan`);
      const panTxt = (v) => (Math.abs(v) < 0.025 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`); const pv = el('div', 'val', panTxt(t.pan));
      pan.addEventListener('input', () => { if (state.readOnly) return; engine.updateTrack(t.id, { pan: Number(pan.value) }); pv.textContent = panTxt(Number(pan.value)); markDirty(); }); pan.addEventListener('dblclick', () => { pan.value = 0; pan.dispatchEvent(new Event('input')); pan.dispatchEvent(new Event('change')); }); s.append(pan, pv); }
    const row = el('div', 'fader-row');
    const f = document.createElement('input'); f.type = 'range'; f.className = 'fader'; f.min = -60; f.max = 12; f.step = 0.5; f.value = t ? t.gainDb : engine.master.gainDb; f.title = 'Volume (dB). 0 is as recorded; −6 is about half as loud. Double-click = 0.';
    const val = el('div', 'val', `${f.value} dB`);
    gestureUndo(f, () => `${t ? t.name : 'master'} fader`);
    f.addEventListener('input', () => { if (state.readOnly) return; const v = Number(f.value); if (t) engine.updateTrack(t.id, { gainDb: v }); else engine.setMaster({ gainDb: v }); val.textContent = `${v} dB`; markDirty(); });
    f.addEventListener('dblclick', () => { f.value = 0; f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); });
    f.addEventListener('change', () => { if (t && t.id === state.selectedTrack) renderFx(); });
    const meter = el('div', 'meter'); meter.appendChild(el('div', 'fill'));
    row.append(f, meter); s.append(row, val);
    if (!t) {
      const cl = el('div', 'cliplight' + (clipHeld ? ' on' : ''), clipHeld ? 'CLIP' : 'ok'); cl.title = 'red = the mix went over 0 dBFS with the limiter off (click or stop to reset); amber = the limiter is working hard, turn the loud tracks down'; cl.addEventListener('click', () => { clipHeld = false; cl.classList.remove('on'); cl.textContent = 'ok'; });
      const pk = el('div', 'peak', '−∞'); pk.title = 'Peak: the loudest moment of the whole mix in the last 2 seconds, in dBFS (0 is the ceiling), measured before the limiter. If it keeps touching 0, turn the loud tracks down.';
      const lim = el('label', 'lim'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = engine.master.limiter !== false; cb.title = 'Limiter: a safety net on the whole mix that catches the loudest peaks so they never clip (crackle), even with lots of effects stacked up. Leave it on unless you are checking peaks on purpose.'; cb.addEventListener('change', () => { if (state.readOnly) { cb.checked = !cb.checked; return; } change(() => engine.setMaster({ limiter: cb.checked })); }); lim.append(cb, el('span', null, 'limit'));
      s.append(cl, pk, lim);
      const lu = el('div', 'lufs mixonly', '— LUFS'); lu.title = 'Loudness of the mix right now (short-term LUFS). Streaming "normal" is about −14; loud rock sits around −9. Auto master gets you there.'; s.append(lu);
    }
    if (t) {   // Mix console only (hidden elsewhere): role, reverb send, quick FX on/off, ✨ quick fixes
      const mx = el('div', 'mixonly');
      const role = window.BPAutoMix.role(t); const rc = el('span', 'role', ROLE_LABEL[role] || role); rc.style.borderColor = t.color; rc.title = `Cobander hears this as ${ROLE_LABEL[role] || role} (from the name / type) — Auto mix and the quick fixes use it`; mx.append(rc);
      const sendRow = el('div', 'send'); const sl = document.createElement('input'); sl.type = 'range'; sl.min = 0; sl.max = 100; sl.step = 1; sl.value = Math.round((t.fx.reverbSend || 0) * 100); sl.title = 'Reverb send: how much of this track goes into the shared room sound. Vocals like some; bass and kick none.';
      gestureUndo(sl, () => `${t.name} reverb send`); sl.addEventListener('input', () => { if (state.readOnly) return; engine.updateTrack(t.id, { fx: { reverbSend: Number(sl.value) / 100 } }); sv.textContent = `${sl.value}%`; markDirty(); });
      const sv = el('span', 'val', `${sl.value}%`); sendRow.append(el('span', 'lbl', 'verb'), sl, sv); mx.append(sendRow);
      const chips = el('div', 'fxchips');
      for (const [k, label, tip] of [['hpf', 'LC', 'Low-cut (high-pass): takes out rumble and boom below the note'], ['eq', 'EQ', 'EQ: tone — low / mid / high'], ['comp', 'CMP', 'Compressor: evens out loud and quiet moments'], ['amp', 'AMP', 'Amp model (guitar / bass)'], ['delay', 'DLY', 'Delay (echo)']]) {
        if (k === 'amp' && !(role === 'gtr' || role === 'bass' || (t.fx.amp && t.fx.amp.on))) continue;
        const c = el('button', 'chip-fx' + (t.fx[k] && t.fx[k].on ? ' on' : ''), label); c.title = `${tip} — click to turn ${t.fx[k] && t.fx[k].on ? 'off' : 'on'}; the knobs are in Track FX on the right`;
        c.addEventListener('click', (e) => { e.stopPropagation(); if (ro()) return; change(() => engine.updateTrack(t.id, { fx: { [k]: { on: !(t.fx[k] && t.fx[k].on) } } }), { label: `${t.name} ${label} ${t.fx[k] && t.fx[k].on ? 'off' : 'on'}` }); state.selectedTrack = t.id; renderAll(); });
        chips.append(c);
      }
      mx.append(chips);
      const qf = el('button', 'quickfix'); qf.append(el('i', 'om om-spoon'), document.createTextNode(' fix')); qf.title = 'Quick fixes: common mixing moves in plain words (sit the vocal, less mud, more punch, brighter…). Each one is undoable.'; qf.addEventListener('click', (e) => { e.stopPropagation(); state.selectedTrack = t.id; menuAt(qf, quickFixMenu(t)); }); mx.append(qf);
      s.append(mx);
    }
    if (t) { const b = el('div', 'btns'); const mu = el('button', 'mute' + (t.mute ? ' active' : ''), 'M'); mu.addEventListener('click', () => { change(() => engine.updateTrack(t.id, { mute: !t.mute }), { undoable: false }); renderAll(); }); const so = el('button', 'solo' + (t.solo ? ' active' : ''), 'S'); so.addEventListener('click', () => { change(() => engine.updateTrack(t.id, { solo: !t.solo }), { undoable: false }); renderAll(); }); b.append(mu, so); s.appendChild(b); s.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') { state.selectedTrack = t.id; renderTracks(); renderFx(); } }); }
    return s;
  }

  // One undo entry per slider gesture (first input event of a drag/keypress run), whatever started it.
  function gestureUndo(input, labelFn) {
    input.addEventListener('input', () => { if (state.readOnly) return; if (!input._gest) { input._gest = true; pushUndo(labelFn()); } }, true);
    input.addEventListener('change', () => { input._gest = false; });
    input.addEventListener('blur', () => { input._gest = false; });
  }
  function meterLoop() {
    const m = engine.ctx ? engine.meters() : null;
    if (m) {
      const recId = engine.recording && !engine.recording.midi ? engine.recording.trackId : null;
      document.querySelectorAll('.strip').forEach((s) => { const lv = s.dataset.id === 'master' ? m.master : s.dataset.id === recId ? m.input : m.tracks[s.dataset.id]; const fill = s.querySelector('.meter .fill'); if (fill) fill.style.height = `${pct(lv)}%`; });
      const ms = $('#master-area .strip'); if (ms && m.master) {
        const now = performance.now(); const p = m.master.peakDbfs;
        if (Number.isFinite(p) && (p >= peakHold.v || now - peakHold.at > 2000)) peakHold = { v: p, at: now };
        const pk = ms.querySelector('.peak'); if (pk) pk.textContent = Number.isFinite(peakHold.v) && peakHold.v > -90 ? `${peakHold.v > 0 ? '+' : ''}${peakHold.v.toFixed(1)}` : '−∞';
        const cl = ms.querySelector('.cliplight');
        if (Number.isFinite(p) && p > 0 && !engine.master.limiter && !clipHeld) { clipHeld = true; if (cl) { cl.classList.add('on'); cl.classList.remove('hot'); cl.textContent = 'CLIP'; } }
        else if (cl && !clipHeld) { const hot = peakHold.v > 0 || m.limiterDb < -3; cl.classList.toggle('hot', hot); cl.textContent = hot ? 'HOT' : 'ok'; }
        const lim = ms.querySelector('.lim span'); if (lim) lim.textContent = m.limiterDb < -0.5 ? `limiter ${m.limiterDb.toFixed(1)} dB` : 'limiter';
        const lu = ms.querySelector('.lufs'); if (lu && state.ws === 'mix') { const v0 = Number.isFinite(m.master.rmsDbfs) ? m.master.rmsDbfs - 0.7 : null; const v = v0 == null || v0 < -70 ? (lufsEma = null) : (lufsEma = lufsEma == null ? v0 : lufsEma * 0.92 + v0 * 0.08); lu.textContent = v != null && v > -70 && (engine.playing || engine.recording) ? `${v.toFixed(1)} LUFS` : '— LUFS'; lu.classList.toggle('hot', v != null && v > -8); }
      }
      const inFill = $('#input-meter .fill'); if (inFill) inFill.style.width = `${pct(m.input)}%`;
    }
    requestAnimationFrame(meterLoop);
  }
  function pct(lv) { if (!lv || !Number.isFinite(lv.peakDbfs)) return 0; return Math.max(0, Math.min(100, (lv.peakDbfs + 60) / 60 * 100)); }

  // ---------- FX ----------
  const keysOctave = { base: 48 };
  const fxOpen = new Map();   // group title -> user-chosen open/closed, this session
  const AMP_NAMES = { clean: 'Clean (Fender-ish)', crunch: 'Crunch (Marshall-ish)', lead: 'Lead (hot-rodded)', highgain: 'High gain (modern)', fuzz: 'Fuzz', bass: 'Bass amp (clean)', bassdrive: 'Bass amp (driven)' };
  const CAB_NAMES = { 412: '4×12 (big, tight)', 212: '2×12 (open combo)', 112: '1×12 (small combo)', 810: '8×10 bass', 115: '1×15 bass', none: 'no cab (DI / already amped)' };
  function renderFx() {
    $('#bottom').classList.toggle('trk-ro', !!(state.song && !canTouch(engine.track(state.selectedTrack))));   // FX of a track that isn't yours: look, don't touch
    const body = $('#fx-body'); body.innerHTML = '';
    const t = engine.track(state.selectedTrack);
    if (renderFx.lastTrack !== state.selectedTrack) { $('#fx-panel').scrollTop = 0; renderFx.lastTrack = state.selectedTrack; }
    $('#fx-track-name').textContent = t ? `— ${t.name}` : '';
    if (!t) { body.textContent = 'Select a track.'; body.className = 'muted'; return; }
    body.className = '';
    const fx = t.fx;
    // plain-English tips for the knobs (shown on hover / in help mode)
    const FX_TIPS = {
      'Amp': 'A guitar / bass amp model. Turn it on for crunch and body; off for the raw pickup sound.', 'gain': 'How hard the amp is driven: low = clean, high = distorted.', 'bass': 'Low end from the amp.', 'mid': 'Body / honk. Cutting mids scoops the sound.', 'treble': 'Brightness.', 'presence (top-end bite)': 'Extra edge above the treble.', 'level': 'How loud the amp comes out (after the distortion).', 'cab': 'Which speaker cabinet: 112 = small and tight, 412 = big rock stack.', 'amp': 'Which amp: clean, crunch, distorted, bass…',
      'High-pass (cuts rumble)': 'Removes everything below a note — mic thumps, hum, boom. Vocals and guitars usually want this on around 80–120 Hz.', 'cut below': 'Nothing below this frequency gets through. Bass and kick: keep it low (30–40 Hz).',
      'Low-pass (cuts clicks, fizz, fret noise)': 'Removes the very top end — harsh fizz, string squeak. Leave off unless something sounds scratchy.', 'cut above': 'Nothing above this frequency gets through.',
      'EQ': 'Turn parts of the sound up or down. Low = bass / boom, mid = body / honk, high = sparkle / hiss. Small moves (±3 dB) go a long way.',
      'low Hz': 'Where the low control works.', 'low dB': 'More or less low end. Cut it if a track sounds muddy.', 'mid Hz': 'Where the mid control works (300 = mud, 1000 = honk, 3000 = presence).', 'mid dB': 'More or less of that spot.', 'mid width': 'How wide a band the mid control grabs: narrow (high Q) for one annoying note, wide for a general tilt.', 'high Hz': 'Where the high control works.', 'high dB': 'More or less sparkle. Cut it if a track hisses.',
      'Compressor (evens out loud/quiet)': 'Turns the loud moments down so the quiet ones can come up — keeps a vocal or bass steady in the mix. The defaults are sensible.',
      'threshold': 'Where it starts working: lower = it grabs more of the performance.', 'ratio': 'How hard it squashes once past the threshold. 2–4 is gentle, 10+ is a limiter.', 'attack': 'How fast it reacts. Slow (20–30 ms) lets the pick / drum hit through; fast flattens it.', 'release': 'How fast it lets go. Too fast pumps; too slow smears.', 'knee (softness)': 'How gradually it kicks in around the threshold.', 'makeup gain': 'Turn the result back up — compressing makes things quieter overall.',
      'Delay': 'Echo. Synced delay repeats in time with the song.', 'time': 'Gap between repeats.', 'feedback': 'How many repeats before it fades.', 'mix': 'How much echo versus the dry sound.',
      'Reverb (send to the shared room)': 'How much of this track goes into the shared room sound. Vocals like some; bass and kick usually none.', 'amount': 'How much of this track goes to the reverb.',
      'Master reverb (shared by all tracks)': 'The one room every track\'s reverb send goes into.', 'decay': 'How long the room rings.', 'pre-delay': 'A tiny gap before the reverb starts; keeps the words clear.', 'damp': 'Darker or brighter room.',
      'Gate (cuts noise between notes)': 'Mutes the track when it\'s quieter than the threshold — kills hum and bleed between phrases. Set it just above the noise.',
    };
    const slider = (label, get, set, min, max, step, unit, tip) => {
      const l = el('label'); tip = tip || FX_TIPS[label]; if (tip) l.title = tip; l.append(el('span', null, label));
      const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = get();
      const v = el('span', 'v', `${fmt(get())}${unit}`);
      gestureUndo(r, () => `${t.name} ${label}`);
      r.addEventListener('input', () => { if (state.readOnly) return; set(Number(r.value)); v.textContent = `${fmt(Number(r.value))}${unit}`; markDirty(); });
      r.addEventListener('change', () => { if (t.preset) { renderTracks(); renderFx(); } });   // refresh "(edited)" markers once the drag ends
      l.append(r, v); return l;
    };
    // Groups collapse to one line unless the effect is on or the user opened them (remembered per session).
    const group = (title, isOn, setOn, params, { open = null } = {}) => {
      const g = el('div', 'fx-group'); const h = el('div', 'fx-title');
      const key = title.replace(/:.*/, '');
      const isOpen = fxOpen.has(key) ? fxOpen.get(key) : (open !== null ? open : false);
      if (!isOpen) g.classList.add('collapsed');
      const caret = el('span', 'caret', isOpen ? '▾' : '▸'); h.append(caret);
      if (setOn) { const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isOn(); cb.addEventListener('click', (e) => e.stopPropagation()); cb.addEventListener('change', () => { change(() => setOn(cb.checked)); if (cb.checked && g.classList.contains('collapsed')) { g.classList.remove('collapsed'); caret.textContent = '▾'; fxOpen.set(key, true); } }); h.append(cb); }
      h.append(el('span', null, title)); if (FX_TIPS[title]) h.title = FX_TIPS[title];
      if (setOn && !isOpen) h.append(el('span', 'onoff', isOn() ? 'on' : 'off'));
      h.addEventListener('click', (e) => { if (e.target.tagName === 'INPUT') return; const now = g.classList.toggle('collapsed'); caret.textContent = now ? '▸' : '▾'; fxOpen.set(key, !now); const oo = h.querySelector('.onoff'); if (oo) oo.remove(); if (now && setOn) h.append(el('span', 'onoff', isOn() ? 'on' : 'off')); });
      g.appendChild(h);
      const p = el('div', 'params'); for (const args of params) p.appendChild(slider(...args)); g.appendChild(p); return g;
    };
    const upd = (patch) => engine.updateTrack(t.id, { fx: patch });
    const selectRow = (label, options, value, onChange, title) => {
      const l = el('label', 'sel-row'); l.append(el('span', null, label));
      const sel = document.createElement('select'); if (title) sel.title = title;
      for (const [v, text] of options) { const o = el('option', null, text); o.value = v; if (v === value) o.selected = true; sel.appendChild(o); }
      sel.addEventListener('change', () => { if (state.readOnly) { sel.value = value; return; } onChange(sel.value); });
      l.append(sel); return l;
    };
    const PR = window.BPPresets;
    // ---- type / preset / instrument ----
    const head = el('div', 'fx-group');
    head.append(el('div', 'fx-title', 'Track setup'));
    const hp = el('div', 'params');
    hp.append(selectRow('type', PR.TYPES.map((x) => [x, x]), t.type, (v) => { change(() => engine.updateTrack(t.id, { type: v, preset: null, typeSet: true })); renderAll(); }));
    const presets = PR.PRESETS[t.type] || [];
    const edited = t.preset && presetLabel(t).endsWith('(edited)');
    const prow = selectRow('preset', [['', '— pick a preset —'], ...(edited ? [[t.preset, `${t.preset} (edited)`]] : []), ...presets.filter((p) => !(edited && p.name === t.preset)).map((p) => [p.name, `${p.name} — ${p.blurb}`])], t.preset || '', (v) => { if (v) applyPreset(t.id, v); }, 'replaces the whole FX chain with the preset');
    if (edited) { const rb = el('button', null, 'reset'); rb.title = `back to the untouched ${t.preset} preset`; rb.addEventListener('click', () => applyPreset(t.id, t.preset)); prow.append(rb); }
    hp.append(prow);
    const rn = el('button', null, 'rename track'); rn.addEventListener('click', async () => { const n = await promptName('Track name', t.name); if (n) { change(() => engine.updateTrack(t.id, { name: n }), { label: `rename track to ${n}` }); fixTrackTypes({ quiet: false }); renderAll(); } });
    const nameRow = el('label', 'sel-row'); nameRow.append(el('span', null, 'name'), el('span', 'v-left', t.name), rn); hp.prepend(nameRow);
    hp.append(selectRow('source', PR.INSTRUMENTS.map((i) => [i.id, i.name]), t.instrument, (v) => { change(() => engine.updateTrack(t.id, { instrument: v, drum: v === 'drumkit' ? (t.drum || window.BPEngine.DEFAULT_DRUM()) : undefined })); engine.setLiveMidiTrack(t.id); renderAll(); }, 'audio input, a built-in synth played by MIDI, or the drum machine'));
    if (t.instrument.startsWith('synth:')) {
      const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const wrap = el('div'); const bar = el('div', 'keys-bar');
      const down = el('button', null, '− oct'), up = el('button', null, '+ oct'); const lbl = el('span', 'small muted', `C${Math.floor(keysOctave.base / 12) - 1} – C${Math.floor(keysOctave.base / 12) + 1}`);
      down.addEventListener('click', () => { keysOctave.base = Math.max(24, keysOctave.base - 12); renderFx(); }); up.addEventListener('click', () => { keysOctave.base = Math.min(84, keysOctave.base + 12); renderFx(); });
      bar.append(down, lbl, up, el('span', 'small muted', ' click the keys or play a MIDI keyboard — both play and record (R)'));
      const keys = el('div', 'keys');
      for (let n = keysOctave.base; n <= keysOctave.base + 24; n++) { const black = [1, 3, 6, 8, 10].includes(n % 12); const k = el('button', 'key' + (black ? ' black' : ''), black ? '' : NAMES[n % 12] + (n % 12 === 0 ? Math.floor(n / 12) - 1 : '')); k.title = `${NAMES[n % 12]}${Math.floor(n / 12) - 1} (midi ${n})`; let held = false; const on = (e) => { e.preventDefault(); if (held) return; held = true; engine.noteOn(t.id, n, 0.8); k.classList.add('down'); }; const off = () => { if (!held) return; held = false; engine.noteOff(t.id, n); k.classList.remove('down'); }; k.addEventListener('mousedown', on); k.addEventListener('mouseup', off); k.addEventListener('mouseleave', off); k.addEventListener('mouseenter', (e) => { if (e.buttons & 1) on(e); }); keys.appendChild(k); }
      wrap.append(bar, keys); hp.append(wrap);
    }
    head.append(hp); body.append(head);
    if (state.selectedClip) {
      const c = t.clips.find((x) => x.id === state.selectedClip);
      if (c) {
        const maxTrim = Math.max(0.01, (c.duration || 1) - 0.05);
        const cg = group(`Take: ${c.name}${c.mute ? ' (muted)' : ''}${c.takenBy ? ` — by ${c.takenBy}` : ''}`, null, null, [
          ['gain', () => c.gainDb, (v) => { c.gainDb = v; }, -60, 12, 0.5, ' dB'],
          ['trim start', () => c.trimStart, (v) => { c.trimStart = Math.min(v, maxTrim - c.trimEnd); }, 0, maxTrim, 0.01, ' s'],
          ['trim end', () => c.trimEnd, (v) => { c.trimEnd = Math.min(v, maxTrim - c.trimStart); }, 0, maxTrim, 0.01, ' s'],
          ['fade in', () => c.fadeIn || 0, (v) => { c.fadeIn = v; }, 0, Math.min(10, Math.max(0.1, engine.clipLength(c))), 0.01, ' s'],
          ['fade out', () => c.fadeOut || 0, (v) => { c.fadeOut = v; }, 0, Math.min(10, Math.max(0.1, engine.clipLength(c))), 0.01, ' s']], { open: true });
        cg.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('change', () => renderTracks()));
        const row = el('div', 'toast-btns');
        if (c.kind === 'midi') { const q = el('button', null, 'Quantize to 1/16'); q.addEventListener('click', () => { change(() => engine.quantizeClip(c, 0.25, 1)); renderAll(); }); const q8 = el('button', null, 'Quantize to 1/8'); q8.addEventListener('click', () => { change(() => engine.quantizeClip(c, 0.5, 1)); renderAll(); }); row.append(q, q8, el('span', 'small muted', ` ${c.notes.length} notes`)); }
        const mu = el('button', c.mute ? 'active' : null, c.mute ? 'Muted — un-mute' : 'Mute'); mu.title = 'Mute: keep this take in the song but do not play it — handy for comparing takes without deleting the ones you are unsure about.'; mu.addEventListener('click', () => { change(() => { c.mute = !c.mute; }, { label: `${c.mute ? 'un-mute' : 'mute'} ${c.name}` }); renderAll(); });
        const so = el('button', null, 'Solo (mute the others here)'); so.title = 'Solo: mute every other take on this track that overlaps this one, so only this take plays here. Un-mute the others to change your mind.'; so.addEventListener('click', () => { const others = t.clips.filter((x) => x !== c && x.start < c.start + (engine.clipLength(c) || 1) && x.start + (engine.clipLength(x) || 1) > c.start); change(() => { c.mute = false; for (const x of others) x.mute = true; }, { label: `solo ${c.name}` }); renderAll(); });
        const rn = el('button', null, 'Rename'); rn.addEventListener('click', async () => { const n = await promptName('Take name', c.name); if (n) { change(() => { c.name = n; }); renderAll(); } });
        const lp = el('button', null, 'Loop this take'); lp.addEventListener('click', () => $('#btn-loop-clip').click());
        const del = el('button', 'danger', 'Delete take'); del.addEventListener('click', () => deleteClip(t, c).catch(fail));
        row.append(mu, so, rn, lp, del); cg.querySelector('.params').append(row); body.appendChild(cg);
      }
    }
    // ---- quick controls: the three things a non-engineer reaches for ----
    if (t.instrument !== 'drumkit') {
      const squash = () => (fx.comp.on ? Math.round(clamp((-10 - fx.comp.threshold) / 30, 0, 1, 0) * 100) : 0);
      body.append(group('Quick', null, null, [
        ['level', () => t.gainDb, (v) => engine.updateTrack(t.id, { gainDb: v }), -40, 12, 0.5, ' dB', 'how loud this track is in the mix (same as its fader)'],
        ['reverb', () => Math.round(fx.reverbSend * 100), (v) => upd({ reverbSend: v / 100 }), 0, 100, 1, '%', 'room / space: 0 = bone dry'],
        ['squash', () => squash(), (v) => upd({ comp: { on: v > 0, threshold: Math.round(-10 - v / 100 * 30), ratio: Math.max(fx.comp.ratio, 3) } }), 0, 100, 1, '%', 'compression: evens out loud and quiet parts so the take sits steady in the mix'],
      ], { open: true }));
      const q = body.lastChild.querySelector('.params'); q.append(el('div', 'small muted', 'squash = compression: evens out loud and quiet bits. Everything below is the detailed version.'));
      q.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('change', () => { renderMixer(); }));
    }
    // ---- drum machine ----
    if (t.instrument === 'drumkit' && t.drum) {
      const dg = el('div', 'fx-group'); dg.append(el('div', 'fx-title', 'Drum machine'));
      const dp = el('div', 'params');
      const dupd = (patch) => { change(() => engine.updateTrack(t.id, { drum: { ...t.drum, ...patch } }), { label: `${t.name} drum ${Object.keys(patch)[0] === 'custom' ? 'step' : Object.keys(patch)[0]}` }); renderAll(); };
      dp.append(selectRow('kit', PR.DRUM_KITS.map((k) => [k, k]), t.drum.kit, (v) => dupd({ kit: v })));
      dp.append(selectRow('pattern', [...Object.keys(PR.DRUM_PATTERNS).map((k) => [k, k]), ['__custom', 'custom (edit grid below)']], t.drum.custom ? '__custom' : t.drum.pattern, (v) => dupd(v === '__custom' ? { custom: JSON.parse(JSON.stringify(PR.DRUM_PATTERNS[t.drum.pattern] || {})) } : { pattern: v, custom: null })));
      dp.append(slider('swing', () => Math.round(t.drum.swing * 100), (v) => engine.updateTrack(t.id, { drum: { ...t.drum, swing: v / 100 } }), 0, 100, 1, '%'));
      { const b = el('button', null, '🥁 Drum editor / generator… (any length, hit by hit)'); b.type = 'button'; b.addEventListener('click', () => openDrums().catch(fail)); dp.append(b); }
      dp.append(slider('bars (0 = whole song)', () => t.drum.bars, (v) => engine.updateTrack(t.id, { drum: { ...t.drum, bars: v } }), 0, 128, 1, ''));
      dp.append(slider('start bar', () => t.drum.offsetBars, (v) => engine.updateTrack(t.id, { drum: { ...t.drum, offsetBars: v } }), 0, 128, 1, ''));
      dp.append(slider('level', () => t.drum.gainDb, (v) => engine.updateTrack(t.id, { drum: { ...t.drum, gainDb: v } }), -24, 12, 0.5, ' dB'));
      dp.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('change', () => renderTracks()));
      const steps = t.drum.custom || PR.DRUM_PATTERNS[t.drum.pattern] || {};
      const nSteps = Math.min(16, engine.timeSig[0] * 4);
      const grid = el('div', 'drumgrid');
      for (const voice of ['kick', 'snare', 'hat', 'ohat', 'tom', 'crash']) {
        const row = el('div', 'drow'); row.append(el('span', 'dname', voice));
        const arr = steps[voice] || [];
        for (let i = 0; i < nSteps; i++) {
          const b = el('button', 'dstep' + (arr[i] === 2 ? ' acc' : arr[i] ? ' on' : '') + (i % 4 === 0 ? ' beat' : ''), '');
          b.addEventListener('click', () => { if (state.readOnly) return; const cur = JSON.parse(JSON.stringify(t.drum.custom || steps)); const a = (cur[voice] = cur[voice] && cur[voice].length === 16 ? cur[voice] : Array(16).fill(0)); a[i] = (a[i] + 1) % 3; dupd({ custom: cur }); engine.playNote(t.id, { kick: 36, snare: 38, hat: 42, ohat: 46, tom: 45, crash: 49 }[voice], a[i] === 2 ? 1 : 0.7); });
          row.append(b);
        }
        grid.append(row);
      }
      dp.append(grid);
      const hint = el('div', 'small muted', `Click a step: off → hit → accent (${nSteps} sixteenths per ${engine.timeSig.join('/')} bar). Editing a built-in pattern turns it into a custom one.`); dp.append(hint);
      dg.append(dp); body.append(dg);
    }
    const a = fx.amp, dl = fx.delay;
    body.append(
      (() => { const g = group('Amp', () => a.on, (v) => upd({ amp: { on: v } }), [
        ['gain', () => a.gain, (v) => upd({ amp: { gain: v } }), 0, 10, 0.1, ''], ['bass', () => a.bass, (v) => upd({ amp: { bass: v } }), -8, 8, 0.5, ''],
        ['mid', () => a.mid, (v) => upd({ amp: { mid: v } }), -8, 8, 0.5, ''], ['treble', () => a.treble, (v) => upd({ amp: { treble: v } }), -8, 8, 0.5, ''],
        ['presence (top-end bite)', () => a.presence, (v) => upd({ amp: { presence: v } }), -8, 8, 0.5, ''], ['level', () => a.level, (v) => upd({ amp: { level: v } }), -24, 12, 0.5, ' dB']]);
        const p = g.querySelector('.params');
        p.prepend(selectRow('cab', window.BPEngine.CABS.map((c) => [c, CAB_NAMES[c] || c]), a.cab, (v) => { change(() => upd({ amp: { cab: v } }), { label: `${t.name} cab` }); }));
        p.prepend(selectRow('amp', window.BPEngine.AMP_MODELS.map((m) => [m, AMP_NAMES[m] || m]), a.model, (v) => { change(() => upd({ amp: { model: v } }), { label: `${t.name} amp model` }); }));
        return g; })(),
      group('High-pass (cuts rumble)', () => fx.hpf.on, (v) => upd({ hpf: { on: v } }), [['cut below', () => fx.hpf.hz, (v) => upd({ hpf: { hz: v } }), 20, 1000, 1, ' Hz']]),
      group('Low-pass (cuts clicks, fizz, fret noise)', () => fx.lpf.on, (v) => upd({ lpf: { on: v } }), [['cut above', () => fx.lpf.hz, (v) => upd({ lpf: { hz: v } }), 500, 20000, 50, ' Hz']]),
      group('EQ', () => fx.eq.on, (v) => upd({ eq: { on: v } }), [
        ['low Hz', () => fx.eq.low.hz, (v) => upd({ eq: { low: { hz: v } } }), 30, 500, 1, ''], ['low dB', () => fx.eq.low.db, (v) => upd({ eq: { low: { db: v } } }), -18, 18, 0.5, ''],
        ['mid Hz', () => fx.eq.mid.hz, (v) => upd({ eq: { mid: { hz: v } } }), 100, 10000, 10, ''], ['mid dB', () => fx.eq.mid.db, (v) => upd({ eq: { mid: { db: v } } }), -18, 18, 0.5, ''],
        ['mid width', () => fx.eq.mid.q, (v) => upd({ eq: { mid: { q: v } } }), 0.2, 10, 0.1, ' Q'],
        ['high Hz', () => fx.eq.high.hz, (v) => upd({ eq: { high: { hz: v } } }), 1500, 16000, 50, ''], ['high dB', () => fx.eq.high.db, (v) => upd({ eq: { high: { db: v } } }), -18, 18, 0.5, '']]),
      group('Compressor (evens out loud/quiet)', () => fx.comp.on, (v) => upd({ comp: { on: v } }), [
        ['threshold', () => fx.comp.threshold, (v) => upd({ comp: { threshold: v } }), -60, 0, 1, ' dB'], ['ratio', () => fx.comp.ratio, (v) => upd({ comp: { ratio: v } }), 1, 20, 0.5, ':1'],
        ['attack', () => fx.comp.attack * 1000, (v) => upd({ comp: { attack: v / 1000 } }), 1, 300, 1, ' ms'], ['release', () => fx.comp.release * 1000, (v) => upd({ comp: { release: v / 1000 } }), 10, 1500, 10, ' ms'],
        ['knee (softness)', () => fx.comp.knee, (v) => upd({ comp: { knee: v } }), 0, 40, 1, ' dB'], ['makeup gain', () => fx.comp.makeup, (v) => upd({ comp: { makeup: v } }), 0, 24, 0.5, ' dB']]),
      (() => { const g = group('Delay', () => dl.on, (v) => upd({ delay: { on: v } }), [
        ['time', () => dl.time, (v) => upd({ delay: { time: v } }), dl.sync ? 0.25 : 0.01, dl.sync ? 4 : 2, dl.sync ? 0.25 : 0.01, dl.sync ? ' beats' : ' s'],
        ['feedback', () => Math.round(dl.feedback * 100), (v) => upd({ delay: { feedback: v / 100 } }), 0, 90, 1, '%'], ['mix', () => Math.round(dl.mix * 100), (v) => upd({ delay: { mix: v / 100 } }), 0, 100, 1, '%']]);
        const p = g.querySelector('.params'); const l = el('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = dl.sync; cb.addEventListener('change', () => { change(() => upd({ delay: { sync: cb.checked, time: cb.checked ? 0.5 : 0.25 } })); renderFx(); }); l.append(el('span', null, 'sync to tempo'), cb); p.prepend(l); return g; })(),
      group('Reverb (send to the shared room)', null, null, [['amount', () => Math.round(fx.reverbSend * 100), (v) => upd({ reverbSend: v / 100 }), 0, 100, 1, '%']]),
      group('Master reverb (shared by all tracks)', null, null, [
        ['decay', () => engine.master.reverb.decay, (v) => engine.setMaster({ reverb: { decay: v } }), 0.2, 6, 0.1, ' s'],
        ['pre-delay', () => engine.master.reverb.preDelay * 1000, (v) => engine.setMaster({ reverb: { preDelay: v / 1000 } }), 0, 100, 5, ' ms'],
        ['damp', () => engine.master.reverb.damp, (v) => engine.setMaster({ reverb: { damp: v } }), 1000, 16000, 100, ' Hz']], { open: false }),
    );
  }
  // The fx a preset would produce (so the UI can tell whether the track still matches it).
  function presetFx(type, name) {
    const list = window.BPPresets.PRESETS[type] || []; const p = list.find((x) => x.name === name); if (!p) return null;
    const fresh = window.BPEngine.DEFAULT_FX(); const fx = JSON.parse(JSON.stringify(fresh));
    for (const k of Object.keys(p.fx)) fx[k] = typeof p.fx[k] === 'object' && p.fx[k] !== null ? { ...fresh[k], ...p.fx[k], ...(k === 'eq' && p.fx[k].low ? { low: { ...fresh.eq.low, ...p.fx[k].low }, mid: { ...fresh.eq.mid, ...p.fx[k].mid }, high: { ...fresh.eq.high, ...p.fx[k].high } } : {}) } : p.fx[k];
    return window.BPEngine.normalizeTrack({ id: 'x', fx }).fx;
  }
  function presetLabel(t) { if (!t.preset) return ''; const pf = presetFx(t.type, t.preset); return pf && JSON.stringify(pf) !== JSON.stringify(t.fx) ? `${t.preset} (edited)` : t.preset; }
  function applyPreset(trackId, name, type = null) {
    const t = engine.track(trackId); if (!t) throw new Error(`no track ${trackId}`);
    const ty = type || t.type;
    const list = window.BPPresets.PRESETS[ty] || []; const p = list.find((x) => x.name === name); if (!p) throw new Error(`no preset "${name}" for type ${ty}`);
    const fx = presetFx(ty, name);
    change(() => engine.updateTrack(t.id, { fx, preset: p.name, type: ty }), { label: `${t.name} preset ${p.name}` });
    renderAll(); status(`${t.name}: ${p.name}`);
    return t;
  }
  function fmt(v) { return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 3 : 1).replace(/\.?0+$/, ''); }

  // Trash: one entry per deleted clip (full clip JSON, so split/trimmed pieces come back exactly), keyed by clip id.
  function trashClip(t, c) {
    const entry = { clip: JSON.parse(JSON.stringify(c)), name: c.name, trackId: t.id, trackName: t.name, start: c.start, takenBy: c.takenBy, by: me(), at: new Date().toISOString() };
    if (entry.clip.notes && entry.clip.notes.length > 2000) entry.clip.notes = entry.clip.notes.slice(0, 2000);
    const trash = { ...(state.song.trash || {}), [c.id]: entry };
    const keys = Object.keys(trash); if (keys.length > 200) { keys.sort((a, b) => String(trash[a].at).localeCompare(String(trash[b].at))); for (const k of keys.slice(0, keys.length - 200)) delete trash[k]; }   // oldest entries fall off; the audio files stay
    state.song.trash = trash;
  }
  const inSong = (id) => engine.tracks.some((t) => t.clips.some((c) => c.id === id));
  // Everything restorable: trashed clips (not back in the song) + audio files no clip and no trash entry references (lost conflicts).
  function deletedTakesList() {
    const out = []; const trash = state.song ? state.song.trash || {} : {};
    const covered = new Set();
    for (const [id, tr] of Object.entries(trash)) { if (inSong(id)) continue; const c = tr.clip || { id, name: tr.name, start: tr.start || 0, takenBy: tr.takenBy, duration: 0, trimStart: 0, trimEnd: 0 }; covered.add(audioId(c)); out.push({ kind: 'trash', id, clip: c, tr }); }
    for (const u of state.unreferenced) if (!covered.has(u.clipId) && !Object.values(trash).some((tr) => tr.clip && audioId(tr.clip) === u.clipId)) out.push({ kind: 'file', id: u.clipId, u });
    return out;
  }
  async function deleteClip(t, c, { confirm = true } = {}) {
    if (state.readOnly) return;
    if (c.link) { const s0 = mirrorSource(c); if (!s0) { mirrorHint(c); return; } const sec = liveSections().find((x) => x.id === c.link.section); status(`Deleting it in the room — every linked ${sec ? TPL.sectionType(sec.name) : 'copy'} loses it.`, 6000); return deleteClip(s0.t, s0.c, { confirm }); }
    if (confirm) { const a = await ask('Delete take', `Remove "${c.name}"${c.takenBy ? ` (recorded by ${c.takenBy})` : ''} from the song? The audio file stays in the folder ("Deleted takes" brings it back) and ${MOD}+Z undoes this.`, [['Delete', 'ok', 'danger'], ['Cancel', 'cancel', 'primary']]); if (a !== 'ok') return; }
    change(() => { t.clips = t.clips.filter((x) => x.id !== c.id); if (state.selectedClip === c.id) state.selectedClip = null; trashClip(t, c); }, { label: `delete ${c.name}` });
    renderAll(); refreshUnreferenced();
    status(`${c.name} removed (${MOD}+Z undoes; "Deleted takes" restores).`);
  }

  // ---------- take editing: split / copy / paste / duplicate / nudge / fades / keep ----------
  const clipboard = { clips: [] };
  const fullLen = (c) => { if (c.kind === 'midi') return c.duration; const b = engine.buffers.get(audioId(c)); return b ? b.duration : c.duration; };
  const clipEnd = (c) => c.start + engine.clipLength(c);
  function findClip(id) { for (const t of engine.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return { t, c }; } return null; }
  const selected = () => (state.selectedClip ? findClip(state.selectedClip) : null);
  function cloneClip(c, start) { const n = JSON.parse(JSON.stringify(c)); n.id = window.BPUtil.newId(); if (c.kind === 'midi') delete n.src; else n.src = audioId(c); n.start = start; n.takenBy = c.takenBy; return n; }
  function splitClip(t, c, at) {
    if (c.link) { const s0 = mirrorSource(c); if (!s0) { mirrorHint(c); return null; } return splitClip(s0.t, s0.c, at + roomShift(c.link.section)); }   // split a copy = split the room's take (every copy follows)
    const a = Math.max(c.start, Math.min(clipEnd(c), at)); const leftLen = a - c.start;
    if (leftLen < 0.02 || clipEnd(c) - a < 0.02) { status('Put the playhead inside the take to split it.'); return null; }
    const full = fullLen(c);
    const base = c.name.replace(/ \((\d+)\)$/, ''); const used = new Set(t.clips.map((x) => x.name));
    const nm = (k) => { let n = `${base} (${k})`; while (used.has(n)) n = `${base} (${++k})`; used.add(n); return n; };
    const left = { ...c, trimEnd: Math.max(0, full - c.trimStart - leftLen), fadeOut: 0, name: / \(\d+\)$/.test(c.name) ? c.name : nm(1) };
    const right = cloneClip(c, a); right.trimStart = c.trimStart + leftLen; right.fadeIn = 0; right.name = nm(2);
    if (c.kind === 'midi') { left.notes = c.notes.filter((n) => n.t - c.trimStart < leftLen); right.notes = c.notes.filter((n) => n.t - c.trimStart >= leftLen); }
    change(() => { const i = t.clips.indexOf(c); t.clips.splice(i, 1, left, right); }, { label: `split ${c.name}` });
    state.selectedClip = right.id; renderAll(); status(`Split ${c.name} at ${fmtBar(a)}.`);
    return right;
  }
  function fmtBar(sec) { const p = MT.posAt(meter(), Math.max(0, sec)); return `bar ${p.bar}.${p.beat}`; }
  function copyClip(c) { clipboard.clips = [JSON.parse(JSON.stringify(c))]; clipboard.song = state.folder; status(`Copied ${c.name} — ${MOD}+V pastes at the playhead on the selected track.`); }
  function pasteClips(trackId, at) {
    if (!clipboard.clips.length) { status('Nothing copied yet.'); return; }
    if (clipboard.song !== state.folder) { status('That take belongs to another song; copy/paste works inside one song.'); return; }
    const t = engine.track(trackId); if (!t) { status('Select a track to paste onto.'); return; }
    const base = Math.min(...clipboard.clips.map((c) => c.start)); let last = null;
    change(() => { for (const c of clipboard.clips) { if (c.kind === 'midi' && !String(t.instrument).startsWith('synth:')) continue; if (c.kind !== 'midi' && t.instrument !== 'audio') continue; last = cloneClip(c, at + (c.start - base)); last.name = `${c.name.replace(/ copy( \d+)?$/, '')} copy`; let k = 2; while (engine.tracks.some((x) => x.clips.some((y) => y.name === last.name))) last.name = `${c.name.replace(/ copy( \d+)?$/, '')} copy ${k++}`; t.clips.push(last); } }, { label: 'paste take' });
    if (last) { state.selectedClip = last.id; state.selectedTrack = t.id; }
    renderAll(); status(last ? `Pasted at ${fmtBar(at)}.` : 'That take does not fit this track type.');
  }
  function duplicateClip(t, c) { const d = cloneClip(c, clipEnd(c)); d.name = `${c.name.replace(/ copy( \d+)?$/, '')} copy`; let k = 2; while (engine.tracks.some((x) => x.clips.some((y) => y.name === d.name))) d.name = `${c.name.replace(/ copy( \d+)?$/, '')} copy ${k++}`; change(() => { t.clips.push(d); }, { label: `duplicate ${c.name}` }); state.selectedClip = d.id; renderAll(); }
  function nudgeClip(c, dSec) { change(() => { c.start = Math.max(0, c.start + dSec); }, { label: `nudge ${c.name}` }); renderAll(); }
  function setFade(c, which, secs) { change(() => { c[which] = Math.max(0, Math.min(engine.clipLength(c), secs)); }, { label: `${which === 'fadeIn' ? 'fade in' : 'fade out'} ${c.name}` }); renderAll(); }
  function overlapping(t, c) { return t.clips.filter((x) => x !== c && x.start < clipEnd(c) && clipEnd(x) > c.start); }
  // ---- comping: this take for just a range (loop / a part); other takes play as before outside it ----
  function compItems(t, c, disabled) {
    const items = []; const s = c.start, e = clipEnd(c);
    if (engine.loop.end > engine.loop.start + 0.25 && engine.loop.start < e - 0.05 && engine.loop.end > s + 0.05) { const a = Math.max(s, engine.loop.start), b = Math.min(e, engine.loop.end); items.push({ label: `Comp: this take for the loop (${fmtBar(a)} – ${fmtBar(b)})`, action: () => compTake(t, c, a, b, 'the loop'), disabled }); }
    for (const x of liveSections()) if (x.start < e - 0.05 && x.end > s + 0.05) items.push({ label: `Comp: this take for ${x.name}`, action: () => compTake(t, c, Math.max(s, x.start), Math.min(e, x.end), x.name), disabled });
    return items.length ? [{ label: 'Comp (use this take for…)', sub: items, disabled }] : [];
  }
  function compTake(t, c, a, b, what) {
    if (!(b > a + 0.05)) { status('That range is outside the take.'); return null; }
    let res = null;
    change(() => { res = window.BPComp.comp(t.clips, c.id, a, b, { len: (x) => engine.clipLength(x) || x.duration, full: fullLen, newId: window.BPUtil.newId, audioId }); t.clips.splice(0, t.clips.length, ...res.clips); }, { label: `comp ${c.name} for ${what}` });
    renderAll(); status(res && res.changed ? `${c.name} now plays for ${what}; the other takes play everywhere else. ${MOD}+Z to undo.` : `${c.name} was already the only take there.`, 7000);
    return res;
  }
  function keepTake(t, c) { change(() => { c.mute = false; for (const x of overlapping(t, c)) x.mute = true; }, { label: `keep ${c.name}` }); state.selectedClip = c.id; renderAll(); status(`Keeping ${c.name}; overlapping takes muted.`); }
  // Temporary solo: hear this take alone over its bars, then put every mute back the way it was when playback stops.
  function auditionTake(t, c) {
    if (engine.recording) { status('Stop recording first.'); return; }
    if (engine.audition) engine.audition = null;
    // Playback-only override: the song's mute flags are untouched, so nothing can be saved in the audition state.
    engine.audition = { unmute: new Set([c.id]), mute: new Set(overlapping(t, c).map((x) => x.id)) };
    renderTracks(); renderFx();
    const restore = () => { engine.audition = null; renderTracks(); renderFx(); status(`Back to normal — right-click ${c.name} → Keep this take if that was the one.`); };
    const loopWas = engine.loop.enabled; if (loopWas && (c.start < engine.loop.start || c.start >= engine.loop.end)) engine.setLoop({ enabled: false });
    engine.seek(c.start);
    const off = engine.on((ev, data) => { if (ev === 'transport' && !data.playing) { off && off(); if (loopWas && !engine.loop.enabled) engine.setLoop({ enabled: true }); restore(); } });
    play().catch(fail); status(`Listening to ${c.name} alone (Esc stops, everything goes back as it was).`, 0);
  }
  function moveClipToTrack(c, from, to) { if (from === to) return; if (c.kind === 'midi' ? !String(to.instrument).startsWith('synth:') : to.instrument !== 'audio') { status(`${to.name} is a different kind of track.`); return; } change(() => { from.clips = from.clips.filter((x) => x !== c); to.clips.push(c); }, { label: `move ${c.name} to ${to.name}` }); state.selectedTrack = to.id; renderAll(); }
  function trimToLoop(t, c) { if (!engine.loop.enabled) { status('Turn the loop on first.'); return; } const a = Math.max(c.start, engine.loop.start), b = Math.min(clipEnd(c), engine.loop.end); if (b - a < 0.02) { status('The take is outside the loop.'); return; } const full = fullLen(c); change(() => { c.trimStart += a - c.start; c.trimEnd = Math.max(0, full - c.trimStart - (b - a)); c.start = a; }, { label: `trim ${c.name} to loop` }); renderAll(); }
  const referencedIds = () => [...new Set([...engine.tracks.flatMap((t) => t.clips.flatMap((c) => [audioId(c), ...[c.vs, c.ps, c.ps && c.ps.vs].filter((x) => x && x.src).map((x) => x.src)])), ...CB.live(CB.list(state.song, 'ideas')).filter((i) => i.audioId).map((i) => i.audioId)])];
  async function refreshUnreferenced() { if (!state.folder) return; try { state.unreferenced = await bp.song.unreferenced(state.folder, referencedIds()); updateBadges(); } catch (_) {} }

  // one undo step per visit to the notes box, taken at the first keystroke (just clicking in must not wipe Redo)
  let notesUndoTaken = false;
  $('#notes').addEventListener('focus', () => { notesUndoTaken = false; });
  $('#notes').addEventListener('input', () => { if (state.readOnly || state.ab) return; if (!notesUndoTaken) { notesUndoTaken = true; const v = $('#notes').value; $('#notes').value = state.song.notes || ''; pushUndo('notes edit'); $('#notes').value = v; } state.song.notes = $('#notes').value; markDirty(); });

  // ---------- import ----------
  async function importClip({ trackId, arrayBuffer, name, start }) {
    if (tempoBusy) throw new Error('Still re-speeding the takes for the new tempo — try again in a moment.');
    if (!state.folder) throw new Error('no song open');
    if (state.readOnly) throw new Error('song is read-only');
    if (engine.recording) throw new Error('stop recording first');
    if (trackId) { const tt = engine.track(trackId); if (tt && tt.instrument !== 'audio') trackId = null; }   // audio dropped on a drum-machine / synth lane gets its own track
    await engine.init();
    let buf;
    try { buf = await engine.ctx.decodeAudioData(arrayBuffer.slice(0)); } catch (err) { throw new Error(`Could not decode "${name}": ${err.message || 'unsupported format'}`); }
    if (buf.sampleRate !== engine.ctx.sampleRate) {
      const off = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * engine.ctx.sampleRate), engine.ctx.sampleRate);
      const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start(0); buf = await off.startRendering();
    }
    const base = String(name || 'import').replace(/\.[^.]+$/, '').slice(0, 60);
    const chans = window.BPWav.audioBufferToChannels(buf).slice(0, 2);
    if (buf.numberOfChannels > 2) { const b2 = engine.ctx.createBuffer(2, buf.length, buf.sampleRate); chans.forEach((c, i) => b2.copyToChannel(c, i)); buf = b2; }
    const clip = { id: window.BPUtil.newId(), name: base, start: clamp(start, 0, 1e6, 0), gainDb: 0, trimStart: 0, trimEnd: 0, duration: buf.duration, channels: chans.length, takenBy: state.settings.identity.user, takenAt: new Date().toISOString(), mute: false };
    await bp.audio.write(state.folder, clip.id, window.BPWav.encodeWav(chans, buf.sampleRate, 24), { label: takeLabel(engine.track(trackId) || { name: base }, clip) });
    engine.buffers.set(clip.id, buf);
    let t = engine.track(trackId);
    pushUndo('import audio'); logActivity(`imported ${base}`);
    if (!t) t = engine.addTrack(base);
    t.clips.push(clip);
    state.selectedTrack = t.id; state.selectedClip = clip.id;
    renderAll();
    await saveWithClip(t.id, clip, t.name);
    return { trackId: t.id, clip };
  }
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  // Audio files dropped anywhere outside the track lanes become new tracks (one per file) at the playhead's bar.
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((f) => /\.(wav|mp3|m4a|aac|ogg|flac|aif|aiff|webm)$/i.test(f.name) || /^audio\//.test(f.type));
    if (!files.length || e.target.closest && e.target.closest('#tracks')) return;
    if (!state.folder) { status('Open a song first, then drop the audio files on it.'); return; }
    importFilesAsTracks(files, floorBar(engine.playhead)).catch(fail);
  });
  async function importFilesAsTracks(files, at = 0) {
    if (ro()) { status('Read-only — take over to add tracks.'); return; }
    let n = 0, ok = 0; const bad = [];
    for (const f of files) { status(`Importing ${f.name} (${++n}/${files.length})…`, 0); try { await importClip({ trackId: null, arrayBuffer: await f.arrayBuffer(), name: f.name, start: at }); ok++; } catch (err) { bad.push(f.name); fail(err); } }   // one bad file doesn't stop the rest
    status('');
    if (!ok) return;
    toast(`Imported ${ok} file${ok > 1 ? 's' : ''}${bad.length ? ` (skipped ${bad.join(', ')})` : ''} as ${ok > 1 ? 'new tracks' : 'a new track'} at ${posLabel(at)}. Drag a take sideways to line it up; drop a file on a track's lane to add it to that track.`, { kind: 'ok', ms: 9000 });
    maybeAutoKey();
  }
  { const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.aif,.aiff'; inp.hidden = true; document.body.append(inp);
    inp.addEventListener('change', () => { const files = [...inp.files]; inp.value = ''; if (files.length) importFilesAsTracks(files, state.importAt || 0).catch(fail); });
    window.pickAudioFiles = (at = 0) => { state.importAt = at; inp.click(); }; }
  tracksEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  tracksEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const row = e.target.closest('.track'); const lane = e.target.closest('.lane');
    const trackId = row ? row.dataset.id : null;
    const start = lane ? Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / state.pxPerSec) : engine.playhead;
    for (const f of e.dataTransfer.files) { try { await importClip({ trackId, arrayBuffer: await f.arrayBuffer(), name: f.name, start }); } catch (err) { fail(err); } }
    maybeAutoKey();
  });

  // ---------- bounces ----------
  function renderBounces() {
    const ul = $('#bounce-list'); ul.innerHTML = '';
    for (const b of state.bounces.slice(0, 20)) {
      if (b.dir) { const li = el('li', 'bounce-row'); const nm = el('span', 'bname', `📁 ${b.name.replace(new RegExp(`^${state.song ? state.song.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''} ?- ?`), '')}`); nm.title = b.path; const show = el('button', null, 'open'); show.addEventListener('click', () => bp.shell.showInFolder(b.path)); li.append(nm, show); M.attach(li, () => bounceMenu(b)); ul.appendChild(li); continue; }
      const li = el('li', 'bounce-row'); const short = b.name.replace(/\.wav$/i, '').replace(new RegExp(`^${state.song ? state.song.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''} ?`), '').replace(/^- /, '').replace(/(\d{4})-(\d\d)-(\d\d) (\d\d)(\d\d)\d\d/, '$2/$3 $4:$5'); const nm = el('span', 'bname', short || b.name); nm.title = `${b.name}\n${b.path}`;
      const play = el('button', null, '▶'); play.title = 'Play this bounce (the finished audio file) so you can check it. Press again to stop.'; play.addEventListener('click', () => previewBounce(b, play).catch(fail));
      const show = el('button', null, 'folder'); show.title = 'Show this file in its folder on your computer, so you can attach it to a message or copy it somewhere.'; show.addEventListener('click', () => bp.shell.showInFolder(b.path));
      const copy = el('button', null, 'copy msg'); copy.title = 'Copy a ready-made message saying where this bounce is in the band folder — paste it in the group chat.'; copy.addEventListener('click', () => navigator.clipboard.writeText(`"${state.song.name}" bounce is in the band folder: ${state.song.name}/bounces/${b.name}`).then(() => { status('Copied.'); toast('Copied — paste it in the group chat.', { kind: 'ok', ms: 2500 }); }));
      li.append(play, nm, show, copy); M.attach(li, () => bounceMenu(b)); ul.appendChild(li);
    }
    if (!state.bounces.length) ul.appendChild(el('li', 'muted', 'none yet — "Bounce mix" makes a WAV of the whole song here'));
  }
  let preview = null;
  function stopPreview() { if (!preview) return; const p = preview; preview = null; p.audio.pause(); p.btn.textContent = '▶'; clearInterval(p.timer); status('Stopped listening.'); }
  async function previewBounce(b, btn) {
    if (preview && preview.path === b.path) { stopPreview(); return; }
    stopPreview();
    if (engine.playing) { const back = engine.startPos; engine.stop(); engine.playhead = back; positionPlayhead(); }
    const ab = await bp.audio.readFile(b.path); const url = URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
    const audio = new Audio(url); audio.addEventListener('ended', () => { if (preview && preview.audio === audio) { stopPreview(); } URL.revokeObjectURL(url); });
    preview = { path: b.path, audio, btn, timer: null }; btn.textContent = '■';
    preview.timer = setInterval(() => { if (preview && preview.audio === audio) status(`Listening to ${b.name} — ${Math.floor(audio.currentTime)} / ${Math.floor(audio.duration || 0)} s (Esc or ■ stops)`, 0); }, 500);
    await audio.play();
  }
  // the song's chart (chords over words) — whole song, or one stretch
  function songChart({ from, to, title } = {}) { return window.BPChart.chart(collectSong(), { from, to, title: title || state.song.name, linkInfo: TPL.linkInfo, fmtTime: (t) => fmtBar(t) }); }
  // Share one part: its mix (with a bar of ring-out) + chart (words, chords, open notes) in bounces/, message copied
  async function sharePart(s, { copy = true } = {}) {
    if (!state.folder) throw new Error('no song open');
    if (engine.recording) throw new Error('stop recording first');
    if (state.missingClips.size) throw new Error(`${state.missingClips.size} take(s) haven't synced in yet — the bounce would be missing them.`);
    await engine.init(); stopPractice(); if (engine.playing) engine.stop();
    const tail = Math.min(barLenAt(s.end - 1e-3), 3); status(`Rendering ${s.name}…`, 0);
    const r = await engine.render({ from: s.start, to: s.end + tail, exact: true });
    const stamp = await bp.bounce.stamp(); const folderName = `${state.song.name} - ${s.name} ${stamp}`;
    const chart = songChart({ from: s.start, to: s.end, title: `${state.song.name} — ${s.name}` });
    const nm = `${safeFile(`${state.song.name} - ${s.name}`)}.wav`;
    const written = await bp.bounce.exportWrite(state.folder, folderName, [{ path: nm, data: window.BPWav.encodeWav(r.channels, r.sampleRate, 24) }, { path: 'chart.txt', data: chart }]);
    state.bounces = await bp.bounce.list(state.folder); renderBounces();
    const msg = `${s.name} of "${state.song.name}" (${fmtBar(s.start)}–${fmtBar(s.end)}, ${Math.round(s.end - s.start)} s) is in the band folder: ${state.song.name}/bounces/${folderName}/\n\n${chart}`;
    if (copy) { try { await navigator.clipboard.writeText(msg); } catch (_) {} }
    logActivity(`shared ${s.name}`);
    toast(`${s.name} bounced with its chart → bounces/${folderName}.${copy ? ' Message + chart copied for the group chat.' : ''}`, { kind: 'ok', ms: 15000, buttons: [['Open folder', () => { const p0 = written && written.files && written.files[0]; if (p0) bp.shell.showInFolder(p0); }]] });
    return { folder: folderName, chart };
  }
  async function bounce(what, baseName, { allowMissing = false } = {}) {
    if (!state.folder) throw new Error('no song open');
    if (engine.recording) throw new Error('stop recording first');
    if (!engine.contentLength()) throw new Error('nothing to bounce');
    if (state.missingClips.size && !allowMissing) throw new Error(`${state.missingClips.size} take(s) have not synced in yet; the bounce would be missing them. Wait, or pass allowMissing.`);
    const out = [];
    const stamp = await bp.bounce.stamp();
    if (what === 'stems') {
      for (const t of engine.tracks) { if (!t.clips.length && t.instrument !== 'drumkit') continue; status(`Rendering stem: ${t.name}…`, 0); const r = await engine.render({ soloTrackId: t.id, limiter: false }); out.push(await bp.bounce.write(state.folder, `${baseName || state.song.name} - ${t.name}`, window.BPWav.encodeWav(r.channels, r.sampleRate, 24), { stamp })); }
    } else {
      status('Rendering mix…', 0); const r = await engine.render(); out.push(await bp.bounce.write(state.folder, baseName || `${state.song.name} mix`, window.BPWav.encodeWav(r.channels, r.sampleRate, 24), { stamp }));
    }
    state.bounces = await bp.bounce.list(state.folder); renderBounces();
    const names = out.map((p) => String(p).split(/[\\/]/).pop());
    status(`Bounced ${out.length} file(s) to bounces/`);
    const songDir = `${state.song.name}/bounces/`;
    const msg = what === 'stems' ? `Stems for "${state.song.name}" are in the band folder: ${songDir} (${names.length} files, ${stamp})` : `New mix of "${state.song.name}" is in the band folder: ${songDir}${names[0]}`;
    toast(what === 'stems' ? `${names.length} stem${names.length === 1 ? '' : 's'} saved to the band folder (${songDir}). Drive will sync ${names.length === 1 ? 'it' : 'them'} to everyone.` : `Mix saved to the band folder: ${names[0]}. Drive will sync it to everyone.`, { kind: 'ok', ms: 30000, buttons: [['Open folder', () => bp.shell.showInFolder(out[0])], ['Copy message for the group chat', () => navigator.clipboard.writeText(msg).then(() => { status('Copied.'); toast('Copied — paste it in the group chat.', { kind: 'ok', ms: 2500 }); })]] });
    return out;
  }
  $('#btn-bounce').addEventListener('click', () => bounce('mix').catch(fail));
  // ---- song header menus: Share ▾ (everything that leaves Cobander) and ⋯ (housekeeping) ----
  const menuAt = (btn, items) => { const r = btn.getBoundingClientRect(); M.show(Math.min(r.left, window.innerWidth - 300), r.bottom + 4, items); };
  $('#btn-share').addEventListener('click', () => {
    const t = engine.playhead; const sc = state.song ? CB.sectionAt(state.song, t) : null;
    menuAt($('#btn-share'), [{ title: 'Share' },
      { label: '🥡 Bounce the mix (WAV in bounces/)', action: () => bounce('mix').catch(fail) },
      { label: '🍜 Bounce stems (one file per instrument)', action: () => bounce('stems').catch(fail) },
      { label: sc ? `Share ${sc.name} — mix + chart` : 'Share a part — mix + chart', hint: 'for the group chat', sub: liveSections().map((x) => ({ label: x.name, action: () => sharePart(x).catch(fail) })), disabled: !liveSections().length },
      { label: 'Copy the chord chart', action: () => navigator.clipboard.writeText(chartText(0)).then(() => status('Chart copied.')).catch(fail) },
      'sep',
      { label: 'Hand off to a DAW…', hint: 'REAPER project, MIDI, stems, takes', action: () => exportDaw({}).catch(fail) },
      'sep',
      { label: '📱 Open on your phone…', hint: 'lyrics + chords, live, on home Wi-Fi', action: () => openPhoneLink().catch(fail) }]);
  });
  $('#btn-more').addEventListener('click', () => {
    const nDel = state.song ? deletedTakesList().length : 0;
    menuAt($('#btn-more'), [{ title: state.song ? state.song.name : 'Song' },
      { label: 'Show the song folder', action: () => $('#btn-open-folder').click() },
      { label: nDel ? `Deleted takes (${nDel}) — restore…` : 'Deleted takes: none', action: () => recoverTakes().catch(fail), disabled: !nDel || state.readOnly },
      { label: '🥣 Lighten the folder… (FLAC + clear unused audio)', action: () => compactDrive().catch(fail) },
      { label: `Clear parked takes…${state.unreferenced && state.unreferenced.length ? ` (${state.unreferenced.length}, ${mb(state.unreferenced.reduce((n, u) => n + (u.size || 0), 0))})` : ''}`, hint: 'audio nothing in this song uses', action: () => clearParked().catch(fail), disabled: state.readOnly || !(state.unreferenced && state.unreferenced.length) },
      'sep',
      { label: 'What the words mean (glossary)', hint: 'F1', action: showGlossary }, { label: 'Keyboard shortcuts', hint: '?', action: showShortcuts }]);
  });
  // key chip: the song's key, set / detect / transpose from one place
  $('#key-chip').addEventListener('click', () => {
    if (!state.song) { status('Open a song first.'); return; }
    const d = state.keyDoubt;
    menuAt($('#key-chip'), [{ title: `Key${state.song.key ? `: ${state.song.key}${state.song.keySource && state.song.keySource !== 'set' ? ` (${state.song.keySource})` : ''}` : ' — not set'}` },
      ...(d ? [{ label: `⚠ The bass line says ${d.key} — set it`, action: () => setSongKey(d.key, 'bass line'), disabled: state.readOnly }, { label: 'Not now', action: () => { state.keyDoubt = null; renderKeyChip(); } }, 'sep'] : []),
      { label: 'Detect from the tracks', hint: 'guitar, bass, keys, vocals', action: () => detectSongKey().catch(fail), disabled: state.readOnly },
      { label: 'Transpose the song', hint: 'moves the recordings, MIDI and chords', sub: transposeItems(null), disabled: state.readOnly },
      'sep', { title: 'Set the label only — nothing moves' },
      ...window.BPTemplates.KEYS.map((k) => ({ label: k || 'no key', checked: (state.song.key || '') === k, action: () => setSongKey(k), disabled: state.readOnly }))]);
  });
  function renderKeyChip() {
    const c = $('#key-chip'); if (!c) return; const k = state.song && state.song.key; const d = state.keyDoubt;
    c.textContent = `key ${k || '–'}${d ? ' ⚠' : ''}`; c.classList.toggle('muted', !k); c.classList.toggle('doubt', !!d);
    c.title = d ? `The bass line says ${d.key}${k ? `, not ${k}` : ''} — click to fix` : 'Song key — click to set or detect it';
  }
  $('#btn-stems').addEventListener('click', () => exportDaw({}).catch(fail));

  // ---------- DAW hand-off: REAPER project + MIDI file + stems + raw takes + README, in one folder ----------
  const safeFile = (n) => String(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'track';
  async function exportDaw({ what = 'all', name = null, allowMissing = false } = {}) {
    if (!state.folder) throw new Error('no song open');
    if (engine.recording) throw new Error('stop recording first');
    await engine.init();
    const len = engine.contentLength(); if (!len) throw new Error('nothing to export yet');
    if (state.missingClips.size && !allowMissing) throw new Error(`${state.missingClips.size} take(s) have not synced in yet — wait for them, or the export would be missing audio.`);
    const stamp = await bp.bounce.stamp();
    const folderName = name || `${state.song.name} - DAW export ${stamp}`;
    const song = collectSong(); const E = window.BPDawExport;
    const stems = [], takes = []; const used = new Set();
    const uniq = (base) => { let n = base, i = 2; while (used.has(n.toLowerCase())) n = `${base} (${i++})`; used.add(n.toLowerCase()); return n; };
    const put = (files) => bp.bounce.exportWrite(state.folder, folderName, files);
    const stop = () => { if (engine.playing) engine.stop(); };
    stop();
    const doStems = what === 'all' || what === 'stems' || what === 'reaper';
    if (doStems) {
      for (const t of engine.tracks) {
        if (!t.clips.length && t.instrument !== 'drumkit') continue;
        status(`Rendering stem: ${t.name}…`, 0);
        const r = await engine.render({ soloTrackId: t.id, from: 0, to: len, limiter: false, exact: true });
        const p = `stems/${uniq(safeFile(t.name))}.wav`;
        await put([{ path: p, data: window.BPWav.encodeWav(r.channels, r.sampleRate, 24) }]);
        stems.push({ trackId: t.id, path: p, seconds: r.channels[0].length / r.sampleRate });
      }
      status('Rendering mix…', 0);
      const mix = await engine.render({ from: 0, to: len, exact: true });
      await put([{ path: 'mix.wav', data: window.BPWav.encodeWav(mix.channels, mix.sampleRate, 24) }]);
      const copied = new Map();
      for (const t of engine.tracks) for (const c of t.clips) {
        const a = audioId(c); if (c.kind === 'midi' || state.missingClips.has(a)) continue;
        if (!copied.has(a)) { const ext = /\.flac$/i.test(String(await bp.audio.path(state.folder, a).catch(() => '') || '')) ? 'flac' : 'wav'; const p = `takes/${safeFile(takeLabel(t, c))} - ${a}.${ext}`; try { await put([{ path: p, copyTake: a }]); copied.set(a, p); } catch (_) { continue; } }
        takes.push({ clipId: c.id, path: copied.get(a) });
      }
    }
    const files = [];
    const lyricLines = window.BPKaraoke.lines(song, { linkInfo: TPL.linkInfo }); const chart = chartText(0);
    const hasMidi = lyricLines.length > 0 || liveSections().length > 0 || engine.tracks.some((t) => (t.instrument === 'drumkit' && t.drum) || (String(t.instrument).startsWith('synth:') && t.clips.some((c) => c.kind === 'midi')));
    if ((what === 'all' || what === 'reaper') && doStems) files.push({ path: `${safeFile(folderName)}.rpp`, data: E.reaperProject({ song, tracks: engine.tracks, stems, takes, clipLength: (c) => engine.clipLength(c), sampleRate: engine.ctx.sampleRate, meter: meter() }) });
    if ((what === 'all' || what === 'midi' || what === 'reaper') && hasMidi) {
      const bar = engine.beatLen() * engine.timeSig[0];
      const drumEventsFor = (t) => window.BPSynth.drumEvents(t.drum, window.BPPresets.DRUM_PATTERNS, engine.bpm, engine.timeSig, 0, t.drum.bars ? (t.drum.offsetBars + t.drum.bars) * bar : len);
      files.push({ path: `${safeFile(folderName)}.mid`, data: E.midiFile({ song, tracks: engine.tracks, beatLen: engine.beatLen(), drumEventsFor, contentLength: len, meter: meter(), lyricLines }) });
    }
    files.push({ path: 'README.txt', data: E.readme({ song, tracks: engine.tracks, stems, takes, hasMidi, folderName: safeFile(folderName), chart }) });
    if (chart.trim()) files.push({ path: 'chart.txt', data: chart });
    const r = await put(files);
    state.bounces = await bp.bounce.list(state.folder); renderBounces();
    status(`Exported to bounces/${folderName}`);
    const msg = `"${state.song.name}" is ready for your DAW in the band folder: ${state.song.name}/bounces/${folderName}/ — open the .rpp in REAPER, or drop stems/ into anything else at bar 1 (README.txt explains).`;
    toast(`DAW hand-off saved to the band folder: ${folderName}. REAPER project${hasMidi ? ', MIDI file' : ''}, ${stems.length} stems, ${new Set(takes.map((x) => x.path)).size} raw takes, README.`, { kind: 'ok', ms: 30000, buttons: [['Open folder', () => bp.shell.showInFolder(r.folder)], ['Copy message for the group chat', () => navigator.clipboard.writeText(msg).then(() => { status('Copied.'); toast('Copied — paste it in the group chat.', { kind: 'ok', ms: 2500 }); })]] });
    return { folder: r.folder, stems: stems.length, takes: takes.length, midi: hasMidi, reaper: files.some((f) => f.path.endsWith('.rpp')) };
  }

  // ---------- transport ----------
  async function play() { stopPreview(); stopPractice(); await engine.init(); meter(); engine.play(); }
  // Stop (■ / Esc) goes back to where playback started, like every DAW; Space while playing pauses in place.
  async function stop() { stopPreview(); if (engine.recording) return finishRecording(); const back = engine.playing ? engine.startPos : null; engine.stop(); if (back != null) engine.playhead = back; positionPlayhead(); }
  let inputIdleTimer = null;
  // Release the mic ~20 s after the last take / monitoring / sketch (AirPods leave phone-quality headset mode).
  function scheduleInputRelease() { clearTimeout(inputIdleTimer); inputIdleTimer = setTimeout(() => { if (!engine.recording && !engine.monitorInput && !sketchRec && !finishing) engine.closeInput(); }, 20000); }
  async function ensureInput() {
    await engine.init();
    clearTimeout(inputIdleTimer);
    if (engine.inputAlive()) return;
    if (engine.recNode) engine.closeInput();   // stream died (device unplugged / Bluetooth dropped): reopen
    try {
      const granted = await bp.mic.ensure();
      if (granted === false) throw new Error(bp.platform === 'darwin' ? 'microphone access is off for Cobander — System Settings → Privacy & Security → Microphone → turn on Cobander, then restart it' : 'microphone access was denied');
      await engine.openInput(state.settings.inputDeviceId);
      if (engine.inputFallback) toast('Your saved input isn\'t connected — recording from the system default input instead. Pick another in Settings if that\'s wrong.', { kind: '', ms: 9000 });
    }
    catch (err) { throw new Error(`Could not open the audio input (${err.message}). On Windows check Settings → Privacy → Microphone → "Let desktop apps access your microphone"; on macOS allow Cobander under Privacy & Security → Microphone.`); }
  }
  async function record(trackIdArg) {
    if (!state.folder) throw new Error('no song open');
    if (engine.recording) return;
    if (finishing) throw new Error('Still saving the last take — one second.');
    if (tempoBusy) { status('Still re-speeding the takes for the new tempo — one moment.'); return; }
    stopPractice();
    // recording in a linked copy is fine: the take moves to the room when it's done (TPL.carveFollowers), so every copy plays it
    if (state.ab) { await leaveAB({ silent: true }); status('Left A/B — recording into the current song.'); }   // never record into the version being auditioned
    await engine.init();
    let trackId = trackIdArg || state.armedTrack;
    if (trackId && !engine.track(trackId)) throw new Error(`no track ${trackId}`);
    if (!trackId) {
      if (trackIdArg === undefined && !engine.tracks.length) { const kind = await pickTrackKind(); if (!kind) return; const t = addTrackOfKind(kind); if (!t) return; if (TRACK_KINDS[kind] ? !TRACK_KINDS[kind].arm : t.instrument === 'drumkit') { status('Drum machine tracks play their pattern; add a mic/guitar track to record.'); return; } trackId = t.id; }
      else { const selT = engine.track(state.selectedTrack); if (selT && selT.instrument !== 'drumkit') { trackId = selT.id; state.armedTrack = trackId; renderTracks(); status(`Recording onto ${selT.name} (the selected track). Arm another track with ● to record there.`); } else { status('Arm a track first (its ● button) — or click a track to select it, then R.', 7000); return; } }
    }
    const track = engine.track(trackId);
    if (!mineT(track.id)) { const h = heldBy(track.id); if (h) status(`${h} has ${track.name} unlocked — record on a track you've unlocked.`, 7000); else lockNudge(track.id); return; }
    const isMidi = track.instrument !== 'audio';
    if (track.instrument === 'drumkit') throw new Error('The drum machine plays its pattern; nothing to record. Switch the track source to a synth to record MIDI, or audio to record a mic.');
    if (isMidi) { await engine.initMidi(); if (!engine.midi.selectedId) engine.selectMidiInput('any'); }
    else await ensureInput();
    clearTimeout(state.autosaveTimer);
    if (state.pendingExternal && state.pendingExternal.conflict) throw new Error('Resolve the save conflict (banner) before recording.');
    if (state.dirty) { const r = await save(); if (r !== 'ok') throw new Error('Could not save your changes before recording — resolve the banner first.'); }
    // punch in/out: one bar of pre-roll before the loop range (it replaces the count-in), auto-stop just after it
    const punch = !isMidi && $('#punch-on').checked && engine.loop.end > engine.loop.start + 0.25 ? { a: engine.loop.start, b: engine.loop.end, loopWas: engine.loop.enabled, countWas: engine.click.countIn } : null;
    if (punch) { engine.setLoop({ enabled: false }); engine.click.countIn = false; engine.seek(Math.max(0, punch.a - barLenAt(punch.a))); }
    try { if (isMidi) await engine.recordMidi(trackId); else await engine.record(trackId); }
    finally { if (punch) { engine.click.countIn = punch.countWas; if (!engine.recording) engine.setLoop({ enabled: punch.loopWas }); } }
    if (punch && engine.recording) { engine.recording.punch = punch; watchPunch(engine.recording); }
    if (engine.recording && !isMidi) crashGuardStart(engine.recording);
    renderTracks(); showCountIn();
    status(punch ? `Punch recording ${fmtBar(punch.a)} – ${fmtBar(punch.b)} — stops by itself (Space/R stops now).` : isMidi ? 'Recording MIDI — play your keyboard. Space/R to stop.' : 'Recording — Space/R to stop.', 0);
  }
  // ---- crash-safe recording: stream the raw input to this computer's app data every second while recording ----
  const liveGuards = new Set();   // crash copies of takes recording / waiting to be written right now
  function crashGuardStart(rec) {
    if (!bp.rec) return null;
    const id = window.BPUtil.newId(); liveGuards.add(id); const t = engine.track(rec.trackId);
    const g = { id, q: rec.chunks.slice(), dead: false, chain: Promise.resolve(), timer: null };
    rec._crash = g;
    const meta = { folder: state.folder, song: state.song && state.song.name, trackId: rec.trackId, trackName: t ? t.name : null, startPos: rec.startPos, startFrame: rec.startFrame, startCtxTime: rec.startCtxTime, sampleRate: rec.sampleRate || engine.ctx.sampleRate, offsetMs: rec.offsetMs || 0, loop: rec.loopRec ? { start: rec.loopRec.start, end: rec.loopRec.end } : null, punch: rec.punch ? { a: rec.punch.a, b: rec.punch.b } : null, who: me(), at: new Date().toISOString() };
    g.chain = bp.rec.begin(id, meta).catch(() => { g.dead = true; });
    engine.onRecChunk = (r, chunk) => { if (r === rec && !g.dead) g.q.push(chunk); };
    const flush = () => {
      if (g.dead || !g.q.length) return; const q = g.q; g.q = [];
      const nch = q[0].length, n = q.reduce((k, c) => k + c[0].length, 0); const chans = [];
      for (let c = 0; c < nch; c++) { const a = new Float32Array(n); let o = 0; for (const ch of q) { a.set(ch[c] || new Float32Array(ch[0].length), o); o += ch[0].length; } chans.push(a); }
      g.chain = g.chain.then(() => (g.dead ? null : bp.rec.append(id, chans))).catch(() => {});
    };
    g.timer = setInterval(flush, 1000); g.flush = flush;
    return g;
  }
  // the take is safely in the shared folder (or deliberately thrown away): forget the crash copy
  function crashGuardEnd(g) {
    if (!g) return; clearInterval(g.timer); if (engine.onRecChunk) engine.onRecChunk = null;
    if (g.dead) return; g.dead = true; g.q = []; liveGuards.delete(g.id);
    g.chain = g.chain.then(() => bp.rec.end(g.id)).catch(() => {});
  }
  // stopped but not yet on Drive: write what's buffered and keep the copy until the take is written
  function crashGuardHold(g) { if (!g || g.dead) return; clearInterval(g.timer); if (g.flush) g.flush(); if (engine.onRecChunk) engine.onRecChunk = null; }
  async function checkCrashRecordings() {
    if (!bp.rec) return;
    let list = []; try { list = await bp.rec.list(); } catch (_) { return; }
    const held = new Set([...liveGuards, ...[...state.pendingTakes.values()].map((p) => p.crash), ...((state.backup && state.backup.takes) || []).map((t) => t.crash)].filter(Boolean));
    for (const m of list) {
      if (held.has(m.id)) continue;   // still recording / waiting to be written / in the unsaved-changes backup
      if (!(m.seconds > 0.3)) { bp.rec.end(m.id).catch(() => {}); continue; }
      if (state.folder && m.folder === state.folder) {
        toast(`A recording on ${m.trackName || 'a track'} (${Math.round(m.seconds)} s, ${new Date(m.at).toLocaleString()}) was interrupted before it was saved. It's safe on this computer.`, { kind: 'warn', ms: 0, buttons: [['Recover the take', () => recoverCrash(m)], ['Throw it away', async () => { await bp.rec.end(m.id); status('Interrupted recording discarded.'); }]] });
      } else if (!state.folder) status(`An interrupted recording in "${m.song || m.folder}" is waiting — open that song to recover it.`, 12000);
    }
  }
  async function recoverCrash(m) {
    if (state.readOnly) throw new Error('Take over the song first, then recover the take.');
    const { meta, channels } = await bp.rec.read(m.id); await engine.init();
    const sr = meta.sampleRate; let chans = channels.map((b) => new Float32Array(b)); const total = Math.min(...chans.map((c) => c.length));
    let drop = Math.round(meta.startCtxTime * sr) - meta.startFrame + Math.round((meta.offsetMs || 0) / 1000 * sr); let start = meta.loop ? meta.loop.start : meta.startPos;
    if (drop < 0) { start += -drop / sr; drop = 0; }
    if (drop >= total - sr * 0.1) { await bp.rec.end(m.id); throw new Error('That recording stopped during the count-in — nothing to recover.'); }
    chans = chans.map((c) => c.subarray(drop, total));
    if (chans.length === 2) { const pk = chans.map((b) => { let p = 0; for (let i = 0; i < b.length; i += 4) p = Math.max(p, Math.abs(b[i])); return p; }); if (pk[1] <= 1e-4 && pk[0] > 1e-4) chans = [chans[0]]; else if (pk[0] <= 1e-4 && pk[1] > 1e-4) chans = [chans[1]]; }
    let t = engine.track(meta.trackId); if (!t || t.instrument !== 'audio') { t = engine.addTrack(`Recovered${meta.trackName ? ` (${meta.trackName})` : ''}`); }
    // a loop recording comes back as one take per pass (like a normal loop take); the last complete pass plays
    const len = chans[0].length; const segs = [];
    if (meta.loop && meta.loop.end > meta.loop.start) { const lf = Math.round((meta.loop.end - meta.loop.start) * sr); for (let k = 0; k * lf < len; k++) { const a0 = k * lf, b0 = Math.min(len, (k + 1) * lf); if (k > 0 && b0 - a0 < lf / 2) break; segs.push({ a0, b0, full: b0 - a0 >= lf - 1 }); } }
    else segs.push({ a0: 0, b0: len, full: true });
    const made = []; let n = nextTakeNumber(t);
    for (const sg of segs) {
      const part = chans.map((c) => c.subarray(sg.a0, sg.b0)); const buf = engine.ctx.createBuffer(part.length, part[0].length, sr); part.forEach((c, i) => buf.copyToChannel(c, i));
      let clip = { id: window.BPUtil.newId(), name: `take ${n++} (recovered)`, start, gainDb: 0, trimStart: 0, trimEnd: 0, duration: buf.duration, channels: part.length, mute: true, fadeIn: 0, fadeOut: 0, takenBy: meta.who || me(), takenAt: meta.at };
      engine.buffers.set(clip.id, buf);
      if (meta.punch) { const p = window.BPComp.punchTrim(clip, buf.duration, meta.punch.a, meta.punch.b); if (p) clip = p; }
      await bp.audio.write(state.folder, clip.id, window.BPWav.encodeWav(part, sr, 24), { label: takeLabel(t, clip) });
      made.push({ clip, full: sg.full });
    }
    const hero = ((made.filter((x) => x.full).pop()) || made[made.length - 1]).clip; const clip = hero;
    pushUndo('recover take'); for (const x of made) t.clips.push(x.clip);
    hero.mute = t.clips.some((c) => !made.some((x) => x.clip === c) && !c.mute && c.start < clipEnd(hero) && clipEnd(c) > hero.start);
    logActivity(`recovered an interrupted take on ${t.name}`);
    state.dirty = true; state.selectedClip = hero.id; renderAll();
    await save(); await bp.rec.end(m.id);
    toast(`Recovered ${made.length > 1 ? `${made.length} loop passes (${clip.name} plays)` : clip.name} on ${t.name}${clip.mute ? ' (muted, because another take plays there — right-click → Keep this take)' : ''}.`, { kind: 'ok', ms: 10000 });
  }
  // ---- tuner: YIN on the live input, with the armed track's tuning when it's a bass ----
  const TUNINGS = { guitar: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'], bass: ['B0', 'E1', 'A1', 'D2', 'G2'] };
  let tunerRun = null;
  async function openTuner() {
    const d = $('#tuner'); if (d.open) return;
    const hadInput = engine.inputAlive && engine.inputAlive();   // the tuner opened the mic → it closes it again on Done
    await ensureInput(); await engine.resume();
    const an = engine.ctx.createAnalyser(); an.fftSize = 4096; engine.inputSource.connect(an);
    const buf = new Float32Array(an.fftSize); let hist = [];
    try { const v = Number(localStorage.getItem('bp.a4')); if (v >= 415 && v <= 466) $('#tu-a4').value = String(v); } catch (_) {}
    const tr = engine.track(state.armedTrack || state.selectedTrack); const kind = tr && /bass/i.test(`${tr.name} ${tr.preset || ''}`) ? 'bass' : 'guitar';
    $('#tu-strings').innerHTML = ''; for (const n of TUNINGS[kind]) { const sp = el('span', null, n); sp.dataset.n = n; $('#tu-strings').append(sp); }
    let last = 0;
    const loop = (ts) => {
      if (!d.open) return;
      tunerRun = requestAnimationFrame(loop);
      if (ts - last < 80) return; last = ts;
      clearTimeout(inputIdleTimer);
      an.getFloatTimeDomainData(buf);
      const r = window.BPTuner.detect(buf, engine.ctx.sampleRate);
      if (!r || r.clarity < 0.8) { hist = []; return; }
      hist.push(r.freq); if (hist.length > 5) hist.shift();
      const f = hist.slice().sort((a, b) => a - b)[Math.floor(hist.length / 2)];
      const a4 = Number($('#tu-a4').value) || 440; const nt = window.BPTuner.note(f, a4);
      $('#tu-name').textContent = nt.name; $('#tu-oct').textContent = String(nt.octave);
      $('#tu-cents').textContent = nt.cents === 0 ? 'in tune' : `${nt.cents > 0 ? '+' : ''}${nt.cents} cents ${nt.cents > 0 ? '(sharp)' : '(flat)'}`; $('#tu-hz').textContent = ` · ${f.toFixed(1)} Hz`;
      $('#tu-needle').style.left = `${50 + Math.max(-50, Math.min(50, nt.cents))}%`;
      $('.tu-note').classList.toggle('in', Math.abs(nt.cents) <= 3);
      for (const sp of $('#tu-strings').children) sp.classList.toggle('hit', sp.dataset.n === `${nt.name}${nt.octave}` && Math.abs(nt.cents) <= 3);
    };
    d.returnValue = ''; d.showModal(); tunerRun = requestAnimationFrame(loop);
    d.addEventListener('close', () => { cancelAnimationFrame(tunerRun); try { engine.inputSource && engine.inputSource.disconnect(an); } catch (_) {} try { localStorage.setItem('bp.a4', $('#tu-a4').value); } catch (_) {}
      // Done = stop listening: the mic the tuner opened is closed right away (unless a take or monitoring needs it); one someone else opened goes back on the idle timer
      if (!hadInput && !engine.recording && !engine.monitorInput && !sketchRec && !finishing) engine.closeInput(); else scheduleInputRelease(); }, { once: true });
  }
  $('#btn-tuner').addEventListener('click', () => openTuner().catch(fail));
  // ---- what changed since I last opened this song ----
  async function songAsOf(iso) {   // the save that was current at `iso` (from history/), or null
    let hist = []; try { hist = await bp.song.listHistory(state.folder); } catch (_) { return null; }
    for (let i = hist.length - 1, n = 0; i >= 0 && n < 60; i--, n++) { let h; try { h = await bp.song.readHistory(state.folder, hist[i].saveId); } catch (_) { continue; } if (h && h.savedAt && String(h.savedAt) <= iso) return h; }
    return null;
  }
  async function computeChanges(since = state.lastSeenAtOpen) {
    if (!state.folder || !since) return null;
    const old = await songAsOf(since);
    return window.BPChanges.summarize(old, collectSong(), { since, me: me() });
  }
  async function showWhatChanged() {
    const r = await computeChanges(); if (!r || !r.any) return null;
    state.freshClips = new Set(r.freshClips.map((c) => c.id)); state.changes = r; renderTracks();
    const when = new Date(r.since); const ago = timeAgo(r.since);
    const first = r.freshClips[0]; const lyr = r.lyrics[0];
    const btns = [];
    if (first) btns.push([`Hear the new take${r.freshClips.length > 1 ? 's' : ''}`, async () => { engine.seek(Math.max(0, first.start - 0.5)); positionPlayhead(); state.selectedClip = first.id; state.selectedTrack = first.trackId; renderAll(); await play(); }]);
    if (r.lyrics.length || r.chords.length) btns.push(['What changed in the words?', async () => { await ask('Changed since you were here', [...r.lyrics.map((x) => `${x.part} — words\n  was: ${x.before || '(none)'}\n  now: ${x.after || '(none)'}`), ...r.chords.map((x) => `${x.part} — chords\n  was: ${x.before || '(none)'}\n  now: ${x.after || '(none)'}`)].join('\n\n'), [['OK', '', 'primary']]); if (lyr && lyr.sectionId) { const x = liveSections().find((y) => y.id === lyr.sectionId); if (x) { engine.seek(x.start); positionPlayhead(); } } }]);
    toast(`Since you were here (${ago}, ${when.toLocaleDateString(undefined, { weekday: 'short' })} ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}): ${window.BPChanges.text(r)}`, { kind: 'ok', ms: 30000, buttons: btns });
    return r;
  }
  function watchPunch(rec) {
    const tick = () => { if (engine.recording !== rec) return; if (engine.playhead >= rec.punch.b + 0.25) { finishRecording().catch(fail); return; } setTimeout(tick, 30); };
    tick();
  }
  // Big on-screen count-in numbers, derived from the exact scheduled start so they match the clicks.
  function showCountIn() {
    const rec = engine.recording; const box = $('#countin'); if (!rec || !engine.ctx || !engine.click.countIn) return;
    const plan = engine.countInPlan(Number.isFinite(engine.startPos) ? engine.startPos : engine.playhead);   // the meter where the take starts
    const loop = () => {
      if (engine.recording !== rec) { box.hidden = true; return; }
      const left = rec.startCtxTime - engine.ctx.currentTime;
      if (left <= 0.02) { box.hidden = true; return; }
      const into = plan.length - left; let k = 0; for (let i = 0; i < plan.clicks.length; i++) if (plan.clicks[i].dt <= into + 0.01) k = i;
      box.querySelector('.num').textContent = String(k + 1); box.hidden = false;
      requestAnimationFrame(loop);
    };
    loop();
  }
  let finishing = null;
  function finishRecording() { if (finishing) return finishing; finishing = (async () => { try { await _finishRecording(); } finally { finishing = null; setTimeout(applyDeferredReload, 0); } })(); return finishing; }
  async function _finishRecording() {
    const recNow = engine.recording; const punch = recNow && recNow.punch; const guard = recNow && recNow._crash;
    let r; try { r = await engine.stopRecording(); } finally { if (punch) { engine.setLoop({ enabled: punch.loopWas }); engine.seek(punch.a); } }
    positionPlayhead();
    if (!r || !r.takes || !r.takes.length) { crashGuardEnd(guard); renderAll(); status('Recording cancelled — nothing captured.'); return; }
    const t = engine.track(r.trackId);
    if (r.takes.length > 1) return finishLoopTakes(r, t, guard);
    if (punch && r.clip.kind !== 'midi') {
      const p = window.BPComp.punchTrim(r.clip, fullLen(r.clip), punch.a, punch.b);
      if (!p) { crashGuardEnd(guard); engine.buffers.delete(r.clip.id); renderAll(); status('Stopped before the punch-in — nothing recorded.'); return; }
      Object.assign(r.clip, p);
    }
    r.clip.takenBy = state.settings.identity.user; r.clip.takenAt = new Date().toISOString(); r.clip.mute = false;
    if (t) { const n = nextTakeNumber(t); r.clip.name = r.clip.kind === 'midi' ? `midi take ${n}` : `take ${n}`;
      const over = punch ? [] /* a punched take replaces the others inside its range (comped below) */ : t.clips.filter((c) => !c.mute && c.start < r.clip.start + r.clip.duration && c.start + (engine.clipLength(c) || c.duration) > r.clip.start);
      if (over.length) {
        const newC = r.clip; const names = over.map((c) => c.name).join(', ');
        const keep = (winner, losers) => () => {
          const live = (id) => engine.tracks.flatMap((x) => x.clips).find((c) => c.id === id);   // resolve at click time: the song may have been reloaded since
          const w = live(winner.id), ls = losers.map((c) => live(c.id)).filter(Boolean);
          if (!w) { status('That take is no longer in the song.'); return; }
          change(() => { for (const c of ls) c.mute = true; w.mute = false; }, { label: `keep ${w.name}` }); state.selectedClip = w.id; renderAll();
          toast(`Keeping ${w.name}; ${ls.map((c) => c.name).join(', ') || 'nothing'} muted (still in the song — un-mute in the Take panel).`, { kind: 'ok', ms: 6000 });
        };
        toast(`${newC.name} was recorded over ${names} — ${over.length > 1 ? 'all of them' : 'both'} play together until you pick one. (Click a take to select it; the Take panel has mute / solo.)`, { kind: 'warn', ms: 0, buttons: [[`Keep ${newC.name}`, keep(newC, over)], [`Keep ${over[over.length - 1].name}`, keep(over[over.length - 1], [newC, ...over.filter((c) => c !== over[over.length - 1])])], ['Keep all', () => {}]] });
      }
    }
    pushUndo('record take'); logActivity(`recorded ${r.clip.name}${t ? ` on ${t.name}` : ''}${punch ? ` (punch ${fmtBar(punch.a)}–${fmtBar(punch.b)})` : ''}`);
    if (t) t.clips.push(r.clip);
    if (t && punch) { const res = window.BPComp.comp(t.clips, r.clip.id, r.clip.start, clipEnd(r.clip), { len: (x) => engine.clipLength(x) || x.duration, full: fullLen, newId: window.BPUtil.newId, audioId }); t.clips.splice(0, t.clips.length, ...res.clips); }
    if (!state.readOnly) state.dirty = true; renderAll();
    if (r.clip.kind === 'midi') { crashGuardEnd(guard); status(`Recorded ${r.clip.notes.length} notes.`); try { await saveWithClip(r.trackId, r.clip, t && t.name); } catch (err) { fail(err); } maybeAutoKey(); return; }
    status('Saving take…', 0);
    const wav = window.BPWav.encodeWav(r.channels, r.sampleRate, 24);
    try {
      await bp.audio.write(state.folder, r.clip.id, wav, { label: takeLabel(t, r.clip) });
      crashGuardEnd(guard);
    } catch (err) {
      crashGuardHold(guard);
      state.pendingTakes.set(r.clip.id, { wav, trackId: r.trackId, clip: r.clip, crash: guard && guard.id });
      state.lastSaveError = `Take "${r.clip.name}" is not on the shared folder yet (${err.message}). It is kept in memory; Retry save.`;
      updateBadges(); fail(err); return;
    }
    try { await saveWithClip(r.trackId, r.clip, t && t.name); } catch (err) { fail(err); }
    maybeAutoKey(); offerNoodlePart(t, r.clip); afterTake(t, r.clip);
    if (t && window.BPAutoMix.role(t) === 'bass') setTimeout(() => keyCheck({ quiet: false }).catch(() => {}), 1500);
  }
  // after a take lands: offer its lyrics (vocal takes) and to tick an open need it answers
  function afterTake(t, c) {
    if (!t || !c || state.readOnly || !state.song) return;
    const len = engine.clipLength(c) || 0; const btns = []; const bits = [];
    if (isVocalTrack(t) && len >= 4 && !isBackingVocal(t)) { btns.push(['🎤 Lyrics from it', () => transcribeClips([{ t, c }])]); bits.push('Want the words written out from it?'); }
    const secs = liveSections().filter((x) => x.start < c.start + len - 0.5 && x.end > c.start + 0.5);
    const kind = (t.type || '') + ' ' + t.name; const words = { bass: /bass/i, guitar: /gtr|guitar/i, vocals: /vox|vocal|sing|voice/i, harmony: /harm/i, drums: /drum|kit/i, keys: /key|synth|piano|organ/i };
    const want = Object.entries(words).filter(([, re]) => re.test(kind)).map(([k]) => k);
    const need = liveNeeds().find((n) => !n.done && want.some((k) => new RegExp(k === 'vocals' ? 'vocal|vox|sing|lyric' : k === 'guitar' ? 'guitar|gtr|riff|solo' : k, 'i').test(n.text)) && (!n.sectionId || secs.some((x) => x.id === n.sectionId)) && (!n.who || CB.nameMatch(n.who, me())));
    if ((harmonicTrack(t) || bassTrack(t)) && len >= 4 && !liveChords().some((x) => x.time >= c.start - 0.01 && x.time < c.start + len)) { btns.push(['🎸 Chords from it', () => chordsFromTracks([t])]); bits.push('No chords there yet — want them drafted from it?'); }
    if (need) { btns.push([`✓ "${need.text.slice(0, 40)}" done`, () => setNeedDone(need, true)]); bits.push(`Does it cover "${need.text}"?`); }
    if (btns.length) toast(`${c.name} saved. ${bits.join(' ')}`, { kind: 'ok', ms: 20000, buttons: btns });
  }
  function offerNoodlePart(t, c) { if (!state.song || !state.song.sandbox || !t || !c) return; toast(`${c.name} recorded. Keep it?`, { kind: 'ok', ms: 30000, buttons: [['Save to Parts bin', () => { const f = findClip(c.id); if (f) return savePartFrom({ clip: f.c, track: f.t }); }]] }); }
  // Loop recording produced several passes: write each as its own take, keep only the last audible.
  async function finishLoopTakes(r, t, guard = null) {
    const who = state.settings.identity.user, at = new Date().toISOString();
    if (!t) { t = engine.addTrack('Recovered'); status('The track was deleted mid-recording — takes went onto a new "Recovered" track.', 8000); }
    const names = [];
    let n = nextTakeNumber();
    for (const k of r.takes) { k.clip.name = k.clip.kind === 'midi' ? `midi take ${n}` : `take ${n}`; n++; k.clip.takenBy = who; k.clip.takenAt = at; k.clip.mute = true; names.push(k.clip.name); }
    // the hero take is the last COMPLETE pass; a trailing partial pass is kept but muted
    const complete = r.takes.filter((k) => !k.partial); const hero = (complete.length ? complete[complete.length - 1] : r.takes[r.takes.length - 1]).clip; hero.mute = false;
    status(`Saving ${r.takes.length} takes…`, 0);
    for (const k of r.takes) {   // audio on disk first — the song can always be rebuilt from the files
      if (k.clip.kind === 'midi') continue;
      const wav = window.BPWav.encodeWav(k.channels, r.sampleRate, 24);
      try { await bp.audio.write(state.folder, k.clip.id, wav, { label: takeLabel(t, k.clip) }); }
      catch (err) { state.pendingTakes.set(k.clip.id, { wav, trackId: t.id, clip: k.clip }); state.lastSaveError = `Take "${k.clip.name}" is not on the shared folder yet (${err.message}).`; }
    }
    if ([...state.pendingTakes.values()].some((p) => r.takes.some((k) => k.clip === p.clip))) { crashGuardHold(guard); for (const k of r.takes) { const p = state.pendingTakes.get(k.clip.id); if (p) p.crash = guard && guard.id; } } else crashGuardEnd(guard);
    pushUndo('loop record'); logActivity(`recorded ${r.takes.length} loop passes on ${t.name}`);
    for (const k of r.takes) t.clips.push(k.clip);
    for (const c of t.clips) if (!r.takes.some((k) => k.clip === c) && !c.mute && c.start < hero.start + hero.duration && c.start + (engine.clipLength(c) || c.duration) > hero.start) c.mute = true;   // earlier takes under the loop go quiet
    state.selectedClip = hero.id; if (!state.readOnly) state.dirty = true; renderAll();
    try { await saveWithClip(t.id, r.takes.map((k) => k.clip), t.name); } catch (err) { fail(err); }
    maybeAutoKey();
    offerNoodlePart(t, hero);
    toast(`${r.takes.length} passes recorded: ${names.join(', ')}. ${hero.name} plays; the others are muted under it. Right-click a take → Listen to this take / Keep this take.`, { kind: 'ok', ms: 20000 });
    updateBadges();
  }
  const barLen = () => engine.beatLen() * engine.timeSig[0];   // the SONG's bar (parts with their own tempo / meter: barLenAt)
  // ---- tempo map: parts can have their own tempo and time signature (section.bpm / section.timeSig) ----
  function meter() {
    if (!state.song) return window.BPMeter.build({ bpm: engine.bpm, timeSig: engine.timeSig });
    const ov = liveSections().filter((x) => x.bpm || x.timeSig).map((x) => ({ id: x.id, start: x.start, end: x.end, bpm: x.bpm, timeSig: x.timeSig }));
    const key = JSON.stringify([engine.bpm, engine.timeSig, ov]);
    if (meter.key !== key || !meter.map) { meter.key = key; meter.map = window.BPMeter.build({ bpm: engine.bpm, timeSig: engine.timeSig, sections: ov }); meter.map.sections = ov; engine.setMeter(meter.map); }
    return meter.map;
  }
  function barIdx(sec) { return window.BPMeter.barAt(meter(), Math.max(0, sec)); }          // 0-based, fractional
  function barSec(i) { return window.BPMeter.secAtBar(meter(), Math.max(0, i)); }           // 0-based bar index → seconds
  function barLenAt(sec) { return window.BPMeter.posAt(meter(), Math.max(0, sec)).barLen; }
  function beatLenAt(sec) { return window.BPMeter.posAt(meter(), Math.max(0, sec)).beatLen; }
  function meterAt(sec) { const sg = window.BPMeter.segAt(meter(), Math.max(0, sec)); return { bpm: sg.bpm, timeSig: window.BPMeter.normTs(sg.ts).slice(0, 2), ts: sg.ts }; }
  function snapToBar(sec) { return barSec(Math.round(barIdx(sec))); }
  function floorBar(sec) { return barSec(Math.floor(barIdx(sec) + 1e-6)); }
  function endBarNo(sec) { return Math.round(barIdx(sec)); }
  // Take numbers never repeat on a track, even after deletes (trash remembers the names).
  function nextTakeNumber() {   // song-wide, never reused (trash counts too), so "take 4" means one thing
    let n = 0; const scan = (name) => { const m = /take (\d+)/.exec(name || ''); if (m) n = Math.max(n, Number(m[1])); };
    for (const t of engine.tracks) for (const c of t.clips) scan(c.name);
    for (const tr of Object.values(state.song.trash || {})) scan(tr.name);
    return n + 1;
  }
  function skipBars(n) { if (engine.recording) return; const target = barSec(Math.max(0, Math.round(barIdx(engine.playhead)) + n)); engine.seek(target); positionPlayhead(); }
  $('#btn-start').addEventListener('click', () => { if (!engine.recording) { engine.seek(engine.loop.enabled ? engine.loop.start : 0); positionPlayhead(); } });
  $('#btn-back').addEventListener('click', () => skipBars(-1));
  $('#btn-fwd').addEventListener('click', () => skipBars(1));
  $('#btn-end').addEventListener('click', () => { if (!engine.recording) { engine.seek(engine.contentLength()); positionPlayhead(); } });
  $('#btn-pause').addEventListener('click', () => { if (engine.playing && !engine.recording) engine.pause(); else play().catch(fail); });
  function loopBarsFromEngine() { $('#loop-from').value = Math.round(barIdx(engine.loop.start)) + 1; $('#loop-to').value = Math.round(barIdx(engine.loop.end)); }
  function setLoopBars(fromBar, toBar) { if (!state.folder || engine.recording) { loopBarsFromEngine(); return; } if (state.readOnly) { status('Read-only: take over to change the loop.'); loopBarsFromEngine(); return; } let a = Math.max(1, Math.round(num(fromBar, 1))), z = Math.round(num(toBar, a)); if (z < a) [a, z] = [Math.max(1, z), a]; const maxBar = Math.max(8, Math.ceil(barIdx(Math.max(engine.contentLength(), ...liveSections().map((x) => x.end), 0))) + 8); if (z > maxBar) { z = maxBar; if (a > z) a = z; status(`Loop capped at bar ${maxBar} — the song isn't longer than that yet.`, 5000); } if (engine.loop.enabled && Math.abs(engine.loop.start - barSec(a - 1)) < 1e-6 && Math.abs(engine.loop.end - barSec(z)) < 1e-6) { loopBarsFromEngine(); return; } pushUndo(`loop bars ${a}–${z}`); engine.setLoop({ enabled: true, start: barSec(a - 1), end: barSec(z) }); $('#loop-on').checked = true; markDirty(); drawRuler(); loopBarsFromEngine(); }
  $('#loop-from').addEventListener('change', () => setLoopBars($('#loop-from').value, $('#loop-to').value));
  $('#loop-to').addEventListener('change', () => setLoopBars($('#loop-from').value, $('#loop-to').value));
  $('#btn-loop-here').addEventListener('click', () => { const bar = barOf(engine.playhead); setLoopBars(bar, bar + 3); });
  $('#btn-loop-clip').addEventListener('click', () => { const t = engine.track(state.selectedTrack); const c = t && t.clips.find((x) => x.id === state.selectedClip); if (!c) { status('Select a take first (click it), then Loop take.'); return; } setLoopBars(barOf(c.start), Math.ceil(barIdx(c.start + engine.clipLength(c)) - 1e-6)); });
  $('#btn-play').addEventListener('click', () => play().catch(fail));
  $('#btn-stop').addEventListener('click', () => stop().catch(fail));
  $('#btn-rec').addEventListener('click', () => (engine.recording ? finishRecording() : record()).catch(fail));
  document.querySelectorAll('#topbar input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => cb.blur()));
  $('#click-on').addEventListener('change', (e) => { engine.click.on = e.target.checked; if (engine.playing && !engine.recording) { const p = engine.playhead; engine.stop(); engine.playhead = p; engine.play(); } });
  $('#count-in').addEventListener('change', (e) => { engine.click.countIn = e.target.checked; });
  $('#loop-on').addEventListener('change', (e) => { engine.setLoop({ enabled: e.target.checked }); drawRuler(); loopBarsFromEngine(); if (state.folder && !state.readOnly) markDirty(); });
  // any time signature: the list has the usual ones, "Other…" takes anything (13/7, 11/16) and groupings for the click (2+2+3/8)
  function syncTsSelect() {
    const sel = $('#timesig'); if (!sel) return; const lab = MT.tsLabel(engine.timeSig);
    if (![...sel.options].some((o) => o.value === lab)) { const o = el('option', null, lab); o.value = lab; sel.insertBefore(o, sel.querySelector('option[value="custom"]')); }
    sel.value = lab;
  }
  async function askTimeSig(title, cur) {
    const v = await promptName(`${title} — any meter: 4/4, 6/8, 7/8, 5/4, 13/7 … (2+2+3/8 sets how the click groups the beats)`, cur || MT.tsLabel(engine.timeSig));
    if (v === null) return null; const ts = MT.parseTimeSig(v); if (!ts) { status(`"${v}" isn't a time signature — like 7/8 or 2+2+3/8.`, 6000); return null; } return ts;
  }
  $('#timesig').addEventListener('change', async (e) => {
    e.target.blur(); let ts = e.target.value === 'custom' ? await askTimeSig('Time signature') : MT.parseTimeSig(e.target.value);
    if (ts) { change(() => engine.setTimeSig(ts), { label: `time signature ${MT.tsLabel(ts)}` }); }
    syncTsSelect(); renderAll();
  });
  $('#bpm').addEventListener('change', (e) => { e.target.blur(); /* Ctrl+Z right after Enter should undo the tempo, not be eaten by the field */ const raw = String(e.target.value).trim(); const v = Number(raw); e.target.value = engine.bpm; if (!raw || !Number.isFinite(v) || v === engine.bpm) return; if (v < 30 || v > 300) { status('Tempo has to be between 30 and 300 bpm.', 5000); return; } setTempo(v).catch(fail); });

  // Tempo change. With recorded audio the takes follow the new tempo like tape (varispeed: faster = higher pitch):
  // each take is re-rendered once at the new speed into a NEW file (the old file stays, so undo / roll back work),
  // and everything on the timeline — takes, MIDI, sections, chords, lyrics, notes, loop — keeps its bar position.
  // mode 'grid' = only the grid, click and drum machine change (takes keep their real speed).
  let tempoBusy = false;
  async function setTempo(bpmIn, { mode = 'auto' } = {}) {
    const nb = clamp(bpmIn, 30, 300, engine.bpm), ob = engine.bpm; if (nb === ob) return;
    if (ro()) { status('Read-only: take over to change the tempo.'); return; }
    if (tempoBusy) { status('Still re-speeding the takes — one moment.'); return; }
    if (state.ab) await leaveAB({ silent: true });
    if (engine.recording || finishing) { status('Stop recording first.'); return; }
    const audio = engine.tracks.some((t) => t.clips.some((c) => c.kind !== 'midi'));
    const ratio = nb / ob;   // > 1 = faster
    const f = ob / nb;       // timeline scale: everything keeps its bar
    const scaleTimeline = () => {
      const sc = (x) => (typeof x === 'number' ? x * f : x);
      for (const x of state.song.sections || []) { x.start = sc(x.start); x.end = sc(x.end); if (x.bpm) x.bpm = Math.round(x.bpm * ratio * 100) / 100; }   // a part's own tempo moves with the song
      for (const k of ['chords', 'lyrics', 'markers']) for (const x of state.song[k] || []) { x.time = sc(x.time); if (k === 'lyrics' && Array.isArray(x.words)) x.words = x.words.map((w) => ({ ...w, t: w.t * f, e: w.e * f })); }
      for (const t of engine.tracks) for (const c of t.clips) if (c.kind === 'midi') { c.start *= f; c.trimStart = (c.trimStart || 0) * f; c.trimEnd = (c.trimEnd || 0) * f; c.duration = (c.duration || 0) * f; c.notes = (c.notes || []).map((no) => ({ ...no, t: no.t * f, d: no.d * f })); }
      engine.setLoop({ start: engine.loop.start * f, end: engine.loop.end * f });
      engine.playhead *= f;
    };
    if (mode === 'grid' || ratio > 2 || ratio < 0.5) {
      if (audio && mode !== 'grid') toast('That is more than double / half the tempo — only the grid, click and drum machine changed; the takes keep their speed.', { kind: 'warn', ms: 9000 });
      change(() => engine.setBpm(nb), { label: `tempo ${ob} → ${nb}${audio ? ' (grid only)' : ''}` });
      $('#bpm').value = engine.bpm; drawRuler(); renderAll(); return;
    }
    if (!audio) {   // nothing recorded yet: sections, chords, lyrics, notes, MIDI and the loop simply follow the new tempo
      change(() => { scaleTimeline(); engine.setBpm(nb); }, { label: `tempo ${ob} → ${nb}` });
      $('#bpm').value = engine.bpm; loopBarsFromEngine(); drawRuler(); renderAll(); return;
    }
    tempoBusy = true; document.body.classList.add('busy');
    const written = [];
    try {
      // Always render from the ORIGINAL recording (c.vs = {src, bpm}): 180 → 178 → 176 never resamples a resample,
      // and going back to the tempo it was recorded at uses the original file again.
      // A transposed take (c.ps) re-speeds from ITS original too and gets its transpose re-applied on top, so
      // transpose → tempo → transpose back lands on the original recording instead of a shift of a re-speed of a shift.
      const orig = (c) => (c.ps && c.ps.src ? (c.ps.vs && c.ps.vs.src ? c.ps.vs : { src: c.ps.src, bpm: ob }) : (c.vs && c.vs.src ? c.vs : { src: audioId(c), bpm: ob }));
      const semisOf = (c) => (c.ps && c.ps.semis ? c.ps.semis : 0);
      const jobs = new Map();   // `${origSrc}@${nb}` → {orig, target}
      for (const t of engine.tracks) for (const c of t.clips) if (c.kind !== 'midi') { const o = orig(c); jobs.set(o.src, o); }
      for (const o of jobs.values()) if (!engine.buffers.has(o.src)) {
        try { engine.buffers.set(o.src, await window.BPWav.decodeWav(engine.ctx, await bp.audio.read(state.folder, o.src))); }
        catch (_) { throw new Error('Some takes haven\'t synced in yet — wait for them, or right-click the tempo → "Change tempo, keep takes as they are".'); }
      }
      const out = new Map(); let n = 0;
      for (const o of jobs.values()) {
        if (Math.abs(o.bpm - nb) < 1e-9) { out.set(o.src, { id: o.src, duration: engine.buffers.get(o.src).duration, original: true }); continue; }
        status(`Re-speeding takes for ${nb} bpm… ${++n}/${jobs.size}`, 0);
        const rendered = await window.BPStretch.varispeed(engine.buffers.get(o.src), nb / o.bpm);
        const nid = newId();
        const owner = engine.tracks.flatMap((t) => t.clips.map((c) => [t, c])).find(([, c]) => orig(c).src === o.src);
        await bp.audio.write(state.folder, nid, window.BPWav.encodeWav(window.BPWav.audioBufferToChannels(rendered), rendered.sampleRate, 24), { label: `${owner ? takeLabel(owner[0], owner[1]) : 'take'} - ${nb}bpm` });
        written.push(nid); engine.buffers.set(nid, rendered); out.set(o.src, { id: nid, duration: rendered.duration });
      }
      // transposed takes: the transpose again, on top of the re-sped (or original) file
      const shifted = new Map();   // `${origSrc}|${semis}` → {id, duration}
      for (const t of engine.tracks) for (const c of t.clips) if (c.kind !== 'midi' && semisOf(c)) {
        const o = orig(c), k = `${o.src}|${semisOf(c)}`; if (shifted.has(k)) continue;
        status(`Re-applying the transpose (${semisOf(c) > 0 ? '+' : ''}${semisOf(c)}) at ${nb} bpm…`, 0);
        const base = engine.buffers.get(out.get(o.src).id); const r = await window.BPStretch.conform(base, { ratio: 1, semis: semisOf(c) });
        const nid = newId(); await bp.audio.write(state.folder, nid, window.BPWav.encodeWav(window.BPWav.audioBufferToChannels(r), r.sampleRate, 24), { label: `take - ${nb}bpm ${semisOf(c) > 0 ? '+' : ''}${semisOf(c)}st` });
        written.push(nid); engine.buffers.set(nid, r); shifted.set(k, { id: nid, duration: r.duration });
      }
      // the song must not have changed under us while rendering
      if (engine.bpm !== ob || engine.recording || state.readOnly) throw new Error('The song changed while re-speeding (tempo, recording or lock) — try again.');
      for (const t of engine.tracks) for (const c of t.clips) if (c.kind !== 'midi' && !out.has(orig(c).src)) throw new Error('A take was added while re-speeding — try the tempo change again.');
      const did = change(() => {
        for (const t of engine.tracks) for (const c of t.clips) {
          if (c.kind === 'midi') continue;
          const o = orig(c); const m = out.get(o.src);
          c.start *= f; c.trimStart = (c.trimStart || 0) * f; c.trimEnd = (c.trimEnd || 0) * f; c.fadeIn = (c.fadeIn || 0) * f; c.fadeOut = (c.fadeOut || 0) * f;
          const sm = semisOf(c);
          if (sm) {   // transposed: plays the re-shifted file; ps.src = the untransposed file at the new tempo, ps.vs = its origin
            const r = shifted.get(`${o.src}|${sm}`); c.src = r.id; c.duration = r.duration; delete c.vs;
            c.ps = { src: m.id, semis: sm, ...(m.original ? {} : { vs: { src: o.src, bpm: o.bpm } }) };
          } else {
            c.duration = m.duration; delete c.ps;
            if (m.original) { if (o.src === c.id) delete c.src; else c.src = o.src; delete c.vs; }
            else { c.src = m.id; c.vs = { src: o.src, bpm: o.bpm }; }
          }
          c.trimEnd = Math.max(0, Math.min(c.trimEnd, c.duration - c.trimStart - 0.01));   // rounding of the new file length
        }
        scaleTimeline();
        engine.setBpm(nb);
      }, { label: `tempo ${ob} → ${nb} (takes ${ratio > 1 ? 'sped up' : 'slowed down'}, ${ratio > 1 ? '+' : ''}${(12 * Math.log2(ratio)).toFixed(1)} semitones)` });
      if (!did) throw new Error('Tempo not changed.');
      written.length = 0;
      $('#bpm').value = engine.bpm; loopBarsFromEngine(); drawRuler(); renderAll(); pruneBuffers();
      toast(`Tempo ${ob} → ${nb}: takes ${ratio > 1 ? 'sped up' : 'slowed down'} like tape (${ratio > 1 ? '+' : ''}${(12 * Math.log2(ratio)).toFixed(1)} semitones). ${MOD}+Z undoes. Right-click the tempo for "keep takes as they are".`, { kind: 'ok', ms: 10000 });
    } catch (err) {
      for (const id of written) engine.buffers.delete(id);   // files stay on Drive (immutable, harmless); memory is freed
      throw err;
    } finally { tempoBusy = false; document.body.classList.remove('busy'); status(''); }
  }

  // ---------- transpose: move the song (or one section) up/down by semitones — audio, MIDI, chords and key together ----------
  // Audio is pitch-shifted with the tempo kept (stretch.js conform), written as NEW files; c.ps = {src, semis, vs} remembers the
  // untransposed source so +2 then -2 goes back to the original file instead of a shift of a shift. Drums are left alone.
  let transposeBusy = false;
  // a drum track = the drum machine or a track whose type is drums — by type only, never by name
  const isDrumTrack = (t) => t.instrument === 'drumkit' || t.type === 'drums';
  async function transposeSong(semis, sec = null) {
    semis = Math.round(Number(semis)); if (!semis || Math.abs(semis) > 12) throw new Error('Transpose by 1–12 half steps, up or down.');
    if (!state.folder) return; if (ro()) { status('Read-only — take over first.'); return; }
    if (transposeBusy || tempoBusy) { status('Still working on the last change — one moment.'); return; }
    if (state.ab) await leaveAB({ silent: true });
    if (engine.recording || finishing) { status('Stop recording first.'); return; }
    if (engine.playing) await stop();
    // a linked copy of a section plays its room: transposing it means transposing the room (every linked copy follows)
    let secs = sec ? [sec] : null;
    if (sec) {
      const g = Object.values(TPL.linkInfo({ sections: state.song.sections, linkGroups: state.song.linkGroups })).find((x) => x.room.id === sec.id || x.followers.some((f) => f.id === sec.id));
      if (g) {
        const a = await ask('Linked section', `${sec.name} is linked with ${[g.room, ...g.followers].filter((x) => x.id !== sec.id).map((x) => x.name).join(', ')} — they all play the same takes. Transpose all of them? (To change just this one, right-click it → Unlink first.)`, [['Transpose all', 'ok', 'primary'], ['Cancel', 'cancel']]);
        if (a !== 'ok') return; secs = [g.room, ...g.followers]; sec = g.room;
      }
    }
    const a0 = sec ? sec.start : -Infinity, b0 = sec ? sec.end : Infinity;
    const label = sec ? (secs.length > 1 ? `${secs.map((x) => x.name).join(' / ')}` : sec.name) : 'the song';
    const dir = `${semis > 0 ? 'up' : 'down'} ${Math.abs(semis)} half step${Math.abs(semis) > 1 ? 's' : ''}`;
    // which clips: not mirrors (they follow their room), not drums; in section mode only what sounds inside the room section
    const touched = [];   // [track, clip]
    for (const t of engine.tracks) { if (isDrumTrack(t)) continue; for (const c of t.clips) { if (c.link) continue; const e = c.start + engine.clipLength(c); if (e - Math.max(a0, c.start) > 0.02 && Math.min(b0, e) - c.start > 0.02 && Math.min(b0, e) - Math.max(a0, c.start) > 0.02) touched.push([t, c]); } }
    const audioClips = touched.filter(([, c]) => c.kind !== 'midi');
    if (audioClips.length && Math.abs(semis) > 4) {
      const ok = await ask('Big jump', `Moving recorded audio ${dir} will sound processed (vocals get chipmunky / muddy past 3–4 half steps). It's fine for trying the key out; re-track for keeps. Go ahead?`, [['Transpose', 'ok', 'primary'], ['Cancel', 'cancel']]);
      if (ok !== 'ok') return;
    }
    transposeBusy = true; document.body.classList.add('busy');
    const written = [];
    try {
      await engine.init();
      // base (untransposed) audio for each clip, and the total shift it should end up at
      const baseOf = (c) => (c.ps && c.ps.src ? c.ps : { src: audioId(c), semis: 0, vs: c.vs || null });
      const jobs = new Map();   // `${baseSrc}|${total}` → {src, total}
      for (const [, c] of audioClips) { const b = baseOf(c); const total = b.semis + semis; if (total) jobs.set(`${b.src}|${total}`, { src: b.src, total }); }
      for (const j of jobs.values()) if (!engine.buffers.has(j.src)) {
        try { engine.buffers.set(j.src, await window.BPWav.decodeWav(engine.ctx, await bp.audio.read(state.folder, j.src))); }
        catch (_) { throw new Error('Some takes haven\'t synced in yet — wait for them and try again.'); }
      }
      const out = new Map(); let n = 0;
      for (const [k, j] of jobs) {
        status(`Transposing ${label} ${dir}… ${++n}/${jobs.size}`, 0);
        const src = engine.buffers.get(j.src);
        const shifted = await window.BPStretch.conform(src, { ratio: 1, semis: j.total });
        const nid = newId(); const owner = audioClips.find(([, c]) => baseOf(c).src === j.src);
        await bp.audio.write(state.folder, nid, window.BPWav.encodeWav(window.BPWav.audioBufferToChannels(shifted), shifted.sampleRate, 24), { label: `${owner ? takeLabel(owner[0], owner[1]) : 'take'} - ${j.total > 0 ? '+' : ''}${j.total}st` });
        written.push(nid); engine.buffers.set(nid, shifted); out.set(k, { id: nid, duration: shifted.duration });
      }
      if (engine.recording || state.readOnly) throw new Error('The song changed while transposing — try again.');
      const flat = (k) => MU.isFlatKey(k || '');
      const did = change(() => {
        // section mode: cut takes at the section edges so only the inside part moves
        const cut = (t, c) => {
          if (!sec) return c;
          const cs = c.start, ce = c.start + engine.clipLength(c); if (cs >= a0 - 0.01 && ce <= b0 + 0.01) return c;
          const full = c.kind === 'midi' ? (Number(c.duration) || 0) : ((engine.buffers.get(audioId(c)) || {}).duration || Number(c.duration) || 0);
          const piece = (x, y, keep) => { const ts = (c.trimStart || 0) + (x - cs); const p = { ...JSON.parse(JSON.stringify(c)), id: keep ? c.id : newId(), start: x, trimStart: ts, trimEnd: Math.max(0, full - ts - (y - x)), fadeIn: x > cs + 1e-6 ? 0.004 : c.fadeIn || 0, fadeOut: y < ce - 1e-6 ? 0.004 : c.fadeOut || 0 }; if (c.kind !== 'midi' && !p.src && !keep) p.src = audioId(c); return p; };
          const parts = []; let mid = null;
          if (cs < a0 - 0.01) parts.push(piece(cs, a0, true));
          mid = piece(Math.max(cs, a0), Math.min(ce, b0), !parts.length); parts.push(mid);
          if (ce > b0 + 0.01) parts.push(piece(b0, ce, false));
          const i = t.clips.indexOf(c); t.clips.splice(i, 1, ...parts);
          return mid;
        };
        for (const [t, c0] of touched) {
          const c = cut(t, c0);
          if (c.kind === 'midi') {
            const w0 = sec ? Math.max(a0, c.start) : -Infinity, w1 = sec ? Math.min(b0, c.start + engine.clipLength(c)) : Infinity;
            c.notes = (c.notes || []).map((x) => { const at = c.start + x.t - (c.trimStart || 0); return at >= w0 - 1e-6 && at < w1 ? { ...x, n: Math.max(0, Math.min(127, x.n + semis)) } : x; });
            continue;
          }
          const b = baseOf(c); const total = b.semis + semis;
          if (!total) { if (b.src === c.id) delete c.src; else c.src = b.src; if (b.vs) c.vs = b.vs; else delete c.vs; delete c.ps; }
          else { const m = out.get(`${b.src}|${total}`); c.src = m.id; c.duration = m.duration; c.ps = { src: b.src, semis: total, ...(b.vs ? { vs: b.vs } : {}) }; delete c.vs; }
          c.trimEnd = Math.max(0, Math.min(c.trimEnd || 0, (c.duration || 0) - (c.trimStart || 0) - 0.01));
        }
        // chords and key
        const newKey = (k) => (k ? MU.transposeKey(k, semis) : k);
        if (!sec) {
          if (state.song.key) state.song.key = newKey(state.song.key);
          for (const x of state.song.sections || []) if (x.key) x.key = newKey(x.key);
        } else {
          const k = newKey(keyAt(sec.start + 0.01) || state.song.key || '');
          const same = MU.parseKey(k) && MU.parseKey(state.song.key || '') && MU.parseKey(k).name === MU.parseKey(state.song.key).name;
          for (const x of secs) { if (same) delete x.key; else if (k) x.key = k; }
        }
        const fl = flat(sec ? (sec.key || state.song.key) : state.song.key);
        for (const ch of state.song.chords || []) { if (ch.deleted || ch.link) continue; if (sec && !(ch.time >= a0 - 1e-6 && ch.time < b0 - 1e-6)) continue; ch.chord = MU.transposeChord(ch.chord, semis, fl); }
      }, { label: `transposed ${label} ${dir}` });
      if (!did) throw new Error('Not transposed (read-only or A/B).');
      written.length = 0; renderAll(); pruneBuffers();
      const skipped = engine.tracks.filter((t) => isDrumTrack(t) && t.clips.length).map((t) => t.name);
      toast(`Transposed ${label} ${dir}${state.song.key ? ` — key ${sec ? (sec.key || state.song.key) : state.song.key}` : ''}.${skipped.length ? ` Drums left alone (${skipped.join(', ')}).` : ''} ${MOD}+Z undoes; the original recordings are kept.`, { kind: 'ok', ms: 10000 });
    } catch (err) {
      for (const id of written) engine.buffers.delete(id);
      throw err;
    } finally { transposeBusy = false; document.body.classList.remove('busy'); status(''); }
  }
  const transposeItems = (sec = null) => [1, 2, 3, -1, -2, -3, 5, -5, 7, -7, 12, -12].map((s) => ({ label: `${s > 0 ? 'Up' : 'Down'} ${Math.abs(s) === 12 ? 'an octave' : Math.abs(s) === 1 ? 'a half step' : Math.abs(s) === 2 ? 'a whole step' : `${Math.abs(s)} half steps`}${(sec ? keyAt(sec.start + 0.01) : state.song && state.song.key) ? ` (→ ${MU.transposeKey(sec ? keyAt(sec.start + 0.01) : state.song.key, s)})` : ''}`, action: () => transposeSong(s, sec).catch(fail) }));
  // Drop decoded audio nothing can reach any more (not in the song, undo/redo, snapshots or A/B): re-speeds add up fast.
  function pruneBuffers() {
    const keep = JSON.stringify(collectSong()) + state.undo.map(undoJson).join('') + state.redo.map(undoJson).join('') + state.snapshots.map((x) => x.json).join('') + (state.ab ? state.ab.current : '');
    for (const id of [...engine.buffers.keys()]) if (!keep.includes(id) && !ideaBufs.has(id)) engine.buffers.delete(id);
  }
  $('#monitor').addEventListener('change', async (e) => { try { if (e.target.checked) await ensureInput(); engine.setMonitor(e.target.checked); if (!e.target.checked) scheduleInputRelease(); } catch (err) { e.target.checked = false; fail(err); } });

  let midiLedTimer = null;
  engine.on((ev, data) => {
    if (ev === 'input-lost') { toast(data.recording ? `Your input (${data.label || 'mic'}) disconnected while recording — this take may be silent from that point. Plug it back in (or pick another in Settings) and record again.` : `Your input (${data.label || 'mic'}) disconnected. The next take reopens it, or falls back to the default input.`, { kind: 'bad', ms: 12000 }); }
    if (ev === 'transport' && !data.playing && !data.recording) scheduleInputRelease();
    if (ev === 'loop-pass') { status(`Loop pass ${data} — keep going, each pass becomes a take. Space/R to stop.`, 0); if (data === 21) toast('20 passes recorded — every pass is its own take. Stop when you have a keeper (Space / R); it stops by itself after 50.', { kind: 'warn', ms: 12000 }); if (data > 50) finishRecording(); }
    if (ev === 'midi' && data.on) { const led = $('#midi-led'); led.classList.add('on'); clearTimeout(midiLedTimer); midiLedTimer = setTimeout(() => led.classList.remove('on'), 120); }
    if (ev === 'tick') { positionPlayhead(); if (engine.recording) { const rc = tracksEl.querySelector('.clip[data-recording]'); if (rc) rc.style.width = `${Math.max(2, (engine.playhead - engine.recording.startPos) * state.pxPerSec)}px`; else renderTracks(); const px = engine.playhead * state.pxPerSec; tracksEl.querySelectorAll('.drumlane[data-follow]').forEach((dl) => { const left = parseFloat(dl.style.left) || 0; if (px - left > parseFloat(dl.style.width)) dl.style.width = `${px - left}px`; }); } }
    if (ev === 'transport' && !data.playing) { clipHeld = false; peakHold = { v: -Infinity, at: 0 }; const cl = $('#master-area .cliplight'); if (cl) { cl.classList.remove('on', 'hot'); cl.textContent = 'ok'; } }
    if (ev === 'transport') sendPresence();
    if (ev === 'transport') { $('#btn-pause').textContent = data.playing && !data.recording ? '❚❚' : '▶'; $('#btn-play').classList.toggle('active', data.playing && !data.recording); $('#btn-rec').classList.toggle('active', data.recording); positionPlayhead(); if (!data.recording) { const rc = tracksEl.querySelector('.clip[data-recording]'); if (rc) rc.remove(); } }
  });

  window.addEventListener('keydown', (e) => {
    if (document.activeElement && document.activeElement.tagName === 'BUTTON' && !document.querySelector('dialog[open]')) document.activeElement.blur();
    const ae = document.activeElement; const widget = ae && ae.tagName === 'INPUT' && ['checkbox', 'range', 'color'].includes(ae.type);
    if (widget && (e.code === 'Space' || e.key.length === 1)) ae.blur();   // Space on a focused checkbox would toggle it instead of playing
    if (widget && ae.type === 'range' && e.key.startsWith('Arrow')) return;   // arrows nudge the slider, not the track selection
    const numField = ae && ae.tagName === 'INPUT' && ae.type === 'number' && e.code === 'Space';   /* only Space leaves a number box (apply + play); letters typed there never act as shortcuts */
    if (numField) { ae.dispatchEvent(new Event('change')); ae.blur(); }   // Space from the bpm/loop fields: apply the number and play
    const typing = (!widget && !numField && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)) || document.querySelector('dialog[open]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (mod && /^Digit[1-5]$/.test(e.code)) { e.preventDefault(); setWorkspace(['write', 'record', 'mix', 'practice', 'band'][Number(e.code.slice(5)) - 1]); return; }
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); (e.shiftKey ? redo() : undo()).catch(fail); return; }
    if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo().catch(fail); return; }
    if (typing) return;
    const sel = selected();
    if (sel && sel.c.link && mod && e.key.toLowerCase() === 'd') { e.preventDefault(); const s0 = mirrorSource(sel.c); if (s0) duplicateClip(s0.t, s0.c); return; }
    if (mod && e.key.toLowerCase() === 'c' && sel) { e.preventDefault(); copyClip(sel.c); return; }
    if (mod && e.key.toLowerCase() === 'x' && sel && !state.readOnly) { e.preventDefault(); copyClip(sel.c); deleteClip(sel.t, sel.c, { confirm: false }); return; }
    if (mod && e.key.toLowerCase() === 'v' && !state.readOnly) { e.preventDefault(); pasteClips(state.selectedTrack, engine.playhead); return; }
    if (mod && e.key.toLowerCase() === 'd' && sel && !state.readOnly) { e.preventDefault(); duplicateClip(sel.t, sel.c); return; }
    if (!mod && e.key.toLowerCase() === 's' && sel && !state.readOnly) { e.preventDefault(); splitClip(sel.t, sel.c, engine.playhead); return; }
    if (!mod && (e.key.toLowerCase() === 'm' || e.key.toLowerCase() === 's' || e.key === 'Delete' || e.key === 'Backspace') && !sel && !state.readOnly && state.folder) { status('Select a take first (click it).'); }
    if (!mod && e.key.toLowerCase() === 'm' && sel && !state.readOnly) { e.preventDefault(); const c = sel.c; change(() => { c.mute = !c.mute; }, { label: `${c.mute ? 'un-mute' : 'mute'} ${c.name}` }); renderAll(); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && sel && !state.readOnly) { e.preventDefault(); nudgeClip(sel.c, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? barLenAt(sel.c.start) : beatLenAt(sel.c.start))); return; }
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); showShortcuts(); return; }
    if (!mod && !e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); openTuner().catch(fail); return; }
    if (!mod && !e.altKey && e.key.toLowerCase() === 'k' && state.folder) { e.preventDefault(); openKaraoke().catch(fail); return; }
    if (!mod && !e.altKey && /^Digit[1-9]$/.test(e.code) && state.folder) { e.preventDefault(); jumpToPart(Number(e.code.slice(5)), { loop: e.shiftKey }); return; }
    if ((e.code === 'Space' || e.key === 'Escape') && preview) { e.preventDefault(); stopPreview(); return; }
    if ((e.code === 'Space' || e.key === 'Escape') && practice) { e.preventDefault(); stopPractice(); return; }
    if (e.code === 'Space' && !state.folder) { e.preventDefault(); status('Open a song first.'); return; }
    if (e.code === 'Space') { e.preventDefault(); if (engine.recording) finishRecording().catch(fail); else if (engine.playing) { engine.pause(); positionPlayhead(); status(`Paused at bar ${$('#bars').textContent} — Space continues.`); } else play().catch(fail); }
    else if (e.key.toLowerCase() === 'r' && !mod) { e.preventDefault(); (engine.recording ? finishRecording() : record()).catch(fail); }
    else if (e.key.toLowerCase() === 'p' && !mod && state.folder) { e.preventDefault(); pinNextLyric(); }
    else if (e.key.toLowerCase() === 'b' && !mod && state.folder) { e.preventDefault(); if (state.ws === 'mix' && state.mixAB) mixABToggle(); else toggleAB().catch(fail); }
    else if (e.key === 'Escape') { stop().catch(fail); }
    else if (e.key === 'Home') { engine.seek(0); }
    else if (e.key === 'l' || e.key === 'L') { $('#loop-on').click(); }
    else if (e.key === ',' || e.key === '<') { skipBars(e.shiftKey ? -4 : -1); }
    else if (e.key === '.' || e.key === '>') { skipBars(e.shiftKey ? 4 : 1); }
    else if (e.key === '[') { const bar = barOf(engine.playhead); setLoopBars(bar, Math.max(bar, Math.round(barIdx(engine.loop.end)))); }
    else if (e.key === ']') { const bar = Math.ceil(barIdx(engine.playhead) - 1e-6); setLoopBars(Math.min(Math.round(barIdx(engine.loop.start)) + 1, bar), Math.max(1, bar)); }
    else if (e.key === 'End') { engine.seek(engine.contentLength()); positionPlayhead(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedClip && !state.readOnly) { const f = findClip(state.selectedClip); if (f) deleteClip(f.t, f.c, { confirm: false }).catch(fail); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { const i = engine.tracks.findIndex((t) => t.id === state.selectedTrack); const n = engine.tracks[Math.max(0, Math.min(engine.tracks.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))]; if (n) { state.selectedTrack = n.id; if (e.shiftKey) state.armedTrack = n.id; renderTracks(); renderFx(); } }
  });
  // number keys: jump to the Nth part of the song (Shift = loop it); keeps playing if it was
  function jumpToPart(n, { loop = false } = {}) {
    const secs = liveSections().slice().sort((a, b) => a.start - b.start); const x = secs[n - 1];
    if (!x) { status(secs.length ? `This song has ${secs.length} part${secs.length > 1 ? 's' : ''} — keys 1–${Math.min(9, secs.length)}.` : 'No parts yet — add sections (Verse, Chorus…) to jump between them with 1–9.'); return; }
    if (engine.recording) { status('Stop recording first.'); return; }
    if (loop) { setLoopBars(barOf(x.start), Math.max(barOf(x.start), Math.ceil(barIdx(x.end) - 1e-6))); if (!engine.loop.enabled) $('#loop-on').click(); }
    engine.seek(x.start); positionPlayhead(); status(`${n} · ${x.name}${loop ? ' (looping)' : ''}`);
  }
  const SHORTCUTS = [
    ['Transport', [['Space', 'play / pause (stops recording)'], ['R', 'record on the armed track'], ['Esc', 'stop'], ['Home / End', 'start / end of the song'], [', .', 'back / forward a bar (Shift: 4 bars)'], ['1 – 9', 'jump to that part of the song'], ['Shift + 1 – 9', 'loop that part'], ['L', 'loop on / off'], ['[ ]', 'loop start / end at the playhead'], ['B', 'A/B against a saved version']]],
    ['Takes', [['click', 'select a take'], ['S', 'split the selected take at the playhead'], ['M', 'mute / un-mute it'], ['← →', 'nudge a beat (Shift: a bar)'], ['Del', 'delete it'], [`${MOD}+C / X / V`, 'copy / cut / paste at the playhead'], [`${MOD}+D`, 'duplicate right after'], ['right-click', 'keep, comp, star, lyrics from this take…']]],
    ['Song', [[`${MOD}+S`, 'save'], [`${MOD}+Z / ${MOD}+Shift+Z`, 'undo / redo'], ['↑ ↓', 'select the track above / below'], ['P', 'pin the next lyric line at the playhead'], [`${MOD}+1 – 5`, 'Write · Record · Mix · Practice · Band'], ['K', 'practice mode'], ['T', 'tuner'], ['B (in Mix)', 'A/B before / after Auto mix'], ['?', 'this sheet']]],
    ['Practice (K)', [['Space', 'play / pause (count-in first if on)'], ['← → or , .', 'back / forward a bar'], ['PgUp / PgDn', 'previous / next part'], ['1 – 9', 'jump to a part (Shift: loop it)'], ['L', 'loop the part you\'re in'], ['M', 'mix: take tracks out / solo one'], ['V', 'vocals on / off'], ['- / +', 'slower / faster (same pitch)'], ['C', 'click on / off'], ['R', 'record'], ['↑ ↓', 'text size'], ['Shift+↑ ↓', 'previous / next song (setlist)'], ['Esc', 'close']]],
  ];
  function showShortcuts() {
    let d = $('#keys');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'keys'; const f = document.createElement('form'); f.method = 'dialog'; f.append(el('h3', null, 'Keyboard shortcuts'));
      const grid = el('div', 'keys-grid');
      for (const [title, rows] of SHORTCUTS) { const col = el('div'); col.append(el('div', 'panel-title', title)); const tb = document.createElement('table'); for (const [k, v] of rows) { const tr = document.createElement('tr'); const a = document.createElement('td'); a.append(el('kbd', null, k)); tr.append(a, el('td', 'small', v)); tb.append(tr); } col.append(tb); grid.append(col); }
      const menu = document.createElement('menu'); const b = el('button', 'primary', 'Close'); b.value = ''; menu.append(b); f.append(grid, menu); d.append(f); document.body.append(d);
    }
    d.showModal();
  }
  // ---------- plain-English help: hover tips (styled, short delay), help mode (? badges, instant tips) and a glossary ----------
  // Every control carries a `title` written for someone who has never used recording software. On hover the title
  // is moved to data-tip (so the browser's tiny native tooltip stays out of the way) and shown in our own box.
  const HELP = { timer: 0, el: null, on: false, cur: null };
  function helpBox() { if (!HELP.el) { HELP.el = el('div'); HELP.el.id = 'help-tip'; document.body.append(HELP.el); } return HELP.el; }
  function helpShow(t) {
    const text = t.dataset.tip; if (!text) return; const box = helpBox(); box.textContent = text; box.style.display = 'block'; HELP.cur = t;
    const r = t.getBoundingClientRect(); const w = box.offsetWidth, h = box.offsetHeight;
    let x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)); let y = r.bottom + 8; if (y + h > window.innerHeight - 8) y = r.top - h - 8;
    box.style.left = `${x}px`; box.style.top = `${Math.max(8, y)}px`;
  }
  function helpHide() { clearTimeout(HELP.timer); HELP.timer = 0; HELP.cur = null; if (HELP.el) HELP.el.style.display = 'none'; }
  document.addEventListener('mouseover', (e) => {
    let t = e.target && e.target.closest ? e.target.closest('[title], [data-tip]') : null;
    // a chip's text next to a titled checkbox / select: use that control's tip
    if (e.target && e.target.closest) { const lab = e.target.closest('label, .chip'); if (lab && (!t || t.contains(lab)) && lab !== t) { const inner = lab.querySelector('[title], [data-tip]'); if (inner) t = inner; } }
    if (!t || t.closest('#help-tip')) return;
    if (t.getAttribute('title')) { t.dataset.tip = t.getAttribute('title'); t.removeAttribute('title'); }
    if (t === HELP.cur) return;
    clearTimeout(HELP.timer); HELP.timer = setTimeout(() => helpShow(t), HELP.on ? 60 : 650);
  });
  document.addEventListener('mouseout', (e) => { const t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null; if (t && (!e.relatedTarget || !t.contains(e.relatedTarget))) helpHide(); });
  document.addEventListener('mousedown', helpHide, true); document.addEventListener('keydown', (e) => { if (e.key !== 'F1') helpHide(); }, true); window.addEventListener('blur', helpHide);
  // dialogs: a tip inside an open <dialog> must sit above it, so the box moves into the dialog's top layer
  const tipHost = () => { const d = document.querySelector('dialog[open]'); return d || document.body; };
  new MutationObserver(() => { const box = helpBox(); const host = tipHost(); if (box.parentElement !== host) host.append(box); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  function setHelpMode(on) { HELP.on = !!on; document.body.classList.toggle('help', HELP.on); const b = $('#btn-help'); if (b) b.classList.toggle('active', HELP.on); if (HELP.on) status('Help mode: hover anything with a ? to see what it does — F1 or the ? button turns it off. Press F1 twice for the glossary.', 8000); else helpHide(); }
  // glossary: the words that trip people up, in plain English
  const GLOSSARY = [
    ['Track', 'One instrument or voice. A song is a stack of tracks playing together.'],
    ['Take', 'One recording on a track. Keep several takes and pick the best — or stitch the best bits together (comp).'],
    ['Bar', 'A chunk of time, usually 4 beats. Songs are counted in bars ("verse is 8 bars").'],
    ['BPM', 'Beats per minute — how fast the song goes. 120 is a brisk walk.'],
    ['Click', 'A metronome you hear in your headphones so everyone plays in time. It isn\'t in the recording.'],
    ['Count-in', 'A bar of clicks before recording starts so you know when to come in.'],
    ['Arm', 'Pick the track you\'re about to record onto (the red ● on the track).'],
    ['Monitor', 'Hear yourself through Cobander while you record. If you hear yourself twice, turn it off.'],
    ['Latency', 'The tiny delay between playing a note and hearing it back through the computer. The latency offset in Settings lines takes up with the click.'],
    ['Mute / Solo', 'Mute silences a track. Solo plays only that track (and anything else soloed).'],
    ['Loop', 'Play the same bit over and over — to practise it or record it again.'],
    ['Punch in', 'Record only between two points, to fix one bad bit without redoing the whole take.'],
    ['Lock', 'Who\'s allowed to change the song right now, so two people don\'t overwrite each other. Unlock a track to record on it while someone else has the song open.'],
    ['Linked parts', 'Chorus 2 is a copy of Chorus 1: record or write in one and both change. Unlink it to make it different.'],
    ['Key', 'The home note of the song (G, Bm…). Chords and the pitch check are measured against it.'],
    ['Capo / transpose', 'Show the chords moved up or down, for a capo or a different tuning. The audio doesn\'t change.'],
    ['Mix', 'How loud each track is, where it sits left/right, and its sound (EQ, effects). The mix is what you hear; the takes don\'t change.'],
    ['Fader / gain', 'Volume of a track, in dB. 0 is as recorded; −6 is about half as loud.'],
    ['Pan', 'Left / right position in the speakers.'],
    ['EQ', 'Turn frequencies up or down. Low = bass and boom, mid = body and honk, high = sparkle and hiss.'],
    ['High-pass (low-cut)', 'Takes out the rumble below an instrument\'s lowest note — cleans up vocals and guitars.'],
    ['Compressor', 'Evens out loud and quiet moments so a vocal sits steady in the mix. Threshold = where it starts working; ratio = how hard.'],
    ['Reverb / send', 'Room sound. The send is how much of a track goes into the shared reverb.'],
    ['Delay', 'Echo. Synced delay repeats in time with the song.'],
    ['Master', 'The last volume control, for the whole song. Auto master sets it to a normal loudness for sharing.'],
    ['LUFS', 'A loudness number streaming services use. Around −14 is "normal", −9 is loud rock.'],
    ['Limiter', 'Stops the loudest peaks from clipping (crackling) when the song is turned up.'],
    ['Bounce', 'Save the whole song as one audio file to share. Stems = one file per instrument, for a real studio.'],
    ['Quantize / Tighten', 'Nudge notes or hits onto the beat. Strength = how far (100% is robotic).'],
    ['MIDI', 'Notes as data instead of audio (which note, when, how hard). MIDI tracks play a built-in instrument, so you can draw a bass line without a bass.'],
    ['FLAC', 'The file type takes are saved as: lossless (nothing thrown away) but about half the size of WAV.'],
    ['Comp', 'Stitching the best bits of several takes into one.'],
    ['Pitch check', 'Marks sung notes that are flat (blue), sharp (red) or the wrong note (amber). It never changes the audio.'],
    ['Noodle pad', 'Your own scratch song for messing around. Save the good bits to the Parts bin.'],
    ['Loose ends', 'The band\'s to-do list for things that aren\'t a song.'],
  ];
  function showGlossary() {
    let d = $('#glossary');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'glossary'; const f = document.createElement('form'); f.method = 'dialog'; f.append(el('h3', null, 'What the words mean'));
      f.append(el('p', 'muted small', 'Hover anything in Cobander for a plain-English tip. F1 turns on help mode (little ? marks everywhere, tips show instantly).'));
      const tb = document.createElement('table'); tb.className = 'glossary'; for (const [k, v] of GLOSSARY) { const tr = document.createElement('tr'); const a = document.createElement('td'); a.append(el('b', null, k)); const b = document.createElement('td'); b.textContent = v; tr.append(a, b); tb.append(tr); }
      const menu = document.createElement('menu'); const man = el('button', null, '📖 User manual'); man.type = 'button'; man.title = 'Opens the manual at cobander.com in your browser'; man.addEventListener('click', () => bp.shell.openLink('manual').catch(fail)); const ks = el('button', null, 'Keyboard shortcuts'); ks.type = 'button'; ks.addEventListener('click', () => { d.close(); showShortcuts(); }); const b = el('button', 'primary', 'Close'); b.value = ''; menu.append(man, ks, b); f.append(tb, menu); d.append(f); document.body.append(d);
    }
    d.showModal();
  }
  document.addEventListener('keydown', (e) => { if (e.key !== 'F1') return; e.preventDefault(); if (HELP.on) { if (document.querySelector('dialog[open]')) return; showGlossary(); } else setHelpMode(true); }, true);
  if ($('#btn-help')) $('#btn-help').addEventListener('click', () => setHelpMode(!HELP.on));
  window.addEventListener('resize', () => { renderTracks(); positionPlayhead(); });
  // Resizable bottom panel (mixer / FX / notes); height remembered on this computer.
  // Draggable dividers: songs list | timeline, mixer | FX | side tabs. Widths are remembered per computer.
  (function paneSplitters() {
    for (const sp of document.querySelectorAll('.vsplit')) {
      const tgt = $(sp.dataset.target), key = sp.dataset.key, min = Number(sp.dataset.min), max = Number(sp.dataset.max), left = sp.dataset.side === 'left';
      const apply = (w) => { tgt.style.width = `${w}px`; tgt.style.flex = 'none'; };
      try { const v = Number(localStorage.getItem(key)); if (v >= min && v <= max) apply(v); } catch (_) {}
      sp.addEventListener('mousedown', (e) => {
        e.preventDefault(); const x0 = e.clientX, w0 = tgt.getBoundingClientRect().width; sp.classList.add('dragging'); document.body.classList.add('pane-dragging');
        const move = (ev) => { const dx = ev.clientX - x0; apply(Math.max(min, Math.min(Math.min(max, window.innerWidth - 360), left ? w0 + dx : w0 - dx))); };
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); sp.classList.remove('dragging'); document.body.classList.remove('pane-dragging'); try { localStorage.setItem(key, String(Math.round(tgt.getBoundingClientRect().width))); } catch (_) {} renderTracks(); positionPlayhead(); if (state.mel) drawRoll(); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      });
      sp.addEventListener('dblclick', () => { tgt.style.width = ''; tgt.style.flex = ''; try { localStorage.removeItem(key); } catch (_) {} renderTracks(); });
    }
  })();
  (function bottomResize() {
    const h = $('#bottom-handle'), b = $('#bottom');
    applyBottomH();
    h.addEventListener('mousedown', (e) => {
      e.preventDefault(); const y0 = e.clientY, h0 = b.getBoundingClientRect().height;
      const move = (ev) => { const nh = Math.max(120, Math.min(window.innerHeight - 160, h0 + (y0 - ev.clientY))); b.style.height = `${nh}px`; };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); try { localStorage.setItem(`bp.bottomH.${state.ws || 'write'}`, String(Math.round(b.getBoundingClientRect().height))); } catch (_) {} renderTracks(); positionPlayhead(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    h.addEventListener('dblclick', () => { try { localStorage.removeItem(`bp.bottomH.${state.ws || 'write'}`); } catch (_) {} applyBottomH(); renderTracks(); });
  })();
  window.addEventListener('beforeunload', () => { if (state.folder && (state.dirty || state.pendingTakes.size)) bp.song.backup(state.folder, collectSong(), [...state.pendingTakes].map(([clipId, p]) => ({ clipId, trackId: p.trackId, clip: p.clip, wav: p.wav, crash: p.crash || null }))); });

  // ---------- control API relay ----------
  const tid = (x) => {
    if (x && x.id) { const t = engine.track(x.id); if (!t) throw new Error(`no track with id ${x.id}`); return t; }
    if (x && x.name) { const m = engine.tracks.filter((t) => t.name === x.name); if (m.length !== 1) throw new Error(m.length ? `${m.length} tracks are named "${x.name}"; use id` : `no track named "${x.name}"`); return m[0]; }
    throw new Error('track needs id or name');
  };
  const MIX_KEYS = ['gainDb', 'pan', 'mute', 'solo', 'color', 'fx', 'rename', 'type', 'instrument', 'drum', 'preset'];
  bp.api.onRequest(async (op, args) => {
    args = args || {};
    // the API (assistant / scripts) works like someone who hit "Unlock all": free tracks are claimed before it edits
    if (state.folder && state.song && !state.readOnly && !/^(state|collab|songs|parts|chart|history|versions|analyze|debugEval)$/i.test(op) && engine.tracks.some((t) => !mineT(t.id) && !heldBy(t.id))) await unlockAll({ quiet: true });
    const need = () => { if (!state.folder) throw new Error('no song open'); };
    const writable = () => { need(); if (state.readOnly) throw new Error('song is read-only (someone else holds the lock); POST /song/takeover first'); };
    switch (op) {
      case 'state': return { version: (upd.st && upd.st.current) || null, song: state.folder ? collectSong() : null, folder: state.folder, readOnly: state.readOnly, dirty: state.dirty || state.pendingTakes.size > 0, pendingTakes: [...state.pendingTakes.keys()], backup: state.backup ? { at: state.backup.at } : null, lastSaveError: state.lastSaveError, pendingExternal: state.pendingExternal, transport: engine.transportState(), selectedTrack: state.selectedTrack, armedTrack: state.armedTrack, missingClips: [...state.missingClips], unreferencedTakes: state.unreferenced, bounces: state.bounces, recordOffsetMs: engine.recordOffsetMs, audioInput: engine.inputDeviceId, snapshots: state.snapshots.map((s) => ({ id: s.id, label: s.label, at: s.at })) };
      case 'openSong': { if (!args.folder) throw new Error('folder required'); if (!state.songs.some((s) => s.folder === args.folder)) { await refreshSongs(); if (!state.songs.some((s) => s.folder === args.folder)) throw new Error(`no song folder "${args.folder}" in the shared folder (see GET /songs)`); } await openSong(args.folder, { force: !!args.force, interactive: false }); if (state.folder !== args.folder) throw new Error('could not open'); return { folder: state.folder, readOnly: state.readOnly, rev: state.song.rev }; }
      case 'closeSong': { const ok = await closeSong({ interactive: false }); if (!ok) throw new Error('could not close'); return {}; }
      case 'createSong': { if (!args.name) throw new Error('name required');
        if (args.template && !(await allTemplates()).some((x) => x.id === args.template)) throw new Error(`no template "${args.template}" (GET /templates)`);
        if (args.arrangement && !TPL.ARRANGEMENTS.some((x) => x.id === args.arrangement)) throw new Error(`no arrangement "${args.arrangement}" (GET /arrangements)`);
        if (typeof args.timeSig === 'string') { const p = MT.parseTimeSig(args.timeSig); if (!p) throw new Error('timeSig must be like [7, 8], [13, 7] or "2+2+3/8" (1–64 over 1–64)'); args.timeSig = p; } if (args.timeSig !== undefined && JSON.stringify(TPL.validSig(args.timeSig).slice(0, 2)) !== JSON.stringify((args.timeSig || []).slice(0, 2).map(Number))) throw new Error('timeSig must be like [7, 8], [13, 7] or "2+2+3/8" (1–64 over 1–64)'); if (state.folder) { const ok = await closeSong({ interactive: false }); if (!ok) throw new Error('could not close the current song'); } const r = await bp.songs.create(args.name); await refreshSongs(); state.quietEmpty = true; try { await openSong(r.folder, { interactive: false }); } finally { state.quietEmpty = false; }
        if (args.template || args.arrangement || args.bpm || args.timeSig || args.key || args.tracks) {
          const all = await allTemplates(); let t = args.template ? all.find((x) => x.id === args.template) : TPL.BUILTIN.find((x) => x.id === 'blank');
          if (!t) throw new Error(`no template "${args.template}" (GET /templates)`);
          if (args.arrangement) { const a = TPL.ARRANGEMENTS.find((x) => x.id === args.arrangement); if (!a) throw new Error(`no arrangement "${args.arrangement}"`); t = { ...t, structure: a.structure }; }
          const ts = Array.isArray(args.timeSig) ? TPL.validSig(args.timeSig) : t.timeSig;
          await applyTemplate({ template: t, bpm: clamp(args.bpm, 30, 300, t.bpm), timeSig: ts, key: args.key !== undefined ? String(args.key) : (t.key || ''), click: args.click !== undefined ? !!args.click : !(t.tracks || []).includes('drums'),
            tracks: t.trackSetups ? null : (Array.isArray(args.tracks) ? args.tracks.filter((k) => TRACK_KINDS[k]) : t.tracks), trackSetups: t.trackSetups || null });
        }
        return { folder: r.folder, rev: state.song.rev, sections: liveSections().length, tracks: engine.tracks.length }; }
      case 'save': { need(); const r = args.force && state.pendingExternal && state.pendingExternal.conflict && !state.readOnly ? await overwriteKeepingTheirs(state.pendingExternal.savedBy) : await save({ force: !!args.force });   // force after a conflict = "Save mine, keep their takes", never a blind overwrite
        return { result: r, rev: state.song.rev, dirty: state.dirty || state.pendingTakes.size > 0, pendingTakes: [...state.pendingTakes.keys()], conflict: r === 'conflict' ? state.pendingExternal : null, error: state.lastSaveError }; }
      case 'reload': need(); state.dirty = false; state.pendingExternal = null; await reloadFromDisk(); return { rev: state.song.rev };
      case 'takeOver': need(); await takeOver({ interactive: false }); return { readOnly: state.readOnly };
      case 'snapshot': { need(); const s = { id: window.BPUtil.newId(), label: String(args.label || 'snapshot').slice(0, 60), at: new Date().toISOString(), json: JSON.stringify(collectSong()) }; state.snapshots.push(s); if (state.snapshots.length > 30) state.snapshots.shift(); return { id: s.id, label: s.label, at: s.at }; }
      case 'snapshots': return state.snapshots.map((s) => ({ id: s.id, label: s.label, at: s.at }));
      case 'restore': { writable(); const s = state.snapshots.find((x) => x.id === args.id); if (!s) throw new Error(`no snapshot ${args.id}`); const cur = { id: window.BPUtil.newId(), label: `before restore of ${s.label}`, at: new Date().toISOString(), json: JSON.stringify(collectSong()) }; state.snapshots.push(cur); pushUndo('assistant: restore snapshot'); await restoreSnapshot(s.json); return { restored: s.id, autoSnapshot: cur.id, rev: state.song.rev }; }
      case 'mix': {
        writable();
        const plan = (args.tracks || []).map((tp) => { const bad = Object.keys(tp).filter((k) => !['id', 'name', ...MIX_KEYS].includes(k)); if (bad.length) throw new Error(`/mix does not accept ${bad.join(', ')} (use /song/patch for clips)`); const patch = {}; for (const k of MIX_KEYS) if (tp[k] !== undefined) patch[k === 'rename' ? 'name' : k] = tp[k]; return { t: tid(tp), patch }; });
        pushUndo('assistant: mix change');
        for (const { t, patch } of plan) engine.updateTrack(t.id, patch);
        if (args.master) engine.setMaster(args.master);
        markDirty(); renderAll();
        return { applied: plan.map((p) => p.t.id), tracks: engine.tracks.map((t) => ({ id: t.id, name: t.name, gainDb: t.gainDb, pan: t.pan, mute: t.mute, solo: t.solo, fx: t.fx })), master: engine.master };
      }
      case 'patchSong': {
        writable();
        if (args.timeSig !== undefined && (typeof args.timeSig === 'string' ? !MT.parseTimeSig(args.timeSig) : JSON.stringify(validTimeSig(args.timeSig).slice(0, 2)) !== JSON.stringify([Number(args.timeSig[0]), Number(args.timeSig[1])]))) throw new Error('timeSig must be like [7, 8], [13, 7] or "2+2+3/8" (1–64 over 1–64)');
        if (args.bpm !== undefined && (num(args.bpm, NaN) < 30 || num(args.bpm, NaN) > 300)) throw new Error('bpm must be 30-300');
        if (args.removeTrack !== undefined && !engine.track(args.removeTrack)) throw new Error(`no track ${args.removeTrack}`);
        if (args.addTrack && args.addTrack.kind && !TRACK_KINDS[args.addTrack.kind]) throw new Error(`addTrack.kind must be one of ${Object.keys(TRACK_KINDS).join(', ')}`);
        const clipTargets = [];
        for (const cp of args.clips || []) { let found = null; for (const t of engine.tracks) { const c = t.clips.find((x) => x.id === cp.id); if (c) found = { t, c }; } if (!found) throw new Error(`no clip ${cp.id}`); clipTargets.push({ ...found, cp }); }
        pushUndo('assistant: song change');
        if (args.bpm !== undefined) { engine.setBpm(args.bpm); $('#bpm').value = engine.bpm; }
        if (args.key !== undefined) { const k = String(args.key || ''); if (k && !MU.parseKey(k)) throw new Error(`unknown key "${k}"`); if (k) state.song.key = k; else delete state.song.key; }
        if (args.stage !== undefined) { if (args.stage && !STAGES[args.stage]) throw new Error('stage must be idea | writing | demo | done | null'); if (args.stage) state.song.stage = args.stage; else delete state.song.stage; }
        if (args.timeSig !== undefined) engine.setTimeSig(typeof args.timeSig === 'string' ? MT.parseTimeSig(args.timeSig) : args.timeSig); syncTsSelect();
        if (args.notes !== undefined) $('#notes').value = String(args.notes);
        if (args.loop) { engine.setLoop(args.loop); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); }
        if (args.addTrack) { if (args.addTrack.kind) { const u = state.undo.length; addTrackOfKind(args.addTrack.kind, args.addTrack.name); while (state.undo.length > u) state.undo.pop(); } else engine.addTrack(args.addTrack.name, args.addTrack.color); }
        if (args.removeTrack !== undefined) { const rt = engine.track(args.removeTrack); for (const c of rt.clips) trashClip(rt, c); state.song.trashTracks = { ...(state.song.trashTracks || {}), [rt.id]: rt.name }; engine.removeTrack(args.removeTrack); }
        for (const { t, c, cp } of clipTargets) { if (cp.delete) { const s0 = c.link ? mirrorSource(c) : null; const dt = s0 ? s0.t : t, dc = s0 ? s0.c : c; dt.clips = dt.clips.filter((x) => x.id !== dc.id); trashClip(dt, dc); continue; } if (cp.start !== undefined) c.start = clamp(cp.start, 0, 1e6, c.start); if (cp.gainDb !== undefined) c.gainDb = clamp(cp.gainDb, -60, 12, c.gainDb); if (cp.trimStart !== undefined) c.trimStart = clamp(cp.trimStart, 0, Math.max(0, c.duration - 0.05), c.trimStart); if (cp.trimEnd !== undefined) c.trimEnd = clamp(cp.trimEnd, 0, Math.max(0, c.duration - c.trimStart - 0.05), c.trimEnd); if (cp.name !== undefined) c.name = String(cp.name).slice(0, 60); if (cp.mute !== undefined) c.mute = !!cp.mute; if (cp.fadeIn !== undefined) c.fadeIn = clamp(cp.fadeIn, 0, 30, 0); if (cp.fadeOut !== undefined) c.fadeOut = clamp(cp.fadeOut, 0, 30, 0); }
        for (const n of args.addNotes || []) { if (!n || !n.text) continue; if (n.trackId && !engine.track(n.trackId)) throw new Error(`no track ${n.trackId}`); (state.song.markers = state.song.markers || []).push({ id: window.BPUtil.newId(), trackId: n.trackId || null, time: clamp(n.time, 0, 1e6, engine.playhead), text: String(n.text).slice(0, 500), by: me(), at: new Date().toISOString() }); }
        for (const r of args.react || []) { if (!r || !r.target || !r.emoji) continue; const rs = state.song.reactions = state.song.reactions || []; const mine = rs.find((x) => !x.deleted && x.target === r.target && x.emoji === r.emoji && x.by === me()); if (mine) mine.deleted = true; else rs.push({ id: window.BPUtil.newId(), target: String(r.target), emoji: String(r.emoji).slice(0, 8), by: me(), at: new Date().toISOString() }); }
        markDirty(); renderAll(); if (args.removeTrack !== undefined || clipTargets.some((x) => x.cp.delete)) refreshUnreferenced();
        return collectSong();
      }
      case 'transport': {
        await engine.init();
        switch (args.action) {
          case 'play': engine.play(args.time !== undefined ? num(args.time, 0) : undefined); break;
          case 'stop': await stop(); break;
          case 'pause': engine.pause(); break;
          case 'seek': engine.seek(num(args.time, 0)); break;
          case 'record': writable(); await record(args.trackId || null); break;
          case 'loop': engine.setLoop({ ...(args.enabled != null ? { enabled: !!args.enabled } : {}), ...(args.start != null ? { start: args.start } : {}), ...(args.end != null ? { end: args.end } : {}) }); $('#loop-on').checked = engine.loop.enabled; loopBarsFromEngine(); drawRuler(); if (state.folder && !state.readOnly && (args.start != null || args.end != null)) markDirty(); break;
          case 'click': engine.click.on = !!args.enabled; $('#click-on').checked = engine.click.on; break;
          default: throw new Error(`unknown transport action ${args.action}`);
        }
        return engine.transportState();
      }
      case 'meters': return engine.ctx ? engine.meters() : { error: 'audio not initialised' };
      case 'analyze': {
        need(); await engine.init();
        const range = {}; if (args.from !== undefined) range.from = clamp(args.from, 0, 1e6, 0); if (args.to !== undefined) range.to = clamp(args.to, 0, 1e6, engine.songLength());
        const warn = state.missingClips.size ? { warning: `${state.missingClips.size} take(s) missing (not synced yet): ${[...state.missingClips].join(', ')}` } : {};
        if (args.clipId) return { clipId: args.clipId, ...warn, ...(await engine.analyzeClip(args.clipId)) };
        if (args.trackId) return { trackId: args.trackId, ...warn, ...(await engine.analyzeTrack(args.trackId, range)) };
        const out = { ...warn, range, mix: await engine.analyzeMix(range), tracks: {} };
        for (const t of engine.tracks) if (t.clips.length || t.instrument === 'drumkit') out.tracks[t.id] = { name: t.name, ...(await engine.analyzeTrack(t.id, range)) };
        return out;
      }
      case 'splitClip': { writable(); const f = findClip(args.clipId); if (!f) throw new Error('clip not found'); const r = splitClip(f.t, f.c, num(args.at, engine.playhead)); if (!r) throw new Error('split point must be inside the take'); return { left: f.c.id, right: r.id }; }
      case 'duplicateClip': { writable(); const f = findClip(args.clipId); if (!f) throw new Error('clip not found'); duplicateClip(f.t, f.c); return { clipId: state.selectedClip }; }
      case 'exportDaw': need(); return exportDaw({ what: args.what || 'all', name: args.name || null, allowMissing: !!args.allowMissing });
      case 'bounce': need(); return { files: await bounce(args.what === 'stems' ? 'stems' : 'mix', args.name, { allowMissing: !!args.allowMissing }) };
      case 'importClip': { writable(); if (!args.path) throw new Error('path required'); const ab = await bp.audio.readFile(args.path); return importClip({ trackId: args.trackId, arrayBuffer: ab, name: args.name || String(args.path).split(/[\\/]/).pop(), start: args.start }); }
      case 'presets': { const PR = window.BPPresets; const type = args.type; return { types: PR.TYPES, presets: type ? (PR.PRESETS[type] || []).map((p) => ({ name: p.name, blurb: p.blurb, fx: p.fx })) : Object.fromEntries(Object.entries(PR.PRESETS).map(([k, v]) => [k, v.map((p) => ({ name: p.name, blurb: p.blurb }))])), instruments: PR.INSTRUMENTS, drumKits: PR.DRUM_KITS, drumPatterns: Object.keys(PR.DRUM_PATTERNS), ampModels: window.BPEngine.AMP_MODELS, cabs: window.BPEngine.CABS }; }
      case 'applyPreset': { writable(); const t = tid(args); if (args.type && !window.BPPresets.TYPES.includes(args.type)) throw new Error(`unknown type ${args.type}`); const r = applyPreset(t.id, args.preset, args.type); return { trackId: r.id, type: r.type, preset: r.preset, fx: r.fx }; }
      case 'drums': { writable(); const t = tid(args); if (t.instrument !== 'drumkit' && !args.enable) throw new Error('track is not a drum machine; pass "enable":true to make it one'); const drum = { ...(t.drum || window.BPEngine.DEFAULT_DRUM()) }; for (const k of ['kit', 'pattern', 'custom', 'swing', 'bars', 'offsetBars', 'gainDb']) if (args[k] !== undefined) drum[k] = args[k]; if (args.pattern !== undefined && args.custom === undefined) drum.custom = null; if (drum.pattern && !window.BPPresets.DRUM_PATTERNS[drum.pattern] && !drum.custom) throw new Error(`unknown pattern "${drum.pattern}"`); if (!window.BPSynth.KITS[drum.kit]) throw new Error(`unknown kit "${drum.kit}"`); pushUndo('assistant: drums'); engine.updateTrack(t.id, { instrument: 'drumkit', type: 'drums', drum }); markDirty(); renderAll(); return { trackId: t.id, drum: engine.track(t.id).drum }; }
      case 'midiNotes': {
        writable(); const t = tid(args); if (!t.instrument.startsWith('synth:')) throw new Error('track source is not a synth; set instrument first (e.g. "synth:bass")');
        const notes = (args.notes || []).map((n) => ({ t: num(n.t, 0), d: num(n.d, 0.25), n: Math.round(num(n.n, 60)), v: num(n.v, 0.8) }));
        if (!notes.length) throw new Error('notes required: [{t (s from clip start), d (s), n (midi note), v (0-1)}]; or use beats:true to give t/d in beats');
        if (args.beats) for (const n of notes) { n.t *= engine.beatLen(); n.d *= engine.beatLen(); }
        pushUndo('assistant: midi notes');
        const clip = { id: window.BPUtil.newId(), kind: 'midi', name: String(args.name || 'midi').slice(0, 60), start: num(args.start, engine.playhead) * (args.beats && args.start !== undefined ? engine.beatLen() : 1), gainDb: 0, trimStart: 0, trimEnd: 0, duration: 0, notes };
        const norm = window.BPEngine.normalizeTrack({ id: t.id, clips: [clip] }).clips[0];
        t.clips.push(norm); state.selectedTrack = t.id; state.selectedClip = norm.id; markDirty(); renderAll();
        return { trackId: t.id, clip: norm };
      }
      case 'quantize': { writable(); let found = null; for (const t of engine.tracks) { const c = t.clips.find((x) => x.id === args.clipId); if (c) found = c; } if (!found || found.kind !== 'midi') throw new Error('midi clip not found'); pushUndo('assistant: quantize'); engine.quantizeClip(found, clamp(args.division, 1 / 32, 4, 0.25), clamp(args.strength, 0, 1, 1)); markDirty(); renderAll(); return { clipId: found.id, notes: found.notes.length }; }
      case 'playNote': { need(); await engine.init(); const t = tid(args); engine.playNote(t.id, Math.round(num(args.note, 60)), clamp(args.vel, 0, 1, 0.8), clamp(args.dur, 0.05, 10, 0.5)); return { ok: true }; }
      case 'midiInputs': { await engine.init(); await engine.initMidi(); if (args.select !== undefined) { engine.selectMidiInput(args.select); state.settings = await bp.settings.set({ midiInputId: args.select || null }); } return { available: !!engine.midi.access, inputs: engine.midi.inputs, selected: engine.midi.selectedId }; }
      case 'relabelTakes': { writable(); const r = await syncTakeNames(); return { renamed: r }; }
      case 'unreferenced': need(); state.unreferenced = await bp.song.unreferenced(state.folder, referencedIds()); updateBadges(); return state.unreferenced;
      case 'attachTake': writable(); return attachTake(args);
      case 'transcribe': {
        writable(); let list = [];
        if (args.clipId) { const f = findClip(args.clipId); if (!f) throw new Error(`no clip ${args.clipId}`); list = [{ t: f.t, c: f.c.link ? (mirrorSource(f.c) || f).c : f.c }]; }
        else if (args.trackId) { const t = engine.track(args.trackId); if (!t) throw new Error(`no track ${args.trackId}`); list = t.clips.filter((c) => !c.link && !c.mute && c.kind !== 'midi').map((c) => ({ t, c })); }
        else list = engine.tracks.filter(isVocalTrack).flatMap((t) => t.clips.filter((c) => !c.link && !c.mute && c.kind !== 'midi').map((c) => ({ t, c })));
        if (args.model) { state.settings = await bp.settings.set({ asrModel: String(args.model) }); }
        const n = await transcribeClips(list, { replace: args.replace !== false });
        return { lines: n || 0, lyrics: liveLyrics().filter((l) => l.asr).map((l) => ({ id: l.id, time: l.time, text: l.text, words: (l.words || []).length })) };
      }
      case 'audioSettings': {
        await engine.init();
        const patch = {};
        if (args.recordOffsetMs !== undefined) patch.recordOffsetMs = args.recordOffsetMs === null ? null : clamp(args.recordOffsetMs, 0, 1000, 0);
        if (args.inputDeviceId !== undefined) patch.inputDeviceId = args.inputDeviceId || null;
        if (args.outputDeviceId !== undefined) patch.outputDeviceId = args.outputDeviceId || null;
        if (args.monitorFx !== undefined) patch.monitorFx = !!args.monitorFx;
        if (Object.keys(patch).length) {
          state.settings = await bp.settings.set(patch); await loadSettings();
          if (patch.recordOffsetMs === null) { engine.offsetManual = false; engine.recordOffsetMs = engine.autoOffsetMs(); }
          if (patch.monitorFx !== undefined) engine.setMonitorFx(patch.monitorFx);
          if (patch.outputDeviceId !== undefined) await engine.setOutput(patch.outputDeviceId);
          if (patch.inputDeviceId !== undefined && engine.stream) await engine.openInput(patch.inputDeviceId);
        }
        const inputs = await engine.listInputs().catch(() => []), outputs = await engine.listOutputs().catch(() => []);
        return { recordOffsetMs: engine.recordOffsetMs, offsetManual: !!engine.offsetManual, autoOffsetMs: engine.autoOffsetMs(), inputDeviceId: state.settings.inputDeviceId || null, outputDeviceId: state.settings.outputDeviceId || null, monitorFx: engine.monitorFx, sampleRate: engine.ctx.sampleRate, baseLatency: engine.ctx.baseLatency, outputLatency: engine.ctx.outputLatency, inputs, outputs };
      }
      case 'measureLatency': {
        await engine.init(); await bp.mic.ensure(); if (!engine.stream) await engine.openInput(state.settings.inputDeviceId);
        const r = await engine.measureLatency({ clicks: Math.max(4, Math.min(12, Number(args.clicks) || 6)) });
        if (args.apply) { state.settings = await bp.settings.set({ recordOffsetMs: Math.round(r.ms) }); await loadSettings(); }
        scheduleInputRelease(); return { ...r, applied: !!args.apply, recordOffsetMs: engine.recordOffsetMs };
      }
      case 'phoneState': {
        if (!state.folder || !state.song) return { song: null };
        const ls = karaLines(); const v = Math.abs([...kara.key].reduce((h, ch) => ((h * 31) + ch.charCodeAt(0)) | 0, 7)) || 1;
        const chords = liveChords().slice().sort((a, b) => a.time - b.time);
        const barsOf = (a, z) => { const out = []; let held = null; for (const c of chords) if (c.time <= a + 1e-6) held = c.chord; for (let x = a; x < z - 1e-3;) { const b = barLenAt(x + 1e-4); const e = Math.min(z, x + b); const inB = chords.filter((c) => c.time >= x - 1e-6 && c.time < e - 1e-6).map((c) => c.chord); out.push({ s: x, e, chords: inB, held: !!held }); if (inB.length) held = inB[inB.length - 1]; x = e; } return out; };
        const secs = liveSections().map((x) => ({ name: x.name, start: x.start, end: x.end, bars: barsOf(x.start, x.end) }));
        const pr = practice; const end = Math.max(engine.contentLength() || 0, ...liveSections().map((x) => x.end), 1);
        return { song: state.song.name, v, lines: args.since === v ? null : ls.map((l) => ({ time: l.time, end: l.end, section: l.section, words: l.words.map((w) => ({ w: w.w, t: w.t, e: w.e })), chords: (l.chords || []).map((c) => ({ chord: c.chord, wi: c.wi })) })),
          sections: secs, bars: secs.length ? null : barsOf(0, end), pos: kara.open ? karaTime() : (engine.playing ? engine.currentPos() : engine.playhead), playing: !!(engine.playing || pr), rate: pr ? pr.pct / 100 : 1,
          loop: pr ? { from: pr.from, to: pr.to } : engine.loop.enabled ? { from: engine.loop.start, to: engine.loop.end } : null, end, key: state.song.key || null, setlist: kara.setlist ? `song ${kara.setlist.i + 1}/${kara.setlist.order.length}` : null };
      }
      case 'phoneCmd': {
        const a = String(args.action || '');
        if (a === 'toggle') { if (kara.open) await karaToggle(); else if (engine.playing) { engine.pause(); positionPlayhead(); } else await play(); }
        else if (a === 'nextpart' || a === 'prevpart') { if (kara.open) karaPart(a === 'nextpart' ? 1 : -1); else { const ps = liveSections().map((x) => x.start).sort((x, y) => x - y); const t = engine.playing ? engine.currentPos() : engine.playhead; const to = a === 'nextpart' ? ps.find((x) => x > t + 0.05) : [...ps].reverse().find((x) => x < t - 1); if (to != null) { engine.seek(to); positionPlayhead(); } } }
        else if (a === 'nextsong' || a === 'prevsong') { if (kara.setlist) await karaGoSong(a === 'nextsong' ? 1 : -1); }
        else if (a === 'seek') { const t = Number(args.time) || 0; if (kara.open) karaSeek(t); else { engine.seek(t); positionPlayhead(); } }
        else throw new Error(`unknown action ${a}`);
        return { ok: true };
      }
      case 'workspace': { if (args.ws) setWorkspace(String(args.ws)); return { ws: state.ws, practice: kara.open }; }
      case 'chartAll': return chartAllSongs({ interactive: false });
      case 'chordsDetect': { writable(); const ts = Array.isArray(args.trackIds) ? args.trackIds.map((id) => engine.track(id)).filter(Boolean) : null; const n = await chordsFromTracks(ts, { replaceDrafts: args.replaceDrafts !== false }); return { added: n || 0, chords: liveChords().map((c) => ({ time: c.time, chord: c.chord, det: !!c.det })) }; }
      case 'autoMix': { writable(); const r = await autoMix(); return r ? { changes: r.lines, tracks: engine.tracks.map((t) => ({ id: t.id, name: t.name, gainDb: t.gainDb, pan: t.pan, fx: t.fx })) } : null; }
      case 'autoMaster': { writable(); const r = await autoMaster({ target: args.target != null ? Number(args.target) : -14 }); return r ? { gainDb: engine.master.gainDb, limiter: engine.master.limiter, expectedLufs: r.expectedLufs } : null; }
      case 'mixAB': { if (!state.mixAB) throw new Error('nothing to A/B yet — Auto mix first'); mixABToggle(); return { showing: state.mixAB.showing }; }
      case 'tighten': { writable(); const f = findClip(args.clipId); if (!f) throw new Error(`no take ${args.clipId}`); if (args.undo) { untighten(f.t, f.c); return { undone: true }; } const gi = GRIDS.find((x) => x[0] === (args.grid || '1/8')); if (!gi) throw new Error('grid must be one of ' + GRIDS.map((x) => x[0]).join(', ')); return doTighten(f.t, [f.c], { sub: gi[1], strength: args.strength != null ? Math.max(0.1, Math.min(1, Number(args.strength))) : 0.6 }, f.c); }
      case 'pitchCheck': { need(); const t = engine.track(args.trackId); if (!t) throw new Error(`no track ${args.trackId}`); const r = await pitchCheckTrack(t, args.clipId ? (findClip(args.clipId) || {}).c : null); return r ? { notes: r.results.map((x) => ({ t0: x.t0, t1: x.t1, target: x.target, off: Math.round(x.off), flag: x.flag })), report: r.report } : null; }
      case 'practice': { if (args.open === false) { closeKaraoke(); return { open: false }; } if (args.open) await openKaraoke(); if (args.show !== undefined) await setShow(!!args.show); if (args.step) await showStep(Number(args.step)); if (args.flush) practiceFlush(); return { open: kara.open, show: !!kara.show, song: state.folder, setlist: kara.setlist ? { i: kara.setlist.i, order: kara.setlist.order } : null }; }
      case 'openRefs': return { folder: state.folder || null, ids: state.folder ? [...referencedIds(), ...state.pendingTakes.keys()] : [] };
      case 'changes': return computeChanges(args.since || state.lastSeenAtOpen);
      case 'sharePart': { const sc = liveSections().find((x) => x.id === args.section || x.name === args.section); if (!sc) throw new Error(`no part ${args.section}`); return sharePart(sc, { copy: false }); }
      case 'comp': { const f = findClip(args.clipId); if (!f) throw new Error(`no take ${args.clipId}`); const r = compTake(f.t, f.c, Number(args.from), Number(args.to), args.what || 'the range'); return { changed: r ? r.changed : 0 }; }
      case 'quest': { await loadQuest(); if (!quest.board) throw new Error('no shared folder'); const b = quest.board; return { name: b.name, level: b.level, xp: b.xp, max: b.max, boss: b.boss, next: b.next, practice: b.practice, todos: b.todos, members: b.members.map((m) => ({ name: m.name, role: m.role, character: m.character || null, look: m.look || null, xp: m.xp, level: m.level, achievements: m.achievements, takes: m.takes, midi: m.midi, notes: m.notes, replies: m.replies, chords: m.chords, lyrics: m.lyrics, sections: m.sections, needsDone: m.needsDone, perSong: m.perSong })), songs: b.songs.map((s) => ({ qid: s.qid, name: s.name, folder: s.folder, xp: s.xp, max: s.max, goals: s.goals, parts: s.prog.map((p) => ({ member: p.member, pct: p.pct, written: p.written, takes: p.takes, midi: p.midi, xp: p.xp, manual: p.manual })), tasks: s.tasks, milestones: s.milestones })) }; }
      case 'questSet': {
        await loadQuest(); if (!quest.board) throw new Error('no shared folder'); const b = quest.board; const patch = {};
        const songOf = (x) => { const s = b.songs.find((y) => y.folder === x || y.name === x || y.qid === x); if (!s) throw new Error(`no song "${x}" on the board`); return s; };
        if (args.goal) { const s = songOf(args.goal.song); if (!Q.GOALS.some(([id]) => id === args.goal.id)) throw new Error('goal id must be title | structure | show'); patch[qKey(s, `goal:${args.goal.id}`)] = !!args.goal.done; }
        if (args.task) { const s = songOf(args.task.song); if (args.task.id) { const t = s.tasks.find((x) => x.id === args.task.id); if (!t) throw new Error(`no task ${args.task.id}`); patch[`song:${t.qid}:task:${t.id}`] = { text: t.text, done: args.task.done !== undefined ? !!args.task.done : t.done, who: t.who, ...(args.task.delete ? { deleted: true } : {}) }; } else { if (!args.task.text) throw new Error('task text required'); const mb = args.task.who ? Q.memberFor(b.members, args.task.who) : null; patch[qKey(s, `task:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`)] = { text: String(args.task.text).slice(0, 200), done: false, who: mb ? mb.name : args.task.who ? String(args.task.who).slice(0, 30) : null }; } }
        if (args.todo) { if (args.todo.id) { const t = (b.todos || []).find((x) => x.id === args.todo.id); if (!t) throw new Error(`no to-do ${args.todo.id}`); patch[`band:todo:${t.id}`] = { text: t.text, who: t.who, done: args.todo.done !== undefined ? !!args.todo.done : t.done, doneBy: args.todo.done ? me() : t.doneBy, ...(args.todo.delete ? { deleted: true } : {}) }; } else { if (!args.todo.text) throw new Error('todo.text'); const mb = args.todo.who ? Q.memberFor(b.members, args.todo.who) : null; patch[`band:todo:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`] = { text: (mb ? String(args.todo.text).replace(/\s*@\w+/, '') : String(args.todo.text)).trim().slice(0, 200) || String(args.todo.text).slice(0, 200), done: false, who: mb ? mb.name : args.todo.who ? String(args.todo.who).slice(0, 30) : null }; } }
        if (args.boss !== undefined) patch['band:boss'] = args.boss ? { title: String(args.boss.title || '').slice(0, 80), date: /^\d{4}-\d\d-\d\d$/.test(String(args.boss.date || '')) ? args.boss.date : '', songs: (args.boss.songs || []).map((x) => songOf(x).qid) } : null;
        if (args.next !== undefined) patch['band:next'] = String(args.next || '').slice(0, 200);
        if (args.manual) { const s = songOf(args.manual.song); const mb = Q.memberFor(b.members, args.manual.member); if (!mb) throw new Error(`no member ${args.manual.member}`); patch[qKey(s, `m:${mb.name}:${s.folder ? 'manual' : 'pct'}`)] = args.manual.pct == null ? null : Q.clampPct(args.manual.pct); }
        if (!Object.keys(patch).length) throw new Error('nothing to set'); await questWrite(patch); return { ok: true, xp: quest.board.xp };
      }
      case 'collab': { need(); const sg = collectSong(); return { sections: liveSections(), chords: liveChords(), lyrics: lyricsOrdered(), needs: liveNeeds(), notes: liveNotes().map((m) => ({ ...m, replies: CB.live(m.replies), section: (CB.sectionAt(sg, m.time) || {}).name || null })), votes: CB.live(CB.list(sg, 'votes')), ideas: liveIdeas(), versions: liveVersions(), activity: CB.feed(sg).slice(0, 100), pendingActivity: state.pendingActivity, presence: (state.songs.find((x) => x.folder === state.folder) || {}).presence || [], people: people(), mentionsForMe: CB.mentionsFor(sg, me(), { knownNames: people().concat(me()) }).map((x) => ({ noteId: x.note.id, by: x.by, text: x.text })), ab: state.ab ? { id: state.ab.id, name: state.ab.name } : null }; }
      case 'sections': {
        writable(); const b = barLen(); const out = [];
        const sec = (x, k, bk) => (x[bk] !== undefined ? (bk === 'endBar' ? barSec(num(x[bk], 1)) : barSec(num(x[bk], 1) - 1)) : clamp(x[k], 0, 1e6, 0)); void b;
        for (const id of args.remove || []) { const s0 = liveSections().find((x) => x.id === id); if (!s0) throw new Error(`no section ${id}`); }
        for (const a of args.add || []) if (!a || !a.name) throw new Error('every added section needs a name');
        for (const u of args.update || []) if (!liveSections().find((x) => x.id === u.id)) throw new Error(`no section ${u.id}`);
        change(() => {
          for (const id of args.remove || []) { const s0 = liveSections().find((x) => x.id === id); s0.deleted = true; s0.deletedBy = me(); }
          for (const u of args.update || []) { const s0 = liveSections().find((x) => x.id === u.id); if (u.name) s0.name = String(u.name).slice(0, 40); if (u.start !== undefined || u.startBar !== undefined) s0.start = sec(u, 'start', 'startBar'); if (u.end !== undefined || u.endBar !== undefined) s0.end = sec(u, 'end', 'endBar'); if (u.color) s0.color = String(u.color).slice(0, 9); if (u.key !== undefined) { if (u.key && !MU.parseKey(u.key)) throw new Error(`unknown key ${u.key}`); if (u.key) s0.key = String(u.key); else delete s0.key; } out.push(s0.id); }
          for (const a of args.add || []) { if (!a.name) throw new Error('section needs a name'); const st = sec(a, 'start', 'startBar'); const en = a.end !== undefined || a.endBar !== undefined ? sec(a, 'end', 'endBar') : barSec(barIdx(st) + 8); if (en <= st) throw new Error(`section ${a.name}: end must be after start`); const n = { id: newId(), name: String(a.name).slice(0, 40), start: st, end: en, by: me(), at: nowIso(), ...(a.color ? { color: String(a.color).slice(0, 9) } : {}) }; (state.song.sections = state.song.sections || []).push(n); out.push(n.id); }
        }, { label: 'assistant: sections' });
        renderAll(); return { changed: out, sections: liveSections() };
      }
      case 'chords': {
        writable(); const b = barLen(); const out = [];
        if (args.bars) { const n = setChordBars(Math.max(1, Math.round(num(args.fromBar, 1))), String(args.bars)); out.push(`${n} chords`); }
        if (args.clear || args.remove || args.set) change(() => {
          if (args.clear) for (const c of liveChords()) { c.deleted = true; c.deletedBy = me(); }
          for (const id of args.remove || []) { const c = liveChords().find((x) => x.id === id); if (c) { c.deleted = true; c.deletedBy = me(); } }
          for (const x of args.set || []) { if (!x || !x.chord) continue; const t = x.bar !== undefined ? barSec(num(x.bar, 1) - 1) : clamp(x.time, 0, 1e6, 0); void b; const ex = liveChords().find((c) => Math.abs(c.time - t) < 1e-3); if (ex) ex.chord = String(x.chord).slice(0, 12); else (state.song.chords = state.song.chords || []).push({ id: newId(), time: t, chord: String(x.chord).slice(0, 12), by: me(), at: nowIso() }); }
        }, { label: 'assistant: chords' });
        renderAll(); return { chords: liveChords(), notes: out };
      }
      case 'lyrics': {
        writable(); const b = barLen();
        if (args.text) addLyricLines(String(args.text));
        if (args.add || args.pin || args.update || args.remove) change(() => {
          for (const a of args.add || []) { if (!a || !a.text) continue; const t = a.bar !== undefined ? barSec(num(a.bar, 1) - 1) : a.time !== undefined && a.time !== null ? clamp(a.time, 0, 1e6, 0) : null; (state.song.lyrics = state.song.lyrics || []).push({ id: newId(), time: t, text: String(a.text).slice(0, 200), by: me(), at: nowIso() }); }
          if (args.pin) { const l = liveLyrics().find((x) => x.id === args.pin.id); if (!l) throw new Error(`no lyric ${args.pin.id}`); l.time = clamp(args.pin.time, 0, 1e6, engine.playhead); }
          for (const u of args.update || []) { const l = liveLyrics().find((x) => x.id === u.id); if (!l) throw new Error(`no lyric ${u.id}`); if (u.text !== undefined) l.text = String(u.text).slice(0, 200); if (u.time !== undefined) l.time = u.time === null ? null : clamp(u.time, 0, 1e6, 0); }
          for (const id of args.remove || []) { const l = liveLyrics().find((x) => x.id === id); if (l) { l.deleted = true; l.deletedBy = me(); } }
        }, { label: 'assistant: lyrics' });
        renderAll(); return { lyrics: lyricsOrdered() };
      }
      case 'needs': {
        writable();
        for (const t of args.add || []) addNeed(typeof t === 'string' ? t : t.text, typeof t === 'string' ? {} : { who: t.who || null, sectionId: t.sectionId || null });
        const find = (id) => { const n = liveNeeds().find((x) => x.id === id); if (!n) throw new Error(`no need ${id}`); return n; };
        for (const id of args.done || []) setNeedDone(find(id), true);
        for (const id of args.undone || []) setNeedDone(find(id), false);
        for (const a of args.assign || []) assignNeed(find(a.id), a.who || null);
        if ((args.remove || []).length) { change(() => { for (const id of args.remove) { const n = find(id); n.deleted = true; n.deletedBy = me(); } }, { label: 'assistant: needs' }); renderAll(); }
        return { needs: liveNeeds() };
      }
      case 'noteReply': { writable(); const m = liveMarker(args.noteId); if (!m) throw new Error(`no note ${args.noteId}`); if (!args.text) throw new Error('text required'); const r = replyTo(m, String(args.text).slice(0, 1000)); renderAll(); return { noteId: m.id, reply: r }; }
      case 'noteResolve': { writable(); const m = liveMarker(args.noteId); if (!m) throw new Error(`no note ${args.noteId}`); setResolved(m, args.resolved !== false); return { noteId: m.id, resolved: !!m.resolved }; }
      case 'vote': { writable(); const f = findClip(args.clipId); if (!f) throw new Error(`no clip ${args.clipId}`); toggleVote(f.t, f.c); const c = findClip(args.clipId).c; return { clipId: c.id, stars: CB.votesFor(state.song, c.id).length, mine: !!myVote(c.id), mute: !!c.mute }; }
      case 'idea': {
        writable();
        if (args.path) { const ab = await bp.audio.readFile(args.path); return saveIdeaAudio(ab, args.title || String(args.path).split(/[\\/]/).pop()); }
        if (!args.text) throw new Error('text or path required');
        let i = null; change(() => { i = { id: newId(), title: String(args.title || args.text).slice(0, 40), kind: 'text', text: String(args.text).slice(0, 2000), by: me(), at: nowIso() }; (state.song.ideas = state.song.ideas || []).push(i); }, { label: 'assistant: idea' }); renderAll(); return i;
      }
      case 'version': {
        writable();
        if (args.restore) { const v = liveVersions().find((x) => x.id === args.restore); if (!v) throw new Error(`no version ${args.restore}`); const vs = await bp.song.readVersion(state.folder, v.id); pushUndo(`assistant: restore version ${v.name}`); await loadAudio(state.folder, vs); await restoreSnapshot(JSON.stringify({ ...takesOnly(vs), notes: $('#notes').value })); logActivity(`restored version "${v.name}"`); return { restored: v.id }; }
        if (!args.name) throw new Error('name required'); return tagVersion(args.name);
      }
      case 'versions': need(); return liveVersions();
      case 'history': need(); return bp.song.listHistory(state.folder).then((h) => h.map(({ rev, saveId }) => ({ rev, saveId })));
      case 'rollback': {
        writable(); if (!/^[a-f0-9]{12}$/i.test(String(args.saveId || ''))) throw new Error('saveId required (GET /history)');
        if (state.ab) await leaveAB({ silent: true });
        const body = await bp.song.readHistory(state.folder, args.saveId);
        pushUndo('assistant: roll back'); await loadAudio(state.folder, body);
        await restoreSnapshot(JSON.stringify(args.everything ? body : takesOnly(body)));
        logActivity(`rolled back${args.everything ? ' everything' : ''} to rev ${body.rev}`);
        return { rolledBackTo: body.rev, dirty: true };
      }
      case 'link': {
        writable(); const ty = TPL.sectionType(args.type || ''); if (!ty) throw new Error('type required, e.g. "chorus"');
        if (args.on === false) { await unlinkGroup(ty); return { linked: false }; }
        const same = liveSections().filter((x) => TPL.sectionType(x.name) === ty); if (same.length < 2) throw new Error(`need at least two ${ty} sections to link`);
        const others = same.slice().sort((a, b) => a.start - b.start).slice(1).filter((x) => !x.unlinked && clipsIn(x).length);
        change(() => { state.song.linkGroups = { ...(state.song.linkGroups || {}), [ty]: true }; if (args.keepOthers) for (const x of others) x.unlinked = true; }, { label: `linked ${plural(ty)}` });
        renderAll(); const g = TPL.linkInfo(collectSong())[ty]; return { room: g.room.id, followers: g.followers.map((f) => f.id), mirrors: engine.tracks.reduce((n, t) => n + t.clips.filter((c) => c.link).length, 0) };
      }
      case 'unlinkSection': { writable(); const sec = liveSections().find((x) => x.id === args.sectionId); if (!sec) throw new Error(`no section ${args.sectionId}`); if (args.relink) { change(() => { delete sec.unlinked; }, { label: `re-linked ${sec.name}` }); } else await unlinkSection(sec); renderAll(); return { unlinked: !!sec.unlinked }; }
      case 'room': { need(); if (args.leave) { leaveRoom(); return { room: null }; } const sec = liveSections().find((x) => x.id === args.sectionId || x.name === args.name); if (!sec) throw new Error('no such section'); openRoom(sec); return { room: sec.id, loop: { ...engine.loop } }; }
      case 'melody': {
        writable(); if (!args.text) throw new Error('text required (one line per phrase)');
        const windows = melodyWindowOptions(); let win;
        if (args.sectionId) win = windows.find((x) => x.id === args.sectionId); else if (args.from !== undefined) win = { id: 'bars', label: 'bars', w0: num(args.from, 0), w1: num(args.to, barSec(barIdx(num(args.from, 0)) + 8)), type: '' }; else win = windows[0];
        if (!win) throw new Error('no such section');
        const lines = ML.syllables(String(args.text)); if (!lines.length) throw new Error('no syllables in text');
        const key = keyAt(win.w0 + 0.01) || songKeyOrGuess() || 'C';
        const g = ML.generate({ lines, seconds: win.w1 - win.w0, bpm: meterAt(win.w0 + 1e-4).bpm, timeSig: meterAt(win.w0 + 1e-4).timeSig, key, sectionType: win.type, voice: args.voice || 'mid', density: args.density || 'auto', seed: Number.isFinite(Number(args.seed)) ? Number(args.seed) : undefined, chordAt: (sec) => { const c = CB.chordAt(state.song, win.w0 + sec); return c && !c.deleted ? c.chord : null; } });
        g.win = win; g.key = key; g.text = String(args.text);
        state.mel = { windows, gen: null, clipId: null, kept: [], replaced: [], done: [], origIds: new Set() }; const vsel = $('#ml-voice'); vsel.value = args.voice || 'mid';
        applyMelodyDraft(g); if (args.place) placeMelodyLyrics(g); state.mel = null;
        return { seed: g.seed, key, score: g.score, syllables: g.notes.length, notes: g.notes, lines: lines.map((l) => l.map((x) => x.text).join('·')) };
      }
      case 'transpose': { writable(); const sec = args.sectionId ? liveSections().find((x) => x.id === args.sectionId) : null; if (args.sectionId && !sec) throw new Error(`no section ${args.sectionId}`); await transposeSong(num(args.semis, 0), sec); return { key: state.song.key || '', sectionKey: sec ? sec.key || '' : undefined }; }
      case 'drumPart': {
        writable(); const windows = melodyWindowOptions(); const win = args.sectionId ? windows.find((x) => x.id === args.sectionId) : windows[0]; if (!win) throw new Error('no such section');
        const hits = Array.isArray(args.hits) ? args.hits.filter((h) => DR.NOTE[h.voice]).map((h) => ({ t: num(h.t, 0), voice: h.voice, vel: Math.max(0.2, Math.min(1, num(h.vel, 0.8))) })) : DR.generate({ seconds: win.w1 - win.w0, bpm: meterAt(win.w0 + 1e-4).bpm, timeSig: meterAt(win.w0 + 1e-4).timeSig, style: args.style || DR.styleFor(state.song.style), sectionType: win.type, intensity: args.feel || 'normal', seed: Number.isFinite(Number(args.seed)) ? Number(args.seed) : undefined });
        state.dr = { windows, win, hits, hist: [], orig: {}, edited: new Set(), undoLen: state.undo.length, touched: false }; drCommit(); const t = drumTrack(false); const c = drumClipAt(t, win); state.dr = null;
        return { trackId: t.id, clipId: c.id, hits: hits.length, notes: c.notes.length };
      }
      case 'detectKey': { need(); const sec = args.sectionId ? liveSections().find((x) => x.id === args.sectionId) : null; if (args.sectionId && !sec) throw new Error(`no section ${args.sectionId}`); const r = await hearKey(sec ? [sec.start, sec.end] : null); if (args.apply && r.key) { writable(); if (sec) setSectionKey(sec, r.key); else setSongKey(r.key, 'heard'); } return { key: r.key, runnerUp: r.runnerUp || '', confidence: Math.round((r.confidence || 0) * 100) / 100, source: r.source }; }
      case 'partKey': {
        const p = (await bp.parts.list()).find((x) => x.id === args.partId); if (!p) throw new Error(`no part ${args.partId}`);
        if (args.detect) { await redetectPartKey(p); const q = (await bp.parts.list()).find((x) => x.id === args.partId); return { key: q.key, source: q.keySource, confidence: q.keyConfidence }; }
        if (!MU.parseKey(args.key)) throw new Error('key required, e.g. "Em"'); await setPartKey(p, args.key); return { key: args.key };
      }
      case 'partTags': { const p = (await bp.parts.list()).find((x) => x.id === args.partId); if (!p) throw new Error(`no part ${args.partId}`); const patch = {}; if (Array.isArray(args.tags)) patch.tags = args.tags.map((x) => String(x).trim().toLowerCase().slice(0, 24)).filter(Boolean).slice(0, 12); if (args.style !== undefined) patch.style = String(args.style || ''); await setPartMeta(p, patch); return { tags: p.tags || [], style: p.style || '' }; }
      case 'parts': return (await bp.parts.list()).map((p) => ({ id: p.id, name: p.name, by: p.by, style: p.style || '', tags: p.tags || [], bpm: p.bpm, timeSig: p.timeSig || [4, 4], key: p.key, keySource: p.keySource || null, keyConfidence: p.keyConfidence, bars: p.bars, tracks: (p.tracks || []).map((t) => t.name), from: p.from }));
      case 'savePart': {
        need(); if (!args.name) throw new Error('name required');
        let o = {}; if (args.sectionId) { const sc = liveSections().find((x) => x.id === args.sectionId); if (!sc) throw new Error('no such section'); o = { section: sc }; }
        else if (args.clipId) { const f = findClip(args.clipId); if (!f) throw new Error('no such clip'); o = { clip: f.c, track: f.t }; }
        else o = { from: args.from, to: args.to };
        const p = await savePartFrom({ ...o, name: args.name }); return { id: p.id, bpm: p.bpm, key: p.key, bars: p.bars };
      }
      case 'dropPart': {
        writable(); const p = (await bp.parts.list()).find((x) => x.id === args.partId); if (!p) throw new Error(`no part ${args.partId} (GET /parts)`);
        let at = args.at !== undefined ? num(args.at, 0) : engine.playhead; if (args.sectionId) { const sc = liveSections().find((x) => x.id === args.sectionId); if (!sc) throw new Error('no such section'); at = sc.start; }
        return dropPart(p, { at, conform: args.conform !== false });
      }
      case 'chart': need(); return { text: chartText(num(args.transpose, 0)) };
      case 'arrangements': return (await arrangementChoices()).map((a) => ({ id: a.id, style: a.group, name: a.name, blurb: a.blurb, sections: TPL.numberSections(a.structure).map(([n, b]) => `${n}:${b}`) }));
      case 'restructure': {
        writable(); let arr;
        if (args.arrangement) { arr = (await arrangementChoices()).find((a) => a.id === args.arrangement); if (!arr) throw new Error(`no arrangement "${args.arrangement}" (GET /arrangements)`); }
        else if (Array.isArray(args.structure) && args.structure.length) { arr = { id: 'custom', name: 'custom structure', structure: TPL.normalizeStructure(args.structure) }; if (!arr.structure.length) throw new Error('structure has no valid [name, bars] slots'); }
        else throw new Error('arrangement or structure required');
        if (!liveSections().length) throw new Error('the song has no labelled sections — add some first (POST /sections)');
        const r = args.dryRun ? restructurePreview(arr) : applyRestructure(arr);
        if (!r) throw new Error('could not restructure (A/B or read-only?)');
        return { applied: !args.dryRun, length: r.length, sections: r.sections.map((x, i) => ({ name: x.name, start: x.start, end: x.end, from: r.report.slots[i].from })), report: { ...r.report } };
      }
      case 'tempo': { writable(); if (!Number.isFinite(Number(args.bpm))) throw new Error('bpm required'); await setTempo(Number(args.bpm), { mode: args.keepTakes ? 'grid' : 'auto' }); return { bpm: engine.bpm }; }
      case 'templates': return (await allTemplates()).map((t) => ({ id: t.id, name: t.name, blurb: t.blurb, bpm: t.bpm, timeSig: t.timeSig, band: !!t.band, sections: TPL.numberSections(t.structure).map(([n, b]) => `${n}:${b}`), tracks: t.trackSetups ? t.trackSetups.map((x) => x.name) : t.tracks }));
      case 'saveTemplate': {
        if (!args.name) throw new Error('name required'); const folder = args.folder || state.folder; if (!folder) throw new Error('no song open and no folder given');
        const song = folder === state.folder ? collectSong() : (await bp.song.peek(folder)).song;
        const tpl = TPL.fromSong(song, args.name, me()); await bp.templates.write(tpl); return { id: tpl.id, sections: tpl.structure.length, tracks: tpl.trackSetups.length };
      }
      case 'saveForQuit': {
        if (engine.recording) await finishRecording().catch(() => {});
        await flushSketch().catch(() => {});
        if (finishing) await finishing.catch(() => {});
        if (state.folder && (state.dirty || state.pendingTakes.size)) {
          const r = state.readOnly ? 'readonly' : await save();
          if (r !== 'ok' || !saved()) { try { await bp.song.backup(state.folder, collectSong(), [...state.pendingTakes].map(([clipId, p]) => ({ clipId, trackId: p.trackId, clip: p.clip, wav: p.wav, crash: p.crash || null }))); } catch (_) {} }   // never clobber a bandmate at quit; keep a local copy instead
        }
        return {};
      }
      default: throw new Error(`unknown op ${op}`);
    }
  });

  window.bandpadDebug = { engine, state, kara: () => kara, timingReport: (id) => timingReport(engine.track(id), null), closeSong, addNote, insertSongPart, songPartList, renderAll: () => renderAll(), editTrack: (id, patch) => change(() => engine.updateTrack(id, patch), { label: `edit ${(engine.track(id) || {}).name}` }), mineT, heldBy, unlockAll, lockAll, rollAt: (i) => { const G = rollGeom(); const z = G && G.g.notes[i]; if (!z) return null; const r = RC.cv().getBoundingClientRect(); return { x: r.left + (G.xOf(z.t) + Math.max(G.xOf(z.t) + 3, G.xOf(z.t + z.d))) / 2, y: r.top + G.yOf(z.n) + G.rowH / 2, rowH: G.rowH, grid: G.grid, pxPerSec: (G.w - G.gut) / G.W, left: r.left, top: r.top, gut: G.gut, topPad: G.top }; } };
  // ---------- boot ----------
  (async () => {
    await loadSettings();
    await refreshSongs();
    try { await engine.init(); if (state.settings.recordOffsetMs != null) engine.recordOffsetMs = state.settings.recordOffsetMs; if (state.settings.clickOutputId) engine.setClickOutput(state.settings.clickOutputId).catch(() => {}); } catch (err) { fail(err); }
    engine.initMidi().then(() => { if (state.settings.midiInputId) engine.selectMidiInput(state.settings.midiInputId); }).catch(() => {});
    meterLoop();
    bp.api.ready();
    setTimeout(() => { if (!state.folder) checkCrashRecordings().catch(() => {}); }, 1500);
    try { if (!localStorage.getItem('bp.seen014')) { localStorage.setItem('bp.seen014', '1'); setTimeout(() => toast('New layout: Write · Record · Mix · Practice · Band up top (Ctrl+1–5). Each one shows just what that job needs — recording tools in Record, Auto mix in Mix, the band page in Band. Share ▾ and ⋯ on the song hold bounce / DAW / phone / folder.', { kind: 'ok', ms: 20000 }), 2500); } } catch (_) {}
    if (!state.settings.sharedFolder || !state.settings.displayName) { openSettings(); if (!state.settings.displayName) setTimeout(() => $('#s-name').focus(), 50); }
  })();
})();
