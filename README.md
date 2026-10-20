# Cobander — noodle together.

A band sketchpad. Everyone in the band records, writes, mixes and practices on their own computer, and the
song lives in one folder the band already shares (Google Drive, OneDrive, iCloud Drive or Dropbox). No server, no
accounts, no subscription. Whatever one of you noodles, the rest get in seconds.

It is not a DAW you'd mix an album in. It is the thing you open at 11 pm when a riff shows up, and the thing the
whole band opens at practice.

<p align="center"><img src="build/icon.png" width="128" alt="noodles in a colander"></p>

## What it does

- **Write** — tracks on a timeline, sections (Intro / Verse / Chorus…), a chord lane, lyrics pinned to where
  they're sung (Whisper speech-to-text runs on your computer), notes and replies on the timeline, needs, ideas, a
  parts bin, history and tagged versions.
- **Record** — arm a track, hit R. Takes are lossless FLAC. Punch in, comp the best bits, crash-safe recording,
  a tuner, part hotkeys, a drum machine and MIDI guitar / bass / keys for sketching without a mic.
- **Mix** — faders, pan, sends, per-track FX, Auto mix (levels by role, low-cut, EQ, compression) and Auto master
  to a loudness target, A/B against your last mix, tighten a sloppy take to the grid, pitch check on vocals, a
  timing report for every take, bounce a mix or stems, hand off to a real DAW with markers.
- **Practice** — big words and chords that follow the song, loop a part, slow it down without changing pitch,
  take instruments out, a note highway of what to play (chord grips with capo, the bass line, MIDI notes),
  Show mode for the setlist with a pedal, and a phone page so your phone follows along on the same Wi-Fi.
- **Band** — the quest board: levels and achievements for the band and each player, this song's goals, the
  setlist, who's rehearsing right now, practice minutes, loose ends (to-dos that aren't a song), chart every song
  with one button.
- **Together** — one shared folder; song locks and per-track locks so two people can work on the same song at
  once; presence ("Dan is recording"); @mentions; a band feed; in-app updates.

## Install

Download the latest release for your computer from the
[Releases page](../../releases/latest): the `.exe` for Windows, the `mac-arm64` zip for Apple-silicon Macs, the
`mac-x64` zip for Intel Macs. Open it, give yourself a name, and point it at a folder inside the cloud folder your
band shares. Everyone in the band does the same with the same folder. That's the setup.

Cobander checks that Releases page (or the band folder) for updates and installs them itself.

The builds aren't code-signed (that costs money). Windows SmartScreen will ask "Run anyway"; on a Mac, drag the app
into Applications, then right-click → Open the first time.

## Build it yourself

```
npm install
npm start            # run it
npm test             # unit tests
npm run e2e          # two real windows on one shared folder, under xvfb
bash scripts/build.sh all   # Windows + macOS installers into release/
```

Node 20+, Electron 44. `src/AI.md` documents the song format and the local control API (an assistant or a
script can drive a running Cobander over HTTP or a file-drop inbox).

## Buy Jeff a PBR 🍺

Cobander is free and will stay free. If it's earning its keep, the tip jar is Venmo **@jdeuel44**
(a link is in the app under ⚙ and on the Band page).

## License

MIT — see [LICENSE](LICENSE). Made by Jeff Deuel for a band in a basement.
