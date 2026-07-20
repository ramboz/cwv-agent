# Request Chains

## Overview

A **request chain** is a sequence of dependent resource fetches where each request is discovered (and therefore blocked) by the completion of the previous one. The cumulative delay is the sum of each leg: DNS + TCP + TLS + download + parse/execute, multiplied across the chain depth.

Chains show up most visibly in the HAR waterfall as a stair-step: a script finishes downloading, executes, and only then does the browser discover the import / `createElement('script')` / `fetch()` inside it that triggers the next request. Unlike parallel resources (which compete for bandwidth but not time), chained resources serialize — doubling the chain depth roughly doubles the wall-clock cost.

Classifying a chain correctly is a prerequisite to giving the right optimization advice:

- **CRITICAL** chains need to happen early. Preload every level or make the imports static so the browser discovers them up-front.
- **DEFERRABLE** chains must NOT be preloaded. Defer them, ideally off the critical path entirely.
- **MIXED** chains need surgical treatment per resource — preload the critical parts, defer the rest.

## CRITICAL chains

Must load synchronously or be preloaded. These resources block rendering or control above-fold content.

**Included:**
- First-party scripts in `<head>` that execute before LCP (framework bootstrap, app shell, decorate functions)
- A/B testing / personalization SDKs that control above-fold content:
  - Optimizely (`cdn.optimizely.com`)
  - VWO (`dev.visualwebsiteoptimizer.com`)
  - Adobe Target (`at.js`, `mbox.js`, `*.tt.omtrdc.net`)
  - Google Optimize (`optimize.google.com`)
  - LaunchDarkly (`app.launchdarkly.com`) when gating above-fold UI
- Critical CSS (render-blocking by nature)
- Hero images and other LCP resources
- Critical above-fold fonts

**Examples:**
- `main.js → app-framework.js → vendor-library.js` (3-level first-party bootstrap chain)
- `optimizely.js → experiment-config.js → variant-payload.js` (above-fold A/B test)
- `scripts.js → aem.js → blocks/hero/hero.js` (AEM EDS eager-phase block decoration)

**Recommendation:** Preload or keep synchronous. Add `<link rel="preload" as="script">` for each discovered level so the browser can fetch them in parallel while still executing in dependency order. NEVER async/defer.

## DEFERRABLE chains

Must NOT be preloaded. Must NOT get `preconnect` hints. Should load after LCP.

**Categories and example domains:**

| Category | Examples |
|----------|----------|
| Analytics | GA4 (`google-analytics.com`), Segment, Mixpanel, Amplitude, Adobe Analytics beacon |
| Consent / privacy | OneTrust, `cookielaw.org`, TrustArc, Cookiebot |
| Monitoring / errors | Sentry, Datadog RUM, New Relic, Rollbar |
| Session replay | Hotjar, FullStory, Microsoft Clarity, ContentSquare |
| Chat widgets | Intercom, Drift, Zendesk |
| Social embeds / pixels | Facebook Pixel, LinkedIn Insight, Twitter/X widgets |

**Examples:**
- `cookielaw.org/otBannerSdk.js → otSDKStub.js → consent-categories.js` (consent chain, 3 levels)
- `gtm.js → GA4 config → ga collect beacon` (analytics chain via tag manager)
- `hotjar.com/c/hotjar-XXX.js → hotjar-session.js → replay-beacon.js` (session replay chain)

**Recommendation:** `async` or `defer` attributes. Load after `DOMContentLoaded` or post-LCP. For AEM EDS, put them in `loadDelayed()` (3s after `load`). NEVER preload or preconnect.

## MIXED chains

Contain both critical and deferrable resources. Tag managers are the canonical example.

**Examples:**
- **Google Tag Manager** (`gtm.js`): the container loader is critical if it fires above-fold Optimizely/Target tags; otherwise deferrable. Individual tags inside vary independently.
- **Adobe Launch / DTM** (`assets.adobedtm.com`): critical IF Adobe Target is present AND personalizing above-fold; otherwise deferrable.
- `main.js (critical) → adobedtm (mixed) → vendor-chart.js (deferrable below-fold)` — split: preload `main.js`, audit Launch, defer `vendor-chart.js`.

**Recommendation:** Audit each tag independently. Preload the container only if it controls above-fold content; defer individual non-critical tags inside. The default assumption for tag managers is deferrable unless you have explicit evidence of above-fold personalization.

## Identification heuristic

From `shared.js`:

> Chain depth ≥3 sequential requests involving the same domain → classify the root initiator and apply the verdict to the whole chain.

Practical workflow:

1. From the HAR, find runs of requests where each one starts shortly after the previous one finishes, with the same initiator type (script/script, not parallel parsing).
2. Count the depth. Depth ≥3 and cumulative delay >500ms is worth reporting.
3. Identify the root initiator (first script in the chain). Classify by domain/category per the tables above.
4. If root is first-party or an above-fold personalization SDK → CRITICAL → recommend preload.
5. If root is analytics/consent/monitoring/social → DEFERRABLE → recommend async/defer.
6. If the chain spans multiple categories (e.g. first-party → third-party analytics) → MIXED → split the recommendation.

**Anti-rule:** Do NOT recommend preload for deferrable chains just because they're slow. Slowness of a deferrable chain delays TTI, not LCP, unless the chain is incorrectly blocking the critical path — in which case the fix is to get it off the critical path, not to make the bad chain faster.

## Server-Timing sub-phases

TTFB is a single number, but `Server-Timing` response headers expose what happened inside that number. The three tiers we care about for CDN-fronted sites:

- **`cdn`** — time spent at the edge (Fastly, Akamai, CloudFront). Low here = cache HIT served from edge.
- **`dispatcher`** — time spent at the reverse-proxy / middleware tier (Apache Dispatcher for AEM CS, Varnish, nginx). Shows cache layer decisions between edge and origin.
- **`origin`** — time spent at the application tier (publish tier, Sling models, DB queries). High here = backend work.

Format:

```
Server-Timing: cdn;dur=50, dispatcher;dur=80, origin;dur=250
```

Interpretation rules:

- `cdn` high (>100ms), `origin` low → network latency / CDN routing issue → check CDN region, shield config.
- `cdn` low, `dispatcher` high → dispatcher cache MISS → check cache headers, TTLs, invalidation.
- `cdn` low, `dispatcher` low, `origin` high (>200ms) → backend bottleneck → optimize Sling models, DB queries, cold-start.
- All three low but TTFB still high → client-side (service worker overhead, DNS, TLS) → check web-vitals TTFB attribution fields (`dnsDuration`, `connectionDuration`, `cacheDuration`).

Always correlate `Server-Timing` with `X-Cache` / `Age` response headers to confirm cache status. If `Server-Timing` isn't present at all, the site is flying blind on TTFB; recommend adding it as a foundational observability improvement.
