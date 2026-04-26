// ─── ClaudeTrack — Background Service Worker ───────────────────────────────
// Polls claude.ai/settings/usage every 5 minutes, parses usage data via a
// content script, persists it to chrome.storage.local, and updates the badge.

const API_BASE   = 'https://claude.ai/api';
const ALARM_NAME = 'claudetrack-poll';
const POLL_MIN   = 5;   // minutes between automatic refreshes

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
  refreshUsage();   // fetch immediately on install/update
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  refreshUsage();
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
    refreshUsage();
  }
});

// ── Manual refresh triggered from popup ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'REFRESH') {
    refreshUsage().then((result) => sendResponse({ ok: true, ...result }));
    return true;
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

// ── Core refresh logic ────────────────────────────────────────────────────

async function refreshUsage() {
  // Primary path: internal Claude API (works when user is logged in)
  const apiResult = await refreshUsageFromApi();
  if (apiResult.refreshed) return { ...apiResult, source: 'api' };

  // Fallback: inject into an already-open usage tab (never open one automatically)
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
  if (tabs.length > 0) {
    await injectIntoTab(tabs[0].id);
    return { refreshed: true, source: 'existing-tab' };
  }

  return { refreshed: false, reason: 'no-usage-tab-open' };
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (_e) {
    // injection fails when the tab navigates away — silently skip
  }
}

async function refreshUsageFromApi() {
  try {
    const orgId = await getClaudeOrgId();
    if (!orgId) {
      return { refreshed: false, reason: 'org-not-found' };
    }

    let usage;
    try {
      usage = await fetchClaudeJson(`${API_BASE}/organizations/${orgId}/usage`);
    } catch (error) {
      if (String(error?.message || '').startsWith('http-404')) {
        await chrome.storage.local.remove('claudeOrgId');
        const retriedOrgId = await getClaudeOrgId();
        if (!retriedOrgId) throw error;
        usage = await fetchClaudeJson(`${API_BASE}/organizations/${retriedOrgId}/usage`);
      } else {
        throw error;
      }
    }

    const data = mapApiUsageToStoredShape(usage);
    const stored = await persistAndBadge(data);
    return {
      refreshed: stored,
      reason: stored ? undefined : 'api-data-rejected',
    };
  } catch (error) {
    return { refreshed: false, reason: 'api-fetch-failed', error: String(error?.message || error) };
  }
}

async function getClaudeOrgId() {
  const { claudeOrgId } = await chrome.storage.local.get('claudeOrgId');
  if (claudeOrgId) return claudeOrgId;

  const organizations = await fetchClaudeJson(`${API_BASE}/organizations`);
  const orgId = selectOrgId(organizations);
  if (orgId) {
    await chrome.storage.local.set({ claudeOrgId: orgId });
  }
  return orgId;
}

function selectOrgId(payload) {
  if (Array.isArray(payload) && payload.length > 0) {
    return payload[0]?.uuid || payload[0]?.organization_uuid || payload[0]?.id || null;
  }

  if (Array.isArray(payload?.organizations) && payload.organizations.length > 0) {
    const org = payload.organizations[0];
    return org?.uuid || org?.organization_uuid || org?.id || null;
  }

  return null;
}

async function fetchClaudeJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/plain, */*',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`auth-${response.status}`);
  }

  if (!response.ok) {
    throw new Error(`http-${response.status}`);
  }

  return response.json();
}

function mapApiUsageToStoredShape(usage) {
  return {
    session: {
      percentage: normalizePct(usage?.five_hour?.utilization),
      resetTime: parseApiTime(usage?.five_hour?.resets_at),
      label: usage?.five_hour?.resets_at ? null : 'Current session',
    },
    weekly: {
      percentage: normalizePct(usage?.seven_day?.utilization),
      resetTime: parseApiTime(usage?.seven_day?.resets_at),
      label: usage?.seven_day?.resets_at ? null : 'Weekly limit',
    },
    design: {
      percentage: normalizePct(usage?.seven_day_omelette?.utilization),
      resetTime: parseApiTime(usage?.seven_day_omelette?.resets_at),
      label: usage?.seven_day_omelette?.resets_at ? null : 'Not yet used',
    },
    meta: {
      ready: normalizePct(usage?.five_hour?.utilization) !== null,
      confidence: 'high',
      sessionSource: 'api',
      weeklySource: 'api',
      designSource: 'api',
      foundSessionMarker: true,
      foundWeeklyMarker: true,
      foundDesignMarker: true,
      textPercentageCount: 0,
    },
  };
}

function parseApiTime(value) {
  if (!value) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
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
