// Phone page: Cobander serves a small practice page on the home network (lyrics + chords following the song live,
// play/pause and part skips from the phone). Off unless turned on; every request needs the key in the link.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
let server = null; let current = null;
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue; if (a.internal) continue;
    const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address); if (!priv) continue;
    const virt = /vethernet|virtualbox|vmware|docker|wsl|hyper-v|loopback|tailscale|zerotier/i.test(name);
    out.push({ name, address: a.address, score: (virt ? 0 : 2) + (/^192\.168\./.test(a.address) ? 1 : 0) + (/wi-?fi|wlan|en0|ethernet|eth0/i.test(name) ? 1 : 0) });
  }
  return out.sort((a, b) => b.score - a.score);
}
const isPrivate = (ip) => { const v = String(ip || '').replace(/^::ffff:/, ''); return v === '127.0.0.1' || v === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(v); };
function start({ port = 47811, key, ask }) {
  return new Promise((resolve, reject) => {
    if (server && current && current.port === port && current.key === key) { resolve(info()); return; }
    stop();
    const page = fs.readFileSync(path.join(__dirname, 'renderer', 'phone.html'), 'utf8');
    const s = http.createServer(async (req, res) => {
      const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
      try {
        if (!isPrivate(req.socket.remoteAddress)) return send(403, { error: 'home network only' });
        const u = new URL(req.url, 'http://x'); const k = u.searchParams.get('k') || req.headers['x-bp-key'];
        if (k !== key) return send(403, u.pathname === '/' ? 'This link has expired — open it again from Cobander (Share → Open on your phone).' : { error: 'bad key' }, u.pathname === '/' ? 'text/plain; charset=utf-8' : 'application/json');
        if (req.method === 'GET' && u.pathname === '/') return send(200, page, 'text/html; charset=utf-8');
        if (req.method === 'GET' && u.pathname === '/state') return send(200, await ask('phoneState', { since: Number(u.searchParams.get('v')) || 0 }));
        if (req.method === 'POST' && u.pathname === '/cmd') {
          let body = ''; for await (const ch of req) { body += ch; if (body.length > 4096) break; }
          let args = {}; try { args = JSON.parse(body || '{}'); } catch (_) {}
          return send(200, await ask('phoneCmd', args));
        }
        return send(404, { error: 'not found' });
      } catch (err) { send(500, { error: String(err && err.message || err) }); }
    });
    s.on('error', (err) => { server = null; current = null; reject(err); });
    s.listen(port, '0.0.0.0', () => { server = s; current = { port, key }; resolve(info()); });
  });
}
function info() { if (!current) return { on: false }; const ips = lanAddresses(); return { on: true, port: current.port, key: current.key, urls: ips.map((a) => ({ name: a.name, url: `http://${a.address}:${current.port}/?k=${current.key}` })) }; }
function stop() { if (server) { try { server.close(); } catch (_) {} } server = null; current = null; }
module.exports = { start, stop, info, lanAddresses, isPrivate };
