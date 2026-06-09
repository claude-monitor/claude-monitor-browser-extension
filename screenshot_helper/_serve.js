// Dev-only harness: serves the REAL claudetrack/popup.{html,css,js} with a
// chrome.* stub injected, so the actual extension UI can be previewed/screenshot
// outside the browser. Not shipped — lives in screenshot_helper/.

const http = require('http');
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'claudetrack');

const stub = `<script>
window.chrome = {
  runtime: {
    getManifest: () => ({ version: '1.6.2' }),
    sendMessage: (m, cb) => { if (cb) cb({ ok: true }); },
    onMessage: { addListener() {} },
  },
  storage: {
    local: {
      get: (keys, cb) => cb({
        claudeUsage: {
          session: { percentage: 58, resetTime: Date.now() + 8.0e6, label: null },
          weekly:  { percentage: 73, resetTime: Date.now() + 3.6e8, label: null },
          sonnet:  { percentage: 0,  resetTime: Date.now() + 2.4e8, label: null },
          opus:    null,
          design:  null,
          extra: null, routine: { used: 3, limit: 15 }, lastUpdated: Date.now(), meta: { ready: true },
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

// After popup.js runs, force the menu open so the screenshot shows it expanded.
const opener = `<script>setTimeout(function(){var m=document.getElementById('viewMenu');if(m)m.hidden=false;var b=document.getElementById('viewBtn');if(b)b.classList.add('active');},80);</script>`;

const TYPES = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', html: 'text/html' };

http.createServer((q, r) => {
  const f = q.url === '/' ? '/popup.html' : q.url.split('?')[0];
  try {
    if (f === '/popup.html') {
      let body = fs.readFileSync(path.join(base, f), 'utf8');
      body = body.replace('</head>', stub + '</head>').replace('</body>', opener + '</body>');
      r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      r.end(body);
    } else {
      const ext = f.split('.').pop();
      r.writeHead(200, { 'Content-Type': (TYPES[ext] || 'application/octet-stream') + '; charset=utf-8' });
      r.end(fs.readFileSync(path.join(base, f)));
    }
  } catch (e) {
    r.writeHead(404);
    r.end('not found');
  }
}).listen(4179, () => console.log('popup harness on http://localhost:4179'));
