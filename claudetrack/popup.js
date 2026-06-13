// ─── Claude Usage Monitor — Popup Script ─────────────────────────────────────

const USAGE_URL   = 'https://claude.ai/settings/usage';
const SIGN_IN_URL = 'https://claude.ai/login';

const SUBCARDS = ['sonnet', 'opus', 'design'];
// Per-sub-cap visibility. Tri-state: true = always show, false = always hide,
// undefined = auto (show only when the API returns data for it this week).
let cardPrefs  = {};
let planSubcaps = {};   // which sub-caps the plan offers: { opus, sonnet, design }
let lastData   = null;

// Optional cards selectable from the View menu (weekly sub-caps + daily routine).
const OPTIONAL_CARDS = [...SUBCARDS, 'routine'];

// ── DOM refs ──────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const mainEl        = $('main');
const noDataEl      = $('noData');
const refreshBtn    = $('refreshBtn');
const lastUpdated   = $('lastUpdated');
const appVersionEl  = $('appVersion');
const planBadgeEl   = $('planBadge');
const openUsageBtn    = $('openUsageBtn');
const openUsagePage   = $('openUsagePage');
const intervalSelect  = $('intervalSelect');
const subcapNote    = $('subcapNote');

// Session
const sessionPct   = $('sessionPct');
const sessionBar   = $('sessionBar');
const sessionReset = $('sessionReset');
const sessionLabel = $('sessionLabel');

// Weekly
const weeklyPct   = $('weeklyPct');
const weeklyBar   = $('weeklyBar');
const weeklyReset = $('weeklyReset');
const weeklyLabel = $('weeklyLabel');

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
const sonnetMenuItem = $('sonnetMenuItem');
const opusMenuItem   = $('opusMenuItem');
const designMenuItem = $('designMenuItem');
const sonnetMenuPct  = $('sonnetMenuPct');
const opusMenuPct    = $('opusMenuPct');
const designMenuPct  = $('designMenuPct');

// Banners
const extraBanner   = $('extraBanner');
const extraUsed     = $('extraUsed');
const extraCap      = $('extraCap');
const extraReset    = $('extraReset');
const extraPct      = $('extraPct');
const extraBar      = $('extraBar');
const staleBanner   = $('staleBanner');
const staleSubtitle = $('staleBannerSubtitle');
const signInBtn     = $('signInBtn');
const cardsEl       = $('cards');

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

// ── Time formatting ───────────────────────────────────────────────────────

function formatResetDate(epochMs) {
  if (!epochMs) return '';
  const d       = new Date(epochMs);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month   = d.toLocaleDateString('en-US', { month: 'long' });
  const time    = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${weekday} ${d.getDate()} ${month} ${time}`;
}

function formatResetTime(epochMs) {
  if (!epochMs) return '';
  return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatTimeUntil(epochMs) {
  if (!epochMs) return null;
  const diff = epochMs - Date.now();
  if (diff <= 0) return 'Resetting soon';

  const totalSec = Math.floor(diff / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);

  if (d > 0) return `Resets in ${d}d ${h}h`;
  if (h > 0) return `Resets in ${h}h ${m}m`;
  return `Resets in ${m}m`;
}

// Usage credits reset on the 1st of each calendar month (verified: the API
// exposes no reset timestamp, and claude.ai resets on the 1st — not the billing
// date). Derive it locally; the hour is approximate (local midnight).
function firstOfNextMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

function formatShortDate(epochMs) {
  const d = new Date(epochMs);
  return `${d.getDate()} ${d.toLocaleDateString('en-US', { month: 'short' })}`;
}

function formatCredits(amount, currency) {
  const symbol = currency === 'USD' ? '$' : (currency || '');
  // Always two decimals: this is a money value, so $5.50 must not render as
  // "$5.5" and a $100 cap reads as "$100.00".
  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}`;
}

function formatTimestamp(epochMs) {
  if (!epochMs) return 'Never updated';
  const now  = new Date();
  const d    = new Date(epochMs);
  const diffMin = Math.round((now - d) / 60000);

  if (diffMin < 1)   return 'Just updated';
  if (diffMin < 60)  return `Updated ${diffMin}m ago`;

  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Updated ${diffH}h ago`;

  return `Updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Render ────────────────────────────────────────────────────────────────

function render(data) {
  if (!data) {
    mainEl.style.display   = 'none';
    noDataEl.style.display = 'block';
    return;
  }

  const { session, weekly, sonnet, opus, design, extra, routine, lastUpdated: ts } = data;
  lastData = data;
  const hasSomething =
    session?.percentage !== null ||
    weekly?.percentage  !== null ||
    sonnet?.percentage  !== null ||
    opus?.percentage    !== null ||
    design?.percentage  !== null;

  if (!hasSomething) {
    mainEl.style.display   = 'none';
    noDataEl.style.display = 'block';
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
  } else {
    sessionPct.textContent = '—';
  }

  const sReset   = formatTimeUntil(session?.resetTime);
  const sStarted = sReset ? formatResetTime(session?.resetTime) : '';
  sessionReset.textContent = sReset
    ? (sStarted ? `${sReset} (${sStarted})` : sReset)
    : (session?.label || 'Reset time unknown');
  sessionLabel.textContent = '';

  // ── Weekly ───────────────────────────────────────────────────────────
  const wPct = weekly?.percentage ?? null;
  if (wPct !== null) {
    const p = Math.min(100, Math.max(0, Math.round(wPct)));
    weeklyPct.textContent = `${p}%`;
    weeklyBar.style.width = `${p}%`;
    applyColor(weeklyPct, weeklyBar, wPct);
  } else {
    weeklyPct.textContent = '—';
  }

  const wReset = formatTimeUntil(weekly?.resetTime);
  const wDate  = wReset ? formatResetDate(weekly?.resetTime) : '';
  weeklyReset.textContent = wReset
    ? (wDate ? `${wReset} (${wDate})` : wReset)
    : (weekly?.label || 'Reset day unknown');
  weeklyLabel.textContent = '';

  // ── Weekly sub-caps (always selectable from the filter menu) ─────────
  renderSubCard('sonnet', sonnet, sonnetCard, sonnetPct, sonnetBar, sonnetReset, weekly?.resetTime);
  renderSubCard('opus',   opus,   opusCard,   opusPct,   opusBar,   opusReset, weekly?.resetTime);
  renderSubCard('design', design, designCard, designPct, designBar, designReset, weekly?.resetTime);

  // Compact sub-caps hide their reset rows; one shared note covers them all.
  if (subcapNote) {
    const anySubcap = [sonnetCard, opusCard, designCard].some(el => el.style.display !== 'none');
    subcapNote.style.display = anySubcap ? 'block' : 'none';
  }

  // ── Daily routine runs (count-based; shown whenever the API returns it) ─
  renderRoutineCard(routine);

  // ── Extra usage credits ──────────────────────────────────────────────
  if (extra && extra.isEnabled && extra.monthlyLimit > 0) {
    extraBanner.style.display = 'flex';
    extraUsed.textContent = formatCredits(extra.usedCredits, extra.currency);
    extraCap.textContent  = formatCredits(extra.monthlyLimit, extra.currency);

    const xPct = Math.min(100, Math.max(0, (extra.usedCredits / extra.monthlyLimit) * 100));
    extraPct.textContent = `${Math.round(xPct)}%`;
    extraBar.style.width = `${xPct}%`;
    applyColor(extraPct, extraBar, xPct);

    // The usage API carries no reset timestamp for credits; they reset on the
    // 1st of each month, so derive the countdown locally.
    const reset  = firstOfNextMonth();
    const xReset = formatTimeUntil(reset);
    extraReset.textContent = xReset ? `${xReset} (${formatShortDate(reset)})` : 'Resets monthly';
  } else {
    extraBanner.style.display = 'none';
  }

  // ── Timestamp ────────────────────────────────────────────────────────
  clearRefreshError();
  lastUpdated.textContent = formatTimestamp(ts);

  // ── Optional-cards menu ───────────────────────────────────────────────
  renderViewMenu(data);
}

// ── Sub-card rendering ──────────────────────────────────────────────────────

// A sub-cap is offered (listed in the filter / eligible to show) when the plan
// includes it, or when the API is already returning data for it.
function subcapOffered(key, hasData) {
  return Boolean(planSubcaps[key]) || hasData;
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

  // Sub-caps reset with the weekly window, so fall back to the weekly reset.
  const resetTime = bucket?.resetTime ?? weeklyResetTime ?? null;
  const reset = formatTimeUntil(resetTime);
  const date  = reset ? formatResetDate(resetTime) : '';
  resetEl.textContent = reset
    ? (date ? `${reset} (${date})` : reset)
    : (bucket?.label || 'Reset day unknown');
  // Compact sub-caps hide the reset row; expose it on hover instead.
  cardEl.title = resetEl.textContent;
}

// ── Routine-runs card ───────────────────────────────────────────────────────

// The plan exposes a routine budget when it returns a positive limit.
function routineOffered(routine) {
  const limit = Number(routine?.limit);
  return Number.isFinite(limit) && limit > 0;
}

// Count-based (`used / limit`), not a percentage. The API returns no reset
// timestamp, so the reset is labelled generically. Offered only when the plan
// exposes a routine budget; like the sub-caps it's selectable from the View
// menu (tri-state, default shown — opt-out).
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
  routineReset.textContent = 'Resets daily';
  routineCard.title = 'Resets daily';
}

// ── Optional-cards menu ─────────────────────────────────────────────────────

function renderViewMenu(data) {
  // Only sub-caps the plan offers (or that already have data) are listed.
  const offered = {
    opus:   subcapOffered('opus',   (data?.opus?.percentage   ?? null) !== null),
    sonnet: subcapOffered('sonnet', (data?.sonnet?.percentage ?? null) !== null),
    design: subcapOffered('design', (data?.design?.percentage ?? null) !== null),
  };
  const routineOff = routineOffered(data?.routine);
  const anyOffered = offered.opus || offered.sonnet || offered.design || routineOff;
  // The options menu is always available (it hosts the theme picker); only the
  // card-toggle section follows the plan's sub-caps.
  if (cardsSection) cardsSection.style.display = anyOffered ? 'block' : 'none';
  if (themeDivider) themeDivider.style.display = anyOffered ? 'block' : 'none';

  updateMenuItem('opus',   offered.opus,   data?.opus?.percentage,   opusMenuItem,   opusMenuPct);
  updateMenuItem('sonnet', offered.sonnet, data?.sonnet?.percentage, sonnetMenuItem, sonnetMenuPct);
  updateMenuItem('design', offered.design, data?.design?.percentage, designMenuItem, designMenuPct);
  updateRoutineMenuItem(routineOff, data?.routine);

  if (viewAllBtn) {
    const keys = OPTIONAL_CARDS.filter(k => k === 'routine' ? routineOff : offered[k]);
    const allShown = keys.length > 0 && keys.every(k =>
      cardVisible(k, k === 'routine' ? true : (data?.[k]?.percentage ?? null) !== null));
    viewAllBtn.textContent = allShown ? 'Deselect all' : 'Select all';
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
  if (pctEl) pctEl.textContent = hasData ? `${Math.round(pct)}%` : '—';
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
    : (lastData?.[key]?.percentage ?? null) !== null;
  // Flip current effective visibility into an explicit, persisted preference.
  cardPrefs[key] = !cardVisible(key, hasData);
  chrome.storage.local.set({ cardPrefs });
  if (lastData) render(lastData);
}

function toggleAllCards() {
  const keys = OPTIONAL_CARDS.filter(k => {
    if (k === 'routine') return routineOffered(lastData?.routine);
    const pct = lastData ? (lastData[k]?.percentage ?? null) : null;
    return subcapOffered(k, pct !== null);
  });
  const allShown = keys.length > 0 && keys.every(k => {
    if (k === 'routine') return cardVisible('routine', true);
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

// ── Auth-failed banner ────────────────────────────────────────────────────

function renderAuthState(authBackoff, lastUpdatedTs) {
  const failing = Boolean(authBackoff && authBackoff.fails > 0);
  if (!failing) {
    staleBanner.style.display = 'none';
    cardsEl?.classList.remove('dimmed');
    return;
  }
  staleBanner.style.display = 'flex';
  cardsEl?.classList.add('dimmed');
  staleSubtitle.textContent = lastUpdatedTs
    ? `Last update ${formatTimestamp(lastUpdatedTs).replace(/^Updated\s+/, '')}`
    : 'No data captured yet';
}

// ── Subscription badge ──────────────────────────────────────────────────────

function renderPlanBadge(plan) {
  if (!planBadgeEl) return;
  const label = plan && typeof plan === 'object' ? plan.label : null;
  if (label) {
    planBadgeEl.textContent = label;
    planBadgeEl.hidden = false;
  } else {
    planBadgeEl.hidden = true;
  }
}

function applyPlan(plan) {
  planSubcaps = (plan && plan.subcaps && typeof plan.subcaps === 'object') ? plan.subcaps : {};
  renderPlanBadge(plan);
}

// ── Load from storage ─────────────────────────────────────────────────────

function loadData() {
  const manifestVersion = chrome.runtime.getManifest?.().version;
  if (appVersionEl && manifestVersion) {
    appVersionEl.textContent = `v${manifestVersion}`;
  }

  chrome.storage.local.get(
    ['claudeUsage', 'refreshInterval', 'authBackoff', 'cardPrefs', 'claudePlan', 'theme'],
    ({ claudeUsage, refreshInterval, authBackoff, cardPrefs: storedPrefs, claudePlan, theme }) => {
      applyTheme(theme);
      if (theme) mirrorTheme(theme);
      if (storedPrefs && typeof storedPrefs === 'object') {
        cardPrefs = { ...storedPrefs };
      }
      applyPlan(claudePlan);
      if (intervalSelect) intervalSelect.value = String(refreshInterval || 5);
      render(claudeUsage || null);
      renderAuthState(authBackoff, claudeUsage?.lastUpdated);
    }
  );
}

// ── Refresh flow ──────────────────────────────────────────────────────────

let refreshInFlight = false;
let refreshErrorTimer = null;
let footerTextBeforeError = '';

function refreshErrorMessage(reason) {
  if (reason === 'auth-failed')   return 'Refresh failed: sign in to claude.ai';
  if (reason === 'org-not-found') return 'Refresh failed: no organization found';
  return 'Refresh failed: claude.ai unreachable';
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

function triggerRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshBtn.classList.add('spinning');

  chrome.runtime.sendMessage({ type: 'REFRESH' }, (response) => {
    const lastError = chrome.runtime.lastError; // only readable inside this callback
    refreshInFlight = false;
    refreshBtn.classList.remove('spinning');
    // Background persists before responding; re-render from storage directly.
    chrome.storage.local.get('claudeUsage', ({ claudeUsage }) => {
      render(claudeUsage || null);
      if (lastError || !response || response.ok === false || response.refreshed === false) {
        flashRefreshError(response && response.reason);
      }
    });
  });
}

// ── Events ────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', triggerRefresh);

intervalSelect?.addEventListener('change', () => {
  const minutes = parseInt(intervalSelect.value, 10);
  chrome.runtime.sendMessage({ type: 'SET_INTERVAL', minutes });
});

viewBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (viewMenu?.hidden) openViewMenu();
  else closeViewMenu();
});

viewMenu?.addEventListener('click', (e) => {
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

function openUsage() {
  chrome.tabs.create({ url: USAGE_URL, active: true });
  window.close();
}

openUsageBtn?.addEventListener('click', openUsage);
openUsagePage?.addEventListener('click', openUsage);

signInBtn?.addEventListener('click', () => {
  chrome.tabs.create({ url: SIGN_IN_URL, active: true });
  window.close();
});

// Listen for storage changes while popup is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.claudeUsage) {
    render(changes.claudeUsage.newValue || null);
  }
  if (changes.claudeUsage || changes.authBackoff) {
    chrome.storage.local.get(['claudeUsage', 'authBackoff'], ({ claudeUsage, authBackoff }) => {
      renderAuthState(authBackoff, claudeUsage?.lastUpdated);
    });
  }
  if (changes.claudePlan) {
    applyPlan(changes.claudePlan.newValue);
    if (lastData) render(lastData);
  }
  if (changes.theme) {
    applyTheme(changes.theme.newValue);
    if (changes.theme.newValue) mirrorTheme(changes.theme.newValue);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

applyTheme(readThemeMirror());   // sync, pre-storage — avoids the theme flash
loadData();
