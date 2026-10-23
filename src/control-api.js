'use strict';
// Loopback-only HTTP control API so an assistant (Claude / Cowork) can read and drive
// the running app. Every request needs the bearer token from settings.json.
//
// The main process owns the server; the renderer owns the audio engine, so most
// endpoints are relayed to the renderer over IPC and awaited.

const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 47800;

const ROUTES = [
  ['GET', '/', 'Lists routes (this)'],
  ['GET', '/state', 'Full app + song state: settings, open song (song.json), lock, transport, selection, missingClips, lastSaveError, unreferencedTakes'],
  ['GET', '/songs', 'Songs in the shared folder with lock status and Drive conflict copies'],
  ['POST', '/song/open', '{folder, force?} open a song (soft lock); force takes over. Opening another song saves the current one first.'],
  ['POST', '/song/close', 'save if dirty, release lock, close song'],
  ['POST', '/song/create', '{name, template?:id (GET /templates), arrangement?:id (GET /arrangements), bpm?, timeSig?:[n,d], key?:"Em", click?:bool, tracks?:[kind] (guitar|rhythmGuitar|leadGuitar|bass|vocals|drumsMic|drums|keys|other)} — with a template: sections, tempo, starter tracks and groove are laid out'],
  ['POST', '/song/save', '{force?} save current song.json (rev++, new saveId). Returns {result:"ok"|"conflict"|"error"|"readonly", rev, dirty, conflict, error}. result:"readonly" means take over first.'],
  ['POST', '/song/reload', 're-read song.json from disk (after an external edit)'],
  ['POST', '/song/rename', '{name} rename the open song: its folder is renamed too (you must hold the song; nobody else may have it open); XP, goals and tasks carry over → {folder, name}'],
  ['POST', '/song/takeover', 'take the lock from whoever holds it; keeps your unsaved changes'],
  ['POST', '/song/snapshot', '{label?} remember the current song state (in-memory undo point)'],
  ['GET', '/song/snapshots', 'list snapshots'],
  ['POST', '/song/restore', '{id} restore a snapshot (the current state is snapshotted first)'],
  ['POST', '/mix', '{tracks:[{id|name, gainDb?, pan?, mute?, solo?, rename?, color?, type?, instrument?, preset?, fx?:{gate,amp,hpf,eq,comp,delay,reverbSend}}], master?:{gainDb?, reverb?}} partial update, all-or-nothing, applies live; clips are not accepted here'],
  ['POST', '/song/patch', '{bpm?, timeSig?, notes?, loop?, addTrack?:{kind?|name,color?}, removeTrack?:id, clips?:[{id, start?, gainDb?, trimStart?, trimEnd?, fadeIn?, fadeOut?, mute?, name?, delete?}], addNotes?:[{trackId?, time, text}] (timeline notes; trackId omitted = master time scale), react?:[{target:"song"|trackId|clipId, emoji}] (toggles your reaction)}, key?:"Em"|null, stage?:idea|writing|demo|done|null'],
  ['POST', '/transport', '{action:"play"|"stop"|"pause"|"record"|"seek"|"loop"|"click", time?, enabled?, start?, end?, trackId?}'],
  ['GET', '/meters', 'Live peak/RMS dBFS per track + master + input (only meaningful while playing)'],
  ['GET', '/analyze', '?trackId=&clipId=&from=&to= offline analysis: peak, RMS, active RMS, crest, LUFS, band energies, clipping, DC, silence'],
  ['POST', '/clip/import', '{path, trackId?, start?, name?} import a WAV/MP3/FLAC/OGG file as a take (stored in audio/ as lossless 24-bit FLAC)'],
  ['GET', '/changes', '?since=ISO (default: when you last had the song open) → who did what, new takes, words / chords changed per part, new notes'],
  ['POST', '/part/share', '{section: id|name} bounce one part (+ a bar of ring-out) with its chart into bounces/<song> - <part> <stamp>/'],
  ['POST', '/comp', '{clipId, from, to} comp: that take is the only one heard on its track between from and to (s); others play as before outside'],
  ['POST', '/workspace', '{ws: "write"|"record"|"mix"|"practice"|"band"} switch the workspace'],
  ['POST', '/tab', '{trackId} read every live take on a guitar / bass track and write its tab (notes + chord voicings as string/fret events) onto the song → {id, instrument, tuningCents, events[], text}'],
  ['POST', '/part/stage', '{trackId|track, stage?: idea|writing|demo|tracking|editing|mixing|review|approved|null, redo?: "text"|null} set where a part is at — anyone can, no lock (it is mailed to whoever has the song) → {trackId, stage, redo}'],
  ['GET', '/part/stages', 'every track\'s part stage on the open song → {stages:[{trackId, track, stage, redo, by, at}], rollup:{total, approved, staged, redo, counts}}'],
  ['GET', '/tabs', 'the tabs on the open song → [{id, trackId, track, instrument, tuningCents, events[]}] (+ text: the chart\'s tab section)'],
  ['POST', '/chords/detect', '{trackIds?, replaceDrafts?:true, wipe?:false (true = drop every existing chord first, typed ones too)} chords heard from the guitar / keys / bass takes → drafted into the chord lane where there are none (det:true)'],
  ['POST', '/mix/auto', 'Auto mix: per-track levels, HPF / EQ cleanup, comp, pan, reverb sends from solo renders (undoable; POST /mix/ab flips before/after)'],
  ['POST', '/master/auto', '{target?:-14} Auto master: master gain to a LUFS target, limiter on'],
  ['POST', '/mix/ab', 'flip between before / after the last Auto mix / master'],
  ['POST', '/clip/tighten', '{clipId, grid?:"1/8", strength?:0.6, undo?} pull hits onto the grid (new audio file; c.tt keeps the original) / quantize MIDI with a strength'],
  ['POST', '/pitch/check', '{trackId, clipId?} vocal pitch check vs the melody (or the key): flags sharp / flat / wrong notes; nothing is changed'],
  ['POST', '/practice', '{open?, show?, step?, flush?} practice mode / Show mode / next song; flush writes practice minutes'],
  ['GET', '/phone', 'phone page status + links (turn it on from Share → Open on your phone)'],
  ['POST', '/audio/compact', '{folder?, dryRun?, olderThanDays?:30, convert?:true, purge?:true} lighten Drive: WAV takes → lossless FLAC; remove audio nothing (song, versions, last 500 saves, notes) has referenced for N days. No folder = every song'],
  ['GET', '/takes/unreferenced', 'takes in audio/ that no clip references (deleted or lost in a conflict)'],
  ['POST', '/clip/attach', '{clipId, trackId?, start?, name?} re-attach an unreferenced take'],
  ['POST', '/clip/mono', '{clipId, which?: left|right|sum (default sum)} fold a stereo take to mono: a new mono file, the clip re-pointed to it (undoable) → {clip}'],
  ['POST', '/clip/split', '{clipId, at?} split a take at `at` seconds (default: playhead); both halves share the audio file (right half gets src=<audio id>)'],
  ['POST', '/clip/duplicate', '{clipId} copy a take right after itself (shares the audio file)'],
  ['POST', '/takes/relabel', 'rename every take file in audio/ to "<track> - <take> - <who> - <id>.flac" (runs automatically after saves; use once on old songs)'],
  ['POST', '/export', '{what?:"all"|"reaper"|"midi"|"stems", name?} write a DAW hand-off folder under <song>/bounces: REAPER .rpp, Standard MIDI File, bar-1-aligned stems, README'],
  ['POST', '/bounce', '{what:"mix"|"stems", name?, allowMissing?} renders to <song>/bounces and returns paths; refuses if takes are missing unless allowMissing'],
  ['GET', '/presets', '?type=guitar → preset list with full fx; no type → names for every type, plus instruments, drum kits/patterns, amp models, cabs'],
  ['POST', '/track/preset', '{id|name, preset, type?} apply a preset (replaces the fx chain, sets track.preset)'],
  ['POST', '/drums', '{id|name, enable?, kit?, pattern?, custom?:{kick:[16],snare:[16],hat,ohat,tom,crash}, swing?, bars?, offsetBars?, gainDb?} drum machine on a track'],
  ['POST', '/midi/notes', '{id|name, notes:[{t,d,n,v}], start?, beats?:true, name?} add a MIDI clip to a synth track'],
  ['POST', '/midi/quantize', '{clipId, division?:0.25, strength?:1}'],
  ['POST', '/note', '{id|name, note, vel?, dur?} audition a note on a synth/drum track'],
  ['GET', '/midi/inputs', 'list MIDI inputs; POST {select:id|"any"|""} to choose'],
  ['POST', '/lyrics/transcribe', '{clipId? | trackId? (default: every vocal track), model?: base.en|small.en|medium.en, replace?: true (re-does what speech-to-text wrote before), wipe?: false (true = drop every existing lyric line first)} — speech-to-text: lyric lines pinned where they are sung, with word timings'],
  ['POST', '/lyrics/retime', '{} — tighten timing: every timed lyric word gets its start / end moved onto the vocal takes (where the voice starts and stops). Returns {moved, lyrics}'],
  ['GET', '/audio', 'Audio devices and settings: inputs, outputs, chosen input/output, record latency offset (ms, manual or automatic), FX monitoring, inputChannels (auto | left | right | stereo: what a take keeps from a 2-input interface)'],
  ['POST', '/audio', '{recordOffsetMs?: number|null (null = automatic), inputDeviceId?, outputDeviceId?, monitorFx?} — change audio settings (saved)'],
  ['POST', '/latency/measure', '{apply?: true} — play clicks out the output, hear them on the input (the output must be routed into the input), return the round trip in ms; apply saves it as the record offset'],
  ['POST', '/update', '{install?: true} — check for an update now; install: download/apply the one found and restart'],
  ['GET', '/quest', 'The game layer: band level + XP, every member (XP, level, achievements, per-song), every song as a quest (goals, parts-written % per member from their takes, tasks, milestones), the next boss battle'],
  ['POST', '/quest', '{goal?:{song, id:title|structure|show, done}, task?:{song, text, who?} | {song, id, done?|delete?}, boss?:{title, date?, songs?:[names]}, next?, bandName? (the free band name; a key band name wins), member?:{name, aliases?:[display names their install uses], role?}, manual?:{song, member, pct|null}, todo?:{text, who?} | {id, done?|delete?}} — set a band decision; song = folder or name'],
  ['POST', '/chart/all', 'Chart every song: open each song in turn, draft the chords its takes imply where none exist, save; songs someone else has open are skipped → {charted[], skipped[]}'],
  ['GET', '/collab', 'Collaboration state of the open song: sections, chords, lyrics, needs, notes with replies, votes, ideas, versions, activity feed, presence, people'],
  ['POST', '/sections', '{add?:[{name, startBar|start, endBar|end}], update?:[{id, name?, start?, end?, key? (modulation; null = song key)}], remove?:[id]} song structure blocks on the master timeline (bars are 1-based, endBar inclusive; start/end in seconds)'],
  ['POST', '/chords', '{set?:[{bar?|time, chord}], fromBar?, bars?:"G D Em C" (one chord per bar, "|" splits bars), remove?:[id], clear?:true}'],
  ['POST', '/lyrics', '{add?:[{text, time?|bar?}], text?:"line\\nline" (adds unpinned lines), pin?:{id, time}, update?:[{id, text?, time?}], remove?:[id]}'],
  ['POST', '/needs', '{add?:[text], done?:[id], undone?:[id], remove?:[id]} the song\'s "needs" checklist (badge on the song list)'],
  ['POST', '/note/reply', '{noteId, text} reply in a timeline note\'s thread (@Name mentions badge that bandmate)'],
  ['POST', '/note/resolve', '{noteId, resolved?:true|false}'],
  ['POST', '/vote', '{clipId} toggle your star on a take; when a take becomes the top-voted of its overlapping takes it becomes the hero (others muted)'],
  ['POST', '/idea', '{text?, title?, path?} add to the idea scratchpad: a text idea, or an audio file (voice memo) copied into audio/ — not on the timeline'],
  ['POST', '/version', '{name} tag the current song as a named version (immutable copy in <song>/versions/); {restore:id} brings one back (undoable)'],
  ['GET', '/versions', 'list version tags'],
  ['GET', '/history', 'roll-back points: every save of the open song [{rev, saveId}] (oldest first, last 200)'],
  ['POST', '/rollback', '{saveId, everything?:bool} put the song back as it was at that save (undoable). Default keeps notes/lyrics/chords/sections/needs as they are now'],
  ['POST', '/link', '{type:"chorus", on?:true|false, keepOthers?:bool} link every section of a type: the first is the room, the others play a mirror of it (clips with link:{from,section}, regenerated on every change). keepOthers leaves sections that already have takes unlinked instead of replacing them'],
  ['POST', '/section/unlink', '{sectionId, relink?:bool} break one linked section off (its mirrors become its own clips) or re-link it'],
  ['POST', '/room', '{sectionId|name} open a section room (zoom + loop that part) | {leave:true}'],
  ['GET', '/arrangements', 'named song structures (several per style: pop-punk "Half-chorus tease", "Cold open"…) + band templates'],
  ['POST', '/restructure', '{arrangement:id | structure:[["Verse",8],["Half chorus",4,"Chorus"],…], dryRun?:bool} cut the takes/chords/lyrics/notes in the labelled sections and lay them out in the new order (undoable). Returns the mapping report'],
  ['POST', '/tempo', '{bpm, keepTakes?:bool} change tempo; by default recorded takes follow like tape (varispeed: pitch moves with speed, new files, undoable); keepTakes = grid/click only'],
  ['GET', '/chart', '?transpose=n chord chart / lyric sheet of the open song as text (by section: chords bar by bar, lyric lines with their chord)'],
  ['POST', '/melody', '{text (one line per phrase; "ar-gue" forces a split), sectionId? | from?, to? (seconds), voice?:low|mid|high, density?:auto|sparse|busy, seed?, place?:bool} write a melody: syllables counted, laid across the part, notes in the key at that spot over the chord lane, scored against songwriting rules; MIDI clip on the Melody (guide voice) track, each note carries its syllable (l). place:true pins the lines as lyrics'],
  ['POST', '/song/transpose', '{semis (-12..12), sectionId?} move the recordings (pitch-shifted, tempo kept, new files), MIDI notes, chords and key up/down; drums are left alone; linked sections move together; undoable'],
  ['POST', '/song/key/detect', '{sectionId?, apply?:bool} listen to the recorded tracks (not drums, not the generated melody) for the key of the song or one section; apply sets it'],
  ['POST', '/drum-part', '{sectionId?, style?: rock|punk|skate|halftime|funk|disco|metal|shuffle|ska|ballad|blast, feel?: chill|normal|busy, seed?, hits?:[{t (s from section start), voice: kick|snare|hat|ohat|tom|crash, vel}]} write a drum part for a section: generated (or the given hits) as a MIDI clip on the drum-machine track; it replaces the groove there'],
  ['POST', '/part/key', '{partId, key:"Em"} set a part\'s key | {partId, detect:true} listen for it again'],
  ['POST', '/part/tags', '{partId, tags?:[...], style?} set a part\'s tags / style (parts are auto-tagged with instruments, section type and the song style on save)'],
  ['GET', '/parts', 'the band parts bin: saved riffs / sections with bpm, key, bars, tracks'],
  ['POST', '/part', '{name, sectionId? | clipId? | from?, to? (seconds)} save part of the open song to the parts bin (audio copied into <shared>/_parts)'],
  ['POST', '/part/drop', '{partId, at? (seconds) | sectionId?, conform?:true} drop a part into the open song: re-timed to the song tempo AND shifted to the song key (independently), onto matching tracks'],
  ['GET', '/templates', 'new-song templates: built-in + band templates (<shared>/_templates)'],
  ['POST', '/template', '{name, folder?} save the open song (or folder) as a band template: sections, tempo, key, track setups — no audio'],
  ['GET', '/doc', 'AI.md: file format, units, mixing cookbook'],
];

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) { const e = new Error('body too large'); e.status = 413; reject(e); req.pause(); return; } chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function start({ port = DEFAULT_PORT, token, handlers, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const reply = (code, obj) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj, null, 2));
    };
    try {
      // CSRF guard: browsers send Origin on cross-site requests; curl and scripts don't.
      // Browsers always send Origin on cross-origin requests with custom headers; curl/Node fetch do not.
      if (req.headers.origin) return reply(403, { error: 'browser requests are not allowed' });
      const host = String(req.headers.host || '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return reply(403, { error: 'bad Host header' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/' && req.method === 'GET') return reply(200, { name: 'Cobander control API', port, routes: ROUTES });
      const auth = req.headers.authorization || '';
      const presented = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!presented || !timingSafeEq(presented, token)) return reply(401, { error: 'missing or wrong token; read "apiToken" from settings.json' });

      const key = `${req.method} ${url.pathname}`;
      const h = handlers[key];
      if (!h) return reply(404, { error: `no route ${key}`, routes: ROUTES });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams.entries());
      const out = await h({ body, query });
      return reply(200, out === undefined ? { ok: true } : out);
    } catch (err) {
      log(`api error ${req.method} ${req.url}: ${err.message}`);
      return reply(err.status || 500, { error: err.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.requestTimeout = 0; server.setTimeout(0);   // bounces / big imports can take minutes: never cut the reply off early
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { start, DEFAULT_PORT, ROUTES };
