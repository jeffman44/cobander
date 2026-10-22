# Cobander shared-folder format — v1 (frozen 2026-10-22, from 0.17.3)

The band folder (Google Drive, Dropbox, OneDrive, iCloud) is the server. Every install reads and writes it, often
several versions at once. This file is the contract: **from 0.17.3 on, no release breaks it.**

## The layout

```
<Shared>/
  _takeout.json            the band's license key (one per band)
  _quest/                  quest board — each member writes only their own file
  _parts/                  parts bin (<id>.json + audio/)
  _templates/              band song templates (no audio)
  _deleted/                deleted songs, restorable
  <Song Name>/             one folder per song; the folder name IS the song name (human-readable, always)
    song.json              the song: format, tracks, clips, collab collections
    audio/                 takes, "<label> - <id>.<ext>" — the 12-hex id is the key, the label is for humans
    bounces/  versions/  history/
    _lock.json  _presence/  _mailbox/  _tracklocks/  _tracks/
```

`song.json` carries `format: 1`. A client refuses (with "update Cobander to open it") a song whose `format` is higher
than its own.

## The rules (what "frozen" means)

1. **Add, never change.** A new feature adds a new field, a new collection or a new file/folder. Existing fields keep
   their name, type and meaning. Nothing is renamed or repurposed.
2. **Unknown is kept, not dropped.** A client carries every field it doesn't know through a load + save untouched —
   on the song, on each track, on each track's `fx`, on each clip, and on `master` (`engine.js` `extras()`).
3. **Unknown collections merge.** Any top-level array of `{id}` entries (other than `tracks`) merges entry by entry,
   field by field, exactly like the known ones (`collab.js` `collectionKeys()`), and mailed changes to it are applied.
   Unknown song-level fields follow the same "one side changed it → that side wins" rule as tempo and key.
4. **Old values still mean the same thing.** A new field may refine behaviour, but a song without it plays and looks as
   it did.
5. **Ids are forever.** Track, clip, take and entry ids never change meaning or format (12 hex for takes / clips).
6. **Folder names stay human.** Song folder = song name; take files keep a readable label.

## When a change can't follow these rules

That is a **format 2**: bump `FORMAT_VERSION` in `store.js`, convert old songs on open (write a backup to `history/`
first), and ship it as a major app version. Format-1 clients then refuse format-2 songs with the update message
instead of mangling them.

## Gates

- `test/unit/format.test.js` — unknown fields and collections survive.
- `npm test` + `npm run e2e` stay green before any release.
