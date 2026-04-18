# Chrome Web Store Listing — Claude Usage Monitor

## Extension name
Claude Usage Monitor

## Short description (119 / 132 chars max)
Track your Claude.ai usage in real time. Session & weekly limits, reset countdowns, color-coded badge — right in your toolbar.

## Category
Productivity

## Language
English

## Privacy policy URL
https://msadofschi.github.io/claude-usage-monitor/

---

## Long description

Know when you're getting close to your Claude limit — without opening the settings page.

Claude Usage Monitor shows your session and weekly usage directly in your browser toolbar, with a color-coded badge that updates automatically every 5 minutes.

**What you see at a glance:**
- Session usage percentage (current 5-hour window)
- Weekly usage percentage (all models combined)
- Countdown to each reset time
- Color-coded badge: green under 50%, yellow 50–80%, red above 80%

**How it works:**
The extension reads your usage data directly from Claude.ai using your existing login session — the same way Claude's own settings page works. No separate account or sign-up required. All data is stored locally on your device and is never sent anywhere else.

**Permissions used and why:**
- *claude.ai access* — to read usage data from the Claude API using your existing session
- *Storage* — to persist usage data between sessions so the badge survives browser restarts
- *Alarms* — to schedule a refresh every 5 minutes
- *Scripting* — to parse the Claude usage settings page as a fallback when the API is unavailable

**Privacy:**
Nothing leaves your device except requests to claude.ai (which you're already making when you use Claude). No tracking, no analytics, no third-party services. Full privacy policy: https://msadofschi.github.io/claude-usage-monitor/

---

## Screenshots needed (take manually)

Minimum: 1 screenshot at **1280×800px** or **640×400px**

### Suggested shots:
1. **Popup — healthy usage** (green badge, ~20% session, ~30% weekly, with reset countdowns showing)
2. **Popup — high usage** (red badge, ~90% session, showing "Resets in 2h 15m")
3. **Toolbar badge** — zoomed view showing the % badge on the Chrome toolbar

### How to take them:
1. Load the extension unpacked in Chrome (chrome://extensions → Load unpacked → select the `claudetrack/` folder)
2. Open `https://claude.ai` so the extension can fetch your real data
3. Click the extension icon to open the popup
4. Use Chrome DevTools or a screen capture tool set to 1280×800

---

## Store checklist before submitting

- [ ] Privacy policy page live at https://msadofschi.github.io/claude-usage-monitor/
- [ ] At least 1 screenshot (1280×800)
- [ ] Extension loaded and tested in Chrome (verify badge updates, refresh button works)
- [ ] `claudetrack/` folder zipped for upload (zip the folder contents, not the folder itself)
- [ ] Developer account registered at https://chrome.google.com/webstore/devconsole ($5 one-time fee)

## How to zip for upload

```
cd claudetrack/
zip -r ../claude-usage-monitor-v1.1.2.zip . --exclude "*.DS_Store"
```

Or on Windows: select all files inside the `claudetrack/` folder → right-click → Compress to ZIP.
