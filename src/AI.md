<!-- cobander-ai-doc v17 -->
# Cobander — guide for AI assistants (Claude / Cowork / scripts)

Cobander is a small multitrack sketchpad. Everything it knows is plain JSON and WAV on disk,
and the running app exposes a loopback HTTP API. You can mix, analyze, bounce and manage
songs without touching the GUI.

## 1. Files (shared Google Drive folder)

```
<Shared>/
  AI.md                       this file (Cobander re-copies it when its version is newer)
  _takeout.json               the band's license key {key, band, tier}. Free Cobander keeps ONE song per folder; with a valid
                              key (Ed25519-signed, verified offline) the band adds as many as it likes. POST /song/create
                              on a free folder that already has its song fails with "A license lifts the limit".
  <Song Name>/
    song.json                 the whole project: tempo, tracks, mix, FX, clip placement, notes
    audio/<track> - <take> - <who> - <clipId>.wav   one immutable 24-bit WAV per take. The 12-hex clipId at the END
                              of the name is the key; the label in front is for humans and follows renames
                              (Cobander renames the file after each save; POST /takes/relabel forces it).
                              Older files named just <clipId>.wav are still found. Never edit the audio.
    bounces/*.wav             mixdowns and stems written by "Bounce"
    _lock.json                soft lock: {user, host, pid, token, since, heartbeat} (ms epoch)
```

Lock rules: the app refreshes its lock every 20 s and deletes it on close. A lock whose file
has not changed for 90 s *as observed by the reader* is stale and may be taken (clocks on the
two machines are never compared for staleness). "Take over" overwrites the lock; the previous holder drops
to read-only as soon as it sees a foreign lock with a newer `since` (seconds, plus Drive sync time) — a foreign
lock that looks *older* is treated as a possible stale file and only loses after two missed heartbeats (≤ 40 s).
Before every save the app re-reads `_lock.json` and refuses to write unless the token is its own. Unsaved
changes of the loser stay in memory; "Take the song back & save mine on top" merges them over the other
person's version, keeping any takes/tracks the other person added.

### song.json schema (format 1)

```jsonc
{
  "format": 1, "name": "Can't Argue", "id": "…",
  "rev": 12, "saveId": "3f9a1c…",                         // rev counts saves; saveId is random per save and is what conflict detection compares
  "savedBy": "Riley", "savedAt": "2026-10-13T03:12:00.000Z",
  "bpm": 120, "timeSig": [4, 4], "sampleRate": 48000,
  "notes": "Verse: G D Em C …",
  "loop": { "enabled": false, "start": 0, "end": 8 },          // seconds
  "master": { "gainDb": 0, "limiter": true, "reverb": { "decay": 1.8, "preDelay": 0.02, "damp": 6000 } },   // limiter: safety brick-wall at -1 dBFS on the mix (not on stems)
  "tracks": [{
    "id": "a1b2c3d4e5f6", "name": "Vox", "color": "#e06c75",
    "gainDb": -3, "pan": 0, "mute": false, "solo": false,        // gain −60..+12, pan −1..1
    "fx": {
      "hpf": { "on": true, "hz": 80 },
      "eq": { "on": true, "low": { "hz": 120, "db": -2 }, "mid": { "hz": 1000, "db": 0, "q": 1 }, "high": { "hz": 8000, "db": 1.5 } },
      "comp": { "on": true, "threshold": -18, "ratio": 3, "attack": 0.01, "release": 0.2, "knee": 6, "makeup": 3 },  // seconds, dB
      "reverbSend": 0.15                                          // 0..1 to the shared master reverb
    },
    "clips": [{ "id": "0f1e2d3c4b5a", "name": "take 2", "start": 4.0, "gainDb": 0, "mute": false,
                "trimStart": 0, "trimEnd": 0, "fadeIn": 0, "fadeOut": 0.2, "duration": 31.9, "channels": 1,
                "takenBy": "Riley", "takenAt": "…",
                "src": "0f1e2d3c4b5a" }]                         // src (optional): the audio file id when this clip is a split/copy of
                                                             // another take; absent ⇒ the clip's own id is the file. Several clips may share one file.
  }],
  "trash": {}, "trashTracks": {}                              // what the user deleted (see rules); keep when rewriting
}
```

Track fields added in 0.2: `type` (guitar|bass|vocals|drums|keys|other — picks the preset list),
`preset` (name of the last applied preset, informational), `instrument` (`audio` | `synth:bass` |
`synth:saw` | `synth:square` | `synth:pad` | `synth:keys` | `synth:organ` | `synth:pluck` | `drumkit`),
`drum` (only when instrument is drumkit: `{kit, pattern, custom, swing, bars, offsetBars, gainDb}`;
`kit` ∈ rock|punk|tight|808|lofi; `pattern` is a name from GET /presets; `custom` is
`{kick:[16], snare:[16], hat, ohat, tom, crash}` with 0/1/2 = off/hit/accent per sixteenth;
`bars` 0 = play for the whole song, including while a take is being recorded over it; the grid is 4 sixteenths per beat, so 3/4 uses 12 steps). fx gains two blocks:
`amp: {on, model (clean|crunch|lead|highgain|fuzz|bass|bassdrive), gain 0-10, bass/mid/treble/presence −8..8, cab (412|212|112|810|115|none), level dB}`
and `delay: {on, time, feedback 0-0.9, mix 0-1, sync}` — when `sync` is true `time` is in BEATS
(0.5 = eighth, 0.75 = dotted eighth, 1 = quarter), otherwise seconds. `gate: {on, threshold dBFS}` is a real noise gate (6 dB hysteresis, 50 ms hold).
Clips have `kind`: `audio` (default) or `midi` with `notes: [{t, d, n, v}]` (seconds from clip start,
seconds, MIDI note 0-127, velocity 0-1); a midi clip plays through the track's synth instrument.

Signal chain per track: source (take / synth / drum machine) → clip gain → amp (pre → waveshaper →
tone stack → cab IR) → HPF → low shelf → mid peak → high shelf → compressor → makeup → delay insert →
fader → pan → master (and → reverb send → master reverb → master).
Units: gains dB, frequencies Hz, times seconds (API `attack`/`release` too), pan −1..+1.
Out-of-range or non-numeric values are clamped or replaced by defaults on load; a Unicode
minus ("−3") is accepted.

Editing song.json directly is fine **when nobody holds the lock**. When you do, write a NEW
random 12-hex `saveId`, bump `rev` by one and set `savedBy` — running apps notice the file
only when `saveId` changes, and reload it (if the user has no unsaved changes and the
transport is stopped; otherwise they get a banner). Keep `format`, `id` and clip `id`s
intact. Prefer the API when the app is running.

### 1c. Timeline notes and reactions (0.3.1)

- `song.markers[]`: `{id, trackId|null, time (s), text, by, at, deleted?, editedBy?, deletedBy?}` — a pinned note at a time, on one track or (trackId null) on the master time scale.
- `song.reactions[]`: `{id, target: "song"|<trackId>|<clipId>, emoji, by, at, deleted?}` — one entry per person per emoji per target. Toggle = add, or mark the existing one `deleted: true`.
- Both are soft-deleted so bandmates' saves merge: union by id; `deleted` on either side wins; an entry you did not touch takes the other side's edit. Never hard-delete entries from these arrays.
- API: `POST /song/patch {addNotes:[{trackId?, time, text}], react:[{target, emoji}]}`. Keep notes short and positional ("bar 44: guitar should get heavy here" → time = (44-1)*barLen).
- `installers/latest.json` + installer files in `<shared>/installers/` drive the in-app updater; the app refuses a file whose sha256 does not match.

### 1d. Songwriting data (0.4 / 0.5)

All of these live in song.json, are arrays of entries keyed by `id`, soft-deleted (`deleted: true`) and merged field by field between bandmates — never hard-delete an entry:
- `sections[]` `{id, name, start, end, unlinked?}` (seconds) — Intro / Verse 1 / Chorus… on the master timeline. `linkGroups: {chorus: true}` links every section of a type: the earliest is the **room**, the others play **copies** of it. Copies are real clips with `link: {from, section}` and ids derived from (source clip, section); Cobander regenerates them on every change, so never edit a `link` clip — edit the room clip, or `POST /section/unlink`.
- `chords[]` `{id, time, chord}`; `lyrics[]` `{id, time|null, text}` (null = not placed yet); `needs[]` `{id, text, who?, sectionId?, done:{by,at}|null}` (assignments: `who` gets a badge on their song list).
- `markers[]` notes now have `replies[]` and `resolved:{by,at}`; `votes[]` `{clipId, by}` (★ take voting — most stars is the hero take); `ideas[]` (scratchpad: text or audio sketches, not on the timeline); `versions[]` (named snapshots, bodies in `<song>/versions/<id>.json`); `activity[]` (feed: `{by, at, items[], kinds:{take:1,note:2…}, base}` — `base` is the save it replaced = the roll-back point).
- `key` ("Em"), `stage` (idea | writing | demo | done).
- `sections[].key`: a key change for that section (modulation); everything key-aware uses the key at that time.
- Melody clips: MIDI clips with `melody: {text, seed, section, voice}` on a `synth:voice` track (guide voice); each note `{t, d, n, v, l}` carries its syllable in `l`. Write them with `POST /melody` (deterministic with `seed`).
- Parts carry `key`, `keySource` (song | set | notes | audio | chords) and `keyConfidence`; `POST /part/key` sets or re-detects it.
- `<song>/history/rev-NNNNNN-<saveId>.json`: every save (last 500) — roll-back points (`GET /history`, `POST /rollback`).
- `<shared>/_templates/*.json`: band song templates. `<shared>/_parts/part-*.json` + `_parts/audio/*.wav`: the band **parts bin**; `POST /part/drop` re-times a part to the song tempo and shifts it to the song key (independently).
- Tempo changes (`POST /tempo`) re-speed recorded takes like tape (new files, clip `vs: {src, bpm}` remembers the original); `keepTakes:true` changes only the grid.
- Assistants: prefer `GET /collab`, `GET /chart`, `POST /sections`, `/chords`, `/lyrics`, `/needs`, `/restructure`, `/song/create {template, arrangement}` over editing song.json.

## 2. Control API (preferred when Cobander is open)

Base URL `http://127.0.0.1:47800` (port = `apiPort` in settings.json). Every call needs
`Authorization: Bearer <apiToken>` (header only; no query-string token). Read `apiToken` from:

* macOS: `~/Library/Application Support/Cobander/settings.json`
* Windows: `%APPDATA%\Cobander\settings.json`
* Linux: `~/.config/Cobander/settings.json`

```
GET  /                 route list (no auth)
GET  /state            settings, identity, open song (full song.json), lock, readOnly, dirty, lastSaveError,
                       pendingExternal, transport, selection, missingClips, unreferencedTakes, bounces, snapshots
GET  /songs            songs in the shared folder with lock status and any Drive conflict copies
POST /song/open        {"folder":"Can't Argue","force":false}   force = take over the lock. Saves the current song first.
POST /song/close       saves if dirty, releases the lock
POST /song/create      {"name":"New idea"}
POST /song/save        {"force":false} → {result:"ok"|"conflict"|"error"|"readonly", rev, conflict:{…}|null}; refused while read-only
POST /song/reload
POST /song/takeover    take the lock; keeps and saves your unsaved changes
POST /song/snapshot    {"label":"before AI mix"} → {id}       in-memory undo point (lost when the song is closed)
GET  /song/snapshots
POST /song/restore     {"id":"…"}   the current state is snapshotted first
POST /mix              {"tracks":[{"id":"…","gainDb":-2,"pan":-0.2,"rename":"Lead vox","fx":{"comp":{"on":true,"threshold":-20}}}],
                        "master":{"gainDb":-1,"reverb":{"decay":2.2}}}   partial; ALL-OR-NOTHING (a bad id or unknown key rejects the whole call);
                        keys: gainDb pan mute solo rename color type instrument preset fx. A track may be addressed by {"name":"Vox"} instead of id
                        (error if the name is not unique). Clips are edited through /song/patch.
POST /song/patch       {"bpm":128,"timeSig":[4,4],"notes":"…","loop":{"enabled":true,"start":0,"end":16},
                        "addTrack":{"kind":"guitar"},"removeTrack":"id",          kind ∈ guitar|bass|vocals|other|drums|keys: sets type, a default preset,
                                                                               source (audio / drum machine / synth) and arms it — same as the "+ track" dialog.
                                                                               Or {"name":"Bass","color":"#98c379"} for a bare audio track.
                        "clips":[{"id":"…","start":8,"gainDb":-1,"trimStart":0,"trimEnd":0,"name":"…","mute":false,"delete":false}]}
POST /transport        {"action":"play"|"stop"|"pause"|"seek"|"record"|"loop"|"click","time":12.5,"trackId":"…","enabled":true,"start":0,"end":8}
GET  /meters           live peak/RMS dBFS per track, master (pre-limiter) and input, plus limiterDb (gain reduction, ≤ 0)
GET  /analyze          whole song: mix + every track (offline render, a few seconds)
GET  /analyze?trackId= one track: post-FX, post-fader, incl. its reverb send, master at unity
GET  /analyze?clipId=  one raw take (a mono take reads ~3 LU quieter here than on its stereo track — see below)
GET  /analyze?from=&to=  restrict any of the above to a time range in seconds (verse vs chorus)
POST /clip/import      {"path":"/Users/jeff/Downloads/bass.wav","trackId":"…","start":0,"name":"bass DI"}  omit trackId → new track
GET  /takes/unreferenced   takes in audio/ no clip references (deleted, or lost in a save conflict)
POST /clip/attach      {"clipId":"…","trackId":"…","start":0,"name":"…"}   re-attach one
POST /bounce           {"what":"mix"|"stems","name":"rough 3","allowMissing":false} → {files:[paths]}
                       refuses while takes are still syncing from Drive unless allowMissing
GET  /presets          ?type=guitar → [{name, blurb, fx}]; no type → names per type + instruments, drumKits, drumPatterns, ampModels, cabs
POST /track/preset     {"name":"Gtr L","preset":"Punk Rhythm","type":"guitar"}   replaces the fx chain (type optional: sets it first)
POST /drums            {"name":"Beats","enable":true,"kit":"punk","pattern":"Punk","bars":0,"swing":0.1}
                       or {"name":"Beats","custom":{"kick":[2,0,0,0,...16],"snare":[...],"hat":[...]}}   turns the track into a drum machine
POST /midi/notes       {"name":"Low","beats":true,"start":0,"notes":[{"t":0,"d":0.9,"n":40,"v":0.9},...]}   adds a midi clip (t/d in beats when beats:true)
POST /midi/quantize    {"clipId":"…","division":0.25,"strength":1}
POST /note             {"name":"Low","note":45,"vel":0.8,"dur":0.5}   audition through the track's synth/kit (36 kick 38 snare 42 hat 46 open hat 45 tom 49 crash)
GET  /midi/inputs      MIDI hardware inputs; POST {"select":"<id>"|"any"|""} picks one (persisted)
GET  /doc              this document
```

`/analyze` returns per item: `peakDbfs, rmsDbfs` (whole item incl. silence), `rmsActiveDbfs`
(silent 50 ms blocks excluded — use this for balance), `crestDb` (peak − active RMS),
`lufsApprox` (BS.1770-shaped: K-weighted, per-channel powers summed, absolute + relative
gate; treat ±1 LU), `dcOffset, clippedSamples, silentPct, bandsDbfs:{sub, low, lowMid, mid,
high, air}` (RMS in dBFS of 20–60, 60–250, 250–1k, 1k–4k, 4k–10k, 10k+ Hz on a mono sum).
Because channel powers are summed, a mono take copied to both speakers reads 3 LU louder on
its track than the raw clip does. Every `/analyze` response carries a `warning` if any take
is missing (not synced yet) — do not judge a mix with a warning present.

Example session:

```sh
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/Library/Application Support/Cobander/settings.json')))['apiToken'])")
H="Authorization: Bearer $TOKEN"; B=http://127.0.0.1:47800
curl -s -H "$H" $B/state | jq '.song.tracks[] | {id,name,gainDb,pan}'
curl -s -H "$H" -X POST $B/song/snapshot -d '{"label":"before AI mix"}'
curl -s -H "$H" $B/analyze | jq '.tracks[] | {name, rmsActiveDbfs, lufsApprox, bandsDbfs}'
curl -s -H "$H" -X POST $B/mix -d '{"tracks":[{"name":"Vox","gainDb":-4,"fx":{"hpf":{"on":true,"hz":90}}}]}'
curl -s -H "$H" -X POST $B/song/save
curl -s -H "$H" -X POST $B/bounce -d '{"what":"mix","name":"AI rough"}'
```

### File-drop inbox (no network needed)

The same API is driven by JSON files dropped into the inbox folder (shown in Settings →
Assistant; default `<app data>/Cobander/inbox`, configurable as `apiInbox` in settings.json).
Write `<name>.json` containing one request or an array:

```json
[{"method":"POST","path":"/song/open","body":{"folder":"Can't Argue"}},
 {"method":"GET","path":"/analyze","query":{"trackId":"…"}},
 {"method":"POST","path":"/mix","body":{"tracks":[{"name":"Vox","gainDb":-2}]}},
 {"method":"POST","path":"/song/save"}]
```

Cobander executes it within ~2 s, writes `<name>.result.json` (one `{ok,status,result|error}`
per request; stops at the first error unless `"stopOnError":false`) and renames the request
to `<name>.done`. Write the file atomically (write to a temp name, then rename) so a half-
written file is not picked up. No token: anyone who can write to that folder is the local user.

### DAW hand-off (`POST /export`)
Writes `bounces/<Song> - DAW export <stamp>/` with: `<name>.rpp` (REAPER project: one track per Cobander track
holding its post-FX stem, plus muted "raw takes, dry" tracks with the untouched take files at their exact
positions/trims/gains), `<name>.mid` (Standard MIDI File, type 1, 480 ppq: tempo, time signature, drum
machine on channel 10 with GM drum notes, each synth track's notes), `stems/<track>.wav` (24-bit, post-FX,
post-fader, limiter off, all exactly the same length, starting at bar 1), `takes/` (copies of the raw take
files), `mix.wav`, `README.txt` (per-DAW import steps: REAPER, Logic, GarageBand, Ableton, FL, Studio One,
Pro Tools). `what` = all | reaper | midi | stems. Use this whenever someone wants to continue in their own DAW.

### 0.13 / 0.14 tools (all undoable, all in GET /doc's route list)
- Takes are stored as **FLAC** (`<label> - <id>.flac`; older takes may still be `.wav`). `POST /audio/compact` converts WAVs and clears audio nothing references for ≥ 7 days.
- `POST /lyrics/transcribe` (Whisper, on this computer) pins words where they're sung; typed lines are re-pinned, never duplicated.
- `POST /tab {trackId}` reads every live take on a guitar / bass track and writes a `tabs` entry on the song: `{id, trackId, track, instrument, tuningCents, role (rhythm | lead | guitar | bass), events: [{t, d, notes[midi], frets[per string, -1 = not played], name?, mono, conf, inferred?}]}` (one per track; re-running replaces). `GET /tabs` lists them plus the chart's tab text. The notes come from a note-tracking model (models/nmp.onnx) and are snapped to the song's beat grid, conformed to the key and cross-checked between repeated bars; `inferred: true` marks a note filled in from the other passes of a riff. A track's `guitarRole` (`rhythm` | `lead`, from the Rhythm guitar / Lead guitar track kinds) decides the tab's role.
- `POST /part/stage {trackId|track, stage?, redo?}` sets where a part is at — `idea | writing | demo | tracking | editing | mixing | review | approved` (null clears); `redo: "text"` flags it for a redo without moving the stage, `redo: null` clears the flag. Stored in the `stages` collection (`{id: 'stg-<trackId>', trackId, stage, redo, by, at}`, one per track). Anyone can set it — no lock; a read-only window mails it to the song holder like a note. Changing the takes on an approved part sends it back to `review`. `GET /part/stages` lists them plus a rollup.
- `POST /chords/detect` drafts chords from guitar / keys / bass takes (built from the notes the tracker hears on each track; the chroma reader is the fallback) (chord objects get `det: true` until someone edits them; typed chords are never replaced).
- `POST /mix/auto`, `POST /master/auto {target}`, `POST /mix/ab` — Auto mix (solo-render loudness per role → gain, HPF, EQ, comp, pan, sends), Auto master (LUFS target, limiter), A/B flip.
- `POST /clip/tighten {clipId, grid, strength, undo}` — onset-based tightening into a new take file; `clip.tt.src` keeps the original. MIDI: strength quantize.
- `POST /pitch/check {trackId}` — sung notes vs the melody / key; `clip.pitch.ok` = % in tune. Nothing is pitch-shifted.
- `POST /comp {clipId, from, to}`, `POST /part/share {section}`, `GET /changes?since=`.
- `POST /workspace {ws}` (write · record · mix · practice · band), `POST /practice {open, show, step, flush}`; practice minutes go to the quest file as `practice:<who>:<YYYY-MM-DD>:<qid>` (1 XP / min, ≤ 60 a day), setlist runs as `setlist:<who>:<date>`.
- `POST /chart/all` — Band page "🎼 Chart every song": opens each song in turn, drafts missing chords from its takes, saves, skips songs someone else has open. Returns `{charted[], skipped[]}`.
- Band to-dos ("Loose ends" on the Band page — things that aren't a song): `GET /quest` → `todos[]`; `POST /quest {todo:{text, who}}` adds, `{todo:{id, done}}` checks off (TASK_XP to whoever did), `{todo:{id, delete:true}}` removes. Stored as `band:todo:<id>`.
- Phone page: `GET /phone` (on/off, links). The page itself is served on the home network (port `phonePort`, default 47811) only with the key in its link.

## 3. Building a song from nothing (what an assistant can do without a mic)

1. `POST /song/create {"name":"New idea"}`, then `/song/patch {"bpm":150}`.
2. Drums: `/song/patch {"addTrack":{"kind":"drums"}}` (punk kit + pattern, named "Drums") → tweak with `/drums {"name":"Drums","pattern":"Punk Double-time"}`.
3. Bass: add a track, `/mix {"tracks":[{"name":"Bass","instrument":"synth:bass","type":"bass"}]}`, then
   `/midi/notes` with `beats:true` (one note per beat on the root works for punk), `/track/preset {"name":"Bass","preset":"Punk Grit"}`.
4. The humans record guitars/vocals on audio tracks (`instrument:"audio"`); you pick their presets
   (`/presets?type=guitar` → `/track/preset`) and balance with `/analyze` + `/mix`.
5. `/bounce {"what":"mix"}` for a rough; the band listens from `bounces/`.

## 3b. Mixing cookbook (what "good" looks like in these numbers)

* Headroom: aim mix `peakDbfs ≤ -1`, `lufsApprox` around −16 to −12 for a rough. Clipped
  samples > 0 on the mix means pull the master or the loud track down — it is already distorting.
* A take with `clippedSamples > 0` was clipped at the interface; no mix move fixes it. Say so.
* `crestDb` < 8 on a vocal = heavily compressed already; back off `ratio`/`threshold`.
* Prefer presets over hand-tuned chains: `/track/preset` gives a sane chain in one call; then nudge.
* Amp models: clean/crunch for rhythm under vocals, highgain for punk/metal rhythm (pan L/R doubles ±0.7), lead for solos.
  The amp's `level` is already compensated per model; use the fader for balance, `level` only to tame a hot preset.
* Vocals: HPF 80–120 Hz; comp −18 to −24 thresh, 3:1, 10 ms/150 ms; a little `reverbSend` (0.1–0.25).
* Guitars (pop-punk): HPF 90–120, dip `mid` 300–400 Hz −2 dB if `lowMid` ≫ `mid`; pan doubles ±0.7.
* Bass: HPF 35–40; `low` band should sit within ~3 dB of the kick's.
* Drums/loops: watch `sub` vs `low`; `air` above −35 dBFS on a close mic is probably hiss.
* Balance: `rmsActiveDbfs` of lead vocal ≈ 2–4 dB above guitars; everything else below.
* Use `pan` for width before EQ for separation. Keep `master.gainDb ≤ 0`; fix loudness at tracks.
* The master limiter hides clipping on the mix (`/meters` `limiterDb` below about -3 means it is working hard). Treat that as a mix problem to fix at the tracks, not a feature; stems bypass it.
* Loop recording: `POST /transport {action:"record"}` with the loop enabled records from the loop start and turns every
  pass into its own take (same start, all muted except the last). Pick one with `clips:[{id, mute:false}]`.
* Editing: `/clip/split`, `/clip/duplicate`, clip `start/trimStart/trimEnd/fadeIn/fadeOut/mute` via `/song/patch`. Pieces that
  share one audio file carry `src`; deleting the last clip that references a file makes it an unused take (never deleted).
* Takes are named `take N` per track (numbers never reuse); overlapping takes on one track all play (stacked lanes in the UI) unless `mute:true`. To keep one, set `mute:true` on the others via `/song/patch clips:[{id,mute:true}]` (reversible) rather than deleting.
* `song.trash` (`{clipId: {name, trackId, trackName, start, takenBy, at}}`) and `song.trashTracks` (`{trackId: name}`) remember what the user deleted, so "Deleted takes" can restore a take to its original place and a merge never resurrects a deliberately deleted track. Keep them when you rewrite song.json.
* Workflow: `/song/snapshot` → change one thing → `/analyze?trackId=` → compare → `/song/save`.
  Tell the human what you changed in plain words ("pulled the vox HPF up to 100 Hz, guitars −2 dB").

## 4. Rules of engagement

* Never modify or delete files in `audio/`. Never write `song.json` while `_lock.json` is live
  and not yours — use the API instead, which respects the lock.
* Do not `force` a save or take over a lock unless the human says so. If `/state` shows
  `readOnly: true`, say who holds it and stop.
* If `/state.pendingExternal` is set, a bandmate saved in the meantime: ask before overwriting.
* Bounces are additive and timestamped; it is fine to make several.
* Takes are 24-bit WAV at the session's sample rate (default 48 kHz); bandmates import them
  straight into REAPER/Logic/Ableton. Clip `start` is the position in seconds in the song.
