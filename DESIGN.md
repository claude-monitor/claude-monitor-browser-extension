# Design

Visual system for the Claude Usage Monitor popup. Theme: warm-dark "Anthropic-honest". See PRODUCT.md for the strategy behind it. Source of truth is `claudetrack/popup.css` `:root`; keep this file in sync with it (and reuse it when restyling the landing page).

## Theme

Warm near-black surfaces with a clay accent, the real Anthropic signature rather than the generic "AI equals purple" reflex. Reads as a calm instrument that speaks Claude's own visual language. **Clay** is the default; the user can switch among six themes from the options menu (see Themes below). Theme is an explicit choice persisted in `chrome.storage.local`, not driven by OS light/dark.

## Color

Surfaces (warm, low chroma toward orange):

| Token | Hex | Use |
|---|---|---|
| `--bg-0` | `#15110e` | body |
| `--bg-1` | `#1e1916` | header, cards, footer |
| `--bg-2` | `#271f1b` | controls (select, buttons, menu) |
| `--bg-3` | `#322820` | progress track, hover |
| `--border` | `#352c26` | hairlines |
| `--border-lt` | `#45392f` | control / hover borders |

Ink (all AA on `--bg-1`):

| Token | Hex | Use |
|---|---|---|
| `--text-pri` | `#f4eee7` | primary text |
| `--text-sec` | `#b9ada1` | labels, secondary (~8:1) |
| `--text-dim` | `#9c9286` | supplementary (~5:1) |

Accent, clay (action and selection only, never decoration):

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#d97757` | fills, logo, selection, primary button |
| `--accent-bright` | `#ea9576` | text / links / hover on dark |
| `--accent-ink` | `#1b1410` | text ON clay fills (dark-on-clay, ~5.9:1) |

Semantic usage state (data, not decoration; thresholds <50 / 50–80 / >80):

| Token | Hex |
|---|---|
| `--green` | `#5bc98c` |
| `--yellow` | `#f2b53c` |
| `--red` | `#f0655a` |

## Themes (user-selectable)

Six themes, chosen from the swatch row in the options menu (the sliders button in the header), persisted as `theme` in `chrome.storage.local`, applied via a `data-theme` attribute on `<html>`. Full token sets live in `claudetrack/popup.css` under `:root[data-theme="…"]`; this table lists identity only.

A theme overrides **surface + accent only**. The semantic `--green/--yellow/--red` stay meaningful (usage state), in two sets:
- Dark themes: green `#5bc98c`, amber `#f2b53c`, red `#f0655a`.
- Light themes: green `#15803d`, amber `#b45309`, red `#c81e1e` (deeper, for white-bg contrast).

| Theme | `data-theme` | Mode | Accent | Note |
|---|---|---|---|---|
| Clay | (default) | dark warm | `#d97757` | the default |
| Slate | `slate` | dark cool | `#4a9eff` | neutral instrument |
| Violet | `violet` | dark | `#8250dc` | the pre-1.5 look, kept for continuity |
| Midnight | `midnight` | near-black | `#d97757` | OLED / high contrast |
| Paper | `paper` | light | `#b85a36` | white surface, clay |
| Cool light | `cool` | light | `#4f46e5` | white surface, indigo |

Accents avoid the green/red/amber hue ranges so they never read as usage state. Every theme is WCAG AA including the dimmest text (`--text-dim`). **To add a theme:** add a `:root[data-theme="x"]` block in popup.css (plus the light `--green/--yellow/--red` if it is light), add `'x'` to the `THEMES` array in popup.js, and add a `.theme-swatch[data-theme="x"]` button in popup.html with its swatch color in popup.css.

## Typography

- One family: system sans (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`). No display/body pairing (product register).
- Fixed px scale (popup is fixed-width): numbers 21px/700 (count variant 16px), app name 13px/600, card title 12px/600, body 13px, labels and reset rows 11–11.5px, version and badge 9.5–10px.
- `font-variant-numeric: tabular-nums` on every numeric readout (% values, counts, reset times, version) so digits don't shift on refresh.
- Card titles are sentence/title case. No all-caps tracked eyebrow.

## Components

- **Card**: `--bg-1` surface, 1px `--border`, 12px radius, 13×14 padding. No hover state (cards are not interactive). One card per usage bucket.
- **Compact card** (`.card.compact`): the weekly sub-caps (Opus / Sonnet / Design) and routine runs collapse to a dense ~40px row (smaller value, 4px bar, reset row hidden) so the full set fits the popup under Chrome's ~600px height cap without scrolling. Session and Weekly stay full-size as the primary metrics; the sub-caps' reset is redundant with Weekly (they share the weekly window) and routine's title already says "Daily".
- **Progress bar**: 6px `--bg-3` track, pill radius, semantic fill, `width` transition 0.35s. (Animating `width` is the idiomatic exception to the no-layout-animation rule: the fill is the only child of an `overflow:hidden` track, so no sibling reflow, and it animates only on refresh. `scaleX` was rejected because it distorts the rounded cap.)
- **Controls** (select / refresh / view buttons): `--bg-2` + `--border-lt`; hover `--bg-3` + clay border + `--text-pri`.
- **Options menu** (the header's Display options popover): `--bg-2`; the selected item's checkbox is filled clay; "no usage" items dim to `--text-sec` / `--text-dim`.
- **Badges & tinted banners** (plan badge, extra credits, pro teaser): flat clay tint `rgba(217,119,87,0.08–0.16)` plus a matching border. No gradients.
- **Stale / auth banner**: amber tint (a warning), not clay.
- **Primary button** (empty state): clay fill + `--accent-ink` text.
- **Focus**: `:focus-visible` 2px `--accent-bright` outline on every interactive control.

## Layout

Fixed 320px width. Vertical stack: header (chrome) → banners → cards → footer (chrome). Header and footer sit on `--bg-1` as the second neutral layer; content sits on `--bg-0`.

## Motion

- Transitions 120–350ms, ease-out (`cubic-bezier(0.2,0.7,0.2,1)`). Motion conveys state only: hover, selection, bar fill, refresh spin.
- `prefers-reduced-motion: reduce` collapses all animation and transition to ~0.

## Accessibility

WCAG AA contrast on all text (verified in-browser). Color is never the only signal: a number and a bar width accompany every color-coded value. Keyboard focus is always visible.
