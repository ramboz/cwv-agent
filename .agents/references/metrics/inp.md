# INP

## Definition

The Interaction to Next Paint (INP) metric measures user interface responsiveness – how quickly a website responds to user interactions like clicks or key presses.

## Components

- Input delay: waiting for background tasks on the page that prevent the event handler from running
- Processing time: running event handlers in JavaScript
- Presentation delay: handling other queued up interactions, recalculating the page layout, and painting page content

## Value Range

| INP               | Mobile/ Desktop  |
|-------------------|------------------|
| Good              | < 200ms          |
| Needs Improvement | 200-500ms        |
| Poor              | > 500ms          |


## Most common issues

- Long tasks running in the background delaying execution of event handlers
- 3rd-party scripts tracking user interactions (i.e. analytics and conversion tracking tags from the martech stack)
- Expensive logic in the event handlers
- Complex UI updates

## Most common optimizations

- Reduce and break up background activity on the main thread
   - Follow the [TBT](./tbt.md) optimizations
- Avoid unnecessary re-rendering of your components (especially in the case of React)
- [Reduce relayouts](https://www.debugbear.com/blog/front-end-javascript-performance#avoid-dom-access-that-requires-layout-work) due to interactions.
  - [What forces layout/reflow. The comprehensive list.](https://gist.github.com/paulirish/5d52fb081b3570c81e3a)
  - Look at alternative ways to get element or scroll positions, like https://toruskit.com/blog/how-to-get-element-bounds-without-reflow/
- Offset complex calculations to a web worker, or at least show a UI update before starting it (i.e. open a dialog with a spinning wheel) and perform further updates asynchronously
- Cache complex computation or UI updates with [memoization](https://www.debugbear.com/blog/front-end-javascript-performance#memoization) techniques where appropriate
- Defer UI updates outside of the current viewport
- [Throttle or debounce](https://www.debugbear.com/blog/front-end-javascript-performance#event-listeners) repeated events firing on a short time-frame

## How to measure

### Manually
```js
performance.getEntriesByType('long-animation-frame');
```

### Using web-vitals.js

```js
import { onINP } from 'web-vitals';

// Measure and log INP in all situations
// where it needs to be reported.
onINP(console.log);
```

## How to debug

Follow the steps in one of:
- [TBT in our performance audit](../topics/performance-audit.md#tbt) article
- the [Interaction events](https://developer.chrome.com/docs/devtools/performance/reference#interactions) in the Chrome DevTools performance audit panel
- The DebugBear [INP Debugger](https://www.debugbear.com/inp-debugger)

## References

- https://web.dev/articles/inp
- https://web.dev/articles/optimize-inp
- https://www.debugbear.com/docs/metrics/interaction-to-next-paint
- https://kurtextrem.de/posts/improve-inp

## Attribution Phases (web-vitals v4)

INP attribution in web-vitals v4 is exposed under `metric.attribution` (type `INPAttribution`). v4 dramatically expanded INP attribution with `PerformanceLongAnimationFrameTiming` (LoAF) data — use it to attribute time inside the slow frame to specific scripts, style/layout, and paint. All durations are in milliseconds.

### Phase breakdown

| Phase | Field | Dominant when | Root cause | Fix direction |
|-------|-------|---------------|------------|---------------|
| Input delay | `inputDelay` | >200ms | Long task blocking main thread at time of interaction (often third-party scripts) | Break up tasks, `scheduler.yield()`, defer analytics/martech |
| Processing | `processingDuration` | >100ms | Expensive event handler (React re-render, complex DOM mutation, sync network) | Optimize/defer handler work, memoize, offload to worker |
| Presentation | `presentationDelay` | >50ms | Large DOM, expensive style recalc/layout, paint | Reduce DOM size, CSS `contain`, avoid layout thrash |

### v4 LoAF-derived breakdown fields

These fields aggregate data from all `PerformanceLongAnimationFrameTiming` entries that intersect the interaction:

| Field | Meaning |
|-------|---------|
| `longestScript` | `{ entry, subpart, intersectingDuration }` — the single most expensive script that ran during the interaction. `entry` is the `PerformanceScriptTiming` object (source URL, `sourceFunctionName`, `sourceCharPosition`); `subpart` is which phase it ran in; `intersectingDuration` is how many ms of it overlapped the interaction |
| `totalScriptDuration` | Aggregate script time (ms) across all LoAFs touching the interaction |
| `totalStyleAndLayoutDuration` | Aggregate style recalc + layout cost (ms) |
| `totalPaintDuration` | Aggregate paint cost (ms) |
| `totalUnattributedDuration` | Time (ms) inside LoAFs not attributable to any script/style/paint — often idle, GC, compositor |
| `longAnimationFrameEntries` | Full array of overlapping `PerformanceLongAnimationFrameTiming` entries — walk the `scripts[]` array for per-script detail |

### Interaction metadata

| Field | Meaning |
|-------|---------|
| `interactionTarget` | CSS selector of the element the user interacted with |
| `interactionType` | `'pointer'` or `'keyboard'` |
| `interactionTime` | Timestamp (ms from navigation start) when the interaction was observed |
| `nextPaintTime` | Timestamp of the next paint after the interaction |
| `processedEventEntries` | Array of the `PerformanceEventTiming` entries that comprise this interaction |

Diagnosis rule of thumb: compare `totalScriptDuration` to `totalStyleAndLayoutDuration`. If scripts dominate, inspect `longestScript.entry.invoker` / `sourceURL` to name the offender. If style/layout dominates, look for forced synchronous layout (`getBoundingClientRect` / `offsetHeight` reads interleaved with writes) — the `topics/performance-audit.md` runbook covers this.

## Patch Snippets

The `patches.json` bundle is applied pre-navigation by `launcher.js`. Only these keys are valid: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`.

### Blocking analytics / tracking that runs in event handlers
```json
{
  "block": [
    "*google-analytics.com*",
    "*doubleclick.net*",
    "*facebook.net*",
    "*segment.io*"
  ],
  "markup": [
    { "selector": "script[src*='analytics']", "attrs": { "defer": "" } }
  ]
}
```

### Defer tag manager + session replay (high `inputDelay`)
```json
{
  "block": [
    "*hotjar.com*",
    "*fullstory.com*",
    "*clarity.ms*"
  ],
  "markup": [
    { "selector": "script[src*='googletagmanager']", "attrs": { "defer": "" } },
    { "selector": "script[src*='launch.adobedtm']", "attrs": { "defer": "" } }
  ]
}
```

### Block chat widget pulling in large bundle during interaction
```json
{
  "block": [
    "*intercom.io*",
    "*drift.com*",
    "*zendesk.com*"
  ]
}
```

### Neutralize a specific script identified via `longestScript.entry.sourceURL`
```json
{
  "block": [
    "*/heavy-vendor-sdk.js"
  ]
}
```
