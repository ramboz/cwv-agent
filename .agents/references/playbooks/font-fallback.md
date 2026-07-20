---
issue_type: font-fallback
risk_tier: low

required_validation:
  - font_face_declarations_inventoried
  - custom_fonts_distinguished_from_system
  - per_font_fix_independently_assessed
  - font_metric_data_available    # only required for the size-adjust fix
  - css_source_in_repo

forbidden_techniques:
  - pattern: 'font-display:\s*block\b'
    reason: "font-display: block extends FOIT to ~3s; if the LCP element is text this directly delays LCP. Use 'swap' or 'optional'"
  # NOTE: font-display: optional is intentionally NOT banned. It's stricter than
  # 'swap' (drops the swap entirely if the font isn't already loaded fast enough,
  # eliminating CLS from swap at the cost of fallback-only rendering for slow
  # connections). Sometimes the right call; design-tolerance dependent.

see_also:
  - playbook: font-format
    edge: orthogonal
    reason: "TTF/EOT/OTF → WOFF2 is a file-format concern, independent of the swap-time fix"
  - playbook: font-preload
    edge: complements
    reason: "narrow follow-up for sites using font-display: optional — preload keeps the swap window short on top of the fallback"
---

# Font fallback

> **Risk tier:** low · **CWV metric:** CLS, LCP

## What this addresses

Custom fonts ship over the network. While they're loading, the browser needs a fallback strategy:

- **Without `font-display`** browsers default to `block` — text is invisible (FOIT) for ~3 s before falling back. If the LCP element is a heading, this directly delays LCP by up to 3 s.
- **With `font-display: swap`** the fallback shows immediately and swaps to the web font once loaded. FOIT is eliminated, but the swap itself usually causes CLS — fallback glyph widths differ from the web font, so paragraphs reflow on swap.
- **With a size-adjusted fallback** that matches the web font's metrics, the swap is visually invisible — eliminates both FOIT and the residual CLS.

This playbook covers **three independent fixes** per custom font, with **three independent gates**. The first two are universally safe; the third is conditional on metric data being available.

## When to apply / when to skip

**Apply when (any of):**
- One or more custom fonts use the default `block` value of `font-display` (or no `font-display` at all)
- One or more `font-family` declarations are missing a web-safe fallback before the generic family
- Font metric data is available for one or more custom fonts and no size-adjusted fallback exists yet

**Skip when:**
- All custom fonts already have `font-display: swap` (or `optional`) AND have web-safe fallbacks AND have size-adjusted fallbacks — nothing to do
- The CSS containing the `@font-face` declarations isn't in this repo (third-party-hosted font service that emits its own CSS — the fix path is on the vendor side)
- The site uses *only* system fonts (no `@font-face` declarations) — no fallback is needed

## Recommended approaches

The three fixes are independent — emit each one whose precondition is met, regardless of the others. A patch that adds `font-display: swap` and a web-safe fallback but skips size-adjust (because metric data isn't available) is a valid partial fix; ship it.

### Fix 1: Add `font-display: swap` to every custom `@font-face`

```css
/* Good */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

**Precondition:** any custom `@font-face` without an explicit `font-display` value.
**Risk:** none. `swap` is the universally safe default — text renders immediately, swaps to the web font when loaded.

### Fix 2: Add a web-safe fallback to the `font-family` stack

```css
/* Good — every text-applying rule lists a specific web-safe fallback */
body      { font-family: 'Brand',      Arial,         system-ui,           sans-serif; }
h1, h2    { font-family: 'BrandSerif', Georgia,      'Times New Roman',    serif;      }
code, pre { font-family: 'BrandMono',  ui-monospace, 'Cascadia Code',      monospace;  }
```

**Precondition:** any `font-family` rule whose stack ends with only a generic family (`serif`, `sans-serif`, `monospace`) and no specific web-safe font in between.
**Risk:** none. The web-safe font (Arial, Georgia, ui-monospace, etc.) renders during the swap window before the web font loads.

Without a specific fallback, browsers resolve `sans-serif` differently per OS — Arial on Windows, Helvetica Neue on macOS, Roboto on Android. The same page swaps to wildly different fallback typography, with corresponding visual instability.

### Fix 3: Add a size-adjusted fallback `@font-face`

When font metric data is available — the web font's actual `ascent`, `descent`, `line-gap`, and average glyph width — define a fallback `@font-face` whose metric overrides match the web font. The swap then becomes visually invisible.

```css
/* Good — fallback whose metrics match 'Brand' */
@font-face {
  font-family: 'Brand-Fallback';
  src: local('Arial');
  size-adjust: 96.5%;          /* glyphs fill the same horizontal space as 'Brand' */
  ascent-override: 90%;
  descent-override: 22%;
  line-gap-override: 0%;
}

body { font-family: 'Brand', 'Brand-Fallback', Arial, sans-serif; }
```

**Precondition:** font metric data is available — either from a font-fallback generator, [meowni.ca/font-style-matcher](https://meowni.ca/font-style-matcher/), or by reading the webfont's metrics directly.
**Risk:** medium if the metric values are wrong — the swap then *creates* a different CLS instead of eliminating one. Always use a generator; never hand-tune.

This is the only conditional fix. Skip if metric data isn't available — fixes 1 and 2 alone still eliminate FOIT and stabilize the swap target across platforms.

## Anti-patterns

### `font-display: block`

```css
/* Bad */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff2') format('woff2');
  font-display: block;
}
```

**Why this is bad:** `block` extends FOIT to ~3 s. If the LCP element is a heading, this delays LCP by the full FOIT duration. Always use `swap` or `optional`.

### Fallback stack ending in `serif` / `sans-serif` only

```css
/* Bad — generic family is the only fallback */
body { font-family: 'Brand', sans-serif; }
```

**Why this is bad:** `sans-serif` resolves differently on every OS, so the same page swaps to a different fallback per platform. Insert a specific web-safe font (Arial, ui-sans-serif) before the generic.

### Size-adjusting with guessed values

```css
/* Bad — guessed values */
@font-face {
  font-family: 'Brand-Fallback';
  src: local('Arial');
  size-adjust: 100%;       /* guess */
  ascent-override: 90%;    /* guess */
}
```

**Why this is bad:** wrong metric values produce a *different* CLS at swap time — the layout shift is just shifted to a different moment, not eliminated. Always use a generator that reads the actual webfont metrics. Skip the size-adjust fix entirely if metric data isn't available; fixes 1 and 2 are still worth shipping on their own.

### Adding `font-display` to a `local()`-only `@font-face`

```css
/* Bad — font-display is meaningless when src is purely local */
@font-face {
  font-family: 'Brand-Fallback';
  src: local('Arial');
  font-display: swap;
}
```

**Why this is bad:** `font-display` controls behavior while a remote font is loading. A `@font-face` whose `src` is `local()`-only never has a loading window — `font-display` has no effect. Don't waste a line on it; don't let it confuse readers into thinking the fallback uses `font-display`.

## Related playbooks

- [`layout-shift.md`](./layout-shift.md) — CLS symptom view; routes to this playbook when the shifting element is text mid font-swap.
- [`font-format.md`](./font-format.md) — TTF/EOT/OTF → WOFF2 (file-format concern).
- [`font-preload.md`](./font-preload.md) — *narrow follow-up* for sites using `font-display: optional`. With `font-display: swap` + size-adjusted fallback (this playbook), preload is **not** needed for the common case — preload competes with LCP-image bandwidth without measurable benefit. Reach for `font-preload.md` only when `optional` is in play, or when a human has flagged a display/branded font as worth the trade.
