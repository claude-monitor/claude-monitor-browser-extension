// ─── ClaudeTrack — Background Service Worker ───────────────────────────────
// Receives usage data from the content script (injected into settings/usage),
// persists it to chrome.storage.local, and updates the badge.

const ALARM_NAME = 'claudetrack-poll';
const POLL_MIN   = 5;   // minutes between badge refreshes from cache

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

async function setupAlarm() {
  const { refreshInterval } = await chrome.storage.local.get('refreshInterval');
  const interval = refreshInterval || POLL_MIN;
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshBadge();
  }
});

// ── Manual refresh triggered from popup ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'REFRESH') {
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'SET_INTERVAL') {
    const minutes = msg.minutes;
    chrome.storage.local.set({ refreshInterval: minutes }).then(() => {
      chrome.alarms.clear(ALARM_NAME, () => {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
        sendResponse({ ok: true });
      });
    });
    return true;
  }
  if (msg.type === 'USAGE_DATA') {
    // Forwarded from the content script via tab messaging
    persistAndBadge(msg.data).then((stored) => sendResponse({ ok: true, stored }));
    return true;
  }
});

// ── Badge refresh from cache ──────────────────────────────────────────────

async function refreshBadge() {
  const { claudeUsage } = await chrome.storage.local.get('claudeUsage');
  if (claudeUsage) updateBadge(claudeUsage);
}

// ── Badge helpers ─────────────────────────────────────────────────────────

async function persistAndBadge(data) {
  const next = sanitizeUsageData(data);
  if (!next) return false;

  const { claudeUsage: current } = await chrome.storage.local.get('claudeUsage');
  if (!shouldPersist(next, current)) {
    return false;
  }

  next.lastUpdated = Date.now();
  await chrome.storage.local.set({ claudeUsage: next });
  updateBadge(next);
  return true;
}

function sanitizeUsageData(data) {
  if (!data || typeof data !== 'object') return null;

  const clone = {
    session: {
      percentage: normalizePct(data.session?.percentage),
      resetTime: data.session?.resetTime ?? null,
      label: data.session?.label ?? null,
    },
    weekly: {
      percentage: normalizePct(data.weekly?.percentage),
      resetTime: data.weekly?.resetTime ?? null,
      label: data.weekly?.label ?? null,
    },
    design: {
      percentage: normalizePct(data.design?.percentage),
      resetTime: data.design?.resetTime ?? null,
      label: data.design?.label ?? null,
    },
    meta: {
      ready: Boolean(data.meta?.ready),
      confidence: data.meta?.confidence || 'low',
      sessionSource: data.meta?.sessionSource || null,
      weeklySource: data.meta?.weeklySource || null,
      foundSessionMarker: Boolean(data.meta?.foundSessionMarker),
      foundWeeklyMarker: Boolean(data.meta?.foundWeeklyMarker),
      textPercentageCount: Number.isFinite(data.meta?.textPercentageCount) ? data.meta.textPercentageCount : 0,
    },
  };

  if (clone.session.percentage === null && clone.weekly.percentage === null) return null;
  return clone;
}

function normalizePct(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 100) return null;
  return num;
}

function confidenceRank(level) {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

function shouldPersist(next, current) {
  if (!next?.meta?.ready || next.session?.percentage === null) return false;
  if (!current) return true;

  const nextRank = confidenceRank(next.meta?.confidence);
  const currentRank = confidenceRank(current.meta?.confidence);
  const nextSession = next.session?.percentage;
  const currentSession = current.session?.percentage;

  if (currentSession === null) return true;
  if (nextRank > currentRank) return true;
  if (nextRank === currentRank) return true;

  const drop = currentSession - nextSession;
  if (drop >= 20) return false;

  return true;
}

function updateBadge(data) {
  const pct = data?.session?.percentage ?? null;

  if (pct === null) {
    chrome.action.setBadgeText({ text: '?' });
    chrome.action.setBadgeBackgroundColor({ color: '#555555' });
    return;
  }

  chrome.action.setBadgeText({ text: `${Math.round(pct)}%` });

  let color;
  if (pct < 50)       color = '#22c55e';   // green
  else if (pct < 80)  color = '#f59e0b';   // yellow/amber
  else                color = '#ef4444';   // red

  chrome.action.setBadgeBackgroundColor({ color });
}

// ── Restore badge on startup from cached data ────────────────────────────

chrome.storage.local.get('claudeUsage', ({ claudeUsage }) => {
  if (claudeUsage) updateBadge(claudeUsage);
});
