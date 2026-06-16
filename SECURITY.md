# Security Policy

This document describes the security model of **Claude Usage Monitor**
(`msadofschi/claudetrack`), how to report a vulnerability, and an honest threat
model — including what a worst-case compromise could and could not do.

The extension is open source and unminified. Every claim below is checkable
against the source in this repository, primarily
[`claudetrack/manifest.json`](claudetrack/manifest.json),
[`claudetrack/background.js`](claudetrack/background.js), and
[`claudetrack/popup.js`](claudetrack/popup.js).

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately by email to **martin.sadofschi@gmail.com** with:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- The extension version (shown in the popup header, e.g. `v1.7.2`) and your
  browser + version.

You can expect an initial acknowledgement within **5 business days**. Valid
issues will be fixed in a new release pushed to the Chrome Web Store and Firefox
Add-ons, and the fix will be noted in the release. You are welcome to be
credited, or to remain anonymous — your call.

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

The extension is built so that the **worst case is small by construction**, not
by trust. The defense is the permission surface, not a promise.

### Permissions

Declared in [`claudetrack/manifest.json`](claudetrack/manifest.json):

| Permission                                    | Why it exists                                          | What it does **not** grant                                  |
| --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `storage`                                     | Persist usage data and preferences locally             | No network, no page access, no sync to any server           |
| `alarms`                                      | Schedule the periodic refresh                          | Nothing else                                                |
| host: `claude.ai/api/organizations`           | Read the org list to find the active org UUID + plan   | No other path on claude.ai                                  |
| host: `claude.ai/api/organizations/*/usage`   | Read usage statistics                                  | Read-only; cannot write                                     |
| host: `claude.ai/api/organizations/*/prepaid/credits` | Read your prepaid usage-credit **balance** (shown in the extra-credits banner) | Read-only; no payment methods, cards, or invoices |
| host: `claude.ai/api/organizations/*/overage_spend_limit` | Read your monthly usage-credit **spend / limit** (shown in the extra-credits banner) | Read-only; no payment methods, cards, or invoices |
| host: `claude.ai/v1/code/routines/run-budget` | Read the daily routine-run budget                      | Read-only; cannot write                                     |

There is **no** `cookies`, `tabs`, `scripting`, `webRequest`, `<all_urls>`, or
any broad host permission. There are **no content scripts**, no
`web_accessible_resources`, and no `externally_connectable`.

### What the extension can and cannot access

| Can read (via your session)                          | Cannot access                                              |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Session (5-hour) usage %                             | Your chats, projects, or files                            |
| Weekly usage % (all models + per-model sub-caps)     | Organization members / member list                        |
| Daily routine-run count                              | Billing management or payment methods                     |
| Extra-usage credit spend + prepaid balance           | API key management (different domain — see threat model)  |
| Your organization UUID                               | Any non-`claude.ai` domain                                |
| Your plan tier label (e.g. `Max 5x`)                 | The value of your session cookie or auth token            |

### Credentials and your session

Network requests use `credentials: 'include'`
([`background.js`](claudetrack/background.js)), which tells the **browser** to
attach the `claude.ai` cookie you already have — exactly as the official
`claude.ai/settings/usage` page does. The extension:

- has no `cookies` permission, so it **never reads the value** of your cookie or
  token;
- only issues **`GET`** requests — it cannot change your account, send messages,
  or spend quota;
- stores results only in `chrome.storage.local` on your device.

### No remote code, no injection surface

- All code ships inside the package. Nothing is downloaded or evaluated at
  runtime (no `eval`, no remote scripts), as required by Manifest V3.
- API responses are rendered with `.textContent`, never `innerHTML`
  ([`popup.js`](claudetrack/popup.js)), so a malformed or hostile API response
  cannot inject executable markup.
- The message listener in [`background.js`](claudetrack/background.js) only
  accepts messages from the extension's own popup (`REFRESH`, `SET_INTERVAL`).
  With no `externally_connectable`, **no web page can message the extension.**

---

## Threat Model

### Assets

The only data this extension handles is **Claude usage metadata**: percentages,
reset times, your org UUID, and your plan tier. There are no credentials,
secrets, message contents, or payment data in scope.

### Supply chain / compromised release

This is the realistic, generic risk for **any** auto-updating browser extension:
the publisher account (Chrome Web Store / Firefox AMO) or the build/distribution
chain is compromised, and a malicious version reaches users.

It is worth taking seriously — and it is also where minimal permissions do their
job. A compromised release is bounded by what the manifest already grants:

- With the **current** permissions, the most a malicious build could do is read
  your usage metadata + org UUID/tier + prepaid credit balance and try to send it
  somewhere. That is the entire blast radius: **low-value usage numbers, a plan
  name, and a credit balance.** No chats, no members, no keys, no payment methods.
- To do **more** — reach other endpoints, other domains, or exfiltrate to an
  attacker server — a malicious version must **expand `host_permissions`** (or
  add `cookies`/`scripting`/etc.) in the manifest. That is not silent:
  - It is **visible in the public diff** of this repository.
  - Browsers **surface a new-permission prompt and disable the extension
    pending your re-approval** when an update increases permissions. There is no
    quiet permission escalation.
  - It is subject to store review.

So minimal permissions are not a cosmetic detail — they are the cap on a
supply-chain compromise.

### A compromised service worker is still bounded to five paths

A fair question from any security reviewer: the background service worker runs
inside the already-trusted extension, on a timer, with `credentials: 'include'`
— so could a **compromised** build quietly walk other authenticated `claude.ai`
endpoints and exfiltrate whatever they return? With this manifest, no. The
reason is that `host_permissions` are scoped to five **exact paths**, not to
`https://claude.ai/*`:

- `https://claude.ai/api/organizations`
- `https://claude.ai/api/organizations/*/usage`
- `https://claude.ai/api/organizations/*/prepaid/credits`
- `https://claude.ai/api/organizations/*/overage_spend_limit`
- `https://claude.ai/v1/code/routines/run-budget`

That path-level scoping ([`claudetrack/manifest.json`](claudetrack/manifest.json))
bounds the worst case in two independent ways.

**1. It can only read those five endpoints.** Attaching the session cookie is
not the same as being able to read the response. A credentialed `fetch` to any
other URL — a different path on `claude.ai`, or any other domain — is an
ordinary cross-origin request for which the extension holds no matching host
permission. The browser applies the normal CORS rules, and `claude.ai` does not
return headers granting a browser extension read access, so the response is
**opaque and unreadable**. Pivoting to a settings, account, member, or billing
endpoint to harvest what it returns simply does not work: the bytes never reach
the worker.

**2. Reading anything else requires widening `host_permissions`.** To make a new
endpoint readable, a malicious build has to add it to the manifest — and that is
the same non-silent escalation described above: the browser surfaces a
new-permission prompt and **disables the extension until you re-approve it**, the
change is visible in this repository's public diff, and it is subject to store
review. There is no quiet path from "five read-only endpoints" to "the rest of
your account."

**What a compromised build can still do** — without any prompt — is *send* what
it already reads (org UUID, usage percentages, plan tier, credit balance) to an attacker, since
a fire-and-forget request needs no readable response. That is the entire blast
radius: the same low-value metadata, exfiltrated. No new class of data — chats,
projects, organization members, payment methods, invoices, or API keys —
becomes reachable, because reaching any of it would require a permission this
manifest does not grant. The polling interval changes how often that metadata
could be sent, not what is in scope.

All of this is checkable against
[`claudetrack/manifest.json`](claudetrack/manifest.json) (the five host
permissions) and [`claudetrack/background.js`](claudetrack/background.js) (every
request is a `GET` to one of those URLs).

### No dependency supply chain

The extension has **zero third-party runtime dependencies**: no `package.json`,
no `node_modules`, no bundler, and no build step. The JavaScript in
[`claudetrack/`](claudetrack/) is exactly what ships to the store. There is no
npm/lockfile layer for a malicious, compromised, or typosquatted package to ride
in through — the only code that runs is the code in this repository. This is why
pinned dependency versions do not apply here: there are no dependencies to pin,
which removes that supply-chain surface entirely rather than managing it.

### Why a claude.ai session does not expose API keys

A common (and reasonable) worry: "if a compromised extension rides my
authenticated session, can it steal my Anthropic API keys and rack up a bill?"

For this extension, no:

1. **Different domain.** Programmatic Anthropic API keys are managed on
   **`console.anthropic.com`**, not `claude.ai`. This extension's
   `host_permissions` cover only `claude.ai`. Under Manifest V3 the service
   worker **cannot fetch a domain outside `host_permissions`** — so the key
   management surface is unreachable.
2. **Different session.** A `claude.ai` cookie does not authenticate
   `console.anthropic.com`; they are separate origins and sessions even if you
   sign in to both with the same identity provider.
3. **No member/billing endpoints.** The granted endpoints are the org list and
   usage stats. Member enumeration and billing management are not in scope and
   not reachable.

Reaching API keys would require a malicious build to add
`console.anthropic.com` (or similar) to `host_permissions` — which lands back in
the visible, prompt-triggering escalation described above.

### Out of scope

- Vulnerabilities in `claude.ai` itself or Anthropic's APIs — report those to
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
- Keeping the permission surface **minimal** (the most effective mitigation).
- Shipping **unminified** code so the published build can be diffed against this
  repository.
- **Signing git commits and tags** with an OpenPGP key, so the commit history
  has a verifiable origin (GitHub shows "Verified").
- **Publishing signed SHA-256 checksums** for each release package, so any copy
  can be checked against a known-good, signed hash — and traced if a hash
  surfaces in threat intelligence / IoCs.

---

## Data Handling and Privacy

- All data is stored locally in `chrome.storage.local`. Nothing is synced to any
  server, sent to the maintainer, or shared with third parties.
- No analytics, no telemetry, no crash reporting, no ad networks.
- The only network destination is `claude.ai`.

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
[`claudetrack/`](claudetrack/). To verify the version you installed matches this
repo:

1. Note the version in the popup header (e.g. `v1.7.2`) and check out the
   matching commit/tag.
2. Compare the installed extension files (Chrome:
   `chrome://extensions` → Inspect; or unpack the store CRX/XPI) against
   `claudetrack/`.
3. There is no build step — no transpilation, bundling, or minification — so the
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
