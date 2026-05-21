# Claude Usage Monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.4.2-blue.svg)](claudetrack/manifest.json)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web%20Store-brightgreen.svg)](https://chromewebstore.google.com/detail/claude-usage-monitor-sess/bfhdcfiigpaaopklllpobkheakpigbfo)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox-Add--ons-orange.svg)](https://addons.mozilla.org/firefox/addon/claude-usage-meter/)

Claude Usage Monitor is a Manifest V3 browser extension for Claude.ai that shows your current usage directly from the toolbar popup. **Open source (MIT)** — all code in this repo is exactly what runs in your browser.

It displays three usage buckets:

- **Current Session**: the current short-window Claude usage percentage.
- **Weekly Limit**: the weekly Claude usage percentage.
- **Claude Design**: the weekly Claude Design usage percentage (only shown when in use).

## How it works

The extension refreshes usage through Claude.ai's internal authenticated API.

- Automatic refresh runs every 5 minutes.
- Manual refresh is available from the popup.
- The popup shows the extension version so you can confirm which local build is loaded.
- A content-script fallback fires if a usage tab is already open and the API path fails.

## Features

- Toolbar badge showing the current session percentage.
- Popup with current session and weekly usage cards.
- Reset countdowns when Claude returns reset timestamps.
- Claude Design usage card (hidden until Design is active).
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

Firefox uses a separate manifest (`manifest.firefox.json`). The easiest path is to build the Firefox ZIP and load it temporarily:

1. From the repo root, run:
   ```powershell
   ./build-firefox.ps1
   ```
   This produces `claude-usage-monitor-firefox-v<version>.zip`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on...**.
4. Select the generated ZIP (or any file inside the unpacked ZIP).
5. The add-on stays loaded until you restart Firefox.

For a permanent install, use the published add-on at <https://addons.mozilla.org/firefox/addon/claude-usage-meter/>.

## Notes for local testing

- You must already be logged in to `https://claude.ai`.
- After loading the extension, open the popup and confirm the version shown there matches the current build.
- Automatic refresh should work without manually opening the usage page.
- If Claude changes its internal API behavior, the fallback parser may still help, but the primary refresh path is the API integration in `background.js`.

## Project structure

- `claudetrack/manifest.json`: extension manifest and permissions.
- `claudetrack/background.js`: automatic refresh logic, Claude API fetching, storage, and badge updates.
- `claudetrack/content.js`: fallback usage-page parsing logic for `claude.ai/settings/usage`.
- `claudetrack/popup.html`: popup markup.
- `claudetrack/popup.css`: popup styling.
- `claudetrack/popup.js`: popup rendering, manual refresh flow, and storage listeners.

## Privacy

- All data is stored locally on your device via `chrome.storage.local`.
- No analytics, no telemetry, no third parties.
- The extension cannot read your chats, projects, files, or any other Claude.ai content.
- Host permissions are scoped to the usage page and two specific API endpoints. See the [Chrome](STORE_LISTING_CHROME.md) and [Firefox](STORE_LISTING_FIREFOX.md) listings for the full permission breakdown.
- Full privacy policy: <https://claude-monitor.netlify.app/privacy>

## Contributing

Bug reports and feature requests are welcome via [GitHub Issues](https://github.com/msadofschi/claudetrack/issues).

Pull requests are welcome. For non-trivial changes, please open an issue first to discuss the scope.

## Security

If you find a security issue, please email <martin.sadofschi@gmail.com> instead of opening a public issue.

## License

[MIT](LICENSE) © Digital Advanced Solutions

Claude Usage Monitor is an independent project and is not affiliated with Anthropic.
