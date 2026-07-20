# TTFB

## Definition

The  Time To First Byte (TTFB) metric measures the time it takes for the network to respond to a user request with the first byte of a resource.

## Components

TTFB is essentially composed of:
- Redirect time
- Service worker and/or lamba function startup time (if applicable)
- DNS lookup
- TCP connection
- TLS negociation
- Server processing time

## Value Range

| TTFB              | Mobile/Desktop |
|-------------------|----------------|
| Good              | < 800ms        |
| Needs Improvement | 800ms – 1.6s   |
| Poor              | > 1.8s         |

## Most common issues

- Overhead of connections to other hosts
  - Slow DNS lookup
  - Overhead of TLS handshake for SSL connections
- Slow network times due to remote access
- Overhead of redirections
- Slow server processing times
- Nested network calls
- Cloud instance cold-starts

## Most common optimizations

- Self-hosting 3rd-party dependencies to reduce domain lookup overhead
- Use a CDN with global locations for all hosts (including DNS)
- Use local 3rd-party APIs, co-located within the CDN pop regions
- [Avoid redirect chains](https://developer.chrome.com/docs/lighthouse/performance/redirects)
- Leverage caching at every level
  - Database
  - Server response
  - CDN
  - Browser
- Ensure warm cloud instances are available in every region

## How to measure

### Manually

```js
new PerformanceObserver((entryList) => {
  const [pageNav] = entryList.getEntriesByType('navigation');
  console.log(`TTFB: ${pageNav.responseStart}`);
}).observe({ type: 'navigation', buffered: true });
```

### Using web-vitals.js

```js
import { onTTFB } from 'web-vitals';

// Measure and log TTFB as soon as it's available.
onTTFB(console.log);
```

## How to debug

Follow the steps in one of:
- the [network resource details](https://developer.chrome.com/docs/devtools/network#details) in the Chrome DevTools
- the [time to first byte](https://docs.webpagetest.org/getting-started/#time-to-first-byte) metric in the [webpagetest.org]() site perfromance audit

## References

- https://web.dev/articles/ttfb
- https://web.dev/articles/optimize-ttfb
- https://www.debugbear.com/docs/metrics/time-to-first-byte
- https://www.debugbear.com/blog/http-server-connections

## Attribution Phases (web-vitals v4)

TTFB attribution in web-vitals v4 is exposed under `metric.attribution` (type `TTFBAttribution`). **v4 renamed every field from `*Time` to `*Duration`** — use the exact names below. All durations are in milliseconds.

| Phase | Field | Dominant when | Root cause | Fix direction |
|-------|-------|---------------|------------|---------------|
| Cache lookup | `cacheDuration` | >100ms | Service worker / disk cache overhead | Investigate SW registration; simplify fetch handler; bypass SW for navigation requests |
| DNS | `dnsDuration` | >100ms | Slow DNS resolution, no prefetch, multiple lookups | DNS prefetch via `<link rel=dns-prefetch>`, use reliable DNS provider, reduce third-party origins |
| Connection | `connectionDuration` | >200ms | TCP + TLS handshake cost | Enable HTTP/2 or HTTP/3, keep-alive, use Early Hints (`103`), preconnect to critical origins |
| Request | `requestDuration` | >100ms | Slow upload (large request headers/cookies) or slow server first-byte emission | Investigate cookie bloat, request header size; server-side logging |
| Waiting | `waitingDuration` | >400ms | Server processing, origin compute, dispatcher cache MISS, backend query | Origin performance tuning, CDN config (longer TTLs, stale-while-revalidate), warm compute instances |

Additional field:

| Field | Meaning |
|-------|---------|
| `navigationEntry` | Full `PerformanceNavigationTiming` for deeper analysis (includes `redirectStart`/`redirectEnd`, `workerStart`, `secureConnectionStart`, etc.) |

Diagnosis rule of thumb: sum the five durations; identify the dominant one. `waitingDuration > 400ms` is the most common TTFB root cause and almost always indicates cache MISS or slow origin. Use `Server-Timing` response headers (e.g. `cdn;dur=50, dispatcher;dur=80, origin;dur=250`) to split `waitingDuration` further into CDN / dispatcher / origin tiers — see `topics/request-chains.md`.

## Patch Snippets

The `patches.json` bundle is applied pre-navigation by `launcher.js`. Only these keys are valid: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`.

> TTFB patches are inherently lab-only: production fixes require CDN/origin configuration changes. These snippets simulate the response headers a properly configured CDN would emit.

### Simulate aggressive CDN caching (addresses high `waitingDuration` from cache MISS)
```json
{
  "responseHeaders": [
    {
      "urlPattern": "*/index.html",
      "set": {
        "Cache-Control": "public, max-age=60, s-maxage=3600, stale-while-revalidate=86400",
        "CDN-Cache-Control": "public, max-age=3600"
      }
    },
    {
      "urlPattern": "*.{js,css,woff2,png,jpg,webp,avif}",
      "set": {
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    }
  ]
}
```

### Preconnect to critical origins (addresses `dnsDuration` + `connectionDuration`)
```json
{
  "responseHeaders": [
    {
      "urlPattern": "*/index.html",
      "append": {
        "Link": "<https://cdn.example.com>; rel=preconnect; crossorigin, <https://api.example.com>; rel=preconnect; crossorigin, <https://fonts.gstatic.com>; rel=preconnect; crossorigin"
      }
    }
  ]
}
```

### Trim request cookies / headers (addresses `requestDuration`)
```json
{
  "requestHeaders": [
    {
      "urlPattern": "*/api/*",
      "remove": ["Cookie", "X-Tracking-Context"]
    }
  ]
}
```

### Simulate Early Hints preconnect for critical resources
```json
{
  "responseHeaders": [
    {
      "urlPattern": "*/index.html",
      "append": {
        "Link": "<https://images.example.com>; rel=preconnect; crossorigin, </hero.webp>; rel=preload; as=image; fetchpriority=high"
      }
    }
  ]
}
```
