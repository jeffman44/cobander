#!/usr/bin/env python3
"""Generate Cobander's search landing pages, 404 page, sitemap.xml and robots.txt into docs/,
resized WebP copies of the site JPGs, and the SEO head block + Guides line on the manual pages.

Run from the repo root:  python3 -I scripts/gen-seo-pages.py docs
Re-run it after scripts/gen-manual.py, which rewrites docs/manual/ without these tags.
"""
import html, json, os, re, sys, datetime

DOCS = sys.argv[1]
SITE = 'https://cobander.com'
TODAY = datetime.date.today().isoformat()
OG_IMAGE = f'{SITE}/img/og.jpg'

# --- images: resized WebP next to each JPG (og.jpg stays JPG only; band-scene-m.jpg is unused) ---
WEBP_WIDTHS = (640, 960, 1280)
WEBP_SKIP = {'og.jpg', 'band-scene-m.jpg'}
_IMG_SIZES = {}

def img_size(name):
    if name not in _IMG_SIZES:
        from PIL import Image
        with Image.open(os.path.join(DOCS, 'img', name)) as im:
            _IMG_SIZES[name] = im.size
    return _IMG_SIZES[name]

def webp_widths(name):
    w, _ = img_size(name)
    return sorted({min(x, w) for x in WEBP_WIDTHS})

def make_webps():
    from PIL import Image
    made = 0
    for name in sorted(os.listdir(os.path.join(DOCS, 'img'))):
        if not name.endswith('.jpg') or name in WEBP_SKIP:
            continue
        src = os.path.join(DOCS, 'img', name)
        for w in webp_widths(name):
            dst = os.path.join(DOCS, 'img', f'{name[:-4]}-{w}.webp')
            if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
                continue
            with Image.open(src) as im:
                im = im.convert('RGB')
                if im.width != w:
                    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
                im.save(dst, 'WEBP', quality=80, method=6)
            made += 1
    return made

def picture(prefix, name, alt, sizes, hero=False, cls=''):
    """<picture> with resized WebP sources and the original JPG as fallback.
    hero=True: eager + fetchpriority=high; otherwise lazy. Always async decode + real width/height."""
    w, h = img_size(name)
    srcset = ', '.join(f'{prefix}img/{name[:-4]}-{x}.webp {x}w' for x in webp_widths(name))
    load = 'fetchpriority="high"' if hero else 'loading="lazy"'
    c = f' class="{cls}"' if cls else ''
    return (f'<picture><source type="image/webp" srcset="{srcset}" sizes="{sizes}">'
            f'<img{c} src="{prefix}img/{name}" alt="{esc(alt)}" width="{w}" height="{h}" {load} decoding="async"></picture>')

PAGES = [
    {
        'slug': 'band-songwriting-app',
        'title': 'Write Songs With Your Band Remotely — Cobander',
        'nav': 'Write songs remotely',
        'desc': 'Cobander lets your band write and record songs together from different houses. Riffs, takes, chords and lyrics sync through the Google Drive, OneDrive, iCloud or Dropbox folder you already share. Free to try.',
        'h1': 'Write songs with your band, from four different houses',
        'lead': 'Somebody records a riff at 11 pm. By 11:01 it is on everyone else\'s screen, on its own track, in the right spot in the song. No uploads, no accounts, no monthly plan — the cloud folder your band already shares is the whole system.',
        'img': ('write.jpg', 'Cobander\'s Write workspace: song parts, a chord lane and lyrics pinned to the timeline'),
        'sections': [
            ('One song, the whole band, no file juggling', [
                'Every song lives in your band\'s shared folder. When the drummer adds a take at lunch, it lands on its own track for everyone, lined up with the rest of the song. Nobody emails a bounce called "chorus idea FINAL v3".',
                'Two people can work on the same song at once. Song and track locks keep you from stepping on each other, and whatever you change is merged in, not overwritten.',
            ]),
            ('Built for writing, not just recording', [
                'Lay out the parts — intro, verse, chorus, bridge — and drag them around. Put chords on a chord lane, pin lyrics to where they are sung, drop notes on the timeline ("try a half-time feel here"), and @mention whoever needs to see it.',
                'A parts bin keeps the riffs that don\'t have a song yet, and your own noodle pad is there for messing around without touching the band\'s songs.',
            ]),
            ('Know where every song stands', [
                'Each part gets a stage, from idea to approved, and anyone can flag a part for a redo with a short note. The song list shows how many parts are done, and the band feed shows who did what while you were at work.',
            ]),
            ('Works with what you already have', [
                'Point Cobander at a folder in Google Drive, OneDrive, iCloud Drive or Dropbox — every bandmate picks the same one. Windows and Mac work together. Your songs never go anywhere but that folder.',
            ]),
        ],
        'faq': [
            ('Do we all need the same computer?', 'No. One person on a Mac and three on Windows works fine — everything is files in the shared folder.'),
            ('Do we need to be online at the same time?', 'No. Work whenever you want; the folder syncs your changes to everyone else when they open Cobander.'),
            ('Is there a server or an account?', 'No. There is no Cobander server and no account. The cloud folder your band shares does the syncing.'),
        ],
    },
    {
        'slug': 'free-daw-for-bands',
        'title': 'A Free DAW Built for Bands — Cobander',
        'nav': 'Free DAW for bands',
        'desc': 'Cobander is a free recording app made for bands, not solo producers: multitrack recording, punch-ins, comping, mixing and practice, shared through your band\'s cloud folder. Windows and Mac.',
        'h1': 'A free DAW made for a band, not a solo producer',
        'lead': 'Most recording software assumes one person at one computer. Cobander assumes four people, four computers, and a shared folder. Record, mix and practice your own songs together — free to download, every feature included.',
        'img': ('mix.jpg', 'Cobander\'s Mix workspace: the song timeline with a console of faders below and Track FX on the right'),
        'sections': [
            ('Record', [
                'Arm a track and hit R. Takes are lossless. Punch in to fix one bar, keep several takes and comp the best bits, and use the built-in tuner and drum machine. MIDI guitar, bass and keys let you sketch a part without a mic.',
            ]),
            ('Mix', [
                'Faders, pan, sends, EQ and compression on a real mixing console. Auto mix gets a rough balance in one click and Auto master brings it to a normal loudness. Tighten a sloppy take to the grid, check vocal pitch, read a timing report, bounce stems — and when a song outgrows Cobander, hand the whole session off to a studio DAW with markers.',
            ]),
            ('Practice', [
                'Big lyrics and chords that follow the song, loops, slow-down without changing pitch, and a mode that takes your own part out so you can play along with the band.',
            ]),
            ('What "free" means', [
                'The free version is the whole app — every feature and every update — with one song per band folder. A one-time license unlocks unlimited songs for the whole band. No subscription, no per-seat pricing, no ads.',
            ]),
        ],
        'faq': [
            ('Is it a real DAW?', 'It records real takes, mixes with real EQ and compression, bounces stems, and exports to a studio DAW when you need one. It is built for getting songs down fast with a band, not for producing an album.'),
            ('Windows or Mac?', 'Both, and they work together in the same band.'),
            ('Does it need an internet connection?', 'Only for your cloud folder to sync. Speech-to-text, chord detection and pitch check all run on your own computer.'),
        ],
    },
    {
        'slug': 'lyrics-from-vocal-recording',
        'title': 'Transcribe Lyrics From Your Vocal Recording — Cobander',
        'nav': 'Lyrics from a vocal take',
        'desc': 'Sing the take and Cobander types out the lyrics and pins each word to when you sang it — on your own computer. Your band gets a lyric sheet, a karaoke view and a chart from one vocal take.',
        'h1': 'Sing it once. The lyrics write themselves down.',
        'lead': 'Record a vocal take and Cobander listens, types the words, and pins each one to the moment you sang it. The lyric sheet, the karaoke-style practice view and the chord chart all exist before anyone opens a notes app.',
        'img': ('practice.jpg', 'Practice: lyrics flying toward you in 3D over the song'),
        'sections': [
            ('Speech-to-text that stays on your computer', [
                'Transcription runs locally — nothing is uploaded to a transcription service. It gets the words down; you clean up anything it misheard in the lyric editor.',
            ]),
            ('Every word lands where it is sung', [
                'Each word carries its time in the song. If the timing drifts, Tighten timing snaps the words back to the vocal.',
            ]),
            ('Practice with the words in front of you', [
                'In Practice, the lyrics fly toward you and hit the line when it is time to sing them, with the chords above. Loop the line you keep blowing, or slow the song down without changing the pitch.',
            ]),
            ('Already have lyrics?', [
                'Cobander warns you before it replaces lyrics someone already typed, so a transcription never quietly wipes out a finished verse.',
            ]),
        ],
        'faq': [
            ('Does it upload my vocals?', 'No. Speech-to-text runs on your own computer.'),
            ('Do I have to sing clearly?', 'Clearer takes transcribe better. Anything it mishears, you fix in the lyric editor.'),
            ('Can bandmates see the lyrics?', 'Yes. The words are saved in the song, in the band\'s shared folder, for everyone.'),
        ],
    },
    {
        'slug': 'band-practice-app',
        'title': 'Practice Your Band\'s Own Songs — Cobander',
        'nav': 'Practice your songs',
        'desc': 'Practice your band\'s own songs at home: lyrics and chords that follow the song, loops, slow-down without pitch change, a note highway, and play-along with your own part taken out.',
        'h1': 'Practice your own songs, not someone else\'s',
        'lead': 'Practice apps are built around famous songs. Cobander is built around yours — the ones your band recorded last week. Lyrics, chords and tab follow the song, and your own part comes out so you can play along with the band.',
        'img': ('practice.jpg', 'Practice: lyrics flying toward you in 3D over the song'),
        'sections': [
            ('Everything follows the song', [
                'Big lyrics and chords scroll with the recording. Words fly at you and land on the line when it is time to sing them, with a classic karaoke view if you prefer it. Guitar and bass players get a scrolling tab or note highway.',
            ]),
            ('Work on the hard part', [
                'Loop the bars you keep missing. Slow the song down without changing pitch, then bring it back up. Take your own part out and play along with the rest of the band.',
            ]),
            ('On stage and on your phone', [
                'Show mode runs the set with a foot pedal, and your phone can follow along as a lyric and chord screen.',
            ]),
            ('The band sees who is putting in the time', [
                'Practice minutes count on the Band page, along with levels, achievements and a countdown to the next show, so "did anyone learn the bridge?" has an answer.',
            ]),
        ],
        'faq': [
            ('Do we need to record the song first?', 'Practice works on whatever the song has: a rough demo with a guide vocal is enough to start.'),
            ('Can I practice offline?', 'Yes. Songs live in your synced folder on your own computer.'),
        ],
    },
    {
        'slug': 'find-the-key-of-a-song',
        'title': 'Find the Key of Your Song From the Recording — Cobander',
        'nav': 'Find your song\'s key',
        'desc': 'Cobander listens to your band\'s takes and tells you what key the song is in — then moves the whole song, recordings included, to a key that fits your singer. Runs on your own computer.',
        'h1': 'What key is this song in? Cobander listens and tells you.',
        'lead': 'Nobody wrote the key down, the bass player swears it\'s G, and the singer is straining on the chorus. Cobander hears the key from the recordings, shows it on the song, and can move the whole song to a better one.',
        'img': ('write.jpg', 'Cobander\'s Write workspace: song parts, a chord lane and lyrics pinned to the timeline'),
        'sections': [
            ('Hear the key from the takes', [
                'After the first takes land, Cobander listens to the recordings and the chords and names the key. If it isn\'t sure, it says so instead of guessing — and it offers the relative major or minor when the song could be either.',
                'Songs that change key get a key per section, so the bridge that lifts a step up is labelled as its own key.',
            ]),
            ('Move the song to a key that fits', [
                'Transpose the song up or down by half steps. The recordings are re-tuned, MIDI parts and chords move with them, and the drums stay put. Change one section only, or relabel a key that was named wrong without moving anything.',
                'Only keys you can actually reach by shifting the pitch are offered, so you never end up with a song labelled one thing and sounding like another.',
            ]),
            ('Know when a part is out of key', [
                'A warning chip shows up when a part doesn\'t sit in the song\'s key — handy when someone recorded their riff in E and the rest of the band is in F.',
            ]),
        ],
        'faq': [
            ('Does it work on a rough demo?', 'Yes. A guitar and a guide vocal are enough for it to hear the key.'),
            ('Does transposing hurt the sound?', 'Small moves of a step or two sound natural. Big jumps change the character of a voice or a guitar, the same as any pitch shifter.'),
            ('Is the audio sent anywhere?', 'No. Key detection and transposing run on your own computer.'),
        ],
    },
    {
        'slug': 'chords-from-a-recording',
        'title': 'Get the Chords From Your Own Recording — Cobander',
        'nav': 'Chords from a recording',
        'desc': 'Record the guitar, keys or bass and Cobander drafts the chords onto the song\'s chord lane, bar by bar, from the notes actually played. Edit, transpose and print the chart for the band.',
        'h1': 'Play it once. Get the chord chart.',
        'lead': 'The guitarist knows the song with his hands, not on paper. Cobander listens to the guitar, keys and bass takes, works out the notes that were played, and drafts the chords onto the song so everyone can read them.',
        'img': ('write.jpg', 'Cobander\'s Write workspace with a chord lane running above the song'),
        'sections': [
            ('Chords from the notes, not a guess', [
                'Cobander reads each guitar, keys and bass track note by note with a small note-tracking model on your computer, then names the chord in each half bar from what was played together. The bass note decides slash chords like G/B.',
                'It is a draft: wrong chords are one right-click away from fixed, and it asks before replacing chords someone already typed.',
            ]),
            ('One chart for the whole band', [
                'The chord lane runs above the timeline and the chord chart shows every section with its chords and lyrics. Transpose the chart for a capo or a different key without touching the recording.',
            ]),
            ('Chords that follow you in Practice', [
                'In Practice the chords scroll with the song above the lyrics, so the new guy can play along on day one.',
            ]),
        ],
        'faq': [
            ('Does it work on distorted guitar?', 'Power chords and crunchy rhythm parts work. Heavy fuzz, lots of reverb or two guitars on one track make it harder; check the draft by ear.'),
            ('Can it read a part I play live into the mic?', 'Yes. Any audio take on a guitar, keys or bass track can be read.'),
            ('Does it need an internet connection?', 'No. It runs on your own computer.'),
        ],
    },
    {
        'slug': 'song-structure-planner',
        'title': 'Plan Your Song\'s Structure With the Band — Cobander',
        'nav': 'Song structure planner',
        'desc': 'Start a song from a style and a structure, lay out verses, choruses and bridges on the timeline, drag them around, and get a drum part to write over — then record into it with your band.',
        'h1': 'Lay out the song before anyone hits record',
        'lead': 'Verse, pre, chorus, verse, chorus, bridge, double chorus — or something weirder. Cobander lets you sketch the shape of a song in a minute, hear it with a drum part, and move sections around until it feels right.',
        'img': ('write.jpg', 'Cobander\'s Write workspace: song sections laid out along the timeline'),
        'sections': [
            ('Start from a shape', [
                'The new-song wizard sets the tempo, key and feel from a list of styles and offers dozens of named song structures. Pick one, or start blank and add sections as you go.',
            ]),
            ('Move whole sections, takes and all', [
                'Drag a section and everything recorded in it moves with it. Restructure the song, make the second chorus a copy of the first so a fix to one fixes both, or give a section its own key.',
            ]),
            ('Something to write over', [
                'The drum generator writes a part for each section in the song\'s feel — fill it in per drum at quarters, eighths or sixteenths, then add or remove single hits. The riff and melody generators give you a starting point when you are stuck.',
            ]),
            ('Notes where the music is', [
                'Pin a note to a bar ("half-time here?"), tag a bandmate, and give each part a stage from idea to approved so everyone knows what\'s left.',
            ]),
        ],
        'faq': [
            ('Can I change the structure after we\'ve recorded?', 'Yes. Sections carry their takes with them when you move, copy or remove them.'),
            ('Do I need to read music?', 'No. Sections, chords and lyrics are all labelled in plain words.'),
        ],
    },
    {
        'slug': 'melody-from-vocal',
        'title': 'Turn a Sung Vocal Into Melody Notes — Cobander',
        'nav': 'Melody from a vocal',
        'desc': 'Sing the line and Cobander writes it down as notes on the song\'s melody track, in key and on the beat — or type lyrics and get a melody to try. Runs on your own computer.',
        'h1': 'Hum it, and the melody is written down',
        'lead': 'The best melody ideas get sung into a phone at a red light and forgotten. In Cobander, a vocal take becomes notes on the song\'s melody track, so the band can see it, play it and keep it.',
        'img': ('write.jpg', 'Cobander\'s Write workspace with the melody track under the song'),
        'sections': [
            ('A vocal take becomes notes', [
                'Right-click a vocal track and choose Melody from this track. Cobander follows the sung pitch and writes notes: vibrato and the scoop into a note count as the note you were aiming at, and notes are pulled into the song\'s key and onto the beat when the recording backs it up.',
            ]),
            ('Or start from the words', [
                'Type a lyric and the melody generator sets it to a tune that fits the chords — reroll the notes, the rhythm or both, edit any note by hand, and keep the one you like. A guide voice sings it back so you can hear it.',
            ]),
            ('Use it everywhere', [
                'The melody shows up in the chart and in Practice, and a keyboard player can read it straight off the note editor.',
            ]),
        ],
        'faq': [
            ('Do I need a good voice?', 'No. It writes down the notes you aimed for; a rough hum works.'),
            ('Does it upload my singing?', 'No. It runs on your own computer.'),
        ],
    },
]

STYLE = """
:root { --ink:#15171d; --ink-2:#1e2129; --steel:#9aa0ad; --line:#2f3340; --noodle:#f2b534; --chili:#d8392b; --white:#f6f6f8;
  --display:"Big Shoulders Display", Impact, "Arial Narrow", sans-serif; --body:"Atkinson Hyperlegible", system-ui, sans-serif; }
* { box-sizing:border-box; }
body { margin:0; background:var(--ink); color:var(--white); font:17px/1.6 var(--body); -webkit-font-smoothing:antialiased; }
a { color:var(--noodle); } a:focus-visible { outline:3px solid var(--noodle); outline-offset:3px; }
.wrap { max-width:860px; margin:0 auto; padding:0 16px; }
nav { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 0; flex-wrap:wrap; }
.mark { display:inline-flex; gap:8px; align-items:center; text-decoration:none; color:var(--white); }
.mark b { font-family:var(--display); font-weight:900; font-size:26px; letter-spacing:2px; }
.mark .seal { width:26px; height:26px; border:2px solid var(--chili); border-radius:5px; transform:rotate(-6deg); display:inline-flex; align-items:center; justify-content:center; }
.mark .seal img { width:17px; height:17px; }
nav .links { display:flex; gap:18px; font-size:15px; flex-wrap:wrap; } nav .links a { color:var(--steel); text-decoration:none; } nav .links a:hover { color:var(--white); }
h1, h2 { font-family:var(--display); font-weight:900; line-height:.98; letter-spacing:.5px; margin:0; }
h1 { font-size:clamp(40px, 7vw, 68px); margin:28px 0 16px; }
h2 { font-size:clamp(28px, 4.5vw, 40px); margin:40px 0 12px; }
h3 { font-size:18px; margin:18px 0 4px; }
p { margin:0 0 14px; color:#d6d9e0; }
.lead { font-size:20px; color:var(--white); }
figure { margin:26px 0 8px; } picture { display:contents; } picture source { display:none; } figure img { width:100%; height:auto; border-radius:10px; border:1px solid var(--line); display:block; }
.cta { display:flex; gap:10px; flex-wrap:wrap; margin:22px 0 6px; }
.btn { display:inline-block; font:700 17px/1 var(--body); padding:15px 22px; border-radius:8px; text-decoration:none; border:2px solid transparent; }
.btn.hot { background:var(--noodle); color:#1d1d1d; } .btn.hot:hover { background:#ffc94d; }
.btn.cool { color:var(--white); border-color:var(--line); } .btn.cool:hover { border-color:var(--steel); }
.fine { font-size:14px; color:var(--steel); }
.faq { border-top:2px solid var(--noodle); margin-top:40px; }
.more { display:flex; flex-wrap:wrap; gap:8px 18px; padding:0; list-style:none; margin:0 0 10px; }
footer { border-top:1px solid var(--line); margin-top:48px; padding:22px 0 40px; color:var(--steel); font-size:14px; }
"""

def esc(s):
    return html.escape(s, quote=True)

def page(p):
    url = f"{SITE}/{p['slug']}/"
    img_url = f"{SITE}/img/{p['img'][0]}"
    ld = [
        {'@context': 'https://schema.org', '@type': 'WebPage', 'name': p['title'], 'description': p['desc'], 'url': url,
         'isPartOf': {'@type': 'WebSite', 'name': 'Cobander', 'url': SITE + '/'},
         'about': {'@type': 'SoftwareApplication', 'name': 'Cobander', 'url': SITE + '/'}},
        {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
            {'@type': 'ListItem', 'position': 1, 'name': 'Cobander', 'item': SITE + '/'},
            {'@type': 'ListItem', 'position': 2, 'name': p['nav'], 'item': url}]},
        {'@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': [
            {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in p['faq']]},
    ]
    body = []
    for h, paras in p['sections']:
        body.append(f'<h2>{esc(h)}</h2>')
        body += [f'<p>{esc(x)}</p>' for x in paras]
    faq = ''.join(f'<h3>{esc(q)}</h3><p>{esc(a)}</p>' for q, a in p['faq'])
    more = ''.join(f'<li><a href="../{o["slug"]}/">{esc(o["nav"])}</a></li>' for o in PAGES if o is not p)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(p['title'])}</title>
<meta name="description" content="{esc(p['desc'])}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cobander">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{esc(p['title'])}">
<meta property="og:description" content="{esc(p['desc'])}">
<meta property="og:image" content="{SITE}/img/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(p['title'])}">
<meta name="twitter:description" content="{esc(p['desc'])}">
<meta name="twitter:image" content="{SITE}/img/og.jpg">
<link rel="icon" href="../icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../site.css">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
</head>
<body>
<div class="wrap">
<nav>
  <a class="mark" href="../"><b>COBANDER</b><span class="seal"><img src="../icons/gi-delapouite-noodles.svg" alt="" width="17" height="17"></span></a>
  <div class="links"><a href="../#does">What it does</a><a href="../#menu">Licenses</a><a href="../manual/">Manual</a></div>
</nav>
<main>
<h1>{esc(p['h1'])}</h1>
<p class="lead">{esc(p['lead'])}</p>
<div class="cta"><a class="btn hot" href="https://takeout.cobander.com/download/win">Download for Windows</a><a class="btn hot" href="https://takeout.cobander.com/download/mac-arm64">Download for Mac</a><a class="btn cool" href="../#menu">Licenses</a></div>
<p class="fine">Free — the whole app, one song per band. Intel Mac? <a href="https://takeout.cobander.com/download/mac-x64">Intel Mac download</a>.</p>
<figure>{picture('../', p['img'][0], p['img'][1], '(max-width: 860px) calc(100vw - 32px), 828px', hero=True)}</figure>
{chr(10).join(body)}
<section class="faq"><h2>Questions</h2>{faq}</section>
<h2>More about Cobander</h2>
<ul class="more"><li><a href="../">Home</a></li>{more}</ul>
</main>
<footer><p><a href="../">Cobander</a> · <a href="../manual/">User manual</a> · <a href="../terms.html">Terms &amp; privacy</a> · <a href="mailto:noods@cobander.com">noods@cobander.com</a></p></footer>
</div>
</body>
</html>
"""

def guides_links(prefix):
    return ' · '.join(f'<a href="{prefix}{p["slug"]}/">{esc(p["nav"])}</a>' for p in PAGES)

def page_404():
    # GitHub Pages serves this for any missing path, so every link is root-absolute.
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — Cobander</title>
<meta name="description" content="That page isn't here. Head back to Cobander or open the user manual.">
<meta name="robots" content="noindex">
<link rel="icon" href="/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<div class="wrap">
<nav>
  <a class="mark" href="/"><b>COBANDER</b><span class="seal"><img src="/icons/gi-delapouite-noodles.svg" alt="" width="17" height="17"></span></a>
  <div class="links"><a href="/#does">What it does</a><a href="/#menu">Licenses</a><a href="/manual/">Manual</a></div>
</nav>
<main>
<h1>This page wandered off</h1>
<p class="lead">Nothing lives at this address. It may have moved, or the link had a typo.</p>
<div class="cta"><a class="btn hot" href="/">Go to the homepage</a><a class="btn cool" href="/manual/">Open the manual</a></div>
<h2>Or try one of these</h2>
<ul class="more">{''.join(f'<li><a href="/{p["slug"]}/">{esc(p["nav"])}</a></li>' for p in PAGES)}</ul>
</main>
<footer><p><a href="/">Cobander</a> · <a href="/manual/">User manual</a> · <a href="/terms.html">Terms &amp; privacy</a> · <a href="mailto:noods@cobander.com">noods@cobander.com</a></p></footer>
</div>
</body>
</html>
"""

# --- manual pages: canonical, social tags, breadcrumb JSON-LD, Guides line (idempotent) ---
SEO_START, SEO_END = '<!-- seo:start -->', '<!-- seo:end -->'
GUIDES_START, GUIDES_END = '<!-- guides:start -->', '<!-- guides:end -->'

def _strip_block(s, a, b):
    return re.sub(re.escape(a) + r'.*?' + re.escape(b) + r'\n?', '', s, flags=re.S)

def patch_manual():
    mdir = os.path.join(DOCS, 'manual')
    files = sorted(f for f in os.listdir(mdir) if f.endswith('.html'))
    for f in files:
        path = os.path.join(mdir, f)
        s = open(path).read()
        s = _strip_block(s, SEO_START, SEO_END)
        s = _strip_block(s, GUIDES_START, GUIDES_END)
        title = html.unescape(re.search(r'<title>(.*?)</title>', s, re.S).group(1).strip())
        m = re.search(r'<meta name="description" content="(.*?)">', s, re.S)
        desc = html.unescape(m.group(1)) if m else ''
        if not desc:
            sys.exit(f'manual/{f} has no meta description; add one in scripts/gen-manual.py')
        url = f'{SITE}/manual/' + ('' if f == 'index.html' else f)
        crumbs = [('Cobander', SITE + '/'), ('Manual', f'{SITE}/manual/')]
        if f != 'index.html':
            crumbs.append((re.sub(r'\s+—\s+Cobander manual$', '', title), url))
        ld = {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
            {'@type': 'ListItem', 'position': i, 'name': n, 'item': u} for i, (n, u) in enumerate(crumbs, 1)]}
        block = f"""{SEO_START}
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Cobander">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:image" content="{OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{esc(title)}">
<meta name="twitter:description" content="{esc(desc)}">
<meta name="twitter:image" content="{OG_IMAGE}">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
{SEO_END}
"""
        s = s.replace('</head>', block + '</head>', 1)
        if f == 'index.html':
            g = f'{GUIDES_START}\n<p class="muted">Guides: {guides_links("../")}</p>\n{GUIDES_END}\n'
            s = s.replace('    <div class="next">', g + '    <div class="next">', 1)
            if GUIDES_START not in s:
                sys.exit('manual/index.html: could not place the Guides line')
        open(path, 'w').write(s)
    return len(files)

open(os.path.join(DOCS, 'site.css'), 'w').write(STYLE.lstrip())
print('webp files written:', make_webps())
open(os.path.join(DOCS, '404.html'), 'w').write(page_404())
print('manual pages patched:', patch_manual())
for p in PAGES:
    d = os.path.join(DOCS, p['slug']); os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w').write(page(p))

urls = [('', '1.0')] + [(p['slug'] + '/', '0.8') for p in PAGES]
urls += [('manual/', '0.6')] + [(f'manual/{f}', '0.5') for f in sorted(os.listdir(os.path.join(DOCS, 'manual'))) if f.endswith('.html') and f != 'index.html']
urls += [('terms.html', '0.2')]
sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
sm += [f'  <url><loc>{SITE}/{u}</loc><lastmod>{TODAY}</lastmod><priority>{pr}</priority></url>' for u, pr in urls]
sm.append('</urlset>')
open(os.path.join(DOCS, 'sitemap.xml'), 'w').write('\n'.join(sm) + '\n')
open(os.path.join(DOCS, 'robots.txt'), 'w').write(f'User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n')
# homepage Guides line lists every landing page
_ip = os.path.join(DOCS, 'index.html'); _h = open(_ip, encoding='utf-8').read()
_g = '<p>Guides: ' + ' · '.join(f'<a href="{p["slug"]}/">{esc(p["nav"])}</a>' for p in PAGES) + '</p>'
_h2 = re.sub(r'<p>Guides: .*?</p>', lambda m: _g, _h, count=1)
if _h2 != _h: open(_ip, 'w', encoding='utf-8').write(_h2)
print('pages:', [p['slug'] for p in PAGES], 'sitemap urls:', len(urls))
