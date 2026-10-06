// ─── Claude Usage Monitor: on-page usage bar ────────────────────────────────
// Optional, off by default. Shows the session and weekly limits in a slim strip
// right above claude.ai's chat box, so the numbers are in view while you type.
// It renders what the background already stored (no requests of its own) and
// relays the limits page/stream.js reads from each reply to the background.
// Everything lives in a closed shadow root, so claude.ai's styles can't leak in
// and ours can't leak out.

(() => {
  if (window.__claudeUsageMonitorBar) return;
  window.__claudeUsageMonitorBar = true;

  const HOST_ID = 'claude-usage-monitor-bar';
  // Must match FETCH_FAIL_STALE in background.js.
  const FETCH_FAIL_STALE = 2;

  let state = { usage: null, plan: null, authBackoff: null, fetchFailures: null, enabled: true };
  let host = null;
  let root = null;

  // ── Relay: stream.js (page world) → background ───────────────────────────
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'claude-usage-monitor' || data.type !== 'stream-limits') return;
    try {
      chrome.runtime.sendMessage({ type: 'STREAM_LIMITS', limits: data.limits }, () => void chrome.runtime.lastError);
    } catch { /* extension reloaded underneath this page: nothing to relay to */ }
  });

  // ── Data ─────────────────────────────────────────────────────────────────
  const KEYS = ['claudeUsage', 'claudePlan', 'authBackoff', 'fetchFailures', 'pageBar'];

  function load() {
    chrome.storage.local.get(KEYS, (s) => {
      state = {
        usage: s.claudeUsage || null,
        plan: s.claudePlan || null,
        authBackoff: s.authBackoff || null,
        fetchFailures: s.fetchFailures || null,
        enabled: s.pageBar?.enabled !== false,
      };
      render();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !KEYS.some(k => k in changes)) return;
    load();
  });

  // ── Mounting ─────────────────────────────────────────────────────────────
  // claude.ai is a single-page app that rebuilds the composer on navigation, so
  // the strip is re-anchored whenever the DOM changes, batched to one check per
  // burst. A timer, not requestAnimationFrame: rAF is paused in background tabs,
  // which left the batch flag stuck and the strip missing after navigation.
  function anchor() {
    const input = document.querySelector('[data-testid="chat-input"]');
    return input ? input.closest('fieldset') : null;
  }

  function ensureMounted() {
    const target = state.enabled ? anchor() : null;
    if (!target) {
      host?.remove();
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      root = host.attachShadow({ mode: 'closed' });
      render();
    }
    if (host.nextElementSibling !== target || host.parentElement !== target.parentElement) {
      target.parentElement.insertBefore(host, target);
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; ensureMounted(); }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Countdowns tick without new data.
  setInterval(render, 30 * 1000);

  // ── Rendering ────────────────────────────────────────────────────────────
  function colorFor(pct) {
    if (pct < 50) return 'var(--green)';
    if (pct < 80) return 'var(--amber)';
    return 'var(--red)';
  }

  function until(epochMs) {
    const diff = epochMs - Date.now();
    if (!(diff > 0)) return '';
    const min = Math.floor(diff / 60000);
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = min % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Readings taken from a reply (Free plan) are never refreshed in between, so
  // a window that has already reset means 0% until the next message, not the
  // old figure.
  function bucket(b, fromStream) {
    if (!b || b.percentage === null || b.percentage === undefined) return null;
    if (fromStream && b.resetTime && b.resetTime <= Date.now()) return { percentage: 0, resetTime: null };
    return b;
  }

  function isDark() {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!bg) return true;
    const [r, g, b] = bg.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
  }

  // Built with DOM calls, not innerHTML: nothing here is markup, and it keeps
  // the strip clear of claude.ai's Trusted Types policy and of store review flags.
  const STYLE = `
    :host { all: initial; display: block; }
    .bar {
      --green: #22c55e; --amber: #f59e0b; --red: #ef4444;
      --text: #d6d3cd; --dim: #8f8b84; --track: rgba(255,255,255,0.10);
      display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
      padding: 0 6px 6px; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: var(--text);
    }
    .bar.light { --text: #3d3a35; --dim: #7a766f; --track: rgba(0,0,0,0.09); }
    .bar.stale { opacity: 0.6; }
    .seg { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .label, .reset, .note { color: var(--dim); }
    .track { width: 56px; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .fill { display: block; height: 100%; border-radius: 2px; }
    .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
    @media (max-width: 520px) { .reset { display: none; } }
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function segment(label, b) {
    const pct = Math.min(100, Math.max(0, Math.round(b.percentage)));
    const reset = b.resetTime ? until(b.resetTime) : '';
    const seg = el('span', 'seg');
    seg.title = `${label}: ${pct}% used${reset ? `, resets in ${reset}` : ''}`;
    const track = el('span', 'track');
    const fill = el('span', 'fill');
    fill.style.width = `${pct}%`;
    fill.style.background = colorFor(pct);
    track.append(fill);
    const pctEl = el('span', 'pct', `${pct}%`);
    pctEl.style.color = colorFor(pct);
    seg.append(el('span', 'label', label), track, pctEl);
    if (reset) seg.append(el('span', 'reset', reset));
    return seg;
  }

  function render() {
    if (!root) return;
    const fromStream = state.usage?.source === 'stream';
    const session = bucket(state.usage?.session, fromStream);
    const weekly  = bucket(state.usage?.weekly, fromStream);
    const stale = Boolean(state.authBackoff?.fails > 0) || (state.fetchFailures?.count ?? 0) >= FETCH_FAIL_STALE;
    const free = state.plan?.label === 'Free';

    const bar = el('div', `bar${isDark() ? '' : ' light'}${stale ? ' stale' : ''}`);
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', 'Claude usage');
    if (session || weekly) {
      if (session) bar.append(segment('Session', session));
      if (weekly)  bar.append(segment('Weekly', weekly));
      if (stale)   bar.append(el('span', 'note', 'stale'));
    } else {
      bar.append(el('span', 'note', free
        ? 'Your Free plan limits appear after your next message'
        : 'Usage not loaded yet'));
    }
    const style = el('style', null, STYLE);
    root.replaceChildren(style, bar);
  }

  load();
  ensureMounted();
})();
