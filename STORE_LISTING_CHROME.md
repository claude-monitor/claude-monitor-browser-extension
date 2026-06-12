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
https://claude-monitor.com/privacy

---

## Long description

The first Claude usage tracker to monitor Claude Design and Opus weekly limits alongside your 5-hour session and 7-day weekly limits — plus paid extra credits — all in your browser toolbar.

Stop opening claude.ai/settings/usage. A color-coded badge tells you at a glance whether you can keep working or need to pace yourself, with countdowns to every reset.

No account, no API key, no data leaves your browser. Reads your existing Claude session the same way the official settings page does.

Pick from six color themes, from the default warm dark to a clean light mode, switchable right in the popup.

WHAT YOU SEE
- Session usage (5-hour rolling window) with reset countdown
- Weekly usage (all models combined — Fable, Opus, Sonnet, Haiku) with reset day/time
- Fable has no separate weekly cap and draws down the shared weekly limit 2x faster than Opus — flagged right on the weekly card
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
- *Storage* — persist usage data locally so the badge survives browser restarts
- *Alarms* — schedule automatic refreshes at the configured interval
- *https://claude.ai/api/organizations* — list your organizations to identify the active one
- *https://claude.ai/api/organizations/\*/usage* — read usage stats only
- *https://claude.ai/v1/code/routines/run-budget* — read your daily routine-run count only

HOW IT WORKS
1. Install the extension and pin it to your toolbar
2. Log into claude.ai (you probably already are)
3. The badge starts showing your usage automatically
4. Click the icon any time for the full breakdown

Claude Usage Monitor is an independent project and is not affiliated with Anthropic.
Source code: https://github.com/msadofschi/claudetrack
Learn more: https://claude-monitor.com/
Full privacy policy: https://claude-monitor.com/privacy

---

## Screenshots needed (take manually)

Minimum: 1 screenshot at **1280×800px** or **640×400px**

### Current screenshots (`screenshots/`)

| File | Caption for store submission |
|------|------------------------------|
| `01-overview.png` | Session, weekly (Fable · Opus · Sonnet · Haiku), per-model sub-caps, Claude Design, and daily routine runs — all with reset countdowns. No more opening Settings. |
| `02-themes.png` | Six built-in themes: Clay, Slate, Violet, Midnight, Paper, and Cool light. Switch anytime from the popup. |
| `03-display-options.png` | Show or hide any card from the Display options menu. Per-model sub-caps, Claude Design, and daily routine runs are all optional. |
| `04-high-usage.png` | Color-coded the moment you're close — red badge and live countdowns so you can pace yourself before hitting a limit. |

### How to retake if needed:
1. Load the extension unpacked in Chrome (chrome://extensions → Load unpacked → select the `claudetrack/` folder)
2. Open `https://claude.ai` so the extension can fetch your real data
3. Click the extension icon to open the popup
4. Use Chrome DevTools or a screen capture tool set to 1280×800

---

## Store checklist before submitting

- [ ] Bump `version` in `claudetrack/manifest.json`
- [ ] Test the unpacked extension in Chrome (badge updates, popup shows session/weekly/sub-caps + plan badge, Display options menu (Metrics + Theme) works, refresh works)
- [ ] Build the ZIP from inside `claudetrack/` (files at root, not nested)
- [ ] Privacy policy URL is live and accurate
- [ ] At least 1 screenshot (1280×800)
- [ ] Tag the release in git (`git tag v<version> && git push --tags`)

## How to zip for upload

Run from the repo root:

```powershell
./Generate_zip_extensions_chrome.ps1
```

Produces `claude-usage-monitor-chrome-v<version>.zip` at the repo root. Reads the version from `claudetrack/manifest.json` by default, or pass `-Version 1.6.4` to override.

The ZIP must contain the files at the root, not inside a `claudetrack/` folder.
