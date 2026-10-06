// ─── Claude Usage Monitor — Background Service Worker ──────────────────────
// Polls Claude.ai's authenticated usage API every 5 minutes, persists the
// result to chrome.storage.local, and updates the toolbar badge.

const API_BASE   = 'https://claude.ai/api';
const ALARM_NAME = 'claudetrack-poll';
const POLL_MIN   = 5;   // minutes between automatic refreshes

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

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  setupAlarm();
  refreshUsage();   // fetch immediately on install/update
  markInstalledAt();
  setUninstallFeedbackUrl();
  syncPageScripts();
  if (details?.reason === 'update') markWindowsPromoOnUpdate();
});

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

async function syncPageScripts() {
  try {
    const { pageBar } = await chrome.storage.local.get('pageBar');
    const granted = await pageBarGranted();
    if (!chrome.scripting?.registerContentScripts) return; // namespace absent until granted
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

chrome.permissions.onAdded.addListener(syncPageScripts);
// Access revoked from the browser's own extension settings: turn the toggle off
// too, so the options page and the popup don't claim a bar that can't run.
chrome.permissions.onRemoved.addListener(async () => {
  if (!(await pageBarGranted())) await chrome.storage.local.set({ pageBar: { enabled: false } });
  syncPageScripts();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pageBar) syncPageScripts();
});

// Limits read from a reply by page/stream.js. On the Free plan they are the
// only figures that exist, so they become the stored snapshot. On paid plans
// /usage stays authoritative; a reply just means usage moved, so it triggers a
// refresh (throttled) and the bar catches up seconds after each message.
const STREAM_REFRESH_GAP_MS = 20 * 1000;
const STREAM_MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

async function applyStreamLimits(limits) {
  const { claudePlan, claudeUsage } = await chrome.storage.local.get(['claudePlan', 'claudeUsage']);
  if (claudePlan?.label !== 'Free') {
    if (!claudeUsage?.lastUpdated || Date.now() - claudeUsage.lastUpdated > STREAM_REFRESH_GAP_MS) {
      await refreshUsage();
    }
    return;
  }
  const session = streamWindow(limits?.session, claudeUsage?.source === 'stream' ? claudeUsage.session : null);
  const weekly  = streamWindow(limits?.weekly,  claudeUsage?.source === 'stream' ? claudeUsage.weekly  : null);
  if (!session && !weekly) return;
  const empty = { percentage: null, resetTime: null, label: null };
  const stored = await persistAndBadge({
    session: session || empty,
    weekly: weekly || empty,
    fable: empty, opus: empty, sonnet: empty, design: empty,
    extra: null, prepaidBalance: null, routine: null,
    meta: { ready: true },
    source: 'stream',
  });
  if (stored) {
    await chrome.storage.local.remove('fetchFailures');
    // First Free-plan reading ever: the limits Claude hides from its own usage
    // page just showed up. Same moment-of-value signal as a timely alert.
    if (claudeUsage?.source !== 'stream') {
      await chrome.storage.local.set({ reviewMoment: { type: 'free', at: Date.now() } });
    }
  }
}

// Validates one window from the page (the page world is not trusted with
// anything beyond two numbers) and keeps the previous figure when the new one
// is lower within the same window: the reply and the accounting round
// independently, so a reading can dip by a point before it settles.
function streamWindow(incoming, previous) {
  const pct = Number(incoming?.percentage);
  const reset = Number(incoming?.resetTime);
  if (!Number.isFinite(pct) || pct < 0 || !Number.isFinite(reset)) return null;
  if (reset <= Date.now() || reset > Date.now() + STREAM_MAX_RESET_AHEAD_MS) return null;
  const next = { percentage: Math.min(pct, 100), resetTime: reset, label: null };
  const sameWindow = previous && Math.abs((previous.resetTime || 0) - reset) < 60 * 1000;
  return sameWindow && Number(previous.percentage) > next.percentage ? previous : next;
}

// One-question exit survey. Carries only the version and the browser family,
// so the page can route the answer; no identifier, no usage data.
function setUninstallFeedbackUrl() {
  if (!chrome.runtime.setUninstallURL) return;
  const version = chrome.runtime.getManifest().version;
  const ua = navigator.userAgent;
  const browser = ua.includes('Firefox') ? 'firefox' : ua.includes('Edg/') ? 'edge' : 'chrome';
  chrome.runtime.setUninstallURL(`https://claude-monitor.com/uninstall?v=${version}&b=${browser}`);
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
    // Manual refresh bypasses the auth backoff: the user may have just signed
    // back in, and waiting out the remaining skipped ticks would keep data stale.
    refreshUsage({ force: true })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }
  if (msg.type === 'STREAM_LIMITS') {
    applyStreamLimits(msg.limits)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'PRUNE_HISTORY') {
    pruneStoredHistory()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
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
});

// ── Core refresh logic ────────────────────────────────────────────────────

async function refreshUsage({ force = false } = {}) {
  if (!force && await shouldSkipForAuthBackoff()) {
    return { refreshed: false, reason: 'auth-backoff' };
  }
  const apiResult = await refreshUsageFromApi();
  if (apiResult.refreshed) {
    await clearAuthBackoff();
    await chrome.storage.local.remove('fetchFailures');
    return { ...apiResult, source: 'api' };
  }
  if (apiResult.reason === 'auth-failed') {
    await bumpAuthBackoff();
    markBadgeStale();
  } else if (apiResult.reason === 'api-data-rejected' && await isFreePlan()) {
    // Expected, not a failure: /usage answers with every field null on the
    // Free plan. Whatever a reply reported (applyStreamLimits) stays as is.
    await clearAuthBackoff();
    const { claudeUsage } = await chrome.storage.local.get('claudeUsage');
    if (claudeUsage) updateBadge(claudeUsage);  // the poll is what moves an expired window to 0%
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

async function refreshUsageFromApi() {
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
    // Routine budget is a separate, optional fetch — never let it break the
    // refresh. Null when unavailable (other plan, auth, beta changed) → card hides.
    data.routine = await fetchRoutineBudget(activeOrgId);
    // Credits spend/limit. usage.extra_usage is scoped to the signed-in member,
    // while overage_spend_limit is the organization-wide limit — on Team/
    // Enterprise accounts the second one is much larger than what the member
    // sees in Claude. So use extra_usage for the numbers when it has them, and
    // borrow the overage endpoint's reset/suspension fields, which extra_usage
    // lacks. When extra_usage is null (suspended member) the overage payload is
    // the only source left, so fall back to it whole.
    const overage = await fetchOverageSpendLimit(activeOrgId);
    data.extra = mergeCreditSources(data.extra, overage);
    // Prepaid balance ("current balance"), shown next to the credits card.
    // Always fetched; fail-soft to null so it never breaks the refresh.
    data.prepaidBalance = await fetchPrepaidCredits(activeOrgId);
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
  const { claudeOrgId, claudeOrgIdAt, claudePlan } = await chrome.storage.local.get(['claudeOrgId', 'claudeOrgIdAt', 'claudePlan']);
  const fresh = claudeOrgIdAt && (Date.now() - claudeOrgIdAt) < ORG_ID_TTL_MS;
  // Only short-circuit when the plan is also cached, so an existing install
  // (org id already cached) still fetches the org list once to populate the plan
  // badge. PLAN_SCHEMA forces one refetch after an update that changes how the
  // plan is derived (v2: Free accounts read as tier default_claude_ai).
  if (claudeOrgId && fresh && claudePlan?.v === PLAN_SCHEMA) return claudeOrgId;

  const organizations = await fetchClaudeJson(`${API_BASE}/organizations`);
  const org = selectOrg(organizations);
  const orgId = (org && (org.uuid || org.organization_uuid || org.id)) || null;
  if (orgId) {
    await chrome.storage.local.set({ claudeOrgId: orgId, claudeOrgIdAt: Date.now() });
  }
  // A different org means a different account signed in to claude.ai. The
  // stored reading belongs to the previous one and must not be shown as this
  // account's usage, so it goes, along with the alert state tied to it.
  if (claudeOrgId && orgId && orgId !== claudeOrgId) {
    await chrome.storage.local.remove(['claudeUsage', 'fetchFailures', 'notifState']);
    chrome.action.setBadgeText({ text: '' });
  }
  await chrome.storage.local.set({ claudePlan: derivePlan(org) });
  return orgId;
}

function selectOrg(payload) {
  const orgs = Array.isArray(payload) ? payload
    : Array.isArray(payload?.organizations) ? payload.organizations
    : [];
  // Multi-org accounts (e.g. Team/Enterprise plus a personal workspace): prefer
  // the org that hosts the chat product; otherwise keep the first entry.
  const chatOrg = orgs.find(o => Array.isArray(o?.capabilities) && o.capabilities.includes('chat'));
  return chatOrg || orgs[0] || null;
}

// Extract a displayable subscription label from the org payload. The
// /api/organizations response (already fetched for the org id) carries
// rate_limit_tier + capabilities — no extra request or permission needed.
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
    // Fable has no flat seven_day_* bucket — its weekly cap only exists as a
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
// carry scope.model.display_name (e.g. "Fable" — per-model caps live ONLY here,
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
// overage_spend_limit source. Returns null when suspended (used/limit null) —
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
    if (!response.ok) return null; // fail soft: 404 (no beta/plan), 400, 401 → hide card
    return mapRoutineBudget(await response.json());
  } catch {
    return null;
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

// Primary credits source — the same endpoint claude.ai /usage uses for the
// "Usage credits" card. Plain cookie auth (no special headers). Returns the
// spend/limit/reset even while suspended, unlike usage.extra_usage.
async function fetchOverageSpendLimit(orgId) {
  try {
    const data = await fetchClaudeJson(`${API_BASE}/organizations/${orgId}/overage_spend_limit`);
    return mapOverageSpendLimit(data);
  } catch {
    return null; // fail soft: 403/404 (not offered on this plan) → use fallback
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
    return mapPrepaidCredits(data);
  } catch {
    return null; // fail soft: no balance / endpoint unavailable → hide the line
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

// Buckets that fire alerts, with the display name used in the notification copy.
const NOTIF_BUCKETS = [
  ['session', 'Claude session'],
  ['weekly',  'Claude weekly limit'],
  ['fable',   'Fable 5 weekly cap'],
  ['opus',    'Opus weekly cap'],
  ['sonnet',  'Sonnet weekly cap'],
  ['design',  'Claude Design weekly cap'],
];

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
// flags clear, so each window alerts at most once per threshold — no repeat
// notifications on every poll while usage stays above the threshold.
async function checkThresholdNotifications(data) {
  const settings = await getNotifSettings();
  if (!settings.enabled) return;
  // `notifications` is an optional permission (granted from the options page).
  // If the user hasn't granted it, the API namespace is absent — skip quietly.
  if (!chrome.notifications) return;

  const { notifState } = await chrome.storage.local.get('notifState');
  const state = (notifState && typeof notifState === 'object') ? notifState : {};
  let dirty = false;

  for (const [key, label] of NOTIF_BUCKETS) {
    const pct = data?.[key]?.percentage;
    if (pct === null || pct === undefined) continue;
    const windowId = data[key].resetTime ?? 'no-reset';
    let flags = state[key];
    if (!flags || flags.windowId !== windowId) {
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
}

function showThresholdNotification(key, label, pct, resetTime, critical) {
  // A warning that arrived in time is the moment the extension proved itself,
  // so the popup's review ask keys off it (see renderReviewNudge).
  chrome.storage.local.set({ reviewMoment: { type: 'alert', at: Date.now() } });
  const resetsIn = formatTimeUntil(resetTime);
  const message = critical
    ? (resetsIn ? `Almost at the limit — resets in ${resetsIn}` : 'Almost at the limit')
    : (resetsIn ? `Resets in ${resetsIn}` : 'Approaching the limit');
  // Firefox supports only the basic subset of notification options — no
  // priority/buttons — so stick to the common fields.
  chrome.notifications.create(`usage-${key}-${critical ? 'crit' : 'warn'}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${label} at ${Math.round(pct)}%`,
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
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// A click on any usage alert opens the official usage page.
chrome.notifications?.onClicked.addListener((id) => {
  if (!id.startsWith('usage-')) return;
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: 'https://claude.ai/settings/usage', active: true });
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
// reset window rolls over — that point marks the cycle boundary and must survive.
async function appendHistorySample(data) {
  const settings = await getHistorySettings();
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  const sample = await buildHistorySample(data);
  const last = history[history.length - 1] || null;
  if (last && (sample.t - last.t) < HISTORY_MIN_GAP_MS && !resetWindowChanged(last, sample)) return;
  history.push(sample);
  await chrome.storage.local.set({ [HISTORY_KEY]: pruneHistory(history, settings.retentionDays) });
}

// Money stays in major units, exactly as the snapshot already normalized it from
// the API's cents. The export declares currency and units so it can't be misread.
async function buildHistorySample(data) {
  const { claudePlan } = await chrome.storage.local.get('claudePlan');
  const buckets = {};
  for (const key of HISTORY_BUCKETS) {
    buckets[key] = {
      pct: data?.[key]?.percentage ?? null,
      reset: data?.[key]?.resetTime ?? null,
    };
  }
  return {
    t: Date.now(),
    v: chrome.runtime.getManifest().version,
    plan: claudePlan?.label ?? null,
    stale: false,  // only live reads are appended; failures show up as gaps
    buckets,
    spend: data?.extra ? {
      used: data.extra.usedCredits,
      limit: data.extra.monthlyLimit,
      currency: data.extra.currency,
      source: data.extra.source ?? null,
    } : null,
    prepaid: data?.prepaidBalance ? {
      amount: data.prepaidBalance.amount,
      currency: data.prepaidBalance.currency,
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

// ── Badge helpers ─────────────────────────────────────────────────────────

async function persistAndBadge(data) {
  const next = sanitizeUsageData(data);
  if (!next) return false;
  if (!shouldPersist(next)) return false;

  next.lastUpdated = Date.now();
  await chrome.storage.local.set({ claudeUsage: next });
  updateBadge(next);
  // Alerts ride on the fresh data but must never break the refresh itself.
  try { await checkThresholdNotifications(next); } catch { /* data is already persisted */ }
  // Same posture for the history append: best-effort, never blocks a refresh.
  try { await appendHistorySample(next); } catch { /* data is already persisted */ }
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
  // Treat null/undefined/empty as "no data" — Number(null) is 0, which would
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
  // API data is authoritative — persist whenever it parsed successfully.
  return Boolean(next?.meta?.ready);
}

function updateBadge(data) {
  // A reply-sourced window that has reset is at 0% until the next message.
  const expired = data?.source === 'stream' && data.session?.resetTime && data.session.resetTime <= Date.now();
  const pct = expired ? 0 : (data?.session?.percentage ?? null);

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

// Gray out the badge while auth is failing, so a stale percentage isn't
// mistaken for live data. The text (last known %) stays readable.
function markBadgeStale() {
  chrome.action.setBadgeBackgroundColor({ color: '#555555' });
}

// ── Restore badge on startup from cached data ────────────────────────────

chrome.storage.local.get(['claudeUsage', 'authBackoff', 'fetchFailures'], ({ claudeUsage, authBackoff, fetchFailures }) => {
  if (claudeUsage) updateBadge(claudeUsage);
  if (authBackoff && authBackoff.fails > 0) markBadgeStale();
  if ((fetchFailures?.count ?? 0) >= FETCH_FAIL_STALE) markBadgeStale();
});
