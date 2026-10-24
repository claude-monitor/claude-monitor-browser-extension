/* ─── Claude Usage Monitor: page-world limit reader ──────────────────────────
 * Runs in claude.ai's own JavaScript world, and only after the user turns on
 * the on-page bar. When a reply finishes, claude.ai streams the 5-hour and
 * 7-day limit windows with it; on the Free plan that is the ONLY place the
 * limits exist (/usage answers with every field null there). Two transports
 * carry them:
 *   - classic chat: a `message_limit` server-sent event on .../completion;
 *   - unified interface (2026-10): binary Connect frames on
 *     /claudeai-rpc/...ConversationService/StreamTimeline.
 *
 * Privacy boundary: this file extracts only the limit fields (utilization and
 * reset time of the 5-hour and 7-day windows) and never turns any other byte
 * into text. Event-stream lines are matched on their raw bytes and only the
 * limit event's line is decoded; StreamTimeline frames are matched on the
 * bytes of the "5h"/"7d" labels and walked as numbers and lengths. Compressed
 * frames (the reply) are skipped unread; only their 5-byte header is read. A
 * PerformAction request (a send, but also opening a chat) is noticed by its
 * URL alone; no request body is ever read. It stores nothing and sends nothing else: the figures go to the
 * extension's own bar script on this page (window.postMessage, same origin).
 * Reading stops at 8 MB per response. The one body parsed whole is the small
 * JSON error a send refused at the limit gets instead of a stream (no
 * conversation content).
 *
 * Event shapes (not documented APIs):
 *   message_limit.windows = { "5h": {status, resets_at, utilization}, "7d": {...}, ... }
 *     (observed 2026-08) utilization is a 0-1 fraction, resets_at is unix
 *     seconds, and a window that has run out reports status "exceeded_limit"
 *     while utilization can stay < 1.
 *   StreamTimeline (observed 2026-10-14, an alpha API): one protobuf message
 *     per window, holding the label "5h"/"7d", the reset as unix seconds and
 *     the utilization as a double. Field numbers are not relied on, only the
 *     labels and the wire types: an alpha API can renumber at any time.
 *
 * One block comment on purpose: addons-linter reads a file that opens with a
 * long run of // lines as minified code, which holds back AMO auto-approval.
 */

(() => {
  if (window.__claudeUsageMonitorStream) return;
  window.__claudeUsageMonitorStream = true;

  const COMPLETION_PATH = /^\/api\/organizations\/([^/]+)\/chat_conversations\/[^/]+\/(?:retry_)?completion$/;
  const TIMELINE_PATH = /^\/claudeai-rpc\/[\w.]*ConversationService\/StreamTimeline$/;
  // Sending a message in the unified interface, and also opening or starting a
  // chat (observed 2026-10-24). Only the URL is looked at.
  const ACTION_PATH = /^\/claudeai-rpc\/[\w.]*ConversationService\/PerformAction$/;
  // The event arrives near the end of the stream, after the reply. A long reply
  // is still far below this; past it we stop reading rather than buffer forever.
  const MAX_BYTES = 8 * 1024 * 1024;

  // Chain onto whatever fetch is installed now, so other extensions that also
  // wrap it keep working.
  const previousFetch = window.fetch;

  window.fetch = function (input, init) {
    const pending = previousFetch.apply(this, arguments);
    const kind = classify(input);
    if (!kind) return pending;
    if (kind.type === 'action') {
      // A reply counts as a message only after a send from this page.
      sentAt = Date.now();
      sawReply = false;
      return pending;
    }
    return pending.then((response) => {
      // Read a clone in the background; the page gets the original untouched
      // and never waits on us. Only a body we will read is cloned: an unread
      // clone would hold a copy of the whole response.
      try {
        const scan = scannerFor(kind, response.headers.get('content-type') || '');
        if (scan) scan(response.clone()).catch(() => {});
      } catch { /* clone failed: skip */ }
      return response;
    });
  };

  function classify(input) {
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin) return null;
      const completion = COMPLETION_PATH.exec(url.pathname);
      if (completion) return { type: 'completion', orgId: completion[1] };
      if (TIMELINE_PATH.test(url.pathname)) return { type: 'timeline' };
      if (ACTION_PATH.test(url.pathname)) return { type: 'action' };
    } catch { /* unparsable URL: not ours */ }
    return null;
  }

  function scannerFor(kind, type) {
    if (kind.type === 'timeline') {
      return type.includes('application/connect+proto') ? (response) => scanTimeline(response.body) : null;
    }
    if (type.includes('text/event-stream')) return (response) => scanEventStream(response.body, kind.orgId);
    // A send refused at the limit answers with JSON instead of a stream, and
    // still carries the same payload a level or two down.
    if (type.includes('application/json')) {
      return async (response) => {
        const found = findMessageLimit(await response.json(), 0);
        if (found) reportMessageLimit(found, kind.orgId);
      };
    }
    return null;
  }

  function post(limits, orgId, eventKey, reply) {
    if (!limits.session && !limits.weekly) return;
    window.postMessage({ source: 'claude-usage-monitor', type: 'stream-limits', limits, orgId, eventKey, reply }, location.origin);
  }

  // ── Classic chat: server-sent events ──────────────────────────────────────
  const DATA_PREFIX = ascii('data:');
  const EVENT_MARK = ascii('"message_limit"');
  // The limit event is a line of a few hundred bytes; a longer line is skipped
  // without being kept.
  const MAX_LINE = 64 * 1024;

  async function scanEventStream(body, orgId) {
    if (!body) return;
    const reader = body.getReader();
    let carry = null;      // start of a line the previous chunk cut off
    let skipping = false;  // inside a line too long to be the event
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      let start = 0;
      for (let nl = value.indexOf(0x0A); nl !== -1; nl = value.indexOf(0x0A, start)) {
        if (!skipping) checkLine(carry ? concat(carry, value.subarray(start, nl)) : value.subarray(start, nl), orgId);
        carry = null;
        skipping = false;
        start = nl + 1;
      }
      if (!skipping && start < value.length) {
        carry = carry ? concat(carry, value.subarray(start)) : value.slice(start);
        if (carry.length > MAX_LINE) { carry = null; skipping = true; }
      }
      if (bytes > MAX_BYTES) { reader.cancel().catch(() => {}); return; }
    }
  }

  // Only a `data:` line carrying the event name is decoded; every other line is
  // dropped as bytes.
  function checkLine(line, orgId) {
    if (!startsWith(line, DATA_PREFIX) || indexOfBytes(line, EVENT_MARK) === -1) return;
    try {
      const event = JSON.parse(new TextDecoder().decode(line.subarray(DATA_PREFIX.length)));
      if (event && event.type === 'message_limit') reportMessageLimit(event.message_limit, orgId);
    } catch { /* malformed record: ignore */ }
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
      utilization,
    };
  }

  // Every completion is a sent message, so `reply` is always true here; the org
  // comes from the request path and lets the background drop another org's.
  function reportMessageLimit(messageLimit, orgId) {
    const windows = messageLimit && messageLimit.windows;
    if (!windows) return;
    post({ session: toWindow(windows['5h']), weekly: toWindow(windows['7d']) }, orgId || null, null, true);
  }

  // ── Unified interface: StreamTimeline (Connect + protobuf) ─────────────────
  // Connect streaming frames: 1 flag byte, a 4-byte big-endian length, then the
  // payload. Flag 0x01 is gzip, 0x02 is the end-of-stream JSON (never read).
  // Reply content comes in gzip frames and the limits in a plain one (~120
  // bytes), so a compressed frame is skipped without being decompressed: its
  // header only says that a reply went by.
  const FRAME_HEADER = 5;
  const MAX_FRAME = 4 * 1024 * 1024;
  const MAX_DEPTH = 8;
  const RESET_AHEAD_S = 8 * 24 * 60 * 60;
  const RECENT_KEYS = 32;
  // A send whose limits never came (stopped, failed) stops counting after this.
  const REPLY_WINDOW_MS = 10 * 60 * 1000;

  // A limits event counts as a message (`reply`) only when an action from this
  // page came first and reply frames followed it: reopened streams replay the
  // timeline, reply frames and limits included, with nothing sent. Opening a
  // chat is an action too and its snapshot comes in gzip frames, but its
  // stream carries no limits event (observed 2026-10-24), so it never counts.
  // Page-wide on purpose: the stream reopens often, and the limits can arrive
  // on a different stream than the reply did.
  let sentAt = 0;
  let sawReply = false;
  // Events already reported from this page; a reopened stream replays them.
  // The frame holds the event's id, so two events with the same figures still
  // get different keys.
  const recentKeys = [];

  async function scanTimeline(body) {
    if (!body) return;
    const reader = body.getReader();
    const queue = byteQueue();
    let frame = null;  // header of the frame being collected
    let skip = 0;      // bytes left of a frame that is dropped unread
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { reader.cancel().catch(() => {}); return; }
      queue.push(value);
      for (;;) {
        if (skip) {
          skip -= queue.drop(skip);
          if (skip) break;
        }
        if (!frame) {
          if (queue.size < FRAME_HEADER) break;
          const head = queue.take(FRAME_HEADER);
          const flags = head[0];
          const length = head[1] * 0x1000000 + (head[2] << 16) + (head[3] << 8) + head[4];
          if (length > MAX_FRAME) { reader.cancel().catch(() => {}); return; }
          if (flags & 0x02) { skip = length; continue; }
          if (flags & 0x01) {
            sawReply = true;
            skip = length;
            continue;
          }
          if (flags !== 0x00) { skip = length; continue; }
          frame = { length };
        }
        if (queue.size < frame.length) break;
        const payload = queue.take(frame.length);
        frame = null;
        readFrame(payload);
      }
    }
  }

  function readFrame(payload) {
    // Quick test on raw bytes: a length-2 field holding "5h" or "7d".
    if (!payload || !(hasLabel(payload, 0x35, 0x68) || hasLabel(payload, 0x37, 0x64))) return;
    const found = {};
    findWindows(payload, 0, payload.length, 0, found);
    const rated = (w) => Boolean(w && w.utilization !== null);
    if (!rated(found.session) && !rated(found.weekly)) return;
    const limits = { session: toLimit(found.session), weekly: toLimit(found.weekly) };
    const eventKey = fnv1a(payload);
    if (recentKeys.includes(eventKey)) { sawReply = false; return; }
    recentKeys.push(eventKey);
    if (recentKeys.length > RECENT_KEYS) recentKeys.shift();
    const reply = sawReply && sentAt > 0 && Date.now() - sentAt < REPLY_WINDOW_MS;
    sawReply = false;
    if (reply) sentAt = 0;
    post(limits, null, eventKey, reply);
  }

  // proto3 leaves a 0.0 double out of the frame: a window with its reset but
  // no utilization is at 0% when the other window in the frame was read whole
  // (readFrame checks that), e.g. a weekly window that has just reset.
  function toLimit(win) {
    if (!win) return null;
    const utilization = win.utilization ?? 0;
    return {
      percentage: utilization >= 1 ? 100 : Math.round(utilization * 100),
      resetTime: win.resetsAt * 1000,
      utilization,
    };
  }

  // A window is a message that directly holds a 2-byte field "5h" or "7d".
  function findWindows(bytes, start, end, depth, found) {
    const list = fields(bytes, start, end);
    if (!list) return;
    const label = list.find((f) => f.wire === 2 && f.end - f.start === 2 && labelAt(bytes, f.start));
    if (label) {
      const key = labelAt(bytes, label.start);
      if (!found[key]) found[key] = windowFrom(bytes, list.filter((f) => f !== label), depth);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const f of list) {
      if (f.wire === 2 && f.end > f.start) findWindows(bytes, f.start, f.end, depth + 1, found);
    }
  }

  function labelAt(bytes, i) {
    if (bytes[i] === 0x35 && bytes[i + 1] === 0x68) return 'session';
    if (bytes[i] === 0x37 && bytes[i + 1] === 0x64) return 'weekly';
    return null;
  }

  // Inside the window (outside its label): the utilization is the first double
  // in 0..1.5, the reset the first integer that reads as a unix time from an
  // hour ago to 8 days ahead. Without a reset there is no window; a missing
  // utilization stays null here (see toLimit).
  function windowFrom(bytes, list, depth) {
    const nowS = Date.now() / 1000;
    const hit = { utilization: null, resetsAt: null };
    collect(bytes, list, depth, hit, nowS);
    return hit.resetsAt === null ? null : hit;
  }

  function collect(bytes, list, depth, hit, nowS) {
    for (const f of list) {
      if (hit.utilization !== null && hit.resetsAt !== null) return;
      if (f.wire === 1 && hit.utilization === null) {
        const value = new DataView(bytes.buffer, bytes.byteOffset + f.start, 8).getFloat64(0, true);
        if (Number.isFinite(value) && value >= 0 && value <= 1.5) hit.utilization = value;
      } else if (f.wire === 0 && hit.resetsAt === null) {
        if (f.value > nowS - 3600 && f.value < nowS + RESET_AHEAD_S) hit.resetsAt = f.value;
      } else if (f.wire === 2 && depth < MAX_DEPTH) {
        const sub = fields(bytes, f.start, f.end);
        if (sub) collect(bytes, sub, depth + 1, hit, nowS);
      }
    }
  }

  // Schema-free protobuf: splits bytes[start, end) into fields, or returns null
  // when they don't parse cleanly as a message (they are then opaque bytes).
  // Field values are kept as offsets; nothing is decoded here.
  function fields(bytes, start, end) {
    const list = [];
    let pos = start;
    while (pos < end) {
      const tag = varint(bytes, pos, end);
      if (!tag || tag.value < 8) return null;
      pos = tag.next;
      const wire = tag.value % 8;
      if (wire === 0) {
        const v = varint(bytes, pos, end);
        if (!v) return null;
        list.push({ wire, value: v.value });
        pos = v.next;
      } else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (pos + size > end) return null;
        list.push({ wire, start: pos, end: pos + size });
        pos += size;
      } else if (wire === 2) {
        const len = varint(bytes, pos, end);
        if (!len || len.next + len.value > end) return null;
        list.push({ wire, start: len.next, end: len.next + len.value });
        pos = len.next + len.value;
      } else {
        return null;
      }
    }
    return list;
  }

  function varint(bytes, pos, end) {
    let value = 0;
    for (let i = 0, scale = 1; i < 10 && pos < end; i++, scale *= 128) {
      const b = bytes[pos++];
      value += (b & 0x7f) * scale;
      if (b < 0x80) return { value, next: pos };
    }
    return null;
  }

  // Chunks of a response, consumed a frame at a time without joining them all.
  function byteQueue() {
    const chunks = [];
    let size = 0;
    return {
      get size() { return size; },
      push(chunk) {
        if (!chunk.byteLength) return;
        chunks.push(chunk);
        size += chunk.byteLength;
      },
      // Removes up to n bytes and returns how many it removed.
      drop(n) {
        const count = Math.min(n, size);
        let left = count;
        while (left) {
          const head = chunks[0];
          if (head.byteLength <= left) { chunks.shift(); left -= head.byteLength; }
          else { chunks[0] = head.subarray(left); left = 0; }
        }
        size -= count;
        return count;
      },
      // Removes exactly n bytes (n <= size) and returns them in one array.
      take(n) {
        const out = new Uint8Array(n);
        let offset = 0;
        while (offset < n) {
          const head = chunks[0];
          const k = Math.min(head.byteLength, n - offset);
          out.set(head.subarray(0, k), offset);
          offset += k;
          if (k === head.byteLength) chunks.shift();
          else chunks[0] = head.subarray(k);
        }
        size -= n;
        return out;
      },
    };
  }

  // ── Byte helpers ───────────────────────────────────────────────────────────
  function ascii(text) {
    return Uint8Array.from(text, (c) => c.charCodeAt(0));
  }

  function concat(a, b) {
    const out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(a);
    out.set(b, a.byteLength);
    return out;
  }

  function startsWith(bytes, prefix) {
    if (bytes.byteLength < prefix.byteLength) return false;
    for (let i = 0; i < prefix.byteLength; i++) if (bytes[i] !== prefix[i]) return false;
    return true;
  }

  function indexOfBytes(bytes, needle) {
    for (let i = bytes.indexOf(needle[0]); i !== -1 && i + needle.byteLength <= bytes.byteLength; i = bytes.indexOf(needle[0], i + 1)) {
      let j = 1;
      while (j < needle.byteLength && bytes[i + j] === needle[j]) j++;
      if (j === needle.byteLength) return i;
    }
    return -1;
  }

  function hasLabel(bytes, a, b) {
    for (let i = bytes.indexOf(0x02); i !== -1 && i + 2 < bytes.byteLength; i = bytes.indexOf(0x02, i + 1)) {
      if (bytes[i + 1] === a && bytes[i + 2] === b) return true;
    }
    return false;
  }

  // FNV-1a, 32 bits: a short key that tells events apart, never sent anywhere
  // beyond the extension.
  function fnv1a(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.byteLength; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
})();
