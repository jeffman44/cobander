'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('bandpad', {
  platform: process.platform,
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  },
  songs: {
    list: () => ipcRenderer.invoke('songs:list'),
    create: (name) => ipcRenderer.invoke('songs:create', name),
    check: (name) => ipcRenderer.invoke('songs:check', name),
    onChanged: on('songs:changed'),
  },
  parts: {
    list: () => ipcRenderer.invoke('parts:list'),
    save: (folder, part, audioIds) => ipcRenderer.invoke('parts:save', folder, part, audioIds),
    readAudio: (id) => ipcRenderer.invoke('parts:readAudio', id),
    remove: (id) => ipcRenderer.invoke('parts:delete', id),
    writeAudio: (id, buf) => ipcRenderer.invoke('parts:writeAudio', id, buf),
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    write: (t) => ipcRenderer.invoke('templates:write', t),
    remove: (id) => ipcRenderer.invoke('templates:delete', id),
  },
  asr: {
    cacheGet: (url) => ipcRenderer.invoke('asr:cacheGet', url),
    cachePut: (url, buf) => ipcRenderer.invoke('asr:cachePut', url, buf),
    cacheInfo: () => ipcRenderer.invoke('asr:cacheInfo'),
  },
  quest: {
    read: () => ipcRenderer.invoke('quest:read'),
    write: (patch) => ipcRenderer.invoke('quest:write', patch),
  },
  song: {
    open: (folder, opts) => ipcRenderer.invoke('song:open', folder, opts),
    close: () => ipcRenderer.invoke('song:close'),
    trash: (folder) => ipcRenderer.invoke('song:trash', folder),
    trashed: () => ipcRenderer.invoke('song:trashed'),
    restore: (id) => ipcRenderer.invoke('song:restore', id),
    reload: (folder) => ipcRenderer.invoke('song:reload', folder),
    peek: (folder) => ipcRenderer.invoke('song:peek', folder),
    save: (folder, song, opts) => ipcRenderer.invoke('song:save', folder, song, opts),
    takeOver: (folder) => ipcRenderer.invoke('song:takeOver', folder),
    unreferenced: (folder, ids) => ipcRenderer.invoke('song:unreferenced', folder, ids),
    backup: (folder, song, takes) => ipcRenderer.invoke('song:backup', folder, song, takes),
    readBackup: (folder) => ipcRenderer.invoke('song:readBackup', folder),
    clearBackup: (folder) => ipcRenderer.invoke('song:clearBackup', folder),
    markSeen: (folder) => ipcRenderer.invoke('song:markSeen', folder),
    writeVersion: (folder, id, song) => ipcRenderer.invoke('version:write', folder, id, song),
    readVersion: (folder, id) => ipcRenderer.invoke('version:read', folder, id),
    listHistory: (folder) => ipcRenderer.invoke('history:list', folder),
    readHistory: (folder, saveId) => ipcRenderer.invoke('history:read', folder, saveId),
    onExternalChange: on('song:externalChange'),
    onLockStatus: on('song:lockStatus'),
    onLockLost: on('song:lockLost'),
  },
  audio: {
    write: (folder, clipId, arrayBuffer, opts) => ipcRenderer.invoke('audio:write', folder, clipId, arrayBuffer, opts),
    rename: (folder, clipId, label) => ipcRenderer.invoke('audio:rename', folder, clipId, label),
    path: (folder, clipId) => ipcRenderer.invoke('audio:path', folder, clipId),
    read: (folder, clipId) => ipcRenderer.invoke('audio:read', folder, clipId),
    readFile: (p) => ipcRenderer.invoke('audio:readFile', p),
    compact: (folder, opts) => ipcRenderer.invoke('audio:compact', folder, opts),
    purge: (folder, ids) => ipcRenderer.invoke('audio:purge', folder, ids),
    onCompactProgress: on('audio:compactProgress'),
  },
  phone: {
    start: () => ipcRenderer.invoke('phone:start'),
    stop: () => ipcRenderer.invoke('phone:stop'),
    info: () => ipcRenderer.invoke('phone:info'),
    newKey: () => ipcRenderer.invoke('phone:newKey'),
  },
  rec: {
    begin: (id, meta) => ipcRenderer.invoke('rec:begin', id, meta),
    append: (id, chans) => ipcRenderer.invoke('rec:append', id, chans),
    end: (id) => ipcRenderer.invoke('rec:end', id),
    list: () => ipcRenderer.invoke('rec:list'),
    read: (id) => ipcRenderer.invoke('rec:read', id),
  },
  bounce: {
    write: (folder, baseName, arrayBuffer, opts) => ipcRenderer.invoke('bounce:write', folder, baseName, arrayBuffer, opts),
    stamp: () => ipcRenderer.invoke('bounce:stamp'),
    exportWrite: (folder, name, files) => ipcRenderer.invoke('export:write', folder, name, files),
    list: (folder) => ipcRenderer.invoke('bounce:list', folder),
  },
  shell: {
    showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
    openSongFolder: (folder) => ipcRenderer.invoke('shell:openSongFolder', folder),
    openLink: (which) => ipcRenderer.invoke('shell:openLink', which),   // 'repo' | 'venmo' | 'kofi' | 'issues' | 'releases'
    links: () => ipcRenderer.invoke('shell:links'),
  },
  mic: { ensure: () => ipcRenderer.invoke('mic:ensure') },
  presence: { set: (p) => ipcRenderer.invoke('presence:set', p) },
  tlock: { list: (f) => ipcRenderer.invoke('tlock:list', f), claim: (f, id, o) => ipcRenderer.invoke('tlock:claim', f, id, o), touch: (f, id) => ipcRenderer.invoke('tlock:touch', f, id), release: (f, id) => ipcRenderer.invoke('tlock:release', f, id) },
  tracks: { post: (f, id, p) => ipcRenderer.invoke('tracks:post', f, id, p), read: (f) => ipcRenderer.invoke('tracks:read', f), remove: (f, file, id) => ipcRenderer.invoke('tracks:remove', f, file, id) },
  identity: () => ipcRenderer.invoke('me:identity'),
  mail: { post: (folder, op) => ipcRenderer.invoke('mail:post', folder, op), read: (folder) => ipcRenderer.invoke('mail:read', folder), remove: (folder, file) => ipcRenderer.invoke('mail:remove', folder, file) },
  update: {
    status: () => ipcRenderer.invoke('update:status'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    snooze: () => ipcRenderer.invoke('update:snooze'),
    onStatus: on('update:status'),
  },
  onStoreError: on('store:error'),
  onAudioArrived: on('audio:arrived'),
  api: {
    info: () => ipcRenderer.invoke('api:info'),
    onRequest: (cb) => {
      ipcRenderer.on('api:request', async (_e, { id, op, args }) => {
        try { const result = await cb(op, args); ipcRenderer.send('api:response', { id, result }); }
        catch (err) { let msg; try { msg = (err && (err.message || err.name)) ? `${err.name && err.name !== 'Error' ? err.name + ': ' : ''}${err.message || ''}` : (typeof err === 'object' ? JSON.stringify(err) : String(err)); } catch (_) { msg = String(err); } ipcRenderer.send('api:response', { id, error: msg }); }
      });
    },
    ready: () => ipcRenderer.send('renderer:ready'),
  },
});
