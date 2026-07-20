# LCP

## Definition

The Largest Contentful Paint (LCP) metric measures the time from when the page starts loading to when the largest text block.

## Components

  - [Server response time](./ttfb.md)
  - Resource load delay
  - Resource load duration
  - Element render delay
  - [Critical rendering path](https://web.dev/learn/performance/understanding-the-critical-path)

## Value Range

| LCP               | Mobile   | Desktop  |
|-------------------|----------|----------|
| Good              |    <2.5s |   <1.2s  |
| Needs Improvement | 2.5-4.0s | 1.2-2.4s |
| Poor              |    >3.0s |   >2.4s  |
| Theoretical min   |     0.6s |    160ms |

## Most common issues

- Bad [TTFB](./ttfb.md)
- Bad [FCP](./fcp.md)
- Render-blocking resources in the critical path that delay the LCP resource loading
- Unnecessary resources in the critical path that delay the LCP resource loading
- Non-optimized custom fonts
- Cookie consent dialog is loaded async and being picked up as LCP (especially on mobile)

## Most common optimizations

- Follow the [TTFB](./ttfb.md) optimizations
- Follow the [FCP](./fcp.md) optimizations
- Include the LCP element in the initial HTML document
- Try to have the LCP element being the same as the FCP one
- Leverage modern media formats (webp, avif, webm) and optimize for the viewport (responsive image)
  - if the LCP element is a video, make sure to use a poster image
  - if the LCP element is an image, make sure it is `loading` as `eager` and its [`fetchpriority`](https://web.dev/articles/fetch-priority) is set to `high`
    - the `prioritizeImages` method in the [aem-cwv-helper](https://github.com/ramboz/aem-cwv-helper#prioritizeimagesselector) can help with this
- Leverage the `navigator.connection` API to adjust media variants for slower networks
- Use [speculative pre-rendering](https://developer.chrome.com/docs/web-platform/prerender-pages)
- Redesign cookie consent dialog so it is smaller than the actual LCP on the page

## How to measure

### Manually
```js
new PerformanceObserver((entryList) => {
  for (const entry of entryList.getEntries()) {
    console.log('LCP candidate:', entry.startTime, entry);
  }
}).observe({ type: 'largest-contentful-paint', buffered: true });
```

### Using web-vitals.js

```js
import { onLCP } from 'web-vitals';

// Measure and log LCP as soon as it's available.
onLCP(console.log);
```

## How to debug

Follow the steps in one of:
- [LCP in our performance audit](../topics/performance-audit.md#fcplcp) article
- the [LCP event](https://developer.chrome.com/docs/devtools/performance/reference#timings) in the Chrome DevTools performance audit view timings
- the [largest contentful paint](https://docs.webpagetest.org/getting-started/#largest-contentful-paint) metric in the [webpagetest.org]() site perfromance audit

## References

- https://web.dev/articles/lcp
- https://web.dev/articles/optimize-lcp
- https://www.debugbear.com/docs/metrics/largest-contentful-paint
- https://www.debugbear.com/docs/fix-lcp-issue
- https://www.woorank.com/en/core-web-vitals/largest-contentful-paint

## Attribution Phases (web-vitals v4)

LCP attribution in web-vitals v4 is exposed under `metric.attribution` (type `LCPAttribution`). v4 renamed `attribution.element` to `attribution.target`. All durations are in milliseconds.

| Phase | `attribution` field | Dominant when | Root cause | Fix direction |
|-------|--------------------|---------------|------------|---------------|
| Server | `timeToFirstByte` | >600ms | Slow origin/CDN, cold start, no edge cache | See [TTFB runbook](./ttfb.md) |
| Discovery | `resourceLoadDelay` | >400ms | LCP resource not in initial HTML, no preload, wrong `fetchpriority` | Add `fetchpriority=high` preload, ensure LCP element is in initial HTML |
| Load | `resourceLoadDuration` | >600ms | Unoptimized image (format, size, compression) | Convert to WebP/AVIF, responsive `srcset`, compress |
| Render | `elementRenderDelay` | >300ms | Render-blocking CSS/JS, hydration delay, font FOIT | Defer blocking scripts, optimize fonts, inline critical CSS |

Additional fields:

| Field | Meaning |
|-------|---------|
| `attribution.target` | CSS selector of LCP element (**renamed from `element` in v4**) |
| `attribution.url` | URL of the LCP resource (image/video src) if applicable |
| `attribution.lcpEntry` | Full `LargestContentfulPaint` `PerformanceEntry` |
| `attribution.lcpResourceEntry` | `PerformanceResourceTiming` entry for the LCP resource |
| `attribution.navigationEntry` | Full `PerformanceNavigationTiming` for the page |

Diagnosis rule of thumb: sum the four phase durations; identify the dominant one, then drill into the specific remediation. If `timeToFirstByte` exceeds 40% of LCP, pivot to the TTFB runbook first — nothing else will move the needle until origin response is fixed.

## Patch Snippets

The `patches.json` bundle is applied pre-navigation by `launcher.js`. Only these keys are valid: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`.

### Missing preload on hero image (addresses `resourceLoadDelay`)
```json
{
  "preloads": [
    { "href": "/images/hero.jpg", "as": "image", "fetchpriority": "high" }
  ],
  "markup": [
    { "selector": "img.hero", "attrs": { "fetchpriority": "high", "loading": "eager" } }
  ]
}
```

### Preload hero + preconnect to image CDN via response headers
```json
{
  "responseHeaders": [
    {
      "urlPattern": "*/index.html",
      "append": {
        "Link": "<https://cdn.example.com>; rel=preconnect; crossorigin, </hero.webp>; rel=preload; as=image; fetchpriority=high"
      }
    }
  ]
}
```

### Defer render-blocking third-party script (addresses `elementRenderDelay`)
```json
{
  "markup": [
    { "selector": "script[src*='analytics']", "attrs": { "defer": "" } },
    { "selector": "link[rel='stylesheet'][href*='fonts.googleapis']", "attrs": { "media": "print", "onload": "this.media='all'" } }
  ],
  "block": [
    "*chat-widget.example.com*"
  ]
}
```

### Web font optimization (addresses render delay from FOIT)
```json
{
  "preloads": [
    { "href": "/fonts/brand.woff2", "as": "font", "crossorigin": "anonymous" }
  ],
  "responseHeaders": [
    {
      "urlPattern": "*/brand.woff2",
      "set": { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  ]
}
```
