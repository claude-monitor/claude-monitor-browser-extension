// ─── Claude Usage Monitor: Background Service Worker ───────────────────────
// Polls Claude.ai's authenticated usage API every 5 minutes, persists the
// result to chrome.storage.local, and updates the toolbar badge.

const API_BASE   = 'https://claude.ai/api';
const ALARM_NAME = 'claudetrack-poll';
const POLL_MIN   = 5;   // minutes between automatic refreshes (default)
// The interval setting is clamped to this range. One minute meant ~1,400
// requests a day per user to claude.ai for figures that move slowly.
const POLL_FLOOR = 2;
const POLL_MAX   = 60;

const ORG_ID_TTL_MS    = 24 * 60 * 60 * 1000; // re-validate cached orgId once a day
const AUTH_BACKOFF_MAX = 6;                    // cap consecutive auth-failure skips
const FETCH_FAIL_STALE = 2;                    // consecutive non-auth failures before the data counts as stale
const PLAN_SCHEMA      = 2;                    // bump to re-derive cached plans after a derivation change

// Daily routine-run budget lives behind the Claude Code gateway (/v1/code/...),
// NOT in /usage. The route 404s without the ccr-triggers beta + anthropic-version
// headers. The beta tag is dated and will change as the feature graduates.
const ROUTINE_BUDGET_URL = 'https://claude.ai/v1/code/routines/run-budget';
const ROUTINE_BETA       = 'ccr-triggers-2026-01-30';
const ANTHROPIC_VERSION  = '2023-06-01';

// Routine budget, credits and prepaid balance move far less than the session,
// so they are read every EXTRAS_TTL_MS instead of every tick (~433 requests a
// day at 5 minutes instead of ~1,150). A forced refresh rereads any copy older
// than EXTRAS_FORCED_GAP_MS.
const EXTRAS_TTL_MS        = 30 * 60 * 1000;
const EXTRAS_FORCED_GAP_MS = 60 * 1000;
// An automatic refresh (popup opened, bar or welcome page loaded) is skipped
// within this long of the last forced one. A click on refresh never is.
const AUTO_REFRESH_GAP_MS  = 60 * 1000;

const WHATS_NEW_VERSIONS = ['1.21.0']; // Must match the keys of WHATS_NEW in popup.js.

// Dates follow the UI language only where the UI is translated; otherwise an
// English UI would show, say, Arabic or Russian dates (14 store-only locales).
const UI_LANG = chrome.i18n.getUILanguage();
const UI_BASES = ['es', 'de', 'fr', 'it', 'ja', 'ko'];
const LOCALE = (UI_LANG === 'pt-BR' || UI_BASES.includes(UI_LANG.split('-')[0])) ? UI_LANG : 'en-US';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  setupAlarm();
  refreshUsage();   // fetch immediately on install/update
  markInstalledAt();
  updateUninstallUrl();
  syncPageScripts();
  if (details?.reason === 'install') openWelcome();
  if (details?.reason === 'update') {
    revokeUnusedScripting();
    // One notice per update: the release that arms What's new leaves the
    // Windows promo for a later one.
    if (!(await armWhatsNew())) markWindowsPromoOnUpdate();
  }
});

// Packaged page, not a website: the permission request behind its main button
// needs a click on an extension page. Install only, never on an update (sync
// installing on another device counts as an install; the page closes in a click).
function openWelcome() {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
}

// Arms the popup's What's new card for releases that have one. Also true when
// it was already armed for this version, so a reload of the same version does
// not arm the Windows promo either.
async function armWhatsNew() {
  const version = chrome.runtime.getManifest().version;
  if (!WHATS_NEW_VERSIONS.includes(version)) return false;
  const { whatsNew } = await chrome.storage.local.get('whatsNew');
  if (whatsNew?.v !== version) {
    await chrome.storage.local.set({ whatsNew: { v: version, at: Date.now(), views: 0 } });
  }
  return true;
}

// Up to 1.20.2, turning the bar off asked Chrome to remove `scripting` and the
// claude.ai origin in one call, which Chrome refuses whole (the origin counts
// as required), so `scripting` stayed granted. On update, anyone without the
// bar on gives it back. The scripts are unregistered first, which needs it.
async function revokeUnusedScripting() {
  try {
    await syncPageScripts();
    const { pageBar } = await chrome.storage.local.get('pageBar');
    if (pageBar?.enabled === true) return;
    await chrome.permissions.remove({ permissions: ['scripting'] });
  } catch { /* not granted, or the browser refused: nothing to give back */ }
}

// ── On-page bar (optional) ────────────────────────────────────────────────
// Off by default. Turning it on grants access to claude.ai pages plus the
// `scripting` permission, both OPTIONAL: a required permission added in an
// update makes Chrome disable the extension for everyone until they re-accept.
// The scripts are registered at runtime only while the toggle is on and the
// grant is in place, and unregistered the moment either goes away.

const CLAUDE_PAGES = 'https://claude.ai/*';
const PAGE_SCRIPTS = [
  // Page world, before claude.ai's own code runs, so its fetch is wrapped in time.
  { id: 'cum-stream', matches: [CLAUDE_PAGES], js: ['page/stream.js'], runAt: 'document_start', world: 'MAIN' },
  { id: 'cum-bar',    matches: [CLAUDE_PAGES], js: ['page/bar.js'],    runAt: 'document_idle' },
];

async function pageBarGranted() {
  return chrome.permissions.contains({ origins: [CLAUDE_PAGES], permissions: ['scripting'] });
}

// Calls are chained: the permission and storage events of one toggle arrive
// together, and two overlapping runs can act on each other's stale reads.
let pageScriptsSync = Promise.resolve();
function syncPageScripts() {
  pageScriptsSync = pageScriptsSync.then(syncPageScriptsNow);
  return pageScriptsSync;
}

async function syncPageScriptsNow() {
  try {
    const { pageBar } = await chrome.storage.local.get('pageBar');
    const granted = await pageBarGranted();
    // The namespace is absent until `scripting` is granted. After a revoke with
    // the worker still alive it can remain an object whose every call throws
    // "not available in this context"; the catch below absorbs that.
    if (!chrome.scripting?.registerContentScripts) return;
    const registered = (await chrome.scripting.getRegisteredContentScripts())
      .map(s => s.id)
      .filter(id => PAGE_SCRIPTS.some(p => p.id === id));

    if (!(pageBar?.enabled && granted)) {
      if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered });
      return;
    }
    const missing = PAGE_SCRIPTS.filter(p => !registered.includes(p.id));
    if (!missing.length) return;
    await chrome.scripting.registerContentScripts(missing);
    // Registration only covers pages loaded from now on; claude.ai tabs that
    // are already open get the scripts directly, so the bar shows up without a
    // reload. Both scripts guard against running twice.
    const tabs = await chrome.tabs.query({ url: CLAUDE_PAGES });
    for (const tab of tabs) {
      for (const script of missing) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: script.js,
          world: script.world || 'ISOLATED',
        }).catch(() => {});
      }
    }
  } catch { /* never let the bar setup break the extension */ }
}

chrome.permissions.onAdded.addListener(async () => {
  await consumePageBarRequest();
  syncPageScripts();
  updateUninstallUrl();
});
// Access revoked from the browser's own extension settings: turn the toggle off
// too, so the options page and the popup don't claim a bar that can't run.
chrome.permissions.onRemoved.addListener(async () => {
  if (!(await pageBarGranted())) await chrome.storage.local.set({ pageBar: { enabled: false } });
  syncPageScripts();
  updateUninstallUrl();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.pageBar) {
    syncPageScripts();
    refreshFreeHint();
  }
  if (changes.pageBar || changes.barHealth || changes.claudePlan) updateUninstallUrl();
});
// Every worker start reconciles too, so a registration that went missing
// (a failed call, a worker that missed the events) heals by the next poll
// instead of waiting for a browser restart or a toggle.
syncPageScripts();

// The welcome page and the popup stamp `pageBarRequested` in the same click
// that asks for access. If that page closes while the browser's prompt is up,
// nothing is left to turn the bar on; the grant event finishes the job when the
// stamp is recent.
const PAGE_BAR_REQUEST_TTL_MS = 2 * 60 * 1000;

async function consumePageBarRequest() {
  try {
    const { pageBarRequested } = await chrome.storage.local.get('pageBarRequested');
    if (!pageBarRequested) return;
    const age = Date.now() - Number(pageBarRequested);
    if (age >= 0 && age < PAGE_BAR_REQUEST_TTL_MS) {
      if (!(await pageBarGranted())) return; // another grant; keep waiting for this one
      await chrome.storage.local.set({ pageBar: { enabled: true } });
    }
    await chrome.storage.local.remove('pageBarRequested');
  } catch { /* the page's own handler covers the usual case */ }
}

// Limits read from a reply by page/stream.js. On the Free plan they are the
// only figures that exist, so they become the stored snapshot. On paid plans
// /usage stays authoritative; a reply just means usage moved, so it triggers a
// refresh (throttled) and the bar catches up seconds after each message.
const STREAM_REFRESH_GAP_MS = 20 * 1000;
const STREAM_MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

// Events are handled one at a time: two tabs can report the same reply, and the
// message log below dedupes on a read-modify-write.
let streamQueue = Promise.resolve();
function queueStreamLimits(limits, meta) {
  const run = streamQueue.then(() => applyStreamLimits(limits, meta));
  streamQueue = run.catch(() => {});
  return run;
}

// meta = { orgId, eventKey, reply } from the page: the org in the reply's URL
// (classic route only), a hash of the frame that carried the limits, and
// whether a reply came with it (reopened streams can repeat the event alone).
async function applyStreamLimits(limits, meta = {}) {
  const { claudePlan, claudeUsage, claudeOrgId, pageBar } = await chrome.storage.local.get(['claudePlan', 'claudeUsage', 'claudeOrgId', 'pageBar']);
  // Tabs opened before the bar was turned off keep its scripts until they
  // reload (older versions' scripts too); what they relay goes no further.
  if (!(pageBar?.enabled && await pageBarGranted())) return;
  // A reply in another organization's chat (another tab, another workspace)
  // says nothing about the one shown. Events without an org id can't tell.
  const orgId = typeof meta?.orgId === 'string' && UUID_RE.test(meta.orgId) ? meta.orgId.toLowerCase() : null;
  if (orgId && claudeOrgId && orgId !== String(claudeOrgId).toLowerCase()) return;
  const eventKey = typeof meta?.eventKey === 'string' && /^[0-9a-f]{8}$/.test(meta.eventKey) ? meta.eventKey : null;
  const reply = meta?.reply !== false;
  await logStreamMessage(parseStreamWindow(limits?.session), eventKey, reply);

  // The refresh is also how a plan not known yet turns out to be Free, so a
  // Free account's first reply isn't dropped on the paid path.
  let usage = claudeUsage;
  let free = claudePlan?.label === 'Free';
  if (!free && (!claudeUsage?.lastUpdated || Date.now() - claudeUsage.lastUpdated > STREAM_REFRESH_GAP_MS)) {
    free = (await refreshUsage())?.reason === 'free-plan';
    if (free) ({ claudeUsage: usage } = await chrome.storage.local.get('claudeUsage'));
  }
  if (free) {
    const prev = usage?.source === 'stream' ? usage : null;
    const session = streamWindow(limits?.session, prev?.session ?? null);
    const weekly  = streamWindow(limits?.weekly,  prev?.weekly ?? null);
    if (!session && !weekly) return;
    const empty = { percentage: null, resetTime: null, label: null };
    // A window left out of this event (a 0.0 utilization is not serialized)
    // keeps its last reading while that window is still running.
    const keep = (b) => (Number(b?.resetTime) > Date.now() ? b : empty);
    const stored = await persistAndBadge({
      session: session || keep(prev?.session),
      weekly: weekly || keep(prev?.weekly),
      fable: empty, opus: empty, sonnet: empty, design: empty,
      extra: null, prepaidBalance: null, routine: null,
      meta: { ready: true },
      source: 'stream',
    });
    if (stored) {
      await chrome.storage.local.remove('fetchFailures');
      // First Free-plan reading ever: the limits Claude hides from its own usage
      // page just showed up. Same moment-of-value signal as a timely alert.
      if (usage?.source !== 'stream') {
        await chrome.storage.local.set({ reviewMoment: { type: 'free', at: Date.now() } });
      }
    }
  }
  await updateMsgEstimate();
}

// Validates one window from the page (the page world is not trusted with
// anything beyond these numbers) and keeps the previous figure when the new one
// is lower within the same window: the reply and the accounting round
// independently, so a reading can dip by a point before it settles.
function streamWindow(incoming, previous) {
  const next = parseStreamWindow(incoming);
  if (!next) return null;
  const sameWindow = previous && Math.abs((previous.resetTime || 0) - next.resetTime) < 60 * 1000;
  return sameWindow && Number(previous.percentage) > next.percentage ? previous : next;
}

// The raw 0-1 utilization rides along only for the message estimate; the
// stored snapshot keeps the whole percentage (sanitizeUsageData drops it).
function parseStreamWindow(incoming) {
  const pct = Number(incoming?.percentage);
  const reset = Number(incoming?.resetTime);
  if (!Number.isFinite(pct) || pct < 0 || !Number.isFinite(reset)) return null;
  if (reset <= Date.now() || reset > Date.now() + STREAM_MAX_RESET_AHEAD_MS) return null;
  const next = { percentage: Math.min(pct, 100), resetTime: reset, label: null };
  const util = incoming.utilization;
  if (typeof util === 'number' && Number.isFinite(util) && util >= 0 && util <= 1.5) next.utilization = util;
  return next;
}

// ── Messages left (estimate) ──────────────────────────────────────────────
// Session utilization after each of the last replies in the current window,
// from the bar's stream reader (the only source of per-reply figures). No
// message content is involved: a time, a fraction and a frame hash.
const MSG_LOG_MAX        = 20;
const MSG_EST_MIN_COUNT  = 5;     // replies before anything is shown
const MSG_EST_MIN_DELTA  = 0.03;  // and at least 3 points of movement across them
const SAME_WINDOW_MS     = 60 * 1000;  // resets_at jitters by up to a second or so

async function logStreamMessage(session, eventKey, reply) {
  if (reply === false || !session) return;
  const u = Number.isFinite(session.utilization) ? session.utilization : session.percentage / 100;
  const { msgLog } = await chrome.storage.local.get('msgLog');
  let log = msgLog && Array.isArray(msgLog.entries) && Number.isFinite(msgLog.reset) ? msgLog : null;
  if (!log || Math.abs(session.resetTime - log.reset) > SAME_WINDOW_MS) {
    log = { reset: session.resetTime, entries: [] };
  }
  // The same event seen from a second tab, or by a reopened stream.
  if (eventKey && log.entries.some(e => e.k === eventKey)) return;
  log.entries.push({ t: Date.now(), u, k: eventKey });
  await chrome.storage.local.set({ msgLog: { reset: log.reset, entries: log.entries.slice(-MSG_LOG_MAX) } });
}

// Average cost per reply across the log, counting the replies that didn't move
// the figure (dropping them inflates the cost and undercounts what's left).
async function updateMsgEstimate(data) {
  const { msgLog, claudeUsage } = await chrome.storage.local.get(['msgLog', 'claudeUsage']);
  const usage = data || claudeUsage;
  const entries = Array.isArray(msgLog?.entries) ? msgLog.entries : [];
  const count = entries.length;
  const reset = Number(usage?.session?.resetTime);
  let estimate = null;
  if (count >= MSG_EST_MIN_COUNT && reset > Date.now() && Math.abs(reset - msgLog.reset) <= SAME_WINDOW_MS) {
    const last = Number(entries[count - 1].u);
    const delta = last - Number(entries[0].u);
    if (delta >= MSG_EST_MIN_DELTA - 1e-9) {
      const rate = delta / (count - 1);
      const remaining = 1 - Math.max(last, (badgePct(usage, 'session') ?? 0) / 100);
      const n = Math.floor(remaining / rate);
      if (n >= 1) estimate = { n, basedOn: count, reset: msgLog.reset, at: Date.now() };
    }
  }
  if (estimate) await chrome.storage.local.set({ msgLeft: estimate });
  else await chrome.storage.local.remove('msgLeft');
}

// ── Uninstall survey URL ──────────────────────────────────────────────────
// One-question exit survey. The query carries the version and the browser
// family so the page can route the answer. In Chrome and Edge the fragment
// carries five coarse values (plan type, bar on/off, bar anchored, last
// refresh result, install age bucket): a fragment never reaches the server
// when the page opens, and the page sends it only with an answer and its
// checkbox ticked. No identifier, org, name or usage figure ever goes in.
const REFRESH_CODES = {
  'ok': 'ok', 'auth-failed': 'auth', 'org-not-found': 'org', 'free-plan': 'free',
  'api-fetch-failed': 'fail', 'api-data-rejected': 'fail',
};
let lastUninstallUrl = null;

async function updateUninstallUrl() {
  if (!chrome.runtime.setUninstallURL) return;
  try {
    const url = await buildUninstallUrl();
    if (url === lastUninstallUrl) return;
    lastUninstallUrl = url;
    chrome.runtime.setUninstallURL(url);
  } catch { /* keep whatever URL is set */ }
}

async function buildUninstallUrl() {
  const { claudePlan, pageBar, barHealth, lastRefresh, installedAt } = await chrome.storage.local.get(
    ['claudePlan', 'pageBar', 'barHealth', 'lastRefresh', 'installedAt']);
  const version = chrome.runtime.getManifest().version;
  const ua = navigator.userAgent;
  const browser = ua.includes('Firefox') ? 'firefox' : ua.includes('Edg/') ? 'edge' : 'chrome';
  const base = `https://claude-monitor.com/uninstall?v=${version}&b=${browser}`;
  // data_collection_permissions: none (manifest.firefox.json): no state there.
  if (browser === 'firefox') return base;
  const p = claudePlan?.label === 'Free' ? 'free' : claudePlan?.label ? 'paid' : 'unk';
  const bar = pageBar?.enabled && await pageBarGranted() ? '1' : '0';
  const anc = bar === '0' || !barHealth ? 'n' : barHealth.anchored ? '1' : '0';
  const r = lastRefresh ? (REFRESH_CODES[lastRefresh.reason] || 'fail') : 'none';
  const days = (Date.now() - Number(installedAt)) / (24 * 60 * 60 * 1000);
  const d = !(days >= 1) ? '0' : days < 7 ? '1' : days < 30 ? '7' : '30';
  return `${base}#p=${p}&bar=${bar}&anc=${anc}&r=${r}&d=${d}`;
}

// One-shot flag for the Windows companion promo in the popup. An update reaches
// the whole installed base at once instead of waiting for each user to age into
// the time-based nudge. The version is recorded so the click can be attributed
// to the release that surfaced it; a previous dismissal is never overridden.
// Armed at most once per install: re-arming on every release made the banner
// reappear for users who had not dismissed it yet, and the uninstall spike
// after 1.12/1.13 (2026-08-02) points at exactly that.
async function markWindowsPromoOnUpdate() {
  const { winPromoDismissed, winPromoUpdateArmed } =
    await chrome.storage.local.get(['winPromoDismissed', 'winPromoUpdateArmed']);
  if (winPromoDismissed || winPromoUpdateArmed) return;
  await chrome.storage.local.set({
    winPromoUpdate: chrome.runtime.getManifest().version,
    winPromoUpdateArmed: true,
  });
}

// First-seen timestamp drives the popup's review nudge (~1 week after install).
async function markInstalledAt() {
  const { installedAt } = await chrome.storage.local.get('installedAt');
  if (!installedAt) await chrome.storage.local.set({ installedAt: Date.now() });
}

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
  refreshUsage();
  syncPageScripts();
  updateUninstallUrl();
});
updateUninstallUrl();

function clampInterval(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return POLL_MIN;
  return Math.min(POLL_MAX, Math.max(POLL_FLOOR, minutes));
}

// A stored interval below the floor (the old 1-minute option) is raised and
// written back, so the popup shows what actually runs.
async function setupAlarm() {
  const { refreshInterval } = await chrome.storage.local.get('refreshInterval');
  const interval = refreshInterval == null ? POLL_MIN : clampInterval(refreshInterval);
  if (refreshInterval != null && refreshInterval !== interval) {
    await chrome.storage.local.set({ refreshInterval: interval });
  }
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== interval) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshUsage();
  } else if (alarm.name === RESET_ALARM) {
    notifySessionReset(alarm);
  }
});

// ── Messages from the popup, the welcome page and the bar ────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'REFRESH') {
    requestRefresh(msg.source === 'auto' ? 'auto' : 'manual')
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.type === 'STREAM_LIMITS') {
    queueStreamLimits(msg.limits, { orgId: msg.orgId, eventKey: msg.eventKey, reply: msg.reply })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'SET_ORG') {
    setPinnedOrg(msg.orgId)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.type === 'OPEN_DETAILS') {
    openDetails().then((opened) => sendResponse({ ok: true, opened }));
    return true;
  }
  if (msg.type === 'PRUNE_HISTORY') {
    pruneStoredHistory()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.type === 'SET_INTERVAL') {
    const minutes = clampInterval(msg.minutes);
    chrome.storage.local.set({ refreshInterval: minutes }).then(() => {
      chrome.alarms.clear(ALARM_NAME, () => {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
        sendResponse({ ok: true, minutes });
      });
    });
    return true;
  }
});

// Both kinds bypass the auth backoff: the user may have just signed back in,
// and waiting out the remaining skipped ticks would keep data stale. 'auto'
// (popup opened, bar or welcome page loaded) is skipped within a minute of the
// last forced refresh, so opening the popup repeatedly doesn't hammer claude.ai.
async function requestRefresh(source) {
  const now = Date.now();
  if (source === 'auto') {
    const { forcedRefreshAt } = await chrome.storage.local.get('forcedRefreshAt');
    const since = now - Number(forcedRefreshAt);
    if (since >= 0 && since < AUTO_REFRESH_GAP_MS) return { refreshed: false, reason: 'throttled' };
  }
  await chrome.storage.local.set({ forcedRefreshAt: now });
  return refreshUsage({ force: true });
}

// The bar's brand mark. Opening the popup from a page message has no user
// gesture behind it, which the browser may refuse; Settings is the fallback.
// A second click while the popup is up is refused too (the popup holds the
// focus); that click already closes it, so it toggles instead of opening Settings.
async function openDetails() {
  if (chrome.action?.openPopup) {
    try {
      await chrome.action.openPopup();
      return 'popup';
    } catch { /* no focused window, or not allowed here */ }
    const popups = await chrome.runtime.getContexts?.({ contextTypes: ['POPUP'] }).catch(() => []);
    if (popups?.length) return 'closed';
  }
  chrome.runtime.openOptionsPage();
  return 'options';
}

// ── Core refresh logic ────────────────────────────────────────────────────

// Overlapping calls (alarm, popup, bar, stream) share the run in progress. A
// forced call behind an unforced run waits for it and then runs, so it never
// gets an answer that went through the auth backoff.
let refreshRun = null;     // { promise, force }
let forcedAfterRun = null; // the forced run queued behind an unforced one

function refreshUsage({ force = false } = {}) {
  if (refreshRun) {
    if (!force || refreshRun.force) return refreshRun.promise;
    if (!forcedAfterRun) {
      forcedAfterRun = refreshRun.promise.catch(() => {}).then(() => {
        forcedAfterRun = null;
        return refreshUsage({ force: true });
      });
    }
    return forcedAfterRun;
  }
  const promise = refreshUsageNow({ force }).finally(() => {
    if (refreshRun?.promise === promise) refreshRun = null;
  });
  refreshRun = { promise, force };
  return promise;
}

async function refreshUsageNow({ force }) {
  if (!force && await shouldSkipForAuthBackoff()) {
    return { refreshed: false, reason: 'auth-backoff' };
  }
  const result = await refreshUsageOnce({ force });
  // What the last read that reached claude.ai came back with: the popup's and
  // the welcome page's empty states, and the uninstall survey, key off it.
  await chrome.storage.local.set({
    lastRefresh: { reason: result.refreshed ? 'ok' : result.reason, at: Date.now(), forced: Boolean(force) },
  });
  updateUninstallUrl();
  return result;
}

async function refreshUsageOnce({ force }) {
  const apiResult = await refreshUsageFromApi({ force });
  if (apiResult.refreshed) {
    await clearAuthBackoff();
    await chrome.storage.local.remove('fetchFailures');
    return { ...apiResult, source: 'api' };
  }
  if (apiResult.reason === 'auth-failed') {
    // Forced reads (popup opened, bar or welcome page loaded) only start the
    // backoff; growing it on each would leave the poll skipping for an hour
    // after signing back in.
    const { authBackoff } = await chrome.storage.local.get('authBackoff');
    if (!force || !authBackoff) await bumpAuthBackoff();
    markBadgeSignedOut();
  } else if (apiResult.reason === 'api-data-rejected' && await isFreePlan()) {
    // Expected, not a failure: /usage answers with every field null on the
    // Free plan. Whatever a reply reported (applyStreamLimits) stays as is.
    await clearAuthBackoff();
    const { claudeUsage } = await chrome.storage.local.get('claudeUsage');
    if (claudeUsage) await updateBadge(claudeUsage);  // the poll is what moves an expired window to 0%
    else await markBadgeFreeNoData();  // also replaces the sign-in hint after signing back in
    return { refreshed: false, reason: 'free-plan' };
  } else {
    await bumpFetchFailures();
  }
  return { refreshed: false, reason: apiResult.reason || 'api-fetch-failed' };
}

async function isFreePlan() {
  const { claudePlan } = await chrome.storage.local.get('claudePlan');
  return claudePlan?.label === 'Free';
}

// Non-auth failures (claude.ai unreachable, unexpected payload) used to leave
// the last reading on screen as if it were live: users saw "12%" for hours with
// no hint that nothing had been read since. One miss can be a blip, so the data
// only counts as stale after FETCH_FAIL_STALE in a row; the popup reads the same
// record to show its banner.
async function bumpFetchFailures() {
  const { fetchFailures } = await chrome.storage.local.get('fetchFailures');
  const count = (fetchFailures?.count ?? 0) + 1;
  await chrome.storage.local.set({ fetchFailures: { count, since: fetchFailures?.since ?? Date.now() } });
  if (count >= FETCH_FAIL_STALE) markBadgeStale();
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

async function refreshUsageFromApi({ force = false } = {}) {
  try {
    const orgId = await getClaudeOrgId();
    if (!orgId) {
      return { refreshed: false, reason: 'org-not-found' };
    }

    let activeOrgId = orgId;
    let usage;
    try {
      usage = await fetchClaudeJson(`${API_BASE}/organizations/${orgId}/usage`);
    } catch (error) {
      if (String(error?.message || '').startsWith('http-404')) {
        // Expire the cache but keep the old id, so getClaudeOrgId can tell an
        // account switch (a different org comes back) from a stale cache.
        await chrome.storage.local.remove('claudeOrgIdAt');
        const retriedOrgId = await getClaudeOrgId();
        if (!retriedOrgId) throw error;
        activeOrgId = retriedOrgId;
        usage = await fetchClaudeJson(`${API_BASE}/organizations/${retriedOrgId}/usage`);
      } else {
        throw error;
      }
    }

    const data = mapApiUsageToStoredShape(usage);
    // The secondary reads only matter when /usage had figures (the Free plan
    // answers all null, and the refresh is rejected below anyway).
    if (data.meta.ready) {
      const extras = await readExtras(activeOrgId, force);
      // Routine budget: null when unavailable (other plan, auth, beta changed) → card hides.
      data.routine = extras.routine;
      // Credits spend/limit. usage.extra_usage is scoped to the signed-in member,
      // while overage_spend_limit is the organization-wide limit: on Team/
      // Enterprise accounts the second one is much larger than what the member
      // sees in Claude. So use extra_usage for the numbers when it has them, and
      // borrow the overage endpoint's reset/suspension fields, which extra_usage
      // lacks. When extra_usage is null (suspended member) the overage payload is
      // the only source left, so fall back to it whole.
      data.extra = mergeCreditSources(data.extra, extras.overage);
      // Prepaid balance ("current balance"), shown next to the credits card.
      data.prepaidBalance = extras.prepaid;
    }
    const stored = await persistAndBadge(data);
    return {
      refreshed: stored,
      reason: stored ? undefined : 'api-data-rejected',
    };
  } catch (error) {
    const msg = String(error?.message || error);
    let reason = msg.startsWith('auth-') ? 'auth-failed' : 'api-fetch-failed';
    if (reason === 'auth-failed' && await pinnedOrgRefused()) reason = 'api-fetch-failed';
    return { refreshed: false, reason, error: msg };
  }
}

// An org picked in the popup can refuse its usage to a member (401/403) while
// the session itself is fine. If the org list still loads it is not a sign-out:
// no sign-in prompt, no backoff, and the picker is the way back.
async function pinnedOrgRefused() {
  const { claudeOrgPinned } = await chrome.storage.local.get('claudeOrgPinned');
  if (!claudeOrgPinned) return false;
  try {
    await fetchClaudeJson(`${API_BASE}/organizations`);
    return true;
  } catch {
    return false;
  }
}

async function getClaudeOrgId() {
  const { claudeOrgId, claudeOrgIdAt, claudePlan, claudeOrgs, claudeOrgPinned } = await chrome.storage.local.get(
    ['claudeOrgId', 'claudeOrgIdAt', 'claudePlan', 'claudeOrgs', 'claudeOrgPinned']);
  const fresh = claudeOrgIdAt && (Date.now() - claudeOrgIdAt) < ORG_ID_TTL_MS;
  // Only short-circuit when the plan and the org list are also cached, so an
  // existing install (org id already cached) still fetches the list once to
  // populate the plan badge and the org picker. PLAN_SCHEMA forces one refetch
  // after an update that changes how the plan is derived (v2: Free accounts
  // read as tier default_claude_ai). A pin that isn't the active org yet too.
  if (claudeOrgId && fresh && claudePlan?.v === PLAN_SCHEMA && Array.isArray(claudeOrgs) &&
      (!claudeOrgPinned || claudeOrgPinned === claudeOrgId)) return claudeOrgId;

  const organizations = await fetchClaudeJson(`${API_BASE}/organizations`);
  const candidates = orgCandidates(organizations);
  // Names stay on this device: the popup's picker is their only reader.
  await chrome.storage.local.set({
    claudeOrgs: candidates.map(o => ({
      id: orgIdOf(o),
      name: String(o.name || '').slice(0, 60),
      plan: planLabel(o.rate_limit_tier || null, Array.isArray(o.capabilities) ? o.capabilities : [], o.raven_type),
    })).filter(o => o.id),
  });
  const pinnedListed = claudeOrgPinned && candidates.some(o => orgIdOf(o) === claudeOrgPinned);
  if (claudeOrgPinned && !pinnedListed) await chrome.storage.local.remove('claudeOrgPinned');
  const org = selectOrg(organizations, pinnedListed ? claudeOrgPinned : null);
  const orgId = orgIdOf(org);
  if (orgId) {
    await chrome.storage.local.set({ claudeOrgId: orgId, claudeOrgIdAt: Date.now() });
  }
  // A different org means another account signed in to claude.ai, or another
  // org picked in the popup. The stored reading belongs to the previous one and
  // must not be shown as this one's usage, so it goes, along with the alert
  // state, the estimates and the cached secondary reads tied to it. History is
  // kept but cut: the forecast and the sparklines ignore what came before.
  if (claudeOrgId && orgId && orgId !== claudeOrgId) {
    await chrome.storage.local.remove(['claudeUsage', 'fetchFailures', 'notifState', 'msgLog', 'msgLeft', 'forecast', 'extrasCache']);
    await chrome.storage.local.set({ historyCutAt: Date.now() });
    chrome.alarms.clear(RESET_ALARM);  // that session's reset is not this org's
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: BADGE_NAME });
  }
  await chrome.storage.local.set({ claudePlan: derivePlan(org) });
  return orgId;
}

function orgIdOf(org) {
  return (org && (org.uuid || org.organization_uuid || org.id)) || null;
}

// The orgs that host the chat product; all of them when none says so.
function orgCandidates(payload) {
  const orgs = (Array.isArray(payload) ? payload
    : Array.isArray(payload?.organizations) ? payload.organizations
    : []).filter(o => o && typeof o === 'object');
  const chat = orgs.filter(o => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  return chat.length ? chat : orgs;
}

// Multi-org accounts (e.g. Team/Enterprise plus a personal workspace): the org
// picked in the popup while it is still listed; otherwise prefer the org that
// hosts the chat product, else the first entry.
function selectOrg(payload, pinned) {
  const candidates = orgCandidates(payload);
  return (pinned && candidates.find(o => orgIdOf(o) === pinned)) || candidates[0] || null;
}

// The popup's org picker. Only an org from the stored list can be pinned.
async function setPinnedOrg(orgId) {
  const id = typeof orgId === 'string' ? orgId : '';
  const { claudeOrgs } = await chrome.storage.local.get('claudeOrgs');
  if (!UUID_RE.test(id) || !Array.isArray(claudeOrgs) || !claudeOrgs.some(o => o?.id === id)) {
    return { ok: false, reason: 'invalid-org' };
  }
  await chrome.storage.local.set({ claudeOrgPinned: id, forcedRefreshAt: Date.now() });
  // A refresh already running read the old org; let it land, then expire the
  // cached id it may have written, so the next run resolves the pin.
  await Promise.allSettled([refreshRun?.promise, forcedAfterRun]);
  await chrome.storage.local.remove('claudeOrgIdAt');
  const result = await refreshUsage({ force: true });
  return { ok: true, ...result };
}

// Extract a displayable subscription label from the org payload. The
// /api/organizations response (already fetched for the org id) carries
// rate_limit_tier + capabilities, so no extra request or permission is needed.
function derivePlan(org) {
  const tier = org?.rate_limit_tier || null;
  const caps = Array.isArray(org?.capabilities) ? org.capabilities : [];
  return { v: PLAN_SCHEMA, tier, label: planLabel(tier, caps, org?.raven_type), subcaps: availableSubcaps(tier, caps) };
}

// Which weekly sub-caps this plan should offer. The API exposes no reliable
// per-model signal (capabilities only carries the tier; the omelette flag is
// null even on Max), so we offer the model sub-caps on paid plans and none on free.
function availableSubcaps(tier, caps) {
  const t = String(tier || '').toLowerCase();
  const paid = caps.includes('claude_max') || caps.includes('claude_pro') ||
               /max|pro|team|enterprise/.test(t);
  return { fable: paid, opus: paid, sonnet: paid, design: paid };
}

function planLabel(tier, caps, ravenType) {
  const t = String(tier || '').toLowerCase();
  if (t.includes('max_20x'))    return 'Max 20x';
  if (t.includes('max_5x'))     return 'Max 5x';
  if (t.includes('max'))        return 'Max';
  if (t.includes('team'))       return 'Team';
  if (t.includes('enterprise')) return 'Enterprise';
  if (t.includes('pro'))        return 'Pro';
  if (caps.includes('claude_max')) return 'Max';
  if (caps.includes('claude_pro')) return 'Pro';
  // raven_type is set on Team/Enterprise orgs, whose tier can read like a
  // personal one; checked before the Free fallback so they never land there.
  if (ravenType) return String(ravenType).toLowerCase().includes('enterprise') ? 'Enterprise' : 'Team';
  // Free and Pro share the tier "default_claude_ai"; Pro is told apart only by
  // the claude_pro capability checked above, so what remains here is Free.
  if (t.includes('free') || t === 'default' || t === 'default_claude_ai') return 'Free';
  return null; // unknown tier → show nothing rather than a wrong label
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
  const scoped = mapLimitsArray(usage?.limits);
  const session = pickBucket(scoped.session, usage?.five_hour);
  const weekly  = pickBucket(scoped.weekly,  usage?.seven_day);
  const opus    = pickBucket(scoped.opus,    usage?.seven_day_opus);
  const sonnet  = pickBucket(scoped.sonnet,  usage?.seven_day_sonnet);
  return {
    session: {
      percentage: normalizePct(session?.utilization),
      resetTime: parseApiTime(session?.resets_at),
      label: session?.resets_at ? null : 'Not yet used',
    },
    weekly: {
      percentage: normalizePct(weekly?.utilization),
      resetTime: parseApiTime(weekly?.resets_at),
      label: weekly?.resets_at ? null : 'Weekly limit',
    },
    // Fable has no flat seven_day_* bucket; its weekly cap only exists as a
    // weekly_scoped entry in the limits array.
    fable: {
      percentage: normalizePct(scoped.fable?.utilization),
      resetTime: parseApiTime(scoped.fable?.resets_at),
      label: scoped.fable?.resets_at ? null : 'Not yet used',
    },
    opus: {
      percentage: normalizePct(opus?.utilization),
      resetTime: parseApiTime(opus?.resets_at),
      label: opus?.resets_at ? null : 'Not yet used',
    },
    sonnet: {
      percentage: normalizePct(sonnet?.utilization),
      resetTime: parseApiTime(sonnet?.resets_at),
      label: sonnet?.resets_at ? null : 'Not yet used',
    },
    design: {
      percentage: normalizePct(usage?.seven_day_omelette?.utilization),
      resetTime: parseApiTime(usage?.seven_day_omelette?.resets_at),
      label: usage?.seven_day_omelette?.resets_at ? null : 'Not yet used',
    },
    extra: mapExtraUsage(usage?.extra_usage),
    meta: {
      ready:
        normalizePct(session?.utilization) !== null ||
        normalizePct(weekly?.utilization) !== null,
    },
  };
}

// The `limits` array (added to /usage ~2026-07) is what claude.ai/settings/usage
// renders: [{ kind, group, percent, severity, resets_at, scope, is_active }].
// kind is "session" | "weekly_all" | "weekly_scoped"; weekly_scoped entries
// carry scope.model.display_name (e.g. "Fable"; per-model caps live ONLY here,
// there is no seven_day_fable flat bucket). Normalized to the flat-bucket shape
// ({ utilization, resets_at }) so both sources feed the same mapping.
function mapLimitsArray(limits) {
  const out = {};
  if (!Array.isArray(limits)) return out;
  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') continue;
    const entry = { utilization: limit.percent, resets_at: limit.resets_at ?? null };
    if (limit.kind === 'session') {
      out.session = entry;
    } else if (limit.kind === 'weekly_all') {
      out.weekly = entry;
    } else if (limit.kind === 'weekly_scoped') {
      const model = String(limit.scope?.model?.display_name || '').toLowerCase();
      if (model.includes('fable'))       out.fable  = entry;
      else if (model.includes('opus'))   out.opus   = entry;
      else if (model.includes('sonnet')) out.sonnet = entry;
    }
  }
  return out;
}

// Prefer the limits-array entry (it is what the official usage page shows) and
// fall back to the legacy flat bucket for accounts still on the old shape.
function pickBucket(scopedEntry, flatBucket) {
  if (scopedEntry && normalizePct(scopedEntry.utilization) !== null) return scopedEntry;
  return flatBucket ?? null;
}

// Fallback credits source: usage.extra_usage. Money is in cents (10197/10000 =
// $101.97/$100.00). Maps to the same unified shape as the primary
// overage_spend_limit source. Returns null when suspended (used/limit null):
// the overage endpoint covers that case.
function mapExtraUsage(extra) {
  if (!extra || typeof extra !== 'object') return null;
  if (extra.used_credits == null || extra.monthly_limit == null) return null;
  const usedCredits = Number(extra.used_credits) / 100;
  const monthlyLimit = Number(extra.monthly_limit) / 100;
  if (!Number.isFinite(usedCredits) || !Number.isFinite(monthlyLimit) || monthlyLimit <= 0) return null;
  return {
    isEnabled: Boolean(extra.is_enabled),
    usedCredits,
    monthlyLimit,
    currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
    utilization: (usedCredits / monthlyLimit) * 100,
    resetTime: null,
    outOfCredits: usedCredits >= monthlyLimit,
    disabledReason: typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null,
    source: 'extra_usage',
  };
}

// Combine the member-scoped numbers (extra_usage) with the org-scoped payload
// (overage_spend_limit), which is the only one carrying the reset timestamp and
// the suspension flags. Numbers always win from extra_usage when present.
function mergeCreditSources(extra, overage) {
  if (!extra) return overage || null;
  if (!overage) return extra;
  return {
    ...extra,
    resetTime: overage.resetTime,
    outOfCredits: overage.outOfCredits || extra.outOfCredits,
    disabledReason: extra.disabledReason ?? overage.disabledReason,
  };
}

// ── Secondary reads (routine, credits, prepaid), cached ──────────────────
// Each is { val, failed }: `val` already mapped, or null when not offered.
// `failed` marks a transient miss (network, 5xx, 429), retried on the next
// tick; any other answer, null included, is kept for EXTRAS_TTL_MS like a value.
const EXTRA_READS = {
  routine: fetchRoutineBudget,
  overage: fetchOverageSpendLimit,
  prepaid: fetchPrepaidCredits,
};

async function readExtras(orgId, forced) {
  const { extrasCache } = await chrome.storage.local.get('extrasCache');
  const cache = extrasCache?.orgId === orgId ? extrasCache : {};
  const next = { orgId };
  for (const [key, read] of Object.entries(EXTRA_READS)) {
    const entry = cache[key];
    const age = Date.now() - Number(entry?.at);
    const due = !entry || !(age >= 0 && age < EXTRAS_TTL_MS) || entry.failed ||
      (forced && age > EXTRAS_FORCED_GAP_MS);
    next[key] = due ? { at: Date.now(), ...(await read(orgId)) } : entry;
  }
  await chrome.storage.local.set({ extrasCache: next });
  return { routine: next.routine.val ?? null, overage: next.overage.val ?? null, prepaid: next.prepaid.val ?? null };
}

// fetch() rejects with a TypeError when the network fails; fetchClaudeJson
// throws `auth-<status>` / `http-<status>` for answers that aren't ok.
function isTransientFailure(error) {
  const status = Number((String(error?.message || '').match(/^(?:auth|http)-(\d{3})$/) || [])[1]);
  if (status) return status >= 500 || status === 429;
  return error?.name === 'TypeError';
}

async function fetchRoutineBudget(orgId) {
  try {
    const response = await fetch(ROUTINE_BUDGET_URL, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'anthropic-beta': ROUTINE_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
        'x-organization-uuid': orgId,
      },
    });
    // fail soft: 404 (no beta/plan), 400, 401 → hide card
    if (!response.ok) return { val: null, failed: response.status >= 500 || response.status === 429 };
    return { val: mapRoutineBudget(await response.json()), failed: false };
  } catch (error) {
    return { val: null, failed: isTransientFailure(error) };
  }
}

// Response shape: { used: "0", limit: "15", unified_billing_enabled: true }.
// used/limit are numeric strings; there is no reset timestamp (daily, implicit).
function mapRoutineBudget(data) {
  if (!data || typeof data !== 'object') return null;
  const used  = Number(data.used);
  const limit = Number(data.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return { used, limit };
}

// Primary credits source: the same endpoint claude.ai /usage uses for the
// "Usage credits" card. Plain cookie auth (no special headers). Returns the
// spend/limit/reset even while suspended, unlike usage.extra_usage.
async function fetchOverageSpendLimit(orgId) {
  try {
    const data = await fetchClaudeJson(`${API_BASE}/organizations/${orgId}/overage_spend_limit`);
    return { val: mapOverageSpendLimit(data), failed: false };
  } catch (error) {
    // fail soft: 403/404 (not offered on this plan) → use fallback
    return { val: null, failed: isTransientFailure(error) };
  }
}

// Response: { is_enabled, monthly_credit_limit, used_credits, currency,
// out_of_credits, disabled_reason, disabled_until, ... }. Amounts in cents.
// disabled_until is the real reset (1st of next month) once the limit is hit.
function mapOverageSpendLimit(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.monthly_credit_limit == null || data.used_credits == null) return null;
  const monthlyLimit = Number(data.monthly_credit_limit) / 100;
  const usedCredits  = Number(data.used_credits) / 100;
  if (!Number.isFinite(monthlyLimit) || !Number.isFinite(usedCredits) || monthlyLimit <= 0) return null;
  return {
    isEnabled: Boolean(data.is_enabled),
    usedCredits,
    monthlyLimit,
    currency: typeof data.currency === 'string' ? data.currency : 'USD',
    utilization: (usedCredits / monthlyLimit) * 100,
    resetTime: parseApiTime(data.disabled_until),
    outOfCredits: Boolean(data.out_of_credits),
    disabledReason: typeof data.disabled_reason === 'string' ? data.disabled_reason : null,
    source: 'overage_spend_limit',
  };
}

async function fetchPrepaidCredits(orgId) {
  try {
    const data = await fetchClaudeJson(`${API_BASE}/organizations/${orgId}/prepaid/credits`);
    return { val: mapPrepaidCredits(data), failed: false };
  } catch (error) {
    // fail soft: no balance / endpoint unavailable → hide the line
    return { val: null, failed: isTransientFailure(error) };
  }
}

// Response shape: { amount: 500, currency: "EUR", ... }. amount is in cents.
// Carries its own currency so the overdraft notice can render when `extra`
// (and its currency) is null due to suspension.
function mapPrepaidCredits(data) {
  if (!data || typeof data !== 'object') return null;
  const amount = Number(data.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    amount: amount / 100,
    currency: typeof data.currency === 'string' ? data.currency : 'USD',
  };
}

function parseApiTime(value) {
  if (!value) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

// ── Threshold notifications ───────────────────────────────────────────────

const NOTIF_DEFAULTS = { enabled: true, warnAt: 80, critAt: 95 };

// Buckets that fire alerts, with the message key of the name used in the
// notification copy (translated in _locales).
const NOTIF_BUCKETS = [
  ['session', 'nbSession'],
  ['weekly',  'nbWeekly'],
  ['fable',   'nbFable'],
  ['opus',    'nbOpus'],
  ['sonnet',  'nbSonnet'],
  ['design',  'nbDesign'],
];

function msg(key, ...subs) {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

// Settings are written by options.html; re-read on every poll so changes apply
// on the next refresh without messaging. Clamped here too, in case storage was
// edited outside the options page.
async function getNotifSettings() {
  const { notifSettings } = await chrome.storage.local.get('notifSettings');
  const merged = { ...NOTIF_DEFAULTS, ...(notifSettings || {}) };
  const warnAt = clampThreshold(merged.warnAt, NOTIF_DEFAULTS.warnAt);
  const critAt = Math.max(warnAt, clampThreshold(merged.critAt, NOTIF_DEFAULTS.critAt));
  return { enabled: Boolean(merged.enabled), warnAt, critAt };
}

function clampThreshold(value, fallback) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(100, Math.max(1, num));
}

// Notify on the first crossing of each threshold per reset window. The window
// is identified by its resets_at timestamp: when it changes (new window) the
// flags clear, so each window alerts at most once per threshold, with no repeat
// notifications on every poll while usage stays above the threshold. resets_at
// jitters by up to a second or so on every read, so a reset within
// SAME_WINDOW_MS of the stored one is the same window, and the stored id is
// kept so the drift can't add up across polls.
async function checkThresholdNotifications(data) {
  const settings = await getNotifSettings();
  if (!settings.enabled) return;
  // `notifications` is an optional permission (granted from the options page or
  // the popup's alerts ask).
  // If the user hasn't granted it, the API namespace is absent: skip quietly.
  if (!chrome.notifications) return;

  const { notifState } = await chrome.storage.local.get('notifState');
  const state = (notifState && typeof notifState === 'object') ? notifState : {};
  let dirty = false;

  for (const [key, label] of NOTIF_BUCKETS) {
    const pct = data?.[key]?.percentage;
    if (pct === null || pct === undefined) continue;
    const windowId = data[key].resetTime ?? 'no-reset';
    let flags = state[key];
    const same = flags && (flags.windowId === windowId ||
      (Number.isFinite(flags.windowId) && Number.isFinite(windowId) &&
       Math.abs(flags.windowId - windowId) <= SAME_WINDOW_MS));
    if (!same) {
      flags = { windowId, warned: false, critical: false };
      state[key] = flags;
      dirty = true;
    }
    if (pct >= settings.critAt && !flags.critical) {
      flags.critical = true;
      flags.warned = true; // don't follow a critical alert with a late warning
      dirty = true;
      showThresholdNotification(key, label, pct, data[key].resetTime, true);
    } else if (pct >= settings.warnAt && !flags.warned) {
      flags.warned = true;
      dirty = true;
      showThresholdNotification(key, label, pct, data[key].resetTime, false);
    }
  }

  if (dirty) await chrome.storage.local.set({ notifState: state });
  await scheduleResetAlarm(data?.session, settings.warnAt);
}

// Reset alert: a session that crossed the warning threshold gets one more
// notification a minute after it resets. It rides on the alerts toggle and the
// `notifications` grant already checked above; no setting or permission of its
// own. resets_at jitters by up to a second or so between reads, so the alarm is
// moved only when the reset itself moved.
const RESET_ALARM = 'reset-session';
const RESET_ALARM_DELAY_MS = 60 * 1000;
// An alarm that fires late (the browser was closed through the reset) no
// longer means the session is at 0%: it only refreshes.
const RESET_ALARM_LATE_MS = 10 * 60 * 1000;

async function scheduleResetAlarm(session, warnAt) {
  const pct = session?.percentage;
  const reset = Number(session?.resetTime);
  if (!(pct >= warnAt) || !(reset > Date.now())) return;
  const when = reset + RESET_ALARM_DELAY_MS;
  const existing = await chrome.alarms.get(RESET_ALARM);
  if (existing && Math.abs(existing.scheduledTime - when) <= SAME_WINDOW_MS) return;
  chrome.alarms.create(RESET_ALARM, { when });
}

async function notifySessionReset(alarm) {
  const settings = await getNotifSettings();
  const late = Date.now() - (alarm?.scheduledTime ?? Date.now()) >= RESET_ALARM_LATE_MS;
  if (settings.enabled && chrome.notifications && !late) {
    chrome.notifications.create('usage-reset-session', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: msg('notifResetTitle'),
      message: msg('notifResetBody'),
    });
  }
  refreshUsage();
}

function showThresholdNotification(key, label, pct, resetTime, critical) {
  // A warning that arrived in time is the moment the extension proved itself,
  // so the popup's review ask keys off it (see renderReviewNudge).
  chrome.storage.local.set({ reviewMoment: { type: 'alert', at: Date.now() } });
  const resetsIn = formatTimeUntil(resetTime);
  const message = critical
    ? (resetsIn ? msg('almostResets', resetsIn) : msg('almostLimit'))
    : (resetsIn ? msg('resetsIn', resetsIn) : msg('approaching'));
  // Firefox supports only the basic subset of notification options (no
  // priority/buttons), so stick to the common fields.
  chrome.notifications.create(`usage-${key}-${critical ? 'crit' : 'warn'}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: msg('notifTitle', msg(label), Math.round(pct)),
    message,
  });
}

// d/h/m countdown for the notification copy (the popup has its own long form).
function formatTimeUntil(epochMs) {
  if (!epochMs) return null;
  const diff = epochMs - Date.now();
  if (diff <= 0) return null;
  const totalSec = Math.floor(diff / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return msg('durDH', d, h);
  if (h > 0) return msg('durHM', h, m);
  return msg('durM', m);
}

// A click on any usage alert opens the official usage page, or a new chat on
// the Free plan, where that page shows nothing. After a reset the chat is
// where people want to go, whatever the plan.
chrome.notifications?.onClicked.addListener(async (id) => {
  if (!id.startsWith('usage-')) return;
  chrome.notifications.clear(id);
  const chat = id === 'usage-reset-session' || await isFreePlan();
  const url = chat ? 'https://claude.ai/new' : 'https://claude.ai/settings/usage';
  chrome.tabs.create({ url, active: true });
});

// ── Usage history ─────────────────────────────────────────────────────────
// Local time series behind the popup sparkline and the JSON/CSV export. It
// never leaves the device and holds no chat, project, cookie or token data.

const HISTORY_KEY          = 'usageHistory';
const HISTORY_MIN_GAP_MS   = 10 * 60 * 1000;  // floor between stored samples
const HISTORY_MAX_SAMPLES  = 5000;            // ~30d at one sample / 10 min
const HISTORY_DEFAULT_DAYS = 30;
const HISTORY_MAX_DAYS     = 30;              // free-tier retention cap

const HISTORY_BUCKETS = ['session', 'weekly', 'fable', 'opus', 'sonnet', 'design'];

// Written by options.html; re-read on every append so a change applies at once.
async function getHistorySettings() {
  const { historySettings } = await chrome.storage.local.get('historySettings');
  const days = Math.round(Number(historySettings?.retentionDays));
  return {
    retentionDays: Number.isFinite(days)
      ? Math.min(HISTORY_MAX_DAYS, Math.max(1, days))
      : HISTORY_DEFAULT_DAYS,
  };
}

// One sample per successful capture. A failed refresh writes nothing: a gap in
// the series means "we could not read", never "usage was zero". Sampling is
// throttled so a 1-minute poll interval doesn't blow up storage, except when a
// reset window rolls over: that point marks the cycle boundary and must survive.
async function appendHistorySample(data) {
  const settings = await getHistorySettings();
  const stored = await chrome.storage.local.get([HISTORY_KEY, 'historyCutAt']);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const sample = await buildHistorySample(data);
  // A sample from before an org or account switch doesn't hold back the first
  // reading of the new one.
  let last = history[history.length - 1] || null;
  if (last && last.t < (Number(stored.historyCutAt) || 0)) last = null;
  if (last && (sample.t - last.t) < HISTORY_MIN_GAP_MS && !resetWindowChanged(last, sample)) return;
  history.push(sample);
  await chrome.storage.local.set({ [HISTORY_KEY]: pruneHistory(history, settings.retentionDays) });
}

// Money stays in major units, exactly as the snapshot already normalized it from
// the API's cents. The export declares currency and units so it can't be misread.
// The prepaid balance, and the credits when only the overage endpoint has them,
// come from the 30-minute cache (readExtras): `at` says when they were read.
async function buildHistorySample(data) {
  const { claudePlan, extrasCache } = await chrome.storage.local.get(['claudePlan', 'extrasCache']);
  const t = Date.now();
  const buckets = {};
  for (const key of HISTORY_BUCKETS) {
    buckets[key] = {
      pct: data?.[key]?.percentage ?? null,
      reset: data?.[key]?.resetTime ?? null,
    };
  }
  const readAt = (entry) => (Number.isFinite(entry?.at) ? entry.at : t);
  return {
    t,
    v: chrome.runtime.getManifest().version,
    plan: claudePlan?.label ?? null,
    stale: false,  // only live reads are appended; failures show up as gaps
    buckets,
    spend: data?.extra ? {
      used: data.extra.usedCredits,
      limit: data.extra.monthlyLimit,
      currency: data.extra.currency,
      source: data.extra.source ?? null,
      at: data.extra.source === 'overage_spend_limit' ? readAt(extrasCache?.overage) : t,
    } : null,
    prepaid: data?.prepaidBalance ? {
      amount: data.prepaidBalance.amount,
      currency: data.prepaidBalance.currency,
      at: readAt(extrasCache?.prepaid),
    } : null,
  };
}

// A rollover is the previous window having ended, not the reset timestamp
// changing. The API returns resets_at with sub-second jitter in both
// directions on every read (measured across consecutive polls: +0.05s, -0.27s,
// +0.91s, -1.09s), so comparing the two values for inequality was true on every
// poll and defeated the 10-minute floor entirely: one sample every 5 minutes on
// all three live buckets, two of them 8 seconds apart.
function resetWindowChanged(prev, next) {
  return HISTORY_BUCKETS.some((key) => {
    // ?? NaN, not a bare Number(): Number(null) is 0, which would read as a
    // window that ended in 1970 and make every appearing bucket a rollover.
    const before = Number(prev?.buckets?.[key]?.reset ?? NaN);
    const after  = Number(next.buckets[key].reset ?? NaN);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
    return after > before && before <= next.t;
  });
}

function pruneHistory(history, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept = history.filter(s => s && Number.isFinite(s.t) && s.t >= cutoff);
  return kept.length > HISTORY_MAX_SAMPLES ? kept.slice(kept.length - HISTORY_MAX_SAMPLES) : kept;
}

// Lowering the retention setting has to take effect immediately, not on the
// next poll, so the options page asks for a prune right after saving.
async function pruneStoredHistory() {
  const settings = await getHistorySettings();
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const kept = pruneHistory(history, settings.retentionDays);
  await chrome.storage.local.set({ [HISTORY_KEY]: kept });
  return kept.length;
}

// ── Pace forecast ─────────────────────────────────────────────────────────
// "At this pace: limit at ~16:40". The rise over the last hour (session) or day
// (weekly) of stored samples, projected to 100%, shown only when it lands
// before the reset. Samples are whole percentages at most every 10 minutes, so
// a minimum span and a minimum rise keep one rounding step from reading as a
// pace. Free without the bar has no history and stays without a forecast.
const FORECAST_MIN_RISE = 3;  // points
const FORECAST_SPANS = {
  session: { span: 60 * 60 * 1000,      minSpan: 30 * 60 * 1000 },
  weekly:  { span: 24 * 60 * 60 * 1000, minSpan: 6 * 60 * 60 * 1000 },
};
const FORECAST_MAX_AGE_MS = 30 * 60 * 1000;

async function updateForecast(data) {
  const stored = await chrome.storage.local.get([HISTORY_KEY, 'historyCutAt']);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const now = Date.now();
  const forecast = { at: now };
  for (const [key, { span, minSpan }] of Object.entries(FORECAST_SPANS)) {
    forecast[key] = windowForecast(key, data, history, now, span, minSpan, stored.historyCutAt);
  }
  await chrome.storage.local.set({ forecast });
  return forecast;
}

function windowForecast(key, data, history, now, span, minSpan, cutAt) {
  const cur = badgePct(data, key);
  const reset = Number(data?.[key]?.resetTime);
  if (cur === null || cur >= 100 || !reset || reset <= now) return null;
  const from = Math.max(now - span, Number(cutAt) || 0);
  let first = null;
  for (const sample of history) {
    const bucket = sample?.buckets?.[key];
    if (!sample || !(sample.t >= from) || !Number.isFinite(bucket?.pct)) continue;
    if (!(Math.abs(Number(bucket.reset ?? NaN) - reset) <= SAME_WINDOW_MS)) continue;  // another window
    if (!first || sample.t < first.t) first = sample;
  }
  if (!first || now - first.t < minSpan) return null;
  const rise = cur - first.buckets[key].pct;
  if (rise < FORECAST_MIN_RISE) return null;
  const eta = now + (100 - cur) * (now - first.t) / rise;
  if (eta >= reset) return null;
  return { eta: Math.round(eta), reset };
}

// What every reader checks before showing a stored forecast: still ahead, still
// before the reset, the same window as the current reading, and recent.
function shownForecast(forecast, key, data) {
  const f = forecast?.[key];
  const now = Date.now();
  if (!f || !(forecast.at > now - FORECAST_MAX_AGE_MS)) return null;
  if (!(f.eta > now) || !(f.eta < f.reset)) return null;
  if (!(Math.abs(f.reset - Number(data?.[key]?.resetTime)) <= SAME_WINDOW_MS)) return null;
  return f;
}

// "16:40" today, "Thu 09:00" on another day, in the UI language.
function formatClock(epochMs) {
  const d = new Date(epochMs);
  const time = d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${time}`;
}

// ── Badge helpers ─────────────────────────────────────────────────────────

async function persistAndBadge(data) {
  const next = sanitizeUsageData(data);
  if (!next) return false;
  if (!shouldPersist(next)) return false;

  next.lastUpdated = Date.now();
  await chrome.storage.local.set({ claudeUsage: next });
  // Before the badge, so its tooltip carries the forecast of this same reading.
  try { await updateForecast(next); } catch { /* data is already persisted */ }
  await updateBadge(next);
  // Alerts ride on the fresh data but must never break the refresh itself.
  try { await checkThresholdNotifications(next); } catch { /* data is already persisted */ }
  // Same posture for the history append: best-effort, never blocks a refresh.
  try { await appendHistorySample(next); } catch { /* data is already persisted */ }
  try { await updateMsgEstimate(next); } catch { /* data is already persisted */ }
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
    fable: {
      percentage: normalizePct(data.fable?.percentage),
      resetTime: data.fable?.resetTime ?? null,
      label: data.fable?.label ?? null,
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
    prepaidBalance: sanitizePrepaid(data.prepaidBalance),
    routine: sanitizeRoutine(data.routine),
    meta: {
      ready: Boolean(data.meta?.ready),
    },
    // 'stream' = read from a reply on claude.ai (Free plan); never refreshed in
    // between, so readers treat a passed reset as 0% rather than the old figure.
    source: data.source === 'stream' ? 'stream' : 'api',
  };

  if (clone.session.percentage === null && clone.weekly.percentage === null) return null;
  return clone;
}

function sanitizeRoutine(routine) {
  if (!routine || typeof routine !== 'object') return null;
  const used  = Number(routine.used);
  const limit = Number(routine.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return { used, limit };
}

function sanitizeExtra(extra) {
  if (!extra || typeof extra !== 'object') return null;
  const usedCredits = Number(extra.usedCredits);
  const monthlyLimit = Number(extra.monthlyLimit);
  if (!Number.isFinite(usedCredits) || !Number.isFinite(monthlyLimit) || monthlyLimit <= 0) return null;
  const utilization = Number(extra.utilization);
  const resetTime = Number(extra.resetTime);
  return {
    isEnabled: Boolean(extra.isEnabled),
    usedCredits,
    monthlyLimit,
    currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
    utilization: Number.isFinite(utilization) ? utilization : (usedCredits / monthlyLimit) * 100,
    resetTime: Number.isFinite(resetTime) ? resetTime : null,
    outOfCredits: Boolean(extra.outOfCredits),
    disabledReason: typeof extra.disabledReason === 'string' ? extra.disabledReason : null,
    // Which endpoint produced this reading. The two are not interchangeable
    // (extra_usage goes null on suspension), so the history records the origin.
    source: typeof extra.source === 'string' ? extra.source : null,
  };
}

function sanitizePrepaid(prepaid) {
  if (!prepaid || typeof prepaid !== 'object') return null;
  const amount = Number(prepaid.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    amount,
    currency: typeof prepaid.currency === 'string' ? prepaid.currency : 'USD',
  };
}

function normalizePct(value) {
  // Treat null/undefined/empty as "no data": Number(null) is 0, which would
  // otherwise pollute a bucket with a fake 0% when the API returns the whole
  // bucket as null (meaning the bucket does not apply to the user's plan).
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  // Overage can push utilization past 100; clamp instead of dropping the
  // bucket, or the user would see stale data right when they hit the limit.
  return Math.min(num, 100);
}

function shouldPersist(next) {
  // API data is authoritative: persist whenever it parsed successfully.
  return Boolean(next?.meta?.ready);
}

// Last line of the tooltip: the same name the toolbar shows before any data.
const BADGE_NAME = chrome.runtime.getManifest().action.default_title;

// The badge shows the session, unless a weekly cap has reached the user's
// warning threshold and is fuller than the session: a green "0%" next to a
// weekly cap at 95% read as wrong data. That figure takes the badge in red
// with a W prefix ("W95"), and the tooltip spells out both windows.
async function updateBadge(data) {
  const pct = badgePct(data, 'session');
  const weekly = fullestWeekly(data);
  const { warnAt } = await getNotifSettings();
  const { forecast } = await chrome.storage.local.get('forecast');
  chrome.action.setTitle({ title: badgeTitle(data, pct, weekly, shownForecast(forecast, 'session', data)) });

  if (weekly && weekly.pct >= warnAt && weekly.pct > (pct ?? -1)) {
    chrome.action.setBadgeText({ text: `W${Math.round(weekly.pct)}` });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    return;
  }

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

// A reply-sourced window that has reset is at 0% until the next message.
function badgePct(data, key) {
  const bucket = data?.[key];
  if (data?.source === 'stream' && bucket?.resetTime && bucket.resetTime <= Date.now()) return 0;
  return bucket?.percentage ?? null;
}

// The fullest weekly window: all models or a per-model cap, named as in alerts.
function fullestWeekly(data) {
  let best = null;
  for (const [key, label] of NOTIF_BUCKETS) {
    if (key === 'session') continue;
    const pct = badgePct(data, key);
    if (pct !== null && (!best || pct > best.pct)) best = { pct, label, resetTime: data[key].resetTime };
  }
  return best;
}

// One line per window, then the name. The session reset is a countdown; the
// weekly one is a day and time, which stays right between polls. The session
// pace forecast, when there is one, goes right under the session line.
function badgeTitle(data, sessionPct, weekly, sessionForecast) {
  const lines = [];
  if (sessionPct !== null) {
    const pct = Math.round(sessionPct);
    const resetsIn = formatTimeUntil(data.session.resetTime);
    lines.push(resetsIn ? msg('barTitleReset', msg('nbSession'), pct, resetsIn) : msg('barTitle', msg('nbSession'), pct));
    if (sessionForecast) {
      lines.push(msg('forecastLine', formatClock(sessionForecast.eta), formatClock(sessionForecast.reset)));
    }
  }
  if (weekly) {
    const pct = Math.round(weekly.pct);
    const resetsAt = formatResetAt(weekly.resetTime);
    lines.push(resetsAt ? msg('tipResetsAt', msg(weekly.label), pct, resetsAt) : msg('barTitle', msg(weekly.label), pct));
  }
  lines.push(BADGE_NAME);
  return lines.join('\n');
}

// "Thu 09:00", in the UI language and its clock format.
function formatResetAt(epochMs) {
  if (!epochMs || epochMs <= Date.now()) return null;
  const d = new Date(epochMs);
  return `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' })}`;
}

// Gray out the badge while auth is failing, so a stale percentage isn't
// mistaken for live data. The text (last known %) stays readable.
function markBadgeStale() {
  chrome.action.setBadgeBackgroundColor({ color: '#555555' });
}

// Signed out of claude.ai: the tooltip says what brings the numbers back.
function markBadgeSignedOut() {
  markBadgeStale();
  chrome.action.setTitle({ title: `${msg('tipSignIn')}\n${BADGE_NAME}` });
}

// Free plan with nothing read yet: /usage is all null there, and the bar's
// reply reader is the only source. A gray "?" and a tooltip that says so,
// instead of an empty badge.
async function markBadgeFreeNoData() {
  const { pageBar } = await chrome.storage.local.get('pageBar');
  const barOn = Boolean(pageBar?.enabled) && await pageBarGranted();
  chrome.action.setBadgeText({ text: '?' });
  chrome.action.setBadgeBackgroundColor({ color: '#555555' });
  chrome.action.setTitle({ title: `${msg(barOn ? 'barFreeWaiting' : 'tipFreeBarOff')}\n${BADGE_NAME}` });
}

// The bar toggled while that hint is up: swap the hint without waiting a poll.
async function refreshFreeHint() {
  try {
    const { claudeUsage, claudePlan, authBackoff } = await chrome.storage.local.get(['claudeUsage', 'claudePlan', 'authBackoff']);
    if (!claudeUsage && claudePlan?.label === 'Free' && !(authBackoff?.fails > 0)) await markBadgeFreeNoData();
  } catch { /* cosmetic */ }
}

// ── Restore badge on startup from cached data ────────────────────────────

// Awaited so the stale marks land on top of the redrawn badge, not under it.
chrome.storage.local.get(['claudeUsage', 'authBackoff', 'fetchFailures'], async ({ claudeUsage, authBackoff, fetchFailures }) => {
  if (claudeUsage) await updateBadge(claudeUsage);
  if (authBackoff && authBackoff.fails > 0) markBadgeSignedOut();
  if ((fetchFailures?.count ?? 0) >= FETCH_FAIL_STALE) markBadgeStale();
});
