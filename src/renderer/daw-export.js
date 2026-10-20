// DAW hand-off: builds a REAPER project (.rpp), a Standard MIDI File (.mid) and a README from the
// current song. Stems and take copies are written by app.js (it owns the audio engine); this module
// only produces text/bytes. Everything is plain, documented formats so other DAWs can import it too.
(function (global) {
  'use strict';

  const q = (s) => `"${String(s).replace(/["\\]/g, '')}"`;
  const dbToGain = (db) => Math.pow(10, (db || 0) / 20);

  // REAPER project. Paths are relative to the .rpp. Each Cobander track becomes:
  //   1) "<name>" — the post-FX stem (sounds like Cobander)
  //   2) "<name> (raw takes, dry)" — muted, the untouched take files at their exact positions/trims
  function reaperProject({ song, tracks, stems, takes, clipLength, sampleRate, meter }) {
    const [num, den] = song.timeSig || [4, 4];
    const L = [];
    L.push(`<REAPER_PROJECT 0.1 "6.0" ${Math.floor(Date.now() / 1000)}`);
    L.push(`  TEMPO ${song.bpm} ${num} ${den}`);
    // parts with their own tempo / time signature: a tempo envelope (square steps) with the meter on each point
    if (meter && meter.segs && meter.segs.length > 1) {
      L.push('  <TEMPOENVEX'); L.push('    ACT 1 -1'); L.push('    VIS 1 0 1'); L.push('    LANEHEIGHT 0 0'); L.push('    ARM 0'); L.push('    DEFSHAPE 1 -1 -1');
      for (const sg of meter.segs) { const ts = sg.ts || [num, den]; L.push(`    PT ${sg.t0.toFixed(6)} ${(+sg.bpm).toFixed(6)} 1 ${ts[0] + ts[1] * 65536} 0 1`); }
      L.push('  >');
    }
    L.push(`  SAMPLERATE ${sampleRate} 0 0`);
    // the song's parts as regions (Verse 1, Chorus…), chords as markers
    { let k = 1; const secs = (song.sections || []).filter((x) => x && !x.deleted).sort((a, b) => a.start - b.start);
      for (const x of secs) { L.push(`  MARKER ${k} ${(+x.start).toFixed(6)} ${q(x.name)} 1 0 1 R`); L.push(`  MARKER ${k} ${(+x.end).toFixed(6)} "" 1`); k++; }
      for (const c of (song.chords || []).filter((x) => x && !x.deleted && typeof x.time === 'number').sort((a, b) => a.time - b.time)) { L.push(`  MARKER ${k} ${(+c.time).toFixed(6)} ${q(c.chord)} 0 0 1 B`); k++; } }
    if (song.notes) {
      L.push(`  <NOTES 0 2`);
      for (const line of String(song.notes).split('\n').slice(0, 200)) L.push(`    |${line.replace(/[\r|]/g, ' ')}`);
      L.push(`  >`);
    }
    for (const t of tracks) {
      const stem = stems.find((s) => s.trackId === t.id);
      L.push(`  <TRACK`);
      L.push(`    NAME ${q(t.name)}`);
      L.push(`    VOLPAN 1 0 -1 -1 1`);           // stems are rendered post-fader: unity here
      L.push(`    MUTESOLO ${t.mute ? 1 : 0} 0 0`);
      if (stem) {
        L.push(`    <ITEM`);
        L.push(`      POSITION 0`);
        L.push(`      LENGTH ${stem.seconds.toFixed(6)}`);
        L.push(`      SOFFS 0`);
        L.push(`      VOLPAN 1 0 1 -1`);
        L.push(`      MUTE 0 0`);
        L.push(`      NAME ${q(`${t.name} (Cobander stem)`)}`);
        L.push(`      <SOURCE WAVE`);
        L.push(`        FILE ${q(stem.path)}`);
        L.push(`      >`);
        L.push(`    >`);
      }
      L.push(`  >`);
      const audioClips = t.clips.filter((c) => c.kind !== 'midi' && takes.some((k) => k.clipId === c.id));
      if (audioClips.length) {
        L.push(`  <TRACK`);
        L.push(`    NAME ${q(`${t.name} (raw takes, dry)`)}`);
        L.push(`    VOLPAN ${dbToGain(t.gainDb).toFixed(6)} ${Number(t.pan || 0).toFixed(3)} -1 -1 1`);
        L.push(`    MUTESOLO 1 0 0`);
        for (const c of audioClips) {
          const k = takes.find((x) => x.clipId === c.id);
          L.push(`    <ITEM`);
          L.push(`      POSITION ${Number(c.start).toFixed(6)}`);
          L.push(`      LENGTH ${Math.max(0.01, clipLength(c)).toFixed(6)}`);
          L.push(`      SOFFS ${Number(c.trimStart || 0).toFixed(6)}`);
          L.push(`      VOLPAN ${dbToGain(c.gainDb).toFixed(6)} 0 1 -1`);
          L.push(`      MUTE ${c.mute ? 1 : 0} 0`);
          if (c.fadeIn > 0) L.push(`      FADEIN 1 ${Number(c.fadeIn).toFixed(3)} 0 1 0 0 0`);
          if (c.fadeOut > 0) L.push(`      FADEOUT 1 ${Number(c.fadeOut).toFixed(3)} 0 1 0 0 0`);
          L.push(`      NAME ${q(`${c.name}${c.takenBy ? ` (${c.takenBy})` : ''}`)}`);
          L.push(`      <SOURCE ${/\.flac$/i.test(k.path) ? 'FLAC' : 'WAVE'}`);
          L.push(`        FILE ${q(k.path)}`);
          L.push(`      >`);
          L.push(`    >`);
        }
        L.push(`  >`);
      }
    }
    L.push(`>`);
    return L.join('\n') + '\n';
  }

  // ---- Standard MIDI File (type 1, 480 ppq) ----
  const PPQ = 480;
  function vlq(n) { const out = [n & 0x7f]; n >>= 7; while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; } return out; }
  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >>> 8) & 255, n & 255]; }
  function str(s) { return [...new TextEncoder().encode(s)]; }
  function chunk(tag, bytes) { return [...str(tag), ...u32(bytes.length), ...bytes]; }
  function trackBytes(events) {
    // events: [{tick, bytes}] absolute ticks → delta-encoded, terminated with End Of Track
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const out = []; let last = 0;
    for (const e of events) { out.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes); last = e.tick; }
    out.push(...vlq(0), 0xff, 0x2f, 0x00);
    return out;
  }
  const GM_DRUM = { kick: 36, snare: 38, hat: 42, ohat: 46, tom: 45, crash: 49 };
  const GM_PROGRAM = { bass: 38, saw: 81, square: 80, pad: 89, keys: 4, organ: 16, pluck: 25 };

  // tracks: Cobander tracks; drumEventsFor(track) → [{t (s), voice, vel}] already resolved by app.js
  function midiFile({ song, tracks, beatLen, drumEventsFor, contentLength, meter, lyricLines = null }) {
    const [num, den] = song.timeSig || [4, 4];
    // ticks per second follow the tempo map (Cobander's beat = 1/den note; SMF ticks are per quarter)
    const segs = meter && meter.segs && meter.segs.length ? meter.segs : [{ t0: 0, t1: Infinity, bpm: song.bpm, ts: [num, den] }];
    const rate = (sg) => (sg.bpm * 4 / ((sg.ts && sg.ts[1]) || den)) / 60 * PPQ;
    const tickAt = []; { let acc = 0; for (const sg of segs) { tickAt.push(acc); if (Number.isFinite(sg.t1)) acc += (sg.t1 - sg.t0) * rate(sg); } }
    const secToTick = (s) => { let i = segs.length - 1; while (i > 0 && s < segs[i].t0) i--; return Math.round(tickAt[i] + (s - segs[i].t0) * rate(segs[i])); };
    void beatLen;
    const t0 = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(str(song.name).length), ...str(song.name)] }];
    segs.forEach((sg, i) => {
      const ts = sg.ts || [num, den]; const q = sg.bpm * 4 / ts[1]; const tempo = Math.round(60000000 / q);
      t0.push({ tick: tickAt[i], order: 1, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] });
      t0.push({ tick: tickAt[i], order: 2, bytes: [0xff, 0x58, 0x04, Math.min(255, ts[0]), Math.max(0, Math.round(Math.log2(ts[1]))), 24, 8] });   // SMF can only say 2/4/8/16…: 13/7 is written as 13/8
    });
    // parts as markers, chords as text events (DAWs show both on the timeline)
    for (const x of (song.sections || []).filter((y) => y && !y.deleted)) t0.push({ tick: secToTick(x.start), order: 3, bytes: [0xff, 0x06, ...vlq(str(x.name).length), ...str(x.name)] });
    for (const c of (song.chords || []).filter((y) => y && !y.deleted && typeof y.time === 'number')) t0.push({ tick: secToTick(c.time), order: 4, bytes: [0xff, 0x01, ...vlq(str(c.chord).length), ...str(c.chord)] });
    const chunks = [trackBytes(t0)];
    // the words, timed, as a "Lyrics" track of SMF lyric events (karaoke players and most DAWs read them)
    if (lyricLines && lyricLines.length) {
      const lv = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(6), ...str('Lyrics')] }];
      for (const l of lyricLines) l.words.forEach((w, i) => { if (w.t < 0) return; const txt = `${i === 0 ? '\\' : ''}${w.w}${i < l.words.length - 1 ? ' ' : ''}`; lv.push({ tick: secToTick(w.t), order: 1, bytes: [0xff, 0x05, ...vlq(str(txt).length), ...str(txt)] }); });
      chunks.push(trackBytes(lv));
    }
    let ch = 0;
    for (const t of tracks) {
      const ev = [];
      const name = (n) => ({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(str(n).length), ...str(n)] });
      if (t.instrument === 'drumkit' && t.drum) {
        ev.push(name(`${t.name} (drums)`));
        const parts = t.clips.filter((c) => c.kind === 'midi' && !c.mute);
        for (const c of parts) for (const nn of c.notes || []) { const abs = c.start + nn.t - (c.trimStart || 0); if (abs < 0) continue; const tick = secToTick(abs); ev.push({ tick, order: 1, bytes: [0x99, nn.n & 127, Math.max(1, Math.min(127, Math.round((nn.v ?? 0.8) * 127)))] }); ev.push({ tick: tick + Math.round(PPQ / 8), order: 2, bytes: [0x89, nn.n & 127, 0] }); }
        const inPart = (tt) => parts.some((c) => tt >= c.start - 1e-6 && tt < c.start + Math.max(0, (c.duration || 0) - (c.trimStart || 0) - (c.trimEnd || 0)) - 1e-6);
        for (const d of drumEventsFor(t)) {
          if (inPart(d.t)) continue;
          const n = GM_DRUM[d.voice]; if (n == null) continue;
          const tick = secToTick(d.t); const vel = Math.max(1, Math.min(127, Math.round(d.vel * 127)));
          ev.push({ tick, order: 1, bytes: [0x99, n, vel] });
          ev.push({ tick: tick + Math.round(PPQ / 8), order: 2, bytes: [0x89, n, 0] });
        }
      } else if (String(t.instrument || '').startsWith('synth:')) {
        const c9 = ch === 9 ? ++ch : ch; const chan = c9 & 15;
        ev.push(name(t.name));
        ev.push({ tick: 0, order: 1, bytes: [0xc0 | chan, GM_PROGRAM[t.instrument.slice(6)] ?? 0] });
        for (const c of t.clips) {
          if (c.kind !== 'midi' || c.mute) continue;
          for (const n of c.notes || []) {
            const abs = c.start + n.t - (c.trimStart || 0); if (abs < 0) continue;
            const on = secToTick(abs), off = secToTick(abs + Math.max(0.03, n.d));
            const vel = Math.max(1, Math.min(127, Math.round((n.v ?? 0.8) * 127)));
            for (const iv of (Array.isArray(n.iv) && n.iv.length ? n.iv : [0])) {   // chord notes export as their real pitches
              const p = Math.max(0, Math.min(127, n.n + iv));
              ev.push({ tick: on, order: 1, bytes: [0x90 | chan, p, vel] });
              ev.push({ tick: off, order: 0, bytes: [0x80 | chan, p, 0] });
            }
          }
        }
        ch = (c9 + 1) % 16;
      } else continue;
      chunks.push(trackBytes(ev));
    }
    const bytes = [...chunk('MThd', [...u16(1), ...u16(chunks.length), ...u16(PPQ)])];
    for (const c of chunks) bytes.push(...chunk('MTrk', c));
    void contentLength;
    return new Uint8Array(bytes);
  }

  function readme({ song, tracks, stems, takes, hasMidi, folderName, chart = null }) {
    const [num, den] = song.timeSig || [4, 4];
    const L = [];
    L.push(`${song.name} — DAW hand-off from Cobander`);
    L.push(`Tempo ${song.bpm} bpm, ${num}/${den}. Everything in this folder starts at bar 1 beat 1.`);
    L.push('');
    L.push('WHAT IS HERE');
    L.push(`  ${folderName}.rpp     REAPER project: one track per Cobander track with its stem, plus muted "raw takes" tracks with the untouched recordings at their real positions.`);
    if (hasMidi) L.push(`  ${folderName}.mid     Standard MIDI File: the drum-machine pattern (GM drums, channel 10) and every synth track's notes. Drag into any DAW; pick your own drum/synth sounds.`);
    L.push(`  stems/                One 24-bit WAV per track, post-FX, post-fader, all the same length, starting at bar 1. Sounds exactly like Cobander.`);
    L.push(`  takes/                The raw take files (dry, no FX), named "<track> - <take> - <who> - <id>.flac" (or .wav for older takes) — lossless; every DAW opens FLAC.`);
    L.push(`  mix.wav               The full Cobander mix.`);
    L.push('');
    L.push('HOW TO OPEN');
    L.push('  REAPER:        File > Open project > the .rpp. Done.');
    L.push('  Logic Pro:     New project at the tempo above > File > Import > Audio File, select everything in stems/ (shift-click), "Create new tracks", bar 1. Then File > Import > MIDI File for the .mid if present.');
    L.push('  GarageBand:    New empty project, set tempo, drag all stems/ files onto the empty area at bar 1 (one track each). Drag the .mid for drums/synths.');
    L.push('  Ableton Live:  Set tempo, drag stems/ into Arrangement view at 1.1.1 (each file makes a track). Drag the .mid in for MIDI tracks. Turn Warp OFF on the stems (they are already at tempo).');
    L.push('  FL Studio:     Set tempo, drag stems/ into the Playlist at bar 1 (one per track); File > Import > MIDI file for the .mid.');
    L.push('  Studio One:    Set tempo, drag stems/ onto the arrange view at 1.1.1; drag the .mid in for MIDI.');
    L.push('  Pro Tools:     Set tempo, File > Import > Audio, "New track", Spot to 1|1|000; File > Import > MIDI.');
    L.push('  Anything else: tempo + stems at bar 1 is the universal hand-off. Use takes/ if you want the dry recordings.');
    L.push('');
    L.push('TRACKS');
    for (const t of tracks) {
      const s = stems.find((x) => x.trackId === t.id);
      L.push(`  ${t.name}: ${t.instrument === 'drumkit' ? `drum machine (${t.drum.kit}, ${t.drum.custom ? 'custom pattern' : t.drum.pattern})` : String(t.instrument || 'audio').startsWith('synth:') ? `synth ${t.instrument.slice(6)}` : `${t.type || 'audio'}${t.preset ? `, preset "${t.preset}"` : ''}`}${t.mute ? ' [muted in Cobander]' : ''}${s ? ` → stems/${s.path.split('/').pop()}` : ''}`);
      for (const c of t.clips) if (c.kind !== 'midi') { const k = takes.find((x) => x.clipId === c.id); L.push(`      ${c.name}${c.takenBy ? ` by ${c.takenBy}` : ''} at ${c.start.toFixed(2)} s${c.mute ? ' (muted)' : ''}${k ? ` → takes/${k.path.split('/').pop()}` : ' (not synced yet — missing)'}`); }
    }
    if (chart) { L.push(''); L.push('CHART (also in chart.txt; parts are regions in the .rpp, markers in the .mid)'); for (const line of chart.split('\n')) L.push(`  ${line}`); }
    if (song.notes) { L.push(''); L.push('NOTES'); for (const line of String(song.notes).split('\n')) L.push(`  ${line}`); }
    return L.join('\n') + '\n';
  }

  global.BPDawExport = { reaperProject, midiFile, readme };
})(window);
