// Melody generator: lyrics in, a singable MIDI melody out — in the song's key, over the song's chords, with the
// syllables laid across the bars of the part. Not random: candidates are built from songwriting rules and scored,
// and the best one wins. Pure (renderer: window.BPMelody; node: require). Uses BPMusic for keys/chords.
//
//   syllables(text)              → lines of syllables {text, stress 0|1, wordEnd, word}
//   generate(opts)               → {notes:[{t, d, n, v, l}] (seconds from part start), rhythm, pitches, seed, score, lines}
//     opts: {text|lines, seconds (part length), bpm, timeSig, key, chordAt(sec)→symbol|null, sectionType,
//            voice: 'low'|'mid'|'high', seed, rhythm? (lock), pitches? (lock), density: 'auto'|'sparse'|'busy'}
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./music') : root.BPMusic);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPMelody = api;
})(typeof self !== 'undefined' ? self : this, function (MU) {
  'use strict';

  // ---------- seeded random ----------
  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
  function wpick(r, items) { const tot = items.reduce((s, x) => s + Math.max(0, x.w), 0); let u = r() * tot; for (const x of items) { u -= Math.max(0, x.w); if (u <= 0) return x; } return items[items.length - 1]; }

  // ---------- syllables ----------
  // Small dictionary for words the rules get wrong (or that singers squeeze), counts as sung in pop/rock.
  const DICT = Object.assign(Object.create(null), {
    nineteen: ['nine', 'teen'], ninety: ['nine', 'ty'], seventeen: ['sev', 'en', 'teen'], seventy: ['sev', 'en', 'ty'], ok: ['o', 'kay'], okay: ['o', 'kay'], hundred: ['hun', 'dred'],     someone: ['some', 'one'], anyone: ['an', 'y', 'one'], everybody: ['ev', 'ry', 'bod', 'y'], million: ['mil', 'lion'], billion: ['bil', 'lion'], region: ['re', 'gion'], religion: ['re', 'li', 'gion'], onion: ['on', 'ion'], opinion: ['o', 'pin', 'ion'], union: ['un', 'ion'], companion: ['com', 'pan', 'ion'], champion: ['cham', 'pi', 'on'], quiet: ['qui', 'et'], diamond: ['di', 'mond'], violent: ['vi', 'lent'], radio: ['ra', 'di', 'o'], video: ['vid', 'e', 'o'], idea: ['i', 'de', 'a'], area: ['ar', 'e', 'a'], create: ['cre', 'ate'], poem: ['po', 'em'], being: ['be', 'ing'], seeing: ['see', 'ing'], going: ['go', 'ing'], doing: ['do', 'ing'],
    fire: ['fire'], hire: ['hire'], tire: ['tire'], wire: ['wire'], our: ['our'], hour: ['hour'], flower: ['flow', 'er'], power: ['pow', 'er'], every: ['ev', 'ry'], everything: ['ev', 'ry', 'thing'], everyone: ['ev', 'ry', 'one'], evening: ['eve', 'ning'], different: ['dif', 'frent'], favorite: ['fav', 'rite'], family: ['fam', 'ly'], camera: ['cam', 'ra'],
    beautiful: ['beau', 'ti', 'ful'], people: ['peo', 'ple'], little: ['lit', 'tle'], something: ['some', 'thing'], nothing: ['noth', 'ing'], anything: ['an', 'y', 'thing'], maybe: ['may', 'be'], really: ['real', 'ly'], only: ['on', 'ly'], away: ['a', 'way'], alone: ['a', 'lone'], again: ['a', 'gain'], forever: ['for', 'ev', 'er'], tonight: ['to', 'night'], today: ['to', 'day'], tomorrow: ['to', 'mor', 'row'], yesterday: ['yes', 'ter', 'day'],
    the: ['the'], are: ['are'], were: ['were'], there: ['there'], where: ['where'], here: ['here'], one: ['one'], gone: ['gone'], done: ['done'], some: ['some'], come: ['come'], love: ['love'], live: ['live'], give: ['give'], have: ['have'], more: ['more'], before: ['be', 'fore'], sure: ['sure'], whole: ['whole'], made: ['made'], time: ['time'], life: ['life'], heart: ['heart'], eyes: ['eyes'], lies: ['lies'], tried: ['tried'], died: ['died'], cried: ['cried'], wanted: ['want', 'ed'], waited: ['wait', 'ed'], needed: ['need', 'ed'], ended: ['end', 'ed'], started: ['start', 'ed'],
    i: ['I'], "i'm": ["I'm"], "i've": ["I've"], "i'll": ["I'll"], "you're": ["you're"], "we're": ["we're"], "they're": ["they're"], "can't": ["can't"], "don't": ["don't"], "won't": ["won't"], "didn't": ["did", "n't"], "wouldn't": ["would", "n't"], "couldn't": ["could", "n't"], "shouldn't": ["should", "n't"], "isn't": ["is", "n't"], "wasn't": ["was", "n't"], "doesn't": ["does", "n't"], "haven't": ["have", "n't"],
  });
  // Words that are normally unstressed when sung (function words).
  const WEAK = new Set('a an the and or but of to in on at by for from with as is am are was were be been it its i im me my you your youre we our us they them their he him his she her so if than that this these those do does did can could would should will shall just like up out off all im ive ill id youll youve theyre were'.split(' '));
  // Split one word into syllables (text chunks). Vowel groups with English fixes: silent e, -le, -ed, -es, y as vowel.
  function wordSyllables(raw) {
    const word = String(raw);
    const low = word.toLowerCase().replace(/[^a-z']/g, '');
    if (!low) return [];
    if (/[a-z]-[a-z]/i.test(word)) return word.split('-').filter(Boolean).flatMap((x) => wordSyllables(x));   // "ar-gue" (forced split), "twenty-one"
    if (Object.prototype.hasOwnProperty.call(DICT, low)) { const d = DICT[low]; if (d.join('').toLowerCase().replace(/'/g, '') === low.replace(/'/g, '')) return splitLike(word, d); return d.slice(); }
    const w = low.replace(/'/g, '');
    // vowel groups (y counts as a vowel when not first)
    const groups = []; const re = /[aeiouy]+/g; let m;
    while ((m = re.exec(w))) { if (m.index === 0 && m[0] === 'y' && w.length > 1) continue; groups.push({ i: m.index, s: m[0] }); }
    let n = groups.length;
    if (n > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) n--;                         // silent final e (make, stone) but not "table"
    if (n > 1 && /[^aeiouy]es$/.test(w) && !/(ss|sh|ch|x|z|ce|ge|se)es$/.test(w + 'es') && !/(c|g|s|x|z|sh|ch)es$/.test(w)) n--;   // makes
    if (n > 1 && /ed$/.test(w) && !/[td]ed$/.test(w)) n--;                                     // walked (but wanted)
    if (n > 1 && /[^aeiouy]e(ly|ness|ful|ment|less)$/.test(w)) n--;                             // lonely, careless, movement
    if (/[aeiou]y[aeiou]/.test(w)) n++;                                                        // payer?? rare
    const yv = groups.filter((g) => g.i > 0 && /^[aeiou]?y[aeiou]/.test(g.s)).length; n += yv;                                  // cry-ing, say-ing
    const g0 = groups.find((g) => /^(ia|io|iu|eo)$/.test(g.s)); if (g0 && g0 === groups[0] && !/(tion|sion|cious|tious|ious)$/.test(w)) n++;   // ri-ot, li-on, pi-a-no
    const g1 = groups.find((g) => /^(ua|uo)$/.test(g.s) && !/[qg]/.test(w[g.i - 1] || '')); if (g1) n++;                // du-al, flu-ent — not guard / square
    n = Math.max(1, Math.min(n, groups.length + 1));
    if (n === 1) return [word.replace(/[^\p{L}\p{N}'-]/gu, '') || word];
    // cut the written word into n chunks at consonants between vowel groups (VCV → V-CV, VCCV → VC-CV)
    // a two-vowel group that is really two syllables (ri-ot, li-on) splits in the middle
    for (let k = 0; groups.length < n && k < groups.length; k++) {
      const g = groups[k]; const y = g.i > 0 ? /^([aeiou]?y)([aeiou].*)$/.exec(g.s) : null;
      if (y) { groups.splice(k, 1, { i: g.i, s: y[1] }, { i: g.i + y[1].length, s: y[2] }); continue; }
      if (/^(ia|io|iu|eo|ua|uo)$/.test(g.s) && !/[qg]/.test(w[g.i - 1] || '')) groups.splice(k, 1, { i: g.i, s: g.s[0] }, { i: g.i + 1, s: g.s.slice(1) });
    }
    const cuts = [];
    for (let k = 1; k < groups.length && cuts.length < n - 1; k++) {
      const end = groups[k - 1].i + groups[k - 1].s.length, start = groups[k].i, cons = start - end;
      cuts.push(cons <= 1 ? end : end + Math.floor(cons / 2));
    }
    // suffixes keep their own consonant: sing-ing, scream-ing, want-ed, fast-er (not sin-ging)
    const suf = /[^aeiouy](ing|ed|er|est|ish)$/.exec(w); if (suf && cuts.length) cuts[cuts.length - 1] = w.length - suf[1].length;
    const letters = word.replace(/[^\p{L}\p{N}']/gu, '');
    const out = []; let prev = 0;
    for (const c of cuts) { out.push(letters.slice(prev, c)); prev = c; }
    out.push(letters.slice(prev));
    return out.filter(Boolean);
  }
  function splitLike(word, parts) { const letters = word.replace(/[^\p{L}\p{N}']/gu, ''); const out = []; let at = 0; for (const p of parts) { out.push(letters.slice(at, at + p.length)); at += p.length; } return out; }
  function wordStress(word, nSyl) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (nSyl === 1) return [WEAK.has(w) ? 0 : 1];
    const s = new Array(nSyl).fill(0);
    if (/(tion|sion|cian|ic|ical|ity|ify|ial|ual|ious)$/.test(w)) s[Math.max(0, nSyl - 2)] = 1;
    else if (/(ee|eer|ese|ette|oon|ique|ade)$/.test(w)) s[nSyl - 1] = 1;
    else if (/^(a(?=[^aeiouy][aeiouy])|be|de|re|un|for|to|ex|en|em|im|dis|mis)/.test(w) && nSyl === 2 && !/^(an|ev|en(?=[^aeiouy]{2})|re(?=[^aeiouy]{2})|ex(?=[^aeiouy])|to(?=[^aeiouy]{2}))/.test(w)) s[1] = 1;   // a-WAY, be-FORE, to-NIGHT, for-GET
    else s[0] = 1;
    return s;
  }
  // text → lines of syllables. Blank lines are dropped; "word-word" forces a split, "_" joins words into one syllable.
  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function spell(n) {
    if (n < 20) return ONES[n]; if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
    if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${spell(n % 100)}` : ''}`;
    if (n >= 1100 && n < 10000 && n % 100) return `${spell(Math.floor(n / 100))} ${n % 100 < 10 ? `oh ${ONES[n % 100]}` : spell(n % 100)}`;   // 1985 → nineteen eighty-five
    if (n < 10000) return `${spell(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${spell(n % 1000)}` : ''}`;
    return String(n).split('').map((d) => ONES[+d]).join(' ');
  }
  const sayNumbers = (line) => line.replace(/\d+/g, (d) => spell(Number(d)));
  // Lines keep `.src` = their index among the non-blank text lines, so lyrics/speech line up even when a line has nothing to sing.
  function syllables(text) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.map((line0, src) => {
      const line = sayNumbers(line0);
      const out = [];
      const words = line.replace(/_/g, '\u0000').split(/\s+/).filter(Boolean);
      for (const w0 of words) {
        if (w0.includes('\u0000')) { out.push({ text: w0.replace(/\u0000/g, ' '), stress: 1, wordEnd: true, word: w0.replace(/\u0000/g, ' ') }); continue; }
        const parts = wordSyllables(w0); if (!parts.length) continue;
        const st = wordStress(w0, parts.length);
        parts.forEach((p, i) => out.push({ text: p, stress: st[i], wordEnd: i === parts.length - 1, word: w0 }));
      }
      out.src = src;
      return out;
    }).filter((l) => l.length);
  }

  // ---------- rhythm ----------
  // Lay one line of k syllables into `beats` beats on a grid. Dynamic programming over grid positions: stressed
  // syllables want strong positions, unstressed want weak ones; the last syllable wants room to be held; a little
  // randomness (seeded) makes each roll different. Returns [{b (beat offset), d (beats)}].
  function posWeight(pos, beatsPerBar) {
    const inBar = pos % beatsPerBar, beat = Math.floor(inBar + 1e-9), frac = inBar - beat;
    if (Math.abs(frac) < 1e-6) return beat === 0 ? 4 : (beatsPerBar % 2 === 0 && beat === beatsPerBar / 2) ? 3 : 2;
    if (Math.abs(frac - 0.5) < 1e-6) return 1;
    return 0.4;
  }
  function lineRhythm(syl, beats, beatsPerBar, r, density) {
    const k = syl.length; const breath = beats >= 4 ? 1 : 0.5; const usable = Math.max(0.5, beats - breath);
    // grid: 8ths normally; 16ths when the line is crowded (or "busy"); quarters when roomy and "sparse"
    let grid = 0.5; if (k > usable / 0.5 * 0.8 || density === 'busy') grid = 0.25; if (density === 'sparse' && k <= usable * 0.6) grid = 1;
    if (k > usable / grid) grid = usable / k;   // squeeze: never drop a syllable
    const m = Math.floor(usable / grid + 1e-9); if (m < k) return syl.map((_, i) => ({ b: i * (usable / k), d: usable / k }));
    const pos = Array.from({ length: m }, (_, i) => i * grid);
    const jit = pos.map(() => r() * 0.9);
    // dp[i][j]: best score placing syllable i at grid j
    const NEG = -1e9; const dp = Array.from({ length: k }, () => new Float64Array(m).fill(NEG)); const from = Array.from({ length: k }, () => new Int32Array(m).fill(-1));
    const sc = (i, j) => { const w = posWeight(pos[j], beatsPerBar); const s = syl[i].stress; let v = s ? w * 1.4 : (w >= 3 ? -1.2 : 0.6 - w * 0.2); if (i === 0 && j > 0 && s) v -= 0.3 * j; if (i === 0 && !s && j > 0 && j <= 2) v += 0.5; return v + jit[j]; };
    for (let j = 0; j < m; j++) dp[0][j] = sc(0, j) - (j > m / 3 ? 3 : 0);
    const maxGap = Math.max(2, Math.round(4 / grid));
    for (let i = 1; i < k; i++) for (let j = i; j < m; j++) { let best = NEG, bi = -1; for (let p = Math.max(i - 1, j - maxGap); p < j; p++) { if (dp[i - 1][p] <= NEG) continue; const gap = j - p; let v = dp[i - 1][p] - (gap > 4 / grid ? (gap - 4 / grid) * 0.5 : 0) - (syl[i - 1].wordEnd ? 0 : (gap > 2 ? 0.6 : 0)); if (v > best) { best = v; bi = p; } } if (bi >= 0) { dp[i][j] = best + sc(i, j); from[i][j] = bi; } }
    // last syllable: prefer leaving at least a beat to hold it
    let bj = -1, bv = NEG; for (let j = k - 1; j < m; j++) { const room = usable - pos[j]; const v = dp[k - 1][j] + Math.min(2, room) * 0.8 - (room < grid * 1.5 ? 2 : 0); if (v > bv) { bv = v; bj = j; } }
    const idx = new Array(k); for (let i = k - 1, j = bj; i >= 0; i--) { idx[i] = j; j = from[i][j]; }
    return idx.map((j, i) => { const b = pos[j]; const next = i < k - 1 ? pos[idx[i + 1]] : usable; let d = next - b; d = i < k - 1 ? Math.min(d, Math.max(grid, 1.5)) : Math.min(d, beatsPerBar); return { b, d: Math.max(Math.min(grid * 0.9, next - b), Math.min(d, next - b)) }; });
  }
  // Whole part: lines spread over the bars (2 or 4 bars each when it fits), repeated line shapes reuse their rhythm.
  function rhythm(lines, { seconds, bpm, timeSig, seed = 1, density = 'auto' }) {
    const r = rng(seed ^ 0x9e3779b9);
    const beatsPerBar = (timeSig && timeSig[0]) || 4; const beatSec = 60 / bpm;
    const secs = Number.isFinite(Number(seconds)) && seconds > 0 ? Number(seconds) : 8 * beatsPerBar * beatSec;
    const totalBeats = Math.max(0.5, Math.floor((secs / beatSec) * 4 + 1e-6) / 4);   // never past the end of the part
    const L = lines.length; if (!L) return [];
    // each line gets an equal slot: whole bars when there's room, otherwise a share of a bar (every line is sung)
    const bars = totalBeats / beatsPerBar; const slot = bars >= L ? Math.floor(bars / L) * beatsPerBar : totalBeats / L;
    const out = []; const cache = new Map();
    lines.forEach((syl, li) => {
      const startBeat = li * slot;
      const avail = li === L - 1 ? totalBeats - startBeat : slot;
      const beats = Math.min(avail, 4 * beatsPerBar);   // a phrase spans at most 4 bars; the rest of a long slot is a rest
      const shape = `${syl.length}:${syl.map((s) => s.stress).join('')}:${beats}`;
      let rh = cache.get(shape);
      if (!rh) { rh = lineRhythm(syl, beats, beatsPerBar, r, density); cache.set(shape, rh); }   // same shape → same rhythm: line 3 echoes line 1
      rh.forEach((e, i) => out.push({ line: li, i, beat: startBeat + e.b, dur: e.d, syl: syl[i] }));
    });
    return out;
  }

  // ---------- pitches ----------
  const VOICE = { low: { lo: 45, hi: 62 }, mid: { lo: 52, hi: 69 }, high: { lo: 57, hi: 76 } };
  const CENTER = { verse: 0.35, 'pre-chorus': 0.55, chorus: 0.7, 'post-chorus': 0.7, hook: 0.7, bridge: 0.5, intro: 0.45, outro: 0.4, breakdown: 0.4, drop: 0.7, build: 0.55 };
  function scaleNotes(key, lo, hi) { const sc = MU.scaleOf(key) || MU.scaleOf('C'); const out = []; for (let n = lo; n <= hi; n++) if (sc.pcs.includes(((n % 12) + 12) % 12)) out.push(n); return { notes: out, sc }; }
  const degreeOf = (sc, n) => sc.pcs.indexOf(((n % 12) + 12) % 12) + 1;   // 1..7, 0 if out of key
  // One candidate: a constrained random walk. Strong beats go to chord tones, steps beat leaps, leaps resolve the
  // other way, each line arcs up to a peak ~2/3 in, odd lines end open (2nd/5th), even lines end home (1st/3rd).
  function walk(events, ctx, r) {
    const { scale, sc, chordAt, center, beatSec } = ctx;
    const idxOf = (n) => { let best = 0, bd = 1e9; scale.forEach((x, i) => { const d = Math.abs(x - n); if (d < bd) { bd = d; best = i; } }); return best; };
    const centerIdx = Math.round(center * (scale.length - 1));
    let cur = Math.max(0, Math.min(scale.length - 1, centerIdx + pick(r, [-2, -1, 0, 0, 1])));
    const out = []; let lastLeap = 0;
    for (let e = 0; e < events.length; e++) {
      const ev = events[e]; const lineEvs = events.filter((x) => x.line === ev.line); const pos = ev.i / Math.max(1, lineEvs.length - 1);
      const isLast = ev.i === lineEvs.length - 1; const strong = posWeight(ev.beat, ctx.beatsPerBar) >= 2;
      const chord = MU.chordPcs(chordAt(ev.beat * beatSec)) || [sc.pcs[0], sc.pcs[2], sc.pcs[4]];
      const target = centerIdx + Math.round(Math.sin(Math.PI * Math.min(1, pos / 0.66) * 0.5) * 3 * (pos <= 0.66 ? 1 : (1 - pos) / 0.34));
      const cands = [];
      for (let d = -5; d <= 5; d++) {
        const j = cur + d; if (j < 0 || j >= scale.length) continue;
        const n = scale[j]; const pc = ((n % 12) + 12) % 12; const deg = degreeOf(sc, n);
        let w = [0.8, 4, 1.5, 0.75, 0.4, 0.15][Math.abs(d)] || 0.05;                // steps over leaps
        if (e === 0) w = 1;
        if (lastLeap && Math.abs(d) && Math.sign(d) === Math.sign(lastLeap)) w *= 0.35;   // after a leap, turn around
        if (strong || ev.dur >= 1) w *= chord.includes(pc) ? 2.2 : 0.55;               // chord tones on strong beats / long notes
        if (ev.dur >= 1 && (deg === 4 || deg === 7)) w *= 0.3;                        // no long 4ths / 7ths
        w *= Math.exp(-Math.abs(j - target) * 0.2);                                  // phrase arc
        if (ctx.hook && [1, 2, 3, 5, 6].includes(deg)) w *= 1.3;                      // pentatonic bias for hooks
        if (isLast) { const open = ev.line % 2 === 0 && ev.line !== ctx.lastLine; const want = open ? [2, 5] : [1, 3]; w *= want.includes(deg) ? 4 : (deg === 1 && open) ? 0.6 : 0.25; }
        cands.push({ j, d, w });
      }
      const c = wpick(r, cands.length ? cands : [{ j: cur, d: 0, w: 1 }]);
      lastLeap = Math.abs(c.d) >= 3 ? c.d : 0; cur = c.j; out.push(scale[cur]);
    }
    return out;
  }
  // Rule score of a finished melody (higher = better): stepwise share, chord-tone landings, range, repetition of
  // the opening motif, open/closed cadences, no big leaps in a row, peak placement.
  function score(events, pitches, ctx) {
    if (!pitches.length) return -1e9;
    let s = 0; let steps = 0, leaps = 0, big = 0;
    for (let i = 1; i < pitches.length; i++) { const iv = Math.abs(pitches[i] - pitches[i - 1]); if (events[i].line !== events[i - 1].line) continue; if (iv <= 2) steps++; else if (iv <= 7) leaps++; else big++; }
    const tot = Math.max(1, steps + leaps + big); const stepShare = steps / tot; s += 10 - Math.abs(stepShare - 0.7) * 20 - big * 3;
    const range = Math.max(...pitches) - Math.min(...pitches); s -= Math.max(0, range - 12) * 2; s -= Math.max(0, 5 - range) * 1.5;
    for (let i = 0; i < events.length; i++) { const ch = MU.chordPcs(ctx.chordAt(events[i].beat * ctx.beatSec)); if (!ch) continue; const inC = ch.includes(((pitches[i] % 12) + 12) % 12); if (posWeight(events[i].beat, ctx.beatsPerBar) >= 3) s += inC ? 1.2 : -1.5; }
    const lines = [...new Set(events.map((e) => e.line))];
    for (const l of lines) { const ix = events.map((e, i) => (e.line === l ? i : -1)).filter((i) => i >= 0); const lp = ix.map((i) => pitches[i]); const peak = lp.indexOf(Math.max(...lp)) / Math.max(1, lp.length - 1); s += 2 - Math.abs(peak - 0.6) * 3; const deg = degreeOf(ctx.sc, lp[lp.length - 1]); s += (l % 2 === 0 && l !== ctx.lastLine ? [2, 5] : [1, 3]).includes(deg) ? 2 : -1; }
    // motif: line 3 starts like line 1 (contour)
    if (lines.length >= 3) { const a = events.map((e, i) => (e.line === 0 ? i : -1)).filter((i) => i >= 0).slice(0, 4); const b = events.map((e, i) => (e.line === 2 ? i : -1)).filter((i) => i >= 0).slice(0, 4); let same = 0; for (let i = 1; i < Math.min(a.length, b.length); i++) if (Math.sign(pitches[a[i]] - pitches[a[i - 1]]) === Math.sign(pitches[b[i]] - pitches[b[i - 1]])) same++; s += same; }
    return s;
  }
  // Copy line-1's opening contour onto line 3 (classic A-B-A'-C), keeping notes in key.
  function echoMotif(events, pitches, scale) {
    const a = events.map((e, i) => (e.line === 0 ? i : -1)).filter((i) => i >= 0); const b = events.map((e, i) => (e.line === 2 ? i : -1)).filter((i) => i >= 0);
    const n = Math.min(a.length, b.length, 4); if (n < 2) return pitches;
    const out = pitches.slice(); const idx = (p) => scale.indexOf(p);
    for (let i = 1; i < n; i++) { const step = idx(pitches[a[i]]) - idx(pitches[a[i - 1]]); const j = Math.max(0, Math.min(scale.length - 1, idx(out[b[i - 1]]) + step)); out[b[i]] = scale[j]; }
    return out;
  }

  function generate(opts) {
    const bpm = Number(opts.bpm) || 120, beatSec = 60 / bpm, timeSig = opts.timeSig || [4, 4], beatsPerBar = timeSig[0] || 4;
    const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : (Math.random() * 2 ** 32) >>> 0;
    const lines = opts.lines || syllables(opts.text);
    if (!lines.length) throw new Error('no lyrics to sing — type a line or two');
    const events = opts.rhythm && opts.rhythm.length === lines.reduce((n, l) => n + l.length, 0) ? opts.rhythm.map((e, i) => ({ ...e, syl: lines.flat()[i] })) : rhythm(lines, { seconds: opts.seconds, bpm, timeSig, seed, density: opts.density || 'auto' });
    const v = VOICE[opts.voice] || VOICE.mid; const { notes: scale, sc } = scaleNotes(opts.key || 'C', v.lo, v.hi);
    const ty = String(opts.sectionType || '').toLowerCase();
    const ctx = { lastLine: Math.max(...events.map((e) => e.line)), scale, sc, beatSec, beatsPerBar, chordAt: opts.chordAt || (() => null), center: CENTER[ty] != null ? CENTER[ty] : 0.5, hook: /chorus|hook|drop/.test(ty) };
    let best = null;
    if (opts.pitches && opts.pitches.length === events.length) best = { pitches: opts.pitches.slice(), score: score(events, opts.pitches, ctx) };
    else {
      const r = rng(seed);
      for (let c = 0; c < 40; c++) { let p = walk(events, ctx, r); if (c % 2) p = echoMotif(events, p, scale); const sc2 = score(events, p, ctx); if (!best || sc2 > best.score) best = { pitches: p, score: sc2 }; }
    }
    const notes = events.map((e, i) => { const t = e.beat * beatSec; const next = i < events.length - 1 ? events[i + 1].beat * beatSec : Infinity; return { t, d: Math.max(0.02, Math.min(next - t - 0.005, Math.max(0.06, e.dur * beatSec * 0.92))), n: best.pitches[i], v: e.syl.stress ? 0.85 : 0.7, l: e.syl.text }; });
    return { notes, rhythm: events.map((e) => ({ line: e.line, i: e.i, beat: e.beat, dur: e.dur })), pitches: best.pitches, seed, score: best.score, lines, lineSrc: lines.map((l, i) => (l.src != null ? l.src : i)) };
  }

  // Vowel a syllable is sung on (for the guide voice): a e i o u
  function vowelOf(syl) {
    const s = String(syl || '').toLowerCase();
    if (/ay$|ai|a(?=[^aeiou]e$)/.test(s)) return 'a';
    if (/ee|ea|ie|ey$|y$|i(?=[^aeiou]e)|ei/.test(s)) return 'i';
    if (/oo|ou|ew|ue|u(?![aeiou])/.test(s) && !/our|ought/.test(s)) return 'u';
    if (/o/.test(s)) return 'o';
    if (/a/.test(s)) return 'a';
    if (/i/.test(s)) return 'a';   // "I", "night" → ah-ee; ah is the singable part
    if (/e/.test(s)) return 'e';
    return 'a';
  }

  return { spell, syllables, wordSyllables, wordStress, rhythm, generate, vowelOf, rng, score, posWeight };
});
