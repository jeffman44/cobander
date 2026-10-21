#!/usr/bin/env python3
"""Generate the Cobander manual pages (docs/manual/*.html) from one template."""
import os, html

OUT = '/home/claude/bandpad/docs/manual'

PAGES = [
    # (file, nav label, group)
    ('index.html', 'Start here', 'Basics'),
    ('write.html', 'Write', 'Workspaces'),
    ('record.html', 'Record', 'Workspaces'),
    ('mix.html', 'Mix', 'Workspaces'),
    ('practice.html', 'Practice', 'Workspaces'),
    ('band.html', 'Band', 'Workspaces'),
    ('together.html', 'Together', 'The band'),
    ('keys.html', 'Free &amp; Send noods', 'The band'),
    ('shortcuts.html', 'Keyboard shortcuts', 'Reference'),
    ('faq.html', 'Troubleshooting', 'Reference'),
]

HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — Cobander manual</title>
<meta name="description" content="{desc}">
<link rel="icon" href="../icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="manual.css">
</head>
<body>
<div class="page">
  <aside class="side"><div class="sticky">
    <a class="back" href="../">← cobander.com</a>
    <div class="title">COBANDER<small>the manual</small></div>
    <nav aria-label="Manual pages"><ul>
{nav}
    </ul></nav>
  </div></aside>
  <article>
'''

FOOT = '''
    <div class="next">{prev}{next}</div>
  </article>
</div>
</body>
</html>
'''


def nav_for(current):
    out, grp = [], None
    for f, label, g in PAGES:
        if g != grp:
            out.append(f'      <li class="grp">{g}</li>')
            grp = g
        cls = ' class="here"' if f == current else ''
        out.append(f'      <li><a{cls} href="{f}">{label}</a></li>')
    return '\n'.join(out)


def write_page(file, title, desc, body):
    i = [p[0] for p in PAGES].index(file)
    prev = f'<a href="{PAGES[i-1][0]}">← {PAGES[i-1][1]}</a>' if i > 0 else '<span></span>'
    nxt = f'<a href="{PAGES[i+1][0]}">{PAGES[i+1][1]} →</a>' if i < len(PAGES) - 1 else '<span></span>'
    doc = HEAD.format(title=title, desc=html.escape(desc, quote=True), nav=nav_for(file)) + body.strip('\n') + FOOT.format(prev=prev, next=nxt)
    with open(os.path.join(OUT, file), 'w') as fh:
        fh.write(doc)
    print('wrote', file, len(doc.splitlines()), 'lines')


# ---------------------------------------------------------------- index
write_page('index.html', 'Start here', 'How to use Cobander: setup, the five workspaces, working together through a shared folder, keys, shortcuts and troubleshooting.', '''
<h1>The manual</h1>
<p class="lede">Cobander is a sketchpad for your whole band. Everyone records, writes, mixes and practices on their own computer. The song lives in one folder the band already shares. This manual is written for people who have never used recording software.</p>

<h2>Setup, in one breath</h2>
<ol>
  <li>Open Cobander and type your name. Bandmates see it on the takes you record.</li>
  <li>Click ⚙ and point Cobander at a folder inside the cloud folder your band shares (Google Drive, OneDrive, iCloud Drive or Dropbox). A new folder is fine: <code>Band stuff / Cobander</code>.</li>
  <li>Every bandmate does the same, with the same folder. That's it. Songs, takes, chords and words show up for everyone within seconds.</li>
</ol>
<div class="tip">Share the folder with the band from the cloud app itself (Drive "Share", OneDrive "Share", iCloud "Collaborate", Dropbox "Share"). Then turn on "always keep on this device" / "available offline" for it, so takes aren't downloading in the middle of a song.</div>

<h2>The first time you open it</h2>
<ul>
  <li><b>Windows</b> shows "Windows protected your PC". Click <b>More info</b>, then <b>Run anyway</b>. That's SmartScreen not recognising a new installer. It happens once.</li>
  <li><b>Mac</b>: right-click the app and choose <b>Open</b> the first time. After that it opens normally.</li>
  <li>Cobander then asks for two things before the first song: your name and the band's shared folder. Both live under ⚙ (Settings).</li>
  <li>The first time you record, your computer asks for microphone permission. Say yes.</li>
</ul>

<h2>The five screens</h2>
<p>Cobander is split into five screens, one for each stage of making a song. Pick one at the top, or press <kbd>Ctrl</kbd>+<kbd>1</kbd> to <kbd>5</kbd> (<kbd>Cmd</kbd> on a Mac). Nothing is lost when you move between them.</p>
<ul class="toc">
  <li><a href="write.html"><b>Write</b><span>The song: parts, takes, lyrics, chords, notes, ideas, the Parts bin, History and Versions.</span></a></li>
  <li><a href="record.html"><b>Record</b><span>Pick your input, hear yourself, punch in, tune up, see the takes on the selected track.</span></a></li>
  <li><a href="mix.html"><b>Mix</b><span>Each track's volume, left/right position and effects. Auto mix and Auto master do a first pass.</span></a></li>
  <li><a href="practice.html"><b>Practice</b><span>Full screen: lyrics and chords as they come, loop parts, slow down, take yourself out of the mix, Show mode, your phone.</span></a></li>
  <li><a href="band.html"><b>Band</b><span>The band's level, the setlist, the boss battle, who's done what, Loose ends, who's rehearsing.</span></a></li>
</ul>

<h2>Everything else</h2>
<ul class="toc">
  <li><a href="together.html"><b>Together</b><span>The shared folder, locks, presence, @mentions, the Band feed, the phone page.</span></a></li>
  <li><a href="keys.html"><b>Free &amp; Send noods</b><span>What's free, what a key does, how to enter one, what to do if you lose it.</span></a></li>
  <li><a href="shortcuts.html"><b>Keyboard shortcuts</b><span>Every key, in one place.</span></a></li>
  <li><a href="faq.html"><b>Troubleshooting</b><span>SmartScreen, no mic, a locked song, a folder that won't sync, a key that isn't accepted.</span></a></li>
</ul>

<h2>Help is built in</h2>
<ul>
  <li>Hover anything in Cobander for a plain-English tip.</li>
  <li>Press <kbd>F1</kbd> (or the <b>?</b> button at the top right) for help mode: little ? marks appear on everything and tips show instantly.</li>
  <li>Press <kbd>F1</kbd> again for the glossary, the words that trip people up (track, take, bar, click, latency, comp…).</li>
  <li>Press <kbd>?</kbd> for the keyboard shortcut sheet.</li>
</ul>

<h2>How updates work</h2>
<ul>
  <li>Cobander updates itself. It checks the band folder (and GitHub) every 10 minutes, or right now when you click <b>Check for updates</b> under ⚙.</li>
  <li>When a new version is out, a blue <b>Update bar</b> appears across the top of the window. It says which version is ready and which you have.</li>
  <li>Click <b>Update now</b>. Cobander saves your song, downloads the update, checks it, then closes and reopens by itself. <b>What's new</b> shows the changes; <b>Later</b> hides the bar for now.</li>
  <li>If the bar says it is still "waiting for Google Drive" (or your cloud), the new version is still syncing to your computer. <b>Check again</b> once it has.</li>
  <li>Updates are free and never required. A bandmate on an older version still sees your songs.</li>
</ul>

<h2>Words you'll see a lot</h2>
<ul>
  <li><b>Track</b>: one instrument or voice. A song is a stack of tracks playing together.</li>
  <li><b>Take</b>: one recording on a track. Keep several and pick the best.</li>
  <li><b>Part</b>: a section of the song (Intro, Verse, Chorus…).</li>
  <li><b>Bar</b>: a chunk of time, usually 4 beats. Songs are counted in bars.</li>
  <li><b>Click</b>: a metronome you hear in your headphones. It is not in the recording.</li>
  <li><b>Playhead</b>: the line that shows where you are in the song.</li>
</ul>
''')

# ---------------------------------------------------------------- write
write_page('write.html', 'Write', 'The Write workspace: parts, tracks, takes, lyrics, chords, notes, needs, ideas, the Parts bin, History and Versions.', '''
<h1>Write</h1>
<p class="lede">The song itself: parts on a timeline, tracks stacked below, and tabs on the right for Lyrics, Chords, Notes, Needs, Ideas, Parts, History and Versions. <kbd>Ctrl</kbd>+<kbd>1</kbd>.</p>

<h2>Start a song</h2>
<ul>
  <li>Click <b>+</b> next to <b>Songs</b> on the left. Give it a working title; you can rename it later.</li>
  <li>Pick a style (punk, folk, hip-hop, metal… 35 of them). It sets up the tempo, time signature, section order, starter tracks and a matching drum groove. Everything can be changed later.</li>
  <li>Not sure of the key? Guess. Cobander can hear it from a take later.</li>
  <li>Free Cobander keeps one song per band folder. The second song asks for a Send noods key. See <a href="keys.html">Free &amp; Send noods</a>.</li>
</ul>

<h2>The top row</h2>
<ul>
  <li><b>bpm</b>: how fast the song goes. 120 is a medium tempo.</li>
  <li><b>Time signature</b>: how many beats in each bar. 4/4 is most songs. <b>Other…</b> takes anything, including groupings like 2+2+3/8.</li>
  <li><b>key</b>: the home note of the song (G, Bm…). Click it to set it, detect it from the tracks, or transpose the whole song. A ⚠ means the takes disagree with the label; click it to see what the bass line says.</li>
  <li><b>click</b>: the metronome. Turn it on when you record to a bare song; turn it off once the drums are there.</li>
  <li><b>count-in</b>: one bar of clicks before recording starts, so you know when to come in.</li>
  <li><b>loop</b>: play the same stretch of bars over and over. Set the bars here, drag across the bar numbers at the top of the timeline, or press <kbd>L</kbd> to loop the part you're in. <b>here</b> loops 4 bars from the playhead; <b>take</b> loops exactly the selected take.</li>
</ul>

<h2>Parts (sections)</h2>
<ul>
  <li>The <b>sections</b> strip above the tracks shows Intro, Verse, Chorus… Right-click the strip to add one. Grab a part to move it; grab its edge to resize it.</li>
  <li><b>Repeated parts are linked.</b> Every Chorus plays the first one. Record or write in any copy and all of them change. Right-click a part → <b>Unlink</b> to make one different (the last chorus, say). <b>Stop linking</b> turns this off for the song.</li>
  <li>Right-click a part for the rest: delete it and close the gap, duplicate it, move it earlier or later, split it at the playhead, merge with the next, insert empty bars, give it its own tempo and time signature, change its key, write drums for it.</li>
  <li><b>Restructure song…</b> re-cuts your labelled parts into a new order (Verse – Chorus – Verse – Bridge – Chorus…). Nothing is deleted; Undo brings the old order back.</li>
  <li>Press <kbd>1</kbd>–<kbd>9</kbd> to jump to a part. <kbd>Shift</kbd>+number loops it.</li>
</ul>

<h2>Tracks and takes</h2>
<ul>
  <li><b>+ track</b> asks what you're recording: Guitar, Bass, Vocals, Anything else, Drums (mics), Drum machine, Synth / keys, Guitar (MIDI), Bass (MIDI). Each comes with a sensible sound. Track types also set themselves from the name (bass, drums, vox…).</li>
  <li>Drag a track's name up or down to reorder. <b>↕</b> (or <kbd>Alt</kbd>+wheel over the tracks) changes the track height so more fit on screen.</li>
  <li>Click a take to select it. Drag it to move it; drag its ends to trim; drag it to another track to move it there (<kbd>Shift</kbd>-drag drops a copy). <kbd>S</kbd> splits it at the playhead, <kbd>M</kbd> mutes it, <kbd>Del</kbd> deletes it.</li>
  <li><b>snap</b> makes things you drag land exactly on the beat grid. Zoom in (<kbd>Ctrl</kbd>+wheel) for a finer grid. Hold <kbd>Alt</kbd> while dragging to ignore snap once.</li>
  <li>Right-click a take for everything else: keep this take, Comp, ★ Star it (the take with the most stars plays), fades, Normalize, Timing report, Tighten to the grid, Pitch check, Lyrics from this take, Chords from this track, Save to the Parts bin.</li>
  <li><b>⤓ import</b> brings in WAV, MP3 or M4A files, or drag them straight onto the timeline. Each becomes its own track.</li>
  <li>Deleted a take by mistake? <b>⋯ → Deleted takes</b> brings it back. The audio stays in the song folder.</li>
</ul>

<h2>Sketch without a mic</h2>
<ul>
  <li><b>🥁 Drums</b> (next to + track, or right-click a part → Drums for…): pick a style and feel, hit <b>🎲 Generate</b> for a whole part with fills, then click squares to add, accent or remove hits. Each row's <b>fill</b> menu fills the whole part.</li>
  <li><b>Draw notes</b>: double-click an empty spot on any MIDI track (Synth / keys, Guitar (MIDI), Bass (MIDI)). Click-drag to draw a note, right-click a note for power chords or any chord. The <b>🎲 Riff</b> generator writes a riff that follows your chords.</li>
  <li><b>🎵 Melody…</b> (Lyrics tab): type the words, pick a part, and Cobander writes a tune for them in key, over your chords. <b>🎲 Again</b> rolls a new one; <b>☆ Keep</b> saves the ones you like. A guide voice sings the vowels so you can hear it.</li>
</ul>

<h2>Lyrics</h2>
<ul>
  <li><b>Add lines…</b>: paste or type the words, one line per row. They start unpinned.</li>
  <li><b>Pin next (P)</b>: play the song and press <kbd>P</kbd> as each line is sung. That is what Practice and the chart read from.</li>
  <li><b>From the vocals</b>: Cobander listens to the vocal takes and types out the words, each line pinned where it's sung, word by word. It runs on your computer; the speech model downloads once (about 250 MB). Lines you already typed win; only words nobody typed are added. After a vocal take it offers to do this for you.</li>
</ul>

<h2>Chords</h2>
<ul>
  <li>Click the <b>chords</b> strip above the tracks to add a chord at that beat. The picker knows the song's key and offers chords that fit, or a whole progression.</li>
  <li><b>From the recordings</b> (Chords tab): Cobander listens to the guitar / keys / bass takes and drafts the chords, bar by bar, with the bass line naming the roots. Drafts are dotted until someone edits them. Chords you typed are never replaced.</li>
  <li>The Chords tab shows the chart: chords over the words, by part. <b>Copy text</b> pastes it into the group chat. <b>Save printable</b> writes a page that opens in any browser. <b>Transpose</b> shows it moved for a capo or another key.</li>
  <li>Right-click a guitar / keys / bass track → <b>🎸 Chords &amp; tabs</b> for the capo views, chords from its takes, or the play-along highway.</li>
</ul>

<h2>Notes, Needs, Ideas</h2>
<ul>
  <li><b>Notes</b>: comments pinned to a spot on the timeline ("bar 44: guitar should get heavy here"). Right-click a take or lane → <b>Note here…</b>. Bandmates reply in a thread; <b>Resolve</b> hides it when it's sorted. Scratch notes below are free text everyone sees.</li>
  <li><b>Needs</b>: what the song is still missing ("needs bass", "needs a harmony"). Type one and press Add. @Name assigns it; that person gets a "for you" badge on their song list. After a take that covers a need, Cobander offers to tick it.</li>
  <li><b>Ideas</b>: quick sketches and voice memos kept off the timeline. <b>● Sketch</b> records one with your mic; <b>Add file…</b> takes a phone recording; <b>Text…</b> jots words. Right-click one to put it on the timeline.</li>
</ul>

<h2>Parts bin and Noodle pad</h2>
<ul>
  <li><b>Parts</b> tab, <b>This song</b>: every part of the song. Drag one onto the timeline to add another linked copy.</li>
  <li><b>Band parts bin</b>: riffs and sections anyone in the band saved. Drop one into any song and it is re-timed to that song's tempo and moved to its key automatically. Filter by name, tag, style, key or who made it.</li>
  <li><b>Save part…</b> puts the part under the playhead (or the selected take) in the bin, with its words.</li>
  <li><b>Noodle pad</b> (🎸 next to Songs): your own scratch song with a 4-bar loop. Record whatever; each take offers "Save to Parts bin".</li>
</ul>

<h2>History and Versions</h2>
<ul>
  <li><b>History</b>: every save of this song, who did it and what changed. Click a row to roll back to it. Undo works on roll-backs too.</li>
  <li><b>Versions</b>: snapshots you tagged by name (<b>Tag this version…</b>). <b>A/B</b> (or <kbd>B</kbd>) plays a tagged version against what you have now from the same spot. Bounces you shared are listed below.</li>
  <li>Opening a song tells you what happened since you were last in it: new takes (outlined "new", one click to hear them), changed words or chords, new notes.</li>
</ul>

<h2>Change the key or tempo</h2>
<ul>
  <li><b>Transpose the song</b> (key chip, or right-click a part): moves the recordings, MIDI notes, chords and the key up or down together. Drums are left alone. The originals are kept, so transposing back lands on them. Past 3–4 half steps vocals sound processed; re-record for keeps.</li>
  <li>Change the <b>bpm</b> and the takes follow like tape (pitch follows speed). Right-click the tempo for "keep takes as they are".</li>
</ul>

<h2>Share</h2>
<ul>
  <li><b>Share ▾</b> at the top of the song: <b>Bounce</b> the mix (one audio file), <b>Bounce stems</b> (one file per instrument), share a part with its chart for the group chat, copy the chord chart, hand off to a DAW (a studio program), or open the song on your phone.</li>
  <li><b>⋯</b>: show the song folder, Deleted takes, <b>Lighten the folder…</b> (converts older takes to FLAC and clears audio nothing has used for 30 days), clear parked takes, the glossary, the shortcuts.</li>
  <li><b>Save</b> (<kbd>Ctrl</kbd>+<kbd>S</kbd>) writes the song to the band folder; bandmates get it within seconds. Cobander also autosaves shortly after you stop editing. <b>Close</b> hands the song back to the band.</li>
</ul>
''')

# ---------------------------------------------------------------- record
write_page('record.html', 'Record', 'The Record workspace: inputs, monitoring, arming a track, recording a take, punching in, comping, the tuner, timing and pitch reports.', '''
<h1>Record</h1>
<p class="lede">Pick your input, hear yourself, arm a track, hit <kbd>R</kbd>. Takes are lossless FLAC and crash-safe. <kbd>Ctrl</kbd>+<kbd>2</kbd>.</p>

<h2>Before the first take: Settings</h2>
<p>Open ⚙ once and set these. They are remembered per computer.</p>
<ul>
  <li><b>Audio input</b>: the mic or audio interface Cobander records from. Plug it in first, then <b>Refresh</b>.</li>
  <li><b>Audio output</b>: your interface's headphone or line out. The click, playback and monitoring go here.</li>
  <li><b>Click output</b>: send the metronome somewhere else (a drummer's in-ears). Same as the audio output = everything together.</li>
  <li><b>MIDI input</b>: the keyboard you play synth tracks with. Leave it if you don't have one.</li>
  <li><b>Record latency offset</b>: your computer delays sound a tiny bit. Set this once so takes line up with the click; raise it if takes land late. <b>Measure</b> sets it for you: it plays 8 clicks out the output and listens for them on the input. Point the input at the output first (a cable from line out into an input, or a mic that can hear the speakers).</li>
  <li><b>Click level</b>: how loud the click is in your headphones. −12 is a good start.</li>
</ul>

<h2>Record a take</h2>
<ol>
  <li>Add a track (<b>+ track</b>) and say what you're recording. Guitar can be a mic or plugged straight in; Cobander adds an amp sound. Bass plugs straight in. Vocals get a ready-made vocal chain.</li>
  <li><b>Arm</b> the track: click the red ● on the track head. That's the track the take lands on. Nothing is armed when a song opens.</li>
  <li>Watch the <b>input meter</b> at the top. Keep it green or amber. Red means the recording crackles (clips) and that can never be fixed afterwards. Turn the gain down on your interface, not in Cobander.</li>
  <li>Turn <b>click</b> on if the song is bare, and leave <b>count-in</b> on so you get a bar of clicks before it starts.</li>
  <li>Put the playhead where you want to start (<kbd>Home</kbd> for the top) and press <kbd>R</kbd>. Press <kbd>Space</kbd> or <kbd>Esc</kbd> to stop.</li>
</ol>
<div class="tip">While you record, the audio streams to your computer every second. If Cobander or the computer dies mid-take, opening the song offers <b>Recover the take</b>.</div>

<h2>Hear yourself (monitor)</h2>
<ul>
  <li><b>monitor</b> plays your mic or instrument through Cobander while you play, with the track's amp and effects. Use headphones or you'll get feedback.</li>
  <li>If you hear yourself twice (once live, once late), turn it off. Your interface already lets you hear yourself.</li>
  <li>Takes are always recorded dry, so you can change the amp and effects later. Right-click the monitor chip to hear the dry signal instead.</li>
</ul>

<h2>Tune up</h2>
<ul>
  <li><b>tuner</b> (or <kbd>T</kbd>): play one string and Cobander shows the note and whether it's flat or sharp, like a clip-on tuner. It listens to the input picked in Settings.</li>
  <li>Guitar and bass strings are listed. A4 is 440 Hz unless the band tunes differently. <b>Done</b> closes the mic.</li>
  <li>Tune before every take. Out-of-tune takes are the one thing a mix can't fix.</li>
</ul>

<h2>Record one part over and over</h2>
<ul>
  <li>Set a <b>loop</b> around the part (or press <kbd>L</kbd> while you're in it) and press <kbd>R</kbd>. Each pass becomes its own take. Pick the best afterwards.</li>
  <li>Right-click a part → enter its <b>room</b>: <b>● Record here</b> loop-records just that part. <b>Leave room</b> goes back to the whole song.</li>
  <li>Loop recording warns at 20 passes and stops at 50.</li>
</ul>

<h2>Fix one bad bit (punch in)</h2>
<ol>
  <li>Set the loop around the bad bars (<b>take</b> next to the loop sets it to the selected take).</li>
  <li>Tick <b>punch</b>, then press <kbd>R</kbd>.</li>
  <li>Playback starts a bar early so you can come in. Only what you play inside the loop is kept. The old take stays everywhere else, and the other takes go quiet inside the range.</li>
</ol>

<h2>The Takes tab</h2>
<p>Below the tracks, the <b>Takes</b> tab lists every recording on the selected track: who, when, how long. Right-click one (or the take on the timeline) for:</p>
<ul>
  <li><b>Keep this take</b>: mutes the ones overlapping it. <b>Listen to this take</b> plays only it.</li>
  <li><b>Comp</b>: use this take for the loop, or for a part. It's the only one heard there; everything else plays as before. Stitch the best bits of several takes this way.</li>
  <li><b>★ Star this take</b>: the take with the most stars plays. Bandmates vote.</li>
  <li><b>⏱ Timing report</b>: how early or late each bar is, the worst bars, and a one-click <b>Nudge</b> when it's a fixed offset or <b>Tighten</b> when it isn't.</li>
  <li><b>Tighten to the grid…</b>: pulls each hit part of the way onto the beat. Pick the grid (1/4 … 1/16, triplets) and a strength; 100% is robotic. The original stays in the folder; <b>Undo tighten</b> any time. MIDI takes quantize the same way.</li>
  <li><b>🎯 Pitch check</b> (vocal takes): flat notes marked blue, sharp red, wrong notes amber, with a per-part report. It only shows; nothing is auto-tuned.</li>
  <li><b>🎤 Lyrics from this take</b>: speech-to-text writes the words out, pinned where they're sung.</li>
  <li><b>🎸 Chords from this track</b>: drafts the chords from a guitar, keys or bass take.</li>
  <li><b>Normalize</b>: sets the take's level so its loudest moment is just under full.</li>
  <li><b>Deleted takes</b> (button in the tab, or ⋯ at the top): bring back a take that was deleted or lost when two people saved at once.</li>
</ul>

<h2>Drums, keys and MIDI without a mic</h2>
<ul>
  <li><b>Drum machine</b> track: pick a built-in beat, then edit it hit by hit in the drum editor (🥁).</li>
  <li><b>Drums (mics)</b>: record your real kit or e-kit through the audio interface.</li>
  <li><b>Synth / keys</b>: play a MIDI keyboard or the on-screen keys. Wrong notes can be fixed afterwards in the note editor. The <b>midi</b> light at the top blinks when the keyboard is talking to Cobander; if it stays dark, pick the keyboard under MIDI input in Settings.</li>
  <li><b>Guitar (MIDI)</b> and <b>Bass (MIDI)</b>: draw the notes instead of playing them. Sounds: clean, crunch, distorted, palm-mute, acoustic, picked bass.</li>
</ul>

<h2>Your own setups</h2>
<ul>
  <li>Right-click a track → <b>Save as my track setup…</b> keeps its amp, FX and level. Your setups sit at the top of + track on your computer.</li>
  <li>A track head in Record shows the arm button first and the last take (who, when).</li>
</ul>

<h2>Space on the drive</h2>
<ul>
  <li>Takes are stored as FLAC: the exact same audio, about half the size of WAV.</li>
  <li>Deleted takes stay listed on their track until the track is locked again, then they're gone for good unless the song or a tagged version still uses them.</li>
  <li><b>⋯ → Lighten the folder…</b> converts any older WAV takes and clears audio nothing has used for 30 days. Versions, the last 500 saves, deleted songs, the Parts bin and bounces are kept.</li>
</ul>
''')

# ---------------------------------------------------------------- mix
write_page('mix.html', 'Mix', 'The Mix workspace: channel strips, faders, pan, sends, Track FX, quick fixes, Auto mix, Auto master, A/B, bounce, stems and the DAW hand-off.', '''
<h1>Mix</h1>
<p class="lede">How loud each track is, where it sits left or right, and how it sounds. The mix is what you hear; the takes don't change. <kbd>Ctrl</kbd>+<kbd>3</kbd>.</p>

<h2>The layout</h2>
<ul>
  <li>The timeline stays. Each track head becomes a mini channel strip: volume, pan, <b>LC</b> / <b>EQ</b> / <b>CMP</b> on-off buttons, <b>M</b> (mute) and <b>S</b> (solo), and <b>fix</b>.</li>
  <li>The console below has a bigger strip for every track: a fader, pan, reverb send, a meter, and one-click FX (<b>LC</b> low-cut, <b>EQ</b>, <b>CMP</b> compressor, <b>AMP</b>, <b>DLY</b> delay).</li>
  <li>The master strip on the right is the last volume control for the whole song, with a loudness readout.</li>
  <li><b>Track FX</b> on the right shows every knob for the selected track. Hover any knob for what it does.</li>
</ul>

<h2>Let Cobander do the first pass</h2>
<ul>
  <li><b>Auto mix</b> listens to each track and sets levels by role (drums, bass, guitars, keys, lead and backing vocals), a low-cut, tone, compression, guitars and harmonies panned apart, reverb on vocals. A rough mix to start from. Amp tones are never touched.</li>
  <li><b>Auto master</b> makes the whole song as loud as a streaming release (−14 LUFS) without distorting; a limiter catches the peaks.</li>
  <li><b>A/B</b> (or <kbd>B</kbd>) flips between before and after. <b>Undo</b> takes it all back.</li>
</ul>

<h2>Fix one track in plain words</h2>
<p>Click <b>fix</b> on any strip. The moves are named for what they do, and each is undoable:</p>
<ul>
  <li>Vocals: <b>Sit the vocal in the mix</b>, <b>Tame the harshness</b>.</li>
  <li>Bass: <b>Tight and even</b>. Guitar: <b>Less mud</b>, <b>Make room for the vocal</b>. Drums: <b>More punch</b>. Keys: <b>Make room for the vocal</b>.</li>
  <li>Anything: <b>Brighter</b>, <b>Darker</b>, <b>Warmer</b>, <b>Thinner</b>, <b>Even it out (compress)</b>, <b>Add space (reverb)</b>, <b>Dry it up</b>.</li>
  <li><b>Copy the sound from…</b> another track. <b>Start over</b> (flat). <b>Fader 0 dB · pan centre</b>. <b>Open Track FX</b> for all the knobs.</li>
</ul>

<h2>Do it by hand</h2>
<ul>
  <li><b>Fader</b>: volume in dB. 0 is as recorded; −6 is about half as loud.</li>
  <li><b>Pan</b>: left / right position in the speakers.</li>
  <li><b>Low-cut</b> (LC): takes out the rumble below an instrument's lowest note. Cleans up vocals and guitars.</li>
  <li><b>EQ</b>: turn frequencies up or down. Low = bass and boom, mid = body and honk, high = sparkle and hiss.</li>
  <li><b>Compressor</b> (CMP): evens out loud and quiet moments so a vocal sits steady. Threshold = where it starts working; ratio = how hard.</li>
  <li><b>Reverb send</b>: how much of the track goes into the shared room sound. The master reverb's decay, pre-delay and damp shape the room for everyone.</li>
  <li><b>Delay</b>: echo. Synced delay repeats in time with the song.</li>
  <li><b>Amp</b>: the amp sim for guitar and bass tracks (clean, crunch, lead, high gain, fuzz, bass models and cabinets).</li>
  <li><b>Low-pass</b>: cuts above a frequency. Takes the pick click off a bass DI, tames fizz.</li>
  <li><b>Gate</b>: silences a track below a level, so hum and spill between notes go away.</li>
</ul>

<h2>Take-level handles</h2>
<ul>
  <li>Drag the top corners of a take for fade in / fade out. Drag the line up or down for the take's own level.</li>
  <li>Right-click a take → <b>Normalize</b> sets its level from its loudest moment.</li>
</ul>

<h2>Fix a sloppy take</h2>
<ul>
  <li>Right-click the take → <b>⏱ Timing report</b> shows how early or late each bar is. If the whole take is just late (a latency offset), <b>Nudge</b> fixes it in one click.</li>
  <li><b>Tighten to the grid…</b> pulls each hit part of the way onto the beat. Try 50–70% before 100%. Preview first. The attacks stay untouched and the original stays in the folder.</li>
  <li><b>🎯 Pitch check</b> on a vocal take marks flat (blue), sharp (red) and wrong (amber) notes so you know what to re-sing. Nothing is auto-tuned.</li>
</ul>

<h2>Mute and solo</h2>
<ul>
  <li><b>M</b> silences a track. <b>S</b> plays only that track (and anything else soloed).</li>
  <li>Mute or solo on a track someone else has unlocked is just for your ears; it doesn't change their mix.</li>
</ul>

<h2>Get the song out</h2>
<ul>
  <li><b>Share ▾ → Bounce the mix</b>: the whole song as one WAV file in the song's <code>bounces/</code> folder. It also shows up under Versions → Bounces.</li>
  <li><b>Share ▾ → Bounce stems</b>: one file per instrument, for a studio or a friend with a mixing program.</li>
  <li><b>Share ▾ → Hand off to a DAW…</b>: writes a folder with a project file for a studio program, a MIDI file with the parts as regions and chords as markers, stems, the raw takes and <code>chart.txt</code>. For when a song outgrows Cobander.</li>
  <li><b>Share ▾ → Share a part — mix + chart</b>: bounces one part (with a bar of ring-out) plus its chart, and copies a message for the group chat.</li>
</ul>

<h2>Compare mixes</h2>
<ul>
  <li><b>Versions → Tag this version…</b> before you start. Then <b>A/B</b> plays the tagged version against what you have now, from the same spot.</li>
  <li>Every save is in <b>History</b>. Right-click a row → listen to the song before it, or roll back.</li>
</ul>
''')

# ---------------------------------------------------------------- practice
write_page('practice.html', 'Practice', 'The Practice workspace: karaoke-style lyrics and chords, loops, slow-down, taking tracks out, the note highway, the setlist, Show mode, the foot pedal and the phone page.', '''
<h1>Practice</h1>
<p class="lede">Full screen. The words and chords come at you as the song plays. Loop the part you keep blowing, slow it down, take your own part out, or put the whole setlist on. <kbd>Ctrl</kbd>+<kbd>4</kbd> or <kbd>K</kbd>.</p>

<h2>Play the song</h2>
<ul>
  <li><kbd>Space</kbd> plays and pauses (with a count-in first if it's on). <kbd>←</kbd> <kbd>→</kbd> go back or forward a bar. <kbd>Page Up</kbd> / <kbd>Page Down</kbd> jump to the previous or next part.</li>
  <li>The bar at the bottom shows where you are. The coloured blocks are the parts; click or drag to jump.</li>
  <li><kbd>1</kbd>–<kbd>9</kbd> jump to a part. <kbd>Shift</kbd>+number loops it.</li>
  <li><b>Volume</b> is just your speakers. The mix itself doesn't change. It's remembered between sessions.</li>
  <li><kbd>Esc</kbd> or ✕ goes back to the song. Nothing you played here is lost; any takes you recorded are on their track.</li>
</ul>

<h2>What's on screen</h2>
<ul>
  <li><b>3D — words fly at you</b>: every word flies in on its own and lands on the line exactly when it's sung, then drops away.</li>
  <li><b>Classic karaoke</b>: words with chords over them. The word being sung lights up; a countdown shows the next line coming.</li>
  <li><b>chords only</b>: the part as big bars, the one you're in lit. <b>words only</b>: just the lyrics.</li>
  <li><b>A±</b> (or <kbd>↑</kbd> <kbd>↓</kbd>) makes the text bigger or smaller.</li>
  <li>"No timed lyrics yet"? Go to Write → Lyrics → <b>From the vocals</b>, or add lines and pin them with <kbd>P</kbd>.</li>
</ul>

<h2>Loop a part</h2>
<ul>
  <li>Pick the part from the <b>loop</b> list, or press <kbd>L</kbd> to loop whichever part you're in. <kbd>L</kbd> again stops looping.</li>
  <li>Drill it until it's solid instead of restarting the whole song.</li>
</ul>

<h2>Slow it down</h2>
<ul>
  <li><b>Speed</b>: 95% down to 50%, same pitch. It works on the whole song or just the part you're looping. <kbd>-</kbd> / <kbd>+</kbd> step it.</li>
</ul>

<h2>Take yourself out</h2>
<ul>
  <li><b>mix</b> (or <kbd>M</kbd>): take any tracks out and play along with the rest, or hear just one. It remembers by track name, so it carries through the setlist.</li>
  <li><b>vocals: guide / off</b> (or <kbd>V</kbd>): hear the vocal as a guide, or mute it and sing it yourself.</li>
  <li><b>click</b> (<kbd>C</kbd>) and its own volume slider; <b>count-in</b> for a bar of clicks before it starts.</li>
</ul>

<h2>Play along (the note highway)</h2>
<ul>
  <li><b>play along</b> shows a scrolling lane of what to play next, like a rhythm game:
    <ul>
      <li><b>🎸 guitar chords</b>: chord shapes, capo-aware.</li>
      <li><b>🎸 bass line (tab)</b>: read off the bass takes.</li>
      <li><b>🎹 MIDI part (tab)</b>: a MIDI track's notes.</li>
    </ul>
  </li>
  <li><b>Capo / transpose</b> shows the chords moved up or down for a capo or a different tuning. The sound doesn't change.</li>
</ul>

<h2>Record while you practise</h2>
<ul>
  <li><b>● rec</b> (or <kbd>R</kbd>) records onto the armed track, the one you picked in Write or Record. Arm one first.</li>
</ul>

<h2>Rehearse the setlist</h2>
<ul>
  <li><b>▶▶ setlist</b> plays every song back to back in the Band page's order, with a set clock.</li>
  <li><b>⏮ song</b> / <b>song ⏭</b> (or <kbd>Shift</kbd>+<kbd>↑</kbd> <kbd>↓</kbd>) move between songs. Pick a <b>gap</b> between songs: time to swap guitars.</li>
  <li>Minutes in Practice count: 1 XP a minute, up to 60 a day. The Band page shows practice this week and who's rehearsing right now.</li>
</ul>

<h2>Show mode (on stage)</h2>
<ul>
  <li><b>Show</b> locks the setlist in order (the boss battle's songs, when you start from one), with big words and chords and nothing to edit by accident.</li>
  <li>Pick what the band hears from Cobander: <b>click only</b>, or <b>click + backing tracks</b>. ⚙ → Click output sends the click to its own output (in-ears).</li>
  <li><b>🦶 pedal…</b> teaches Cobander your foot pedal: next song, previous song, start / stop. Keyboard pedals and MIDI pedals both work. The arrow keys work too.</li>
</ul>

<h2>Your phone on the music stand</h2>
<ul>
  <li>Click <b>📱</b> (or Share ▾ → <b>Open on your phone…</b>). Scan the QR code with your phone on the same Wi-Fi.</li>
  <li>The phone follows the song live: words, chords (or chords-only bars), the part you're in, the capo display, with play / pause and part skips.</li>
  <li>Windows asks once to allow Cobander on private networks. Say yes.</li>
</ul>
''')

# ---------------------------------------------------------------- band
write_page('band.html', 'Band', 'The Band workspace: levels and XP, achievements, your character, the boss battle, this song as a quest, Loose ends, the setlist, Chart every song, who is rehearsing, and the Band feed.', '''
<h1>Band</h1>
<p class="lede">The band's quest board. Levels and achievements for the band and each player, this song's goals, the setlist, the next show, the to-do list that isn't a song, and who's rehearsing right now. <kbd>Ctrl</kbd>+<kbd>5</kbd>.</p>

<h2>How the score works</h2>
<ul>
  <li>Everything is counted from the songs themselves. Nothing to fill in.</li>
  <li>Every take you record (25 XP), MIDI or drum part (15), note (5), reply (3), chord (2), lyric line (3), part laid out (5), need closed (5), idea (5), version tag (10), part saved to the bin (10) and save (1) counts for whoever did it, in every song in the folder.</li>
  <li>Practice minutes count too: 1 XP a minute, up to 60 a day.</li>
  <li>Your level chip at the top of the window shows your level and a "+25 XP" pop when you do something that counts. Click it to open the Band page.</li>
  <li>100 levels, a new name every ten: Roadie → Open Mic → Garage Hero → Basement Star → Local Legend → Headliner → Touring Act → Rock Star → Hall of Famer → Never a Doubt. This ladder takes a band a year or two of weekly work.</li>
  <li><b>LEVEL UP</b> is a full-screen show: confetti, a fanfare and a crowd. Click anywhere to dismiss. It stays quiet while a take is recording. Turn it off under ⚙ → Level-up fanfare.</li>
</ul>

<h2>Achievements</h2>
<ul>
  <li>Click a bandmate for the breakdown: level, XP and achievements. First Take, Scribe, Chord Nerd, Architect, Night Owl, Early Bird, On a Roll, Multi-Instrumentalist, Triple Threat, Parts Written, Everywhere, Noodler, Tied Up, Woodshed (5 hours of practice), Run It Down (a whole setlist) and more.</li>
  <li>Only people who actually played (takes, parts, words, notes) show up as bandmates.</li>
</ul>

<h2>Choose your character</h2>
<ul>
  <li>Click your character on the Band page to build one: body, skin, hair and colour, beard, face, top, jacket, legs, shoes, hat, and what you play (Shredder, Low End, Thumper, Howler, Singer, Keys Wizard, Horn, Noodle, Dumpling, Picker, The Booth, Volt).</li>
  <li>Until you pick, your role picks for you. The pose changes with every new level name.</li>
</ul>

<h2>The band's level and the boss battle</h2>
<ul>
  <li>The top of the page shows the band's level and XP (Dry Noodles → Water's Boiling → Al Dente → Saucy → Chef's Kiss → Never a Doubt).</li>
  <li><b>Boss battle</b>: the next thing the band is working towards. A practice, a show, a recording day. Click it to name it and give it a date. It counts down, and shows how many target songs are show-ready.</li>
  <li>Right-click a song in the setlist → <b>boss target</b> to make it one of the songs for that show. The line under the setlist is what comes after; click to edit.</li>
</ul>

<h2>This song as a quest</h2>
<ul>
  <li><b>Goals</b>: Final Title, Final Structure, Show Ready. Tick them as they happen.</li>
  <li><b>Milestones</b> fill in by themselves: structure laid out, chords, lyrics, everyone's taken a pass, bounced, demo, done.</li>
  <li><b>Parts written</b>: each member's share of the song's parts their takes cover, counted live. A linked copy counts: your verse plays in every verse. Right-click a bandmate's row → <b>set by hand</b> for people who record elsewhere.</li>
  <li><b>Tasks</b> for this song. @Name assigns one. Open <b>Needs</b> show here too.</li>
</ul>

<h2>Loose ends</h2>
<ul>
  <li>The band's to-do list for things that aren't a song: book the gig, fix the PA, buy PBR.</li>
  <li>@Name assigns one. Checking one off earns XP and shows in the feed.</li>
</ul>

<h2>Setlist</h2>
<ul>
  <li>Every song with its XP bar, in the order you'll play them. Drag to reorder. Practice's <b>▶▶ setlist</b> and <b>Show</b> use this order.</li>
  <li>Type a cover that isn't in Cobander and press <b>+</b> so it counts on the setlist and in the quest.</li>
  <li>Right-click a song: boss target, hide, and more.</li>
  <li><b>🎼 Chart every song</b>: opens each song in turn, listens to its guitar / keys / bass takes and drafts the chords it doesn't have yet. Chords anyone typed are never touched. Songs someone else has open are skipped.</li>
</ul>

<h2>The right-hand column</h2>
<ul>
  <li><b>Rehearsing now</b>: who's in Practice at this moment, and on what.</li>
  <li><b>Practice this week</b>: minutes per person.</li>
  <li><b>Band feed</b>: everything the band did, across every song, live. Who's in which song right now, takes, edits, new parts, the XP each thing earned, goals and tasks people tick. Click an entry to open that song.</li>
  <li>At the bottom: the free / Send noods status, the <b>Send noods</b> link, and <b>extra sauce</b> (a tip, any size). See <a href="keys.html">Free &amp; Send noods</a>.</li>
</ul>

<h2>Song stages</h2>
<ul>
  <li>Each song has a stage: idea, writing, demo, done. The filter above the Songs list shows only one stage.</li>
  <li>Right-click a song in the Songs list to set its stage, delete it (it moves to <code>_deleted</code> in the band folder; <b>Deleted songs…</b> brings it back), and more.</li>
</ul>
''')

# ---------------------------------------------------------------- together
write_page('together.html', 'Together', 'How a band works in one shared folder: song locks, track locks, presence, read-only mode, @mentions, the Band feed, the phone page, and the local API and inbox for the curious.', '''
<h1>Together</h1>
<p class="lede">There is no Cobander server. The band's shared folder is the server. Whatever one of you does, the rest get in seconds.</p>

<h2>The shared folder</h2>
<ul>
  <li>Every bandmate points Cobander at the same folder inside Google Drive, OneDrive, iCloud Drive or Dropbox. The cloud app on each computer does the syncing.</li>
  <li>Each song is a folder of its own: the song file, an <code>audio</code> folder with one file per take, <code>bounces</code>, <code>versions</code> and <code>history</code>. The band's Parts bin, templates and the Send noods key sit beside the songs.</li>
  <li>Mac and Windows mix fine. One person on a Mac and three on Windows is just files in a folder.</li>
  <li>Back up the folder the way you'd back up anything else. The cloud service already keeps copies; that's your call.</li>
  <li>⚙ names which cloud it found. If it says the folder doesn't look synced, Cobander still works, but the band only sees each other's noodles if every bandmate uses the same synced folder.</li>
</ul>

<h2>Who can edit: song locks</h2>
<ul>
  <li>When you open a song to edit, you hold its <b>lock</b>. The badge at the top of the song says so. Bandmates who open it see <b>read-only</b> and the name of who has it.</li>
  <li>Read-only bandmates can still talk: notes, replies, needs, reactions, stars and lyric edits go through the song's mailbox, and the editor's Cobander merges them in within seconds.</li>
  <li>Try to edit a read-only song and the holder sees you as <b>⏳ waiting to edit</b>. When the song frees up you get a nudge with a <b>Take over / edit</b> button.</li>
  <li><b>Close</b> hands the song back. The lock also clears itself if a computer crashes or goes to sleep; a bandmate can <b>Take over</b> after it goes quiet for a minute or so.</li>
  <li>Your unsaved changes are never thrown away by someone taking over. You keep them until you take the song back or close.</li>
</ul>

<h2>Two people on one song: track locks</h2>
<ul>
  <li>Every track has a 🔒. Click it to <b>unlock</b> the track for you. Nobody else can touch a track you've unlocked, and you can't touch theirs ("🔒 Dan" on the track).</li>
  <li>While someone else has the song open, you can still unlock free tracks and record or edit on them. Your takes reach them in a few seconds and they save them into the song.</li>
  <li>Click 🔓 again (or <b>Lock all</b> / <b>🔓 Unlock all</b> at the top) to free it. A track nobody has touched for 10 minutes locks itself.</li>
  <li>Tempo, time signature, structure, master and track order stay with whoever holds the song. Whole-song changes (tempo, transpose, restructure) wait until nobody else has a track unlocked.</li>
  <li>Undo never rolls back a track someone else has unlocked.</li>
</ul>

<h2>Presence: who's here</h2>
<ul>
  <li>The Songs list and the song header show who has each song open and what they're doing: looking, 🎧 listening, ● rec, 🎙 rehearsing, ⏳ waiting to edit.</li>
  <li>The Band page's <b>Rehearsing now</b> lists everyone in Practice at this moment.</li>
</ul>

<h2>@mentions and the feed</h2>
<ul>
  <li>Type <b>@Name</b> in a note, a reply, a need, a task or a Loose end to ping a bandmate. Needs and tasks assigned to you get a <b>for you</b> badge on the Songs list and at the top of the Notes tab.</li>
  <li>The <b>Band feed</b> at the bottom of the Songs list shows everything the band did, across every song, live. Click its header to fold it; folded, it counts what's new. Click an entry to open that song.</li>
  <li>Opening a song shows <b>what changed</b> since you were last in it: who did what, new takes outlined "new", which parts' words or chords changed, new notes.</li>
</ul>

<h2>When two people save at once</h2>
<ul>
  <li>Cobander merges field by field: your notes and theirs, your takes and theirs. When you both edit the same note, need or lyric, the banner says so (yours is kept).</li>
  <li>If the cloud delivers an older version than you have (a sync hiccup), a banner offers <b>Keep mine (merge theirs in)</b> or <b>Load the older one</b>. Keep yours unless you know better.</li>
  <li>A take lost to a save conflict is never gone: <b>⋯ → Deleted takes</b> restores it.</li>
</ul>

<h2>Your phone</h2>
<ul>
  <li>Share ▾ → <b>Open on your phone…</b> (or 📱 in Practice) shows a QR code. On the same Wi-Fi your phone follows the song live: words, chords, the part you're in, the capo display, with play / pause and part skips.</li>
  <li>Only a phone with the link's key can see it, and only on your home network.</li>
</ul>

<h2>Updates through the folder</h2>
<ul>
  <li>Installers can live in the band folder, so one bandmate downloading an update means everyone gets it. Cobander also checks GitHub when there's no band folder.</li>
  <li>Cobander refuses an update whose checksum doesn't match. See <a href="index.html">Start here</a> for the Update bar.</li>
</ul>

<h2>For the curious: the assistant API and inbox</h2>
<ul>
  <li>Under ⚙ → <b>Assistant / control API</b>: a local-only HTTP API lets an AI assistant or a script read meters, change the mix, bounce, add notes and more while Cobander is open. It only answers on your own computer, with a token kept in Cobander's settings.</li>
  <li>The same commands can be dropped as files into an <b>inbox</b> folder; no network needed.</li>
  <li>The song format is plain JSON and audio files. The full guide, <code>AI.md</code>, is copied into the band folder.</li>
  <li>An assistant that only saved a mix doesn't show up as a bandmate on the Band page.</li>
</ul>
''')

# ---------------------------------------------------------------- keys
write_page('keys.html', 'Free & Send noods', 'What free Cobander includes, what a Send noods key does, how to enter it, what to do if you lose it, and the Roadie wall.', '''
<h1>Free &amp; Send noods</h1>
<p class="lede">Free Cobander is the whole app. Sending noods buys a key that lifts the one-song limit for everyone in the band. Pay what the band can spare, once.</p>

<h2>What's free</h2>
<ul>
  <li>Everything: Write, Record, Mix, Practice, the Band page, sync, updates. Windows and Mac.</li>
  <li>The only limit is <b>one song per band folder</b>. Folders that already hold more songs keep them all.</li>
  <li>The Noodle pad is your own scratch song and doesn't count.</li>
</ul>

<h2>What a key does</h2>
<ul>
  <li>A <b>Send noods</b> key lifts the limit for the whole band. One key, not one per person or per computer.</li>
  <li>It lives in the shared folder. Whoever pastes it unlocks everyone.</li>
  <li>It checks itself on your computer, never phones home, and never expires. It keeps working if Cobander stops being developed.</li>
  <li>It can be revoked if it's posted publicly or resold. Sharing it with your own band is the point.</li>
</ul>

<h2>What it costs</h2>
<ul>
  <li><b>$25</b> suggested. <b>$12</b> minimum. Pay what you like above that.</li>
  <li><b>$60 and up</b>: <b>Roadie</b>. The same key, plus your band's name on the Roadies wall, on cobander.com and inside the app under ⚙.</li>
  <li>Get it from the <b>Send noods</b> button under ⚙, on the Band page, or on <a href="../#menu">cobander.com</a>. The key arrives by email, usually within a minute.</li>
</ul>

<h2>Enter the key</h2>
<ol>
  <li>Copy the whole key from the email. It looks like <code>cob1.xxxx.xxxx</code>. Extra spaces and line breaks from the email are fine.</li>
  <li>In Cobander, click ⚙ → <b>Enter a key</b>, paste it, and click <b>Unlock the band</b>.</li>
  <li>Or wait for the second song: when you make it, Cobander asks. Paste the key right there.</li>
</ol>
<ul>
  <li>⚙ and the Band page then show the band's name and tier instead of "Free Cobander: one song per band folder".</li>
  <li>Bandmates don't need to do anything. The key is in the folder they already share.</li>
</ul>

<h2>Lost the key</h2>
<ul>
  <li>Reply to the email it came in, or write to <a href="mailto:noods@cobander.com">noods@cobander.com</a>. It gets re-sent.</li>
  <li>Moved the band to a new folder? Paste the key again in the new one.</li>
</ul>

<h2>Refunds</h2>
<ul>
  <li>If the key doesn't work and it can't be fixed within a few days of you saying so, you get your money back in full.</li>
  <li>Change-of-mind refunds within 14 days are fine as long as the key hasn't been used. Just ask.</li>
  <li>The small print is at <a href="../terms.html">cobander.com/terms</a>.</li>
</ul>

<h2>Extra sauce</h2>
<ul>
  <li>Already have it and want to say thanks? <b>Extra sauce</b> is a tip, any size, on Venmo (@jdeuel44) or Ko-fi. The links are under ⚙ and on the Band page.</li>
</ul>

<h2>The Roadie wall</h2>
<ul>
  <li>Bands who sent noods at the Roadie level are listed under ⚙ → Roadies and on cobander.com.</li>
  <li>Your name goes up once you've confirmed how you'd like it to read. Names that are offensive or aren't yours can be declined.</li>
</ul>

<h2>Privacy, in short</h2>
<ul>
  <li>The app sends nothing anywhere. No accounts, no telemetry, no crash reports.</li>
  <li>It makes two read-only network requests: checking for updates, and fetching the Roadies list.</li>
  <li>Speech-to-text, chord detection, key detection and pitch check all run on your computer.</li>
  <li>The source is open (MIT). The key check is one function anyone can read. It's a tip jar with a nudge, not copy protection.</li>
</ul>
''')

# ---------------------------------------------------------------- shortcuts
write_page('shortcuts.html', 'Keyboard shortcuts', 'Every Cobander keyboard shortcut: transport, takes, song, Practice, note and drum editors.', '''
<h1>Keyboard shortcuts</h1>
<p class="lede">Press <kbd>?</kbd> inside Cobander for this sheet. On a Mac, <kbd>Ctrl</kbd> means <kbd>Cmd</kbd>.</p>

<h2>Screens</h2>
<table>
<tr><td><kbd>Ctrl</kbd>+<kbd>1</kbd> … <kbd>5</kbd></td><td>Write · Record · Mix · Practice · Band</td></tr>
<tr><td><kbd>K</kbd></td><td>Practice</td></tr>
<tr><td><kbd>F1</kbd></td><td>help mode on / off; press twice for the glossary</td></tr>
<tr><td><kbd>?</kbd></td><td>this sheet</td></tr>
</table>

<h2>Transport</h2>
<table>
<tr><td><kbd>Space</kbd></td><td>play / pause (stops recording)</td></tr>
<tr><td><kbd>R</kbd></td><td>record onto the armed track</td></tr>
<tr><td><kbd>Esc</kbd></td><td>stop, and jump back to where you started playing</td></tr>
<tr><td><kbd>Home</kbd> / <kbd>End</kbd></td><td>start / end of the song (Home goes to the loop start when looping)</td></tr>
<tr><td><kbd>,</kbd> <kbd>.</kbd></td><td>back / forward a bar (<kbd>Shift</kbd>: 4 bars)</td></tr>
<tr><td><kbd>1</kbd> – <kbd>9</kbd></td><td>jump to that part of the song</td></tr>
<tr><td><kbd>Shift</kbd>+<kbd>1</kbd> – <kbd>9</kbd></td><td>loop that part</td></tr>
<tr><td><kbd>L</kbd></td><td>loop on / off (loops the part you're in)</td></tr>
<tr><td><kbd>[</kbd> <kbd>]</kbd></td><td>loop start / end at the playhead</td></tr>
<tr><td><kbd>B</kbd></td><td>A/B against a tagged version (in Mix: before / after Auto mix)</td></tr>
<tr><td><kbd>T</kbd></td><td>tuner</td></tr>
</table>

<h2>Takes</h2>
<table>
<tr><td>click</td><td>select a take (a second click on the selected track moves the playhead there)</td></tr>
<tr><td><kbd>S</kbd></td><td>split the selected take at the playhead</td></tr>
<tr><td><kbd>M</kbd></td><td>mute / un-mute it</td></tr>
<tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>nudge a beat (<kbd>Shift</kbd>: a bar)</td></tr>
<tr><td><kbd>Del</kbd></td><td>delete it</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd></td><td>copy / cut / paste at the playhead</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>duplicate right after</td></tr>
<tr><td><kbd>Shift</kbd>-drag</td><td>drop a copy on another track</td></tr>
<tr><td><kbd>Alt</kbd>-drag</td><td>ignore snap for this drag</td></tr>
<tr><td>right-click</td><td>keep, comp, star, tighten, pitch check, lyrics from this take…</td></tr>
</table>

<h2>Song</h2>
<table>
<tr><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td><td>save</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></td><td>undo / redo</td></tr>
<tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>select the track above / below</td></tr>
<tr><td><kbd>P</kbd></td><td>pin the next lyric line at the playhead</td></tr>
<tr><td><kbd>Ctrl</kbd>+wheel</td><td>zoom the timeline (snap follows the zoom)</td></tr>
<tr><td><kbd>Alt</kbd>+wheel over the tracks</td><td>track height</td></tr>
<tr><td><kbd>Enter</kbd> in a note thread</td><td>send the reply (<kbd>Shift</kbd>+<kbd>Enter</kbd> = new line)</td></tr>
</table>

<h2>Practice</h2>
<table>
<tr><td><kbd>Space</kbd></td><td>play / pause (count-in first if on)</td></tr>
<tr><td><kbd>←</kbd> <kbd>→</kbd> or <kbd>,</kbd> <kbd>.</kbd></td><td>back / forward a bar</td></tr>
<tr><td><kbd>Page Up</kbd> / <kbd>Page Down</kbd></td><td>previous / next part</td></tr>
<tr><td><kbd>1</kbd> – <kbd>9</kbd></td><td>jump to a part (<kbd>Shift</kbd>: loop it)</td></tr>
<tr><td><kbd>L</kbd></td><td>loop the part you're in</td></tr>
<tr><td><kbd>M</kbd></td><td>mix: take tracks out / solo one</td></tr>
<tr><td><kbd>V</kbd></td><td>vocals on / off</td></tr>
<tr><td><kbd>-</kbd> / <kbd>+</kbd></td><td>slower / faster (same pitch)</td></tr>
<tr><td><kbd>C</kbd></td><td>click on / off</td></tr>
<tr><td><kbd>R</kbd></td><td>record</td></tr>
<tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>text size</td></tr>
<tr><td><kbd>Shift</kbd>+<kbd>↑</kbd> <kbd>↓</kbd></td><td>previous / next song (setlist)</td></tr>
<tr><td><kbd>Esc</kbd></td><td>close</td></tr>
</table>

<h2>Note editor and Melody window</h2>
<table>
<tr><td>click-drag on empty space</td><td>draw a note (snaps to the grid)</td></tr>
<tr><td>drag a note / its right end</td><td>move it / stretch it</td></tr>
<tr><td>double-click</td><td>add or delete a note</td></tr>
<tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>move the selected note (<kbd>Shift</kbd>: an octave)</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>duplicate the note right after itself (keep pressing to stamp copies)</td></tr>
<tr><td><kbd>Shift</kbd>-drag a note</td><td>drag a copy</td></tr>
<tr><td><kbd>Alt</kbd></td><td>no snap</td></tr>
<tr><td>right-click a note</td><td>power chord, add 3rd / 5th, any chord</td></tr>
<tr><td><kbd>Ctrl</kbd>+wheel</td><td>zoom time; the grid follows</td></tr>
<tr><td><kbd>Space</kbd></td><td>play / stop the loop</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>undo the last note edit</td></tr>
</table>

<h2>Drum editor</h2>
<table>
<tr><td>click a square</td><td>add a hit · click again = accent · again = remove</td></tr>
<tr><td>drag across</td><td>paint hits</td></tr>
<tr><td><kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>undo the last edit</td></tr>
</table>
''')

# ---------------------------------------------------------------- faq
write_page('faq.html', 'Troubleshooting', 'Fixes for the usual Cobander problems: SmartScreen and Gatekeeper, no microphone, a locked song, a folder that is not syncing, iCloud still downloading, a Send noods key that is not accepted, updates stuck.', '''
<h1>Troubleshooting</h1>
<p class="lede">The usual snags, and the fix for each. If yours isn't here, ⚙ → <b>Report a bug</b> opens the bug tracker, or write to <a href="mailto:noods@cobander.com">noods@cobander.com</a>.</p>

<h2>Windows says it "protected your PC"</h2>
<ul>
  <li>That's SmartScreen not recognising a new installer. Click <b>More info</b>, then <b>Run anyway</b>. Once.</li>
  <li>On a Mac, right-click Cobander → <b>Open</b> the first time.</li>
  <li>Updates installed from inside Cobander don't ask again.</li>
</ul>

<h2>Windows: after the first update, the old shortcut is gone</h2>
<ul>
  <li>If you came from BandPad, open <b>Cobander</b> from the Start menu once. Same app, same band folder, same settings. The BandPad shortcut goes away.</li>
</ul>

<h2>No mic, or "Could not open the mic"</h2>
<ul>
  <li>Plug the interface in first, then ⚙ → <b>Refresh</b> next to Audio input, and pick it.</li>
  <li><b>Windows</b>: Settings → Privacy → Microphone → turn on "Let desktop apps access your microphone".</li>
  <li><b>Mac</b>: System Settings → Privacy &amp; Security → Microphone → turn on Cobander, then restart it.</li>
  <li>If the mic you saved is unplugged, Cobander falls back to the default mic and says so.</li>
  <li>The tuner closes the mic when you click <b>Done</b>, so nothing stays held open.</li>
</ul>

<h2>I hear myself twice</h2>
<ul>
  <li>Turn <b>monitor</b> off. Your interface already lets you hear yourself; Cobander was adding a late second copy.</li>
</ul>

<h2>My takes land late (or early)</h2>
<ul>
  <li>⚙ → <b>Record latency offset</b>. Click <b>Measure</b> with the input pointed at the output (a cable from line out to an input, or a mic that can hear the speakers). It refuses if the input is silent.</li>
  <li>For a take already recorded, right-click it → <b>⏱ Timing report</b> → <b>Nudge</b>.</li>
</ul>

<h2>The recording crackles</h2>
<ul>
  <li>The input meter hit red. Turn the gain knob down on your interface, not in Cobander, and record again. Clipping can't be fixed afterwards.</li>
  <li>USB mic or AirPods dropping out mid-take is caught and reported. Wired is steadier.</li>
</ul>

<h2>The song is locked by someone</h2>
<ul>
  <li>Someone else has it open for editing. You're <b>read-only</b>, but you can still add notes, needs, reactions, stars and lyric lines; they merge in for the editor within seconds.</li>
  <li>Want to record? Click the 🔒 on a free track to unlock it for you. Record there; your take reaches the editor and they save it into the song.</li>
  <li>Need the whole song? Try to edit and the holder sees you as ⏳ waiting. When they close it you get a <b>Take over / edit</b> nudge.</li>
  <li>They left it open on a sleeping laptop? After it goes quiet for a minute or so the lock counts as stale and <b>Take over</b> in the banner works. Their unsaved changes stay on their computer until they come back.</li>
</ul>

<h2>"X took over this song — you are now read-only"</h2>
<ul>
  <li>A bandmate took the lock. Nothing of yours is lost: your unsaved changes stay in memory. Use <b>Take the song back &amp; save mine on top</b> in the banner, which merges your changes over theirs and keeps any takes or tracks they added.</li>
</ul>

<h2>Bandmates don't see my songs</h2>
<ul>
  <li>Everyone must point Cobander at the <b>same</b> folder, and that folder must be one the cloud app syncs on each computer. ⚙ shows which cloud it found; if it warns that the folder doesn't look synced, pick one inside Google Drive, OneDrive, iCloud Drive or Dropbox.</li>
  <li>Share the folder from the cloud app itself (Drive "Share", OneDrive "Share", iCloud "Collaborate", Dropbox "Share"). Each bandmate then has it on their own computer.</li>
  <li>Check the cloud app's icon: is it paused, signed out, or out of space?</li>
</ul>

<h2>A take is missing, or "not synced yet"</h2>
<ul>
  <li>The cloud is still downloading it. It appears when it arrives. Turn on "always keep on this device" / "available offline" for the band folder so this stops happening mid-song.</li>
  <li><b>iCloud</b> evicts files it thinks you don't need. Cobander asks iCloud for them back when it notices; a song that shows "iCloud is downloading this song" lists itself once it has landed.</li>
  <li>Still missing? <b>⋯ → Deleted takes</b> lists takes whose audio is in the folder but not on a track.</li>
</ul>

<h2>"Delivered an OLDER version" banner</h2>
<ul>
  <li>A sync hiccup handed Cobander an older save than the one you have. Click <b>Keep mine (merge theirs in)</b> unless you know better.</li>
</ul>

<h2>Cobander crashed mid-take</h2>
<ul>
  <li>Open the song. It offers <b>Recover the take</b>; the audio was streaming to your computer every second.</li>
  <li>If the window goes blank, Cobander restarts itself instead of staying stuck with the song locked.</li>
</ul>

<h2>My Send noods key isn't accepted</h2>
<ul>
  <li>Paste the <b>whole</b> key from the email. It looks like <code>cob1.xxxx.xxxx</code>: three pieces separated by dots. Spaces and line breaks are fine; a missing piece isn't.</li>
  <li>The key is for the band folder you're in. Moved the band to a new folder? Paste it again there.</li>
  <li>Still no? Reply to the email the key came in, or write to <a href="mailto:noods@cobander.com">noods@cobander.com</a>. If it can't be fixed within a few days you get a refund.</li>
</ul>

<h2>"That's the free song" when I make a second song</h2>
<ul>
  <li>Free Cobander keeps one song per band folder. Paste a Send noods key right there, or click <b>Not now</b>. See <a href="keys.html">Free &amp; Send noods</a>.</li>
  <li>Folders that already held several songs before the limit arrived keep all of them.</li>
</ul>

<h2>The Update bar says it's waiting</h2>
<ul>
  <li>The new version is still syncing into the band folder from a bandmate's computer. Give it a minute and click <b>Check again</b>. Cobander also checks GitHub by itself.</li>
  <li>An update that failed shows <b>Try again</b>. On a Mac, a failed self-update rolls back on its own.</li>
  <li>Cobander won't update while you're recording. Stop the take first.</li>
</ul>

<h2>The phone page won't open</h2>
<ul>
  <li>Phone and computer must be on the same Wi-Fi. Guest networks often block this.</li>
  <li>Windows asks once to allow Cobander on private networks. If you said no, allow it in Windows Firewall settings.</li>
</ul>

<h2>Speech-to-text (From the vocals) is slow or wrong</h2>
<ul>
  <li>It runs on your computer. The first run downloads the model (about 250 MB). ⚙ → <b>Speech-to-text model</b> picks a faster or more accurate one.</li>
  <li>Lines you type yourself win: type them in the Lyrics tab first and let From the vocals pin them.</li>
</ul>

<h2>The band folder is getting big</h2>
<ul>
  <li><b>⋯ → Lighten the folder…</b> converts older WAV takes to FLAC (same audio, half the size) and clears audio nothing has used for 30 days. <b>Clear parked takes…</b> removes audio nothing in this song uses.</li>
</ul>

<h2>I want the MIDI keyboard to work</h2>
<ul>
  <li>Pick it under ⚙ → <b>MIDI input</b>. The <b>midi</b> light at the top of Record blinks when it's talking to Cobander.</li>
</ul>
''')
