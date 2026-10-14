// ─── Claude Usage Monitor: Welcome ───────────────────────────────────────────
// Opened by the worker on install only. Each step reads the same storage the
// popup does and ticks itself off live. The bar and alerts permissions are
// optional and need a click on an extension page, which is why this page
// exists: it is the first place a fresh install can ask for them.

const SIGN_IN_URL    = 'https://claude.ai/login';
const CHAT_URL       = 'https://claude.ai/new';
const CLAUDE_TABS    = 'https://claude.ai/*';
const PAGE_BAR_PERMS = { origins: [CLAUDE_TABS], permissions: ['scripting'] };
const NOTIF_PERMS    = { permissions: ['notifications'] };
const PIN_CHECK_MS   = 2000;

// Dates follow the UI language only where the UI is translated; otherwise an
// English UI would show, say, Arabic or Russian dates (14 store-only locales).
const UI_LANG = chrome.i18n.getUILanguage();
const UI_BASES = ['es', 'de', 'fr', 'it', 'ja', 'ko'];
const LOCALE = (UI_LANG === 'pt-BR' || UI_BASES.includes(UI_LANG.split('-')[0])) ? UI_LANG : 'en-US';

function msg(key, ...subs) {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

document.documentElement.lang = LOCALE === 'en-US' ? 'en' : UI_LANG;
document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = msg(el.dataset.i18n); });

const $ = id => document.getElementById(id);

function setStep(stepEl, state) {
  if (stepEl) stepEl.dataset.state = state;
}

function setStatus(el, key) {
  el.textContent = key ? msg(key) : '';
  el.hidden = !key;
}

function permissionGranted(perms) {
  return new Promise((resolve) => {
    chrome.permissions.contains(perms, (granted) => {
      void chrome.runtime.lastError;
      resolve(Boolean(granted));
    });
  });
}

function refresh(source) {
  chrome.runtime.sendMessage({ type: 'REFRESH', source }, () => { void chrome.runtime.lastError; });
}

// ── (a) Claude session ───────────────────────────────────────────────────────
// lastRefresh is the worker's latest attempt, so a sign-in it just failed on
// wins over an older reading; any reading at all means the login works.

const signStep   = $('stepSign');
const signStatus = $('signStatus');
const signBtn    = $('signBtn');
const signRetry  = $('signRetry');

let signInOpened = false;

function signState({ claudeUsage, authBackoff, lastRefresh }) {
  const reason = lastRefresh?.reason;
  if (reason === 'auth-failed') return 'needed';
  if (claudeUsage || reason === 'ok' || reason === 'free-plan') return 'ok';
  if ((authBackoff?.fails ?? 0) > 0) return 'needed';
  if (!lastRefresh) return 'checking';
  if (reason === 'org-not-found') return 'org';
  return 'fail';
}

const SIGN_VIEW = {
  checking: { step: 'wait', text: 'wcSignChecking' },
  ok:       { step: 'done', text: 'wcSignOk' },
  needed:   { step: 'warn', text: 'wcSignNeeded', sign: true },
  org:      { step: 'warn', text: 'emptyOrgTitle', retry: true },
  fail:     { step: 'warn', text: 'emptyFailTitle', retry: true },
};

function renderSign(stored) {
  const state = signState(stored);
  const view = SIGN_VIEW[state];
  setStep(signStep, view.step);
  setStatus(signStatus, view.text);
  signBtn.hidden = !view.sign;
  signRetry.hidden = !view.retry;
  if (state === 'ok') signInOpened = false;
}

signBtn.addEventListener('click', () => {
  signInOpened = true;
  chrome.tabs.create({ url: SIGN_IN_URL, active: true });
});

signRetry.addEventListener('click', () => refresh('manual'));

// Back from the sign-in tab: read now, past the backoff, instead of on the
// next tick minutes away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && signInOpened) refresh('manual');
});

// ── (b) On-page bar ──────────────────────────────────────────────────────────

const barStep   = $('stepBar');
const barBtn    = $('barBtn');
const barStatus = $('barStatus');
const freeNote  = $('freeNote');

function renderBar(state) {
  setStep(barStep, state === 'on' ? 'done' : 'todo');
  barBtn.hidden = state === 'on';
  setStatus(barStatus, state === 'on' ? 'wcBarOn' : state === 'denied' ? 'wcBarDenied' : null);
}

async function renderBarFromStorage() {
  const { pageBar } = await chrome.storage.local.get('pageBar');
  const on = Boolean(pageBar?.enabled) && await permissionGranted(PAGE_BAR_PERMS);
  if (on) renderBar('on');
  else if (barStep.dataset.state === 'done') renderBar('off');   // turned off since
}

// claude.ai with the bar: an open tab if there is one (the worker injects the
// bar into it), a new chat otherwise. Done brings it to the front.
async function focusClaude() {
  try {
    const [tab] = await chrome.tabs.query({ url: CLAUDE_TABS });
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch { /* fall back to a new tab */ }
  chrome.tabs.create({ url: CHAT_URL, active: true });
}

// Chrome grants the bar without a prompt, so jumping to claude.ai on the click
// skipped the confirmation and left the pin and alerts steps in a background
// tab. A chat is opened behind this one instead (unless claude.ai is already
// open), and Done is what goes there.
async function openClaudeInBackground() {
  try {
    const [tab] = await chrome.tabs.query({ url: CLAUDE_TABS });
    if (tab) return;
  } catch { /* open one */ }
  chrome.tabs.create({ url: CHAT_URL, active: false });
}

// The request is the first async call in the click, as the permissions API
// requires; `pageBarRequested` goes out in the same tick, so the worker can
// still turn the bar on if this tab is closed while the prompt is up.
barBtn.addEventListener('click', () => {
  chrome.storage.local.set({ pageBarRequested: Date.now() });
  chrome.permissions.request(PAGE_BAR_PERMS, (granted) => {
    if (chrome.runtime.lastError || !granted) {
      renderBar('denied');
      return;
    }
    chrome.storage.local.set({ pageBar: { enabled: true } }, () => {
      renderBar('on');
      openClaudeInBackground();
    });
  });
});

// ── (c) Pin to the toolbar ───────────────────────────────────────────────────
// Chrome reports it; Firefox has no such API, and the step is left out there.

const pinStep   = $('stepPin');
const pinStatus = $('pinStatus');
const canCheckPin = typeof chrome.action?.getUserSettings === 'function';
// The menu lists the extension under its store name, which differs per
// language, so the steps point at the icon. Edge pins with an eye, Firefox
// from a gear.
const PIN_HOW = navigator.userAgent.includes('Firefox') ? 'wcPinHowFirefox'
  : navigator.userAgent.includes('Edg/') ? 'wcPinHowEdge' : 'wcPinHow';

async function renderPin() {
  if (!canCheckPin) return;
  let pinned = false;
  try { pinned = (await chrome.action.getUserSettings())?.isOnToolbar === true; } catch { return; }
  pinStep.hidden = false;
  setStep(pinStep, pinned ? 'done' : 'todo');
  setStatus(pinStatus, pinned ? 'wcPinOk' : PIN_HOW);
}

// Pinning happens in the browser's own UI, which fires no event here: check
// again whenever the tab comes back, and every 2 s while it is in view.
window.addEventListener('focus', renderPin);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderPin();
});
if (canCheckPin) {
  setInterval(() => { if (document.visibilityState === 'visible') renderPin(); }, PIN_CHECK_MS);
}

// ── (d) Alerts ───────────────────────────────────────────────────────────────

const alertsStep   = $('stepAlerts');
const alertsText   = $('alertsText');
const alertsBtn    = $('alertsBtn');
const alertsStatus = $('alertsStatus');

async function renderAlerts(notifSettings) {
  alertsText.textContent = msg('alertsNudgeText', Number(notifSettings?.warnAt) || 80, Number(notifSettings?.critAt) || 95);
  const on = notifSettings?.enabled !== false && await permissionGranted(NOTIF_PERMS);
  setStep(alertsStep, on ? 'done' : 'todo');
  alertsBtn.hidden = on;
  alertsStatus.hidden = !on;
}

// Alerts default to on and only lack the permission; the grant arms them. A
// stored "off" (from Settings) is lifted too: this click asked for alerts.
alertsBtn.addEventListener('click', () => {
  chrome.permissions.request(NOTIF_PERMS, (granted) => {
    if (chrome.runtime.lastError || !granted) return;
    chrome.storage.local.get('notifSettings', ({ notifSettings }) => {
      if (notifSettings?.enabled === false) {
        chrome.storage.local.set({ notifSettings: { ...notifSettings, enabled: true } });
      } else {
        renderAlerts(notifSettings);
      }
    });
  });
});

// ── Live state ───────────────────────────────────────────────────────────────

const WATCHED = ['claudeUsage', 'claudePlan', 'authBackoff', 'lastRefresh', 'pageBar', 'notifSettings'];

async function renderAll() {
  const stored = await chrome.storage.local.get(WATCHED);
  renderSign(stored);
  freeNote.hidden = stored.claudePlan?.label !== 'Free';
  renderBarFromStorage();
  renderAlerts(stored.notifSettings);
  renderPin();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && WATCHED.some(key => key in changes)) renderAll();
});
chrome.permissions.onAdded?.addListener(renderAll);
chrome.permissions.onRemoved?.addListener(renderAll);

// With the bar on, Done goes to claude.ai to see it, then closes this tab.
$('doneBtn').addEventListener('click', async () => {
  const { pageBar } = await chrome.storage.local.get('pageBar');
  if (pageBar?.enabled && await permissionGranted(PAGE_BAR_PERMS)) await focusClaude();
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
    else window.close();
  });
});

renderAll();
// The worker reads on install too; 'auto' lets it skip this one if a forced
// read just ran.
refresh('auto');
