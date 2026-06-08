# TODO

## Track "Daily included routine runs"

claude.ai's usage UI now shows a **Daily included routine runs** bucket
(observed: `15 / 15`, daily reset ~24h). Add it as a tracked card.

What makes it different from the existing cards:

- **Count-based**, not utilization %. The UI shows `used / limit` (e.g. `0/15`),
  closer to the `extra_usage` (credits) shape than to the percentage buckets.
  Bar fill must be derived as `used / limit`.
- **Daily reset** (~24h), unlike the 5h session and 7d weekly/sub-caps.
- **Separate endpoint** — it is NOT in `/api/organizations/{orgId}/usage`. It
  lives behind the Claude Code gateway (see below), so it needs its own fetch +
  host permission, not just a new field in `mapApiUsageToStoredShape`.

### API (verified live on a Max 5x org)

```
GET https://claude.ai/v1/code/routines/run-budget
```

Required headers (cookie auth via `credentials: 'include'`, plus):

- `anthropic-beta: ccr-triggers-2026-01-30`  ← gates the route; without it → 404
- `anthropic-version: 2023-06-01`            ← without it → 400 "header is required"
- `x-organization-uuid: {orgId}`             ← org scope (reuse `getClaudeOrgId`)

(The `anthropic-client-*` / `x-activity-session-id` telemetry headers the SPA
sends are NOT required.)

Response (200):

```json
{ "used": "0", "limit": "15", "unified_billing_enabled": true }
```

- `used` and `limit` are **strings** → parse with `Number()`.
- **No `resets_at`** is returned — daily reset is implicit. The card can't show a
  precise countdown from this payload; label it "Resets daily" (or omit reset).
- `anthropic-beta` is a **dated** value and will likely change as the feature
  graduates — fetch must fail soft (hide the card on 4xx).

Work needed:

- [x] **Verify the API.** Done — endpoint, headers and shape confirmed above.
- [ ] `claudetrack/background.js` — add a separate `fetchRoutineBudget()` (own
  headers, after `getClaudeOrgId`); store `{ used, limit }` on the usage object.
  Fail soft on 4xx (omit the bucket) so non-routine plans just don't show it.
- [ ] `claudetrack/popup.html` + `popup.css` — add the routine card markup/style.
- [ ] `claudetrack/popup.js` — render it. Count format (`X / Y`) with a derived
  bar; decide if it joins the optional-cards menu (`SUBCARDS`) or is always shown.
- [ ] `manifest.json` + `manifest.firefox.json` — add host permission
  `https://claude.ai/v1/code/routines/run-budget`.
- [ ] Bump version (all manifests + doc references) and update README / store
  listings.

Open question (resolved): the bucket is gated by the `ccr-triggers` beta + the
org's `unified_billing_enabled`. On orgs without it the endpoint will likely 4xx,
so the card should auto-hide on fetch failure (same pattern as the weekly
sub-caps).

## Update landing page for v1.4.6 + custom domain — ✅ done 2026-06-08 (shipped at v1.4.7)

The website lives in a separate repo (<https://github.com/msadofschi/claude-usage-monitor-landing>,
served via Cloudflare). After v1.4.6 ships it needs to reflect the new feature
set and move to the custom domain.

- [x] **New features copy** — document the subscription **plan badge**
  (Max 5x, Pro, Team…) and the **per-model weekly sub-caps** (Opus / Sonnet /
  Design) with the **Models** show/hide menu (Select all / Deselect all), plus
  plan-gated sub-caps (only on paid plans).
- [x] **Refresh screenshots** to show the plan badge, sub-caps row and the
  Models menu.
- [x] **Custom domain** — point the Cloudflare site at the new domain and update the
  privacy-policy URL path. (Shipped as extension v1.4.7 → claude-monitor.com.)
- [x] Bump any version references on the page to 1.4.7 (label + JSON-LD
  `softwareVersion`). Note: `ext-screenshot.png` still has "v1.4.6" baked in —
  re-shoot only if you want the image to read 1.4.7 (no UI change since 1.4.6).

## Polish UI with the Impeccable design skill

Use the **Impeccable** design skill (<https://impeccable.style/>) to refine the
popup UI and the store/landing visuals, removing the generic "AI slop" look and
tightening hierarchy, contrast and spacing.

- [ ] Install for Claude Code: `/plugin marketplace add pbakaus/impeccable`
  (or `npx impeccable skills install`).
- [ ] Run its commands (e.g. `/typeset`, `/colorize`) over `claudetrack/popup.html`
  + `popup.css` — it edits real code, so review diffs and keep the existing
  design system rather than letting it overwrite.
- [ ] Re-run the store screenshots (`screenshot_helper/`, `screenshots/`) after
  the polish so the listing reflects the refined look.
- [ ] Optionally run its 41-rule anti-pattern detector as a PR check.
