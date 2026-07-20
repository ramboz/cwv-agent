---
issue_type: lcp-image
risk_tier: low

required_validation:
  - lcp_via_lighthouse_attribution
  - no_existing_fetchpriority
  - image_not_js_lazy_loaded

forbidden_techniques:
  - pattern: 'Link:\s*<[^>]*>;\s*rel\s*=\s*preload'
    reason: "HTTP Link header preload is not maintainable at site scale — use HTML attributes instead"
  - pattern: 'loading\s*=\s*"lazy"'
    reason: "Don't add loading=\"lazy\" to the LCP image — it negates the eager priority"
  - pattern: 'dynamicmedia/deliver/\S*[?&](?:wid|hei)='
    reason: "Image-CDN resize params are endpoint-specific — verify the param the endpoint actually honors. A wrong param returns the full-size original (zero bytes saved) and only changes the URL, which can regress LCP via a cold-cache origin fetch."
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*as\s*=\s*"image"'
    reason: "On stacks with a fixed shared head template, per-page image preload is not feasible (the LCP image varies per page)"

see_also:
  - playbook: image-sizing
    edge: complements
    reason: "keep width/height on the LCP <img> to also fix the CLS reservation"
  - playbook: layout-shift
    edge: complements
    reason: "render the consent-banner placeholder with reserved space so it's stable from first paint"
  - playbook: blocking-resource
    edge: routes_to
    reason: "when FCP == LCP the hero is render-blocked, not load-blocked — the real gate is the render-blocking critical path"
  - playbook: unused-code
    edge: routes_to
    reason: "split the render-blocking CSS monolith / scope oversized bundles when render-delay dominates LCP"
  - playbook: third-party
    edge: orthogonal
    reason: "consent-gating contract when the consent overlay is the LCP element — a separate martech concern"

---

# LCP image

> **Risk tier:** low · **CWV metric:** LCP

## What this addresses

The LCP element on most pages is a hero image. By default, browsers fetch images at lower priority than CSS/JS and may apply lazy-loading heuristics. `fetchpriority="high"` + `loading="eager"` tells the browser this image is the LCP element and should be requested with the highest priority, in parallel with critical resources.

## When to apply / when to skip

**Apply when:**
- Lighthouse element attribution identifies an `<img>` as the LCP element
- The image doesn't already have `fetchpriority` or `<link rel="preload">` targeting it
- The image is rendered in markup (not inserted by JS)

**Skip when:**
- LCP element is not an image (text, video, SVG background — different fix path)
- Image is JS-lazy-loaded (would require refactoring the loader, not just adding attributes)
- `fetchpriority="high"` is already set
- Lighthouse shows `elementRenderDelay` dominating the LCP breakdown with **FCP == LCP** — the hero is render-*blocked*, not load-blocked, so `fetchpriority` won't move it. The real gate is the render-blocking critical path — see [`blocking-resource.md`](./blocking-resource.md) and [`unused-code.md`](./unused-code.md)

## Recommended approaches

### HTML attributes on the `<img>` tag

```html
<!-- Good -->
<img src="hero.jpg"
     alt="Hero"
     fetchpriority="high"
     loading="eager"
     width="1200" height="800">
```

`fetchpriority="high"` raises the request priority. `loading="eager"` overrides any inherited or default lazy loading. Keep `width` / `height` to also fix the CLS reservation (see [`image-sizing.md`](./image-sizing.md)).

`fetchpriority` and image-weight reduction (below) are the recommended LCP-image techniques, and they're complementary — but priority alone won't help a hero that's already discovered early and simply **heavy**. Do not use `<link rel="preload">` or HTTP `Link` headers for LCP images even where they're technically possible (see anti-patterns).

### Reduce LCP image transfer size (byte weight)

`fetchpriority` only helps when the hero is *load*-blocked by low request priority. When the image is already discovered early (low `resourceLoadDelay`) but is simply large, priority is a no-op — the win is cutting transfer **bytes** so the image arrives sooner on a constrained connection. For a heavy hero on mobile / slow-4G this is often the single largest LCP lever.

**When the hero is served through an on-the-fly image pipeline, request a right-sized, compressed rendition via URL params.** The correct param names depend on the pipeline:

- **DM delivery API** — `/adobe/dynamicmedia/deliver/dm-aid--…`: use **`width`** / **`height`** / **`quality`** / **`preferwebp=true`**. This endpoint **silently ignores the classic `wid`/`hei` params** (the request still 200s but returns the full-size original), so a `wid=`-based "fix" saves zero bytes and only changes the URL — see anti-patterns.
- **Legacy image servers** may use different param names (e.g. `wid`/`hei`/`qlt`) — match the endpoint's own convention.
- **Image-CDN endpoints with `<picture>` auto-generation** — when the pipeline already emits a responsive `<picture>` with sized renditions and intrinsic `width`/`height`, the LCP-weight fix is usually **in the image-emitting helper** — request a rendered-size `width` (don't serve the desktop rendition to mobile), keep the modern-format rendition, and set `fetchpriority="high"` on the eager hero `<img>` — not by hand-editing a static URL.

```html
<!-- Good — DM delivery API, right-sized + compressed for a ~780px-rendered mobile hero -->
<img src="…/deliver/dm-aid--…/hero.jpg?preferwebp=true&quality=82&width=780"
     alt="Hero" fetchpriority="high">
```

Size `width` to the largest **rendered** CSS width at the target breakpoint (not the intrinsic asset width). Keep `fetchpriority="high"` — weight and priority stack.

> **Measurement caveat — a new URL variant is cold at the DM CDN.** The first request for a
> newly-parameterized URL pays full origin-processing + cold-cache latency, so a one-shot lab
> measurement of the treatment URL against the warm production baseline can show a false
> *regression* even when the fix is real. Warm the treatment URL before the counted runs (or
> corroborate with `curl -sI` on both URLs, comparing `content-length`). On slow connections the
> byte savings dominate the one-time cold-fetch cost once the variant is warm.

## Anti-patterns

### `<link rel="preload">` for the LCP image

```html
<!-- Bad -->
<link rel="preload" as="image" href="hero.jpg">
```

**Why this is bad:** The LCP image varies per page (hero on homepage, product image on PDP, etc.). Maintaining per-page preload tags requires editing every template — high churn, easy to forget. `fetchpriority="high"` on the `<img>` tag itself ships with the markup, scales naturally, and matches the same browser priority. **On stacks with a fixed shared head template this is also infeasible — there's no per-page injection point.**

### HTTP `Link: rel=preload` header

```
Link: <https://example.com/hero.jpg>; rel=preload; as=image
```

**Why this is bad:** HTTP-level preload is invisible from the page source, requires CDN coordination, and silently breaks when the image URL changes. Not maintainable at site scale.

### `loading="lazy"` on the LCP image

```html
<!-- Bad -->
<img src="hero.jpg" alt="Hero" loading="lazy" fetchpriority="high">
```

**Why this is bad:** `loading="lazy"` defers the request until the image is near the viewport. For an LCP element that's at the top of the viewport, this directly delays LCP — the `fetchpriority="high"` is overridden by the lazy heuristic.

### Cookie consent dialog dominating LCP

```html
<!-- Symptom — Lighthouse attributes LCP to the consent overlay, not your hero -->
<script async src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script>
<!-- consent banner inflates a full-viewport overlay AFTER hero paints -->
```

**Why this happens:** when the consent banner becomes the largest paint on the device profile being audited (often mobile, where a full-screen banner fills the viewport), the browser picks it as the LCP element instead of your hero. Lighthouse then attributes LCP to the consent script's load chain. This is a *situation to recognize*, not a single anti-pattern — pick the fix that matches your consent architecture:

- **Redesign the banner** so it's smaller than the content LCP (bottom-pinned bar, not full-screen overlay).
- **Render its placeholder in the initial HTML** with reserved space (see [`layout-shift.md`](./layout-shift.md)), so the banner is stable from first paint.
- **Defer the consent banner past LCP lock-in** — *valid only when tracking is consent-gated* (queue-and-flush: trackers wait for a `consent-ready` event before firing). With proper gating, deferring the banner is fine and compliant. Without gating, deferring the banner while analytics fires immediately breaks GDPR without fixing LCP — see [`third-party.md`](./third-party.md) for the consent-gating contract.
