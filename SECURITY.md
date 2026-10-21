# Security Policy

This document describes the security model of **Claude Usage Monitor**
(`claude-monitor/claude-monitor-browser-extension`), how to report a vulnerability, and an honest threat
model, including what a worst-case compromise could and could not do.

The extension is open source and unminified. Every claim below is checkable
against the source in this repository, primarily
[`extension/manifest.json`](extension/manifest.json),
[`extension/background.js`](extension/background.js), and
[`extension/popup.js`](extension/popup.js).

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately by email to **support@claude-monitor.com** with:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The extension version (shown in the popup header, e.g. `v1.7.2`) and your
  browser + version.

You can expect an initial acknowledgement within **5 business days**. Valid
issues will be fixed in a new release pushed to the Chrome Web Store and Firefox
Add-ons, and the fix will be noted in the release. You are welcome to be
credited, or to remain anonymous: your call.

GitHub's private vulnerability reporting ("Report a vulnerability" under the
**Security** tab) is also accepted if enabled.

---

## Supported Versions

The extension auto-updates from the Chrome Web Store and Firefox Add-ons. Only
the **latest published version** is supported and receives security fixes.
There is no backporting to older versions; updating is automatic.

| Version            | Supported |
| ------------------ | --------- |
| Latest published   | ✅        |
| Anything older     | ❌        |

---

## Security Model

The extension asks for few permissions and makes few requests, and every claim
here can be checked in the source. The permission surface limits what a
compromised release could read to `claude.ai`, but on `claude.ai` it is wider
than the five API paths the manifest lists (see the [threat model](#a-compromised-build-is-bounded-by-the-code-not-by-the-paths)).
Inside `claude.ai`, what bounds the extension is the published code, the signed
release checksums and store review.

### Permissions

Declared in [`extension/manifest.json`](extension/manifest.json):

| Permission                                    | Why it exists                                          | What the code does with it                                  |
| --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `storage`                                     | Persist usage data and preferences locally             | No network, no page access, no sync to any server           |
| `alarms`                                      | Schedule the periodic refresh                          | Nothing else                                                |
| host: `claude.ai/api/organizations`           | Read the org list to find the active org UUID + plan   | `GET` requests only                                         |
| host: `claude.ai/api/organizations/*/usage`   | Read usage statistics                                  | `GET` requests only; nothing is written                    |
| host: `claude.ai/api/organizations/*/prepaid/credits` | Read your prepaid usage-credit **balance** (shown in the extra-credits banner) | `GET` requests only; no payment methods, cards, or invoices |
| host: `claude.ai/api/organizations/*/overage_spend_limit` | Read your monthly usage-credit **spend / limit** (shown in the extra-credits banner) | `GET` requests only; no payment methods, cards, or invoices |
| host: `claude.ai/v1/code/routines/run-budget` | Read the daily routine-run budget                      | `GET` requests only; nothing is written                    |

**The host paths are not a browser-enforced limit.** Chrome ignores the path
part of host permissions ("For host permissions, the path is required but
ignored", in Chrome's
[match pattern docs](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)),
so these five entries grant access to all of `https://claude.ai/*`, and the
install prompt says so: "Read and change your data on claude.ai". The
right-hand column is what the code does, not what the browser allows. See the
[threat model](#a-compromised-build-is-bounded-by-the-code-not-by-the-paths)
for what that means and how to check it.

There is **no** `cookies`, `tabs`, `webRequest` or `<all_urls>` permission.
`notifications` and `scripting` are **optional**: neither is granted at install,
and each is requested only from a click on one of the extension's own pages:
Settings, the welcome page opened once at install, or a notice in the popup.
Host access to `https://claude.ai/*` is declared optional too, but in Chrome the
required API hosts above already grant it at install.

By default there are **no content scripts**. They exist only while the optional
on-page bar is turned on, and then only on `claude.ai`:

- `page/bar.js` draws the usage strip above the chat box from data the
  extension already stored. It makes no requests.
- `page/stream.js` runs in the page's own world and reads the limits Claude
  attaches to each reply: the `message_limit` event of the chat completion
  stream, or the limit frame of the newer `StreamTimeline` stream (binary
  Connect frames). It extracts only the limit fields (utilization and reset of
  the 5-hour and 7-day windows) and never stores or sends anything else. Event
  lines are matched on their raw bytes and only the limit event's line is
  decoded; `StreamTimeline` frames are matched on the bytes of the "5h"/"7d"
  labels and walked as numbers and lengths, never turned into text.
  Compressed frames, which carry the reply, are skipped without being
  decompressed; only their 5-byte header is read. A send (`PerformAction`) is
  noticed by its URL alone, to tell a new message from a replayed timeline. The
  request (your prompt) is never touched, and the reply streams past without
  being parsed, kept or passed on. Reading stops at 8 MB per response. On the
  Free plan these figures are the only place Claude reports limits.

Turning the bar off unregisters both scripts and gives `scripting` back. In
Chrome, access to `claude.ai` stays, because the required API hosts already
grant it; Chrome refuses to remove it ("You cannot remove required
permissions"). Up to 1.20.2, turning the bar off left `scripting` granted;
the update to 1.21.0 gives it back when the bar is off.
There are no `web_accessible_resources` and no `externally_connectable`.

### What the extension reads and does not read

| Reads (via your session)                             | Does not read                                              |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Session (5-hour) usage %                             | Your chats, projects, or files (the optional bar scans replies only for the usage event, see above) |
| Weekly usage % (all models + per-model sub-caps)     | Organization members / member list                        |
| Daily routine-run count                              | Billing management or payment methods                     |
| Extra-usage credit spend + prepaid balance           | API key management (a different domain, see threat model)  |
| Your organization UUIDs and names (for the popup's picker, kept on this device) | Any non-`claude.ai` domain                  |
| Your plan tier label (e.g. `Max 5x`)                 | The value of your session cookie or auth token            |

The right-hand column is what the code does. The browser backs the last three
rows only for this manifest: with no `cookies` permission the extension cannot
read cookie values, and other domains, including the one that manages API keys,
answer it under their normal CORS rules. As with any extension, an update could
change that, so for that row too what holds is the published code. Everything else in that column lives on `claude.ai`,
which Chrome grants in full (see above).

### Credentials and your session

Network requests use `credentials: 'include'`
([`background.js`](extension/background.js)), which tells the **browser** to
attach the `claude.ai` cookie you already have, exactly as the official
`claude.ai/settings/usage` page does. The extension:

- has no `cookies` permission, so it **never reads the value** of your cookie or
  token;
- only issues **`GET`** requests: it does not change your account, send
  messages, or spend quota;
- stores results only in `chrome.storage.local` on your device.

### No remote code, no injection surface

- All code ships inside the package. Nothing is downloaded or evaluated at
  runtime (no `eval`, no remote scripts), as required by Manifest V3.
- API responses are rendered with `.textContent`, never `innerHTML`
  ([`popup.js`](extension/popup.js)), so a malformed or hostile API response
  cannot inject executable markup.
- The message listener in [`background.js`](extension/background.js) takes
  `REFRESH`, `SET_INTERVAL` and `SET_ORG` from the popup (`REFRESH` also from
  the welcome page), `PRUNE_HISTORY` from Settings and, with the bar on,
  `STREAM_LIMITS`, `REFRESH` and `OPEN_DETAILS` from `page/bar.js`. With no
  `externally_connectable`, no web page can message the extension directly.
  While the bar is on, a script on `claude.ai` can post figures to
  `page/bar.js`; the worker keeps them only as two bounded numbers per window
  (`streamWindow`) on the Free plan, and on paid plans uses them only as a cue
  to re-read `/usage`. For the messages-left estimate it also keeps, for the
  last 20 replies of the current window, a time, a usage fraction and an
  8-character hash of the frame (to count a reply once): no message content.
  `SET_ORG` only accepts an organization from the list `/api/organizations`
  returned, and `OPEN_DETAILS` only opens the popup or Settings.

---

## Threat Model

### Assets

The only data the published code handles is **Claude usage metadata**:
percentages, reset times, your org UUIDs and names (for the popup's picker),
your plan tier and, with the bar on, the time, usage fraction and an
8-character frame hash of your last 20 replies. It keeps no credentials,
secrets, message contents, or payment data (see below for what a compromised
build could reach).

### Supply chain / compromised release

This is the realistic, generic risk for **any** auto-updating browser extension:
the publisher account (Chrome Web Store / Firefox AMO) or the build/distribution
chain is compromised, and a malicious version reaches users.

It is worth taking seriously, and it is where the manifest, the signatures and
store review each do part of the job:

- The manifest limits what a compromised release can read to `claude.ai`,
  **but not to the five API paths it lists** (see the next section). Inside `claude.ai`, a malicious
  build could read whatever your session can read through the API, and send it
  anywhere: sending needs no permission.
- To go **further**, a malicious version has to change the manifest. That
  shows when the store package is compared with this repository, and it is
  subject to store review. Some permission changes also bring a Chrome prompt
  and others do not, which is why the published code and the signed checksums
  matter.

So the permissions cap what a compromised release can read at `claude.ai`. Within
`claude.ai`, the cap is the published code, which you can compare against the
signed checksums of each release, and store review.

### A compromised build is bounded by the code, not by the paths

A fair question from any security reviewer: the background service worker runs
inside the already-trusted extension, on a timer, with `credentials: 'include'`,
so could a **compromised** build quietly walk other authenticated `claude.ai`
endpoints and send whatever they return to an attacker? **Yes.** Earlier
versions of this document said the five paths in `host_permissions` prevented
that. They do not.

**What Chrome actually grants.** The manifest lists five paths:

- `https://claude.ai/api/organizations`
- `https://claude.ai/api/organizations/*/usage`
- `https://claude.ai/api/organizations/*/prepaid/credits`
- `https://claude.ai/api/organizations/*/overage_spend_limit`
- `https://claude.ai/v1/code/routines/run-budget`

Chrome ignores the path in host permissions, so it grants all of
`https://claude.ai/*` and announces exactly that at install ("Read and change
your data on claude.ai"). A credentialed `fetch` from the service worker to a
`claude.ai` path outside the list comes back as readable as one inside it. A
request to another domain is still an ordinary cross-origin request and fails
CORS.

**Check it yourself.** In `chrome://extensions`, turn on Developer mode, click
*service worker* under the extension (Inspect views), and run in its console:

```js
await chrome.permissions.getAll();
// {origins: ['https://claude.ai/*'], permissions: ['alarms', 'storage']}

const probe = (url) => fetch(url, { credentials: 'include' })
  .then(async (r) => [r.type, r.status, (await r.text()).length]);
await probe('https://claude.ai/api/organizations'); // listed: type 'basic', body readable
await probe('https://claude.ai/api/account');       // not listed: same, body readable
await probe('https://example.com/');                // other domain: TypeError: Failed to fetch
```

(Run in Chrome 155 on 2026-10-14 with a fresh profile: `getAll()` returned the
line above, and both `claude.ai` paths came back with type `basic` and a
readable body.)

**What bounds the extension instead:**

- **The code.** It is unminified, has no build step and no dependencies, and
  makes five kinds of request, all `GET`, all to the paths above
  ([`background.js`](extension/background.js)).
- **Signed releases.** Each release ZIP has a GPG-signed SHA-256 checksum (see
  [Verifying Release Signatures](#verifying-release-signatures-and-commits)), so
  the files of an installed copy can be compared against a package the
  maintainer signed.
- **Store review** of every update.
- **The manifest, at the edge of `claude.ai`.** Reading other domains with your
  session needs a new host permission, which brings the prompt described above.
  Inside `claude.ai` it is not a barrier, since some permissions can be added
  in an update without a prompt.

**With the on-page bar on**, the extension also holds `scripting` and runs two
scripts on `claude.ai` pages. A compromised build could then read and change
those pages as well, including your chats as they are shown on screen. The bar
is off by default, and turning it off unregisters the scripts and gives
`scripting` back.

**What a compromised build could do without any prompt:** read what your
`claude.ai` session can read (account details, conversations, projects,
organization members) and send it to an attacker, since a fire-and-forget
request needs no permission. That is the reason releases are signed and the code
is published unminified: a build that does this would differ from this
repository, and the signed checksums make that difference detectable.

All of this is checkable against
[`extension/manifest.json`](extension/manifest.json) (the five host
permissions) and [`extension/background.js`](extension/background.js) (every
request is a `GET` to one of those URLs).

### No dependency supply chain

The extension has **zero third-party runtime dependencies**: no `package.json`,
no `node_modules`, no bundler, and no build step. The JavaScript in
[`extension/`](extension/) is exactly what ships to the store. There is no
npm/lockfile layer for a malicious, compromised, or typosquatted package to ride
in through: the only code that runs is the code in this repository. This is why
pinned dependency versions do not apply here: there are no dependencies to pin,
which removes that supply-chain surface entirely rather than managing it.

### Why a claude.ai session does not expose API keys

A common (and reasonable) worry: "if a compromised extension rides my
authenticated session, can it steal my Anthropic API keys and rack up a bill?"

For this extension, no:

1. **Different domain.** Programmatic Anthropic API keys are managed on
   **`console.anthropic.com`**, not `claude.ai`. This extension's
   `host_permissions` cover only `claude.ai`. The service worker **cannot read
   a response from a domain outside `host_permissions`** unless that domain's
   CORS headers allow it, so the key management surface is out of reach.
2. **Different session.** A `claude.ai` cookie does not authenticate
   `console.anthropic.com`; they are separate origins and sessions even if you
   sign in to both with the same identity provider.
3. **`claude.ai` is a different matter.** Chrome grants all of `claude.ai` (see
   above), so a compromised build could read what your session reads there,
   such as organization members. What keeps the published extension away from
   those endpoints is its code, not its permissions.

Reaching API keys would require a malicious build to add
`console.anthropic.com` (or similar) to `host_permissions`, which lands back in
the visible, prompt-triggering escalation described above.

### Out of scope

- Vulnerabilities in `claude.ai` itself or Anthropic's APIs: report those to
  Anthropic.
- Attacks requiring a pre-compromised machine, a malicious browser build, or
  physical access.
- Social engineering of the maintainer.

---

## Publisher-side mitigations

Because the publisher account is the real target of a supply-chain attack, these
matter more than the extension code itself:

- Two-factor authentication on the **Chrome Web Store** and **Firefox AMO**
  developer accounts.
- Two-factor authentication and branch protection on **GitHub**.
- Keeping the permission surface **minimal**, which keeps what a compromised
  build can reach with your session to `claude.ai`.
- Shipping **unminified** code so the published build can be diffed against this
  repository.
- **Signing git commits and tags** with an OpenPGP key, so the commit history
  has a verifiable origin (GitHub shows "Verified").
- **Publishing signed SHA-256 checksums** for each release package, so any copy
  can be checked against a known-good, signed hash, and traced if a hash
  surfaces in threat intelligence / IoCs.

---

## Data Handling and Privacy

- All data is stored locally in `chrome.storage.local`. No usage data is synced
  to any server, sent to the maintainer, or shared with third parties.
- No analytics, no telemetry, no crash reporting, no ad networks.
- The extension's only network destination is `claude.ai`.
- On uninstall, `runtime.setUninstallURL` opens an optional one-question survey
  on claude-monitor.com. The query carries the extension version and browser
  family. In Chrome and Edge, from 1.21, the `#` fragment carries five coarse
  values: plan type (`free`/`paid`/`unk`), bar on or off, whether the bar found
  the chat box, the result of the last refresh, and an install-age bucket (0,
  1, 7 or 30 days); the Firefox build adds none. A fragment does not reach the
  server when the page opens; the page sends those values only if you tick its
  checkbox when you answer the survey. No identifier, organization name or
  usage figure is ever in the URL.

Full policy: <https://claude-monitor.com/privacy>

---

## Local Development Notes (Claude Code / `.claude`)

For contributors using Claude Code:

- The Anthropic credential used by Claude Code is **not** stored in this
  repository. It lives in your home directory (`~/.claude` / OS keychain),
  outside the project tree. The standard workflow does not write an API key into
  the repo.
- `.claude/settings.local.json` is git-ignored (see [`.gitignore`](.gitignore)).
  It holds local tool-permission preferences, not secrets.
- No file under `.claude/` is tracked in this repository, and no API key
  (`sk-ant-…` / `ANTHROPIC_API_KEY`) has ever appeared in this repository's git
  history.

If you add anything that could hold a secret, git-ignore it before committing,
and never paste keys into tracked files.

---

## Verifying the Published Build

The store package is the unmodified, unminified source in
[`extension/`](extension/). To verify the version you installed matches this
repo:

1. Note the version in the popup header (e.g. `v1.7.2`) and check out the
   matching commit/tag.
2. Compare the installed extension files (Chrome:
   `chrome://extensions` → Inspect; or unpack the store CRX/XPI) against
   `extension/`.
3. There is no build step (no transpilation, bundling, or minification), so the
   files should match byte-for-byte aside from the Firefox manifest swap
   (`manifest.firefox.json` shipped as `manifest.json`).

---

## Verifying Release Signatures and Commits

Release checksums and git commits/tags are signed with the maintainer's OpenPGP
key:

- **Identity:** `Martin Sadofschi <martin.sadofschi@gmail.com>`
- **Fingerprint:** `FD4D 1902 4C6B 44CA 0252  25C3 165E 7A7F C8BB 817D`
- **Public key:** [`signing/signing-key.asc`](signing/signing-key.asc) in this
  repository (also added to the maintainer's GitHub account).

Import the key once:

```sh
gpg --import signing/signing-key.asc
```

### Verify a release package

Each release publishes a `SHA256SUMS-v<version>.txt` checksums file and a
detached signature `SHA256SUMS-v<version>.txt.asc`. Both are kept in this repo
under `signing/` and attached to each GitHub release. To verify from the repo
root (drop the `signing/` prefix if you downloaded the files into the current
folder):

```sh
# 1. Confirm the checksums file was signed by the key above:
gpg --verify signing/SHA256SUMS-v1.7.2.txt.asc signing/SHA256SUMS-v1.7.2.txt

# 2. Confirm the ZIP matches the signed hash:
sha256sum -c signing/SHA256SUMS-v1.7.2.txt  # Linux / macOS
```

On Windows:

```powershell
Get-FileHash -Algorithm SHA256 claude-usage-monitor-chrome-v1.7.2.zip
# compare the hash against the line in signing/SHA256SUMS-v1.7.2.txt
```

A "Good signature" from the fingerprint above plus a matching hash means the
package is the exact one the maintainer released. The same hash can be used to
trace a sample back to its legitimate origin if it appears in IoC feeds.

### Verify commits

```sh
git log --show-signature
```

GitHub marks commits and tags as **Verified** once this public key is registered
on the maintainer's account.

Signing began with commit `9b9502c2` (2026-06-13).
