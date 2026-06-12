// Dev-only harness: serves the REAL claudetrack/popup.{html,css,js} with a
// chrome.* stub injected, so the actual extension UI can be previewed/screenshot
// outside the browser. Not shipped — lives in screenshot_helper/.

const http = require('http');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'claudetrack');

// Keep the stubbed version in sync with the real manifest automatically.
const manifestVersion = JSON.parse(
  fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')
).version;

const stub = `<script>
window.chrome = {
  runtime: {
    getManifest: () => ({ version: '${manifestVersion}' }),
    sendMessage: (m, cb) => { if (cb) cb({ ok: true, refreshed: true }); },
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      get: (keys, cb) => cb({
        claudeUsage: {
          session: { percentage: 34, resetTime: Date.now() + 1.4e7, label: null },
          weekly:  { percentage: 64, resetTime: Date.now() + 3.8e8, label: null },
          sonnet:  { percentage: 71, resetTime: Date.now() + 3.8e8, label: null },
          opus:    { percentage: 28, resetTime: Date.now() + 3.8e8, label: null },
          design:  { percentage: 12, resetTime: Date.now() + 3.8e8, label: null },
          extra: null, routine: { used: 2, limit: 15 }, lastUpdated: Date.now(), meta: { ready: true },
        },
        refreshInterval: 5,
        authBackoff: null,
        cardPrefs: {},
        claudePlan: { tier: 'default_claude_max_5x', label: 'Max 5x', subcaps: { opus: true, sonnet: true, design: true } },
      }),
      set() {}, remove() {},
    },
    onChanged: { addListener() {} },
  },
  tabs: { create() {} },
};
</script>`;

// With ?menu=1, force the menu open after popup.js runs so the screenshot
// shows it expanded; default is the popup as it opens.
const opener = `<script>setTimeout(function(){var m=document.getElementById('viewMenu');if(m)m.hidden=false;var b=document.getElementById('viewBtn');if(b)b.classList.add('active');},80);</script>`;

const TYPES = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', html: 'text/html' };

http.createServer((q, r) => {
  const f = q.url === '/' ? '/popup.html' : q.url.split('?')[0];
  try {
    if (f === '/popup.html') {
      let body = fs.readFileSync(path.join(base, f), 'utf8');
      const withMenu = /[?&]menu=1/.test(q.url);
      body = body.replace('</head>', stub + '</head>')
                 .replace('</body>', (withMenu ? opener : '') + '</body>');
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      r.end(body);
    } else {
      const ext = f.split('.').pop();
      const data = fs.readFileSync(path.join(base, f)); // read before writeHead so a miss 404s cleanly
      r.writeHead(200, { 'Content-Type': (TYPES[ext] || 'application/octet-stream') + '; charset=utf-8' });
      r.end(data);
    }
  } catch (e) {
    r.writeHead(404);
    r.end('not found');
  }
}).listen(4179, () => console.log('popup harness on http://localhost:4179'));
