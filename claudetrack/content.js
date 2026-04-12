// ─── ClaudeTrack — Content Script ──────────────────────────────────────────
// Injected into https://claude.ai/settings/usage
// Parses the page DOM for usage percentages and reset times, then sends the
// structured data to the background service worker.
//
// Strategy: Claude's UI is React-rendered with dynamic class names, so we
// rely on semantic parsing (text, ARIA attributes, data attributes) rather
// than CSS class selectors — making the script resilient to UI updates.

(function () {
  'use strict';

  const SESSION_PATTERNS = [
    /\bcurrent session\b/,
    /\bsession\b/,
    /\bsesion actual\b/,
    /\bsesion\b/,
    /\bmensajes\b/,
    /\bmessages\b/,
    /\buso actual\b/,
  ];

  const WEEKLY_PATTERNS = [
    /\bweekly\b/,
    /\bweek\b/,
    /\bweekly limits?\b/,
    /\blimites? semanales?\b/,
    /\bsemanal(?:es)?\b/,
    /\btodos los modelos\b/,
    /\ball models\b/,
  ];

  const RESET_PATTERNS = /\b(reset|resets|renew|renews|refresh|refreshes|restablece|restablecen|reinicia|reinician)\b/;

  // ── Helpers ───────────────────────────────────────────────────────────

  function normalizeText(text) {
    return (text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectSection(text) {
    const normalized = normalizeText(text);
    if (!normalized) return null;
    if (SESSION_PATTERNS.some((pattern) => pattern.test(normalized))) return 'session';
    if (WEEKLY_PATTERNS.some((pattern) => pattern.test(normalized))) return 'weekly';
    return null;
  }

  /**
   * Pull numeric progress value from an element.
   * Tries: aria-valuenow → value attribute → style.width → inner text.
   */
  function progressValue(el) {
    if (!el) return null;
    const now = el.getAttribute('aria-valuenow');
    if (now !== null) return parseFloat(now);
    const val = el.getAttribute('value');
    if (val !== null) return parseFloat(val);
    // <div style="width: 42%">
    const w = el.style?.width;
    if (w && w.includes('%')) return parseFloat(w);
    return null;
  }

  /**
   * Walk up the DOM from `el` collecting all text nodes within `limit` levels.
   */
  function nearbyText(el, limit = 4) {
    let node = el;
    for (let i = 0; i < limit; i++) {
      if (!node?.parentElement) break;
      node = node.parentElement;
    }
    return node?.innerText || node?.textContent || '';
  }

  /**
   * Parse a relative human time like "in 2 hours 30 minutes", "in 3 days",
   * "tomorrow at 8 AM", "in 1 hour", into a UTC epoch millisecond value.
   * Returns null if parsing fails.
   */
  function parseResetTime(text) {
    if (!text) return null;
    const t = normalizeText(text);
    const now = Date.now();

    // "in X days"
    const days = t.match(/in\s+(\d+)\s+days?/);
    if (days) return now + parseInt(days[1]) * 86400000;

    // "in X hours (Y minutes)"
    const hours = t.match(/in\s+(\d+)\s+hours?/);
    const mins  = t.match(/(\d+)\s+minutes?/);
    if (hours) {
      return now + parseInt(hours[1]) * 3600000 + (mins ? parseInt(mins[1]) * 60000 : 0);
    }
    if (mins && !hours) {
      return now + parseInt(mins[1]) * 60000;
    }

    const esDays = t.match(/en\s+(\d+)\s*d(?:ias?)?\b/);
    if (esDays) return now + parseInt(esDays[1]) * 86400000;

    const esHours = t.match(/en\s+(\d+)\s*h(?:oras?)?\b/);
    const esMins = t.match(/(\d+)\s*m(?:in(?:utos?)?)?\b/);
    if (esHours) {
      return now + parseInt(esHours[1]) * 3600000 + (esMins ? parseInt(esMins[1]) * 60000 : 0);
    }
    if (esMins && !esHours) {
      return now + parseInt(esMins[1]) * 60000;
    }

    // "tomorrow" or day-of-week — rough estimate
    if (t.includes('tomorrow')) return now + 86400000;
    if (t.includes('manana')) return now + 86400000;
    const dow = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    for (let i = 0; i < dow.length; i++) {
      if (t.includes(dow[i])) {
        const today = new Date().getDay();
        let diff = i - today;
        if (diff <= 0) diff += 7;
        return now + diff * 86400000;
      }
    }

    const dowEs = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    for (let i = 0; i < dowEs.length; i++) {
      if (t.includes(dowEs[i])) {
        const today = new Date().getDay();
        let diff = i - today;
        if (diff <= 0) diff += 7;
        return now + diff * 86400000;
      }
    }

    return null;
  }

  /**
   * Extract a percentage number from a text string.
   * e.g. "42% used" → 42
   */
  function extractPct(text) {
    if (!text) return null;
    const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  }

  // ── Main parsing ─────────────────────────────────────────────────────

  function parseUsage() {
    const result = {
      session: { percentage: null, resetTime: null, label: null },
      weekly:  { percentage: null, resetTime: null, label: null },
    };

    // ── 1. Find progress bar / meter elements ───────────────────────────
    const bars = Array.from(
      document.querySelectorAll('[role="progressbar"], meter, progress')
    );

    // Also look for divs that are styled as progress fill bars
    // (common pattern: a wrapper div with a child whose width is set to a %)
    const styleDivs = Array.from(document.querySelectorAll('div')).filter(d => {
      const w = d.style?.width;
      return w && w.endsWith('%') && parseFloat(w) > 0;
    });

    const allBars = [...bars, ...styleDivs];

    // ── 2. Extract values from bars ────────────────────────────────────
    const barData = allBars.map(el => {
      let pct = progressValue(el);
      if (pct === null) {
        // try parsing width percentage
        const w = el.style?.width;
        if (w && w.includes('%')) pct = parseFloat(w);
      }
      const context = nearbyText(el, 5);
      return { pct, context, el };
    }).filter(d => d.pct !== null && d.pct >= 0 && d.pct <= 100);

    // ── 3. Scan full page text for percentage mentions ─────────────────
    // This is the fallback / cross-check when bars aren't found
    const bodyText = document.body?.innerText || '';
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    // Cluster lines: session usage vs weekly usage
    // Key words to look for:
    //   session → "messages", "session", "daily", "today"
    //   weekly  → "weekly", "week", "7 day"
    //   reset   → "resets", "reset", "renews", "refreshes"

    let sessionBlock = '';
    let weeklyBlock  = '';
    let currentBlock = null;
    const textPercentages = [];

    for (const line of lines) {
      const hint = detectSection(line);
      if (hint) currentBlock = hint;

      if (currentBlock === 'session') sessionBlock += ' ' + line;
      if (currentBlock === 'weekly')  weeklyBlock  += ' ' + line;

      const pct = extractPct(line);
      if (pct !== null) {
        textPercentages.push({
          pct,
          line,
          section: hint || currentBlock,
        });
      }
    }

    // ── 4. Assign bar values heuristically ───────────────────────────
    const sessionTextMatch = textPercentages.find(entry => entry.section === 'session');
    const weeklyTextMatch = textPercentages.find(entry => entry.section === 'weekly');

    if (sessionTextMatch) result.session.percentage = sessionTextMatch.pct;
    if (weeklyTextMatch) result.weekly.percentage  = weeklyTextMatch.pct;

    if (result.session.percentage === null || result.weekly.percentage === null) {
      const classifiedBars = barData.map((entry) => ({
        ...entry,
        section: detectSection(entry.context),
      }));

      if (result.session.percentage === null) {
        result.session.percentage =
          classifiedBars.find((entry) => entry.section === 'session')?.pct ?? null;
      }

      if (result.weekly.percentage === null) {
        result.weekly.percentage =
          classifiedBars.find((entry) => entry.section === 'weekly')?.pct ?? null;
      }

      if ((result.session.percentage === null || result.weekly.percentage === null) && classifiedBars.length >= 2) {
        if (result.session.percentage === null) result.session.percentage = classifiedBars[0].pct;
        if (result.weekly.percentage === null) result.weekly.percentage = classifiedBars[1].pct;
      } else if (result.session.percentage === null && classifiedBars.length === 1) {
        result.session.percentage = classifiedBars[0].pct;
      }
    }

    // Cross-check: if text-extracted percentages differ significantly, prefer text
    const sessionPctText = extractPct(sessionBlock);
    const weeklyPctText  = extractPct(weeklyBlock);

    if (sessionPctText !== null) result.session.percentage = sessionPctText;
    if (weeklyPctText  !== null) result.weekly.percentage  = weeklyPctText;

    // If we still have nothing, scan all lines for first two percentages
    if (result.session.percentage === null) {
      const allPcts = [];
      for (const entry of textPercentages) {
        allPcts.push(entry.pct);
        if (allPcts.length >= 2) break;
      }
      if (allPcts[0] != null) result.session.percentage = allPcts[0];
      if (allPcts[1] != null) result.weekly.percentage  = allPcts[1];
    }

    // ── 5. Parse reset times ─────────────────────────────────────────
    for (const line of lines) {
      const l = normalizeText(line);
      if (RESET_PATTERNS.test(l)) {
        // Decide which block this belongs to
        if (!result.session.resetTime && (detectSection(line) === 'session' || l.includes('hour') || l.includes('minute') || l.includes('today') || l.includes('daily') || l.includes('hora') || l.includes('min'))) {
          result.session.resetTime = parseResetTime(line);
          result.session.label     = line;
        } else if (!result.weekly.resetTime && (detectSection(line) === 'weekly' || l.includes('week') || l.includes('day') || l.includes('tomorrow') || l.includes('dia') || l.includes('manana'))) {
          result.weekly.resetTime = parseResetTime(line);
          result.weekly.label     = line;
        } else {
          // assign to whichever slot is empty
          if (!result.session.resetTime) {
            result.session.resetTime = parseResetTime(line);
            result.session.label     = line;
          } else if (!result.weekly.resetTime) {
            result.weekly.resetTime = parseResetTime(line);
            result.weekly.label     = line;
          }
        }
      }
    }

    // ── 6. Fallback label extraction ─────────────────────────────────
    // Try to find human-readable usage descriptions from prominent headings/spans
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,p,div'))
      .filter(el => {
        const t = el.innerText?.trim() || '';
        return t.length > 5 && t.length < 120 && detectSection(t);
      });

    for (const el of headings) {
      const t = el.innerText.trim();
      const section = detectSection(t);
      if (!result.session.label && section === 'session') {
        result.session.label = el.innerText.trim();
      }
      if (!result.weekly.label && section === 'weekly') {
        result.weekly.label = el.innerText.trim();
      }
    }

    return result;
  }

  // ── Wait for React to render, then parse ────────────────────────────

  function waitAndParse(attempts = 0) {
    const MAX = 20;
    const INTERVAL = 500;  // ms

    // A "ready" signal: at least one percentage is visible on the page
    const pctVisible = /\d+\s*%/.test(document.body?.innerText || '');

    if (pctVisible || attempts >= MAX) {
      const data = parseUsage();
      // Send to background SW
      chrome.runtime.sendMessage({ type: 'USAGE_DATA', data });
    } else {
      setTimeout(() => waitAndParse(attempts + 1), INTERVAL);
    }
  }

  waitAndParse();
})();
