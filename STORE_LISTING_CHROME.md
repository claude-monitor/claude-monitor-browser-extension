# Chrome Web Store Listing — Claude Usage Monitor

See also: [STORE_LISTING_FIREFOX.md](STORE_LISTING_FIREFOX.md) for the Firefox AMO submission.

## Extension name
Claude Usage Monitor: Session, Weekly & Design

## Short description (max 132 chars)
Track your Claude.ai session, weekly, and Design usage in real time. Reset times and color-coded progress in your toolbar.

## Category
Productivity

## Language
English

## Privacy policy URL
https://claude-monitor.netlify.app/privacy

---

## Long description

Track your Claude.ai usage in real time. See session and weekly limits, reset times, and color-coded progress — in your toolbar.

The only Claude usage tracker that monitors Claude Design and Opus weekly limits alongside your 5-hour session and 7-day weekly limits — plus paid extra credits — all in your browser toolbar.

Stop opening claude.ai/settings/usage. A color-coded badge tells you at a glance whether you can keep working or need to pace yourself, with countdowns to every reset.

No account, no API key, no data leaves your browser. Reads your existing Claude session the same way the official settings page does.

WHAT YOU SEE
- Session usage (5-hour rolling window) with reset countdown
- Weekly usage (all models combined) with reset day/time
- Sonnet weekly usage (when your plan includes a Sonnet sub-cap)
- Opus weekly usage (when your plan includes an Opus sub-cap)
- Claude Design usage (when your plan includes it — most trackers ignore this)
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
- Permissions are scoped to the absolute minimum: only the usage page and two specific API endpoints (organization list and usage stats)
- Specifically excluded: chat_conversations, projects, members, and every other endpoint

PERMISSIONS USED AND WHY
- *Storage* — persist usage data locally so the badge survives browser restarts
- *Alarms* — schedule automatic refreshes at the configured interval
- *https://claude.ai/settings/usage* — read the usage settings page (content script)
- *https://claude.ai/api/organizations* — list your organizations to identify the active one
- *https://claude.ai/api/organizations/\*/usage* — read usage stats only

HOW IT WORKS
1. Install the extension and pin it to your toolbar
2. Log into claude.ai (you probably already are)
3. The badge starts showing your usage automatically
4. Click the icon any time for the full breakdown

Claude Usage Monitor is an independent project and is not affiliated with Anthropic.
Source code: https://github.com/msadofschi/claudetrack
Learn more: https://claude-monitor.netlify.app/
Full privacy policy: https://claude-monitor.netlify.app/privacy

---

## Screenshots needed (take manually)

Minimum: 1 screenshot at **1280×800px** or **640×400px**

### Suggested shots:
1. **Popup — healthy usage** (green badge, ~20% session, ~30% weekly, ~10% design, with reset countdowns showing)
2. **Popup — high usage** (red badge, ~90% session, showing "Resets in 2h 15m")
3. **Popup — full breakdown** showing all three cards: session, weekly, and Claude Design
4. **Toolbar badge** — zoomed view showing the % badge on the Chrome toolbar

### How to take them:
1. Load the extension unpacked in Chrome (chrome://extensions → Load unpacked → select the `claudetrack/` folder)
2. Open `https://claude.ai` so the extension can fetch your real data
3. Click the extension icon to open the popup
4. Use Chrome DevTools or a screen capture tool set to 1280×800

---

## Store checklist before submitting

- [ ] Bump `version` in `claudetrack/manifest.json`
- [ ] Test the unpacked extension in Chrome (badge updates, popup shows session/weekly/design, refresh works)
- [ ] Build the ZIP from inside `claudetrack/` (files at root, not nested)
- [ ] Privacy policy URL is live and accurate
- [ ] At least 1 screenshot (1280×800)
- [ ] Tag the release in git (`git tag v<version> && git push --tags`)

## How to zip for upload

```
cd claudetrack/
zip -r ../claude-usage-monitor-v<version>.zip . --exclude "*.DS_Store"
```

PowerShell on Windows:
```
cd claudetrack
Compress-Archive -Path * -DestinationPath ../claude-usage-monitor-v<version>.zip -Force
```

The ZIP must contain the files at the root, not inside a `claudetrack/` folder.
