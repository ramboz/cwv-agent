# Image optimization

Image waste is often the single biggest LCP bottleneck on content sites. A 3 MB PNG that ships to a 400x300 CSS box is maybe 20 KB after proper resize + WebP; that 2.9 MB delta is pure LCP delay on slow-4G. This doc catalogs the heuristics the workbench uses to detect image CWV waste and map each to a concrete byte savings.

Cross-reference: [finding-schema.md](./finding-schema.md), [metrics/lcp.md](./metrics/lcp.md), [metrics/cls.md](./metrics/cls.md).

---

## Heuristics

### 1. Oversized image (pixel waste)

An `<img>` whose decoded pixels exceed its painted area (even accounting for DPR) is downloading bytes no user will see.

Trigger:

```
naturalWidth * naturalHeight > (renderedWidth * dpr) * (renderedHeight * dpr) * 1.5
```

The 1.5 buffer prevents false positives from browsers that pick a slightly larger `srcset` variant. Emit `type: "waste"`. Above-the-fold entries set `metric: ["LCP"]`; below-the-fold still affect LCP (competing bandwidth) plus Speed Index, so `metric: ["LCP", "SI"]` at lower severity.

Example: a 2400x1600 JPEG (0.8 MB) rendered at 400x300 CSS px on a 2x-DPR phone (800x600 target) has `naturalPixels=3.84M vs renderedDpr=0.48M` — 8x oversized. Estimated optimal bytes ≈ `0.48M/3.84M * 800 KB ≈ 100 KB`. Savings: 700 KB ≈ 7000 ms on slow-4G.

### 2. Wrong format for opportunity

`content-type: image/jpeg` or `image/png` with `content-length > 50 KB`. Re-encoding to AVIF or WebP at equivalent perceived quality saves ~35% on average (WebP ~30%, AVIF ~50%, per MDN compression studies). Emit `type: "opportunity"`. Impact: `currentBytes * 0.35 / 1024 * 10 ms/KB`.

Example: a 200 KB JPEG hero photo re-encoded as WebP becomes ~140 KB (60 KB saved) or AVIF ~100 KB (100 KB saved). Finding uses the 35% midpoint: 70 KB ≈ 700 ms on slow-4G.

### 3. Missing `srcset` on responsive image

An `<img>` without `srcset` where `renderedWidth !== naturalWidth` — the page is CSS-sizing a single full-size asset. Low-DPR or narrow viewports still pay the full byte cost. Emit `type: "opportunity"`. Skip if `transferSize < 10 KB` to avoid warning on icons.

Fix: add `srcset` with 1x/2x/3x variants plus a `sizes` attribute matching the CSS width.

### 4. LCP image without `fetchpriority="high"`

The LCP candidate (largest above-the-fold, visible image at load) lacks `fetchpriority="high"`, so Chrome defers it behind other discovered resources. Emit `type: "opportunity"`, `metric: ["LCP"]`, `severity: "high"`. Impact: 300-500 ms (mid-point 400 ms).

The patch fragment is applied via `patches.markup`:

```json
{ "selector": "img[src='/hero.jpg']", "attrs": { "fetchpriority": "high" } }
```

### 5. Above-the-fold image with `loading="lazy"`

Classic anti-pattern. `loading="lazy"` defers the image until layout computes it intersects the viewport — pushing LCP discovery past the critical path. Emit `type: "bottleneck"`. Fix via `patches.markup` `removeAttrs: ["loading"]`.

### 6. Below-the-fold image without `loading="lazy"`

Every below-the-fold `<img>` that isn't `loading="lazy"` is pre-fetch waste — bandwidth and decode work spent on pixels the user may never scroll to. Emit a **single aggregate** finding listing all offending URLs (don't spam one per image). The patch lists all selectors with `attrs: { loading: "lazy" }`.

---

## Format savings reference

| Format | vs JPEG at parity | Notes |
|--------|-------------------|-------|
| WebP   | ~30% smaller | Universal support in modern browsers (2020+). |
| AVIF   | ~50% smaller | Chrome 85+, Firefox 93+, Safari 16.4+. Slower encode. |
| JPEG XL | ~40% smaller | Limited browser support as of 2026; avoid for hero images. |

For text-free photos, prefer AVIF. For screenshots/icons with text, WebP tends to be safer (AVIF's visual fidelity can smooth out text edges). Always test with a perceptual diff before committing a format swap.

---

## DPR and natural-vs-rendered size

A 2x DPR display can *legitimately* request 2x natural pixels per CSS pixel. The oversized check must multiply `renderedWidth * dpr` (and height) before comparing to `naturalWidth * naturalHeight`:

- `natural = 1200x900 = 1,080,000 px`
- `rendered = 400x300 CSS, dpr = 2 → 800x600 = 480,000 px`
- `ratio = 1,080,000 / 480,000 = 2.25` → oversized at 2.25x.

With the 1.5 buffer, the same image on a 3x DPR device (`1200x900` rendered pixels) would be `ratio = 0.9` — not flagged.

For very small DPRs (e.g. headless Chrome default = 1), be cautious about false positives: the collector captures `window.devicePixelRatio` from the emulated viewport. Mobile profiles pin DPR at 2-3 via `page.emulate()`; desktop profiles at 1.

---

## LCP candidate heuristic

Real LCP can only be known at render time via `PerformanceObserver({ type: 'largest-contentful-paint' })`. For static DOM analysis the workbench picks the **largest above-the-fold, visible image at document ready**:

- `getBoundingClientRect().top < viewportHeight` (intersects viewport on load)
- `display !== 'none'` and `visibility !== 'hidden'`
- Largest `renderedWidth * renderedHeight` among the above

This is a heuristic. When PerformanceObserver data is available (via `measure-cwv.js`), prefer that. When chaining, cross-reference with `cwv-attribution` evidence on the finding.

---

## Evidence and source tiers

| Heuristic | `source` | Rationale |
|-----------|----------|-----------|
| Oversized (pixel-only)       | `html` | DOM inspection; confidence cap 0.75 |
| Oversized (with byte cite)   | `har`  | Cites `transferSize`; cap 0.85 |
| Wrong format                 | `har`  | Requires `content-type` + `content-length` |
| Missing srcset               | `html` | Pure DOM; cap 0.75 |
| LCP missing fetchpriority    | `html` | Static markup check |
| Above-fold `loading=lazy`    | `html` | Static markup check |
| Below-fold eager (aggregate) | `har` or `html` | `har` when byte totals cited |

Use `evidence[].kind = "rule-violation"` for DOM-only findings. Add `"resource-timing"` when citing transfer size. When screenshots are captured, append `"screenshot"` with the bounding rect and a `phase: "baseline"` marker.

---

## Impact estimation

All `impactReduction.valueMs` values use a slow-4G proxy of **10 ms per KB** saved. This over-approximates vs Lighthouse's 1.6 Mbps throughput model (~6.25 ms/KB) but better reflects TCP/TLS/connection overhead on small-to-medium assets. Per-heuristic formulas:

- Oversized: `(actualBytes - estimatedOptimalBytes) / 1024 * 10`
- Wrong format: `currentBytes * 0.35 / 1024 * 10`
- Missing srcset: `max(10KB, actualBytes) * 0.3 / 1024 * 10`
- LCP fetchpriority: flat 400 ms
- Above-fold lazy: flat 500 ms
- Below-fold eager: `sum(bytes) / 1024 * 10` across offenders

Findings below `MIN_ACTIONABLE_IMPACT` (LCP: 200 ms) are emitted with `status: "rejected"` per [finding-schema.md](./finding-schema.md).
