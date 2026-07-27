---
issue_type: font-format
risk_tier: medium

required_validation:
  - modern_format_version_exists      # WOFF2 preferred; WOFF acceptable when no WOFF2 is available
  - all_font_face_declarations_aggregated
  - self_hosted_vs_cdn_determined

forbidden_techniques:
  - pattern: '@font-face\s*\{[^}]*src:\s*url\([^)]+\.(?:ttf|eot|otf)\)\s+format'
    reason: "Don't use TTF/EOT/OTF as the primary src — modern browsers ship 30-50% smaller payloads with WOFF2 (or WOFF as a legacy fallback)"
  - pattern: 'src:\s*url\([^)]+\.woff\)\s+format\([''"]?woff[''"]?\)\s*,\s*url\([^)]+\.woff2\)'
    reason: "WOFF2 must come BEFORE WOFF in the src list — browsers pick the first matching format"

see_also:
  - playbook: font-fallback
    edge: orthogonal
    reason: "font-display: swap + size-adjusted fallback is the swap-time CLS fix, independent of the file-format concern"
  - playbook: resource-hints
    edge: orthogonal
    reason: "for CDN-served fonts, preconnect to the CDN origin (connection-setup-time fix) is the orthogonal concern"
---

# Font format

> **Risk tier:** medium · **CWV metric:** LCP, FCP

## What this addresses

TTF / EOT / OTF font files are 30–50% larger than WOFF2 for the same glyphs (and ~30% larger than WOFF). Switching the primary `@font-face` src to a modern compressed format reduces font transfer time and shortens the FOIT/FOUT window that delays text rendering (LCP if the LCP element is a heading). **WOFF2 is strongly preferred** (best compression, ~98% browser support); **WOFF is acceptable** when WOFF2 isn't available in the codebase.

## When to apply / when to skip

**Apply when:**
- Site has `@font-face` declarations using TTF / EOT / OTF as the primary `src`
- A modern format (WOFF2 preferred, WOFF acceptable) exists in the codebase for each font (grep for `.woff2` then `.woff`)
- All `@font-face` declarations across the site can be aggregated and updated together

**Skip when:**
- **Only TTF/EOT/OTF available, no WOFF or WOFF2 anywhere in the codebase** — converting requires font-conversion tooling (`fonttools`, `woff2_compress`) that's out of scope for the agent. Surface as a recommendation: "Generate WOFF2 versions of these fonts" — and re-run this playbook once they're added.
- **Fonts are CDN-served** (Google Fonts, Adobe Fonts, fonts.bunny.net) — the CDN already serves WOFF2 with format negotiation; format isn't actionable from this repo. The orthogonal concerns for CDN-served fonts are: (a) [`font-fallback.md`](./font-fallback.md) for `font-display: swap` + size-adjusted fallback (the swap-time CLS fix), and (b) [`resource-hints.md`](./resource-hints.md) for `preconnect` to the CDN origin (the connection-setup-time fix).
- **Partial coverage** — if you can't find every `@font-face` declaration for a family, partial updates cause cross-page rendering inconsistencies

## Recommended approaches

### WOFF2 primary, WOFF legacy fallback

```css
/* Good */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff2') format('woff2'),
       url('/fonts/brand.woff') format('woff');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

WOFF2 is supported by all modern browsers (~98% globally). WOFF as a legacy fallback covers very old browsers without bloating the modern path — the browser only downloads the first format it supports. `font-display: swap` ensures text remains visible during the swap.

### WOFF2 only (modern-only sites)

```css
/* Good — for sites with confirmed modern browser audience only */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff2') format('woff2');
  font-display: swap;
}
```

### WOFF only (when no WOFF2 is available)

```css
/* Acceptable — when only WOFF exists in the codebase, no WOFF2 */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff') format('woff');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

WOFF is ~30% smaller than TTF/EOT and supported by ~99% of browsers. Switching from TTF/EOT to WOFF is a meaningful improvement even without WOFF2 — ship it. Adding WOFF2 later requires font-conversion tooling (`fonttools`, `woff2_compress`); flag it as a follow-up to track separately, but don't block this fix on the WOFF2 generation.

When WOFF2 *does* later become available in the codebase, re-run the playbook — the recommended approach upgrades to WOFF2-primary-with-WOFF-legacy-fallback (see above).

## Anti-patterns

### TTF / EOT as primary src

```css
/* Bad */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.eot');
  src: url('/fonts/brand.eot?#iefix') format('embedded-opentype'),
       url('/fonts/brand.woff') format('woff'),
       url('/fonts/brand.ttf') format('truetype');
}
```

**Why this is bad:** The browser ships ~50% more bytes than necessary, and WOFF2 isn't even in the list. This is the legacy "bulletproof @font-face syntax" — replace it.

### WOFF before WOFF2 in src list

```css
/* Bad */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff') format('woff'),
       url('/fonts/brand.woff2') format('woff2');
}
```

**Why this is bad:** Browsers pick the first format from the `src` list they can render. WOFF support is universal, so the browser stops at WOFF and never reaches WOFF2 — the larger file ships every time. WOFF2 must come first.

### Partial updates across stylesheets

If `base/fonts.css` is updated to WOFF2 but another stylesheet still declares TTF for the same family, pages including both will load the family twice. Aggregate **all** `@font-face` blocks for the same family across the codebase before emitting the fix.
