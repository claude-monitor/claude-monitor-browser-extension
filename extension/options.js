// ─── Claude Usage Monitor — Options ──────────────────────────────────────────
// Notification settings, stored under `notifSettings`. The background worker
// re-reads them on every poll, so changes apply on the next refresh.

const DEFAULTS = { enabled: true, warnAt: 80, critAt: 95 };

const enabledEl = document.getElementById('notifEnabled');
const warnEl    = document.getElementById('warnAt');
const critEl    = document.getElementById('critAt');
const testBtn   = document.getElementById('testBtn');
const statusEl  = document.getElementById('status');

function clampThreshold(value, fallback) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(100, Math.max(1, num));
}

chrome.storage.local.get('notifSettings', ({ notifSettings }) => {
  const s = { ...DEFAULTS, ...(notifSettings || {}) };
  enabledEl.checked = Boolean(s.enabled);
  warnEl.value = clampThreshold(s.warnAt, DEFAULTS.warnAt);
  critEl.value = clampThreshold(s.critAt, DEFAULTS.critAt);
});

let statusTimer = null;

function flashStatus(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
}

// `notifications` is an optional permission, requested from a user gesture the
// first time notifications are turned on. Chrome no longer disables the whole
// extension on update because the permission isn't required up front.
function ensureNotifPermission() {
  return new Promise((resolve) => {
    chrome.permissions.contains({ permissions: ['notifications'] }, (has) => {
      if (has) return resolve(true);
      chrome.permissions.request({ permissions: ['notifications'] }, (granted) => resolve(Boolean(granted)));
    });
  });
}

async function save() {
  // Turning notifications on needs the optional permission; if the user denies
  // it, revert the toggle and don't persist an enabled state we can't honor.
  if (enabledEl.checked) {
    const granted = await ensureNotifPermission();
    if (!granted) {
      enabledEl.checked = false;
      flashStatus('Permission denied');
      return;
    }
  }
  const warnAt = clampThreshold(warnEl.value, DEFAULTS.warnAt);
  // The critical threshold can't sit below the warning one.
  const critAt = Math.max(warnAt, clampThreshold(critEl.value, DEFAULTS.critAt));
  warnEl.value = warnAt;
  critEl.value = critAt;
  chrome.storage.local.set(
    { notifSettings: { enabled: enabledEl.checked, warnAt, critAt } },
    () => flashStatus('Saved'),
  );
}

[enabledEl, warnEl, critEl].forEach(el => el.addEventListener('change', save));

testBtn.addEventListener('click', async () => {
  if (!(await ensureNotifPermission())) { flashStatus('Permission denied'); return; }
  chrome.notifications.create('usage-test', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Claude session at 82%',
    message: 'Resets in 1h 23m (test)',
  });
});

// ─── History ─────────────────────────────────────────────────────────────────
// The series is written by the background worker under `usageHistory`. Here we
// only expose retention, the sample count, the export and the clear action.

const HISTORY_KEY = 'usageHistory';
const HISTORY_DEFAULT_DAYS = 30;
const EXPORT_SCHEMA = 'claude-usage-monitor.history/1';
const HISTORY_BUCKETS = ['session', 'weekly', 'fable', 'opus', 'sonnet', 'design'];

const retentionEl  = document.getElementById('retentionDays');
const countEl      = document.getElementById('historyCount');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportCsvBtn  = document.getElementById('exportCsvBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

function readHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.get(HISTORY_KEY, (stored) => {
      resolve(Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : []);
    });
  });
}

async function refreshHistoryCount() {
  countEl.textContent = String((await readHistory()).length);
}

chrome.storage.local.get('historySettings', ({ historySettings }) => {
  const days = Number(historySettings?.retentionDays);
  retentionEl.value = String([7, 14, 30].includes(days) ? days : HISTORY_DEFAULT_DAYS);
});

refreshHistoryCount();

retentionEl.addEventListener('change', () => {
  const retentionDays = Number(retentionEl.value) || HISTORY_DEFAULT_DAYS;
  chrome.storage.local.set({ historySettings: { retentionDays } }, () => {
    // Shortening the window must drop the excess now, not on the next poll.
    chrome.runtime.sendMessage({ type: 'PRUNE_HISTORY' }, () => {
      void chrome.runtime.lastError;   // worker asleep → prune happens on next append
      refreshHistoryCount();
      flashStatus('Saved');
    });
  });
});

clearHistoryBtn.addEventListener('click', () => {
  chrome.storage.local.remove(HISTORY_KEY, () => {
    refreshHistoryCount();
    flashStatus('History cleared');
  });
});

function isoOrNull(epochMs) {
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

// Self-describing export: every money amount carries its currency and the unit
// it is expressed in, and a missing reading is null, never 0.
function toExportSample(sample) {
  const buckets = {};
  for (const key of HISTORY_BUCKETS) {
    buckets[key] = {
      utilization: sample?.buckets?.[key]?.pct ?? null,
      resetsAt: isoOrNull(sample?.buckets?.[key]?.reset),
    };
  }
  return {
    capturedAt: isoOrNull(sample?.t),
    clientVersion: sample?.v ?? null,
    plan: sample?.plan ?? null,
    stale: Boolean(sample?.stale),
    buckets,
    spend: sample?.spend
      ? {
          used: sample.spend.used ?? null,
          limit: sample.spend.limit ?? null,
          currency: sample.spend.currency ?? null,
          source: sample.spend.source ?? null,
        }
      : null,
    prepaidBalance: sample?.prepaid
      ? { amount: sample.prepaid.amount ?? null, currency: sample.prepaid.currency ?? null }
      : null,
  };
}

function buildJsonExport(history) {
  return JSON.stringify({
    schema: EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    client: {
      name: 'claude-usage-monitor-extension',
      version: chrome.runtime.getManifest().version,
    },
    amountsIn: 'major',
    minorUnitsPerMajor: 100,
    notes: 'A null value means the reading was unavailable, never zero. Gaps in the '
         + 'series mean the refresh failed. Amounts are as reported by the provider.',
    samples: history.map(toExportSample),
  }, null, 2);
}

const CSV_COLUMNS = [
  'captured_at', 'client_version', 'plan',
  ...HISTORY_BUCKETS.flatMap(key => [`${key}_utilization`, `${key}_resets_at`]),
  'spend_used', 'spend_limit', 'spend_currency', 'spend_source',
  'prepaid_amount', 'prepaid_currency',
  'amounts_in', 'minor_units_per_major',
];

function csvCell(value) {
  // Empty cell means "no data". CSV has no null, so this is stated in the header
  // comment of the JSON export and in the options page copy.
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsvExport(history) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const sample of history) {
    const s = toExportSample(sample);
    const cells = [
      s.capturedAt, s.clientVersion, s.plan,
      ...HISTORY_BUCKETS.flatMap(key => [s.buckets[key].utilization, s.buckets[key].resetsAt]),
      s.spend?.used ?? null, s.spend?.limit ?? null, s.spend?.currency ?? null, s.spend?.source ?? null,
      s.prepaidBalance?.amount ?? null, s.prepaidBalance?.currency ?? null,
      'major', 100,
    ];
    rows.push(cells.map(csvCell).join(','));
  }
  return rows.join('\n');
}

function downloadFile(filename, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportStamp() {
  return new Date().toISOString().slice(0, 10);
}

exportJsonBtn.addEventListener('click', async () => {
  const history = await readHistory();
  if (!history.length) { flashStatus('No history yet'); return; }
  downloadFile(`claude-usage-history-${exportStamp()}.json`, 'application/json', buildJsonExport(history));
  flashStatus('Exported');
});

exportCsvBtn.addEventListener('click', async () => {
  const history = await readHistory();
  if (!history.length) { flashStatus('No history yet'); return; }
  downloadFile(`claude-usage-history-${exportStamp()}.csv`, 'text/csv', buildCsvExport(history));
  flashStatus('Exported');
});

// ─── Windows companion promo ─────────────────────────────────────────────────
// Shown only on Windows, where the app can actually be installed. The cid is
// what Partner Center splits campaigns by, so this surface carries its own.

const WIN_PROMO_URL = 'https://apps.microsoft.com/detail/9NNZK4V8CZM0?cid=ext-options';

const winPromoRow  = document.getElementById('winPromoRow');
const winPromoLink = document.getElementById('winPromoLink');

if (navigator.userAgent.includes('Windows NT') && winPromoRow && winPromoLink) {
  winPromoLink.href = WIN_PROMO_URL;
  winPromoRow.style.display = 'block';
}
