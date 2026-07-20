---
issue_type: lcp-image
applicable_flavors: [eds, cs, ams]
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
    reason: "The DM delivery API (/adobe/dynamicmedia/deliver/dm-aid--…) ignores classic Scene7 wid/hei — use width/height. wid= returns the full-size original (zero bytes saved) and only changes the URL, which can regress LCP via a cold-cache origin fetch."
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"\s+[^>]*as\s*=\s*"image"'
    on_flavors: [eds]
    reason: "EDS has a fixed head.html — per-page image preload is not feasible (LCP image varies per page)"

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
    reason: "split the render-blocking CSS monolith / scope oversized clientlibs when render-delay dominates LCP"
  - playbook: third-party
    edge: orthogonal
    reason: "consent-gating contract when the consent overlay is the LCP element — a separate martech concern"

flavor_overrides:
  cs:
    extra_validation:
      - parse_page_templates_for_image_component
  ams:
    extra_validation:
      - verify_jsp_output_path
---

# LCP image

> **Risk tier:** low · **Applies to:** EDS, CS, AMS · **CWV metric:** LCP

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
- Lighthouse shows `elementRenderDelay` dominating the LCP breakdown with **FCP == LCP** — the hero is render-*blocked*, not load-blocked, so `fetchpriority` won't move it. The real gate is the render-blocking critical path — see **Flavor-specific notes → CS** below, [`blocking-resource.md`](./blocking-resource.md), and [`unused-code.md`](./unused-code.md)

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

`fetchpriority` and image-weight reduction (below) are the recommended LCP-image techniques, and they're complementary — but priority alone won't help a hero that's already discovered early and simply **heavy**. Do not use `<link rel="preload">` or HTTP `Link` headers for LCP images even on flavors where they're technically possible (see anti-patterns).

### Reduce LCP image transfer size (byte weight)

`fetchpriority` only helps when the hero is *load*-blocked by low request priority. When the image is already discovered early (low `resourceLoadDelay`) but is simply large, priority is a no-op — the win is cutting transfer **bytes** so the image arrives sooner on a constrained connection. For a heavy hero on mobile / slow-4G this is often the single largest LCP lever.

**When the hero is served through an on-the-fly image pipeline, request a right-sized, compressed rendition via URL params.** The correct param names depend on the pipeline:

- **DM delivery API** — `/adobe/dynamicmedia/deliver/dm-aid--…`: use **`width`** / **`height`** / **`quality`** / **`preferwebp=true`**. This endpoint **silently ignores the classic `wid`/`hei` params** (the request still 200s but returns the full-size original), so a `wid=`-based "fix" saves zero bytes and only changes the URL — see anti-patterns.
- **Classic Scene7 Image Serving** — `/is/image/…`: use **`wid`** / **`hei`** / **`qlt`** (classic naming).
- **Edge Delivery Services (aem.live)** — media URLs (`./media_<hash>.<ext>`): use **`width`** / **`height`** / **`format`** / **`quality`** ([aem.live media docs](https://www.aem.live/docs/media#dynamic-image-manipulation)); `format=webply` is the WebP rendition. The pipeline already auto-emits a `<picture>` with a 750px (mobile) + 2000px (desktop) `webply` source plus the original `png`/`jpeg` fallback, and intrinsic `width`/`height` on the `<img>`. So the EDS LCP-weight fix is usually **in `createOptimizedPicture` / the block's picture markup** — request a rendered-size `width` (don't serve the 2000px desktop rendition to mobile), keep `format=webply`, and set `fetchpriority="high"` on the eager hero `<img>` — not by hand-editing a static URL.

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

**Why this is bad:** The LCP image varies per page (hero on homepage, product image on PDP, etc.). Maintaining per-page preload tags requires editing every template — high churn, easy to forget. `fetchpriority="high"` on the `<img>` tag itself ships with the markup, scales naturally, and matches the same browser priority. **On EDS this is also forbidden because `head.html` is fixed and shared across all pages — there's no per-page injection point.**

### HTTP `Link: rel=preload` header

```
Link: <https://example.com/hero.jpg>; rel=preload; as=image
```

**Why this is bad:** HTTP-level preload is invisible from the page source, requires CDN/dispatcher coordination, and silently breaks when the image URL changes. Not maintainable at site scale.

### `wid=` on a Dynamic Media *delivery* URL

```html
<!-- Bad — /adobe/dynamicmedia/deliver/ ignores wid; image stays full-size -->
<img src="…/deliver/dm-aid--…/hero.jpg?preferwebp=true&quality=82&wid=780" alt="Hero">
```

**Why this is bad:** the DM *delivery* API (`/adobe/dynamicmedia/deliver/dm-aid--…`) does not honor the classic Scene7 `wid`/`hei` params — it returns the full-resolution original, so the "resize" saves zero bytes while changing the URL. That can even *regress* LCP by forcing a cold-cache origin fetch of the same large image. Use `width`/`height` for this endpoint; reserve `wid`/`hei` for classic `/is/image/` Scene7 URLs.

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

## Flavor-specific notes

### EDS

The fix is a single edit to the block's HTML output (`createOptimizedPicture` or the block's own markup). EDS's `head.html` is fixed — never use `<link rel="preload">` for the LCP image, the global head can't carry per-page preloads.

### CS

Identify which page template includes the image component before editing. If the same component is used on multiple templates, scope the `fetchpriority` to the LCP context (typically a hero/banner component on the home / landing-page templates only — adding it to every image component is wrong).

For the hero image itself, route it through the **Adaptive Image Servlet** (`/adaptive/...`) so the publish tier serves a format-converted (WebP/AVIF) and responsively-sized rendition on the fly, dispatcher-cached — rather than the authored original. Check the `dam:Asset` the image component references for its source format.

**The render-blocking critical path is often the real LCP gate — not the hero image.** When `elementRenderDelay` dominates the LCP breakdown and **FCP == LCP**, the image is render-*blocked*, not load-blocked (it may be discovered early and still not paint), so `fetchpriority` won't help. Usual AEM CS culprits, in priority order:

- **`clientlib-base` CSS monolith** — frequently 90%+ unused on a given template. Split the head clientlib's `embed=[…]` list so only above-the-fold component CSS is render-blocking (keep the site base/commons category + `image` + grid; drop accordion/tabs/carousel/search/forms/pdfviewer and let those components self-load their categories on the pages that use them). See [`unused-code.md`](./unused-code.md) and [`bundling.md`](./bundling.md).
- **Authoring jQuery leaking to publish** — Granite/foundation jQuery clientlibs pulled into a CSS-only head clientlib via `dependencies=[cq.jquery]`. Drop the dependency (jQuery consumers are body scripts). See [`blocking-resource.md`](./blocking-resource.md) for the clientlib dependency-graph trace.
- **Adobe Target pre-hiding snippet** — hides `<body>` for up to ~3000ms for anti-flicker. If Target is slow to respond this gates FCP/LCP directly; check and reduce the timeout. **Tell-tale: a high warm-cache LCP floor** — the cold-vs-warm gap is the clientlib cost; the warm floor that *remains* is often the pre-hiding hold. See [`third-party.md`](./third-party.md).
- **Adobe Forms `guideRuntime` (~1.5 MB) loading on non-form pages** — pure waste; scope Forms clientlibs to form templates only. See [`unused-code.md`](./unused-code.md).

**Measurement caveat — the CSS-monolith split is not cleanly lab-A/B-able.** Blocking the bundle to "prove" the LCP win breaks the hero layout and LCP detection goes haywire (jumps to 20s+). Use the **FCP delta** (block the bundle → FCP drops by the bundle's critical-path cost) plus the **warm-cache LCP ceiling** as the evidence, and treat the LCP improvement as guidance-grade, not an oracle-validated delta.

### AMS

Verify the JSP output path before modifying the template. Complex `<cq:include>` chains may produce different rendered markup than the obvious template file suggests.

AMS projects often pre-date the Adaptive Image Servlet and use a **custom image servlet** that rarely does WebP/AVIF — typically JPEG with quality tuning. Check `sling:resourceType` on the image component to identify the servlet before assuming format conversion is available. **Foundation-component hero blocks** also wrap the LCP element in extra `<div class="foundation-…">` containers that inflate DOM size — the `<img>` attribute fix still applies, but flag the markup bloat.
