/* Cobander free web tools: shared music helpers + the four tools. Plain browser JS, no libraries.
   Each tool runs only if its root element is on the page. Copied to docs/tools.js by gen-seo-pages.py. */
(function () {
  'use strict';
  var SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  var PC = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, 'E#': 5, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
  var mod = function (n) { return ((n % 12) + 12) % 12; };
  // a chord token: root, quality/extensions, optional slash bass. Strict so lyric words don't match ("A" alone does).
  var CHORD = /^([A-G](?:#|b)?)((?:maj|min|m|M|dim|aug|sus|add|\+|°|ø|\d|\(|\)|b|#|-)*)(?:\/([A-G](?:#|b)?))?$/;
  function parseChord(tok) {
    var m = CHORD.exec(tok); if (!m || PC[m[1]] == null || (m[3] && PC[m[3]] == null)) return null;
    var q = m[2] || '';
    var quality = /^(dim|°)/.test(q) || /m7b5|ø/.test(q) ? 'dim' : /^(m(?!aj)|min|-)/.test(q) ? 'm' : /^5$/.test(q) ? '5' : /^sus/.test(q) ? 'sus' : /^(aug|\+)/.test(q) ? 'aug' : '';
    return { root: PC[m[1]], suffix: q, bass: m[3] ? PC[m[3]] : null, quality: quality };
  }
  function spell(pc, flats) { return (flats ? FLAT : SHARP)[mod(pc)]; }
  function chordText(c, semis, flats) { return spell(c.root + semis, flats) + c.suffix + (c.bass != null ? '/' + spell(c.bass + semis, flats) : ''); }
  // ---- key finding from chords ----
  var MAJ = { 0: '', 2: 'm', 4: 'm', 5: '', 7: '', 9: 'm', 11: 'dim' };
  var MIN = { 0: 'm', 2: 'dim', 3: '', 5: 'm', 7: 'm', 8: '', 10: '' };
  function keyScores(chords) {
    var out = [];
    for (var t = 0; t < 12; t++) for (var minor = 0; minor < 2; minor++) {
      var sc = minor ? MIN : MAJ, s = 0;
      chords.forEach(function (c, i) {
        var d = mod(c.root - t), want = sc[d];
        if (minor && d === 7 && c.quality === '') want = '';            /* harmonic-minor V */
        if (minor && d === 11 && c.quality === 'dim') want = 'dim';     /* leading-tone diminished */
        if (want == null) { s -= 1; return; }
        var ok = c.quality === want || c.quality === '5' || c.quality === 'sus' || false;
        s += ok ? 1 : 0.4;
        if (d === 0 && ok) { if (i === 0) s += 1.5; if (i === chords.length - 1) s += 1; }
      });
      out.push({ tonic: t, minor: !!minor, score: s / Math.max(1, chords.length) });
    }
    return out.sort(function (a, b) { return b.score - a.score; });
  }
  var flatKey = function (tonic, minor) { var maj = minor ? mod(tonic + 3) : tonic; return [5, 10, 3, 8, 1].indexOf(maj) >= 0; };
  var keyName = function (k) { return spell(k.tonic, flatKey(k.tonic, k.minor)) + (k.minor ? ' minor' : ' major'); };
  var ROM_MAJ = ['I', 'bII', 'II', 'bIII', 'III', 'IV', '#IV', 'V', 'bVI', 'VI', 'bVII', 'VII'];
  var ROM_MIN = ['I', 'bII', 'II', 'III', '#III', 'IV', '#IV', 'V', 'VI', '#VI', 'VII', '#VII'];
  function roman(c, k) {
    var r = (k.minor ? ROM_MIN : ROM_MAJ)[mod(c.root - k.tonic)];
    var dq = (k.minor ? MIN : MAJ)[mod(c.root - k.tonic)];
    var low = c.quality === 'm' || c.quality === 'dim' || ((c.quality === '5' || c.quality === 'sus') && (dq === 'm' || dq === 'dim'));
    if (low) r = r.replace(/[IV]+/, function (x) { return x.toLowerCase(); });
    return r + (c.quality === 'dim' ? '°' : c.quality === 'aug' ? '+' : c.quality === '5' ? '5' : '');
  }
  function chordsIn(text) {
    var out = []; text.split(/\n/).forEach(function (line) { var info = chordLine(line); if (info) info.forEach(function (x) { if (x.c) out.push(x.c); }); });
    return out;
  }
  // a line counts as a chord line when most of its tokens are chords (so lyrics underneath are left alone)
  function chordLine(line) {
    var toks = [], re = /\S+/g, m;
    while ((m = re.exec(line))) toks.push({ s: m.index, t: m[0], c: parseChord(m[0].replace(/[|,]$/, '')) });
    var words = toks.filter(function (x) { return !/^[|:\-x0-9.%]+$/.test(x.t); });
    if (!words.length) return null;
    var n = words.filter(function (x) { return x.c; }).length;
    return n / words.length >= 0.6 ? toks : null;
  }
  function transposeText(text, semis, flats) {
    return text.split(/\n/).map(function (line) {
      var toks = chordLine(line); if (!toks) return line;
      var out = '', cur = 0;
      toks.forEach(function (x, i) {
        var tail = /[|,]$/.test(x.t) && x.c ? x.t.slice(-1) : '';
        var nt = x.c ? chordText(x.c, semis, flats) + tail : x.t;
        var at = Math.max(x.s, i ? cur + 1 : 0);
        while (out.length < at) out += ' ';
        out += nt; cur = out.length;
      });
      return out;
    }).join('\n');
  }
  window.CobTools = { parseChord: parseChord, transposeText: transposeText, keyScores: keyScores, keyName: keyName, roman: roman, chordsIn: chordsIn, spell: spell, flatKey: flatKey, PC: PC };
  if (typeof document === 'undefined') return;
  var $ = function (id) { return document.getElementById(id); };
  var keyOpts = function (sel, minorToo) { SHARP.forEach(function (_, i) { var o = document.createElement('option'); o.value = i; o.textContent = i === 1 || i === 3 || i === 6 || i === 8 || i === 10 ? SHARP[i] + '/' + FLAT[i] : SHARP[i]; sel.appendChild(o); }); };

  // ---- transposer + capo ----
  if ($('tr-in')) {
    var semis = 0;
    var detected = function () { var cs = chordsIn($('tr-in').value); return cs.length ? keyScores(cs)[0] : null; };
    var run = function () {
      var k = detected(); var mode = $('tr-spell').value;
      var flats = mode === 'flats' ? true : mode === 'sharps' ? false : k ? flatKey(k.tonic + semis, k.minor) : false;
      $('tr-out').value = transposeText($('tr-in').value, semis, flats);
      $('tr-n').textContent = (semis > 0 ? '+' : '') + semis;
      $('tr-key').textContent = k ? keyName(k) + ' → ' + keyName({ tonic: mod(k.tonic + semis), minor: k.minor }) : '—';
    };
    $('tr-up').onclick = function () { semis = Math.min(11, semis + 1); run(); };
    $('tr-down').onclick = function () { semis = semis <= -11 ? -11 : semis - 1; run(); };
    $('tr-reset').onclick = function () { semis = 0; run(); };
    $('tr-in').oninput = run; $('tr-spell').onchange = run;
    $('tr-copy').onclick = function () { try { navigator.clipboard.writeText($('tr-out').value); $('tr-copy').textContent = 'Copied'; setTimeout(function () { $('tr-copy').textContent = 'Copy'; }, 1200); } catch (e) {} };
    run();
    keyOpts($('capo-key'));
    var capoRun = function () {
      var t = +$('capo-key').value, minor = $('capo-mode').value === 'm';
      var shapes = minor ? [['Am', 9], ['Em', 4], ['Dm', 2]] : [['C', 0], ['G', 7], ['D', 2], ['A', 9], ['E', 4]];
      var rows = shapes.map(function (s) { return { shape: s[0], fret: mod(t - s[1]) }; }).filter(function (r) { return r.fret <= 7; }).sort(function (a, b) { return a.fret - b.fret; });
      $('capo-out').innerHTML = rows.map(function (r) { return '<li><b>' + (r.fret === 0 ? 'No capo' : 'Capo ' + r.fret) + '</b> — play ' + r.shape + (minor ? '' : ' major') + ' shapes</li>'; }).join('');
    };
    $('capo-key').onchange = capoRun; $('capo-mode').onchange = capoRun; capoRun();
  }

  // ---- key finder ----
  if ($('kf-in')) {
    var kf = function () {
      var cs = chordsIn($('kf-in').value);
      if (!cs.length) { $('kf-out').innerHTML = '<p class="fine">Type some chords, like <code>G D Em C</code>.</p>'; return; }
      var ks = keyScores(cs), best = ks[0], alt = ks[1];
      var flats = flatKey(best.tonic, best.minor);
      var html = '<p class="big">' + keyName(best) + '</p>';
      html += '<p>' + cs.map(function (c) { return '<span class="chip">' + chordText(c, 0, flats) + ' <i>' + roman(c, best) + '</i></span>'; }).join(' ') + '</p>';
      if (alt && best.score - alt.score < 0.15) html += '<p class="fine">Could also be ' + keyName(alt) + ' — the chords fit both. The chord the song starts and ends on usually decides it.</p>';
      var out = cs.filter(function (c) { var d = mod(c.root - best.tonic); return (best.minor ? MIN : MAJ)[d] == null && !(best.minor && (d === 7 || d === 11)); });
      if (out.length) html += '<p class="fine">Borrowed from outside the key: ' + out.map(function (c) { return chordText(c, 0, flats); }).join(', ') + '.</p>';
      $('kf-out').innerHTML = html;
    };
    $('kf-in').oninput = kf; kf();
  }

  // ---- tap tempo ----
  if ($('tt-tap')) {
    var taps = [];
    var show = function (bpm) {
      $('tt-bpm').textContent = bpm ? Math.round(bpm) : '—';
      $('tt-exact').textContent = bpm ? bpm.toFixed(1) + ' BPM · half time ' + (bpm / 2).toFixed(1) + ' · double time ' + (bpm * 2).toFixed(1) : 'Tap at least twice';
      var q = bpm ? 60000 / bpm : 0, f = function (ms) { return bpm ? Math.round(ms) + ' ms' : '—'; };
      $('tt-ms').innerHTML = [['Whole note', q * 4], ['Half note', q * 2], ['Quarter note (one beat)', q], ['Dotted eighth', q * 0.75], ['Eighth note', q / 2], ['Eighth-note triplet', q / 3], ['Sixteenth note', q / 4], ['One bar of 4/4', q * 4]]
        .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + f(r[1]) + '</td></tr>'; }).join('');
    };
    var tap = function () {
      var now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
      taps.push(now); if (taps.length > 9) taps.shift();
      $('tt-tap').classList.remove('hit'); void $('tt-tap').offsetWidth; $('tt-tap').classList.add('hit');
      if (taps.length < 2) { show(0); $('tt-exact').textContent = 'Keep tapping…'; return; }
      show(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
    };
    $('tt-tap').onclick = tap;
    document.addEventListener('keydown', function (e) { if ((e.code === 'Space' || e.key === 't') && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { e.preventDefault(); tap(); } });
    $('tt-reset').onclick = function () { taps = []; show(0); };
    $('tt-set').oninput = function () { var v = +$('tt-set').value; if (v >= 20 && v <= 400) { taps = []; show(v); } };
    show(0);
  }

  // ---- song structure builder ----
  if ($('sb-list')) {
    var TPL = {
      'Verse–chorus (pop / rock)': [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Chorus', 8], ['Outro', 4]],
      'Verse–chorus (short)': [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Bridge', 8], ['Chorus', 8], ['Outro', 4]],
      'Fast punk': [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Verse', 8], ['Chorus', 8], ['Breakdown', 8], ['Chorus', 8], ['Chorus', 8]],
      'AABA (32-bar)': [['A', 8], ['A', 8], ['B', 8], ['A', 8], ['Solo (AABA)', 32], ['B', 8], ['A', 8]],
      '12-bar blues': [['Intro', 4], ['Verse', 12], ['Verse', 12], ['Solo', 12], ['Verse', 12], ['Outro', 4]],
      'Verses only (folk)': [['Intro', 4], ['Verse', 16], ['Verse', 16], ['Instrumental', 8], ['Verse', 16], ['Outro', 4]]
    };
    var COL = { Intro: '#5b8def', Verse: '#3fb27f', 'Pre-chorus': '#a6c83a', Chorus: '#f2b534', Bridge: '#d8392b', Breakdown: '#b04fd1', Solo: '#e07a2f', Outro: '#5b8def' };
    var col = function (n) { for (var k in COL) if (n.indexOf(k) === 0) return COL[k]; return '#8a90a0'; };
    var secs = TPL['Verse–chorus (pop / rock)'].map(function (x) { return { n: x[0], b: x[1] }; });
    var tsel = $('sb-tpl'); Object.keys(TPL).forEach(function (k) { var o = document.createElement('option'); o.textContent = k; tsel.appendChild(o); });
    var mmss = function (s) { s = Math.round(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
    var draw = function () {
      var bpm = Math.max(30, Math.min(300, +$('sb-bpm').value || 120)), bpb = Math.max(1, Math.min(12, +$('sb-bpb').value || 4));
      var bar = 60 / bpm * bpb, t = 0, total = secs.reduce(function (n, s) { return n + s.b; }, 0);
      $('sb-list').innerHTML = secs.map(function (s, i) {
        var row = '<li><span class="sw" style="background:' + col(s.n) + '"></span><input aria-label="Section name" value="' + s.n.replace(/"/g, '&quot;') + '" data-i="' + i + '" data-f="n">' +
          '<input aria-label="Bars" type="number" min="1" max="128" value="' + s.b + '" data-i="' + i + '" data-f="b"> bars <span class="at">' + mmss(t) + '</span>' +
          '<button type="button" data-i="' + i + '" data-a="up" aria-label="Move up">↑</button><button type="button" data-i="' + i + '" data-a="down" aria-label="Move down">↓</button><button type="button" data-i="' + i + '" data-a="del" aria-label="Remove">✕</button></li>';
        t += s.b * bar; return row;
      }).join('');
      $('sb-strip').innerHTML = secs.map(function (s) { return '<span title="' + s.n + ' · ' + s.b + ' bars" style="flex:' + s.b + ';background:' + col(s.n) + '">' + (s.b >= 6 ? s.n : '') + '</span>'; }).join('');
      $('sb-sum').textContent = total + ' bars · ' + mmss(total * bar) + ' at ' + bpm + ' BPM';
      var tt = 0; $('sb-text').value = secs.map(function (s) { var line = mmss(tt) + '  ' + s.n + ' (' + s.b + ' bars)'; tt += s.b * bar; return line; }).join('\n');
    };
    $('sb-list').oninput = function (e) { var i = +e.target.dataset.i, f = e.target.dataset.f; if (f === 'n') secs[i].n = e.target.value; else secs[i].b = Math.max(1, Math.min(128, +e.target.value || 1)); var keep = document.activeElement; var pos = keep && keep.selectionStart; drawKeepFocus(i, f, pos); };
    var drawKeepFocus = function (i, f, pos) { draw(); var el = $('sb-list').querySelector('[data-i="' + i + '"][data-f="' + f + '"]'); if (el) { el.focus(); try { if (f === 'n') el.setSelectionRange(pos, pos); } catch (e) {} } };
    $('sb-list').onclick = function (e) { var a = e.target.dataset.a, i = +e.target.dataset.i; if (!a) return; if (a === 'del') secs.splice(i, 1); if (a === 'up' && i > 0) secs.splice(i - 1, 0, secs.splice(i, 1)[0]); if (a === 'down' && i < secs.length - 1) secs.splice(i + 1, 0, secs.splice(i, 1)[0]); draw(); };
    $('sb-add').onclick = function () { secs.push({ n: $('sb-new').value, b: /Chorus|Verse|Bridge/.test($('sb-new').value) ? 8 : 4 }); draw(); };
    tsel.onchange = function () { secs = TPL[tsel.value].map(function (x) { return { n: x[0], b: x[1] }; }); draw(); };
    $('sb-bpm').oninput = draw; $('sb-bpb').oninput = draw;
    $('sb-copy').onclick = function () { try { navigator.clipboard.writeText($('sb-text').value); $('sb-copy').textContent = 'Copied'; setTimeout(function () { $('sb-copy').textContent = 'Copy'; }, 1200); } catch (e) {} };
    draw();
  }
})();
