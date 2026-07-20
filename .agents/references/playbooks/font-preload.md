---
issue_type: font-preload
applicable_flavors: [eds, cs, ams]
risk_tier: medium

required_validation:
  - same_font_uses_font_display_optional   # PRIMARY GATE — preload is only justified when the @font-face being preloaded uses font-display: optional. Absent this, font-fallback.md (font-display: swap + size-adjusted fallback) is the better fix.
  - font_url_is_stable
  - crossorigin_matches_font_face
  - single_clear_injection_point

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*as\s*=\s*"font"(?![^>]*crossorigin)'
    reason: "Font preload requires crossorigin (matching @font-face crossorigin), or the browser opens a second connection and double-fetches"
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*as\s*=\s*"font"[^>]*href\s*=\s*"[^"]*[?&]v='
    reason: "Don't preload fonts with cache-busted query strings — the static href silently breaks on the next build"

see_also:
  - playbook: font-fallback
    edge: prefer_instead
    reason: "font-display: swap + size-adjusted fallback supersedes preload for the common case; only reach for preload when font-display: optional is in play"
  - playbook: font-format
    edge: orthogonal
    reason: "TTF/EOT/OTF → WOFF2 is a file-format concern, independent of preload"
---

# Font preload

> **Risk tier:** medium · **Applies to:** EDS, CS, AMS · **CWV metric:** LCP, FCP
>
> ⚠️ **For most sites, [`font-fallback.md`](./font-fallback.md) is the right fix, not this one.** Preload is the *narrow* follow-up technique for sites using `font-display: optional` (where it's strictly required) or — outside autofix scope — for human-flagged display / brand-critical fonts. See "When to apply" below.

## What this addresses

Historically, preload was the canonical fix for FOIT and the swap-time CLS that web fonts cause. **That story is now superseded by [`font-fallback.md`](./font-fallback.md)** for the common case: `font-display: swap` eliminates FOIT, and a size-adjusted fallback `@font-face` eliminates the residual swap-time CLS — without consuming preload bandwidth that competes with the LCP image.

Preload still has a real, narrow role in one deterministic case the autofix agent should handle:

- **`font-display: optional` sites** — `optional` *skips* the swap entirely if the font isn't already loaded by the browser's cutoff (~100ms after first paint). Without preload, most users on slow connections never get the brand font in their session and live in the fallback for the entire visit. **Preload is what makes `optional` actually deliver.** This is the auto-fixable case.

Two further cases also benefit from preload but are **out of scope for autofix** because they're opinionated human decisions, not deterministic signals:

- **Display / branded typography** where the letterform identity *is* the brand (editorial, luxury, magazine sites). Size-adjust matches metrics, not glyph shapes — users still see Arial-shaped letters in the brand serif's slot until the swap. For body text that's fine; for a hero headline in a custom display face, the visual identity matters and the swap is jarring even with matched metrics.
- **Branded glyph coverage gaps** — custom ligatures, branded ampersands, icon glyphs delivered through the brand font. Fallback fonts don't have these, so the *content* changes mid-swap.

For both of these, the fix path is human review + manual preload addition, not an autofix patch.

## When to apply / when to skip

**Apply when (all required):**
- The `@font-face` being preloaded uses **`font-display: optional`** (the primary gate — without this, prefer [`font-fallback.md`](./font-fallback.md))
- Font URL is stable across deploys (not hash-busted)
- A single clear global injection point exists in the page head
- `crossorigin` value on the `@font-face` is known so the preload can match
- ≤2 fonts total being preloaded

**Skip when:**
- The `@font-face` uses `font-display: swap` or no `font-display` at all → use [`font-fallback.md`](./font-fallback.md) instead. Preloading on top of a size-adjusted fallback steals bandwidth from the LCP image without measurable benefit.
- Font URL is hash-busted (e.g. `font.woff2?v={buildHash}`) — preload href silently breaks each deploy
- Font is non-critical (used only below fold or for rare glyphs)
- More than 2 fonts being considered for preload (preload bandwidth cost outweighs benefit)
- CSP doesn't allow the preload origin
- The case is "this is a brand display font" — that's a human design call, not an autofix decision; surface it as a recommendation, do not emit a patch

## Recommended approaches

### Single critical font, self-hosted, with crossorigin

```html
<!-- Good — self-hosted -->
<link rel="preload"
      href="/fonts/brand-regular.woff2"
      as="font"
      type="font/woff2"
      crossorigin>
```

The `crossorigin` attribute (no value, equivalent to `crossorigin="anonymous"`) is required for fonts even when self-hosted, because the CSS Fonts spec mandates fonts be fetched with CORS. Omit it and the browser opens a second connection for the actual font request, defeating the preload.

### Cross-origin font (e.g., from a CDN you control)

```html
<!-- Good — cross-origin -->
<link rel="preload"
      href="https://cdn.example.com/fonts/brand-regular.woff2"
      as="font"
      type="font/woff2"
      crossorigin="anonymous">
```

The `crossorigin` value must match the `@font-face` declaration's `crossorigin` (typically `anonymous`). Mismatch → double fetch.

## Anti-patterns

### Missing `crossorigin` attribute

```html
<!-- Bad -->
<link rel="preload" href="/fonts/brand-regular.woff2" as="font" type="font/woff2">
```

**Why this is bad:** The browser issues the preload without CORS. When CSS later requests the same font (with CORS, because that's what the Fonts spec mandates), the responses don't match — the preload is wasted and a second request fires. Net result: same time-to-first-byte as no preload, plus extra connection cost.

### Preloading a hash-busted URL

```html
<!-- Bad -->
<link rel="preload" href="/fonts/brand-regular.woff2?v=a1b2c3" as="font" crossorigin>
```

**Why this is bad:** Once the build hash changes, the static `href` no longer matches the URL that CSS actually requests, so the preload misses entirely and silently. Confirm font URLs are stable (no query-string cache busting) before preloading.

### Preloading too many fonts

```html
<!-- Bad — preloading 5 fonts -->
<link rel="preload" href="/fonts/brand-regular.woff2" as="font" crossorigin>
<link rel="preload" href="/fonts/brand-bold.woff2" as="font" crossorigin>
<link rel="preload" href="/fonts/brand-italic.woff2" as="font" crossorigin>
<link rel="preload" href="/fonts/brand-bold-italic.woff2" as="font" crossorigin>
<link rel="preload" href="/fonts/brand-light.woff2" as="font" crossorigin>
```

**Why this is bad:** Preload bandwidth competes with CSS / JS / LCP image. Above ~2 fonts, the cost outweighs the benefit. Preload only the one or two faces actually used above the fold.

### Preloading webfonts as a default fix for FOIT/CLS

```html
<!-- Bad — preload added because "fonts are slow", with no font-display: optional in play -->
<link rel="preload" href="/fonts/brand-regular.woff2" as="font" type="font/woff2" crossorigin>
<!-- ... and meanwhile @font-face has font-display: swap and no size-adjusted fallback -->
```

**Why this is bad:** historically preload was *the* answer to FOIT and font-swap CLS. With [`font-fallback.md`](./font-fallback.md) in the toolbox (`font-display: swap` + size-adjusted fallback), most sites get a better outcome at zero bandwidth cost — the fallback renders immediately with the right metrics, and the eventual swap is visually invisible. Preloading on top of a working font-fallback setup steals bandwidth from the LCP image without measurable benefit. **Apply font-fallback first; only reach for preload when `font-display: optional` is actively in use.**

### Preloading a font that uses `font-display: swap`

```html
<!-- Bad — the swap path doesn't need preload -->
<link rel="preload" href="/fonts/brand-regular.woff2" as="font" crossorigin>
<style>
  @font-face {
    font-family: 'Brand';
    src: url('/fonts/brand-regular.woff2') format('woff2');
    font-display: swap;          /* swap doesn't need preload — fallback handles the gap */
  }
</style>
```

**Why this is bad:** `font-display: swap` already eliminates FOIT (fallback renders immediately) and pairs cleanly with a size-adjusted `@font-face` to eliminate swap CLS. Adding preload to that setup costs bandwidth without removing user-visible delay — the fallback was already covering the gap. The deterministic precondition for font preload is `font-display: optional`, *not* `font-display: swap`.

## Flavor-specific notes

### EDS

Inject in the project's `head.html`. EDS's fixed-head model is actually well-suited to font preloads because fonts don't vary per page — the same body font is critical site-wide. Verify the font URL doesn't include a build hash (EDS typically serves static fonts from the codebase or DA without hashing).

### CS

Inject in `customheaderlibs.html` or the global page head HTL. Verify the file is not overridden per page template — if it is, the preload only fires on templates that inherit the override.

### AMS

Inject in the global header HTL or the equivalent JSP page template. Same per-template-override caveat as CS.

## Related playbooks

- [`font-fallback.md`](./font-fallback.md) — **the default fix for FOIT/CLS on most sites.** `font-display: swap` + size-adjusted fallback. Apply first; only reach for this playbook when `font-display: optional` is in play.
- [`font-format.md`](./font-format.md) — TTF/EOT/OTF → WOFF2 (file-format concern).
- [`layout-shift.md`](./layout-shift.md) — CLS symptom view; routes to font-fallback (not here) for font-swap CLS.
