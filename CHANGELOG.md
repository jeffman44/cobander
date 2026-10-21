# Cobander changelog

## 0.15.4
- Takeout is a key now. Free Cobander is the whole app with one song per band folder; a Takeout key (pay what the band can spare, once) lifts the limit for everyone in the band — paste it under ⚙ → Enter a key, or when the second song asks. The key lives in the shared folder, verifies offline, never expires, never phones home. Folders that already have more songs keep them all.
- Choose your character is a real character builder now: Liberated Pixel Cup art (hundreds of human-drawn parts) — body, skin, hair and colour, beard, face, top, jacket, legs, shoes, hat — plus your instrument. Your character animates on the Band page and leaps through the level-up show; the pose changes with every new name.
- The kitchen band moved in: the takeout box waits by the drums when no song is open, the band plays across the top of the Band page, and the colander leaps through every level-up.
- The tip jar is now "send noods" (same Venmo / Ko-fi).
- Right-click a guitar / keys / bass track → 🎸 Chords & tabs: the chart moved for a capo or another key (nothing re-tuned), chords from its takes, or the play-along highway; 🔁 Transpose the whole song sits next to it. "Lyrics from this track" now only shows on vocal tracks.
- 3D practice view: every word flies at you on its own, lands in its place on the line when it's time to sing it, and the line assembles as it arrives. The view menu switches back to classic karaoke (words + chords) any time.

## 0.15.3
- Wordmark without the Japanese: COBANDER, a red noodle seal, (noodle together).
- Only people who actually played (takes, parts, words, notes) show up as bandmates — an assistant that saved a mix through the API doesn't.

## 0.15.2
- New wordmark up top in the tofu-shop stencil spirit: COBANDER, a red noodle seal, (noodle together).
- Real icons instead of system emoji: OpenMoji for the kitchen (noodles, takeout, chopsticks, pot…) and game-icons sprites for the Band page — so nothing shows as a box on Windows. Credits under ⚙.
- 100 levels instead of 10, a new name every ten (Roadie → Open Mic → Garage Hero → Basement Star → Local Legend → Headliner → Touring Act → Rock Star → Hall of Famer → Never a Doubt). The old ladder topped out after one good night; this one takes a band a year or two of weekly work. XP for level n = 25·n^1.75. Your level number changes once; nothing else does.
- Choose your character (Band page → click your sprite): a little person (Kenney's hand-drawn toon characters — adventurer, regular guy / gal, robot, zombie; everyone gets one from the start) plus what you play: Shredder, Low End, Thumper, Howler, Frontman, Keys Wizard, Horn, Noodle, Dumpling, Picker, The Booth, Volt. Until you pick, your role picks for you. The pose changes with every new name (idle → walk → talk → show → cheer → jump → attack → wide), with a badge, ring and glow on top; hover one and it walks.
- LEVEL UP: a full-screen show — confetti and noodles, screen shake, your character spinning in, and a power-chord fanfare with a crowd (synthesized, no files). It stays quiet while a take is rolling (you just get the toast). Click anywhere to dismiss.
- The boss battle is a dragon with noodles.
- Mix keeps the timeline: track heads become mini channel strips (volume, pan, LC / EQ / CMP, M / S, fix) with the console below, and the takes get mixing handles — drag the top corners for fades, the line up / down for take level; right-click → Normalize sets a take's level from its loudest moment.
- Practice: "words flying at you (3D)" — lyrics approach from the horizon and hit the line when it's time to sing them; the play-along highway is in perspective too. Practice now lives in the song area (top bar and songs list stay).
- Tooltips rewritten for total beginners: click, count-in, loop, punch, monitor, key, lock, and ~40 more say what, when and what happens; hovering a chip's label shows its control's tip.

## 0.15.1
- 🥡 Takeout: Cobander's installers are pay-what-you-want (a round for the band $12 · a round and the jukebox $25 · Roadie $60), one time, per band; the source stays free. Link under ⚙ and on the Band page.
- Kitchen icons next to the names (names unchanged): 🍜 Songs, 📋 Setlist, 🐉🍜 boss battle, 🥡 Parts, 🥢 Ideas, 🍲 Versions, 🍳 Band feed, 🍽️ Show, 🥄 Auto mix / fix, 🍽️ Auto master, 🥡 Bounce, 🥣 Lighten the folder.
- 🍺 Ko-fi joins Venmo in the tip jar (⚙ and the Band page).

## 0.15.0
- Hover anything for a plain-English tip (no studio jargon). F1 (or the ? button) turns on help mode — little ? marks on everything, tips show instantly — and F1 again opens a glossary of the words that trip people up.
- BandPad is now **Cobander — noodle together.** New name, new icon (noodles in a colander), same app, same band folder, same settings. Windows: after this update open Cobander from the Start menu once (the BandPad shortcut goes away). Mac: the app keeps working from wherever it is.
- 🎚 Mix is a real mixing console now: no timeline — big faders, pan, reverb send and a meter for every track, the master strip with a loudness readout, Auto mix / Auto master / A/B across the top. Each strip has one-click FX on/off (LC · EQ · CMP · AMP · DLY) and ✨ fix: common mixing moves in plain words (sit the vocal, less mud, more punch, brighter, copy the sound from another track…).
- Track heads show what each job needs: Write shows which parts a track covers; Record shows the arm button first and the last take (who, when).
- ↕ Track height (next to + track, or Alt+wheel over the tracks): thin / regular / thick noodles, so more tracks fit on screen. Remembered per computer. (Dan's ask.) Heads drop the extras as they shrink so nothing mashes.
- Loose ends on the Band page: the band's to-do list for things that aren't a song — book the gig, fix the PA, buy PBR. @Name assigns, checking one off earns XP, it shows in the feed. (Dan's ask.)
- 🎼 Chart every song (Band page, by the setlist): opens each song in turn, listens to its guitar / keys / bass takes and drafts the chords it doesn't have yet. Chords anyone typed are never touched; songs someone else has open are skipped.
- Chords from the recordings now run once per linked part and leave silent bars blank; the song's key is heard from the bass line first and only set by itself when it's sure.
- Key chip: ⚠ on the key when the takes disagree with the label — click it to see what the bass line says and set it.
- Track types set themselves from the name (bass, drums, vox…) — a type you picked by hand stays.
- Deleted takes stay listed on their track until the track is locked again, then they're gone for good — unless the song or a tagged version still uses them (those stay in Deleted takes). One-time offer to clear old parked takes.
- 🛣 Note highway in Practice (Play along): a scrolling lane of what to play — chord grips for guitar (capo-aware), the bass line pulled from the bass takes, or a MIDI track's notes.
- ⏱ Timing report for every take (Record → Takes): how early / late each bar is, the worst bars, a one-click Nudge when it's a fixed offset or Tighten when it isn't.
- Pitch check recalibrated on real takes: short notes ignored, slightly-off notes shown grey instead of flagged, wobbly only when the vibrato is wide.
- The band folder can be in Google Drive, OneDrive, iCloud Drive or Dropbox (or any folder every bandmate syncs). Cobander names the provider in Settings and asks iCloud for takes it has evicted.
- Cobander is free and open source: GitHub, Report a bug and 🍺 Buy Jeff a PBR (Venmo @jdeuel44) under ⚙ and on the Band page. Once it's on GitHub, updates can also come from the release there when there's no band folder.
- Tuner: Done really stops listening — the mic the tuner opened is closed when the dialog closes (it used to stay open). (Dan's find.)
- Band levels renamed for the pot: Dry Noodles → Water's Boiling → Al Dente → Saucy → Chef's Kiss → Never a Doubt. New achievements: Noodler, Tied Up.

## 0.14.1
- Chords from the recordings, tried on a real song: the bass line now names the roots (pitch-tracked bar by bar) and the key it implies names major / minor — on American Appetites that turns a smear of Db / Gb / Ab guesses into B · G#m · E · F#. One chord a bar unless the bass moves mid-bar. A key label the bass disagrees with is overruled, and BandPad offers to fix the song's key.
- Key detection listens to the bass line first (the song's "Gm" label was a chroma misread; the bass says B).
- Pitch check: when most notes fall outside the labelled key, it checks the key against the bass and tells you, instead of marking the singer wrong.
- Tighten: a take that's late or early as a whole (a latency offset) is offered a one-nudge fix instead of warping. The toast says what the moved hits were off by, not the whole take.
- Auto mix: a bounced bed ("Backing (no drums)", "instrumental", a full mix) is treated as an instrument bed even on a vocal-type track.

## 0.14.0
- New layout — one screen per job, picked at the top (Ctrl+1–5): ✍ Write (the song: timeline + Lyrics, Chords, Notes, Needs, Ideas, Parts, History, Versions), ● Record (punch, monitor, input meter, tuner up top; channel strips, FX and the selected track's Takes below), 🎚 Mix (mixer, FX, master — Auto mix / Auto master / A/B up top), 🎙 Practice, ⚔ Band. Each remembers its own panel height and tab.
- ⚔ Band is its own page now: the band's level and boss battle, everyone's level and achievements, this song's quest, the setlist — plus who's rehearsing right now, practice this week, and the full band feed.
- The song header is down to Undo · Redo · Save · Share ▾ (bounce mix / stems, share a part with its chart, copy the chart, DAW hand-off, phone) · ⋯ (folder, deleted takes, Lighten Drive) · Close. The song's key sits next to bpm — click it to set, detect or transpose.
- 🎸 Chords from the recordings (Chords tab, a take's menu, or offered after a guitar / keys / bass take): BandPad listens and drafts the chords into the chord lane (dotted until someone edits them), using the bass track for slash chords and the song's key. Chords you typed are never replaced.
- ✨ Auto mix (Mix): listens to each track and sets levels by role (drums, bass, guitars, keys, lead and backing vocals), low-cut, mud / presence EQ, compression, guitars and harmonies panned apart, reverb on vocals. ✨ Auto master: master level to streaming-loud (−14 LUFS) with the limiter on. A/B (or B) flips before ⇄ after; Undo takes it back. Amp tones are never touched.
- ⇥ Tighten to the grid (right-click a take, or Record → Takes): pulls each hit part of the way onto 1/4 … 1/16 or triplets, with a strength slider and Preview. The attacks stay untouched; the original take stays in the folder — Undo tighten any time. MIDI takes quantize with the same strength.
- 🎯 Pitch check on vocal takes: every sung note against the melody (or the song's key) — flat notes marked blue on the take, sharp red, wrong notes amber, a per-part report. It only shows; nothing is auto-tuned.
- 📱 Practice on your phone: Share → Open on your phone (or 📱 in Practice) shows a QR code; on the same Wi-Fi your phone follows the song live — words, chords (or chords-only bars), the part you're in, capo display — with play / pause and part skips. Windows asks once to allow BandPad on private networks.
- 🎤 Show mode (in Practice): the setlist locked in order (the boss battle's songs when you start from one), big words and chords, the click only or click + backing tracks, nothing editable. Next / previous song by foot pedal (🦶 pedal… learns any key or MIDI note / CC) or the arrow keys. Settings → Click output sends the click to its own output (in-ears).
- Practice counts: minutes played in Practice go on the board (1 XP a minute, up to 60 a day), the Band page shows practice this week, the song list and feed show "🎙 rehearsing" live. New achievements: Woodshed (5 hours), Run It Down (a whole setlist).

## 0.13.1
- 🎙 Practice moved to the top bar (next to record) — or press K. It's out of the Lyrics tab.
- Practice has real transport now: play/pause, back/forward a bar, previous/next part, and a scrub bar with the song's parts drawn in it (click or drag to jump). 1–9 jumps to a part, Shift+1–9 loops it.
- Loop any part from a list (not just the one you're in).
- 🎚 Mix: take any tracks out and play along with the rest (or hear just one). It remembers by track name, so it carries through the setlist.
- Slower (95% … 50%, same pitch) works on the whole song, or on the part you're looping; - / + steps it.
- Click on/off and level, a bar of count-in before it starts.
- Words + chords / chords only (the part as big bars, the one you're in lit) / words only.
- Show the chords moved up or down for a capo or another tuning.
- Setlist: previous / next song and a countdown gap between songs.

## 0.13.0
- 🎤 Lyrics from the singing: Lyrics tab → From the vocals (or right-click a take / track → Lyrics from this take) writes the words out, each line pinned where it's sung with word-by-word timing. Runs on your computer (the speech model downloads once, ~250 MB; Settings → Speech to pick faster/better). Lines you already typed win — they get pinned where they're sung instead of duplicated; only words nobody typed are added. It listens to the lead vocal's audible takes (harmonies/doubles only where the lead isn't singing). Works read-only too. After a vocal take it offers to do it for you.
- 🎙 Practice (karaoke): full-screen lyrics, the word being sung lights up, chords over the words, the part you're in, a countdown into the next line, "no words yet" on vocal parts without lyrics. Vocals as a guide or muted, slower at the same pitch, loop the part, record while you practice. ▶▶ setlist plays every song back to back in the board's order with a set clock.
- Parts overlap cleanly: a pickup or ring-out up to a bar either side of a part belongs to that part — moving, duplicating, deleting or linking the part carries it, and it no longer chops the neighbour. A lead vocal sung straight through doesn't unlink every chorus.
- Takes are stored as FLAC — the exact same audio as before, about half the Drive space. Files tab → Lighten Drive… converts every older WAV take and clears audio nothing has used for 30 days (versions, the last 500 saves, deleted songs, the parts bin and bounces are kept). Bandmates need 0.13 to play FLAC takes.
- Comp: right-click a take → Comp → this take for the loop / for a part. It's the only one heard there; everything else plays as before.
- Punch in/out: tick "punch" by the loop bars, hit R — one bar of pre-roll, it records, stops itself after the range, and the take only plays inside it (the rest stays in the file as handles). The other takes go quiet inside the range.
- Crash-safe recording: while you record, the audio streams to your computer every second. If BandPad or the computer dies mid-take, opening the song offers "Recover the take".
- What changed: opening a song tells you what happened since you were last in it — who did what, new takes (outlined "new" on the timeline, one click to hear them), which parts' words or chords changed (and from what), new notes.
- Number keys jump to parts (1 = first part…), Shift+number loops it. ? shows every shortcut. T opens the tuner (guitar and bass strings, A4 adjustable).
- Count-in clicks sound different from the metronome, so you can hear where the song starts.
- My track setups: right-click a track → Save as my track setup — your rigs (amp, FX, level) sit at the top of Add track on your computer.
- Share a part: right-click a part → Share — bounces it (with a bar of ring-out) plus its chart (chords over the words, open notes) and copies a message for the group chat.
- DAW hand-off now has the parts as REAPER regions, chords as markers, a MIDI lyrics track and chart.txt.
- Parts bin carries the words: a saved part keeps its lyrics (and drops them in with it). A sung/hummed sketch in Ideas → Words from this sketch → unpinned lyric lines, which get pinned once the real vocal is in.
- Open "needs" show on the Band tab next to the tasks. Taking care of one: after a take that covers it, BandPad offers to tick it.
- Speech-to-text lyrics count a little XP (1 per line); fix a line and it's yours (3).

## 0.12.3
- A Post-chorus is its own part now (every spelling: Post-chorus, Post Chorus, Postchorus). It used to count as a Chorus, so dragging one in from This song's parts landed as "Chorus 3" and linking grouped it with the choruses. Post-choruses now link only to each other.
- Dropped / duplicated parts are named after the part you dragged (Post-chorus → Post-chorus 2, Big Chorus → Big Chorus 2).

## 0.12.2
- Measure (latency) fixed: it read near-silence as a 0 ms round trip. Now it times each click's arrival (6 clicks, 1.1 s apart so nothing can alias), refuses if the input is silent, and shows each click's delay.

## 0.12.1
- Same as 0.12.0's notes below — the first 0.12.0 upload went out before the audio output / Measure / low-pass / game-layer rework was in, so this one carries all of it.

## 0.12.0
- ⚔ BandPad keeps score now — and it's all counted from the songs themselves, nothing to fill in. Every take you record (25 XP), MIDI / drum part (15), note (5), reply (3), chord (2), lyric line (3), part laid out (5), need closed (5), idea (5), version tag (10), part saved to the bin (10) and save (1) counts for whoever did it, in every song on the Drive, including everything already there.
- Your level chip at the top (Roadie → Open Mic → Garage Hero → Basement Star → Local Legend → Headliner → Touring Act → Rock Star → Hall of Famer → Never a Doubt), a "+25 XP" pop when you do something that counts, level-up and achievement toasts (First Take, Scribe, Chord Nerd, Architect, Night Owl, Early Bird, On a Roll, Multi-Instrumentalist, Triple Threat, Parts Written, Everywhere…).
- The ⚔ Band tab in every song: the band's level and XP (Garage Jammers → Finding the Groove → Basement Show Heroes → Opening Act → Headliners → Never a Doubt), the next boss battle with a countdown and how many target songs are show-ready, every bandmate with level, XP, achievements (click one for the breakdown), and THIS song as a quest: goals (Final Title / Final Structure / Show Ready), its milestones (structure laid out, chords, lyrics, everyone's taken a pass, bounced, demo, done), each member's parts written — the share of the song's parts their takes cover, counted live (a linked copy counts: your verse plays in every verse) — and tasks (@Name assigns one). Then the whole setlist with XP bars (right-click: boss target, hide, add a cover that isn't in BandPad).
- Song list shows every song's XP bar; the band feed shows the XP each thing earned and the goals / tasks people tick.
- Dan's board is in: his setlist order, the covers that aren't BandPad songs, the Tremors task, the January house show, and his percentages for anyone who hasn't recorded in BandPad yet (the moment they do, the real count takes over; right-click a bandmate's row → "set by hand" for people who record elsewhere).
- Band feed minimizes: click its header; folded, it counts what's new.
- Low-pass filter on every track (FX → Low-pass, cut above … Hz): takes the pick / fret click off a bass DI, tames fizz. Bass preset "No Clicks" (DI, top rolled off at 2.5 kHz).
- Hear yourself through the track: with monitoring on, the live input runs through the armed track's amp sim, EQ, compressor, sends and fader in real time — what you hear while you play is what the take will sound like (takes still record dry, so you can change the FX later). Right-click the monitor chip to switch to dry.
- Settings → Audio output: pick your interface's headphone / line out (Focusrite etc.) instead of whatever Windows calls default.
- Settings → Measure next to the latency offset: BandPad plays 8 clicks out the output, hears them on the input, and sets the offset from the real round trip — takes land where you played them. Point the input at the output first (a cable from line out to an input, or a mic that can hear the monitors).

## 0.11.1
- Band feed minimizes: click its header (▾ / ▸). Folded, it shows how many new things happened (and who's in a song right now); the song list takes the space. It remembers.

## 0.11.0
- Repeated parts are linked by themselves: every Pre-chorus plays the first one. A copy that already had its own takes stays its own (nothing gets replaced); right-click → Unlink / Re-link / Stop linking still work, and "Stop linking" stays off.
- Edit from ANY copy: record a new guitar part in Pre-chorus 3 and it lands in the first Pre-chorus, so every Pre-chorus plays it (what it covers gets muted, like any new take). Move, trim, split, delete, gain, mute, fades and MIDI notes on a copy all change every copy. A run-through take that runs into a copy keeps its own performance — that copy unlinks itself.
- Notes in a part show in every linked copy of it (same thread — reply / resolve from any of them). Chords set in a copy go to every copy.
- Parts tab → "This song": every part of the song. Drag one onto the timeline (or right-click → at the playhead / after… / at the end) to add another copy — linked, so it already plays.
- Deleting or moving the first copy hands its takes to the next one instead of being blocked.
- Delete song: right-click a song → Delete song… (not while someone else has it open). The folder moves to "_deleted" in the band Drive folder; right-click → Deleted songs… brings it back.

## 0.10.0
- 6/8 clicks right: six eighths with 1 strong and 4 accented (same for 9/8, 12/8; 7/8 clicks 2+2+3). The count-in follows the meter where the take starts.
- Any time signature: Time signature → Other… (or the new-song wizard) takes 13/7, 5/4, 11/8 … and groupings like 2+2+3/8 or 3+2+2/8 to set where the click accents fall.
- Each part can have its own tempo and time signature: right-click a part → Tempo & time signature… ("90 6/8", "140", "7/8"). It keeps its bar count; what follows moves to fit; MIDI, chords and lyrics inside re-time (audio keeps its speed). The ruler marks the change in orange; bar numbers, grid, snap, loops, click, drum machine and generators follow each part. "Back to the song tempo / time signature" undoes it.
- DAW hand-off: the MIDI file and REAPER project carry the tempo / meter changes.

## 0.9.1
- Parts move with their takes. Right-click a part (Verse, Chorus…):
  - Delete it + its takes and close the gap (everything after moves up) — or leave the empty bars — or delete just the marker.
  - Slice every track at its edges.
  - "Takes move with this part" (or with every part): dragging the part takes its takes, chords and lyrics along.
  - Duplicate it (a copy goes right after), move it earlier / later (swaps with the neighbour), split it in two (at the playhead), merge with the next part, insert 1–8 empty bars before / after.
  - Chords, lyric lines and notes follow; one Undo puts it all back. A linked room has to be unlinked first.

## 0.9.0
- Track locks — the whole band can work in one song at the same time. Every track has a 🔒: click it to unlock the track for you (or "🔓 Unlock all" at the top). Nobody else can touch a track you've unlocked; you can't touch theirs ("🔒 Dan" on the track). Click 🔓 again (or "Lock all") to free it — and a track nobody has touched for 10 minutes locks itself.
- While someone else has the song open you can still unlock free tracks and record / edit them; your tracks reach them in a few seconds and they save them into the song. Tempo, time signature, structure, master and track order stay with whoever has the song, and whole-song changes (tempo, transpose, restructure) wait until nobody else has a track unlocked.
- Mute / solo on a track that isn't yours is just for your ears. Undo never rolls back a track someone else has unlocked.
- Melody dialog: every part you write in one visit gets its lyrics placed (it used to place only the last part's). Right-click a melody take → "Use this melody in every Chorus" copies it (and its lyric lines) to the other choruses.
- Note editor: a "part" picker (any section, the whole song, or the loop) — the riff generator can fill the whole song in one go.
- Drum editor opens on the part you're looping.

## 0.8.4
- Transpose: only drum-type tracks (the drum machine, or a track whose type is Drums) are left alone — track names no longer matter, so "Backing (no drums)" moves with the song.
- Transpose → tempo change → transpose back lands on the original recordings again (no more processing stacked on processing).
- Read-only bandmates can talk: notes, replies, needs (add / tick), reactions and lyric edits work while someone else has the song — they go through the song's mailbox and the editor's BandPad merges them in within seconds ("Kat: …" in the feed).
- "Waiting to edit": trying to edit a song someone else has shows you as ⏳ waiting to them, and you get a "the song is free" nudge with a Take over button.
- Nothing is armed when a song opens (it used to arm the first track, so a bandmate's vocal landed on the guitar). R records onto the selected track, or asks you to arm one.
- Sections can't overlap: dragging lands in the nearest free spot; edges and "Bars…" stop at the neighbours. "End at the playhead" does what its label says.
- Restructure keeps an "unlinked on purpose" section in its role (e.g. the last chorus stays the different one) and always fills the first one from the real room; needs pinned to a section follow it.
- Roll back / Restore version ("tracks & takes") with linked sections brings back the sections they were laid out in; linked copies aren't dumped into Deleted takes.
- Needs list keeps its order when you tick an item (no more ticking the wrong one). Enter sends a note reply (Shift+Enter = new line). Opening a thread clears it from "For you".
- Melody / note / drum editors don't save on every roll — the song saves when you're done.
- Double-click an empty spot on a MIDI track opens the note editor again. ↑/↓ in the note editor reaches bass notes below C2. Ctrl+D copies land on the grid. Riff "different notes" is capped at 7.
- Melody dialog opens on the part you're looping. Snap follows the zoom a step sooner. The + track / 🥁 / snap / import row fits again (it was spilling onto the first track).
- When you both edit the same note / need / lyric, the merge message says so (yours is kept).
- "+ track" picks a name that isn't taken. Custom section names can't duplicate. Chart shows "-" (not "%") in sections without chords. Chords-only sections can be saved to the Parts bin. Typed chords are checked. Loop bars are capped and swapped if reversed. Loop recording warns at 20 passes and stops at 50. The view follows the playhead after stop / Home. Ctrl+Z works right after typing a tempo. Colour picker opens by the track. Deleted takes says when a file is an old tempo / key render.
- Recording memory: a finished take no longer keeps a second full copy of itself in memory.
- Removed: Harmony / shift pitch (didn't sound good enough).

## 0.8.3
- Snap follows the zoom everywhere: section markers, takes (move / trim), loop drags on the ruler, chords and clicks snap to the grid you can see — zoom in (Ctrl+wheel) for 1/8, 1/16, 1/32; zoom out for beats and bars. The "snap" chip under + track shows the current value; click it to lock one (Bar, Beat, 1/8…) or set it back to follow the zoom. Hold Alt while dragging for no snap.
- Dragging a take to another track: the take rides under your mouse (waveform and all), an outline shows where it will land on the other track (red if it's the wrong kind of track), and the original stays faded in place until you let go. Shift-drag drops a copy instead.
- Note editor: Ctrl+D duplicates the selected note right after itself (keep pressing to stamp copies), Shift-drag a note to drag a copy, or right-click → Duplicate. Snap there is "auto (zoom)" by default — Ctrl+wheel over the notes zooms time and the grid follows.

## 0.8.2
- (Harmony from a recorded take — removed again in 0.8.4; it didn't sound good enough.)

## 0.8.1
- Draw MIDI notes: double-click an empty spot on any MIDI track (or right-click the track → Draw notes / riff generator…). The piano roll opens on the loop (or the section): click-drag to draw a note (snaps to 1/32 — change the snap to 1/16, 1/8, triplets…), scroll up/down through every pitch, right-click a note for power chords / add 3rd / any chord. Edits are heard right away while it loops (Space plays/stops).
- Riff generator in that window: pick the note speed (1/2 … 1/16, triplets), how many different notes, busy, syncopated, note length (chug ↔ legato), low note, power chords, follow the chords → 🎲 Riff; New notes / New rhythm re-roll one half.
- Guitar sounds for MIDI tracks: clean, crunch, distorted, palm-muted chug, acoustic, picked bass (Source menu, or + track → Guitar (MIDI) / Bass (MIDI)). Power chords distort together like a real amp.
- Updates can now arrive in pieces, so new versions reach the Update button faster.
- Drum machine: with nothing else in the song it now plays until you stop (it stopped after 4 bars); the drum editor has a "Whole song" part, and the drum machine panel has a button to open the editor.

## 0.8.0
- Drum generator + drum editor (🥁 button next to + track, or right-click a section → Drums for …): pick a style (rock, pop-punk, skate, half-time, funk, four-on-the-floor, metal, shuffle, ska, ballad, blast) and feel, hit 🎲 Generate for a whole part with fills and crashes, then click squares to add / accent / remove hits (drag to paint). Every drum row has a fill menu: 1/4, 1/8, 1/16, triplets, backbeat, off-beats, whole bars, clear. The part replaces the drum machine's groove in that section and exports to your DAW as MIDI.
- Chords on MIDI notes: right-click a take on a synth track → Edit notes… opens a piano roll; right-click any note → power chord, add 5th, add 3rd (in key), add octave, triad in key, harmony a 3rd above / 6th below, or any chord type (major, minor, 7, maj7, m7, sus, dim, aug, add9, 9, 11, 13…). The chord shows as one block on the root note with its name; split it back into separate notes any time. Works in the melody editor too (vocal harmonies).
- Drag a track's name up or down to reorder tracks.
- Draggable dividers: songs list | timeline and mixer | Track FX | side tabs (double-click a divider to reset); the bottom panel's handle is bigger and goes smaller.
- Band feed (bottom of the songs list): everything the band does across every song, live — who's in which song right now, edits, takes, new parts. Click an entry to open that song.
- Parts bin: parts are auto-tagged (instruments, section, song style); add your own tags and a style from the part's right-click menu; sort by style / name / tempo / key / who; click a tag to filter.
- Noodle pad (🎸 next to + Songs): your own scratch song with a 4-bar loop — record whatever, and each take offers "Save to Parts bin".
- Opening a song starts at bar 1 (it kept the last song's scroll).
- Context menus now work inside dialogs.

## 0.7.0
- Fixed (data loss): after an autosave, dragging/resizing sections and deleting chords silently did nothing.
- Fixed (data loss): linking choruses could leave silent take pieces pointing at missing audio.
- Fixed (data loss): a bandmate's take could vanish if a merge landed while you were in A/B.
- Fixed: deleting the track you're recording on is blocked (it lost the take).
- Fixed: playback stopped after 4 bars on a song with only the drum machine (and never stopped on others) — it now plays to the end of your sections.
- Fixed: a false "Drive delivered an OLDER version" banner while working alone.
- Fixed: if BandPad's window crashes (e.g. out of memory), it now restarts itself instead of staying blank with the song locked. Unsaved changes while read-only are backed up every few seconds.
- New-song: bad or taken names (incl. different upper/lower case) are caught before anything closes; a blank tempo uses the style's tempo; names starting with "." or "_" are cleaned up.
- Tempo box: blank / letters / out-of-range are ignored; letters typed in number boxes no longer trigger shortcuts (m muted a take).
- Melody: bringing back a kept melody no longer closes the window; Cancel really undoes everything (no stray melody, no empty Melody track, nothing left in Undo); first draw of the note editor is the right size; notes can't be dragged out of view; the window fits on a laptop screen.
- Key detection: a few MIDI notes no longer outvote all the recordings; the relative major/minor (same notes) is offered as the alternative; a section in the relative key isn't flagged as a key change.
- Parts bin: drums keep their pitch when a part is dropped into another key.
- Opening a song shows a loading bar.
- Takes: dragging/trimming shows movement again, double-click rename works, the track list no longer jumps to the top; dropped files: one bad file doesn't stop the rest, audio dropped on a drum-machine/synth lane gets its own track.
- Smaller: toasts with buttons expire and are cleared when you switch songs; Settings Cancel works with a bad value; loop bar boxes follow tempo/time-sig changes; "Bars 10-3" means 3–10; no-song Ctrl+Z / Space / [ ] are harmless; import is blocked while read-only; "2 other Choruses".

## 0.6.7
- Transpose: Song menu → Transpose song moves the recordings (pitch-shifted, same tempo), MIDI notes, chords and the key up or down together. Drums are left alone. The original recordings are kept: transposing back returns to them, and Ctrl+Z undoes. Best for trying a song in another key — past 3–4 half steps vocals sound processed; re-track for keeps.
- A section's Key change now really moves it: right-click a section → Key change lists only the keys it can be shifted to (major stays major, minor stays minor), and the takes, MIDI and chords in it move with it (linked sections move together). "Fix the label only" is still there for when the key name is just wrong.

## 0.6.7
- Transpose: Song menu → Transpose song, or right-click a section → Transpose. Moves the recordings (pitch-shifted, same tempo), MIDI notes, chords and the key up or down together. Drums are left alone; linked sections move together. The original recordings are kept: transposing back returns to them, and Ctrl+Z undoes. Best for trying a song in another key — past 3–4 half steps vocals sound processed; re-track for keeps.
- Section "Key change" is marked as label only (it doesn't move recordings — Transpose does).

## 0.6.6
- Click a take on the track that's already selected and the playhead jumps to where you clicked. (The first click just selects, like before; dragging still moves the take.)

## 0.6.5
- Loop by dragging: drag across the bar numbers at the top to loop those bars (whole bars; hold Alt for beats). A plain click still just moves the playhead.
- Updating no longer pops up a black terminal window while BandPad closes, and it can't get stuck waiting if BandPad is slow to close (it closes it after two minutes and installs).

## 0.6.4
- Melody note editor: the melody window now has a piano roll. Drag notes up/down and sideways, drag a note's right end to stretch it, double-click to add or delete, ↑↓ nudges the selected note (Shift = octave). "Stay in key" keeps every note in the key. Opening the melody window on a part that already has a melody loads it for editing; Cancel puts it back as it was.
- Song key from your recordings: BandPad listens to the guitar, bass, keys and vocal takes (not drums) and figures out the key. It's set by itself after the first takes go into a song with no key (with an Undo button), and Song menu → Key → Detect from the tracks works any time. Right-click a section's key → Detect from what's recorded here finds a key change.
- Import audio: drag WAV / MP3 / M4A files from anywhere onto BandPad and each becomes its own track (drop on a track's lane to add it to that track). Or use the new ⤓ import button next to + track.
- Fixed: after a failed update, "Try again" did nothing. It now re-checks Drive and retries.
- Melody: ▶ Play and 🗣 Say it now loop the part you're writing the melody for (not whatever loop was set before). Your old loop comes back when you close the dialog.

## 0.6.2
- Parts are whole measures with a time signature: the Parts list shows e.g. "3/4 · 4 bars"; a saved take grows to its bar lines; right-click a part to change its time signature or length. Parts drop on a bar line, and you get a heads-up when a part's time signature doesn't match the song.

## 0.6.1
- Sections drag smoothly now: grab a section to move it, grab an edge to resize it. The block follows your mouse, a dashed outline shows the bars it will snap to, and it settles there when you let go.

## 0.6.0
- Melody from lyrics: type the words, pick a part (Lyrics tab → 🎵 Melody…, or right-click a section). Syllables are counted, stressed words land on strong beats, and the notes follow the key and your chord strip using songwriting rules (mostly steps, chord tones on the beat, lines that rise and resolve, line 3 echoes line 1).
- 🎲 Again rolls a new melody every click; New notes / New rhythm keep the other half; ☆ Keep the ones you like; Say it speaks the words in time.
- Guide voice: the melody goes on a Melody track that sings the vowels in tune, with each syllable shown under its note. Lines can be pinned as lyrics where they're sung.
- Key changes per section (right-click a section → Key change). Chords, the chart, melodies and dropped parts follow the key at that spot.
- Parts now know their key: taken from the song, or heard from the notes / audio. Right-click a part → Key to correct it; parts with an unsure key are not shifted.

## 0.5.0
- New song wizard: 35 styles (pop-punk, emo, metalcore, indie, country, hip-hop, EDM, jazz…) with several song structures each — sections, tempo, key, starter tracks and a matching groove are laid out for you.
- Section rooms: right-click a section → Link all Choruses. Record once in the Chorus room and it plays in every Chorus. Unlink any one to make it different (e.g. the last chorus).
- Restructure song: re-cut your labelled parts into a new structure (e.g. Verse – Half chorus – Verse – Chorus – Verse – Bridge – Chorus – Outro).
- Parts bin: save a riff or section, drop it into any song — it is re-timed to that song's tempo and moved to its key automatically.
- Tempo changes now carry the recorded takes along like tape (pitch follows speed). Right-click the tempo for "keep takes as they are".
- History: every save is a roll-back point. Right-click a line in the Feed → listen to the song before it (A/B) or roll back. Undo works on roll-backs.
- Writing mode (on by default): hides the mixer/FX so the screen is about parts, takes, lyrics and chords. ✍ Writing toggles it.
- Chart tab: chord chart + lyric sheet by section, transposable; copy it to the group chat or save a printable copy.
- Chord picker knows the song key: click the chord strip for the chords that fit, or lay a whole progression.
- Needs can be assigned (@Logan, or right-click → Assign) and tied to a section; you get a "for you" badge on the song list. Songs get a stage (idea / writing / demo / done) with a filter.
- Practice: right-click a section or the loop → practice at 50–90% speed, same pitch.
- Also: section markers, note reply threads with resolve, take voting (★), timed lyrics (press P to pin), chord lane, idea scratchpad, @mentions, version tags with A/B, "who's in the song" presence, Drums (mics) track type.
- Safer collaboration: smarter merges when two people save, laptops waking from sleep can't steal the song, saved input device falls back to the default mic, AirPods/USB mic drop-outs are caught, Mac self-update rolls back if it fails.
