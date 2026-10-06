// ─── Claude Usage Monitor: page-world limit reader ──────────────────────────
// Runs in claude.ai's own JavaScript world, and only after the user turns on
// the on-page bar. Every chat reply streams a `message_limit` event carrying
// the 5-hour and 7-day windows; on the Free plan that event is the ONLY place
// the limits exist (/usage answers with every field null there).
//
// Privacy boundary: this file reads that one event and nothing else. It never
// touches the prompt, the reply text or the conversation. Lines are tested for
// the event name before anything is parsed, and the rest is dropped unread.
//
// Event shape (not a documented API; observed 2026-08):
//   message_limit.windows = { "5h": {status, resets_at, utilization}, "7d": {...}, ... }
//   utilization is a 0-1 fraction, resets_at is unix seconds, and a window that
//   has run out reports status "exceeded_limit" while utilization can stay < 1.

(() => {
  if (window.__claudeUsageMonitorStream) return;
  window.__claudeUsageMonitorStream = true;

  const COMPLETION_PATH = /^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/(?:retry_)?completion$/;
  const EVENT_MARK = '"message_limit"';
  // The event arrives near the end of the stream, after the reply. A long reply
  // is still far below this; past it we stop reading rather than buffer forever.
  const MAX_BYTES = 8 * 1024 * 1024;

  // Chain onto whatever fetch is installed now, so other extensions that also
  // wrap it keep working.
  const previousFetch = window.fetch;

  window.fetch = function (input, init) {
    const pending = previousFetch.apply(this, arguments);
    if (!isCompletion(input)) return pending;
    return pending.then((response) => {
      // Read a clone in the background; the page gets the original untouched
      // and never waits on us.
      try { inspect(response.clone()).catch(() => {}); } catch { /* clone failed: skip */ }
      return response;
    });
  };

  function isCompletion(input) {
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      const url = new URL(raw, location.href);
      return url.origin === location.origin && COMPLETION_PATH.test(url.pathname);
    } catch {
      return false;
    }
  }

  async function inspect(response) {
    const type = response.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) return scanStream(response.body);
    // A send refused at the limit answers with JSON instead of a stream, and
    // still carries the same payload a level or two down.
    if (type.includes('application/json')) {
      const found = findMessageLimit(await response.json(), 0);
      if (found) report(found);
    }
  }

  async function scanStream(body) {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:') || !line.includes(EVENT_MARK)) continue;
        try {
          const event = JSON.parse(line.slice(5));
          if (event && event.type === 'message_limit') report(event.message_limit);
        } catch { /* malformed record: ignore */ }
      }
      if (bytes > MAX_BYTES) { reader.cancel().catch(() => {}); return; }
    }
  }

  function findMessageLimit(node, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (node.message_limit && typeof node.message_limit === 'object') return node.message_limit;
    if (node.windows && typeof node.windows === 'object') return node;
    for (const key of Object.keys(node)) {
      const found = findMessageLimit(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function toWindow(win) {
    if (!win || typeof win !== 'object') return null;
    const utilization = Number(win.utilization);
    const resetsAt = Number(win.resets_at);
    if (!Number.isFinite(utilization) || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
    return {
      percentage: win.status === 'exceeded_limit' ? 100 : Math.round(utilization * 100),
      resetTime: resetsAt * 1000,
    };
  }

  function report(messageLimit) {
    const windows = messageLimit && messageLimit.windows;
    if (!windows) return;
    const limits = { session: toWindow(windows['5h']), weekly: toWindow(windows['7d']) };
    if (!limits.session && !limits.weekly) return;
    window.postMessage({ source: 'claude-usage-monitor', type: 'stream-limits', limits }, location.origin);
  }
})();
