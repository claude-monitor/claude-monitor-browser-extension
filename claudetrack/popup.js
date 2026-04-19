// ─── Claude Usage Monitor — Popup Script ─────────────────────────────────────

const USAGE_URL = 'https://claude.ai/settings/usage';
const PLAN      = 'free';

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
  const d = new Date(epochMs);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month   = d.toLocaleDateString('en-US', { month: 'long' });
  return `${weekday} ${d.getDate()} ${month}`;
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

  const { session, weekly, lastUpdated: ts } = data;
  const hasSomething = session?.percentage !== null || weekly?.percentage !== null;

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
    ? (sStarted ? `${sReset} · ${sStarted}` : sReset)
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
    ? (wDate ? `${wReset} · ${wDate}` : wReset)
    : (weekly?.label || 'Reset day unknown');
  weeklyLabel.textContent = '';

  // ── Timestamp ────────────────────────────────────────────────────────
  lastUpdated.textContent = formatTimestamp(ts);
}

// ── Load from storage ─────────────────────────────────────────────────────

function loadData() {
  const manifestVersion = chrome.runtime.getManifest?.().version;
  if (appVersionEl && manifestVersion) {
    appVersionEl.textContent = `v${manifestVersion}`;
  }

  chrome.storage.local.get(['claudeUsage', 'refreshInterval'], ({ claudeUsage, refreshInterval }) => {
    if (intervalSelect) intervalSelect.value = String(refreshInterval || 5);
    render(claudeUsage || null);
  });
}

// ── Refresh flow ──────────────────────────────────────────────────────────

let refreshInFlight = false;

function triggerRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshBtn.classList.add('spinning');

  chrome.runtime.sendMessage({ type: 'REFRESH' }, () => {
    if (chrome.runtime.lastError) {
      refreshInFlight = false;
      refreshBtn.classList.remove('spinning');
      return;
    }

    let waited = 0;
    const poll = setInterval(() => {
      waited += 500;
      chrome.storage.local.get('claudeUsage', ({ claudeUsage }) => {
        if (claudeUsage?.lastUpdated > (Date.now() - 10000) || waited >= 8000) {
          clearInterval(poll);
          refreshInFlight = false;
          refreshBtn.classList.remove('spinning');
          render(claudeUsage || null);
        }
      });
    }, 500);
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

// Listen for storage changes while popup is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.claudeUsage) {
    render(changes.claudeUsage.newValue || null);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────

loadData();
initPlan();
