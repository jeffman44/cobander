// New-song templates: song structure (sections in bars), tempo, time signature, starter tracks and a matching
// drum-machine groove. Pure data + helpers, no DOM: loaded by the renderer (window.BPTemplates) and by unit tests.
//
// A template:
//   { id, name, blurb, bpm, bpmRange:[lo,hi], timeSig:[n,d], key?, structure:[[sectionName, bars], …],
//     tracks:[kind…]  (kinds from the "What are you recording?" dialog: guitar, bass, vocals, drumsMic, drums, keys, other),
//     drum?:{pattern, kit}  (used when the starter tracks include the drum machine) }
// Band templates saved from a song ("Save as template") live in <shared>/_templates/<name>.json and use the same
// shape, plus `trackSetups` (full track settings: name, type, instrument, fx, gain, pan, drum) instead of `tracks`.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPTemplates = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BAND = ['guitar', 'guitar', 'bass', 'vocals', 'drumsMic'];
  const BUILTIN = [
    { id: 'pop-punk', name: 'Pop-punk', blurb: 'fast, big chorus, half-time bridge', bpm: 180, bpmRange: [165, 195], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]],
      tracks: BAND, drum: { pattern: 'Punk', kit: 'punk' } },
    { id: 'skate-punk', name: 'Skate punk', blurb: 'double-time, short and loud', bpm: 210, bpmRange: [195, 240], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 2]],
      tracks: BAND, drum: { pattern: 'Punk Double-time', kit: 'punk' } },
    { id: 'emo-68', name: 'Emo / midwest (6/8)', blurb: 'twinkly 6/8, quiet-loud (bpm counts eighths)', bpm: 190, bpmRange: [150, 230], timeSig: [6, 8],
      structure: [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 8], ['Breakdown', 8], ['Chorus', 8], ['Outro', 8]],
      tracks: BAND, drum: { pattern: 'Ballad', kit: 'rock' } },
    { id: 'rock', name: 'Verse-chorus rock', blurb: 'the classic shape', bpm: 120, bpmRange: [100, 140], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 4]],
      tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'ballad', name: 'Ballad', blurb: 'slow build, big last chorus', bpm: 74, bpmRange: [60, 85], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]],
      tracks: ['guitar', 'bass', 'vocals', 'keys', 'drumsMic'], drum: { pattern: 'Ballad', kit: 'rock' } },
    { id: 'hardcore', name: 'Hardcore', blurb: 'fast parts, then the breakdown', bpm: 160, bpmRange: [130, 200], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Breakdown', 8], ['Chorus', 8], ['Breakdown', 8]],
      tracks: BAND, drum: { pattern: 'Punk Double-time', kit: 'tight' } },
    { id: 'metal', name: 'Metal', blurb: 'riff intro, double chorus, solo', bpm: 150, bpmRange: [110, 200], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 16], ['Pre-chorus', 8], ['Chorus', 8], ['Verse', 16], ['Pre-chorus', 8], ['Chorus', 16], ['Solo', 16], ['Breakdown', 8], ['Chorus', 16], ['Outro', 4]],
      tracks: BAND, drum: { pattern: 'Metal Double-kick', kit: 'tight' } },
    { id: 'aaba', name: 'AABA', blurb: 'verse, verse, bridge, verse — no chorus', bpm: 110, bpmRange: [80, 140], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Outro', 4]],
      tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'blues', name: '12-bar blues', blurb: 'shuffle, 12-bar choruses', bpm: 96, bpmRange: [70, 130], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 12], ['Verse', 12], ['Solo', 12], ['Verse', 12], ['Outro', 4]],
      tracks: ['guitar', 'guitar', 'bass', 'vocals', 'drumsMic'], drum: { pattern: 'Shuffle', kit: 'rock' } },
    { id: 'ska', name: 'Ska / reggae', blurb: 'offbeat skank', bpm: 150, bpmRange: [70, 180], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]],
      tracks: ['guitar', 'bass', 'vocals', 'keys', 'drumsMic'], drum: { pattern: 'Ska', kit: 'rock' } },
    { id: 'waltz', name: 'Waltz / 3-4', blurb: 'three-four sway', bpm: 140, bpmRange: [90, 180], timeSig: [3, 4],
      structure: [['Intro', 8], ['Verse', 16], ['Chorus', 16], ['Verse', 16], ['Chorus', 16], ['Outro', 8]],
      tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'indie', name: 'Indie rock', blurb: 'jangly verses, big singalong chorus', bpm: 128, bpmRange: [100, 150], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]], tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'grunge', name: 'Grunge', blurb: 'quiet verse, loud chorus', bpm: 112, bpmRange: [90, 140], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 4]], tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'emo', name: 'Emo (4/4)', blurb: 'twinkly riffs, shouted chorus', bpm: 150, bpmRange: [120, 180], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]], tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'post-hardcore', name: 'Post-hardcore', blurb: 'screamed verses, sung chorus', bpm: 165, bpmRange: [130, 200], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Breakdown', 8], ['Bridge', 8], ['Chorus', 8]], tracks: BAND, drum: { pattern: 'Punk Double-time', kit: 'tight' } },
    { id: 'metalcore', name: 'Metalcore', blurb: 'riffs, clean chorus, heavy breakdown', bpm: 140, bpmRange: [110, 180], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Breakdown', 16], ['Chorus', 8], ['Outro', 4]], tracks: BAND, drum: { pattern: 'Metal Double-kick', kit: 'tight' } },
    { id: 'doom', name: 'Doom / stoner', blurb: 'slow, heavy, long riffs', bpm: 66, bpmRange: [50, 90], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Solo', 16], ['Outro', 16]], tracks: ['guitar', 'guitar', 'bass', 'vocals', 'drumsMic'], drum: { pattern: 'Half-time', kit: 'rock' } },
    { id: 'garage', name: 'Garage rock', blurb: 'raw, short, loud', bpm: 145, bpmRange: [120, 170], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8]], tracks: BAND, drum: { pattern: 'Rock 4/4', kit: 'punk' } },
    { id: 'surf', name: 'Surf', blurb: 'twangy lead, instrumental', bpm: 160, bpmRange: [140, 190], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 16], ['Bridge', 8], ['Verse', 16], ['Solo', 16], ['Verse', 16], ['Outro', 4]], tracks: ['guitar', 'guitar', 'bass', 'drumsMic'], drum: { pattern: 'Rock 4/4', kit: 'rock' } },
    { id: 'shoegaze', name: 'Shoegaze', blurb: 'walls of guitar, dreamy vocals', bpm: 100, bpmRange: [80, 130], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 16], ['Outro', 16]], tracks: BAND, drum: { pattern: 'Half-time', kit: 'rock' } },
    { id: 'prog', name: 'Prog (7/8)', blurb: 'odd time, long instrumental middle', bpm: 168, bpmRange: [120, 220], timeSig: [7, 8],
      structure: [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 16], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]], tracks: ['guitar', 'bass', 'vocals', 'keys', 'drumsMic'], drum: { pattern: 'Rock 4/4', kit: 'tight' } },
    { id: 'synthpop', name: 'Synth-pop', blurb: 'four on the floor, hooky chorus', bpm: 118, bpmRange: [100, 130], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 16], ['Outro', 8]], tracks: ['keys', 'keys', 'bass', 'vocals', 'drums'], drum: { pattern: 'Four on the floor', kit: '808' } },
    { id: 'edm', name: 'EDM build / drop', blurb: 'intro, build, drop, break, build, drop', bpm: 126, bpmRange: [120, 150], timeSig: [4, 4],
      structure: [['Intro', 16], ['Build', 8], ['Drop', 16], ['Breakdown', 16], ['Build', 8], ['Drop', 16], ['Outro', 16]], tracks: ['keys', 'keys', 'bass', 'vocals', 'drums'], drum: { pattern: 'Four on the floor', kit: '808' } },
    { id: 'hiphop', name: 'Hip-hop', blurb: '16-bar verses, 8-bar hook', bpm: 90, bpmRange: [70, 100], timeSig: [4, 4],
      structure: [['Intro', 4], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Outro', 4]], tracks: ['keys', 'bass', 'vocals', 'vocals', 'drums'], drum: { pattern: 'Hip-hop', kit: '808' } },
    { id: 'lofi', name: 'Lo-fi beat', blurb: 'chill loop, A/B sections', bpm: 78, bpmRange: [65, 90], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Outro', 4]], tracks: ['keys', 'guitar', 'bass', 'drums'], drum: { pattern: 'Hip-hop', kit: 'lofi' } },
    { id: 'rnb', name: 'R&B', blurb: 'smooth verses, pre, big hook', bpm: 72, bpmRange: [60, 100], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]], tracks: ['keys', 'bass', 'vocals', 'vocals', 'drums'], drum: { pattern: 'Hip-hop', kit: 'lofi' } },
    { id: 'funk', name: 'Funk', blurb: 'groove first, one-chord vamps', bpm: 104, bpmRange: [90, 120], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Breakdown', 8], ['Solo', 16], ['Chorus', 8]], tracks: ['guitar', 'bass', 'keys', 'vocals', 'drumsMic'], drum: { pattern: 'Disco', kit: 'tight' } },
    { id: 'soul', name: 'Soul', blurb: 'verse-chorus with a horn-style bridge', bpm: 96, bpmRange: [70, 120], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]], tracks: ['guitar', 'bass', 'keys', 'vocals', 'drumsMic'], drum: { pattern: 'Shuffle', kit: 'rock' } },
    { id: 'country', name: 'Country', blurb: 'story verses, singalong chorus', bpm: 112, bpmRange: [80, 140], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 4]], tracks: ['guitar', 'guitar', 'bass', 'vocals', 'drumsMic'], drum: { pattern: 'Shuffle', kit: 'rock' } },
    { id: 'folk', name: 'Folk', blurb: 'verses with a refrain, acoustic', bpm: 100, bpmRange: [70, 130], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Outro', 4]], tracks: ['guitar', 'vocals', 'vocals'], drum: { pattern: 'Click only', kit: 'rock' } },
    { id: 'songwriter', name: 'Singer-songwriter', blurb: 'one guitar, one voice, room to grow', bpm: 84, bpmRange: [60, 120], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]], tracks: ['guitar', 'vocals'] },
    { id: 'reggae', name: 'Reggae', blurb: 'one-drop groove', bpm: 76, bpmRange: [60, 90], timeSig: [4, 4],
      structure: [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]], tracks: ['guitar', 'bass', 'keys', 'vocals', 'drumsMic'], drum: { pattern: 'Reggae One-drop', kit: 'rock' } },
    { id: 'jazz', name: 'Jazz standard (AABA 32)', blurb: 'head, solos, head out', bpm: 132, bpmRange: [60, 260], timeSig: [4, 4],
      structure: [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Solo', 32], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Outro', 4]], tracks: ['keys', 'bass', 'guitar', 'drumsMic'], drum: { pattern: 'Shuffle', kit: 'tight' } },
    { id: 'jam', name: 'Just jam', blurb: 'no structure — loop 4 bars and go', bpm: 120, bpmRange: [60, 240], timeSig: [4, 4],
      structure: [], tracks: ['guitar', 'drums'], drum: { pattern: 'Rock 4/4', kit: 'rock' }, loopBars: 4 },
    { id: 'blank', name: 'Blank', blurb: 'empty song, set it up yourself', bpm: 120, bpmRange: [30, 300], timeSig: [4, 4], structure: [], tracks: [] },
  ];

  // Named song structures ("arrangements"), several per style. Used by the new-song wizard (Structure picker) and by
  // "Restructure song", which cuts the takes in your labelled sections and lays them out in the new order.
  // Entries: [label, bars, sourceType?] — sourceType says which of your sections fills the slot (default: the label's
  // type, so "Half chorus" pulls the first half of a Chorus and "Double chorus" plays a Chorus twice as long).
  const A = (genre, id, name, structure, blurb = '') => ({ genre, id: `${genre}:${id}`, name, blurb, structure });
  const ARRANGEMENTS = [
    A('pop-punk', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]], 'V-Pre-C ×2, bridge, last chorus'),
    A('pop-punk', 'half-chorus', 'Half-chorus tease', [['Verse', 8], ['Half chorus', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]], 'verse, half a chorus, verse, chorus, verse, bridge, chorus, outro'),
    A('pop-punk', 'cold-open', 'Cold open', [['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Double chorus', 16], ['Outro', 2]], 'starts on the chorus, double chorus out'),
    A('pop-punk', 'short-fast', 'Short & fast', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 4], ['Chorus', 8]], 'under two minutes, no outro'),
    A('pop-punk', 'breakdown', 'Breakdown ending', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Breakdown', 8], ['Chorus', 8], ['Chorus', 8]], 'breakdown instead of a bridge, two choruses out'),
    A('pop-punk', 'quiet-bridge', 'Quiet bridge build', [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Bridge', 8, 'Bridge'], ['Chorus', 8], ['Outro', 8]], 'bridge twice (quiet, then loud), long outro'),
    A('skate-punk', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 2]]),
    A('skate-punk', 'no-solo', 'Verse-chorus-verse', [['Intro', 2], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Chorus', 8]], 'straight through, chorus twice at the end'),
    A('emo-68', 'quiet-loud', 'Quiet-loud', [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 8], ['Breakdown', 8], ['Chorus', 8], ['Outro', 8]]),
    A('emo-68', 'long-build', 'Long build', [['Intro', 16], ['Verse', 16], ['Verse', 16], ['Bridge', 16], ['Outro', 32]], 'no chorus, builds to a long outro'),
    A('rock', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 4]]),
    A('rock', 'pre-chorus', 'With pre-chorus', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]),
    A('rock', 'riff-returns', 'Intro riff returns', [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Intro', 4, 'Intro'], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Intro', 8, 'Intro']], 'the intro riff comes back between and at the end'),
    A('ballad', 'standard', 'Slow build', [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]),
    A('ballad', 'key-change', 'Big last chorus', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Double chorus', 16], ['Outro', 4]]),
    A('hardcore', 'standard', 'Two breakdowns', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Breakdown', 8], ['Chorus', 8], ['Breakdown', 8]]),
    A('hardcore', 'short', 'Short blast', [['Intro', 2], ['Verse', 8], ['Breakdown', 8], ['Verse', 8], ['Breakdown', 16]], 'no chorus, ends on the breakdown'),
    A('metal', 'standard', 'Standard', [['Intro', 8], ['Verse', 16], ['Pre-chorus', 8], ['Chorus', 8], ['Verse', 16], ['Pre-chorus', 8], ['Chorus', 16], ['Solo', 16], ['Breakdown', 8], ['Chorus', 16], ['Outro', 4]]),
    A('metal', 'prog', 'Long-form', [['Intro', 16], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 16], ['Solo', 16], ['Breakdown', 16], ['Chorus', 16], ['Outro', 16]]),
    A('aaba', 'standard', 'AABA', [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Outro', 4]]),
    A('aaba', 'aaba-twice', 'AABA, bridge twice', [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Outro', 4]]),
    A('blues', 'standard', '12-bar', [['Intro', 4], ['Verse', 12], ['Verse', 12], ['Solo', 12], ['Verse', 12], ['Outro', 4]]),
    A('ska', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]),
    A('waltz', 'standard', 'Standard', [['Intro', 8], ['Verse', 16], ['Chorus', 16], ['Verse', 16], ['Chorus', 16], ['Outro', 8]]),
    A('indie', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]]),
    A('indie', 'slow-burn', 'Slow burn', [['Intro', 8], ['Verse', 16], ['Verse', 16], ['Chorus', 8], ['Bridge', 8], ['Double chorus', 16], ['Outro', 16]], 'two verses before the first chorus'),
    A('grunge', 'standard', 'Quiet-loud', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 4]]),
    A('emo', 'standard', 'Standard', [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]]),
    A('emo', 'gang-vocal', 'Gang-vocal ending', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Breakdown', 8], ['Outro', 16]], 'ends on a long shouted outro'),
    A('post-hardcore', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Breakdown', 8], ['Bridge', 8], ['Chorus', 8]]),
    A('metalcore', 'standard', 'Standard', [['Intro', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Breakdown', 16], ['Chorus', 8], ['Outro', 4]]),
    A('metalcore', 'double-breakdown', 'Two breakdowns', [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Breakdown', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Breakdown', 16]]),
    A('doom', 'standard', 'Slow and long', [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Solo', 16], ['Outro', 16]]),
    A('synthpop', 'standard', 'Standard', [['Intro', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 16], ['Outro', 8]]),
    A('synthpop', 'post-chorus', 'With post-chorus hook', [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Post-chorus', 4, 'Chorus'], ['Verse', 8], ['Chorus', 8], ['Post-chorus', 4, 'Chorus'], ['Bridge', 8], ['Chorus', 8], ['Post-chorus', 8, 'Chorus']]),
    A('edm', 'standard', 'Build / drop ×2', [['Intro', 16], ['Build', 8], ['Drop', 16], ['Breakdown', 16], ['Build', 8], ['Drop', 16], ['Outro', 16]]),
    A('edm', 'radio', 'Radio edit', [['Intro', 8], ['Verse', 8], ['Build', 8], ['Drop', 16], ['Verse', 8], ['Build', 8], ['Drop', 16]], 'vocal verses, shorter'),
    A('hiphop', 'standard', '16-bar verses', [['Intro', 4], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Outro', 4]]),
    A('hiphop', 'three-verse', 'Three verses', [['Intro', 4], ['Verse', 16], ['Hook', 8], ['Verse', 16], ['Hook', 8], ['Verse', 16], ['Hook', 8]]),
    A('rnb', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]),
    A('funk', 'standard', 'Vamp & break', [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Breakdown', 8], ['Solo', 16], ['Chorus', 8]]),
    A('country', 'standard', 'Standard', [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Solo', 8], ['Chorus', 8], ['Outro', 4]]),
    A('country', 'bridge', 'With bridge & tag', [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Chorus', 4, 'Chorus'], ['Outro', 4]], 'last line tagged'),
    A('folk', 'standard', 'Three verses', [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Outro', 4]]),
    A('songwriter', 'standard', 'Standard', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]]),
    A('reggae', 'standard', 'Standard', [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]]),
    A('jazz', 'standard', 'Head – solos – head', [['Intro', 4], ['Verse', 8], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Solo', 32], ['Verse', 8], ['Bridge', 8], ['Verse', 8], ['Outro', 4]]),
    A('prog', 'standard', 'Long instrumental middle', [['Intro', 8], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 16], ['Bridge', 8], ['Chorus', 8], ['Outro', 8]]),
    A('shoegaze', 'standard', 'Dreamy', [['Intro', 8], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Bridge', 16], ['Outro', 16]]),
    A('garage', 'standard', 'Short & loud', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Solo', 8], ['Chorus', 8]]),
    A('surf', 'standard', 'Instrumental', [['Intro', 4], ['Verse', 16], ['Bridge', 8], ['Verse', 16], ['Solo', 16], ['Verse', 16], ['Outro', 4]]),
    A('lofi', 'standard', 'Loop A/B', [['Intro', 4], ['Verse', 16], ['Chorus', 8], ['Verse', 16], ['Chorus', 8], ['Outro', 4]]),
  ];
  const arrangementsFor = (genre) => ARRANGEMENTS.filter((a) => a.genre === genre);

  // "Verse 2" → verse, "Half chorus" → chorus, "Middle 8" → bridge … the kind of section, for matching.
  const SYN = { middle: 'bridge', 'post chorus': 'post-chorus', postchorus: 'post-chorus',   /* a post-chorus is its own part (0.12.3 — it used to count as a chorus and got linked to / named after it) */ refrain: 'chorus', hook: 'chorus', 'middle 8': 'bridge', middle8: 'bridge', pre: 'pre-chorus', prechorus: 'pre-chorus', 'pre chorus': 'pre-chorus', lead: 'solo', 'guitar solo': 'solo', ending: 'outro', coda: 'outro', 'break down': 'breakdown', interlude: 'bridge' };
  function sectionType(name) {
    let n = String(name || '').toLowerCase().trim().replace(/\s*\(.*\)$/, '').replace(/\s*#?\d+$/, '').replace(/^(half|short|double|big|last|final|first|quiet|loud)\s+/, '').trim();
    return SYN[n] || n;
  }

  // Re-arrange a song into `structure`: every slot takes the takes (audio + MIDI), chords, lyric lines and notes that sit
  // inside the matching labelled section of the song and moves them into place. Pure: returns the new pieces + a report.
  //   song: {tracks:[{id, clips:[{id, src?, start, duration, trimStart, trimEnd, fadeIn, fadeOut, kind?, notes?}]}], sections, chords, lyrics, markers}
  //   opts: {bpm, timeSig, newId(), clipLength?(clip)}
  function restructure(song, structure, opts = {}) {
    const bpm = clamp(opts.bpm != null ? opts.bpm : song.bpm, 30, 300, 120), ts = sig(opts.timeSig || song.timeSig), bar = barSeconds(bpm, ts);
    const nid = opts.newId || (() => Math.random().toString(16).slice(2, 14).padEnd(12, '0'));
    const lenOf = opts.clipLength || ((c) => Math.max(0, (Number(c.duration) || 0) - (c.trimStart || 0) - (c.trimEnd || 0)));
    const live = (a) => (Array.isArray(a) ? a.filter((x) => x && !x.deleted) : []);
    const srcSecs = live(song.sections).slice().sort((a, b) => a.start - b.start);
    const byType = {}; for (const sc of srcSecs) (byType[sectionType(sc.name)] = byType[sectionType(sc.name)] || []).push(sc);
    const seenType = {}; const used = new Set();
    const report = { slots: [], missing: [], unusedSections: [], droppedClips: 0, shortened: [], padded: [], notesLeft: [] };
    const idMap = new Map();   // original clip id → ids of its pieces (stars / reactions follow the take)
    const LEAD = 0.03;         // pieces start 30 ms early (faded in) so pickups and slightly-early notes aren't chopped
    const tracks = (song.tracks || []).map((t) => ({ ...t, clips: [] }));
    const chords = [], lyricsMoved = new Map(), markersMoved = new Map();
    const sections = [];
    let at = 0;
    const numbered = numberSections(structure.map(([l, b]) => [l, b]));
    const lastSlot = structure.length - 1;
    const slotsOfType = {}; for (const [l, , from] of structure) { const ty = sectionType(from || l); slotsOfType[ty] = (slotsOfType[ty] || 0) + 1; }
    structure.forEach(([label, bars, from], i) => {
      const want = Math.max(1, Number(bars) || 1) * bar;
      const type = sectionType(from || label);
      const k = seenType[type] = (seenType[type] === undefined ? 0 : seenType[type] + 1);
      const pool = byType[type] || [];
      let src = pool.length ? pool[k % pool.length] : null;
      const slot = { name: numbered[i][0], start: at, end: at + want };
      // linked type: only its first slot (the room) gets pieces — always from the real room (first linked section);
      // later slots are copies of the room, except an "unlinked on purpose" section carries over BY ROLE, counted
      // from the end (delete Chorus 2 of C1 · C2 · C3(unlinked) → the LAST chorus is still the different one).
      const linkedTy = !!(opts.linkGroups && opts.linkGroups[type]);
      if (linkedTy && pool.length) {
        const room = pool.find((x) => !x.unlinked) || pool[0];
        if (k === 0) src = room;
        else { const fromEnd = slotsOfType[type] - 1 - k, cand = pool[pool.length - 1 - fromEnd]; if (cand && cand.unlinked && pool.length - 1 - fromEnd > 0) { slot.unlinked = true; src = cand; } }
      }
      slot._from = linkedTy && k > 0 && !slot.unlinked ? (pool.find((x) => !x.unlinked) || {}).id || null : src ? src.id : null;   // (for re-pointing needs; stripped by the app)
      if (linkedTy && k > 0 && !slot.unlinked) { sections.push(slot); report.slots.push({ slot: slot.name, from: `${pool.length ? pool[0].name : type} (linked)` }); at += want; return; }
      sections.push(slot);
      if (!src) { if (!report.missing.includes(numbered[i][0].replace(/\s+\d+$/, ''))) report.missing.push(numbered[i][0].replace(/\s+\d+$/, '')); report.slots.push({ slot: slot.name, from: null }); at += want; return; }
      used.add(src.id);
      const srcLen = src.end - src.start;
      // Double / longer slot than the source: repeat the source to fill it. Shorter (half chorus): take its start.
      const reps = Math.max(1, Math.ceil(want / srcLen - 1e-6));
      if (want < srcLen - 1e-6) report.shortened.push(slot.name); else if (reps > 1) report.padded.push(slot.name);
      report.slots.push({ slot: slot.name, from: src.name });
      for (let r = 0; r < reps; r++) {
        const w0 = src.start, w1 = src.start + Math.min(srcLen, want - r * srcLen), dst = at + r * srcLen;
        if (w1 - w0 < 0.01) break;
        for (let ti = 0; ti < (song.tracks || []).length; ti++) {
          for (const c of song.tracks[ti].clips || []) {
            const cs = c.start, ce = c.start + lenOf(c);
            const ringOut = i === lastSlot && r === reps - 1;   // the last part keeps its ring-out to the end of the take
            const lead = Math.min(LEAD, dst);                   // (no lead before the very start of the song)
            if (Math.min(ce, w1) - Math.max(cs, w0) < 0.005) continue;   // must really be inside the part, not just in the lead-in
            const a = Math.max(cs, w0 - lead), b = ringOut ? ce : Math.min(ce, w1);
            const full = Number(c.duration) || (ce - cs + (c.trimStart || 0) + (c.trimEnd || 0));
            const trimStart = (c.trimStart || 0) + (a - cs), len = b - a;
            const piece = { ...c, id: nid(), src: c.src || c.id, start: dst + (a - w0), trimStart, trimEnd: Math.max(0, full - trimStart - len),
              fadeIn: a > cs + 1e-6 ? Math.max(0.004, w0 - a) : (c.fadeIn || 0), fadeOut: b < ce - 1e-6 ? 0.004 : (c.fadeOut || 0) };   // short fades at the cuts: no clicks
            if (c.kind === 'midi' && Array.isArray(c.notes)) piece.notes = c.notes.filter((n) => n.t >= trimStart - 1e-6 && n.t < trimStart + len).map((n) => ({ ...n }));   // own copies: pieces never share note objects
            if (c.kind === 'midi' && piece.src === piece.id) delete piece.src;
            if (!idMap.has(c.id)) idMap.set(c.id, []); idMap.get(c.id).push(piece.id);
            tracks[ti].clips.push(piece);
          }
        }
        for (const ch of live(song.chords)) if (ch.time >= w0 - 1e-6 && ch.time < w1 - 1e-6) chords.push({ ...ch, id: nid(), time: dst + (ch.time - w0) });
        if (r === 0) {
          for (const l of live(song.lyrics)) if (typeof l.time === 'number' && l.time >= w0 - 1e-6 && l.time < w1 && !lyricsMoved.has(l.id)) lyricsMoved.set(l.id, dst + (l.time - w0));
          for (const m of live(song.markers)) if (m.time >= w0 - 1e-6 && m.time < w1 && !markersMoved.has(m.id)) markersMoved.set(m.id, dst + (m.time - w0));
        }
      }
      at += want;
    });
    // takes that were not inside any section we used are left out of the new arrangement (they stay in history)
    const inUsed = (c) => { const cs = c.start, ce = c.start + lenOf(c); return srcSecs.some((sc) => used.has(sc.id) && Math.min(ce, sc.end) - Math.max(cs, sc.start) > 0.005); };
    for (const t of song.tracks || []) for (const c of t.clips || []) if (!inUsed(c)) report.droppedClips++;
    report.unusedSections = srcSecs.filter((sc) => !used.has(sc.id)).map((sc) => sc.name);
    for (const m of live(song.markers)) if (!markersMoved.has(m.id)) { const sc = srcSecs.find((x) => m.time >= x.start - 1e-6 && m.time < x.end); report.notesLeft.push({ id: m.id, from: sc ? sc.name : null }); }
    return { tracks, sections, chords, lyricsMoved, markersMoved, idMap, length: at, report };
  }

  // Everything inside [w0, w1) as a self-contained part: per track, clip pieces re-timed to start at 0.
  function extractWindow(song, w0, w1, { clipLength, newId } = {}) {
    const lenOf = clipLength || ((c) => Math.max(0, (Number(c.duration) || 0) - (c.trimStart || 0) - (c.trimEnd || 0)));
    const nid = newId || (() => Math.random().toString(16).slice(2, 14).padEnd(12, '0'));
    const tracks = [];
    for (const t of song.tracks || []) {
      const clips = [];
      for (const c of t.clips || []) {
        if (c.mute) continue;
        const cs = c.start, ce = c.start + lenOf(c); const a = Math.max(cs, w0), b = Math.min(ce, w1); if (b - a < 0.01) continue;
        const full = Number(c.duration) || (ce - cs + (c.trimStart || 0) + (c.trimEnd || 0)); const trimStart = (c.trimStart || 0) + (a - cs), len = b - a;
        const p = { id: nid(), kind: c.kind, name: c.name, start: a - w0, duration: full, trimStart, trimEnd: Math.max(0, full - trimStart - len), gainDb: c.gainDb || 0, fadeIn: a > cs + 1e-6 ? 0.004 : (c.fadeIn || 0), fadeOut: b < ce - 1e-6 ? 0.004 : (c.fadeOut || 0) };
        if (c.kind === 'midi') { p.notes = (c.notes || []).filter((n) => n.t >= trimStart - 1e-6 && n.t < trimStart + len).map((n) => ({ ...n })); if (!p.notes.length) continue; if (c.melody) p.melody = JSON.parse(JSON.stringify(c.melody)); } else p.src = c.src || c.id;
        clips.push(p);
      }
      if (clips.length) tracks.push({ name: t.name, type: t.type, instrument: t.instrument, fx: t.fx ? JSON.parse(JSON.stringify(t.fx)) : undefined, preset: t.preset || null, clips });
    }
    const chords = (song.chords || []).filter((x) => x && !x.deleted && x.time >= w0 - 1e-6 && x.time < w1 - 1e-6).map((x) => ({ time: x.time - w0, chord: x.chord }));
    // the words sung in the window travel with it (word timings are relative to their line, so they need no change)
    const lyrics = (song.lyrics || []).filter((x) => x && !x.deleted && typeof x.time === 'number' && x.time >= w0 - 1e-6 && x.time < w1 - 1e-6 && String(x.text || '').trim()).map((x) => ({ time: x.time - w0, text: x.text, ...(Array.isArray(x.words) && x.words.length ? { words: x.words.map((w) => ({ ...w })) } : {}) }));
    return { tracks, chords, lyrics, length: w1 - w0 };
  }

  // ---------- linked sections ("section rooms") ----------
  // song.linkGroups = { chorus: true, … } turns linking on for a section type. The first (earliest) section of that
  // type that is not `unlinked` is the room; every other linked one plays a mirror of it. Mirrors are real clips in
  // song.json (playback, export and older Cobanders just work) marked `link: {from, section}`, with ids derived from
  // (source clip, section) so every bandmate's Cobander regenerates exactly the same mirrors and merges stay clean.
  function hash12(str) {   // two FNV-1a 32-bit hashes → 12 hex chars, deterministic
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
  }
  function linkInfo(song) {
    const groups = song.linkGroups || {}; const out = {};
    const secs = (song.sections || []).filter((x) => x && !x.deleted).slice().sort((a, b) => a.start - b.start);
    for (const sc of secs) {
      const ty = sectionType(sc.name); if (!groups[ty] || sc.unlinked) continue;
      (out[ty] = out[ty] || { type: ty, room: null, followers: [] });
      if (!out[ty].room) out[ty].room = sc; else out[ty].followers.push(sc);
    }
    return out;
  }
  // ---- part tails & pickups: a take mostly inside a part belongs to it, including up to `edge` (default 1 bar ≈ 2 s)
  // of lead-in before the downbeat and ring-out after the last bar. Owned takes move / copy whole instead of being cut.
  function ownerOf(sections, cs, ce, edgeOf) {
    const len = Math.max(1e-6, ce - cs); let best = null, bestIn = 0;
    for (const s of sections) { const inn = Math.max(0, Math.min(ce, s.end) - Math.max(cs, s.start)); if (inn > bestIn) { bestIn = inn; best = s; } }
    if (!best || bestIn / len < 0.5) return null;
    const e = edgeOf ? edgeOf(best) : 2;
    return cs >= best.start - e - 1e-6 && ce <= best.end + e + 1e-6 ? best : null;
  }
  // Recompute every mirror. Returns {changed, tracks:[{id, clips}]} — clips = non-mirror clips + fresh mirrors.
  // through(track): tracks that play straight through (a lead vocal sung top to bottom): a take of theirs that spans
  // several parts is a performance, not a copy — it neither mirrors into the copies nor unlinks them
  function linkMirrors(song, { clipLength, edge, through = null } = {}) {
    const secsAll = (song.sections || []).filter((x) => x && !x.deleted);
    const lenOf = clipLength || ((c) => Math.max(0, (Number(c.duration) || 0) - (c.trimStart || 0) - (c.trimEnd || 0)));
    const info = linkInfo(song);
    // ids every copy will get: an un-marked clip carrying one of them is a copy that lost its mark (older Cobander) — drop it
    const copyIds = new Set();
    for (const g of Object.values(info)) for (const f of g.followers) for (const t of song.tracks || []) for (const c of t.clips || []) if (!c.link) copyIds.add(hash12(`${c.id}|${f.id}`));
    const tracks = (song.tracks || []).map((t) => ({ id: t.id, clips: (t.clips || []).filter((c) => !c.link && !copyIds.has(c.id)) }));
    for (const g of Object.values(info)) {
      const room = g.room; const w0 = room.start, w1 = room.end;
      for (const f of g.followers) {
        const span = Math.min(w1 - w0, f.end - f.start);
        tracks.forEach((t, ti) => {
          for (const c of (song.tracks[ti].clips || [])) {
            if (c.link || copyIds.has(c.id)) continue;
            const cs = c.start, ce = c.start + lenOf(c);
            const own = ownerOf(secsAll, cs, ce, edge);
            let a, b;
            if (own && own.id === room.id) { a = cs; b = Math.min(ce, w0 + span + (edge ? edge(room) : 2)); }   // the room's take, pickup and ring-out included
            else if (own) continue;   // another part's take (its pickup / tail just touches the room): not the room's to copy
            else if (through && through(song.tracks[ti])) continue;   // a straight-through performance
            else { a = Math.max(cs, w0); b = Math.min(ce, w0 + span); if (b - a < 0.005) continue; if (a - w0 > span - 0.035) continue; }
            const full = Number(c.duration) || (ce - cs + (c.trimStart || 0) + (c.trimEnd || 0));
            const trimStart = (c.trimStart || 0) + (a - cs), len = b - a; if (len < 0.005) continue;
            const m = { ...c, id: hash12(`${c.id}|${f.id}`), start: Math.max(0, f.start + (a - w0)), trimStart, trimEnd: Math.max(0, full - trimStart - len),
              fadeIn: a > cs + 1e-6 ? 0.004 : (c.fadeIn || 0), fadeOut: b < ce - 1e-6 ? 0.004 : (c.fadeOut || 0), link: { from: c.id, section: f.id } };
            if (c.kind !== 'midi') m.src = c.src || c.id; else { delete m.src; m.notes = (c.notes || []).filter((n) => n.t >= trimStart - 1e-6 && n.t < trimStart + len).map((n) => ({ ...n })); }
            t.clips.push(m);
          }
        });
      }
    }
    const mirrorSig = (arr) => JSON.stringify(arr.map((t) => t.clips.filter((c) => c.link).map((c) => [c.id, c.start, c.trimStart, c.trimEnd, c.mute, c.gainDb, c.fadeIn, c.fadeOut, c.src, c.notes && c.notes.length]).sort()));
    const before = (song.tracks || []).map((t) => ({ clips: t.clips || [] }));
    const dropped = (song.tracks || []).some((t, i) => (t.clips || []).filter((c) => !c.link).length !== tracks[i].clips.filter((c) => !c.link).length);
    return { changed: dropped || mirrorSig(before) !== mirrorSig(tracks), tracks, info };
  }
  // Own (non-copy) clips that reach into a linked follower: split at the follower's edges; the inside piece is
  // returned in `removed` (the follower plays the room instead). Used when linking and after recording / dropping.
  function carveFollowers(song, { clipLength, newId, edge, through = null } = {}) {
    const lenOf = clipLength || ((c) => Math.max(0, (Number(c.duration) || 0) - (c.trimStart || 0) - (c.trimEnd || 0)));
    const nid = newId || (() => Math.random().toString(16).slice(2, 14).padEnd(12, '0'));
    const secsAll = (song.sections || []).filter((x) => x && !x.deleted);
    const fol = []; const roomOf = new Map(); for (const g of Object.values(linkInfo(song))) for (const f of g.followers) { fol.push(f); roomOf.set(f.id, g.room); }
    const edgeOf = (sec) => (edge ? edge(sec) : 2);
    const removed = [], moved = [], unlinked = new Set(); let changed = false;
    // A take that BELONGS to a linked copy (mostly inside it, pickup / ring-out included) was recorded / dropped there on
    // purpose: it moves to the room, whole, so every copy plays it. A take that runs deep into a copy from somewhere else
    // (a run-through) keeps its own performance: that copy unlinks. Another part's pickup or tail just touching the copy is left alone.
    for (const t of song.tracks || []) for (const c of t.clips || []) {
      if (c.link) continue; const cs = c.start, ce = c.start + lenOf(c); const own = ownerOf(secsAll, cs, ce, edge);
      if (!own && through && through(t)) continue;
      for (const f of fol) { const inn = Math.min(ce, f.end) - Math.max(cs, f.start); if (inn < 0.01 || (own && own.id === f.id)) continue; if (inn > edgeOf(f) + 0.01 || !own) { if (own || cs < f.start - 0.35) unlinked.add(f.id); } }
    }
    const live = fol.filter((f) => !unlinked.has(f.id));
    const tracks = (song.tracks || []).map((t) => {
      let clips = (t.clips || []).slice(); const thru = !!(through && through(t));
      for (const f of live) {
        const next = [];
        for (const c of clips) {
          const cs = c.start, ce = c.start + lenOf(c);
          if (c.link || Math.min(ce, f.end) - Math.max(cs, f.start) < 0.01) { next.push(c); continue; }
          const own = ownerOf(secsAll, cs, ce, edge);
          if (own && own.id !== f.id) { next.push(c); continue; }   // another part's pickup / tail
          if (!own && thru) { next.push(c); continue; }   // a straight-through vocal: left as sung
          const room = roomOf.get(f.id); changed = true;
          if (own && own.id === f.id) {   // the whole take (pickup and ring-out too) goes to the room
            if (room) moved.push({ trackId: t.id, clip: { ...c, start: Math.max(0, room.start + (cs - f.start)) } }); else removed.push({ trackId: t.id, clip: c });
            continue;
          }
          const full = Number(c.duration) || (ce - cs + (c.trimStart || 0) + (c.trimEnd || 0));
          const piece = (a, b, keepId) => { const ts = (c.trimStart || 0) + (a - cs); const p = { ...c, id: keepId ? c.id : nid(), ...(c.kind !== 'midi' && !keepId ? { src: c.src || c.id } : {}), start: a, trimStart: ts, trimEnd: Math.max(0, full - ts - (b - a)), fadeIn: a > cs + 1e-6 ? 0.004 : c.fadeIn || 0, fadeOut: b < ce - 1e-6 ? 0.004 : c.fadeOut || 0 }; if (c.kind === 'midi') p.notes = (c.notes || []).filter((n) => n.t >= ts - 1e-6 && n.t < ts + (b - a)).map((n) => ({ ...n })); return p; };
          let kept = false;
          if (cs < f.start - 0.01) { next.push(piece(cs, f.start, true)); kept = true; }
          const inside = piece(Math.max(cs, f.start), Math.min(ce, f.end), !kept && !(ce > f.end + 0.01));
          if (room) moved.push({ trackId: t.id, clip: { ...inside, start: room.start + (inside.start - f.start) } }); else removed.push({ trackId: t.id, clip: inside });
          if (ce > f.end + 0.01) next.push(piece(f.end, ce, !kept));
        }
        clips = next;
      }
      return { ...t, clips };
    });
    return { changed: changed || unlinked.size > 0, tracks, removed, moved, unlinked: [...unlinked] };
  }
  // Which linked section (follower) a time falls in, if any → {group, section}
  function followerAt(song, time) {
    for (const g of Object.values(linkInfo(song))) for (const f of g.followers) if (time >= f.start - 1e-6 && time < f.end - 1e-6) return { group: g, section: f };
    return null;
  }

  const KEYS = ['', 'C', 'C#/Db', 'D', 'D#/Eb', 'E', 'F', 'F#/Gb', 'G', 'G#/Ab', 'A', 'A#/Bb', 'B'].flatMap((k) => (k ? [k, `${k}m`] : ['']));
  const TIME_SIGS = [[4, 4], [3, 4], [6, 8], [2, 4], [5, 4], [7, 8], [9, 8], [12, 8]];

  const clamp = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  // same rule as the engine's validTimeSig: 1–64 beats over any note value 1–64 (13/7 included); a grouping may ride along
  const sig = (ts) => { if (!Array.isArray(ts) || ts.length < 2) return [4, 4]; const n = Number(ts[0]), d = Number(ts[1]); if (!Number.isInteger(n) || !Number.isInteger(d) || n < 1 || n > 64 || d < 1 || d > 64) return [4, 4]; const g = Array.isArray(ts[2]) && ts[2].reduce((a, b) => a + Number(b), 0) === n ? ts[2].map(Number) : null; return g ? [n, d, g] : [n, d]; };
  // Length of one bar in seconds — same rule as the engine: one beat = 60/bpm, a bar = numerator beats (so in 6/8 the bpm counts eighths).
  function barSeconds(bpm, timeSig) { const [n] = sig(timeSig); return (60 / clamp(bpm, 30, 300, 120)) * n; }

  // Repeated names get numbers: Verse 1, Verse 2 … (a name that appears once stays bare).
  function numberSections(structure) {
    const total = {}; for (const [name] of structure || []) total[name] = (total[name] || 0) + 1;
    const seen = {};
    return (structure || []).map(([name, bars]) => { seen[name] = (seen[name] || 0) + 1; return [total[name] > 1 ? `${name} ${seen[name]}` : name, bars]; });
  }
  // Sections in seconds for a structure at a tempo: [{name, start, end}] back to back from 0.
  function layoutSections(structure, bpm, timeSig) {
    const b = barSeconds(bpm, timeSig); let at = 0;
    return numberSections(structure).filter(([, bars]) => Number(bars) > 0).map(([name, bars]) => { const s = { name: String(name).slice(0, 40), start: at, end: at + Number(bars) * b }; at = s.end; return s; });
  }
  const totalBars = (structure) => (structure || []).reduce((n, [, bars]) => n + (Number(bars) || 0), 0);
  function summary(t) {
    const bars = totalBars(t.structure); const secs = bars * barSeconds(t.bpm, t.timeSig);
    return bars ? `${bars} bars · ~${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')} at ${t.bpm}` : 'no sections';
  }

  // A band template from an open song: structure from its sections (rounded to bars), tempo, and track setups (no audio).
  function fromSong(song, name, by) {
    const bpm = clamp(song.bpm, 30, 300, 120), ts = sig(song.timeSig), b = barSeconds(bpm, ts);
    const secs = (song.sections || []).filter((s) => s && !s.deleted).slice().sort((x, y) => x.start - y.start);
    const structure = secs.map((s) => [String(s.name).replace(/\s+\d+$/, ''), Math.max(1, Math.round((s.end - s.start) / b))]);
    const trackSetups = (song.tracks || []).map((t) => {
      const o = { name: t.name, type: t.type, instrument: t.instrument, gainDb: t.gainDb, pan: t.pan, color: t.color, preset: t.preset || null };
      if (t.fx) o.fx = JSON.parse(JSON.stringify(t.fx));
      if (t.drum) o.drum = JSON.parse(JSON.stringify(t.drum));
      return o;
    });
    return { id: `band-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'template'}`, name: String(name).slice(0, 60), blurb: `saved by ${by || 'someone'} from "${song.name}"`, band: true, by: by || null, at: new Date().toISOString(),
      bpm, bpmRange: [30, 300], timeSig: ts, key: song.key || '', structure, trackSetups };
  }
  // [[label, bars, sourceType?]…] → clean triples (the source type stays with its own slot), max 64 slots / 1024 bars
  function normalizeStructure(st) {
    if (!Array.isArray(st)) return [];
    const out = []; let total = 0;
    for (const x of st) {
      if (!Array.isArray(x) || !String(x[0] || '').trim()) continue;
      const bars = Math.min(256, Math.round(Number(x[1]))); if (!(bars > 0) || total + bars > 1024 || out.length >= 64) continue;
      total += bars; out.push(x[2] ? [String(x[0]).slice(0, 40), bars, String(x[2]).slice(0, 40)] : [String(x[0]).slice(0, 40), bars]);
    }
    return out;
  }
  // Validate / normalise a template read from disk (band templates are written by other machines).
  function normalize(t) {
    if (!t || typeof t !== 'object' || !t.name) return null;
    const structure = normalizeStructure(t.structure);
    const KINDS = ['guitar', 'bass', 'vocals', 'drumsMic', 'drums', 'keys', 'other'];
    const setups = Array.isArray(t.trackSetups) ? t.trackSetups.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string' && x.name.trim()).slice(0, 32).map((x) => ({ ...x, name: x.name.slice(0, 60) })) : [];
    return { ...t, name: String(t.name).slice(0, 60), blurb: typeof t.blurb === 'string' ? t.blurb.slice(0, 120) : '', bpm: clamp(t.bpm, 30, 300, 120), bpmRange: [30, 300], timeSig: sig(t.timeSig), key: typeof t.key === 'string' ? t.key.slice(0, 8) : '', structure: structure.slice(0, 64),
      tracks: Array.isArray(t.tracks) ? t.tracks.map(String).filter((k) => KINDS.includes(k)).slice(0, 32) : [], trackSetups: setups.length ? setups : null };
  }

  return { ownerOf, BUILTIN, ARRANGEMENTS, arrangementsFor, KEYS, TIME_SIGS, barSeconds, numberSections, layoutSections, totalBars, summary, fromSong, normalize, normalizeStructure, sectionType, restructure, validSig: sig, hash12, linkInfo, linkMirrors, carveFollowers, followerAt, extractWindow };
});
