# Claude Usage Monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.9.0-blue.svg)](claudetrack/manifest.json)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-brightgreen.svg)](https://chromewebstore.google.com/detail/claude-usage-monitor-sess/bfhdcfiigpaaopklllpobkheakpigbfo)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox-Add--ons-orange.svg)](https://addons.mozilla.org/firefox/addon/claude-usage-meter/)

Claude Usage Monitor is a Manifest V3 browser extension for Claude.ai that shows your current usage directly from the toolbar popup. **Open source (MIT)** — all code in this repo is exactly what runs in your browser.

It displays your usage buckets:

- **Current Session**: the current 5-hour-window Claude usage percentage.
- **Weekly limit**: the weekly usage percentage across all models.
- **Per-model weekly sub-limits**: Fable, Opus, Sonnet and Claude Design weekly usage (on paid plans) — show or hide each from the **Metrics** section of the popup's options menu.
- **Daily routine runs**: included Claude Code routine runs as a `used / limit` count (on plans that include them).
- **Your plan**: a badge in the popup header shows your Claude subscription (e.g. *Max 5x*).

## How it works

The extension refreshes usage through Claude.ai's internal authenticated API.

- Automatic refresh runs every 5 minutes.
- Manual refresh is available from the popup.
- The popup shows the extension version so you can confirm which local build is loaded.
- A badge in the header shows your Claude plan (e.g. Max 5x).

## Features

- Toolbar badge showing the current session percentage.
- Popup with current session and weekly usage cards.
- Per-model weekly sub-limit cards — Fable, Opus, Sonnet and Claude Design — offered on paid plans.
- **Display options** menu in the popup: a **Metrics** section to show/hide optional cards (per-model weekly limits and daily routine runs, with Select all / Deselect all), plus a **Theme** section with 6 color palettes; your choices are remembered.
- Daily routine-runs card (`used / limit`), shown only on plans that include routine runs.
- Subscription badge in the header (Max, Pro, Team, etc.).
- Reset countdowns when Claude returns reset timestamps.
- Manual refresh button.
- Quick link to `https://claude.ai/settings/usage`.
- Local storage caching so the last known value remains visible between refreshes.

## Browser support

- **Google Chrome** — Manifest V3, uses `manifest.json`.
- **Mozilla Firefox** — Manifest V3, uses `manifest.firefox.json` (packaged as `manifest.json` by the build script).

The codebase uses the standard `chrome.*` extension APIs, which Firefox supports via the WebExtensions namespace.

## Run locally

Load the unpacked extension from the inner `claudetrack/` directory in this repository.

The extension files are here:

- `claudetrack/manifest.json`
- `claudetrack/background.js`
- `claudetrack/popup.html`

### Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `claudetrack/` folder inside this repo.
5. Pin the extension if you want fast access from the toolbar.

### Firefox

Firefox uses a separate manifest (`manifest.firefox.json`). To load it temporarily:

1. In a copy of the `claudetrack/` folder, replace `manifest.json` with the contents of `manifest.firefox.json` (Firefox reads `manifest.json`).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select the `manifest.json` inside that copied folder.
5. The add-on stays loaded until you restart Firefox.

For a permanent install, use the published add-on at <https://addons.mozilla.org/firefox/addon/claude-usage-meter/>.

## Notes for local testing

- You must already be logged in to `https://claude.ai`.
- After loading the extension, open the popup and confirm the version shown there matches the current build.
- Automatic refresh should work without manually opening the usage page.
- Usage is read exclusively through Claude.ai's authenticated API in `background.js`. If Claude changes that internal API, refresh may stop working until the extension is updated.

## Project structure

- `claudetrack/manifest.json`: extension manifest and permissions.
- `claudetrack/background.js`: automatic refresh logic, Claude API fetching, storage, and badge updates.
- `claudetrack/popup.html`: popup markup.
- `claudetrack/popup.css`: popup styling.
- `claudetrack/popup.js`: popup rendering, manual refresh flow, and storage listeners.

## Privacy

- All data is stored locally on your device via `chrome.storage.local`.
- No analytics, no telemetry, no third parties.
- The extension cannot read your chats, projects, files, or any other Claude.ai content.
- Host permissions are scoped to specific Claude.ai API endpoints. See [SECURITY.md](SECURITY.md) for the full permission breakdown.
- Full privacy policy: <https://claude-monitor.com/privacy>

## Contributing

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/msadofschi/claudetrack/issues).

Pull requests are welcome. For non-trivial changes, please open an issue first to discuss the scope.

## Security

The full security model, threat model, and vulnerability-reporting process are documented in **[SECURITY.md](SECURITY.md)**.

To report a vulnerability, email <martin.sadofschi@gmail.com> instead of opening a public issue.

## License

[MIT](LICENSE) © Digital Advanced Solutions

Claude Usage Monitor is an independent project and is not affiliated with Anthropic.
