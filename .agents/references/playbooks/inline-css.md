---
issue_type: inline-css
applicable_flavors: [eds, cs]
risk_tier: low

required_validation:
  - inline_style_block_exists
  - rules_already_in_stylesheet
  - markup_source_in_repo

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"stylesheet"\s+[^>]*media\s*=\s*"print"\s+[^>]*onload\s*=\s*"this\.media'
    reason: "The media='print' onload swap hack breaks accessibility and print stylesheets — use a proper async stylesheet pattern, or rely on bundling.md + unused-code.md to keep the sheet small enough that it's not blocking"
  - pattern: '<style[^>]*>\s*@import\s+url'
    reason: "Don't @import inside an inline <style> — @import blocks rendering until the imported sheet loads"
  # NOTE: critical-CSS extraction tooling (Critters, Penthouse, Beasties) is
  # NOT regex-banned because it operates at build time, not in the patch diff.
  # See the "Critical-CSS extraction & inlining" anti-pattern for the prose
  # rule and the recommended bundling.md + unused-code.md path instead.

see_also:
  - playbook: bundling
    edge: prefer_instead
    reason: "when the signal is 'render-blocking CSS too large', split the bundle instead of inlining critical CSS"
  - playbook: unused-code
    edge: complements
    reason: "drop unused CSS rules alongside bundling for cumulative savings"
  - playbook: blocking-resource
    edge: complements
    reason: "broader render-blocking fix (JS as well as CSS); shares the media=print ban"
---

# Inline CSS

> **Risk tier:** low · **Applies to:** EDS, CS (recommend-only on AMS — broken critical-CSS pipeline is too variable to auto-fix) · **CWV metric:** LCP, FCP

## What this addresses

Two directions historically lived under "inline CSS" — only **one** is auto-fixable:

1. **✅ Removing redundant inline `<style>` / `style="…"`** when the same rules already exist in a stylesheet. Clean removal, no tooling needed, low risk. **This is what this playbook auto-fixes.**

2. **❌ Extracting and inlining "critical CSS"** as a perf optimization. Historically the canonical fix; **now generally an anti-pattern** for autofix, because:
   - It requires a build-time extraction tool (Critters, Penthouse, Beasties) — fragile pipeline.
   - The extracted CSS goes stale on virtually every above-fold content change — high maintenance churn.
   - It needs CSP coordination (`'unsafe-inline'` or per-page nonce injection) — easy to break.
   - With proper [`bundling.md`](./bundling.md) + [`unused-code.md`](./unused-code.md), a minimal `<link rel="stylesheet">` in `<head>` is small enough that the request doesn't gate LCP — the inlining win evaporates.

When the audit signal is "render-blocking CSS too large", the right fix path is **not** to inline it — it's to shrink it via [`bundling.md`](./bundling.md) and [`unused-code.md`](./unused-code.md). This playbook only auto-fixes the redundant-inline removal direction.

## When to apply / when to skip

**Apply when:**
- An inline `<style>` block or `style="…"` attribute exists in the markup
- The rules in it are already covered (or trivially could be) by an existing stylesheet — i.e., removal is a clean swap
- The markup source is in this repo (HTL / JSP / project JS that emits `<style>` blocks)

**Skip when:**
- The audit signal is actually "render-blocking CSS too large" — the fix path is [`bundling.md`](./bundling.md) (split the bundle) and [`unused-code.md`](./unused-code.md) (drop unused rules), not critical-CSS inlining
- The inline rules are unique to this page / component and don't (and shouldn't) belong in a global stylesheet — leave them alone
- (AMS) Inline-CSS bloat is a symptom of a broken critical-CSS pipeline upstream — investigate the build, don't auto-fix the symptom

## Recommended approaches

### Remove redundant inline `style="…"` attributes

```html
<!-- Before: redundant inline -->
<div style="color: red; font-size: 14px;">Foo</div>

<!-- After: rely on the stylesheet -->
<div class="alert">Foo</div>
```

```css
/* In the stylesheet */
.alert { color: red; font-size: 14px; }
```

The class-based approach is cacheable across pages, doesn't need CSP `'unsafe-inline'` for styles, and centralizes the styling for design-system consistency.

### Remove redundant inline `<style>` blocks

```html
<!-- Before -->
<style>
  .hero { background: #f5f5f5; padding: 2rem; }
  .hero h1 { font-size: 2.5rem; }
</style>
<section class="hero">…</section>

<!-- After: same rules live in the stylesheet, inline block deleted -->
<section class="hero">…</section>
```

```css
/* In the stylesheet (already exists or moved here from inline) */
.hero { background: #f5f5f5; padding: 2rem; }
.hero h1 { font-size: 2.5rem; }
```

When the inline block duplicates rules already in a stylesheet, delete the block. When the rules are unique-to-page but small, *keep* the inline block (a single block-scoped `<style>` adjacent to its markup is fine — it's not the inline-CSS anti-pattern).

## Anti-patterns

### Critical-CSS extraction & inlining

```html
<!-- Bad — even though this used to be the canonical perf advice -->
<head>
  <style>
    /* 12KB of "above-fold" CSS extracted at build time by Critters/Penthouse */
    body { font: 16px/1.5 system-ui; margin: 0; }
    .hero { background: #f5f5f5; padding: 2rem; }
    /* … */
  </style>
  <link rel="preload" href="/styles/main.css" as="style" onload="this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="/styles/main.css"></noscript>
</head>
```

**Why this is bad:** the extraction tool needs to identify above-fold selectors per page; it's wrong on dynamic content, becomes stale every time the design or content changes, requires CSP coordination, and (with proper bundling + unused-code) the LCP gain over a normal `<link rel="stylesheet">` is marginal. The maintenance cost reliably outweighs the perf win.

**Use instead:** [`bundling.md`](./bundling.md) to split route-specific CSS off the global bundle, and [`unused-code.md`](./unused-code.md) to drop rules nothing on the page actually uses. A minimal stylesheet (~5–15KB) loaded via `<link rel="stylesheet">` in `<head>` doesn't gate LCP on warm caches and degrades gracefully on cold ones.

### `media="print"` onload swap

```html
<!-- Bad -->
<link rel="stylesheet" href="/styles/main.css" media="print" onload="this.media='all'">
```

**Why this is bad:** the browser-historic hack to make CSS non-blocking. It breaks screen-reader announcement of the stylesheet load, breaks legitimate print stylesheets, requires inline JS (CSP issues), and the onload trick is unreliable across browsers. See [`blocking-resource.md`](./blocking-resource.md) for the same ban from the deferral angle. If the stylesheet is genuinely too heavy to load synchronously, **shrink it** via bundling/unused-code rather than reaching for this hack.

### `@import` inside inline `<style>`

```html
<!-- Bad -->
<style>
  @import url('/styles/critical.css');
  body { background: white; }
</style>
```

**Why this is bad:** `@import` is render-blocking — the browser must fetch the imported sheet before applying any of the inline rules. Defeats the point of inlining. If you've decided to inline (against the recommendation above), inline the actual CSS, not an import to it.

## Related playbooks

- [`bundling.md`](./bundling.md) — **the actually-correct fix** when the audit complains about render-blocking CSS volume. Splits route-specific CSS off the global bundle.
- [`unused-code.md`](./unused-code.md) — drops CSS rules nothing on the page uses. Pair with `bundling.md` for cumulative savings.
- [`blocking-resource.md`](./blocking-resource.md) — broader render-blocking fix (covers JS as well as CSS); shares the `media="print"` ban.

## Flavor-specific notes

### EDS

Inline `<style>` blocks in EDS typically appear in block JS (a block constructs and appends a `<style>` element). The "remove redundant" fix is straightforward: confirm the rules are in the project's stylesheet (`styles/styles.css` or block-specific), then delete the JS that injects the block-scope `<style>`.

### CS

HTL templates can include inline `<style>` blocks; clientlib CSS files are the canonical home for shared rules. The fix is moving the rules into the appropriate clientlib category and deleting the HTL inline block.
