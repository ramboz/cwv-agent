# TBT

## Definition

The Total Blocking Time (TBT) metric measures the total amount of time after [First Contentful Paint](./fcp.md) (FCP) where the main thread was blocked for long enough to prevent input responsiveness.

## Components

- [Long tasks](https://web.dev/articles/custom-metrics#long-tasks-api) that run for >50ms
- [Long animation frames](https://web.dev/articles/custom-metrics#long-tasks-api) that run for >50ms


## Value Range

| TBT               | Mobile    | Desktop   |
|-------------------|-----------|-----------|
| Good              | < 200ms   | < 150ms   |
| Needs Improvement | 200-600ms | 150-350ms |
| Poor              | > 600ms   | > 350ms   |

## Most common issues

- Complex JS logic at the project level, typically when iterating over a large dataset (like a list of products on a paginated page)
- Leveraging expensive JavaScript APIs, like the `Intl` formatting
- Use of non-optimized 3rd party libraries
- Use of Marketing Tag Managers (like Google Tag Manager, Adobe Launch, etc.)
- Social media or other iframe-like embeds

## Most common optimizations

- Delay long running tasks until after the page is loaded if possible
  - Defer the loading of tag managers (typically a good option for the MarTech)
  - Leverage the [`IntersectionObserver`](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver) API to run tasks when an element becomes visible in the viewport
- Break up long running tasks into smaller chunks
  - Leverage `async`/`await` and the [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) API to refactor code logic from sync to async
  - Use the [`setTimeout`](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout) API to run high priority tasks
  - Use the [`queueMicrotask`](https://developer.mozilla.org/en-US/docs/Web/API/Window/queueMicrotask) API to run medium priority tasks (what `Promise.then()` does)
  - Use the [`requestIdleCallback`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback) API to run low priority tasks when the browser is idle between rendering frames
  - Use the [`requestAnimationFrame`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) API to run tasks that modify the DOM and require a new frame to render
  - Use the [`scheduler.yield`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) API to hand over control to the main thread during a long task, so it can execute other tasks in-between if needed
- [Offload complex background work to a web worker](https://web.dev/articles/off-main-thread)
- For `iframe`-like embeds (videos, maps, social widgets, etc.), try do defer loading with any of these techniques:
  - load the `iframe` only when the user scrolls to the embed, by leveraging an the [`IntersectionObserver`](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver) API
  - use the [`loading="lazy"`](https://developer.mozilla.org/en-US/docs/Web/Performance/Lazy_loading#images_and_iframes) attributes
  - use a static [_facade_ as a placeholder](https://developer.chrome.com/docs/lighthouse/performance/third-party-facades) and load the `iframe` only when the user interacts with the placeholder (i.e. [lite youtube embed](https://github.com/paulirish/lite-youtube-embed), [lite tiktok](https://github.com/justinribeiro/lite-tiktok))


## How to measure

```js
let totalBlockingTime = 0;
new PerformanceObserver((entryList) => {
  for (const entry of entryList.getEntries()) {
    totalBlockingTime += entry.duration - 50;
  }
  console.log({ totalBlockingTime });
}).observe({ type: 'longtask', buffered: true });
```

## How to debug

Follow the steps in one of:
- [TBT in our performance audit](../topics/performance-audit.md#tbt) article
- the [flame chart](https://developer.chrome.com/docs/devtools/performance/reference#timings) in the Chrome DevTools performance audit
- the [total blocking time](https://docs.webpagetest.org/getting-started/#total-blocking-time) metric in the [webpagetest.org]() site perfromance audit


## References

- https://web.dev/articles/tbt
- https://web.dev/articles/optimize-long-tasks
- https://www.debugbear.com/docs/metrics/total-blocking-time
- https://macarthur.me/posts/navigating-the-event-loop/

## Attribution Phases (web-vitals v4)

**TBT is a lab-only metric.** It is not part of the `web-vitals` library's field attribution surface — `web-vitals.js` does not ship `onTBT()` with attribution. TBT is produced by Lighthouse / PageSpeed Insights as an audit output, and is the lab proxy for the field INP metric.

To diagnose TBT in lab, use two complementary signals:

1. **Lighthouse audit outputs** (see [`../topics/performance-audit.md`](../topics/performance-audit.md) for the full audit workflow):
   - `total-blocking-time` audit — reports the numeric value
   - `long-tasks` audit — surfaces individual tasks >50ms with `url`, `duration`, `startTime`, `attributableURLs`
   - `bootup-time` — JS parse/compile/evaluate cost, grouped by script URL
   - `mainthread-work-breakdown` — style/layout/paint/script/parse categorization
   - `third-party-summary` — per-origin third-party cost on main thread

2. **Long Animation Frame observations** (field-aligned, observable in lab too):
   - `performance.getEntriesByType('long-animation-frame')` — each entry has `scripts[]` with per-script `duration`, `invoker`, `sourceURL`, `sourceFunctionName`
   - Correlate with the INP attribution's `longestScript`, `totalScriptDuration`, `totalStyleAndLayoutDuration`, `totalPaintDuration`, `totalUnattributedDuration` fields (see [`inp.md`](./inp.md)) — the same LoAF entries drive both TBT and INP, so a script that dominates LoAFs between FCP and load will also dominate INP during interaction

### Dominant-cause taxonomy

| Category | Audit signal | Fix direction |
|----------|-------------|---------------|
| Third-party scripts (GTM, analytics, martech) | `third-party-summary` high; `long-tasks` `attributableURLs` point to analytics/tag manager | Defer, a delayed loading phase, facade pattern |
| First-party bundle too large | `bootup-time` dominated by site bundles | Code-split, tree-shake, route-level chunks |
| Forced synchronous layout | LoAF with high `totalStyleAndLayoutDuration` | Batch DOM reads/writes, avoid layout thrash |
| Heavy hydration (React/Next/Vue) | `long-tasks` with React/Vue internals in source | Stream/island hydration, defer below-fold |

## Patch Snippets

The `patches.json` bundle is applied pre-navigation by `launcher.js`. Only these keys are valid: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`. Because TBT is lab-only, these patches simulate deferral/blocking of the scripts that produce long tasks between FCP and load.

### Defer marketing tag managers (most common TBT win)
```json
{
  "markup": [
    { "selector": "script[src*='googletagmanager']", "attrs": { "defer": "" } },
    { "selector": "script[src*='launch.adobedtm']", "attrs": { "defer": "" } },
    { "selector": "script[src*='gtm.js']", "attrs": { "async": "" } }
  ]
}
```

### Block heavy third-party analytics / session replay
```json
{
  "block": [
    "*google-analytics.com*",
    "*googletagmanager.com*",
    "*hotjar.com*",
    "*fullstory.com*",
    "*clarity.ms*"
  ]
}
```

### Defer social embeds / chat widgets (iframe-heavy)
```json
{
  "block": [
    "*connect.facebook.net*",
    "*platform.twitter.com*",
    "*platform.linkedin.com*",
    "*intercom.io*",
    "*drift.com*"
  ]
}
```

### Make non-critical first-party bundles async
```json
{
  "markup": [
    { "selector": "script[src*='vendor.bundle']", "attrs": { "defer": "" } },
    { "selector": "script[src*='polyfill']", "attrs": { "defer": "" } }
  ]
}
```
