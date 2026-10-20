// Track types and the preset library. A preset is a partial fx object (plus optional
// gainDb) merged over the track's current fx. Units: dB, Hz, seconds, 0..1 for mixes.
(function (global) {
  'use strict';

  const TYPES = ['guitar', 'bass', 'vocals', 'drums', 'keys', 'other'];

  // amp.model: clean | crunch | lead | highgain | fuzz | bass | bassdrive
  // amp.cab:   412 | 212 | 112 | 810 | 115 | none
  const amp = (model, gain, bass, mid, treble, presence, cab, level = 0) => ({ amp: { on: true, model, gain, bass, mid, treble, presence, cab, level } });
  const noAmp = { amp: { on: false } };
  const hpf = (hz) => ({ hpf: { on: true, hz } });
  const lpf = (hz) => ({ lpf: { on: true, hz } });
  const eq = (low, mid, high, lowHz = 120, midHz = 1000, highHz = 8000, q = 1) => ({ eq: { on: true, low: { hz: lowHz, db: low }, mid: { hz: midHz, db: mid, q }, high: { hz: highHz, db: high } } });
  const comp = (threshold, ratio, attack, release, makeup = 0, knee = 6) => ({ comp: { on: true, threshold, ratio, attack, release, makeup, knee } });
  // time is given in seconds-at-120-bpm for readability; synced delays are stored in beats (×2).
  const delay = (time, feedback, mix, sync = true) => ({ delay: { on: true, time: sync ? time * 2 : time, feedback, mix, sync } });
  const noDelay = { delay: { on: false } };
  const verb = (v) => ({ reverbSend: v });
  const gate = (threshold) => ({ gate: { on: true, threshold } });
  const P = (name, blurb, ...parts) => ({ name, blurb, fx: Object.assign({}, ...parts) });

  const guitar = [
    P('Clean DI', 'no amp, flat — for a modeller or already-amped signal', noAmp, hpf(80), { eq: { on: false } }, { comp: { on: false } }, noDelay, verb(0)),
    P('Clean Twin', 'sparkly clean, light comp, hint of room', amp('clean', 3, 1, -1, 3, 2, '212'), hpf(90), comp(-24, 2.5, 0.01, 0.15, 2), noDelay, verb(0.15)),
    P('Clean Chorus-ish', 'clean with short slap delay for width', amp('clean', 2.5, 2, -2, 2, 1, '212'), hpf(90), comp(-22, 2, 0.01, 0.2, 2), delay(0.09, 0.1, 0.25, false), verb(0.12)),
    P('Jangle', 'bright, compressed clean for arpeggios', amp('clean', 4, -1, 0, 5, 4, '112'), hpf(110), comp(-26, 4, 0.005, 0.1, 4), noDelay, verb(0.18)),
    P('Edge of Breakup', 'just starting to grit', amp('crunch', 4, 1, 1, 2, 2, '212'), hpf(90), { comp: { on: false } }, noDelay, verb(0.1)),
    P('Crunch', 'classic mid-gain rhythm', amp('crunch', 6, 1, 2, 2, 3, '412'), hpf(100), { comp: { on: false } }, noDelay, verb(0.06)),
    P('Punk Rhythm', 'tight, bright, scooped a little, no reverb', amp('highgain', 6.5, 2, -1, 4, 5, '412'), hpf(110), gate(-50), { comp: { on: false } }, noDelay, verb(0)),
    P('Pop-Punk Lead', 'high gain with a touch of delay', amp('lead', 7, 0, 3, 3, 4, '412'), hpf(100), delay(0.25, 0.25, 0.18), verb(0.1)),
    P('Metal Rhythm', 'high gain, scooped mids, gated', amp('highgain', 8.5, 3, -4, 4, 6, '412'), hpf(120), gate(-45), noDelay, verb(0)),
    P('Metal Lead', 'saturated, mids up, long delay', amp('lead', 8, 0, 4, 2, 5, '412'), hpf(120), delay(0.375, 0.35, 0.22), verb(0.15)),
    P('Grunge', 'fuzzy, loose low end', amp('fuzz', 7, 4, 0, 1, 1, '412'), hpf(80), noDelay, verb(0.05)),
    P('Garage Fuzz', 'all fuzz, bright, trashy', amp('fuzz', 9, 1, 2, 5, 3, '112'), hpf(100), noDelay, verb(0.1)),
    P('Ska Upstroke', 'clean, scooped lows, snappy comp', amp('clean', 2, -4, 1, 4, 3, '212'), hpf(160), comp(-20, 3, 0.003, 0.08, 3), noDelay, verb(0.1)),
    P('Reggae Skank', 'muted clean with spring-ish verb', amp('clean', 1.5, -2, -1, 1, 0, '212'), hpf(150), comp(-18, 2.5, 0.005, 0.1, 2), delay(0.2, 0.3, 0.1, false), verb(0.3)),
    P('Blues Breakup', 'warm crunch, mids forward', amp('crunch', 5, 2, 3, 0, 1, '112'), hpf(90), { comp: { on: false } }, noDelay, verb(0.12)),
    P('Indie Shimmer', 'clean, dotted-eighth delay, lots of verb', amp('clean', 3, 0, -1, 3, 2, '212'), hpf(100), comp(-22, 2, 0.01, 0.2, 1), delay(0.375, 0.4, 0.3), verb(0.35)),
    P('Post-Rock Swell', 'clean, long delay, drowning verb', amp('clean', 3.5, 1, -2, 2, 1, '212'), hpf(90), delay(0.5, 0.5, 0.4), verb(0.5)),
    P('Country Twang', 'bright clean, fast comp, slapback', amp('clean', 3, -1, 0, 5, 5, '112'), hpf(100), comp(-24, 4, 0.002, 0.08, 4), delay(0.11, 0.15, 0.3, false), verb(0.08)),
    P('Doom', 'fuzz into a huge cab, low and slow', amp('fuzz', 8, 5, -2, -1, 0, '810'), hpf(60), noDelay, verb(0.1)),
    P('Acoustic Mic', 'no amp; tame boom, open top', noAmp, hpf(90), eq(-3, -2, 2, 150, 400, 9000, 1.2), comp(-20, 2.5, 0.01, 0.2, 2), noDelay, verb(0.2)),
  ];

  const bass = [
    P('DI Flat', 'just a high-pass and a gentle comp', noAmp, hpf(35), comp(-20, 3, 0.01, 0.15, 2), noDelay, verb(0)),
    P('Clean Round', 'warm, rounded, mild compression', amp('bass', 3, 2, 0, -2, 0, '115'), hpf(35), comp(-20, 3, 0.015, 0.2, 3), noDelay, verb(0)),
    P('Punk Grit', 'driven, mids forward, cuts through guitars', amp('bassdrive', 5.5, 1, 3, 2, 2, '810'), hpf(40), comp(-18, 4, 0.01, 0.12, 3), noDelay, verb(0)),
    P('Pick Attack', 'bright, clicky, fast comp', amp('bassdrive', 4, 0, 2, 4, 3, '810'), hpf(40), comp(-18, 4, 0.004, 0.1, 3), noDelay, verb(0)),
    P('Fingerstyle Smooth', 'soft top, slow comp', amp('bass', 2.5, 2, 0, -3, -2, '115'), hpf(35), lpf(3500), comp(-22, 2.5, 0.02, 0.25, 2), noDelay, verb(0)),
    P('No Clicks', 'DI with the top rolled off — pick / fret click gone, body stays', noAmp, hpf(35), lpf(2500), comp(-20, 3, 0.012, 0.18, 2), noDelay, verb(0)),
    P('Fuzz Bass', 'big fuzz, keep the lows', amp('fuzz', 7, 4, 0, -2, 0, '810'), hpf(40), comp(-16, 4, 0.01, 0.15, 2), noDelay, verb(0)),
    P('Metal Bass', 'tight, scooped, aggressive', amp('bassdrive', 6, 2, -2, 3, 3, '810'), hpf(45), gate(-50), comp(-16, 5, 0.005, 0.1, 3), noDelay, verb(0)),
    P('Reggae Dub', 'all lows, no top', amp('bass', 3, 4, -3, -6, -4, '115'), hpf(30), comp(-20, 3, 0.02, 0.3, 3), noDelay, verb(0)),
    P('Ska Walking', 'clean, mids forward, snappy', amp('bass', 3, 0, 3, 1, 1, '115'), hpf(40), comp(-20, 3.5, 0.008, 0.12, 3), noDelay, verb(0)),
    P('Synth-ish', 'driven, heavy comp, slight slap', amp('bassdrive', 5, 3, 1, 1, 1, '810'), hpf(35), comp(-14, 6, 0.005, 0.1, 4), delay(0.08, 0.1, 0.12, false), verb(0)),
    P('Upright Vibe', 'dark, soft comp', noAmp, hpf(45), eq(2, -1, -5, 100, 500, 4000), comp(-22, 2.5, 0.02, 0.3, 2), noDelay, verb(0.08)),
    P('Slap', 'scooped mids, bright top, fast comp', amp('bass', 3, 3, -4, 4, 3, '115'), hpf(40), comp(-18, 5, 0.003, 0.1, 3), noDelay, verb(0)),
  ];

  const vocals = [
    P('Dry Tracking', 'just HPF + light comp, no verb — for tracking', noAmp, hpf(90), comp(-20, 3, 0.01, 0.15, 2), noDelay, verb(0)),
    P('Pop-Punk Lead Vox', 'bright, compressed, short verb', noAmp, hpf(110), eq(-2, 1, 3, 150, 2500, 8000, 1), comp(-20, 4, 0.008, 0.12, 4), delay(0.25, 0.2, 0.08), verb(0.18)),
    P('Rock Lead Vox', 'present mids, medium comp', noAmp, hpf(100), eq(-1, 2, 2, 150, 3000, 9000, 1.2), comp(-18, 3.5, 0.01, 0.15, 3), noDelay, verb(0.2)),
    P('Punk Shout', 'aggressive, saturated a little, tight', amp('crunch', 2.5, 0, 2, 3, 2, 'none', -3), hpf(120), comp(-16, 5, 0.005, 0.1, 4), noDelay, verb(0.08)),
    P('Screamo', 'driven and crushed', amp('lead', 4, -1, 3, 3, 3, 'none', -4), hpf(140), comp(-14, 6, 0.003, 0.08, 4), noDelay, verb(0.1)),
    P('Ballad', 'soft comp, long verb, slow delay', noAmp, hpf(90), eq(0, -1, 2, 150, 500, 10000, 1), comp(-22, 2.5, 0.015, 0.25, 2), delay(0.5, 0.3, 0.12), verb(0.35)),
    P('Harmony / Backing', 'thinner, darker, pushed back', noAmp, hpf(160), eq(-3, -2, 0, 200, 1500, 8000, 1), comp(-20, 4, 0.01, 0.15, 3), noDelay, verb(0.3)),
    P('Doubles', 'tight doubling: fast comp, no verb, bit darker', noAmp, hpf(140), eq(-2, 0, -2, 180, 1000, 8000, 1), comp(-18, 5, 0.005, 0.1, 3), noDelay, verb(0.05)),
    P('Gang Vox', 'group shout: wide, roomy', noAmp, hpf(150), eq(-2, 1, 1, 200, 2000, 7000, 1), comp(-16, 4, 0.01, 0.2, 3), delay(0.06, 0.1, 0.2, false), verb(0.4)),
    P('Telephone', 'band-passed lo-fi', noAmp, hpf(600), eq(-12, 4, -12, 400, 1800, 3500, 2), comp(-20, 6, 0.005, 0.1, 6), noDelay, verb(0)),
    P('Whisper / Intimate', 'close, soft, de-boomed', noAmp, hpf(120), eq(-4, 0, 3, 180, 1000, 10000, 1), comp(-26, 3, 0.01, 0.2, 4), noDelay, verb(0.12)),
    P('Big Chorus Vox', 'wide, loud, slap + verb', noAmp, hpf(110), eq(-1, 2, 3, 150, 3000, 9000, 1), comp(-16, 4, 0.006, 0.12, 4), delay(0.125, 0.15, 0.15), verb(0.3)),
    P('Reggae Toast', 'mids forward, spring-ish tail', noAmp, hpf(120), eq(-2, 3, 0, 150, 2000, 8000, 1.5), comp(-18, 3, 0.01, 0.15, 3), delay(0.33, 0.4, 0.15), verb(0.35)),
    P('Spoken / Podcast', 'clear, flat, de-essed-ish', noAmp, hpf(90), eq(0, 1, -2, 150, 2500, 7000, 1), comp(-22, 3, 0.01, 0.2, 3), noDelay, verb(0)),
  ];

  const drums = [
    P('Raw', 'flat', noAmp, hpf(30), { eq: { on: false } }, { comp: { on: false } }, noDelay, verb(0)),
    P('Punk Kit', 'snappy, bright, a little glue', noAmp, hpf(40), eq(2, -2, 3, 80, 400, 8000, 1), comp(-18, 3, 0.01, 0.1, 2), noDelay, verb(0.08)),
    P('Rock Room', 'roomy, mid-forward', noAmp, hpf(35), eq(2, 1, 2, 90, 1500, 7000, 1), comp(-20, 2.5, 0.015, 0.15, 2), noDelay, verb(0.2)),
    P('Metal Tight', 'scooped, bright, fast comp', noAmp, hpf(40), eq(3, -3, 4, 70, 500, 9000, 1.2), comp(-16, 4, 0.005, 0.08, 3), noDelay, verb(0.03)),
    P('Garage Smash', 'crushed, dirty', amp('crunch', 3, 1, 0, 2, 1, 'none', -3), hpf(50), comp(-12, 8, 0.003, 0.08, 4), noDelay, verb(0.15)),
    P('Lo-fi', 'band-passed, soft', noAmp, hpf(90), eq(-4, 2, -6, 120, 1000, 4000, 1), comp(-18, 4, 0.01, 0.15, 3), noDelay, verb(0.1)),
    P('Big Room', 'huge reverb, slow comp', noAmp, hpf(35), eq(2, 0, 2, 80, 1000, 7000, 1), comp(-20, 2, 0.02, 0.25, 2), noDelay, verb(0.45)),
    P('Dry Tight', 'no room, fast comp', noAmp, hpf(40), eq(1, 0, 2, 80, 1000, 8000, 1), comp(-16, 4, 0.004, 0.08, 3), noDelay, verb(0)),
    P('Ska / Reggae', 'light, bright hats, dry', noAmp, hpf(45), eq(0, -1, 3, 90, 600, 9000, 1), comp(-20, 2.5, 0.01, 0.12, 2), noDelay, verb(0.06)),
    P('Electronic', 'sub up, crisp top', noAmp, hpf(25), eq(4, -2, 3, 60, 500, 10000, 1), comp(-14, 4, 0.003, 0.1, 3), noDelay, verb(0.05)),
  ];

  const keys = [
    P('Clean', 'flat, light comp', noAmp, hpf(40), comp(-22, 2.5, 0.01, 0.2, 2), noDelay, verb(0.15)),
    P('Piano Bright', 'open top, little room', noAmp, hpf(45), eq(0, -1, 3, 120, 800, 8000, 1), comp(-22, 2.5, 0.01, 0.2, 2), noDelay, verb(0.2)),
    P('Warm Rhodes', 'dark, mild drive', amp('clean', 2, 2, 0, -3, -2, 'none'), hpf(50), comp(-20, 3, 0.01, 0.2, 2), delay(0.25, 0.2, 0.1), verb(0.25)),
    P('Organ Crunch', 'driven, mids, slap', amp('crunch', 4, 0, 3, 0, 1, '212'), hpf(60), noDelay, verb(0.15)),
    P('Synth Lead', 'bright, delay', noAmp, hpf(80), eq(-2, 1, 3, 150, 2000, 8000, 1), comp(-18, 3, 0.005, 0.1, 3), delay(0.375, 0.35, 0.25), verb(0.2)),
    P('Pad', 'soft, drowned', noAmp, hpf(60), eq(0, -2, 0, 150, 1000, 8000, 1), comp(-24, 2, 0.03, 0.4, 2), delay(0.5, 0.4, 0.2), verb(0.5)),
    P('Synth Bass', 'sub-forward, tight', noAmp, hpf(30), eq(3, 0, -2, 70, 800, 5000, 1), comp(-16, 5, 0.005, 0.1, 3), noDelay, verb(0)),
    P('Pluck', 'short, bright, slapback', noAmp, hpf(100), eq(-2, 0, 3, 150, 1500, 9000, 1), comp(-20, 4, 0.002, 0.08, 3), delay(0.125, 0.2, 0.2), verb(0.15)),
    P('Lo-fi Keys', 'band-passed, wobbly-ish', noAmp, hpf(120), eq(-5, 2, -8, 150, 1000, 3500, 1), comp(-18, 4, 0.01, 0.15, 3), delay(0.3, 0.3, 0.15), verb(0.2)),
    P('Arena Synth', 'huge, bright, long delay', noAmp, hpf(70), eq(1, 0, 3, 100, 1000, 9000, 1), comp(-18, 3, 0.01, 0.15, 3), delay(0.375, 0.45, 0.3), verb(0.4)),
  ];

  const other = [
    P('Flat', 'nothing on', noAmp, { hpf: { on: false } }, { lpf: { on: false } }, { eq: { on: false } }, { comp: { on: false } }, noDelay, verb(0)),
    P('Gentle Clean-up', 'HPF + light comp', noAmp, hpf(80), comp(-22, 2.5, 0.01, 0.2, 2), noDelay, verb(0.1)),
    P('Phone / Lo-fi', 'band-passed', noAmp, hpf(500), eq(-10, 3, -10, 400, 1800, 3500, 2), comp(-20, 5, 0.005, 0.1, 5), noDelay, verb(0)),
    P('Room', 'reverb-heavy', noAmp, hpf(80), comp(-22, 2, 0.02, 0.3, 2), noDelay, verb(0.4)),
    P('Crush', 'drive + heavy comp', amp('crunch', 4, 1, 1, 2, 1, 'none', -3), hpf(80), comp(-14, 8, 0.003, 0.1, 4), noDelay, verb(0.05)),
  ];

  const PRESETS = { guitar, bass, vocals, drums, keys, other };

  // Instruments for MIDI/keys tracks (see synth.js for the actual voices).
  const INSTRUMENTS = [
    { id: 'audio', name: 'Audio (mic / interface)' },
    { id: 'synth:bass', name: 'Synth bass' },
    { id: 'synth:saw', name: 'Saw lead' },
    { id: 'synth:square', name: 'Square lead' },
    { id: 'synth:pad', name: 'Pad' },
    { id: 'synth:keys', name: 'E-piano' },
    { id: 'synth:organ', name: 'Organ' },
    { id: 'synth:pluck', name: 'Pluck' },
    { id: 'synth:cleangtr', name: 'Guitar — clean' },
    { id: 'synth:crunchgtr', name: 'Guitar — crunch' },
    { id: 'synth:distgtr', name: 'Guitar — distorted' },
    { id: 'synth:mutegtr', name: 'Guitar — palm-muted chug' },
    { id: 'synth:acoustic', name: 'Acoustic guitar' },
    { id: 'synth:bassgtr', name: 'Bass guitar (picked)' },
    { id: 'synth:voice', name: 'Guide voice (sings the vowels)' },
    { id: 'drumkit', name: 'Drum machine' },
  ];

  const DRUM_KITS = ['rock', 'punk', 'tight', '808', 'lofi'];
  // 16 steps per bar (sixteenths). 1 = hit, 2 = accent.
  const DRUM_PATTERNS = {
    'Rock 4/4':        { kick: [2,0,0,0, 0,0,1,0, 2,0,0,0, 0,0,1,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0], crash: [2,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0] },
    'Punk':            { kick: [2,0,1,0, 0,0,1,0, 2,0,1,0, 0,0,1,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1], crash: [2,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0] },
    'Punk Double-time':{ kick: [2,0,2,0, 2,0,2,0, 2,0,2,0, 2,0,2,0], snare: [0,0,2,0, 0,0,2,0, 0,0,2,0, 0,0,2,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    'Half-time':       { kick: [2,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0], snare: [0,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0], crash: [2,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0] },
    'Four on the floor':{ kick: [2,0,0,0, 2,0,0,0, 2,0,0,0, 2,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0], ohat: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0] },
    'Ska':             { kick: [2,0,0,0, 2,0,0,0, 2,0,0,0, 2,0,0,0], snare: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0], ohat: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,1,0] },
    'Reggae One-drop': { kick: [0,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,0,0], snare: [0,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,0,0], hat: [1,0,1,1, 1,0,1,1, 1,0,1,1, 1,0,1,1] },
    'Metal Double-kick':{ kick: [2,1,1,1, 1,1,1,1, 2,1,1,1, 1,1,1,1], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0], crash: [2,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0] },
    'Blast':           { kick: [2,0,2,0, 2,0,2,0, 2,0,2,0, 2,0,2,0], snare: [0,2,0,2, 0,2,0,2, 0,2,0,2, 0,2,0,2], hat: [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0] },
    'Shuffle':         { kick: [2,0,0,1, 0,0,2,0, 0,0,0,1, 0,0,2,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,0,1, 1,0,0,1, 1,0,0,1, 1,0,0,1] },
    'Disco':           { kick: [2,0,0,0, 2,0,0,0, 2,0,0,0, 2,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0], ohat: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0] },
    'Hip-hop':         { kick: [2,0,0,0, 0,0,1,0, 0,1,0,0, 0,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,1,0, 1,0,1,1, 1,0,1,0, 1,0,1,0] },
    'Tom Groove':      { kick: [2,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,0,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], tom: [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,1], hat: [] },
    'Ballad':          { kick: [2,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,1,0], snare: [0,0,0,0, 2,0,0,0, 0,0,0,0, 2,0,0,0], hat: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0] },
    'Click only':      { hat: [2,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0] },
    'Empty':           {},
  };

  global.BPPresets = { TYPES, PRESETS, INSTRUMENTS, DRUM_KITS, DRUM_PATTERNS };
})(window);
