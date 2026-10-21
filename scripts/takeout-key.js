#!/usr/bin/env node
// Make a Takeout key by hand (the Worker in worker/takeout does the same automatically on each sale).
//   node scripts/takeout-key.js "Band Name" [--tier takeout|roadie] [--email who@x.y] [--order 123]
// Reads the private key from $COBANDER_TAKEOUT_PRIV or the file $COBANDER_TAKEOUT_KEYFILE (default ~/.cobander-takeout.key).
// The private key is NOT in the repo. Lose it and every issued key still works; you just can't make new ones.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const T = require('../src/takeout');
const args = process.argv.slice(2); const opt = {}; const rest = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i]; else rest.push(args[i]); }
const band = rest.join(' ').trim();
if (!band) { console.error('usage: node scripts/takeout-key.js "Band Name" [--tier takeout|roadie] [--email x@y] [--order id]'); process.exit(2); }
const file = process.env.COBANDER_TAKEOUT_KEYFILE || path.join(os.homedir(), '.cobander-takeout.key');
const priv = (process.env.COBANDER_TAKEOUT_PRIV || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')).trim();
if (!priv) { console.error(`no private key: set COBANDER_TAKEOUT_PRIV or put it in ${file}`); process.exit(2); }
const key = T.sign({ band, tier: opt.tier, email: opt.email, order: opt.order }, priv);
if (!T.verify(key)) { console.error('signed, but the app\'s public key does not accept it — wrong private key?'); process.exit(1); }
process.stdout.write(key + '\n');
