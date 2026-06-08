# TODO

## Track "Daily included routine runs"

claude.ai's usage UI now shows a **Daily included routine runs** bucket
(observed: `15 / 15`, daily reset ~24h). Add it as a tracked card.

What makes it different from the existing cards:

- **Count-based**, not utilization %. The UI shows `used / limit` (e.g. `15/15`),
  closer to the `extra_usage` (credits) shape than to the percentage buckets.
  Bar fill would need to be derived as `used / limit`.
- **Daily reset** (~24h), unlike the 5h session and 7d weekly/sub-caps.

Work needed:

- [ ] **Verify the API field name.** Inspect the live response of
  `GET /api/organizations/{orgId}/usage` — the routine bucket key is unknown
  (likely a `daily_*` key, sibling to `five_hour` / `seven_day*`). Confirm
  whether it exposes a count (`used`/`limit`) and/or a `utilization` + `resets_at`.
- [ ] `claudetrack/background.js` — map the bucket in `mapApiUsageToStoredShape`
  and sanitize it in `sanitizeUsageData` (store `used`/`limit` + `resetTime`).
- [ ] `claudetrack/popup.html` + `popup.css` — add the routine card markup/style.
- [ ] `claudetrack/popup.js` — render it. Count format (`X / Y`) with a derived
  bar; decide if it joins the optional-cards menu (`SUBCARDS`) or is always shown.
- [ ] Bump version (`manifest.json` + `manifest.firefox.json` + doc references)
  and update README / store listings.

Open question: is the routine cap shared across plans, or only on specific tiers?
(Affects whether the card should auto-hide when the bucket is absent, like the
weekly sub-caps do.)
