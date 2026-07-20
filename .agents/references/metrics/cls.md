# CLS

## Definition

The Cummulative Layout Shift (CLS) metric measures the the largest burst of layout shift scores for every unexpected layout shift that occurs during the entire lifecycle of a page.

## Components

CLS is essentially composed of:
- [impact fraction of the total area of the viewport](https://web.dev/articles/cls#impact-fraction)
- [distance fraction of the viewport's largest dimension](https://web.dev/articles/cls#distance-fraction)

## Value Range

| CLS               | Mobile/Desktop |
|-------------------|----------------|
| Good              | < 0.1          |
| Needs Improvement | 0.1-0.25       |
| Poor              | > 0.25         |

## Most common issues

- Position of DOM elements is changed
- Dimension of DOM elements is changed
- DOM elements are inserted or removed
- CSS animations that trigger layout are running on the page
- CSS `position` of a DOM element
- Images, ads or social embeds are loaded without proper space being reserved
- Async content is rendering without proper space being reserved
- Hydrated/default-state mismatch: SSR/static CSS renders a tab/panel/slot at
  `0px` or `display:none`, then hydration opens the default state and pushes
  following content
- [Use of custom fonts with no proper fallback](https://www.debugbear.com/blog/web-font-layout-shift)
- Loading async content that causes the scrollbar to appear lazily

## Most common optimizations

- Insert/re-order/remove DOM elements before the page is made visible to the user
- Set proper `height` and `width` properties for images, ads or social embeds before they are loaded, or set the `aspect-ratio` CSS property
- Animate using the CSS `transform` property rather than direct CSS position and size properties
- Reserve space for content that loads asynchronously and use properly sized placeholders (leverage static `height`/`min-height`, or position it `absolute`/`fixed`)
- Align SSR/static initial CSS with the hydrated default state. If the default
  tab/panel is open after hydration, reserve its final slot before first paint;
  do not depend on a DOMContentLoaded mutation to add the reservation.
- Optimize your fallback fonts and `size-adjust` them to your custom font
  - https://web.dev/articles/css-size-adjust
  - https://www.debugbear.com/blog/web-font-layout-shift#adjusting-font-metrics
  - https://www.aem.live/developer/font-fallback
- [Avoid inserting new content without a clear user interaction](https://web.dev/articles/optimize-cls#avoid_inserting_new_content_without_a_user_interaction) (like a "load more" button on an infinite list, or toggling an accordion panel)
- Leverage the [`scrollbar-gutter: stable`](https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-gutter) CSS property

## How to measure

### Manually
```js
new PerformanceObserver((entryList) => {
  for (const entry of entryList.getEntries()) {
    console.log('Layout shift:', entry);
  }
}).observe({ type: 'layout-shift', buffered: true });
```

### Using web-vitals.js

```js
import { onCLS } from 'web-vitals';

// Measure and log CLS in all situations
// where it needs to be reported.
onCLS(console.log);
```

## How to debug

Follow the steps in one of:
- [CLS in our performance audit](../topics/performance-audit.md#cls) article
- the [Layout Shift event](https://web.dev/articles/debug-layout-shifts#devtools) in the Chrome DevTools performance audit panel
- the [first contentful paint](https://docs.webpagetest.org/getting-started/#first-contentful-paint) metric in the [webpagetest.org]() site perfromance audit


## References

- https://web.dev/articles/cls
- https://web.dev/articles/optimize-cls
- https://web.dev/articles/debug-layout-shifts
- https://www.debugbear.com/docs/metrics/cumulative-layout-shift
- https://www.debugbear.com/blog/devtools-layout-shift
- https://www.woorank.com/en/core-web-vitals/improving-cumulative-layout-shift
- https://culture-tecture.adobe.com/en/publish/2024/08/26/aem-blog-cumulative-layout-shift-cls-a-developer-s-nightmare
- https://css-triggers.com/
- https://richstyle.org/?documentation/css-will-change-property-en

## Attribution Phases (web-vitals v4)

CLS attribution in web-vitals v4 is exposed under `metric.attribution` (type `CLSAttribution`). CLS is not a timeline of phases — it is the largest shift burst — so attribution focuses on identifying the single worst shift.

| Field | Meaning | Common cause / how to read it |
|-------|---------|-------------------------------|
| `largestShiftTarget` | CSS selector of DOM element causing the largest single shift | Image without dimensions, late-injected ad/banner/consent, async hero |
| `largestShiftValue` | Score contribution of the largest single shift | If `>0.05`, treat as the root issue; if `>0.1` by itself it already puts the page in NI territory |
| `largestShiftTime` | Timestamp (ms since navigation start) of the largest shift | Correlate with network waterfall: what finished loading just before? |
| `largestShiftSource` | `LayoutShiftAttribution` source info (node, previousRect, currentRect) | DOM-level debugging — tells you from where to where the element moved |
| `largestShiftEntry` | Full `LayoutShift` `PerformanceEntry` | Contains `hadRecentInput` for exclusion checks; also `sources[]` |
| `loadState` | When the shift occurred: `loading`, `dom-interactive`, `dom-content-loaded`, `complete` | `loading` = very early, often font/hero; `dom-interactive` = sync JS mutation; `complete` = async content (ads, consent, embeds) |

**Important v4 note:** `hadRecentInput` is **NOT** a top-level field on `CLSAttribution`. It lives at `largestShiftEntry.hadRecentInput`. Shifts with `hadRecentInput=true` are already excluded from the CLS score by web-vitals itself, so you should not see them dominate `largestShiftValue`.

Diagnosis rule of thumb: `loadState` tells you *when* the shift fired — pair it with `largestShiftTarget` to pick the right fix. A `complete`-state shift on an `iframe[src*='ads']` is an ad slot sizing issue; a `loading`-state shift on `body > header` is often a font-swap issue.

### Hydrated/default-state mismatch

Signature: a tab panel, finder module, accordion, or conditional block renders
at `0px`/`display:none` in the static document, then hydration selects a default
state and the panel grows (for example `#FindCare` `0px → 392px`) while content
below it moves (for example `#select-your-insurance`). This is not an image
dimension problem; it is an initial-state contract problem.

Fix it at parse/first-paint time:
- SSR or static CSS must match the hydrated default state. If a panel is open by
  default in JS, render/reserve that panel's final slot in the initial markup/CSS.
- Prefer source CSS/HTML or a `rewriteBody` lab patch for proof, because the
  browser sees the reservation before paint.
- Avoid `DOMContentLoaded`/post-load `markup` reservations for this class. They
  can add their own shift because already-painted content has to move to make
  room.
- Reveal state changes with `opacity`/`transform` on an already-sized box, not
  `display`, `height`, `width`, or jQuery `.show(duration)`/`.slideDown()`.

## Patch Snippets

The `patches.json` bundle is applied pre-navigation by `launcher.js`. Only these keys are valid: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`.

### Image without dimensions (most common CLS cause)
```json
{
  "markup": [
    { "selector": "img.ad-banner", "attrs": { "width": "300", "height": "250" } },
    { "selector": "img.hero", "attrs": { "width": "1200", "height": "600" } }
  ]
}
```

### Reserve space for late-injected ad / embed slot
```json
{
  "markup": [
    { "selector": ".ad-slot", "attrs": { "style": "min-height: 250px; display: block;" } },
    { "selector": "iframe[src*='youtube']", "attrs": { "width": "560", "height": "315" } }
  ]
}
```

### Reserve a hydrated default-state panel before first paint
```json
{
  "rewriteBody": [
    {
      "urlPattern": "*",
      "replacements": [
        {
          "find": "id=\"FindCare\" class=\"tab-panel\"",
          "replace": "id=\"FindCare\" class=\"tab-panel is-active\" style=\"min-height:392px\""
        }
      ]
    }
  ]
}
```

Use this only as a lab proof. The permanent fix should live in the source
template/CSS so the default panel's initial layout matches the hydrated state.

### Font-swap layout shift — preload custom font so it's ready before first paint
```json
{
  "preloads": [
    { "href": "/fonts/brand-regular.woff2", "as": "font", "crossorigin": "anonymous" },
    { "href": "/fonts/brand-bold.woff2", "as": "font", "crossorigin": "anonymous" }
  ],
  "responseHeaders": [
    {
      "urlPattern": "*.woff2",
      "set": { "Cache-Control": "public, max-age=31536000, immutable" }
    }
  ]
}
```

### Block a late-injected chat widget / banner that causes shift
```json
{
  "block": [
    "*intercom.io*",
    "*drift.com*",
    "*hotjar.com*"
  ]
}
```
