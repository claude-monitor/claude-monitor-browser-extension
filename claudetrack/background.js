// ─── ClaudeTrack — Background Service Worker ───────────────────────────────
// Polls claude.ai/settings/usage every 5 minutes, parses usage data via a
// content script, persists it to chrome.storage.local, and updates the badge.

const API_BASE   = 'https://claude.ai/api';
const ALARM_NAME = 'claudetrack-poll';
const POLL_MIN   = 5;   // minutes between automatic refreshes

const ORG_ID_TTL_MS    = 24 * 60 * 60 * 1000; // re-validate cached orgId once a day
const AUTH_BACKOFF_MAX = 6;                    // cap consecutive auth-failure skips

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
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== interval) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  }
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
  if (await shouldSkipForAuthBackoff()) {
    return { refreshed: false, reason: 'auth-backoff' };
  }
  const apiResult = await refreshUsageFromApi();
  if (apiResult.refreshed) {
    await clearAuthBackoff();
    return { ...apiResult, source: 'api' };
  }
  if (apiResult.reason === 'auth-failed') {
    await bumpAuthBackoff();
  }
  return { refreshed: false, reason: apiResult.reason || 'api-fetch-failed' };
}

async function shouldSkipForAuthBackoff() {
  const { authBackoff } = await chrome.storage.local.get('authBackoff');
  if (!authBackoff) return false;
  // Skip 2^fails ticks (capped). With 5-min polls and AUTH_BACKOFF_MAX=6 that's up to ~5h.
  const skipsRemaining = authBackoff.skipsRemaining ?? 0;
  if (skipsRemaining > 0) {
    await chrome.storage.local.set({
      authBackoff: { ...authBackoff, skipsRemaining: skipsRemaining - 1 },
    });
    return true;
  }
  return false;
}

async function bumpAuthBackoff() {
  const { authBackoff } = await chrome.storage.local.get('authBackoff');
  const fails = Math.min((authBackoff?.fails ?? 0) + 1, AUTH_BACKOFF_MAX);
  const skipsRemaining = Math.pow(2, fails) - 1; // 1, 3, 7, 15, 31, 63
  await chrome.storage.local.set({ authBackoff: { fails, skipsRemaining } });
}

async function clearAuthBackoff() {
  await chrome.storage.local.remove('authBackoff');
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
        await chrome.storage.local.remove(['claudeOrgId', 'claudeOrgIdAt']);
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
    const msg = String(error?.message || error);
    const reason = msg.startsWith('auth-') ? 'auth-failed' : 'api-fetch-failed';
    return { refreshed: false, reason, error: msg };
  }
}

async function getClaudeOrgId() {
  const { claudeOrgId, claudeOrgIdAt } = await chrome.storage.local.get(['claudeOrgId', 'claudeOrgIdAt']);
  const fresh = claudeOrgIdAt && (Date.now() - claudeOrgIdAt) < ORG_ID_TTL_MS;
  if (claudeOrgId && fresh) return claudeOrgId;

  const organizations = await fetchClaudeJson(`${API_BASE}/organizations`);
  const orgId = selectOrgId(organizations);
  if (orgId) {
    await chrome.storage.local.set({ claudeOrgId: orgId, claudeOrgIdAt: Date.now() });
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
    opus: {
      percentage: normalizePct(usage?.seven_day_opus?.utilization),
      resetTime: parseApiTime(usage?.seven_day_opus?.resets_at),
      label: usage?.seven_day_opus?.resets_at ? null : 'Not yet used',
    },
    sonnet: {
      percentage: normalizePct(usage?.seven_day_sonnet?.utilization),
      resetTime: parseApiTime(usage?.seven_day_sonnet?.resets_at),
      label: usage?.seven_day_sonnet?.resets_at ? null : 'Not yet used',
    },
    design: {
      percentage: normalizePct(usage?.seven_day_omelette?.utilization),
      resetTime: parseApiTime(usage?.seven_day_omelette?.resets_at),
      label: usage?.seven_day_omelette?.resets_at ? null : 'Not yet used',
    },
    extra: mapExtraUsage(usage?.extra_usage),
    meta: {
      ready:
        normalizePct(usage?.five_hour?.utilization) !== null ||
        normalizePct(usage?.seven_day?.utilization) !== null,
      confidence: 'high',
      sessionSource: 'api',
      weeklySource: 'api',
      opusSource: 'api',
      sonnetSource: 'api',
      designSource: 'api',
      foundSessionMarker: true,
      foundWeeklyMarker: true,
      foundOpusMarker: true,
      foundSonnetMarker: true,
      foundDesignMarker: true,
      textPercentageCount: 0,
    },
  };
}

function mapExtraUsage(extra) {
  if (!extra || typeof extra !== 'object') return null;
  if (extra.used_credits == null || extra.monthly_limit == null) return null;
  const usedCredits = Number(extra.used_credits);
  const monthlyLimit = Number(extra.monthly_limit);
  if (!Number.isFinite(usedCredits) || !Number.isFinite(monthlyLimit)) return null;
  return {
    isEnabled: Boolean(extra.is_enabled),
    usedCredits,
    monthlyLimit,
    currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
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
    opus: {
      percentage: normalizePct(data.opus?.percentage),
      resetTime: data.opus?.resetTime ?? null,
      label: data.opus?.label ?? null,
    },
    sonnet: {
      percentage: normalizePct(data.sonnet?.percentage),
      resetTime: data.sonnet?.resetTime ?? null,
      label: data.sonnet?.label ?? null,
    },
    design: {
      percentage: normalizePct(data.design?.percentage),
      resetTime: data.design?.resetTime ?? null,
      label: data.design?.label ?? null,
    },
    extra: sanitizeExtra(data.extra),
    meta: {
      ready: Boolean(data.meta?.ready),
      confidence: data.meta?.confidence || 'low',
      sessionSource: data.meta?.sessionSource || null,
      weeklySource: data.meta?.weeklySource || null,
      opusSource: data.meta?.opusSource || null,
      sonnetSource: data.meta?.sonnetSource || null,
      designSource: data.meta?.designSource || null,
      foundSessionMarker: Boolean(data.meta?.foundSessionMarker),
      foundWeeklyMarker: Boolean(data.meta?.foundWeeklyMarker),
      foundOpusMarker: Boolean(data.meta?.foundOpusMarker),
      foundSonnetMarker: Boolean(data.meta?.foundSonnetMarker),
      foundDesignMarker: Boolean(data.meta?.foundDesignMarker),
      textPercentageCount: Number.isFinite(data.meta?.textPercentageCount) ? data.meta.textPercentageCount : 0,
    },
  };

  if (clone.session.percentage === null && clone.weekly.percentage === null) return null;
  return clone;
}

function sanitizeExtra(extra) {
  if (!extra || typeof extra !== 'object') return null;
  if (extra.usedCredits == null || extra.monthlyLimit == null) return null;
  const usedCredits = Number(extra.usedCredits);
  const monthlyLimit = Number(extra.monthlyLimit);
  if (!Number.isFinite(usedCredits) || !Number.isFinite(monthlyLimit)) return null;
  return {
    isEnabled: Boolean(extra.isEnabled),
    usedCredits,
    monthlyLimit,
    currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
  };
}

function normalizePct(value) {
  // Treat null/undefined/empty as "no data" — Number(null) is 0, which would
  // otherwise pollute a bucket with a fake 0% when the API returns the whole
  // bucket as null (meaning the bucket does not apply to the user's plan).
  if (value === null || value === undefined || value === '') return null;
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
  if (!next?.meta?.ready) return false;
  if (!current) return true;

  const nextRank = confidenceRank(next.meta?.confidence);
  const currentRank = confidenceRank(current.meta?.confidence);

  if (nextRank > currentRank) return true;
  if (current.session?.percentage === null) return true;

  // High-confidence (API) data is authoritative — accept drops (session resets, plan changes).
  if (next.meta?.confidence === 'high') return true;

  // Lower confidence (DOM parse): need session data to validate the drop.
  if (next.session?.percentage === null) return false;
  const drop = current.session.percentage - next.session.percentage;
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
