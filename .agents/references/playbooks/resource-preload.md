---
issue_type: resource-preload
risk_tier: medium

required_validation:
  - as_attribute_correct_for_resource_type
  - crossorigin_if_cross_origin
  - resource_url_is_stable
  - resource_on_critical_render_path

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*as\s*=\s*"image"'
    reason: "For LCP image preload, use the lcp-image playbook instead — this playbook covers non-image critical resources only"
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*as\s*=\s*"font"'
    reason: "For font preload, use the font-preload playbook instead — it has the additional crossorigin and stability rules"
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*href\s*=\s*"[^"]*[?&](?:v=|hash=|t=)'
    reason: "Don't preload cache-busted URLs — the static href silently breaks on the next build"

see_also:
  - playbook: lcp-image
    edge: prefer_instead
    reason: "for the LCP image, use lcp-image (prefer fetchpriority=high on the <img> over rel=preload)"
  - playbook: font-preload
    edge: prefer_instead
    reason: "for fonts, use font-preload — it has the additional crossorigin and stability rules"
  - playbook: resource-hints
    edge: complements
    reason: "when the preload target is cross-origin, pair with a preconnect to that origin (subject to the LCP-critical-chain gate)"
  - playbook: request-chain
    edge: complements
    reason: "the diagnostic context for when to reach for preload — request-chain identifies which 1-2 LCP-blocking links to preload"
---

# Resource preload (non-font, non-image)

> **Risk tier:** medium · **CWV metric:** LCP, FCP

## What this addresses

Critical CSS, JS, or fetch resources that the browser only discovers after parsing HTML deep into the document arrive late. `<link rel="preload">` lets the browser fetch them in parallel with the HTML parse, shortening time-to-interactive and improving LCP when the resource is on the critical render path.

For images, see [`lcp-image.md`](./lcp-image.md). For fonts, see [`font-preload.md`](./font-preload.md). This playbook is for **other** critical resources (scripts, stylesheets, JSON config fetched before paint, etc.).

## When to apply / when to skip

**Apply when:**
- Lighthouse "critical request chains" identifies the resource as on the critical path
- Resource URL is stable across deploys (not hash-busted)
- The `as=` value can be set correctly for the resource type
- Resource is referenced late in the document (preloading a resource referenced in `<head>` directly does nothing — the browser already discovered it)

**Skip when:**
- URL is hash-busted (`/main.{hash}.js`) — preload href silently breaks each deploy
- Resource is not actually critical (preload steals bandwidth from things that are)
- An optimization at the source (inlining the CSS, deferring the script) is more appropriate

## Recommended approaches

### Preload critical CSS

```html
<!-- Good -->
<link rel="preload" href="/styles/critical.css" as="style">
<link rel="stylesheet" href="/styles/critical.css">
```

The preload starts the fetch early; the stylesheet link applies the styles. Both are needed — preload alone doesn't apply the CSS.

### Preload critical JS module

```html
<!-- Good -->
<link rel="preload" href="/scripts/critical.js" as="script">
```

Use when a `<script src="...">` reference is far down in the body and the browser would otherwise discover it late.

### Preload cross-origin resource (with crossorigin)

```html
<!-- Good -->
<link rel="preload" href="https://api.example.com/critical-data.json" as="fetch" crossorigin>
```

`as="fetch"` covers `fetch()` requests for data needed before paint. `crossorigin` is required for any cross-origin preload, regardless of the `as` value.

## Anti-patterns

### Wrong `as=` value

```html
<!-- Bad -->
<link rel="preload" href="/main.css" as="script">
```

**Why this is bad:** When the actual resource is requested, the browser sees a different `as` and treats the preload as unmatched — fetches a second time. The resource is downloaded twice and the preload is wasted.

### Cross-origin preload without `crossorigin`

```html
<!-- Bad -->
<link rel="preload" href="https://cdn.example.com/main.js" as="script">
```

**Why this is bad:** Same as font preload — without `crossorigin`, the actual fetch (which is CORS-enabled by default for `<script type="module">` and explicit `fetch()`) opens a second connection.

### Preloading hash-busted URLs

```html
<!-- Bad -->
<link rel="preload" href="/main.a1b2c3.js" as="script">
```

**Why this is bad:** Next build, the file is `/main.d4e5f6.js`. The preload misses, the actual resource is fetched normally, and the preload `<link>` triggers a 404 in the browser console. Preload only stable URLs (or generate the preload `href` from the same build manifest as the script tag).

### Preloading non-critical resources

```html
<!-- Bad -->
<link rel="preload" href="/scripts/footer-newsletter-form.js" as="script">
```

**Why this is bad:** A footer newsletter widget isn't on the critical render path. Preloading it consumes bandwidth that should go to LCP-blocking resources, and may actively delay LCP.

## Related playbooks

- [`request-chain.md`](./request-chain.md) — **the diagnostic context for when to reach for preload.** When Lighthouse identifies a deep critical-request chain feeding the LCP element, request-chain.md walks through identifying the 1–2 LCP-blocking links to preload; the actual preload mechanics (this playbook) then take over.
- [`resource-hints.md`](./resource-hints.md) — when the preload target is on a cross-origin host, pair with a preconnect to that origin (subject to the LCP-critical-chain gate).
- [`lcp-image.md`](./lcp-image.md) — for LCP image preload, use that playbook (which has stricter rules: prefer `fetchpriority="high"` on the `<img>` tag over preload).
- [`font-preload.md`](./font-preload.md) — for font preload (different `as=` value, different `crossorigin` rules, narrow `font-display: optional` gate).
