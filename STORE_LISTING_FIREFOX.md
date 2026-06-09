# Firefox AMO Listing — Claude Usage Monitor

See also: [STORE_LISTING_CHROME.md](STORE_LISTING_CHROME.md) for the Chrome Web Store submission.

## Extension name (max 45 chars)
Claude Usage: Session, Weekly & Design

## Add-on URL slug (max 30 chars)
claude-usage-meter

Listing URL: https://addons.mozilla.org/firefox/addon/claude-usage-meter/

## Summary (max 250 chars)
Track your Claude.ai usage in real time. Session, weekly, and Claude Design limits with reset countdowns and color-coded progress — in your toolbar. No account, no API key, no data leaves your browser.

## Category
Alerts & Updates

## License
MIT License

## Support email
martin.sadofschi@gmail.com

## Support website
https://www.claude-monitor.com/

## Privacy policy URL
https://www.claude-monitor.com/privacy

## Compatibility
- Firefox: Yes
- Firefox for Android: No (popup not designed for mobile)

---

## Long description

Track your Claude.ai usage in real time. See session and weekly limits, reset times, and color-coded progress — in your toolbar.

The only Claude usage tracker that monitors Claude Design and Opus weekly limits alongside your 5-hour session and 7-day weekly limits — plus paid extra credits — all in your browser toolbar.

Stop opening claude.ai/settings/usage. A color-coded badge tells you at a glance whether you can keep working or need to pace yourself, with countdowns to every reset.

No account, no API key, no data leaves your browser. Reads your existing Claude session the same way the official settings page does.

WHAT YOU SEE
- Session usage (5-hour rolling window) with reset countdown
- Weekly usage (all models combined) with reset day/time
- Opus weekly usage (per-model weekly sub-limit, on paid plans)
- Sonnet weekly usage (per-model weekly sub-limit, on paid plans)
- Claude Design usage (most trackers ignore this)
- Show or hide each optional card from the Display options menu (Metrics section, with Select all / Deselect all)
- Six color themes — Clay (default), Slate, Violet, Midnight, Paper, Cool light — switchable in the popup
- Your Claude plan shown as a badge in the header (Max, Pro, Team, etc.)
- Daily included routine runs as a used / limit count (on plans that include Claude Code routines)
- Paid extra credits used vs. monthly cap (when enabled on your plan)
- Inline banner when your claude.ai session expires — last-known data stays visible
- Toolbar badge: green under 50%, yellow 50 to 80%, red above 80%
- Configurable auto-refresh: 1, 2, 5, 10, or 60 minutes

WHO IS THIS FOR
Claude Pro, Max, and Team users who hit limits and want to plan their work. Especially useful for Claude Code users on Max plans and teams using Claude Design.

OPEN SOURCE
- Full source code published on GitHub (MIT license): https://github.com/msadofschi/claudetrack
- Verify exactly what the extension does — every line that runs in your browser is in the public repo, unminified.

PRIVACY
- All data stored locally on your device
- No analytics, no telemetry, no third parties
- Cannot read your chats, projects, files, or any other Claude.ai content
- Permissions are scoped to the absolute minimum: three specific API endpoints (organization list, usage stats, and routine-run budget)
- Specifically excluded: chat_conversations, projects, members, and every other endpoint

PERMISSIONS USED AND WHY
- Storage — persist usage data locally so the badge survives browser restarts
- Alarms — schedule automatic refreshes at the configured interval
- https://claude.ai/api/organizations — list your organizations to identify the active one
- https://claude.ai/api/organizations/*/usage — read usage stats only
- https://claude.ai/v1/code/routines/run-budget — read your daily routine-run count only

HOW IT WORKS
1. Install the extension and pin it to your toolbar
2. Log into claude.ai (you probably already are)
3. The badge starts showing your usage automatically
4. Click the icon any time for the full popup breakdown

Claude Usage Monitor is an independent project and is not affiliated with Anthropic.
Source code: https://github.com/msadofschi/claudetrack
Learn more: https://www.claude-monitor.com/
Full privacy policy: https://www.claude-monitor.com/privacy

---

## Notes to Reviewer

This add-on reads Claude.ai usage statistics from the user's existing logged-in session and displays them in a toolbar badge. It does not require its own account or any external service.

BUILD PROCESS: None. The submitted ZIP contains the complete, unminified source code as it runs in the browser. No transpilation, bundling, minification, or preprocessing of any kind. The files in the ZIP (manifest.json, background.js, popup.js, popup.html, popup.css, icons/) are exactly what gets loaded by Firefox.

TO TEST:
1. Install the add-on and pin it to the toolbar.
2. Log in to https://claude.ai with any Claude account (free or paid).
3. Click the extension icon and press Refresh (the badge also populates automatically after install).
4. The toolbar badge will display the session usage percentage (color-coded: green/yellow/red).
5. Click the icon for the full popup showing session, weekly, and Claude Design usage.

NOTES:
- No test credentials needed. Any Claude.ai account works.
- Brand-new accounts with no usage history will correctly show 0% — send at least one message in Claude to see populated data.
- Data is read via authenticated requests to claude.ai/api/organizations, claude.ai/api/organizations/*/usage, and claude.ai/v1/code/routines/run-budget (the same endpoints the official settings/usage page uses).
- All data is stored locally via browser.storage.local. No data is transmitted to any third-party server.
- Host permissions are scoped to exactly three API endpoints, explicitly excluding chat content, projects, and other user data.

---

## Manifest differences from Chrome

Firefox manifest (`claudetrack/manifest.firefox.json`) differs from Chrome's `manifest.json` in:
- `name` shortened to ≤45 chars (AMO limit)
- `background.service_worker` → `background.scripts` (broader Firefox MV3 compatibility)
- `browser_specific_settings.gecko` block added:
  - `id: claude-usage-monitor@digitaladvanced.solutions` (permanent, do not change after first AMO publish)
  - `strict_min_version: 142.0` (required by `data_collection_permissions`)
  - `data_collection_permissions.required: ["none"]` (declares no remote data transmission)
- `minimum_chrome_version` removed (Chrome-only field)

---

## How to package

```powershell
./build-firefox.ps1
```

Produces `claude-usage-monitor-firefox-v<version>.zip` at repo root using .NET ZipArchive (forward-slash paths required by AMO).

The script:
1. Stages `claudetrack/*` in a temp folder
2. Replaces `manifest.json` with `manifest.firefox.json`
3. Zips with forward-slash entry paths
4. Cleans up

---

## Version notes template

```
Bug fixes and improvements:
- <user-facing change>
- <user-facing change>
- Internal cleanup
```

---

## Submission checklist

- [ ] Bump `version` in both `claudetrack/manifest.json` AND `claudetrack/manifest.firefox.json`
- [ ] Build with `./build-firefox.ps1`
- [ ] Upload ZIP via https://addons.mozilla.org/developers/
- [ ] Distribution: "On this site"
- [ ] Compatibility: Firefox only (no Android until popup is responsive)
- [ ] Pre-validation must pass (errors block; warnings are OK)
- [ ] Paste version notes
- [ ] Paste Notes to Reviewer
- [ ] Submit for review (manual review: 1-10 days typically)
