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

function save() {
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

testBtn.addEventListener('click', () => {
  chrome.notifications.create('usage-test', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Claude session at 82%',
    message: 'Resets in 1h 23m (test)',
  });
});
