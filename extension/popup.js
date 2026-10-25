// ─── Claude Usage Monitor: Popup Script ──────────────────────────────────────

const USAGE_URL   = 'https://claude.ai/settings/usage';
const SIGN_IN_URL = 'https://claude.ai/login';
// Free plans have no usage page; the chat is where their limits show up.
const CHAT_URL    = 'https://claude.ai/new';
const HELP_URL    = siteUrl('getting-started', '#troubleshooting');

// claude-monitor.com comes in the same languages as this UI (UI_BASES below,
// plus pt-BR). Spanish keeps the slugs of the first Spanish site, the rest put
// /<lang> before the English slug, and every other UI language (shown in
// English) gets the English page. Reads the language itself because it runs
// before the i18n block. Same rule as siteUrl() in options.js.
function siteUrl(page, rest = '') {
  const lang = chrome.i18n.getUILanguage();
  const base = lang.split('-')[0];
  const prefix = lang === 'pt-BR' ? '/pt-br'
    : ['es', 'de', 'fr', 'it', 'ja', 'ko'].includes(base) ? `/${base}` : '';
  const slug = prefix === '/es' && page === 'getting-started' ? 'guia-de-instalacion' : page;
  return `https://claude-monitor.com${prefix}/${slug}${rest}`;
}

// Review nudge: shown once the popup has been opened with real data on three
// distinct days; a click or dismiss hides it forever. The old 7-days-since-
// install timer fired on the first open for anyone who came back late, which
// asked for a review before the extension had proven itself.
const REVIEW_NUDGE_MIN_DAYS = 3;
// Edge runs the Chrome package but has its own store; its UA carries "Edg/".
// The Chrome link is tagged so the store dashboard can tell these visits, from
// people who already have the extension, apart from new visitors.
const REVIEW_URL = navigator.userAgent.includes('Firefox')
  ? 'https://addons.mozilla.org/firefox/addon/claude-usage-meter/reviews/'
  : navigator.userAgent.includes('Edg/')
    ? 'https://microsoftedge.microsoft.com/addons/detail/ilidbhklkpefboidlfeoiiacepcefinp'
    : 'https://chromewebstore.google.com/detail/bfhdcfiigpaaopklllpobkheakpigbfo/reviews?utm_source=extension&utm_medium=popup&utm_campaign=review';

// Pro waitlist ask: later than the review ask, so it only reaches people who
// kept using the extension. `src` tags the signup with the surface it came from.
const WAITLIST_NUDGE_MIN_DAYS = 7;
const WAITLIST_URL = siteUrl('pro', '?src=ext-popup');

// Must match FETCH_FAIL_STALE in background.js.
const FETCH_FAIL_STALE = 2;

// ── i18n ──────────────────────────────────────────────────────────────────
// Strings live in _locales/<lang>/messages.json; the browser picks the locale.
// Dates follow the UI language only where the UI is translated; otherwise an
// English UI would show, say, Arabic or Russian dates (14 store-only locales).
const UI_LANG = chrome.i18n.getUILanguage();
const UI_BASES = ['es', 'de', 'fr', 'it', 'ja', 'ko'];
const LOCALE = (UI_LANG === 'pt-BR' || UI_BASES.includes(UI_LANG.split('-')[0])) ? UI_LANG : 'en-US';

function msg(key, ...subs) {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

// 2d 3h / 3h 20m / 20m, in the UI language.
function formatDuration(totalSec) {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return msg('durDH', d, h);
  if (h > 0) return msg('durHM', h, m);
  return msg('durM', m);
}

function applyI18n() {
  // The language the page is actually shown in, which is English for the
  // store-only locales.
  document.documentElement.lang = LOCALE === 'en-US' ? 'en' : UI_LANG;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = msg(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = msg(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', msg(el.dataset.i18nAria)); });
  document.querySelectorAll('.theme-swatch').forEach(sw => sw.setAttribute('aria-label', msg('themeAria', sw.title)));
  document.querySelectorAll('#intervalSelect option').forEach(opt => { opt.textContent = msg('intervalOpt', opt.value); });
}

// The background stores these two fallback labels in English; translate them
// at display time so readings saved by older versions still render.
function labelText(label) {
  if (label === 'Not yet used') return msg('notYetUsed');
  if (label === 'Weekly limit') return msg('weeklyLimitLbl');
  return label;
}

const SUBCARDS = ['fable', 'sonnet', 'opus', 'design'];
// Per-sub-cap visibility. Tri-state: true = always show, false = always hide,
// undefined = auto (show only when the API returns data for it this week).
let cardPrefs  = {};
let lastData   = null;

// Optional cards selectable from the View menu (weekly sub-caps + daily routine).
const OPTIONAL_CARDS = [...SUBCARDS, 'routine', 'extra'];

// ── DOM refs ──────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const mainEl        = $('main');
const noDataEl      = $('noData');
const refreshBtn    = $('refreshBtn');
const lastUpdated   = $('lastUpdated');
const appVersionEl  = $('appVersion');
const planBadgeEl   = $('planBadge');
const orgSelect     = $('orgSelect');
const openUsagePage   = $('openUsagePage');
const openUsageLabel  = $('openUsageLabel');
const intervalSelect  = $('intervalSelect');
const settingsBtn     = $('settingsBtn');
const subcapNote    = $('subcapNote');

// Windows companion promo
const winPromo         = $('winPromo');
const winPromoCta      = $('winPromoCta');
const winPromoDismiss  = $('winPromoDismiss');

// Alerts nudge
const alertsNudge        = $('alertsNudge');
const alertsNudgeText    = $('alertsNudgeText');
const alertsNudgeBtn     = $('alertsNudgeBtn');
const alertsNudgeDismiss = $('alertsNudgeDismiss');

// Review nudge
const reviewNudge      = $('reviewNudge');
const reviewRateBtn    = $('reviewRateBtn');
const reviewDismissBtn = $('reviewDismissBtn');
const reviewNudgeText  = $('reviewNudgeText');

// Pro waitlist nudge
const waitlistNudge      = $('waitlistNudge');
const waitlistJoinBtn    = $('waitlistJoinBtn');
const waitlistDismissBtn = $('waitlistDismissBtn');

// What's new card
const whatsNewEl      = $('whatsNew');
const whatsNewTitle   = $('whatsNewTitle');
const whatsNewList    = $('whatsNewList');
const whatsNewBtn     = $('whatsNewBtn');
const whatsNewNote    = $('whatsNewNote');
const whatsNewDismiss = $('whatsNewDismiss');

// Pin hint
const pinHint        = $('pinHint');
const pinHintHow     = $('pinHintHow');
const pinHintDismiss = $('pinHintDismiss');

// No-data variants
const freePlanNotice   = $('freePlanNotice');
const noDataGeneric    = $('noDataGeneric');
const freePlanText      = $('freePlanText');
const freePlanActionBtn = $('freePlanActionBtn');
const emptyTitle = $('emptyTitle');
const emptyText  = $('emptyText');
const emptyBtn   = $('emptyBtn');

const PAGE_BAR_PERMS = { origins: ['https://claude.ai/*'], permissions: ['scripting'] };
let pageBarOn = false;

// Session
const sessionPct   = $('sessionPct');
const sessionBar   = $('sessionBar');
const sessionReset = $('sessionReset');
const sessionLabel = $('sessionLabel');
const sessionForecast = $('sessionForecast');
const sessionMsgs     = $('sessionMsgs');
const sessionTick     = $('sessionTick');
const sessionRingTick = $('sessionRingTick');

// Weekly
const weeklyPct   = $('weeklyPct');
const weeklyBar   = $('weeklyBar');
const weeklyReset = $('weeklyReset');
const weeklyLabel = $('weeklyLabel');
const weeklyForecast = $('weeklyForecast');
const weeklyTick     = $('weeklyTick');
const weeklyRingTick = $('weeklyRingTick');

// Sparklines
const sessionSpark = $('sessionSpark');
const weeklySpark  = $('weeklySpark');
const extraSpark   = $('extraSpark');
const sparkTip     = $('sparkTip');
const sparkToggle  = $('sparkToggle');
const paceToggle   = $('paceToggle');

// Fable
const fableCard  = $('fableCard');
const fablePct   = $('fablePct');
const fableBar   = $('fableBar');
const fableReset = $('fableReset');
const fableLabel = $('fableLabel');

// Sonnet
const sonnetCard  = $('sonnetCard');
const sonnetPct   = $('sonnetPct');
const sonnetBar   = $('sonnetBar');
const sonnetReset = $('sonnetReset');
const sonnetLabel = $('sonnetLabel');

// Opus
const opusCard  = $('opusCard');
const opusPct   = $('opusPct');
const opusBar   = $('opusBar');
const opusReset = $('opusReset');
const opusLabel = $('opusLabel');

// Design
const designCard  = $('designCard');
const designPct   = $('designPct');
const designBar   = $('designBar');
const designReset = $('designReset');
const designLabel = $('designLabel');

// Routine (daily runs)
const routineCard  = $('routineCard');
const routinePct   = $('routinePct');
const routineBar   = $('routineBar');
const routineReset = $('routineReset');
const routineMenuItem  = $('routineMenuItem');
const routineMenuCount = $('routineMenuCount');

// View menu (show/hide optional cards)
const viewWrap       = $('viewWrap');
const viewBtn        = $('viewBtn');
const viewMenu       = $('viewMenu');
const viewAllBtn     = $('viewAllBtn');
const cardsSection   = $('cardsSection');
const themeDivider   = $('themeDivider');
const themeSwatches  = $('themeSwatches');
const fableMenuItem  = $('fableMenuItem');
const sonnetMenuItem = $('sonnetMenuItem');
const opusMenuItem   = $('opusMenuItem');
const designMenuItem = $('designMenuItem');
const fableMenuPct   = $('fableMenuPct');
const sonnetMenuPct  = $('sonnetMenuPct');
const opusMenuPct    = $('opusMenuPct');
const designMenuPct  = $('designMenuPct');
const extraMenuItem  = $('extraMenuItem');
const extraMenuPct   = $('extraMenuPct');

// Banners
const extraBanner   = $('extraBanner');
const extraUsed     = $('extraUsed');
const extraCap      = $('extraCap');
const extraReset    = $('extraReset');
const extraPct      = $('extraPct');
const extraBar      = $('extraBar');
const extraBalance  = $('extraBalance');
const staleBanner   = $('staleBanner');
const staleSubtitle = $('staleBannerSubtitle');
const signInBtn     = $('signInBtn');
const fetchFailBanner   = $('fetchFailBanner');
const fetchFailSubtitle = $('fetchFailSubtitle');
const retryBtn          = $('retryBtn');
const cardsEl       = $('cards');

// Ring gauges (Mixed & Grid layouts) + the layout picker
const sessionRing    = $('sessionRing');
const sessionRingTxt = $('sessionRingTxt');
const weeklyRing     = $('weeklyRing');
const weeklyRingTxt  = $('weeklyRingTxt');
const routineRing    = $('routineRing');
const routineRingTxt = $('routineRingTxt');
const layoutOptions  = $('layoutOptions');

// ── Colour helpers ────────────────────────────────────────────────────────

function colorClass(pct) {
  if (pct < 50) return 'green';
  if (pct < 80) return 'yellow';
  return 'red';
}

function applyColor(pctEl, barEl, pct) {
  const cls = colorClass(pct);
  ['green', 'yellow', 'red'].forEach(c => {
    pctEl.classList.toggle(c, c === cls);
    barEl.classList.toggle(c, c === cls);
  });
}

// Drive a ring gauge from a percentage. pathLength=100 means the dash value is
// the raw percent ("<pct> 100"); colour uses the same thresholds as the bars.
function setRing(valEl, txtEl, pct, label) {
  if (!valEl) return;
  const p = Math.min(100, Math.max(0, Math.round(pct)));
  valEl.setAttribute('stroke-dasharray', `${p} 100`);
  ['green', 'yellow', 'red'].forEach(c => valEl.classList.toggle(c, c === colorClass(pct)));
  if (txtEl) txtEl.textContent = label;
}

// ── Theme ───────────────────────────────────────────────────────────────────

const THEMES = ['clay', 'slate', 'violet', 'midnight', 'paper', 'cool'];

function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'clay';
  document.documentElement.setAttribute('data-theme', t);
  themeSwatches?.querySelectorAll('.theme-swatch').forEach(sw => {
    const on = sw.dataset.theme === t;
    sw.classList.toggle('active', on);
    sw.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'clay';
  applyTheme(t);
  chrome.storage.local.set({ theme: t });
  mirrorTheme(t);
}

// chrome.storage is async, so the first paint would flash the default Clay
// theme before the saved one applies. Mirror the choice in localStorage and
// apply it synchronously at startup; chrome.storage stays the source of truth.
function mirrorTheme(t) {
  try { localStorage.setItem('theme', t); } catch { /* e.g. private mode */ }
}

function readThemeMirror() {
  try { return localStorage.getItem('theme'); } catch { return null; }
}

// ── Layout (Mixed / Grid / List; selectable from the View menu) ───────────────

// 'classic' is the original design (the base CSS with no layout overrides). It
// stays the default so existing users keep the UI they installed for; the other
// three are opt-in from the View menu.
const LAYOUTS = ['classic', 'hybrid', 'bento', 'list'];

function applyLayout(layout) {
  const l = LAYOUTS.includes(layout) ? layout : 'classic';
  document.documentElement.setAttribute('data-layout', l);
  layoutOptions?.querySelectorAll('.layout-option').forEach(opt => {
    opt.setAttribute('aria-pressed', opt.dataset.layout === l ? 'true' : 'false');
  });
}

function setLayout(layout) {
  const l = LAYOUTS.includes(layout) ? layout : 'classic';
  applyLayout(l);
  chrome.storage.local.set({ layout: l });
  mirrorLayout(l);
}

// Same anti-flash trick as the theme: mirror to localStorage for a synchronous
// first paint; chrome.storage stays the source of truth.
function mirrorLayout(l) {
  try { localStorage.setItem('layout', l); } catch { /* e.g. private mode */ }
}

function readLayoutMirror() {
  try { return localStorage.getItem('layout'); } catch { return null; }
}

// ── Time formatting ───────────────────────────────────────────────────────

function formatResetDate(epochMs) {
  if (!epochMs) return '';
  const d       = new Date(epochMs);
  if (LOCALE !== 'en-US') {
    return d.toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
  }
  const weekday = d.toLocaleDateString(LOCALE, { weekday: 'short' });
  const month   = d.toLocaleDateString(LOCALE, { month: 'long' });
  const time    = d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${d.getDate()} ${month} ${time}`;
}

function formatResetTime(epochMs) {
  if (!epochMs) return '';
  return new Date(epochMs).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
}

// Hour and minute when it falls today; the short weekday in front otherwise.
function formatClock(epochMs) {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${time}`;
}

function formatTimeUntil(epochMs) {
  if (!epochMs) return null;
  const diff = epochMs - Date.now();
  if (diff <= 0) return msg('resettingSoon');
  return msg('resetsIn', formatDuration(Math.floor(diff / 1000)));
}

// Usage credits reset on the 1st of each calendar month (verified: the API
// exposes no reset timestamp, and claude.ai resets on the 1st, not the billing
// date). Derive it locally; the hour is approximate (local midnight).
function firstOfNextMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function formatShortDate(epochMs) {
  const d = new Date(epochMs);
  if (LOCALE !== 'en-US') return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  return `${d.getDate()} ${d.toLocaleDateString(LOCALE, { month: 'short' })}`;
}

function formatCredits(amount, currency) {
  // Real currency symbol (€ / £ / $) via Intl, not the ISO code, and always two
  // decimals (a $5.50 spend must not render as "$5.5"). Falls back to a plain
  // prefix if the API ever sends an unknown currency code.
  const cur = (typeof currency === 'string' && currency) ? currency : 'USD';
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: 'currency',
      currency: cur,
      currencyDisplay: 'narrowSymbol',
    }).format(amount);
  } catch {
    return `${cur} ${amount.toFixed(2)}`;
  }
}

// How long ago a reading was taken: { ago } for under a day, { at } beyond that,
// null for under a minute. The footer and the stale banners phrase it differently.
function readingAge(epochMs) {
  const d = new Date(epochMs);
  const diffMin = Math.round((Date.now() - d) / 60000);
  if (diffMin < 1)  return null;
  if (diffMin < 60) return { ago: msg('durM', diffMin) };
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return { ago: msg('durH', diffH) };
  return { at: `${d.toLocaleDateString(LOCALE)} ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}` };
}

function formatTimestamp(epochMs) {
  if (!epochMs) return msg('neverUpdated');
  const age = readingAge(epochMs);
  if (!age) return msg('justUpdated');
  return age.ago ? msg('updatedAgo', age.ago) : msg('updatedAt', age.at);
}

// ── Render ────────────────────────────────────────────────────────────────

// The worker's last refresh outcome ({reason, at}) and the auth backoff, kept
// here because the empty state is picked from them.
let lastRefreshState = null;
let authBackoffState = null;

const EMPTY_STATES = {
  signedOut: { title: 'emptySignedOutTitle', text: 'emptySignedOutText', btn: 'signIn', action: 'sign-in' },
  org:       { title: 'emptyOrgTitle', text: 'emptyOrgText', btn: 'retry', action: 'retry' },
  fail:      { title: 'emptyFailTitle', btn: 'retry', action: 'retry' },
  loading:   { title: 'emptyLoading' },
};

// With no reading to show, say why, most actionable first: an expired
// claude.ai session is the top support case, and it used to hide behind a
// "load your stats" button that opened a usage page. A Free account gets the
// bar offer (its only source of figures); "loading" only while nothing has
// been tried yet. Anything left over is a read that failed.
function emptyState() {
  const reason = lastRefreshState?.reason;
  if ((authBackoffState?.fails ?? 0) > 0 || reason === 'auth-failed') return 'signedOut';
  if (reason === 'org-not-found') return 'org';
  if (currentPlan?.label === 'Free') return 'free';
  if (reason === 'api-fetch-failed' || reason === 'api-data-rejected') return 'fail';
  if (!lastRefreshState || refreshInFlight || orgSwitching) return 'loading';
  // A good read with nothing stored: the reading was just cleared (account or
  // org switch) and the next one is on its way.
  if (reason === 'ok') return 'loading';
  return 'fail';
}

function showNoData() {
  mainEl.style.display   = 'none';
  noDataEl.style.display = 'block';
  const state = emptyState();
  const free = state === 'free';
  if (freePlanNotice) freePlanNotice.style.display = free ? 'block' : 'none';
  if (noDataGeneric)  noDataGeneric.style.display  = free ? 'none' : 'block';
  if (free) { renderFreePlanNotice(); return; }
  const s = EMPTY_STATES[state];
  emptyTitle.textContent = msg(s.title);
  emptyText.textContent = s.text ? msg(s.text) : '';
  emptyText.hidden = !s.text;
  emptyBtn.textContent = s.btn ? msg(s.btn) : '';
  emptyBtn.hidden = !s.btn;
  emptyBtn.dataset.action = s.action || '';
}

// The bar is the only way to read Free-plan limits, so the notice offers it.
// Once it is on, all that is missing is a message to read them from.
function renderFreePlanNotice() {
  if (!freePlanText || !freePlanActionBtn) return;
  freePlanText.textContent = pageBarOn ? msg('freeTextOn') : msg('freeTextOff');
  freePlanActionBtn.textContent = pageBarOn ? msg('openClaude') : msg('turnOn');
}

function refreshPageBarState() {
  chrome.storage.local.get('pageBar', ({ pageBar }) => {
    chrome.permissions.contains(PAGE_BAR_PERMS, (granted) => {
      pageBarOn = Boolean(pageBar?.enabled && granted);
      if (noDataEl.style.display !== 'none') renderFreePlanNotice();
    });
  });
}

// Free-plan readings come from replies and are never refreshed in between: a
// window whose reset has passed is at 0% until the next message.
function settleStreamWindows(data) {
  if (data?.source !== 'stream') return data;
  const settle = (b) => (b?.resetTime && b.resetTime <= Date.now())
    ? { percentage: 0, resetTime: null, label: 'Not yet used' }
    : b;
  return { ...data, session: settle(data.session), weekly: settle(data.weekly) };
}

function render(data) {
  data = settleStreamWindows(data);
  if (!data) {
    // Cleared too: a reading removed on an org or account switch must not
    // come back from a later re-render.
    lastData = null;
    showNoData();
    return;
  }

  const { session, weekly, fable, sonnet, opus, design, extra, routine, prepaidBalance, lastUpdated: ts } = data;
  lastData = data;
  const hasSomething =
    session?.percentage !== null ||
    weekly?.percentage  !== null ||
    fable?.percentage   !== null ||
    sonnet?.percentage  !== null ||
    opus?.percentage    !== null ||
    design?.percentage  !== null;

  if (!hasSomething) {
    showNoData();
    return;
  }

  mainEl.style.display   = 'block';
  noDataEl.style.display = 'none';

  // ── Session ──────────────────────────────────────────────────────────
  const sPct = session?.percentage ?? null;
  if (sPct !== null) {
    const p = Math.min(100, Math.max(0, Math.round(sPct)));
    sessionPct.textContent = `${p}%`;
    sessionBar.style.width = `${p}%`;
    applyColor(sessionPct, sessionBar, sPct);
    setRing(sessionRing, sessionRingTxt, sPct, `${p}%`);
  } else {
    sessionPct.textContent = '–';
    setRing(sessionRing, sessionRingTxt, 0, '–');
  }

  const sReset   = formatTimeUntil(session?.resetTime);
  const sStarted = sReset ? formatResetTime(session?.resetTime) : '';
  sessionReset.textContent = sReset
    ? (sStarted ? `${sReset} (${sStarted})` : sReset)
    : (labelText(session?.label) || msg('resetTimeUnknown'));
  sessionLabel.textContent = '';

  // ── Weekly ───────────────────────────────────────────────────────────
  const wPct = weekly?.percentage ?? null;
  if (wPct !== null) {
    const p = Math.min(100, Math.max(0, Math.round(wPct)));
    weeklyPct.textContent = `${p}%`;
    weeklyBar.style.width = `${p}%`;
    applyColor(weeklyPct, weeklyBar, wPct);
    setRing(weeklyRing, weeklyRingTxt, wPct, `${p}%`);
  } else {
    weeklyPct.textContent = '–';
    setRing(weeklyRing, weeklyRingTxt, 0, '–');
  }

  const wReset = formatTimeUntil(weekly?.resetTime);
  const wDate  = wReset ? formatResetDate(weekly?.resetTime) : '';
  weeklyReset.textContent = wReset
    ? (wDate ? `${wReset} (${wDate})` : wReset)
    : (labelText(weekly?.label) || msg('resetDayUnknown'));
  weeklyLabel.textContent = '';

  // ── Pace forecast and messages left ─────────────────────────────────
  renderPace(data);

  // ── Weekly sub-caps (always selectable from the filter menu) ─────────
  renderSubCard('fable',  fable,  fableCard,  fablePct,  fableBar,  fableReset, weekly?.resetTime);
  renderSubCard('sonnet', sonnet, sonnetCard, sonnetPct, sonnetBar, sonnetReset, weekly?.resetTime);
  renderSubCard('opus',   opus,   opusCard,   opusPct,   opusBar,   opusReset, weekly?.resetTime);
  renderSubCard('design', design, designCard, designPct, designBar, designReset, weekly?.resetTime);

  // Compact sub-caps hide their reset rows; one shared note covers them all.
  if (subcapNote) {
    const anySubcap = [fableCard, sonnetCard, opusCard, designCard].some(el => el.style.display !== 'none');
    subcapNote.style.display = anySubcap ? 'block' : 'none';
  }

  // ── Daily routine runs (count-based; shown whenever the API returns it) ─
  renderRoutineCard(routine);

  // ── Usage credits (mirrors claude.ai /usage) ─────────────────────────
  if (extraOffered(extra) && cardVisible('extra', true)) {
    extraBanner.style.display = 'flex';
    extraUsed.textContent = formatCredits(extra.usedCredits, extra.currency);
    extraCap.textContent  = formatCredits(extra.monthlyLimit, extra.currency);

    // Show the true utilisation in text (e.g. 1302%) like /usage; clamp only the
    // bar fill. out_of_credits forces the full red "used up" treatment.
    const rawPct = Number.isFinite(extra.utilization)
      ? extra.utilization
      : (extra.usedCredits / extra.monthlyLimit) * 100;
    const barPct = Math.min(100, Math.max(0, rawPct));
    extraPct.textContent = `${Math.round(rawPct)}%`;
    extraBar.style.width = `${barPct}%`;
    applyColor(extraPct, extraBar, extra.outOfCredits ? 100 : rawPct);
    extraBanner.classList.toggle('over', Boolean(extra.outOfCredits) || rawPct >= 100);
    extraBanner.title = extra.outOfCredits ? creditsReasonText(extra.disabledReason) : '';

    extraBalance.textContent = prepaidBalance
      ? msg('balance', formatCredits(prepaidBalance.amount, prepaidBalance.currency))
      : '';

    // Prefer the API's real reset (disabled_until); else credits reset on the 1st.
    // Only if it is still ahead: disabled_until keeps the timestamp of a past
    // cycle once the account is re-enabled, and rendering it would show an
    // expired date as if the reset were imminent.
    const apiReset = Number(extra.resetTime);
    const reset  = (Number.isFinite(apiReset) && apiReset > Date.now()) ? apiReset : firstOfNextMonth();
    const xReset = formatTimeUntil(reset);
    extraReset.textContent = xReset ? `${xReset} (${formatShortDate(reset)})` : msg('resetsMonthly');
  } else {
    extraBanner.style.display = 'none';
  }

  // ── Sparklines ───────────────────────────────────────────────────────
  renderSparklines(data);

  // ── Timestamp ────────────────────────────────────────────────────────
  clearRefreshError();
  lastUpdated.textContent = formatTimestamp(ts);

  // ── Optional-cards menu ───────────────────────────────────────────────
  renderViewMenu(data);
}

// ── Pace forecast and messages left ─────────────────────────────────────────
// Both are computed by the worker (`forecast`, `msgLeft`); the popup only
// decides whether they still describe the window on screen. A forecast for a
// window that already reset, or one that went stale, would be a wrong number.

const SAME_WINDOW_MS      = 60 * 1000;          // resets_at jitters between reads
const FORECAST_MAX_AGE_MS = 30 * 60 * 1000;

let forecastState = null;
let msgLeftState  = null;

// The reset time is already on the line above, so only the forecast is shown
// here; the badge tooltip and the bar carry both (forecastLine).
function forecastText(win, bucket) {
  const now = Date.now();
  if (!win || !(Number(forecastState?.at) > now - FORECAST_MAX_AGE_MS)) return null;
  const eta = Number(win.eta);
  const reset = Number(win.reset);
  const current = Number(bucket?.resetTime);
  if (!Number.isFinite(eta) || !Number.isFinite(reset) || !Number.isFinite(current)) return null;
  if (eta <= now || eta >= reset || Math.abs(reset - current) > SAME_WINDOW_MS) return null;
  return msg('forecastAt', formatClock(eta));
}

function msgsLeftFor(session) {
  const m = msgLeftState;
  const reset = Number(session?.resetTime);
  if (!m || !Number.isFinite(m.n) || m.n < 1 || !Number.isFinite(reset) || reset <= Date.now()) return null;
  return Math.abs(Number(m.reset) - reset) <= SAME_WINDOW_MS ? m : null;
}

function setPaceRow(el, text, title) {
  if (!el) return;
  el.textContent = text || '';
  el.title = title || '';
  el.hidden = !text;
}

function renderPace(data) {
  setPaceRow(sessionForecast,
    forecastText(forecastState?.session, data?.session) || aheadText(data?.session, SPARK_SESSION_SPAN));
  setPaceRow(weeklyForecast,
    forecastText(forecastState?.weekly, data?.weekly) || aheadText(data?.weekly, SPARK_WEEKLY_SPAN));
  setPaceMark(sessionTick, sessionRingTick, evenPace(data?.session?.resetTime, SPARK_SESSION_SPAN));
  setPaceMark(weeklyTick, weeklyRingTick, evenPace(data?.weekly?.resetTime, SPARK_WEEKLY_SPAN));
  const left = msgsLeftFor(data?.session);
  setPaceRow(sessionMsgs, left && msg('msgsLeft', left.n), left && msg('msgsLeftTitle', left.basedOn));
}

// ── Pace marker ──────────────────────────────────────────────────────────────
// Where the bar would be now if the window's limit were used evenly from its
// start to its reset: the 5-hour session runs from its first message to
// resets_at, the week is the 7 days before resets_at. A fill past the mark is
// using the window faster than it lasts. Only the reset is needed, so it works
// from the first reading, Free plan included; a window that hasn't started
// (no reset yet) has no mark.

// The line under the bar says so only when the fill is well past the mark and
// the window is far enough along: the first prompts of a session always jump
// ahead of an even pace, and saying so every time would be noise.
const PACE_AHEAD_POINTS  = 10;
const PACE_AHEAD_FROM    = 25;   // % of the window gone
const PACE_RING_INNER    = 15.5; // ring stroke spans r 17 to 21 (r 19, width 4)
const PACE_RING_OUTER    = 22;   // the viewBox edge

// On by default, like the trend line.
let showPaceMarker = true;

function evenPace(resetTime, spanMs) {
  const reset = Number(resetTime);
  const now = Date.now();
  if (!Number.isFinite(reset) || reset <= now) return null;
  const gone = 1 - (reset - now) / spanMs;
  // A reset further away than one window is not this window's: no mark.
  return gone >= 0 ? Math.min(1, gone) * 100 : null;
}

function aheadText(bucket, spanMs) {
  if (!showPaceMarker) return null;
  const pct = bucket?.percentage;
  const even = evenPace(bucket?.resetTime, spanMs);
  if (pct === null || pct === undefined || even === null || pct >= 100) return null;
  if (even < PACE_AHEAD_FROM || pct - even < PACE_AHEAD_POINTS) return null;
  return msg('paceAhead', Math.round(even));
}

function setPaceMark(tickEl, ringTickEl, even) {
  const on = showPaceMarker && even !== null;
  const title = on ? msg('paceEven', Math.round(even)) : '';
  if (tickEl) {
    tickEl.hidden = !on;
    if (on) tickEl.style.left = `${even}%`;
    tickEl.parentElement.title = title;
  }
  if (ringTickEl) {
    ringTickEl.setAttribute('visibility', on ? 'visible' : 'hidden');
    if (on) {
      // The ring starts at 12 o'clock and fills clockwise.
      const angle = (even / 100) * 2 * Math.PI;
      const x = (r) => (22 + r * Math.sin(angle)).toFixed(2);
      const y = (r) => (22 - r * Math.cos(angle)).toFixed(2);
      ringTickEl.setAttribute('x1', x(PACE_RING_INNER));
      ringTickEl.setAttribute('y1', y(PACE_RING_INNER));
      ringTickEl.setAttribute('x2', x(PACE_RING_OUTER));
      ringTickEl.setAttribute('y2', y(PACE_RING_OUTER));
    }
    const ring = ringTickEl.ownerSVGElement;
    if (ring) {
      // The ring is decorative (aria-hidden); the title is for the mouse only.
      let tip = ring.querySelector('title');
      if (!tip) { tip = document.createElementNS(SVG_NS, 'title'); ring.prepend(tip); }
      tip.textContent = title;
    }
  }
}

function renderPaceToggle() {
  paceToggle?.classList.toggle('on', showPaceMarker);
}

function togglePaceMarker() {
  showPaceMarker = !showPaceMarker;
  chrome.storage.local.set({ showPaceMarker });
  renderPaceToggle();
  if (lastData) renderPace(lastData);
}

// ── Sparklines ───────────────────────────────────────────────────────────────
// Drawn from the local history series the background worker writes. The number
// says where you are; the curve says how you got there.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPARK_W = 100;
const SPARK_H = 24;
const SPARK_PAD = 1.5;                          // keeps the stroke off the edges
const SPARK_MIN_POINTS = 2;
const SPARK_SESSION_SPAN = 5 * 60 * 60 * 1000;
const SPARK_WEEKLY_SPAN  = 7 * 24 * 60 * 60 * 1000;

// A hole cuts the line, but "how long is a hole" depends on the span drawn. A
// fixed threshold would shred the weekly curve every night the browser is shut,
// so it scales with the window and only bottoms out near the sampling interval.
const SPARK_GAP_MIN_MS = 45 * 60 * 1000;
const SPARK_GAP_RATIO  = 0.08;

function gapFor(spanMs) {
  return Math.max(SPARK_GAP_MIN_MS, spanMs * SPARK_GAP_RATIO);
}

let historySeries = [];
// Samples before this belong to another org or account (set by the worker on
// a switch); they stay stored but are never drawn.
let historyCutAt = 0;
// On by default: the curve is the reason the history is collected at all.
let showSparkline = true;

for (const el of [sessionSpark, weeklySpark, extraSpark]) bindSparkHover(el);

function renderSparklines(data) {
  if (!showSparkline) {
    for (const el of [sessionSpark, weeklySpark, extraSpark]) {
      if (el) { el.style.display = 'none'; sparkMeta.delete(el); }
    }
    return;
  }
  const now = Date.now();
  const sessionFrom = windowStart(data?.session?.resetTime, SPARK_SESSION_SPAN);
  renderSpark(
    sessionSpark,
    seriesFor(sessionFrom, s => s.buckets?.session?.pct),
    // The API reports whole percentages, so light use reads 0 for a long while.
    // A flat line on the floor is honest and still looks like a broken chart.
    { max: 100, floor: 10, hideWhenFlatZero: true, gapMs: gapFor(SPARK_SESSION_SPAN),
      label: msg('sparkSession'), fmt: pctText, from: sessionFrom, to: now },
  );
  const weeklyFrom = windowStart(data?.weekly?.resetTime, SPARK_WEEKLY_SPAN);
  renderSpark(
    weeklySpark,
    seriesFor(weeklyFrom, s => s.buckets?.weekly?.pct),
    { max: 100, floor: 10, hideWhenFlatZero: true, gapMs: gapFor(SPARK_WEEKLY_SPAN),
      label: msg('sparkWeekly'), fmt: pctText, from: weeklyFrom, to: now },
  );
  const currency = data?.extra?.currency || 'USD';
  const monthStart = startOfMonth();
  renderSpark(
    extraSpark,
    seriesFor(monthStart, s => s.spend?.used),
    // Nothing spent yet draws a flat line on the floor: honest, but only noise.
    { floor: 1, hideWhenFlatZero: true, gapMs: gapFor(now - monthStart),
      label: msg('sparkSpent'), fmt: (v) => formatCredits(v, currency),
      from: monthStart, to: now },
  );
}

// Start of the live reset window, so the curve never crosses a reset: that would
// draw a cliff back to zero and read as usage dropping.
function windowStart(resetTime, spanMs) {
  const now = Date.now();
  const reset = Number(resetTime);
  return (Number.isFinite(reset) && reset > now) ? reset - spanMs : now - spanMs;
}

function seriesFor(fromTs, valueOf) {
  const out = [];
  const from = Math.max(fromTs, historyCutAt);
  for (const sample of historySeries) {
    if (!sample || !Number.isFinite(sample.t) || sample.t < from) continue;
    const raw = valueOf(sample);
    // A missing reading is a hole in the curve, never a zero.
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
    out.push({ t: sample.t, v: Number(raw) });
  }
  return out;
}

// X is anchored to the drawn window (opts.from/opts.to), not to the samples: a
// weekly curve with only a few hours of history has to stay a stub on the right,
// or it gets stretched to full width and reads exactly like the 5h session one.
// Y is the opposite call: the card already shows the exact figure, so the curve
// is scaled to its own range (with a floor) to stay readable at low usage, since
// 15% on a fixed 0-100 axis is a 3px sliver. The tooltip states the real range.
function renderSpark(el, points, opts) {
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  sparkMeta.delete(el);

  if (points.length < SPARK_MIN_POINTS) { el.style.display = 'none'; return; }
  const values = points.map(p => p.v);
  const maxV = Math.max(...values);
  const minV = Math.min(...values);
  if (opts.hideWhenFlatZero && maxV <= 0) { el.style.display = 'none'; return; }

  const top = Math.min(opts.max ?? Infinity, Math.max(opts.floor, maxV * 1.3));
  const t0 = Number.isFinite(opts.from) ? opts.from : points[0].t;
  const t1 = Number.isFinite(opts.to) ? opts.to : points[points.length - 1].t;
  const span = Math.max(t1 - t0, 1);
  // Clamped so a sample from a skewed clock can't draw outside the viewBox.
  const x = (t) => (Math.min(Math.max((t - t0) / span, 0), 1) * SPARK_W).toFixed(2);
  const y = (v) => (SPARK_PAD + (1 - Math.min(v / top, 1)) * (SPARK_H - SPARK_PAD * 2)).toFixed(2);

  sparkMeta.set(el, { points, t0, span, fmt: opts.fmt });

  for (const segment of splitOnGaps(points, opts.gapMs)) {
    const line = segment.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.v)}`).join(' ');
    if (segment.length > 1) {
      const last = segment[segment.length - 1];
      el.appendChild(sparkPath('spark-area',
        `M${x(segment[0].t)},${SPARK_H} ${line.replace(/^M/, 'L')} L${x(last.t)},${SPARK_H} Z`));
      el.appendChild(sparkPath('spark-line', line));
    } else {
      // A lone point between two gaps still deserves a mark; round caps draw it.
      el.appendChild(sparkPath('spark-line', `${line} L${x(segment[0].t)},${y(segment[0].v)}`));
    }
  }

  el.setAttribute('aria-label', msg('sparkRange', opts.label, opts.fmt(minV), opts.fmt(maxV)));
  el.style.display = 'block';
}

// ── Sparkline hover readout ──────────────────────────────────────────────────
// The curve answers "how did I get here"; hovering answers "what was it at 3:20
// exactly". It snaps to the nearest stored sample and never interpolates: every
// point on the line is a real reading, and a readout between two of them would
// be a number the extension never measured.

const sparkMeta = new WeakMap();

function bindSparkHover(el) {
  if (!el) return;
  el.addEventListener('mousemove', event => showSparkTip(el, event));
  el.addEventListener('mouseleave', () => hideSparkTip(el));
}

function nearestSample(points, t) {
  let best = points[0];
  for (const p of points) {
    if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  }
  return best;
}

// A weekly curve spans days, so the hour alone would be ambiguous there.
function sparkTipTime(t, spanMs) {
  const d = new Date(t);
  const time = d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  return spanMs > 24 * 60 * 60 * 1000
    ? `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${time}`
    : time;
}

function showSparkTip(el, event) {
  const meta = sparkMeta.get(el);
  const rect = el.getBoundingClientRect();
  if (!meta || !sparkTip || !rect.width) return;

  const frac = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
  const point = nearestSample(meta.points, meta.t0 + frac * meta.span);

  sparkTip.textContent = `${sparkTipTime(point.t, meta.span)} · ${meta.fmt(point.v)}`;
  sparkTip.hidden = false;

  // Anchored on the sample, not on the cursor, so the number and the mark on the
  // curve always point at the same reading.
  const px = rect.left + ((point.t - meta.t0) / meta.span) * rect.width;
  const maxLeft = document.documentElement.clientWidth - sparkTip.offsetWidth - 4;
  sparkTip.style.left = `${Math.round(Math.min(Math.max(px - sparkTip.offsetWidth / 2, 4), maxLeft))}px`;
  sparkTip.style.top  = `${Math.round(rect.top - sparkTip.offsetHeight - 4)}px`;
  drawSparkCursor(el, meta, point);
}

function drawSparkCursor(el, meta, point) {
  let cursor = el.querySelector('.spark-cursor');
  if (!cursor) {
    cursor = document.createElementNS(SVG_NS, 'line');
    cursor.setAttribute('class', 'spark-cursor');
    cursor.setAttribute('y1', '0');
    cursor.setAttribute('y2', String(SPARK_H));
    el.appendChild(cursor);
  }
  const cx = (((point.t - meta.t0) / meta.span) * SPARK_W).toFixed(2);
  cursor.setAttribute('x1', cx);
  cursor.setAttribute('x2', cx);
}

function hideSparkTip(el) {
  if (sparkTip) sparkTip.hidden = true;
  el.querySelector('.spark-cursor')?.remove();
}

function sparkPath(className, d) {
  const node = document.createElementNS(SVG_NS, 'path');
  node.setAttribute('class', className);
  node.setAttribute('d', d);
  return node;
}

// A hole this long means refreshes failed; the line is cut there rather than
// interpolated across data we never read.
function splitOnGaps(points, gapMs) {
  const segments = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i].t - points[i - 1].t > gapMs) {
      segments.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  segments.push(current);
  return segments;
}

function renderSparkToggle() {
  sparkToggle?.classList.toggle('on', showSparkline);
}

function toggleSparkline() {
  showSparkline = !showSparkline;
  chrome.storage.local.set({ showSparkline });
  renderSparkToggle();
  // Not guarded on lastData: hiding the curves needs no usage data, and the
  // series itself is enough to draw them back.
  renderSparklines(lastData);
}

function pctText(value) { return `${Math.round(value)}%`; }

function startOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

// ── Usage-credits helper ─────────────────────────────────────────────────────

// Short reason for the "used up" state, shown as the credits-banner tooltip.
// Mirrors the disabled_reason values seen on overage_spend_limit / extra_usage.
function creditsReasonText(reason) {
  if (reason === 'self_selected_spend_limit_reached') return msg('spendLimitMonthly');
  if (reason === 'org_level_disabled_until')          return msg('spendLimitOrg');
  return msg('spendLimit');
}

// ── Sub-card rendering ──────────────────────────────────────────────────────

// A sub-cap is offered (listed in the filter / eligible to show) only when the
// API is actually returning a weekly cap for it. The limits[] array is the
// reliable per-model signal, so we no longer assume every paid plan has every
// sub-cap: Anthropic exposes e.g. a Fable weekly cap while folding Opus and
// Sonnet into the all-models weekly limit, so those cards must not appear at 0%.
function subcapOffered(key, hasData) {
  return hasData;
}

// Tri-state visibility: explicit pref wins, otherwise show only when there's data.
function cardVisible(key, hasData) {
  const pref = cardPrefs[key];
  return pref === true ? true : pref === false ? false : hasData;
}

function renderSubCard(key, bucket, cardEl, pctEl, barEl, resetEl, weeklyResetTime) {
  const pct = bucket?.percentage ?? null;
  const hasData = pct !== null;
  if (!subcapOffered(key, hasData) || !cardVisible(key, hasData)) {
    cardEl.style.display = 'none';
    return;
  }
  cardEl.style.display = 'block';

  // The plan includes this sub-cap, so no data this week means 0% used.
  const p = hasData ? Math.min(100, Math.max(0, Math.round(pct))) : 0;
  pctEl.textContent = `${p}%`;
  barEl.style.width = `${p}%`;
  applyColor(pctEl, barEl, hasData ? pct : 0);
  setRing($(key + 'Ring'), $(key + 'RingTxt'), hasData ? pct : 0, `${p}`);

  // Sub-caps reset with the weekly window, so fall back to the weekly reset.
  const resetTime = bucket?.resetTime ?? weeklyResetTime ?? null;
  const reset = formatTimeUntil(resetTime);
  const date  = reset ? formatResetDate(resetTime) : '';
  resetEl.textContent = reset
    ? (date ? `${reset} (${date})` : reset)
    : (labelText(bucket?.label) || msg('resetDayUnknown'));
  // Compact sub-caps hide the reset row; expose it on hover instead.
  cardEl.title = resetEl.textContent;
}

// ── Routine-runs card ───────────────────────────────────────────────────────

// The plan exposes a routine budget when it returns a positive limit.
function routineOffered(routine) {
  const limit = Number(routine?.limit);
  return Number.isFinite(limit) && limit > 0;
}

// Credits banner is filter-listed only when there's a real spend limit to show.
// Unlike sub-caps it has no plan-level "offered" state: data presence is it.
function extraOffered(extra) {
  return Boolean(extra && extra.monthlyLimit > 0);
}

// Count-based (`used / limit`), not a percentage. The API returns no reset
// timestamp, so the reset is labelled generically. Offered only when the plan
// exposes a routine budget; like the sub-caps it's selectable from the View
// menu (tri-state, default shown, opt-out).
function renderRoutineCard(routine) {
  const offered = routineOffered(routine);
  if (!offered || !cardVisible('routine', offered)) {
    routineCard.style.display = 'none';
    return;
  }
  routineCard.style.display = 'block';

  const used  = Math.max(0, routine.used ?? 0);
  const limit = routine.limit;
  const pct   = Math.min(100, Math.max(0, (used / limit) * 100));
  routinePct.textContent = `${used} / ${limit}`;
  routineBar.style.width = `${pct}%`;
  applyColor(routinePct, routineBar, pct);
  setRing(routineRing, routineRingTxt, pct, `${used}`);
  routineReset.textContent = msg('resetsDaily');
  routineCard.title = msg('resetsDaily');
}

// ── Optional-cards menu ─────────────────────────────────────────────────────

function renderViewMenu(data) {
  // Only sub-caps the plan offers (or that already have data) are listed.
  const offered = {
    fable:  subcapOffered('fable',  (data?.fable?.percentage  ?? null) !== null),
    opus:   subcapOffered('opus',   (data?.opus?.percentage   ?? null) !== null),
    sonnet: subcapOffered('sonnet', (data?.sonnet?.percentage ?? null) !== null),
    design: subcapOffered('design', (data?.design?.percentage ?? null) !== null),
  };
  const routineOff = routineOffered(data?.routine);
  const extraOff   = extraOffered(data?.extra);
  const anyOffered = offered.fable || offered.opus || offered.sonnet || offered.design || routineOff || extraOff;
  // The options menu is always available (it hosts the theme picker); only the
  // card-toggle section follows the plan's sub-caps.
  if (cardsSection) cardsSection.style.display = anyOffered ? 'block' : 'none';
  if (themeDivider) themeDivider.style.display = anyOffered ? 'block' : 'none';

  updateMenuItem('fable',  offered.fable,  data?.fable?.percentage,  fableMenuItem,  fableMenuPct);
  updateMenuItem('opus',   offered.opus,   data?.opus?.percentage,   opusMenuItem,   opusMenuPct);
  updateMenuItem('sonnet', offered.sonnet, data?.sonnet?.percentage, sonnetMenuItem, sonnetMenuPct);
  updateMenuItem('design', offered.design, data?.design?.percentage, designMenuItem, designMenuPct);
  updateRoutineMenuItem(routineOff, data?.routine);
  const extraPctVal = extraOff
    ? (Number.isFinite(data.extra.utilization)
        ? data.extra.utilization
        : (data.extra.usedCredits / data.extra.monthlyLimit) * 100)
    : null;
  updateMenuItem('extra', extraOff, extraPctVal, extraMenuItem, extraMenuPct);

  if (viewAllBtn) {
    const keys = OPTIONAL_CARDS.filter(k =>
      k === 'routine' ? routineOff : k === 'extra' ? extraOff : offered[k]);
    const allShown = keys.length > 0 && keys.every(k =>
      cardVisible(k, k === 'routine' ? true
        : k === 'extra' ? extraOff
        : (data?.[k]?.percentage ?? null) !== null));
    viewAllBtn.textContent = allShown ? msg('deselectAll') : msg('selectAll');
  }
}

function updateMenuItem(key, offered, pct, itemEl, pctEl) {
  if (!itemEl) return;
  itemEl.style.display = offered ? 'flex' : 'none';
  if (!offered) return;
  const hasData = (pct ?? null) !== null;
  itemEl.classList.toggle('on', cardVisible(key, hasData));
  // Dim when nothing was used this week (no data, or a 0% reading) so an idle
  // sub-cap doesn't read as bold next to active ones.
  itemEl.classList.toggle('no-usage', !hasData || Math.round(pct) === 0);
  if (pctEl) pctEl.textContent = hasData ? `${Math.round(pct)}%` : '–';
}

// Routine has no percentage, just a used / limit count. Like the sub-caps it
// dims to a "no usage" state when nothing has run yet (used 0).
function updateRoutineMenuItem(offered, routine) {
  if (!routineMenuItem) return;
  routineMenuItem.style.display = offered ? 'flex' : 'none';
  if (!offered) return;
  routineMenuItem.classList.toggle('on', cardVisible('routine', true));
  const used  = Math.max(0, Number(routine?.used) || 0);
  const limit = Number(routine?.limit) || 0;
  routineMenuItem.classList.toggle('no-usage', used === 0);
  if (routineMenuCount) routineMenuCount.textContent = `${used} / ${limit}`;
}

function toggleCard(key) {
  if (!OPTIONAL_CARDS.includes(key)) return;
  const hasData = key === 'routine'
    ? routineOffered(lastData?.routine)
    : key === 'extra'
    ? extraOffered(lastData?.extra)
    : (lastData?.[key]?.percentage ?? null) !== null;
  // Flip current effective visibility into an explicit, persisted preference.
  cardPrefs[key] = !cardVisible(key, hasData);
  chrome.storage.local.set({ cardPrefs });
  if (lastData) render(lastData);
}

function toggleAllCards() {
  const keys = OPTIONAL_CARDS.filter(k => {
    if (k === 'routine') return routineOffered(lastData?.routine);
    if (k === 'extra')   return extraOffered(lastData?.extra);
    const pct = lastData ? (lastData[k]?.percentage ?? null) : null;
    return subcapOffered(k, pct !== null);
  });
  const allShown = keys.length > 0 && keys.every(k => {
    if (k === 'routine') return cardVisible('routine', true);
    if (k === 'extra')   return cardVisible('extra', extraOffered(lastData?.extra));
    const pct = lastData ? (lastData[k]?.percentage ?? null) : null;
    return cardVisible(k, pct !== null);
  });
  const next = !allShown;
  keys.forEach(k => { cardPrefs[k] = next; });
  chrome.storage.local.set({ cardPrefs });
  if (lastData) render(lastData);
}

function openViewMenu() {
  if (!viewMenu) return;
  viewMenu.hidden = false;
  viewBtn?.classList.add('active');
  viewBtn?.setAttribute('aria-expanded', 'true');
}

function closeViewMenu() {
  if (!viewMenu) return;
  viewMenu.hidden = true;
  viewBtn?.classList.remove('active');
  viewBtn?.setAttribute('aria-expanded', 'false');
}

// ── Stale-data banners (signed out, or refreshes failing) ─────────────────

function renderAuthState(authBackoff, fetchFailures, lastUpdatedTs) {
  const authFailing  = Boolean(authBackoff && authBackoff.fails > 0);
  // Signed out explains the stale data on its own, so it wins over this one.
  const fetchFailing = !authFailing && (fetchFailures?.count ?? 0) >= FETCH_FAIL_STALE;
  const age = lastUpdatedTs ? readingAge(lastUpdatedTs) : null;
  const subtitle = !lastUpdatedTs ? msg('noDataCaptured')
    : !age ? msg('lastUpdateNow')
    : age.ago ? msg('lastUpdateAgo', age.ago)
    : msg('lastUpdateAt', age.at);

  staleBanner.style.display = authFailing ? 'flex' : 'none';
  if (fetchFailBanner) fetchFailBanner.style.display = fetchFailing ? 'flex' : 'none';
  cardsEl?.classList.toggle('dimmed', authFailing || fetchFailing);
  if (authFailing) staleSubtitle.textContent = subtitle;
  if (fetchFailing && fetchFailSubtitle) fetchFailSubtitle.textContent = subtitle;
}

// ── Subscription badge ──────────────────────────────────────────────────────

function renderPlanBadge(plan) {
  if (!planBadgeEl) return;
  const label = plan && typeof plan === 'object' ? plan.label : null;
  // The org picker carries each org's plan, so it takes the badge's place.
  if (label && !orgPickerShown()) {
    planBadgeEl.textContent = label;
    planBadgeEl.hidden = false;
  } else {
    planBadgeEl.hidden = true;
  }
}

let currentPlan = null;

function applyPlan(plan) {
  currentPlan = plan && typeof plan === 'object' ? plan : null;
  renderPlanBadge(plan);
  renderFooterLink();
}

// The Free plan has no usage page on claude.ai, so the footer opens the chat.
function renderFooterLink() {
  if (openUsageLabel) openUsageLabel.textContent = msg(currentPlan?.label === 'Free' ? 'openClaude' : 'openUsagePage');
}

// ── Organization picker ─────────────────────────────────────────────────────
// Accounts in more than one Claude organization pick which one is read. The
// worker keeps the choice (claudeOrgPinned) and refreshes against it; the names
// come from the org list it already fetches and never leave the device.

let orgsState  = [];
let orgIdState = null;

function orgPickerShown() {
  return orgsState.length > 1;
}

function applyOrgs(orgs, orgId) {
  orgsState = Array.isArray(orgs) ? orgs.filter(o => o && typeof o.id === 'string') : [];
  orgIdState = typeof orgId === 'string' ? orgId : null;
  renderOrgSelect();
  renderPlanBadge(currentPlan);
}

function renderOrgSelect() {
  if (!orgSelect) return;
  orgSelect.hidden = !orgPickerShown();
  // The header row is ~100px wide: next to the version, the picker would show
  // little more than the plan. Which org is shown matters more here.
  if (appVersionEl) appVersionEl.hidden = !orgSelect.hidden;
  if (orgSelect.hidden) return;
  // Name first: two orgs on the same plan only differ there, and the closed
  // picker is cut at ~120px. The full text is in the tooltip.
  orgSelect.replaceChildren(...orgsState.map(o => {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = [o.name, o.plan || '?'].filter(Boolean).join(' · ');
    return opt;
  }));
  orgSelect.value = orgIdState || '';
  orgSelect.title = orgSelect.selectedOptions[0]?.textContent || msg('orgSelectTitle');
}

// ── Load from storage ─────────────────────────────────────────────────────

const STORED_KEYS = [
  'claudeUsage', 'refreshInterval', 'authBackoff', 'fetchFailures', 'cardPrefs', 'claudePlan',
  'claudeOrgs', 'claudeOrgId', 'lastRefresh', 'theme', 'layout', 'installedAt',
  'reviewNudgeDismissed', 'reviewNudgeSnoozedUntil', 'reviewMoment', 'reviewOpenDays',
  'usageHistory', 'historyCutAt', 'showSparkline', 'showPaceMarker', 'forecast', 'msgLeft', 'pageBar',
  'whatsNew', 'pinHintDismissed', 'winPromoDismissed', 'winPromoUpdate',
  'waitlistNudgeDismissed', 'notifSettings', 'alertsNudgeDismissed', 'alertsNudgeFirstSeen',
];

function loadData() {
  const manifestVersion = chrome.runtime.getManifest?.().version;
  if (appVersionEl && manifestVersion) {
    appVersionEl.textContent = `v${manifestVersion}`;
  }

  chrome.storage.local.get(STORED_KEYS, (s) => {
    historySeries = Array.isArray(s.usageHistory) ? s.usageHistory : [];
    historyCutAt = Number(s.historyCutAt) || 0;
    showSparkline = s.showSparkline !== false;   // absent means on
    showPaceMarker = s.showPaceMarker !== false;
    forecastState = s.forecast || null;
    msgLeftState = s.msgLeft || null;
    lastRefreshState = s.lastRefresh || null;
    authBackoffState = s.authBackoff || null;
    renderSparkToggle();
    renderPaceToggle();
    applyTheme(s.theme);
    if (s.theme) mirrorTheme(s.theme);
    applyLayout(s.layout);
    if (s.layout) mirrorLayout(s.layout);
    if (s.cardPrefs && typeof s.cardPrefs === 'object') {
      cardPrefs = { ...s.cardPrefs };
    }
    applyPlan(s.claudePlan);
    applyOrgs(s.claudeOrgs, s.claudeOrgId);
    refreshPageBarState();
    if (intervalSelect) intervalSelect.value = String(intervalMinutes(s.refreshInterval));
    render(s.claudeUsage || null);
    renderAuthState(s.authBackoff, s.fetchFailures, s.claudeUsage?.lastUpdated);
    refreshOnOpen(s.claudeUsage, s.authBackoff, s.lastRefresh, s.refreshInterval);
    const openDays = trackReviewOpenDay(s.reviewOpenDays, Boolean(s.claudeUsage));
    // The notices wait for the permission and toolbar checks: together they
    // decide which single notice this open gets.
    Promise.all([
      permissionGranted({ permissions: ['notifications'] }),
      permissionGranted(PAGE_BAR_PERMS),
      toolbarPinned(),
    ]).then(([notifGranted, barGranted, onToolbar]) => {
      renderNotices({
        ...s,
        openDays,
        notifGranted,
        onToolbar,
        barOn: Boolean(s.pageBar?.enabled && barGranted),
        hasData: Boolean(s.claudeUsage),
      });
    });
  });
}

function permissionGranted(perms) {
  return new Promise((resolve) => {
    chrome.permissions.contains(perms, (granted) => {
      void chrome.runtime.lastError;
      resolve(Boolean(granted));
    });
  });
}

// 1m is gone from the picker: a stored 1 reads as the 2-minute floor.
function intervalMinutes(stored) {
  const minutes = Number(stored) || 5;
  return minutes < 2 ? 2 : minutes;
}

// Opening the popup is when someone wants a number, so a missing, signed-out
// or older-than-one-interval reading is refreshed now instead of on the next
// tick. 'auto' lets the worker skip it when a forced refresh ran in the last
// minute, so reopening the popup does not hammer claude.ai.
function refreshOnOpen(usage, authBackoff, lastRefresh, refreshInterval) {
  const maxAgeMs = intervalMinutes(refreshInterval) * 60 * 1000;
  const old = !Number.isFinite(lastRefresh?.at) || Date.now() - lastRefresh.at > maxAgeMs;
  if (!usage || (authBackoff?.fails ?? 0) > 0 || old) triggerRefresh('auto');
}

// ── Notices ───────────────────────────────────────────────────────────────
// One per open: the first entry below that applies, and only with a reading on
// screen. Each nudge used to check which of the others was showing, which held
// for two of them and not for seven; a single ordered pick keeps the popup to
// one ask at a time by construction.

function renderNotices(c) {
  for (const el of [reviewNudge, whatsNewEl, alertsNudge, pinHint, winPromo, waitlistNudge]) {
    if (el) el.style.display = 'none';
  }
  // An entry this build has nothing to say about is dropped, not kept around.
  if (c.whatsNew && !WHATS_NEW[c.whatsNew.v]) chrome.storage.local.remove('whatsNew');
  if (!c.hasData) return;

  const now = Date.now();
  const reviewOpen = !c.reviewNudgeDismissed &&
    !(Number.isFinite(c.reviewNudgeSnoozedUntil) && now < c.reviewNudgeSnoozedUntil);
  const moment = c.reviewMoment;
  const freshMoment = Boolean(moment) && REVIEW_MOMENTS.includes(moment.type) &&
    Number.isFinite(moment.at) && now - moment.at < REVIEW_MOMENT_WINDOW_MS;

  const order = [
    [reviewOpen && freshMoment, () => showReviewNudge(REVIEW_COPY[moment.type])],
    [whatsNewDue(c.whatsNew), () => showWhatsNew(c.whatsNew, c.barOn)],
    [alertsNudgeDue(c.notifSettings, c.notifGranted, c.alertsNudgeDismissed, c.alertsNudgeFirstSeen),
      () => showAlertsNudge(c.notifSettings, c.alertsNudgeFirstSeen)],
    [pinHintDue(c.onToolbar, c.pinHintDismissed, c.installedAt, now), showPinHint],
    [reviewOpen && c.openDays >= REVIEW_NUDGE_MIN_DAYS, () => showReviewNudge(REVIEW_COPY.days)],
    [winPromoDue(c.installedAt, c.winPromoDismissed, c.winPromoUpdate, now), () => showWinPromo(c.winPromoUpdate)],
    [!c.waitlistNudgeDismissed && c.openDays >= WAITLIST_NUDGE_MIN_DAYS, () => { waitlistNudge.style.display = 'flex'; }],
  ];
  order.find(([due]) => due)?.[1]();
}

// ── What's new ────────────────────────────────────────────────────────────
// One entry per release that has something to tell the existing base. The
// worker arms `whatsNew` only for versions listed in its WHATS_NEW_VERSIONS.
const WHATS_NEW = {
  '1.21.0': { bullets: ['wn121Bar', 'wn121Pace', 'wn121Msgs'], barButton: true },
};
// Seen twice is enough; after that it gives the slot back on its own.
const WHATS_NEW_MAX_VIEWS = 2;

function whatsNewDue(whatsNew) {
  return Boolean(whatsNew && WHATS_NEW[whatsNew.v] && (Number(whatsNew.views) || 0) < WHATS_NEW_MAX_VIEWS);
}

function showWhatsNew(whatsNew, barOn) {
  const entry = WHATS_NEW[whatsNew.v];
  whatsNewTitle.textContent = msg('whatsNewTitle', majorMinor(whatsNew.v));
  whatsNewList.replaceChildren(...entry.bullets.slice(0, 3).map(key => {
    const li = document.createElement('li');
    li.textContent = msg(key);
    return li;
  }));
  // The base never saw the bar (it shipped off by default), so this release
  // offers it in one click; with the bar already on there is nothing to ask.
  // Chrome shows no prompt for it, so the card itself says what it reads.
  const offerBar = Boolean(entry.barButton) && !barOn;
  whatsNewBtn.hidden = !offerBar;
  if (whatsNewNote) whatsNewNote.hidden = !offerBar;
  if (offerBar) setWhatsNewBtn('bar');
  whatsNewEl.style.display = 'block';
  chrome.storage.local.set({ whatsNew: { ...whatsNew, views: (Number(whatsNew.views) || 0) + 1 } });
}

function setWhatsNewBtn(action) {
  whatsNewBtn.dataset.action = action;
  whatsNewBtn.textContent = msg(action === 'bar' ? 'wnTurnOnBar' : 'openClaude');
}

// ── Alerts nudge ──────────────────────────────────────────────────────────
// Alerts default to on, but `notifications` is optional and only a click can
// grant it, so on a fresh install they never fire. Asked for while alerts are
// still wanted and the permission is missing.
// Left alone, it gives up the slot after three calendar days on screen; the
// toggle stays in Settings. Through 1.20.2 it stayed until clicked, and while
// it showed the review ask never did.
const ALERTS_NUDGE_DAYS = 3;

function alertsNudgeDue(settings, granted, dismissed, firstSeen) {
  const today = new Date().toISOString().slice(0, 10);
  const expired = firstSeen && (Date.parse(today) - Date.parse(firstSeen)) / 86400000 >= ALERTS_NUDGE_DAYS;
  return settings?.enabled !== false && !granted && !dismissed && !expired;
}

function showAlertsNudge(settings, firstSeen) {
  if (alertsNudgeText) {
    alertsNudgeText.textContent = msg('alertsNudgeText', Number(settings?.warnAt) || 80, Number(settings?.critAt) || 95);
  }
  alertsNudge.style.display = 'flex';
  markAlertsNudgeSeen(firstSeen);
}

// The three days start on the first day the ask is actually on screen, so a
// day another notice had the slot does not count.
function markAlertsNudgeSeen(firstSeen) {
  if (firstSeen) return;
  chrome.storage.local.set({ alertsNudgeFirstSeen: new Date().toISOString().slice(0, 10) });
}

// ── Pin hint ──────────────────────────────────────────────────────────────
// The badge is the at-a-glance view, and Chrome keeps a new extension's icon
// inside the puzzle-piece menu until it is pinned. First week only.
const PIN_HINT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// true / false, or null where the browser can't tell (no getUserSettings).
function toolbarPinned() {
  try {
    if (typeof chrome.action?.getUserSettings !== 'function') return Promise.resolve(null);
    return chrome.action.getUserSettings()
      .then(s => (typeof s?.isOnToolbar === 'boolean' ? s.isOnToolbar : null), () => null);
  } catch {
    return Promise.resolve(null);
  }
}

function pinHintDue(onToolbar, dismissed, installedAt, now) {
  return onToolbar === false && !dismissed && Number.isFinite(installedAt) && now - installedAt < PIN_HINT_WINDOW_MS;
}

// The menu lists the extension under its store name, which differs per
// language, so the hint points at the icon instead. Edge pins with an eye,
// Firefox from a gear.
const PIN_HINT_HOW = navigator.userAgent.includes('Firefox') ? 'pinHintHowFirefox'
  : navigator.userAgent.includes('Edg/') ? 'pinHintHowEdge' : 'pinHintHow';

function showPinHint() {
  if (pinHintHow) pinHintHow.textContent = msg(PIN_HINT_HOW);
  pinHint.style.display = 'flex';
}

// ── Review nudge ──────────────────────────────────────────────────────────

// Counts distinct calendar days on which the popup opened with data, at most
// one tick per day. Returns the up-to-date count so render can use it directly.
function trackReviewOpenDay(stored, hasData) {
  const rec = stored && typeof stored === 'object' ? stored : { count: 0, last: null };
  if (!hasData) return rec.count;
  const today = new Date().toISOString().slice(0, 10);
  if (rec.last === today) return rec.count;
  const next = { count: rec.count + 1, last: today };
  chrome.storage.local.set({ reviewOpenDays: next });
  return next.count;
}

// The ask lands best right after the extension earned it: an alert that came
// in time, or a Free account seeing its limits for the first time. Those open
// it straight away (for a few days) and come first; otherwise the 3-day rule
// applies, further down the order.
// The 1.14 nudge only waited for days of use and got ~4 reviews in two months.
const REVIEW_MOMENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const REVIEW_SNOOZE_MS        = 14 * 24 * 60 * 60 * 1000;
const REVIEW_MOMENTS          = ['alert', 'free'];

const REVIEW_COPY = {
  alert: 'reviewAlert',
  free:  'reviewFree',
  days:  'reviewDays',
};

function showReviewNudge(copyKey) {
  if (reviewNudgeText) reviewNudgeText.textContent = msg(copyKey);
  reviewNudge.style.display = 'flex';
}

// Rating ends the ask for good. The first "not now" only snoozes it: closing a
// line in a hurry is not the same as never wanting to be asked, and the second
// close is taken as the answer.
function dismissReviewNudge({ rated = false } = {}) {
  if (reviewNudge) reviewNudge.style.display = 'none';
  if (rated) { chrome.storage.local.set({ reviewNudgeDismissed: true }); return; }
  chrome.storage.local.get('reviewNudgeSnoozedUntil', ({ reviewNudgeSnoozedUntil }) => {
    if (reviewNudgeSnoozedUntil) chrome.storage.local.set({ reviewNudgeDismissed: true });
    else chrome.storage.local.set({ reviewNudgeSnoozedUntil: Date.now() + REVIEW_SNOOZE_MS });
  });
}

// ── Windows companion promo ───────────────────────────────────────────────
// What the extension structurally cannot do: show usage with the browser shut,
// and reopen Claude Code when a limit resets. That gap is the whole pitch.

const WIN_PROMO_AFTER_MS = 14 * 24 * 60 * 60 * 1000;  // clear of the 7-day review ask
const WIN_PROMO_PRODUCT_ID = '9NNZK4V8CZM0';
const IS_WINDOWS = navigator.userAgent.includes('Windows NT');

let winPromoCid = 'ext-popup';

// cid is the only thing Partner Center's acquisitions report splits campaigns
// by, so every surface carries its own and none of them ship without one.
function winPromoUrl(cid) {
  return `https://apps.microsoft.com/detail/${WIN_PROMO_PRODUCT_ID}?cid=${cid}`;
}

// Below the review asks in the order: they feed the extension's own
// distribution and resolve in a single interaction.
function winPromoDue(installedAt, dismissed, updateVersion, now) {
  const due = updateVersion || (installedAt && (now - installedAt) >= WIN_PROMO_AFTER_MS);
  return IS_WINDOWS && !dismissed && Boolean(due);
}

function showWinPromo(updateVersion) {
  winPromoCid = updateVersion ? `ext-update-${majorMinor(updateVersion)}` : 'ext-popup';
  winPromo.style.display = 'block';
}

// 1.12.0 -> 1.12. Patch releases of the same minor are the same campaign, so the
// report stays readable instead of fragmenting into one row per build.
function majorMinor(version) {
  const parts = String(version).split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : String(version);
}

function dismissWinPromo() {
  chrome.storage.local.set({ winPromoDismissed: true });
  chrome.storage.local.remove('winPromoUpdate');
  if (winPromo) winPromo.style.display = 'none';
}

// ── Pro waitlist nudge ────────────────────────────────────────────────────
// The waitlist only lived on the landing page and collected nothing in three
// months; the people who would pay for sync are the ones opening this popup.
// Last in the order: it only gets an open no other notice wants.

function dismissWaitlistNudge() {
  chrome.storage.local.set({ waitlistNudgeDismissed: true });
  if (waitlistNudge) waitlistNudge.style.display = 'none';
}

// ── Refresh flow ──────────────────────────────────────────────────────────

let refreshInFlight = false;
let refreshErrorTimer = null;
let footerTextBeforeError = '';

function refreshErrorMessage(reason) {
  if (reason === 'auth-failed')   return msg('errAuth');
  if (reason === 'org-not-found') return msg('errOrg');
  // Not a failure: the Free plan has no usage page, so its figures only move
  // when a reply on claude.ai carries them.
  if (reason === 'free-plan')     return msg('errFree');
  if (reason === 'api-data-rejected') return msg('errRejected');
  return msg('errUnreachable');
}

function clearRefreshError() {
  if (refreshErrorTimer === null) return;
  clearTimeout(refreshErrorTimer);
  refreshErrorTimer = null;
  lastUpdated.classList.remove('error');
}

// Surface a failed manual refresh in the footer for a few seconds, then
// restore the regular "Updated …" timestamp.
function flashRefreshError(reason) {
  clearRefreshError();
  footerTextBeforeError = lastUpdated.textContent;
  lastUpdated.textContent = refreshErrorMessage(reason);
  lastUpdated.classList.add('error');
  refreshErrorTimer = setTimeout(() => {
    refreshErrorTimer = null;
    lastUpdated.classList.remove('error');
    lastUpdated.textContent = footerTextBeforeError;
  }, 3000);
}

// An org switch is a refresh too: same spinner, and the empty state reads
// "loading" meanwhile instead of flashing an error for the cleared reading.
let orgSwitching = false;

function setBusy() {
  refreshBtn.classList.toggle('spinning', refreshInFlight || orgSwitching);
  if (!lastData) showNoData();
}

// 'manual' is a click (refresh, Retry) and always reads; 'auto' is the popup
// opening, which the worker may skip as 'throttled'.
function triggerRefresh(source = 'manual') {
  if (refreshInFlight) return;
  refreshInFlight = true;
  setBusy();

  chrome.runtime.sendMessage({ type: 'REFRESH', source }, (response) => {
    const lastError = chrome.runtime.lastError; // only readable inside this callback
    refreshInFlight = false;
    // Background persists before responding; re-render from storage directly.
    chrome.storage.local.get(['claudeUsage', 'lastRefresh'], ({ claudeUsage, lastRefresh }) => {
      if (lastRefresh) lastRefreshState = lastRefresh;
      // A worker that never got to write lastRefresh (an error, or one older
      // than this popup) would leave the empty state on "loading" for good.
      else if (!lastRefreshState && response?.reason !== 'throttled') {
        lastRefreshState = { reason: response?.refreshed ? 'ok' : (response?.reason || 'api-fetch-failed'), at: Date.now() };
      }
      setBusy();
      render(claudeUsage || null);
      // Only a refresh someone asked for reports failure in the footer. On
      // open, the empty state or the stale banners already say what is wrong,
      // and a red line the moment the popup appears reads as a crash.
      if (source !== 'manual') return;
      if (lastError || !response || response.ok === false || response.refreshed === false) {
        flashRefreshError(response && response.reason);
      }
    });
  });
}

// ── Events ────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => triggerRefresh('manual'));

intervalSelect?.addEventListener('change', () => {
  const minutes = parseInt(intervalSelect.value, 10);
  chrome.runtime.sendMessage({ type: 'SET_INTERVAL', minutes }, (response) => {
    void chrome.runtime.lastError;
    // The worker clamps to its 2-60 minute range; show what it kept.
    if (response?.minutes) intervalSelect.value = String(response.minutes);
  });
});

// Picking another org: the worker validates it, pins it and refreshes against
// it, clearing the old org's reading. Disabled until it answers.
orgSelect?.addEventListener('change', () => {
  const orgId = orgSelect.value;
  if (!orgId || orgId === orgIdState) return;
  orgSelect.disabled = true;
  orgSwitching = true;
  setBusy();
  chrome.runtime.sendMessage({ type: 'SET_ORG', orgId }, () => {
    void chrome.runtime.lastError;
    orgSwitching = false;
    orgSelect.disabled = false;
    chrome.storage.local.get(['claudeUsage', 'claudeOrgs', 'claudeOrgId', 'lastRefresh'], (s) => {
      if (s.lastRefresh) lastRefreshState = s.lastRefresh;
      // Also puts the picker back on the org in use when the switch is refused.
      applyOrgs(s.claudeOrgs, s.claudeOrgId);
      setBusy();
      render(s.claudeUsage || null);
    });
  });
});

viewBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (viewMenu?.hidden) openViewMenu();
  else closeViewMenu();
});

viewMenu?.addEventListener('click', (e) => {
  // Display options carry data-opt and are not cards: "Deselect all" must not
  // sweep them, and they have no percentage to show.
  const opt = e.target.closest('[data-opt]');
  if (opt) {
    e.stopPropagation();
    if (opt.dataset.opt === 'spark') toggleSparkline();
    if (opt.dataset.opt === 'pace') togglePaceMarker();
    return;
  }
  const item = e.target.closest('.view-menu-item');
  if (!item) return;
  e.stopPropagation();
  toggleCard(item.dataset.card);
});

viewAllBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAllCards();
});

themeSwatches?.addEventListener('click', (e) => {
  const sw = e.target.closest('.theme-swatch');
  if (!sw) return;
  e.stopPropagation();
  setTheme(sw.dataset.theme);
});

layoutOptions?.addEventListener('click', (e) => {
  const opt = e.target.closest('.layout-option');
  if (!opt) return;
  e.stopPropagation();
  setLayout(opt.dataset.layout);
});

document.addEventListener('click', (e) => {
  if (viewMenu && !viewMenu.hidden && viewWrap && !viewWrap.contains(e.target)) {
    closeViewMenu();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewMenu && !viewMenu.hidden) {
    closeViewMenu();
    viewBtn?.focus();
  }
});

function openTab(url) {
  chrome.tabs.create({ url, active: true });
  window.close();
}

openUsagePage?.addEventListener('click', () => openTab(currentPlan?.label === 'Free' ? CHAT_URL : USAGE_URL));

signInBtn?.addEventListener('click', () => openTab(SIGN_IN_URL));

emptyBtn?.addEventListener('click', () => {
  if (emptyBtn.dataset.action === 'sign-in') openTab(SIGN_IN_URL);
  else triggerRefresh('manual');
});

// "Something wrong?" in the footer and in every empty state.
document.querySelectorAll('.help-link').forEach(link => {
  link.href = HELP_URL;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    openTab(HELP_URL);
  });
});

settingsBtn?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Requested straight from the click, as the permissions API requires. The ask
// only shows while alerts are on in settings, so the grant alone arms them.
alertsNudgeBtn?.addEventListener('click', () => {
  chrome.permissions.request({ permissions: ['notifications'] }, (granted) => {
    if (chrome.runtime.lastError || !granted) {
      // Firefox closes the popup when its permission prompt opens; the options
      // page hosts the same toggle and survives that.
      if (chrome.runtime.lastError) chrome.runtime.openOptionsPage();
      return;
    }
    alertsNudge.style.display = 'none';
  });
});

alertsNudgeDismiss?.addEventListener('click', () => {
  chrome.storage.local.set({ alertsNudgeDismissed: true });
  alertsNudge.style.display = 'none';
});

reviewRateBtn?.addEventListener('click', () => {
  dismissReviewNudge({ rated: true });
  chrome.tabs.create({ url: REVIEW_URL, active: true });
  window.close();
});

reviewDismissBtn?.addEventListener('click', () => dismissReviewNudge());

// Only ever opens a tab from a real click, never on its own: an unprompted tab
// is exactly what stores flag as unexpected behaviour.
winPromoCta?.addEventListener('click', () => {
  const url = winPromoUrl(winPromoCid);
  dismissWinPromo();
  chrome.tabs.create({ url, active: true });
});

winPromoDismiss?.addEventListener('click', dismissWinPromo);

waitlistJoinBtn?.addEventListener('click', () => {
  dismissWaitlistNudge();
  chrome.tabs.create({ url: WAITLIST_URL, active: true });
  window.close();
});

waitlistDismissBtn?.addEventListener('click', dismissWaitlistNudge);

// Granted without a prompt in Chrome, so the card says the bar is on before
// the button turns into a way to see it.
whatsNewBtn?.addEventListener('click', () => {
  if (whatsNewBtn.dataset.action !== 'bar') { openTab(CHAT_URL); return; }
  enablePageBar(() => {
    const li = document.createElement('li');
    li.textContent = msg('wcBarOn');
    whatsNewList.append(li);
    setWhatsNewBtn('open');
  });
});

whatsNewDismiss?.addEventListener('click', () => {
  chrome.storage.local.remove('whatsNew');
  whatsNewEl.style.display = 'none';
});

pinHintDismiss?.addEventListener('click', () => {
  chrome.storage.local.set({ pinHintDismissed: true });
  pinHint.style.display = 'none';
});

retryBtn?.addEventListener('click', () => triggerRefresh('manual'));

// Turns the on-page bar on from a click here: the Free notice and the What's
// new card. The request is the first async call in the click, as the
// permissions API requires; `pageBarRequested` goes out in the same tick so
// the worker can still switch the bar on if the popup closes during the
// prompt.
function enablePageBar(onEnabled) {
  chrome.storage.local.set({ pageBarRequested: Date.now() });
  chrome.permissions.request(PAGE_BAR_PERMS, (granted) => {
    if (chrome.runtime.lastError || !granted) {
      // Firefox closes the popup when its permission prompt opens; the options
      // page hosts the same toggle and survives that.
      if (chrome.runtime.lastError) chrome.runtime.openOptionsPage();
      return;
    }
    chrome.storage.local.set({ pageBar: { enabled: true } }, () => {
      pageBarOn = true;
      onEnabled?.();
    });
  });
}

freePlanActionBtn?.addEventListener('click', () => {
  if (pageBarOn) openTab(CHAT_URL);
  else enablePageBar(renderFreePlanNotice);
});

// Listen for storage changes while popup is open
chrome.storage.onChanged.addListener((changes) => {
  // State the renders below read, so it goes first.
  if (changes.lastRefresh) lastRefreshState = changes.lastRefresh.newValue || null;
  if (changes.authBackoff) authBackoffState = changes.authBackoff.newValue || null;
  if (changes.forecast)    forecastState = changes.forecast.newValue || null;
  if (changes.msgLeft)     msgLeftState  = changes.msgLeft.newValue || null;
  if (changes.historyCutAt) historyCutAt = Number(changes.historyCutAt.newValue) || 0;
  // The worker persists the snapshot first and appends the history sample after,
  // so the series arrives in its own event and the curves are redrawn then.
  if (changes.usageHistory) {
    historySeries = Array.isArray(changes.usageHistory.newValue) ? changes.usageHistory.newValue : [];
  }
  if ((changes.usageHistory || changes.historyCutAt) && lastData) renderSparklines(lastData);
  if (changes.claudeUsage) {
    render(changes.claudeUsage.newValue || null);
  } else if (changes.lastRefresh || changes.authBackoff) {
    // The empty state is picked from these; a reading on screen doesn't change.
    if (!lastData) showNoData();
  }
  if ((changes.forecast || changes.msgLeft) && lastData) renderPace(lastData);
  if (changes.claudeOrgs || changes.claudeOrgId) {
    chrome.storage.local.get(['claudeOrgs', 'claudeOrgId'], ({ claudeOrgs, claudeOrgId }) => applyOrgs(claudeOrgs, claudeOrgId));
  }
  if (changes.claudeUsage || changes.authBackoff || changes.fetchFailures) {
    chrome.storage.local.get(['claudeUsage', 'authBackoff', 'fetchFailures'], ({ claudeUsage, authBackoff, fetchFailures }) => {
      renderAuthState(authBackoff, fetchFailures, claudeUsage?.lastUpdated);
    });
  }
  if (changes.pageBar) refreshPageBarState();
  if (changes.claudePlan) {
    applyPlan(changes.claudePlan.newValue);
    // Also with no data yet: the plan decides which empty state is shown.
    render(lastData);
  }
  if (changes.theme) {
    applyTheme(changes.theme.newValue);
    if (changes.theme.newValue) mirrorTheme(changes.theme.newValue);
  }
  if (changes.layout) {
    applyLayout(changes.layout.newValue);
    if (changes.layout.newValue) mirrorLayout(changes.layout.newValue);
  }
  if (changes.showSparkline) {
    showSparkline = changes.showSparkline.newValue !== false;
    renderSparkToggle();
    renderSparklines(lastData);
  }
  if (changes.showPaceMarker) {
    showPaceMarker = changes.showPaceMarker.newValue !== false;
    renderPaceToggle();
    if (lastData) renderPace(lastData);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

applyI18n();
applyTheme(readThemeMirror());     // sync, pre-storage: avoids the theme flash
applyLayout(readLayoutMirror());   // same, for the layout
loadData();
