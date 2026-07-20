# SI

## Definition

The Speed Index (SI) metric measures how quickly content is visually displayed during page load and how long it takes for the viewport to completely render.

## Components

- [TTFB](./ttfb.md)
- [TBT](./tbt.md)
- [FCP](./fcp.md)

## Value Range

| SI                | Mobile   | Desktop  |
|-------------------|----------|----------|
| Good              | < 3.4s   | < 1.3s   |
| Needs Improvement | 3.4-5.8s | 1.3-2.3s |
| Poor              | > 5.8s   | > 2.3s   |

## Most common issues

- Bad [TTFB](./ttfb.md), [TBT](./tbt.md) and/or [FCP](./fcp.md)
- Content visible in the initial viewport is loaded late
- Consent popups, ads or other async elements are loaded late inside the initial viewport

## Most common optimizations

- Follow the Bad [TTFB](./ttfb.md), [TBT](./tbt.md) and [FCP](./fcp.md) optimizations
- [Minimize main thread work](https://developer.chrome.com/docs/lighthouse/performance/mainthread-work-breakdown)
- Prioritize the rendering of the content in the initial viewport

## How to measure

Follow the steps in one of:
- the [Speed Index](https://developer.chrome.com/docs/lighthouse/performance/speed-index) in the Chrome DevTools Lighthouse or PageSpeed Insights report
- the [Speed Index](https://docs.webpagetest.org/metrics/speedindex/) metric in the [webpagetest.org]() site perfromance audit

## How to debug

The speed index is not a metric you can directly debug in the browser, but it is directly impacted by the following metrics:
- [TTFB](./ttfb.md)
- [TBT](./tbt.md)
- [FCP](./fcp.md)

## References

- https://developer.chrome.com/docs/lighthouse/performance/speed-index
- https://www.debugbear.com/docs/metrics/speed-index

## Attribution Phases (web-vitals v4)

**Speed Index is a lab-only metric.** It is not part of the `web-vitals` library — there is no `onSI()`, no `SIAttribution` type. Speed Index is computed by Lighthouse / PageSpeed Insights / WebPageTest from a filmstrip of the viewport, measuring the visual completeness of the above-the-fold area over time. There is no field counterpart.

To diagnose SI in lab, use Lighthouse audits + the three underlying metrics. See [`../topics/performance-audit.md`](../topics/performance-audit.md) for the full audit workflow.

### Contributing signals

SI is dominated by how quickly the visible viewport reaches visual completion. Rather than one attribution surface, SI is driven by the lab attribution of its inputs:

| Underlying metric | Attribution source | Why it matters for SI |
|-------------------|-------------------|------------------------|
| [TTFB](./ttfb.md) | `TTFBAttribution` (`waitingDuration`, `cacheDuration`, `dnsDuration`, `connectionDuration`, `requestDuration`) | Every ms before first byte delays every pixel |
| [FCP](./fcp.md) | `FCPAttribution` (`timeToFirstByte`, `firstByteToFCP`) | First pixels painted — lower is better for SI |
| [TBT](./tbt.md) | Lighthouse `long-tasks`, `bootup-time`, LoAF entries | Long tasks between FCP and visually-complete block paint, dragging SI up |
| [LCP](./lcp.md) | `LCPAttribution.target`, `resourceLoadDelay`, `resourceLoadDuration` | Hero/largest element finishing late means viewport reaches visual completion late |

### Lighthouse audits that move SI

- `speed-index` — the audit itself, including synthetic filmstrip evidence
- `render-blocking-resources` — CSS/JS that block first paint of anything visible
- `unused-css-rules` / `unused-javascript` — bytes delaying first paint without contributing to viewport
- `offscreen-images` — below-fold images being loaded eagerly steal bandwidth from viewport images
- `prioritize-lcp-image` — viewport completeness pivots on LCP image arrival
- `uses-optimized-images`, `modern-image-formats` — smaller viewport images paint faster

Diagnosis rule of thumb: SI rarely has a root cause of its own — it is a composite. Fix the worst of {TTFB, FCP, TBT, LCP} and SI will follow. Use the filmstrip view in PSI / WebPageTest to identify *which* viewport elements paint last and work backwards from there.

## Patch Snippets

The `patches.json` bundle is applied pre-navigation by `launcher.js`. Only these keys are valid: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`. Because SI is a composite, these patches target the dominant contributing metric.

### Prioritize above-fold assets (hero image + critical font)
```json
{
  "preloads": [
    { "href": "/images/hero.webp", "as": "image", "fetchpriority": "high" },
    { "href": "/fonts/brand-regular.woff2", "as": "font", "crossorigin": "anonymous" }
  ],
  "markup": [
    { "selector": "img.hero", "attrs": { "fetchpriority": "high", "loading": "eager" } },
    { "selector": "img[loading='eager']:not(.hero)", "attrs": { "loading": "lazy" } }
  ]
}
```

### Defer below-fold and non-viewport work
```json
{
  "markup": [
    { "selector": "iframe[src*='youtube']", "attrs": { "loading": "lazy" } },
    { "selector": "iframe[src*='maps']", "attrs": { "loading": "lazy" } },
    { "selector": "img:not(.hero):not(.above-fold)", "attrs": { "loading": "lazy", "decoding": "async" } },
    { "selector": "script[src*='below-fold-widget']", "attrs": { "defer": "" } }
  ]
}
```

### Block third-party scripts delaying visual completion
```json
{
  "block": [
    "*google-analytics.com*",
    "*googletagmanager.com*",
    "*doubleclick.net*",
    "*hotjar.com*",
    "*intercom.io*"
  ]
}
```

### Preconnect + aggressive caching for viewport assets
```json
{
  "responseHeaders": [
    {
      "urlPattern": "*/index.html",
      "append": {
        "Link": "<https://images.example.com>; rel=preconnect; crossorigin, <https://fonts.gstatic.com>; rel=preconnect; crossorigin"
      }
    },
    {
      "urlPattern": "*.{webp,avif,woff2,css}",
      "set": { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  ]
}
```
