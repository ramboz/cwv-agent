---
issue_type: blocking-resource
applicable_flavors: [eds, cs, ams]
risk_tier: medium

required_validation:
  - no_synchronous_dependents
  - no_above_fold_selectors_in_css
  - clientlib_dependency_graph_clear

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"stylesheet"\s+[^>]*media\s*=\s*"print"\s+[^>]*onload\s*=\s*"this\.media'
    reason: "The media='print' onload swap hack breaks accessibility tools and print stylesheets — use real critical CSS inlining instead"
  - pattern: '<script\s+[^>]*async[^>]*src\s*=\s*"[^"]*"></script>\s*<script[^>]*>\s*\w+\.\w+\('
    reason: "Don't async a script when an inline script later calls into it — async runs out of order with inline scripts"

flavor_overrides:
  cs:
    extra_validation:
      - clientlib_no_embedded_dependents
  ams:
    extra_validation:
      - clientlib_no_embedded_dependents
---

# Blocking resources

> **Risk tier:** medium · **Applies to:** EDS, CS, AMS · **CWV metric:** LCP, FCP

## What this addresses

Render-blocking CSS and synchronous JS in the document head delay first paint. The browser must download, parse, and execute them before showing anything. `defer` / `async` on scripts and either splitting or removing non-critical CSS unblocks rendering.

## When to apply / when to skip

**Apply when:**
- A `<script>` in `<head>` has no `defer` / `async` and no later inline script depends on it synchronously
- A stylesheet is large but has no above-the-fold selectors (Lighthouse coverage data confirms)
- (CS/AMS) The clientlib dependency graph confirms no other clientlib `embeds` or depends on this one

**Skip when:**
- An inline `<script>` later in the document calls a function from the scripted resource (deferring breaks it)
- The CSS contains above-the-fold selectors (deferring causes flash of unstyled content)
- (CS/AMS) The clientlib is `embed`ded by other clientlibs (deferring breaks dependents silently)

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

In CS/AMS clientlibs, deferring `clientlib-foo.js` when `clientlib-bar` lists `foo` in its `dependencies` (or `embed`s it) silently breaks `bar` — `bar` initializes before `foo` is loaded. **Always trace the clientlib dependency graph before adding `defer`.**

## Flavor-specific notes

### EDS

Block scripts and CSS are self-contained modules. A static dependency trace (which inline scripts call into the deferred external script?) is statically parseable. Lower blast radius than clientlib edits.

**The render-blocking budget is governed by `scripts/scripts.js`'s three loading phases** — knowing which phase a resource lives in is the most important fact for EDS render-blocking work:

| Phase | When | What belongs here |
|---|---|---|
| `loadEager()` | before DOMContentLoaded, sync | LCP block decoration, critical CSS, hero priority hints — **critical path, keep minimal** |
| `loadLazy()` | at DOMContentLoaded | non-critical block decoration, below-fold images, `lazy-styles.css` |
| `loadDelayed()` | ~3s after `load` | analytics, martech, chat — everything non-UI |

Anything in `loadEager` is on the critical path to LCP; the default move when something render-blocking shows up is **"does this belong in `loadEager`, or can it move to `loadLazy`?"** CSS is split by file, not by an extraction pass: `styles/styles.css` is render-blocking in `<head>` (keep under ~10KB — above-fold-critical rules only); `styles/lazy-styles.css` loads in `loadLazy()` (fine to be large). Block CSS (`/blocks/<name>/<name>.css`) loads with its block's decoration phase.

### CS / AMS

Parse all clientlib `.content.xml` files to build the `categories` × `dependencies` × `embed` graph. Safe deferral candidates are categories with no synchronous dependents AND no `embedded-by` relationships. **Deferring an embedded clientlib silently breaks the embedder.**
