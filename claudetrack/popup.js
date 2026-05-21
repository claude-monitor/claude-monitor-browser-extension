// ─── Claude Usage Monitor — Popup Script ─────────────────────────────────────

const USAGE_URL   = 'https://claude.ai/settings/usage';
const SIGN_IN_URL = 'https://claude.ai/login';
const PLAN        = 'free';

// ── DOM refs ──────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const mainEl        = $('main');
const noDataEl      = $('noData');
const refreshBtn    = $('refreshBtn');
const lastUpdated   = $('lastUpdated');
const appVersionEl  = $('appVersion');
const openUsageBtn    = $('openUsageBtn');
const openUsagePage   = $('openUsagePage');
const intervalSelect  = $('intervalSelect');
const proTeaser     = $('proTeaser');

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

// Banners
const extraBanner   = $('extraBanner');
const extraUsed     = $('extraUsed');
const extraCap      = $('extraCap');
const staleBanner   = $('staleBanner');
const staleSubtitle = $('staleBannerSubtitle');
const signInBtn     = $('signInBtn');
const cardsEl       = $('cards');

// ── Plan management ───────────────────────────────────────────────────────

function initPlan() {
  if (PLAN === 'pro') {
    if (proTeaser) proTeaser.style.display = 'none';
    initProFeatures();
  } else {
    if (proTeaser) proTeaser.style.display = 'flex';
  }
}

function initProFeatures() {
  // Reserved for pro tier
}

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

function formatCredits(amount, currency) {
  const symbol = currency === 'USD' ? '$' : (currency || '');
  // Whole dollars when amount is integer, two decimals otherwise.
  const rounded = Number.isInteger(amount) ? amount : Number(amount.toFixed(2));
  const formatted = rounded.toLocaleString('en-US');
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

  const { session, weekly, sonnet, opus, design, extra, lastUpdated: ts } = data;
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

  // ── Sonnet weekly ────────────────────────────────────────────────────
  const snPct = sonnet?.percentage ?? null;
  if (snPct !== null) {
    sonnetCard.style.display = 'block';
    const p = Math.min(100, Math.max(0, Math.round(snPct)));
    sonnetPct.textContent = `${p}%`;
    sonnetBar.style.width = `${p}%`;
    applyColor(sonnetPct, sonnetBar, snPct);
    const snReset = formatTimeUntil(sonnet?.resetTime);
    const snDate  = snReset ? formatResetDate(sonnet?.resetTime) : '';
    sonnetReset.textContent = snReset
      ? (snDate ? `${snReset} (${snDate})` : snReset)
      : (sonnet?.label || 'Reset time unknown');
    sonnetLabel.textContent = '';
  } else {
    sonnetCard.style.display = 'none';
  }

  // ── Opus weekly ──────────────────────────────────────────────────────
  const oPct = opus?.percentage ?? null;
  if (oPct !== null) {
    opusCard.style.display = 'block';
    const p = Math.min(100, Math.max(0, Math.round(oPct)));
    opusPct.textContent = `${p}%`;
    opusBar.style.width = `${p}%`;
    applyColor(opusPct, opusBar, oPct);
    const oReset = formatTimeUntil(opus?.resetTime);
    const oDate  = oReset ? formatResetDate(opus?.resetTime) : '';
    opusReset.textContent = oReset
      ? (oDate ? `${oReset} (${oDate})` : oReset)
      : (opus?.label || 'Reset time unknown');
    opusLabel.textContent = '';
  } else {
    opusCard.style.display = 'none';
  }

  // ── Design ───────────────────────────────────────────────────────────
  const dPct = design?.percentage ?? null;
  if (dPct !== null) {
    designCard.style.display = 'block';
    const p = Math.min(100, Math.max(0, Math.round(dPct)));
    designPct.textContent = `${p}%`;
    designBar.style.width = `${p}%`;
    applyColor(designPct, designBar, dPct);
    const dReset = formatTimeUntil(design?.resetTime);
    const dDate  = dReset ? formatResetDate(design?.resetTime) : '';
    designReset.textContent = dReset
      ? (dDate ? `${dReset} (${dDate})` : dReset)
      : (design?.label || 'Reset time unknown');
    designLabel.textContent = '';
  } else {
    designCard.style.display = 'none';
  }

  // ── Extra usage credits ──────────────────────────────────────────────
  if (extra && extra.isEnabled && extra.monthlyLimit > 0) {
    extraBanner.style.display = 'flex';
    extraUsed.textContent = formatCredits(extra.usedCredits, extra.currency);
    extraCap.textContent  = formatCredits(extra.monthlyLimit, extra.currency);
  } else {
    extraBanner.style.display = 'none';
  }

  // ── Timestamp ────────────────────────────────────────────────────────
  lastUpdated.textContent = formatTimestamp(ts);
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

// ── Load from storage ─────────────────────────────────────────────────────

function loadData() {
  const manifestVersion = chrome.runtime.getManifest?.().version;
  if (appVersionEl && manifestVersion) {
    appVersionEl.textContent = `v${manifestVersion}`;
  }

  chrome.storage.local.get(
    ['claudeUsage', 'refreshInterval', 'authBackoff'],
    ({ claudeUsage, refreshInterval, authBackoff }) => {
      if (intervalSelect) intervalSelect.value = String(refreshInterval || 5);
      render(claudeUsage || null);
      renderAuthState(authBackoff, claudeUsage?.lastUpdated);
    }
  );
}

// ── Refresh flow ──────────────────────────────────────────────────────────

let refreshInFlight = false;

function triggerRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshBtn.classList.add('spinning');

  chrome.runtime.sendMessage({ type: 'REFRESH' }, () => {
    refreshInFlight = false;
    refreshBtn.classList.remove('spinning');
    // Background persists before responding; re-render from storage directly.
    chrome.storage.local.get('claudeUsage', ({ claudeUsage }) => {
      render(claudeUsage || null);
    });
  });
}

// ── Events ────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', triggerRefresh);

intervalSelect?.addEventListener('change', () => {
  const minutes = parseInt(intervalSelect.value, 10);
  chrome.runtime.sendMessage({ type: 'SET_INTERVAL', minutes });
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
});

// ── Init ──────────────────────────────────────────────────────────────────

loadData();
initPlan();
