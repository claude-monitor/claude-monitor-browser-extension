// ─── Claude Usage Monitor: on-page usage bar ────────────────────────────────
// Optional, off by default. Shows the session and weekly limits in a slim strip
// right above claude.ai's chat box (and Claude Code's prompt box), so the
// numbers are in view while you type. It renders what the background already
// stored (no requests of its own) and relays the limits page/stream.js reads
// from each reply to the background. Everything lives in a closed shadow root,
// so claude.ai's styles can't leak in and ours can't leak out.

(() => {
  if (window.__claudeUsageMonitorBar) return;
  window.__claudeUsageMonitorBar = true;

  const HOST_ID = 'claude-usage-monitor-bar';
  // Must match FETCH_FAIL_STALE in background.js.
  const FETCH_FAIL_STALE = 2;
  // Must match NOTIF_DEFAULTS.warnAt in background.js.
  const WARN_AT_DEFAULT = 80;

  // Chat routes get a floating pill when the chat box can't be found, so a
  // redesign of the composer never leaves the bar silently missing. /code has
  // its own anchor and no pill.
  const CHAT_ROUTE = /^\/(?:new|chat|project)(?:\/|$)/;
  const CODE_ROUTE = /^\/code(?:\/|$)/;
  const PILL_DELAY_MS = 4000;
  const PILL_STYLE = 'position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;';
  // Below this the chat box spans the window and its send button sits bottom
  // right, right where the pill would go: no pill there.
  const PILL_MIN_WIDTH = 768;
  // barHealth is rewritten when it changes, or when it is older than this.
  const HEALTH_REFRESH_MS = 6 * 60 * 60 * 1000;

  // Review ask, the popup's twin: same keys, same snooze, same moments, plus a
  // week of the bar in use. One line at the end of the strip, never the pill.
  const REVIEW_MOMENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  const REVIEW_BAR_AFTER_MS     = 7 * 24 * 60 * 60 * 1000;
  const REVIEW_SNOOZE_MS        = 14 * 24 * 60 * 60 * 1000;
  // Edge runs the Chrome package but has its own store; its UA carries "Edg/".
  const REVIEW_URL = navigator.userAgent.includes('Firefox')
    ? 'https://addons.mozilla.org/firefox/addon/claude-usage-meter/reviews/'
    : navigator.userAgent.includes('Edg/')
      ? 'https://microsoftedge.microsoft.com/addons/detail/ilidbhklkpefboidlfeoiiacepcefinp'
      : 'https://chromewebstore.google.com/detail/bfhdcfiigpaaopklllpobkheakpigbfo/reviews?utm_source=extension&utm_medium=bar&utm_campaign=review';

  // The forecast and the messages-left estimate are shown only while they
  // still describe the session window on screen.
  const SAME_WINDOW_MS      = 60 * 1000;
  const FORECAST_MAX_AGE_MS = 30 * 60 * 1000;
  const FORECAST_SHORT_MS   = 60 * 60 * 1000;

  // Dates follow the UI language only where the UI is translated; otherwise an
  // English UI would show, say, Arabic or Russian dates (14 store-only locales).
  const UI_LANG = chrome.i18n.getUILanguage();
  const UI_BASES = ['es', 'de', 'fr', 'it', 'ja', 'ko'];
  const LOCALE = (UI_LANG === 'pt-BR' || UI_BASES.includes(UI_LANG.split('-')[0])) ? UI_LANG : 'en-US';

  let state = { usage: null, plan: null, authBackoff: null, fetchFailures: null, enabled: true };
  let host = null;
  let root = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch { /* extension reloaded underneath this page: nothing to talk to */ }
  }

  function store(items) {
    try { chrome.storage.local.set(items); } catch { /* extension reloaded underneath this page */ }
  }

  // ── Relay: stream.js (page world) → background ───────────────────────────
  // The background validates every field; the page world is not trusted.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    // Turned off since this page loaded: the scripts stay until a reload, the
    // relay stops now (the background checks again).
    if (!state.enabled) return;
    const data = event.data;
    if (!data || data.source !== 'claude-usage-monitor' || data.type !== 'stream-limits') return;
    send({
      type: 'STREAM_LIMITS',
      limits: data.limits,
      orgId: data.orgId ?? null,
      eventKey: data.eventKey ?? null,
      reply: data.reply !== false,
    });
  });

  // ── Data ─────────────────────────────────────────────────────────────────
  // The alert threshold decides when a per-model cap joins the strip.
  const SETTINGS_KEYS = ['notifSettings'];
  const KEYS = ['claudeUsage', 'claudePlan', 'authBackoff', 'fetchFailures', 'pageBar',
    'forecast', 'msgLeft', 'reviewMoment', 'reviewNudgeDismissed', 'reviewNudgeSnoozedUntil', 'barFirstSeen'];

  let loaded = false;
  // barHealth as this page last read or wrote it. Read once: two tabs in
  // different modes would otherwise keep overwriting each other's.
  let health = null;

  function load() {
    chrome.storage.local.get([...KEYS, ...SETTINGS_KEYS, 'barHealth'], (s) => {
      state = {
        usage: s.claudeUsage || null,
        plan: s.claudePlan || null,
        notifSettings: s.notifSettings || null,
        authBackoff: s.authBackoff || null,
        fetchFailures: s.fetchFailures || null,
        enabled: s.pageBar?.enabled !== false,
        forecast: s.forecast || null,
        msgLeft: s.msgLeft || null,
        reviewMoment: s.reviewMoment || null,
        reviewDismissed: Boolean(s.reviewNudgeDismissed),
        reviewSnoozedUntil: s.reviewNudgeSnoozedUntil,
        firstSeen: s.barFirstSeen,
      };
      if (!loaded) {
        health = s.barHealth || null;
        // Nothing to show yet, or the login failed last time: ask for a reading
        // once per page load. The background rate-limits these.
        if (state.enabled && (!state.usage || state.authBackoff?.fails > 0)) send({ type: 'REFRESH', source: 'auto' });
      }
      loaded = true;
      render();
      ensureMounted();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || ![...KEYS, ...SETTINGS_KEYS].some(k => k in changes)) return;
    load();
  });

  // ── Mounting ─────────────────────────────────────────────────────────────
  // claude.ai is a single-page app that rebuilds the composer on navigation, so
  // the strip is re-anchored whenever the DOM changes, batched to one check per
  // burst. A timer, not requestAnimationFrame: rAF is paused in background tabs,
  // which left the batch flag stuck and the strip missing after navigation.
  //
  // Anchors, most specific first:
  //   1. the chat box: before its fieldset (classic and unified chat);
  //   2. Claude Code's prompt box: before .epitaxy-prompt, full width above it;
  //   3. chat routes only: a visible rich-text box inside a form or fieldset in
  //      the lower half of the window, for when the test ids change.
  function anchor() {
    const chat = document.querySelector('[data-testid="chat-input"]')?.closest('fieldset');
    if (chat) return chat;
    const code = document.querySelector('[data-testid="code-prompt-input"]')?.closest('.epitaxy-prompt');
    if (code) return code;
    if (!CHAT_ROUTE.test(location.pathname)) return null;
    for (const box of document.querySelectorAll('[contenteditable="true"][role="textbox"], .ProseMirror')) {
      const container = box.closest('fieldset, form');
      if (!container || box.offsetParent === null) continue;
      const top = box.getBoundingClientRect().top;
      if (top >= innerHeight / 2 && top < innerHeight) return container;
    }
    return null;
  }

  let mode = null;          // 'inline' | 'pill' | null (not on the page)
  let pillClosed = false;   // the pill's ✕: gone until the page reloads
  let lastPath = null;
  let missingSince = 0;     // when this route last had no anchor (0: it has one)
  let pillTimer = null;

  function ensureMounted() {
    if (!loaded) return;
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      missingSince = 0;
    }
    const target = state.enabled ? anchor() : null;
    if (target?.parentElement) {
      missingSince = 0;
      mountInline(target);
      return;
    }
    if (!state.enabled || pillClosed || !CHAT_ROUTE.test(path) || innerWidth < PILL_MIN_WIDTH) {
      unmount();
      return;
    }
    if (mode === 'pill') {
      if (!host.isConnected) document.body.append(host);
      return;
    }
    if (mode === 'inline') unmount();
    // The composer gets a few seconds to render before the pill stands in.
    if (!missingSince) {
      missingSince = Date.now();
      clearTimeout(pillTimer);
      pillTimer = setTimeout(ensureMounted, PILL_DELAY_MS + 50);
    }
    if (Date.now() - missingSince >= PILL_DELAY_MS) mountPill();
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    root = host.attachShadow({ mode: 'closed' });
  }

  function mountInline(target) {
    ensureHost();
    const moved = host.nextElementSibling !== target || host.parentElement !== target.parentElement;
    if (moved) target.parentElement.insertBefore(host, target);
    // After the move: the background comes from the new surroundings.
    if (mode !== 'inline' || moved) {
      mode = 'inline';
      host.removeAttribute('style');
      render();
    }
    noteHealth(true, 'inline');
  }

  function mountPill() {
    ensureHost();
    mode = 'pill';
    host.style.cssText = PILL_STYLE;
    render();
    document.body.append(host);
    noteHealth(false, 'pill');
  }

  function unmount() {
    host?.remove();
    mode = null;
  }

  // Where the bar ended up, for the uninstall diagnosis (no URLs, no ids).
  function noteHealth(anchored, how) {
    const page = CODE_ROUTE.test(location.pathname) ? 'code' : 'chat';
    if (health && health.anchored === anchored && health.mode === how && health.page === page
      && Date.now() - health.at < HEALTH_REFRESH_MS) return;
    health = { anchored, mode: how, page, at: Date.now() };
    store({ barHealth: health });
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
  // Strings live in the extension's _locales; content scripts can read them.
  function msg(key, ...subs) {
    return chrome.i18n.getMessage(key, subs.map(String)) || key;
  }

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
    if (d > 0) return msg('durDH', d, h);
    if (h > 0) return msg('durHM', h, m);
    return msg('durM', m);
  }

  // 16:40 today, "Thu 14:00" on another day.
  function clock(epochMs) {
    const d = new Date(epochMs);
    const time = d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${time}`;
  }

  // Readings taken from a reply (Free plan) are never refreshed in between, so
  // a window that has already reset means 0% until the next message, not the
  // old figure.
  function bucket(b, fromStream) {
    if (!b || b.percentage === null || b.percentage === undefined) return null;
    if (fromStream && b.resetTime && b.resetTime <= Date.now()) return { percentage: 0, resetTime: null };
    return b;
  }

  // A per-model cap gets its own segment once it is the tightest weekly window:
  // at or past the warning threshold and fuller than the weekly limit (the
  // badge's rule). A chat in that model is cut off when the cap runs out,
  // whatever the weekly limit says. Caps without a reset share the week's.
  function tightestCap(usage, weekly) {
    const raw = Math.round(Number(state.notifSettings?.warnAt));
    const warnAt = Number.isFinite(raw) ? Math.min(100, Math.max(1, raw)) : WARN_AT_DEFAULT;
    const names = { fable: msg('fableWeekly'), opus: msg('opusWeekly'), sonnet: msg('sonnetWeekly'), design: 'Claude Design' };
    let best = null;
    for (const [key, label] of Object.entries(names)) {
      const b = bucket(usage?.[key], false);
      if (!b || b.percentage < warnAt || b.percentage <= (weekly?.percentage ?? -1)) continue;
      if (!best || b.percentage > best.b.percentage) best = { label, b: { ...b, resetTime: b.resetTime ?? weekly?.resetTime ?? null } };
    }
    return best;
  }

  function forecastFor(session, now) {
    const f = state.forecast?.session;
    if (!f || !session?.resetTime || !(state.forecast.at > now - FORECAST_MAX_AGE_MS)) return null;
    if (!(f.eta > now && f.eta < f.reset) || !(Math.abs(f.reset - session.resetTime) <= SAME_WINDOW_MS)) return null;
    return f;
  }

  function msgLeftFor(session, now) {
    const left = state.msgLeft;
    if (!left || !(session?.resetTime > now) || !(left.n >= 1)) return null;
    return Math.abs(left.reset - session.resetTime) <= SAME_WINDOW_MS ? left : null;
  }

  function isDark() {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!bg) return true;
    const [r, g, b] = bg.map(Number);
    return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
  }

  // The strip sits in claude.ai's transparent sticky footer, so chat text
  // scrolling under it shows through. Paint it with the nearest real background.
  function pageBg() {
    for (let node = host.parentElement; node; node = node.parentElement) {
      const c = getComputedStyle(node).backgroundColor;
      // Chrome reports some as color(srgb r g b / a), not rgba().
      if (c && c !== 'transparent' && !/^rgba\(.*,\s*0\)$|\/\s*0\)$/.test(c)) return c;
    }
    return '';
  }

  // Built with DOM calls, not innerHTML: nothing here is markup, and it keeps
  // the strip clear of claude.ai's Trusted Types policy and of store review flags.
  const STYLE = `
    :host { all: initial; display: block; }
    .bar {
      --green: #22c55e; --amber: #f59e0b; --red: #ef4444; --brand: #D67A57;
      --text: #d6d3cd; --dim: #8f8b84; --track: rgba(255,255,255,0.10);
      display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
      padding: 0 6px 6px; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: var(--text);
    }
    .bar.light { --text: #3d3a35; --dim: #7a766f; --track: rgba(0,0,0,0.09); }
    .bar.stale > * { opacity: 0.6; }
    .bar.pill {
      gap: 10px; flex-wrap: nowrap; padding: 4px 6px 4px 8px; border-radius: 999px;
      background: #30302e; border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    }
    .bar.pill.light { background: #ffffff; border-color: rgba(0,0,0,0.12); box-shadow: 0 2px 10px rgba(0,0,0,0.12); }
    .pill .track { display: none; }
    .seg { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .label, .reset, .note { color: var(--dim); }
    .track { width: 56px; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .fill { display: block; height: 100%; border-radius: 2px; }
    .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
    .brand { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--dim); border-radius: 4px; }
    .brand svg { display: block; width: 16px; height: 16px; flex: none; }
    .brand:hover .brand-name { color: var(--text); }
    .review { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .stars { color: var(--amber); text-decoration: none; letter-spacing: 1px; white-space: nowrap; }
    .close {
      all: unset; cursor: pointer; color: var(--dim); font-size: 11px; line-height: 1;
      padding: 2px 4px; border-radius: 4px;
    }
    .close:hover, .stars:hover { color: var(--text); }
    .brand:focus-visible, .stars:focus-visible, .close:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
    @media (max-width: 900px) { .brand-name { display: none; } }
    @media (max-width: 640px) { .review { display: none; } }
    @media (max-width: 520px) { .reset { display: none; } }
  `;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  function closeButton(label, onClick) {
    const button = el('button', 'close', '✕');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }

  // The popup's pulse on the extension's orange tile, so a screenshot of the
  // strip says where it comes from. It opens the popup (Settings where the
  // browser won't open a popup from a page).
  function brand(compact) {
    const node = el('span', 'brand');
    node.title = msg('barBrandTitle');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', msg('barBrandTitle'));
    const icon = svg('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' });
    icon.append(
      svg('rect', { width: 20, height: 20, rx: 5, fill: '#D67A57' }),
      svg('polyline', {
        points: '2,10 5,10 7.5,5 10,15 12.5,7 15,10 18,10', transform: 'translate(2.5 2.5) scale(0.75)',
        fill: 'none', stroke: 'white', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }),
    );
    node.append(icon);
    if (!compact) node.append(el('span', 'brand-name', 'Claude Monitor'));
    const open = () => send({ type: 'OPEN_DETAILS' });
    node.addEventListener('click', open);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return node;
  }

  function segment(label, b, { compact = false, extraTitle = '', notes = [] } = {}) {
    const pct = Math.min(100, Math.max(0, Math.round(b.percentage)));
    const reset = b.resetTime ? until(b.resetTime) : '';
    const seg = el('span', 'seg');
    seg.title = (reset ? msg('barTitleReset', label, pct, reset) : msg('barTitle', label, pct)) + extraTitle;
    const track = el('span', 'track');
    const fill = el('span', 'fill');
    fill.style.width = `${pct}%`;
    fill.style.background = colorFor(pct);
    track.append(fill);
    const pctEl = el('span', 'pct', `${pct}%`);
    pctEl.style.color = colorFor(pct);
    seg.append(el('span', 'label', label), track, pctEl);
    if (reset && !compact) seg.append(el('span', 'reset', reset));
    if (!compact) seg.append(...notes);
    return seg;
  }

  // Forecast in the session tooltip (and as text in its last hour), then the
  // messages-left estimate, each only while it matches the window on screen.
  function sessionExtras(session) {
    const now = Date.now();
    let extraTitle = '';
    const notes = [];
    const forecast = forecastFor(session, now);
    if (forecast) {
      extraTitle = `\n${msg('forecastLine', clock(forecast.eta), clock(forecast.reset))}`;
      if (forecast.eta - now <= FORECAST_SHORT_MS) notes.push(el('span', 'note', msg('barForecastShort', clock(forecast.eta))));
    }
    const left = msgLeftFor(session, now);
    if (left) {
      const note = el('span', 'note', msg('msgsLeft', left.n));
      note.title = msg('msgsLeftTitle', left.basedOn);
      notes.push(note);
    }
    return { extraTitle, notes };
  }

  let reviewClosed = false;

  function reviewDue() {
    if (state.reviewDismissed || reviewClosed) return false;
    const now = Date.now();
    if (Number.isFinite(state.reviewSnoozedUntil) && now < state.reviewSnoozedUntil) return false;
    const moment = state.reviewMoment;
    const fresh = moment && Number.isFinite(moment.at) && now - moment.at < REVIEW_MOMENT_WINDOW_MS;
    const settled = Number.isFinite(state.firstSeen) && now - state.firstSeen >= REVIEW_BAR_AFTER_MS;
    return Boolean(fresh || settled);
  }

  function reviewLine() {
    const line = el('span', 'review');
    // Empty stars: the link asks for a rating, it doesn't suggest one.
    const stars = el('a', 'stars', '☆☆☆☆☆');
    stars.href = REVIEW_URL;
    stars.target = '_blank';
    // No Referer from claude.ai (the chat's URL) to the store.
    stars.rel = 'noopener noreferrer';
    stars.referrerPolicy = 'no-referrer';
    stars.title = msg('rateInStore');
    stars.setAttribute('aria-label', msg('rateInStore'));
    // Rating ends the ask for good, here and in the popup. The line goes away
    // after the click has opened the store.
    stars.addEventListener('click', () => {
      reviewClosed = true;
      store({ reviewNudgeDismissed: true });
      setTimeout(render, 0);
    });
    line.append(el('span', 'note', msg('reviewDays')), stars, closeButton(msg('notNow'), dismissReview));
    return line;
  }

  // The first "not now" snoozes for two weeks and the second ends the ask,
  // exactly like the popup's line (they share the keys).
  function dismissReview() {
    reviewClosed = true;
    render();
    try {
      chrome.storage.local.get('reviewNudgeSnoozedUntil', ({ reviewNudgeSnoozedUntil }) => {
        if (reviewNudgeSnoozedUntil) store({ reviewNudgeDismissed: true });
        else store({ reviewNudgeSnoozedUntil: Date.now() + REVIEW_SNOOZE_MS });
      });
    } catch { /* extension reloaded underneath this page */ }
  }

  // The bar's own week starts at its first render with data; for the
  // installed base, at the first page load after the update.
  let firstSeenSaved = false;
  function markFirstSeen() {
    if (Number.isFinite(state.firstSeen) || firstSeenSaved) return;
    firstSeenSaved = true;
    store({ barFirstSeen: Date.now() });
  }

  function render() {
    if (!root) return;
    const pill = mode === 'pill';
    const fromStream = state.usage?.source === 'stream';
    const session = bucket(state.usage?.session, fromStream);
    const weekly  = bucket(state.usage?.weekly, fromStream);
    const stale = Boolean(state.authBackoff?.fails > 0) || (state.fetchFailures?.count ?? 0) >= FETCH_FAIL_STALE;
    const free = state.plan?.label === 'Free';

    const bar = el('div', `bar${pill ? ' pill' : ''}${isDark() ? '' : ' light'}${stale ? ' stale' : ''}`);
    if (!pill) bar.style.background = pageBg();
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-label', msg('barAria'));
    bar.append(brand(pill));
    if (session || weekly) {
      if (session) bar.append(segment(msg('sparkSession'), session, { compact: pill, ...sessionExtras(session) }));
      if (weekly)  bar.append(segment(msg('sparkWeekly'), weekly, { compact: pill }));
      if (stale && !pill) bar.append(el('span', 'note', msg('barStale')));
      if (!pill && !stale && reviewDue()) bar.append(reviewLine());
      if (mode) markFirstSeen();
    } else {
      bar.append(el('span', 'note', free ? msg('barFreeWaiting') : msg('barNotLoaded')));
    }
    // Right after the last segment, ahead of the notes. Free plan readings
    // come from replies, which carry no per-model caps.
    const cap = (session || weekly) && !fromStream ? tightestCap(state.usage, weekly) : null;
    if (cap) [...bar.querySelectorAll('.seg')].pop().after(segment(cap.label, cap.b, { compact: pill }));
    if (pill) bar.append(closeButton(msg('barPillHide'), () => { pillClosed = true; unmount(); }));
    const style = el('style', null, STYLE);
    root.replaceChildren(style, bar);
  }

  load();
})();
