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

  function hasSectionMarkers(text) {
    const normalized = normalizeText(text);
    return {
      session: SESSION_PATTERNS.some((pattern) => pattern.test(normalized)),
      weekly: WEEKLY_PATTERNS.some((pattern) => pattern.test(normalized)),
    };
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

  function isValidPercentage(value) {
    return Number.isFinite(value) && value >= 0 && value <= 100;
  }

  function collectLines(text) {
    return (text || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  }

  function findSectionContainer(section) {
    const candidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,span,p,div'))
      .filter((el) => {
        const text = el.innerText?.trim() || '';
        return text.length > 0 && text.length < 80 && detectSection(text) === section;
      });

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of candidates) {
      let node = candidate;
      for (let depth = 0; depth < 6 && node; depth += 1) {
        const text = node.innerText?.trim() || '';
        const lines = collectLines(text);
        const pctCount = lines.filter((line) => extractPct(line) !== null).length;
        const hasReset = lines.some((line) => RESET_PATTERNS.test(normalizeText(line)));

        if (pctCount > 0) {
          const score = lines.length + depth * 10 + (hasReset ? 0 : 20);
          if (score < bestScore) {
            best = node;
            bestScore = score;
          }
        }

        node = node.parentElement;
      }
    }

    return best;
  }

  function parseSectionFromContainer(section) {
    const container = findSectionContainer(section);
    if (!container) return null;

    const lines = collectLines(container.innerText || container.textContent || '');
    const percentageIdx = lines.findIndex((line) => extractPct(line) !== null);
    const percentageLine = percentageIdx >= 0 ? lines[percentageIdx] : null;

    // Find the closest reset line to the percentage (after it, to match UI order)
    // This prevents picking up reset time from a different section
    let resetLine = null;
    if (percentageIdx >= 0) {
      resetLine =
        lines.slice(percentageIdx + 1).find((line) => RESET_PATTERNS.test(normalizeText(line))) ||
        lines.slice(0, percentageIdx).find((line) => RESET_PATTERNS.test(normalizeText(line))) ||
        null;
    }

    const labelLine = lines.find((line) => detectSection(line) === section) || null;

    return {
      percentage: extractPct(percentageLine),
      resetTime: resetLine ? parseResetTime(resetLine) : null,
      label: labelLine,
      resetLabel: resetLine,
    };
  }

  // ── Main parsing ─────────────────────────────────────────────────────

  function parseUsage() {
    const result = {
      session: { percentage: null, resetTime: null, label: null },
      weekly:  { percentage: null, resetTime: null, label: null },
      meta: {
        ready: false,
        confidence: 'low',
        sessionSource: null,
        weeklySource: null,
        foundSessionMarker: false,
        foundWeeklyMarker: false,
        textPercentageCount: 0,
      },
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
    const markers = hasSectionMarkers(bodyText);
    result.meta.foundSessionMarker = markers.session;
    result.meta.foundWeeklyMarker = markers.weekly;
    const sessionContainerData = parseSectionFromContainer('session');
    const weekl