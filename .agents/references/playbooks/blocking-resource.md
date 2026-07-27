---
issue_type: blocking-resource
risk_tier: medium

required_validation:
  - no_synchronous_dependents
  - no_above_fold_selectors_in_css
  - bundle_dependency_graph_clear

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"stylesheet"\s+[^>]*media\s*=\s*"print"\s+[^>]*onload\s*=\s*"this\.media'
    reason: "The media='print' onload swap hack breaks accessibility tools and print stylesheets — use real critical CSS inlining instead"
  - pattern: '<script\s+[^>]*async[^>]*src\s*=\s*"[^"]*"></script>\s*<script[^>]*>\s*\w+\.\w+\('
    reason: "Don't async a script when an inline script later calls into it — async runs out of order with inline scripts"

---

# Blocking resources

> **Risk tier:** medium · **CWV metric:** LCP, FCP

## What this addresses

Render-blocking CSS and synchronous JS in the document head delay first paint. The browser must download, parse, and execute them before showing anything. `defer` / `async` on scripts and either splitting or removing non-critical CSS unblocks rendering.

## When to apply / when to skip

**Apply when:**
- A `<script>` in `<head>` has no `defer` / `async` and no later inline script depends on it synchronously
- A stylesheet is large but has no above-the-fold selectors (Lighthouse coverage data confirms)
- For build-time bundles, the dependency graph confirms no other bundle embeds or depends on this one

**Skip when:**
- An inline `<script>` later in the document calls a function from the scripted resource (deferring breaks it)
- The CSS contains above-the-fold selectors (deferring causes flash of unstyled content)
- The script is embedded by / a dependency of other bundles (deferring breaks dependents silently)

## Recommended approaches

### Defer non-critical scripts

```html
<!-- Good -->
<script defer src="/scripts/analytics.js"></script>
<script defer src="/scripts/footer-widget.js"></script>
```

`defer` runs after HTML parse completes but before `DOMContentLoaded`. Preserves execution order across multiple deferred scripts. Use this for any script that doesn't need to run during HTML parse.

### Async for independent scripts

```html
<!-- Good — independent script with no execution-order dependencies -->
<script async src="https://www.googletagmanager.com/gtag/js?id=..."></script>
```

`async` executes as soon as the script downloads (out of order). Use only for scripts that have no dependencies on each other or on inline page scripts.

### Move non-critical CSS to the bottom or load it separately

```html
<!-- Good — separate critical and non-critical -->
<link rel="stylesheet" href="/styles/critical.css">
<!-- ... above-fold content ... -->
<link rel="stylesheet" href="/styles/non-critical.css">
```

## Anti-patterns

### `media="print"` onload-swap hack

```html
<!-- Bad -->
<link rel="stylesheet" href="/styles/main.css" media="print" onload="this.media='all'">
```

**Why this is bad:** The browser-historic hack to make CSS non-blocking. It breaks screen-reader announcement of stylesheet load, breaks legitimate print stylesheets, requires inline JS (CSP issues), and the onload trick is unreliable across browsers. Use real critical-CSS inlining + deferred non-critical CSS instead.

### Async on a script with inline callers

```html
<!-- Bad -->
<script async src="/scripts/utils.js"></script>
<!-- ... -->
<script>utils.formatDate(new Date());</script>
```

**Why this is bad:** `async` runs the external script whenever it finishes downloading. The inline script may run before `utils.js` is available — `utils is not defined` error. Use `defer` (preserves order) or refactor the inline script.

### Defer on a script that other scripts call synchronously

When bundles carry build-time dependencies, deferring `foo.js` when `bar.js` depends on it (or embeds it) silently breaks `bar` — `bar` initializes before `foo` is loaded. **Always trace the bundle dependency graph before adding `defer`.**
