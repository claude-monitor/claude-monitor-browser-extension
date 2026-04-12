// ─── ClaudeTrack — Background Service Worker ───────────────────────────────
// Polls claude.ai/settings/usage every 5 minutes, parses usage data via a
// content script, persists it to chrome.storage.local, and updates the badge.

const USAGE_URL  = 'https://claude.ai/settings/usage';
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

function setupAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MIN });
    }
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
    refreshUsage().then(() => sendResponse({ ok: true }));
    return true;   // keep channel open for async response
  }
  if (msg.type === 'USAGE_DATA') {
    // Forwarded from the content script via tab messaging
    persistAndBadge(msg.data);
    sendResponse({ ok: true });
  }
});

// ── Core refresh logic ────────────────────────────────────────────────────

async function refreshUsage() {
  // 1. Try to find an already-open settings/usage tab
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });

  if (tabs.length > 0) {
    await injectIntoTab(tabs[0].id);
    return;
  }

  // 2. No open tab — create one silently (active:false keeps it in background)
  let tab;
  try {
    tab = await chrome.tabs.create({ url: USAGE_URL, active: false });
  } catch (e) {
    console.warn('[ClaudeTrack] Could not create tab:', e);
    return;
  }

  // 3. Wait for the tab to finish loading, then inject
  const onUpdated = (tabId, info) => {
    if (tabId !== tab.id || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);

    injectIntoTab(tab.id).then(() => {
      // Give the content script 2 s to post data back, then close the tab
      setTimeout(() => {
        chrome.tabs.remove(tab.id).catch(() => {});
      }, 2500);
    });
  };
  chrome.tabs.onUpdated.addListener(onUpdated);

  // Safety: remove the tab after 15 s regardless
  setTimeout(() => {
    chrome.tabs.remove(tab.id).catch(() => {});
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }, 15000);
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    console.warn('[ClaudeTrack] Script injection failed:', e);
  }
}

// ── Badge helpers ─────────────────────────────────────────────────────────

function persistAndBadge(data) {
  data.lastUpdated = Date.now();
  chrome.storage.local.set({ claudeUsage: data });
  updateBadge(data);
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
