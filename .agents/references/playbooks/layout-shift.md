---
issue_type: layout-shift
applicable_flavors: [eds, cs]
risk_tier: medium

required_validation:
  - cls_element_attribution_available
  - shifting_element_classified

forbidden_techniques:
  - pattern: 'font-display:\s*block\b'
    reason: "font-display: block extends FOIT and worsens CLS for the heading — use 'swap' or 'optional'"
  - pattern: 'min-height:\s*0(?:px)?\s*(?:!important)?\s*[;}]'
    reason: "min-height: 0 on a container that holds dynamic content does NOT reserve layout space — use a real px or aspect-ratio value"

see_also:
  - playbook: image-sizing
    edge: routes_to
    reason: "router dispatch — when the shifting element is an unsized image"
  - playbook: font-fallback
    edge: routes_to
    reason: "router dispatch — when the shifting element is text mid font-swap"
  - playbook: font-preload
    edge: complements
    reason: "pair with a font preload for the critical body face to keep the swap window short"
---

# Layout shift (general)

> **Risk tier:** medium · **Applies to:** EDS, CS (recommend-only on AMS — root cause too variable in legacy JSP stacks) · **CWV metric:** CLS

## What this addresses

CLS is caused by elements that change size or position after first render. This playbook is a **router**: identify the shifting element from Lighthouse element attribution, then apply the fix that matches the root cause:

| Root cause | Fix path |
|---|---|
| Unsized image | [`image-sizing.md`](./image-sizing.md) |
| Dynamically inserted content (banners, ads, embeds) | `min-height` reservation on the container |
| Web font swap (FOIT/FOUT) | [`font-fallback.md`](./font-fallback.md) |
| Ad/embed slot | Fixed `aspect-ratio` or `min-height` placeholder |
| Sticky header/nav that detaches on scroll | Reserve the collapsing wrapper's height (below) |
| (EDS) Lazy section grows on load — section gating removed / `loadEager` awaits an empty section | Fix the **loading sequence**, not a per-element shim (below; EDS only) |
| Hydrated tab/accordion default state differs from static layout | Render the hydrated default panel/slot at final geometry before first paint |
| Async 3rd-party embed/widget (reviews, social, e.g. Elfsight) injected into an unsized container | Reserve the embed container's height (`min-height`) — see below |
| Full-bleed `::before` section background "amplifying" a shift (AEM `full-width-background-extend`) | The `::before` is the **amplifier, not the cause** — reserve the late content *above* it; see below |
| Hydrated/default-state mismatch (tab/panel starts `0px`/hidden, hydration opens it) | Align SSR/static CSS with the hydrated default and reserve the active panel before first paint |

If the element type can't be classified from Lighthouse output, **do not auto-fix** — recommend manual investigation.

## When to apply / when to skip

**Apply when:**
- Lighthouse CLS attribution identifies a specific shifting element
- The element's root cause matches one of the categories above

**Skip when:**
- No element attribution (CLS score known but no element identified — common pre–PSI v11)
- Root cause is "complex layout reflow" without a single offending element
- (AMS) Legacy JSP stack with multiple includes — too variable, recommend manual investigation

## Recommended approaches

### Reserve space for dynamically inserted content

```html
<!-- Good — banner slot reserves height upfront -->
<div class="banner-slot" style="min-height: 90px"></div>
<script>insertBannerWhenReady('.banner-slot');</script>
```

```css
/* Or via stylesheet, preferred */
.banner-slot { min-height: 90px; }
@media (min-width: 768px) { .banner-slot { min-height: 120px; } }
```

### Async 3rd-party embed widgets — reserve the container (don't block)

An embed widget (Elfsight reviews/social, a chat/booking iframe) injected by a
vendor script into a container with `min-height: 0` inserts its full height late,
shifting everything below it. The fix is to **reserve the container's height** in
critical CSS so the space exists before the widget arrives — not to block the
widget. The target div is usually present in the authored markup (e.g. Elfsight's
`<div class="elfsight-app-…">`); reserve there or on the embed wrapper:

```css
/* The embed host is in the HTML; the vendor fills it late → reserve its box */
.cmp-embed [class*="elfsight-app"] { min-height: 376px; } /* ~rendered height; tune per breakpoint */
```

### Full-bleed `::before` background amplifiers (AEM `full-width-background-extend`)

**Diagnostic trap:** when `cls.shiftSources` blames a `::before` on a full-bleed
section background (the AEM `full-width-background-extend` pattern — an
`position:absolute; width:4000px` pseudo-element that extends a centered
section's background edge-to-edge), that element is almost never the *cause*. It
is an **amplifier**: because it is enormous, any vertical movement of its
container — caused by late content **above** it (a lazy image without dims, an
async embed, a tabbed panel initialising) — scores a huge layout-shift area. Do
NOT try to pin the `::before`. Find what pushes its container (use the box-metric
diff + the per-source `cls-variance` judgment) and reserve *that* upstream space;
the `::before` then stops moving. (Canonical case: mauriceblackburn.com.au
homepage — an Elfsight embed pushed two `full-width-background-extend` sections,
contributing ~0.66 of a 0.92 CLS; reserving the embed zeroed the `::before` source.)

### (EDS) Lazy-section grow-in-place — fix the loading sequence, not the element

EDS-only. When the shifting elements are whole `.section`s that **grow from scaffold
height after `body.appear`** (diagnostic signature: at reveal they are still
`data-section-status="initialized"`/`"loading"` and `display:block`), the cause is a
**broken section-reveal gating contract**, not any single element — so a `min-height`
shim on one container is causally inert (verified on zepbound.lilly.com `/savings`).

Two compounding faults, both in the shared EDS frontend (`scripts/scripts.js`,
`scripts/aem.js`, `styles/styles.css`):

1. The per-section `display:none`-until-`data-section-status="loaded"` gate (and/or
   `body:not(.appear){display:none}`) was **removed** — often swapped for an *opacity*
   transition "to prevent FOUC", which does **not** remove layout — so lazy sections
   sit in flow and grow as they decorate.
2. `loadEager` **awaits an empty first section** (a spacer / `css-block`), so the real
   ATF — including the LCP element — decorates lazily.

These **entangle CLS and LCP**: gating the lazy sections to fix CLS hides the
lazily-decorated LCP element (LCP regresses); not gating lets it shift. **Do not ship
a CSS-only gate.** The fix is the loading sequence — see
[`stacks/aem-eds.md`](../stacks/aem-eds.md) → "Section reveal gating": `loadEager`
awaits the real ATF/LCP section and reveals after it; below-fold sections stay gated
until `loaded`. This is an architecture fix on the shared frontend (lands site-wide),
not a runtime patch — publish it as `cwv-publish` guidance (no `patchContent`).

### Hydrated tab / accordion default-state mismatch

Tabbed panels, accordions, insurance selectors, and other "default choice" UI
often render one static state and then hydrate into another. Diagnostic shape:

- RUM/lab largest shift target names a visible victim container (for example
  `#select-your-insurance`).
- The lab `LayoutShift.sources[]` shows a sibling/default panel growing from
  `0×0` or absent to its final size (for example `#FindCare` from `0` height to
  ~392px), while the named target moves as a consequence.
- A parse-time CSS reservation collapses CLS, proving the mechanism, but may
  also change LCP because the above-fold default content and final hydrated
  content no longer match.

Treat this as a source-state bug, not a victim-selector bug. The durable fix is
to make the static/SSR initial state match the hydrated default:

```html
<!-- Good: the default hydrated panel is present in the initial HTML flow -->
<section class="insurance-tabs" data-default-panel="find-care">
  <div id="FindCare" class="tab-panel is-active">...</div>
  <div id="commercial" class="tab-panel" hidden>...</div>
</section>
```

```css
/* Good: reserve the active panel slot before JS decorates tabs */
.insurance-tabs { min-height: 392px; } /* tune per breakpoint */
.tab-panel[hidden] { display: none; }
.tab-panel.is-active { display: block; }
```

If the final panel must reveal after data arrives, reserve a skeleton with the
same dimensions and animate only `opacity`/`transform`. Avoid a client-only
`display:none → block` default swap after first paint. Validate with
`CLS@<source>` and run the `cwv-fix` load-only LCP guard when the scrolled
treatment changes the LCP candidate.

### Fix font swap CLS — see [`font-fallback.md`](./font-fallback.md)

When the shifting element is text mid font-swap, the fix is the full font-fallback playbook (three independent fixes: `font-display: swap`, web-safe fallback in the family stack, and a size-adjusted fallback `@font-face`). Quick reference:

```css
/* swap eliminates FOIT */
@font-face { font-family: 'Brand'; src: url(...); font-display: swap; }

/* size-adjusted fallback eliminates the residual CLS at swap time */
@font-face { font-family: 'Brand-Fallback'; src: local('Arial'); size-adjust: 96.5%; ascent-override: 90%; }
body { font-family: 'Brand', 'Brand-Fallback', Arial, sans-serif; }
```

Pair with [`font-preload.md`](./font-preload.md) for the critical body face to keep the swap window short. See [`font-fallback.md`](./font-fallback.md) for the full per-font validation checklist, anti-patterns, and the metric-data requirement for `size-adjust`.

### Stabilize the scrollbar with `scrollbar-gutter`

```css
/* Good — reserves scrollbar space upfront on overflow-capable containers */
html { scrollbar-gutter: stable; }
```

When async content loads and the page becomes scrollable, the browser inserts a scrollbar that consumes ~15px of horizontal space — every element on the page shifts left. `scrollbar-gutter: stable` reserves that space at first paint regardless of whether the scrollbar appears. Cheap, universal fix for a class of CLS that's otherwise hard to attribute.

### Reserve ad/embed slots with `aspect-ratio`

```css
/* Good — 16:9 video embed */
.video-embed {
  aspect-ratio: 16 / 9;
  width: 100%;
}
```

### Reveal or expand content without shifting layout

Hiding content with `display:none` and revealing it later — a consent banner, a tab
panel, an accordion, an "expand" — is the most common post-load CLS source after images.
Two flavors of the same mistake shift layout:

- **jQuery `.show(duration)` / `.slideDown()` / `.animate({height})`** tween `width`/
  `height`/`opacity` from 0, so the box *grows open* over many frames — each frame a layout
  shift. The chain-rum-correlator flags exactly this signature (monotonic rect growth across
  consecutive frames) as `animated-reveal` — see
  [chain-rum-correlation.md](../topics/chain-rum-correlation.md) C6.
- **A bare `display:none → display:flex/block` swap** on hydration or interaction reflows
  everything below the element by its full height in one shift.

**The fix: render at final size, reveal with compositor-only properties.** Keep the element
in layout at its final size (or take it out of flow with `position:fixed/absolute` so it
never displaces siblings), and toggle visibility via a class that animates only
`opacity`/`transform`/`visibility` — never `display`/`width`/`height`:

```css
/* Good — the box holds its final size; only opacity/transform animate (compositor, no reflow) */
.cookie-banner {
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 200ms ease, transform 200ms ease;
}
.cookie-banner.is-visible { opacity: 1; transform: none; }
```

```js
banner.classList.add('is-visible');   // Good — class toggle, no layout-affecting animation
$('.cookie-banner').show(400);         // Bad  — tweens width/height/opacity from 0 → grows the box (CLS)
```

**The `display` gotcha.** You can't CSS-`transition` `display:none ↔ block` (it's a discrete
property) — which is *why* developers reach for JS height / `.show(duration)` tweens, and why
those tween layout. Two correct ways out:

1. **Keep it displayed, animate `opacity`/`transform`** (above) — works everywhere.
2. **Discrete-property transitions** (modern browsers) — animate `display` + `opacity`
   together with `@starting-style` and `transition-behavior: allow-discrete`:
   ```css
   .panel { display: none; opacity: 0; transition: opacity 200ms, display 200ms allow-discrete; }
   .panel.open { display: block; opacity: 1; }
   @starting-style { .panel.open { opacity: 0; } }
   ```
  The element must still reserve its space (or be out of flow) so revealing it doesn't push
  siblings.

**Hydrated/default-state mismatch.** A stricter variant is a component whose
static/SSR layout does not match its hydrated default state. Example signature:
a finder/tab module ships with the active panel at `height:0` or `display:none`;
hydration selects the default tab and the panel grows (`#FindCare` `0px → 392px`),
pushing the next block (`#select-your-insurance`). Fix the initial-state contract:
render the default active panel or reserve its final slot before first paint.
Do not rely on a DOMContentLoaded-time reservation; that mutation happens after
paint and can create the CLS you are trying to remove.

**Can't rebuild the source yet?** If the reveal lives in a vendor bundle you can't rebuild
immediately, the minimal interim fix is to drop the animation duration so the element paints
at final size in one frame — e.g. jQuery `$('.x').show(400)` → `$('.x').show()`. That alone
took otempo's consent banner from **0.138 → 0.000** CLS (lab-validated). You can prove such a
served-JS fix in the lab before shipping — see `cwv-validate.md` → "Validating a served-JS fix
with `rewriteBody`".

### Sticky header/nav that detaches on scroll

A header or nav that becomes `position: fixed` (or toggles a `sticky`/`scrolled` class) once
the user scrolls is a distinct, easily-missed CLS source — and it recurs across navigational
sites (seen on both parcelpro and about.ups.com). The trap is a **two-step, two-frame swap**:

1. The nav switches `position: relative → fixed`, which **removes it from flow** — collapsing
   its in-flow wrapper from its height (e.g. 132px) to 0, so everything below jumps **up**.
2. A compensating `padding-top` (≈ the nav height) is added to a content container to fill the
   gap — but **a frame later**, so everything jumps back **down**.

Each step is a separate layout shift of ~the header height, even though the *net* position
barely changes. Because scroll is **not** `hadRecentInput`, these shifts **count toward CLS**,
and they recur every time the user crosses the scroll threshold (down and back up) — so a few
scroll cycles can dominate a session's CLS.

**Why the obvious fixes fail** (all verified inert on about.ups.com): locking the compensating
`padding-top` to 0, hiding the fixed nav (`display:none`), or stripping the toggled body class —
none help, because the *mover* is the **wrapper collapsing out of flow**, not the padding or the
class.

**The fix: reserve the wrapper's height so detaching the nav is layout-neutral.** Keep the
header's space whether or not the nav is fixed, and drop the now-redundant compensating padding:

```css
/* Reserve the header wrapper's height so the nav going fixed can't collapse it */
.site-header-wrapper { min-height: 132px; }   /* = the nav's rendered height */
/* Remove the scroll-toggled compensation (it now double-counts) */
.main-content { padding-top: 0; }
```

Better still, make the nav `position: sticky; top: 0` instead of `fixed` + a JS spacer — sticky
keeps its space in normal flow, so sticking never reflows. Lab-validated on about.ups.com:
reserving the wrapper height took scroll-phase CLS from **0.190 → 0.000**.

> **Attribution tip:** Lighthouse / `largestShiftTarget` often blames a large content grid here,
> with near-identical before/after rects — because the *visible* region is the whole viewport and
> the value is `movedPx / max(viewportW, viewportH)` (a 130px move on a 1366px viewport ≈ 0.095).
> When the shifting element's rects look unchanged but a shift still scores, diff every element's
> box metrics between two scroll states to find the wrapper that actually changes height — see
> `cwv-diagnose.md` → "Step 7a — box-metric diff".

## Anti-patterns

### `font-display: block`

```css
/* Bad */
@font-face {
  font-family: 'Brand';
  src: url('/fonts/brand.woff2') format('woff2');
  font-display: block;
}
```

**Why this is bad:** `block` extends the FOIT (flash of invisible text) period to ~3s. If the LCP element is a heading, this directly delays LCP by the FOIT duration. Always use `swap` or `optional` for body and heading text.

### `min-height: 0` on a dynamic container

```css
/* Bad */
.banner-slot { min-height: 0; }
```

**Why this is bad:** Reserves no space. When the banner inserts at 90px, every element below shifts by 90px. The whole point of `min-height` is to claim the space before the content arrives — `0` defeats it.

### Reserving the wrong amount

```css
/* Bad — banner is 90px tall, container reserves 30px */
.banner-slot { min-height: 30px; }
```

**Why this is bad:** Partial reservation means a smaller-but-still-present shift when the banner actually inserts. Use the actual rendered height, not a guess.

### Animating with layout properties (`width`, `height`, `top`, `left`)

```css
/* Bad — animating top/left re-runs layout on every frame */
.menu {
  position: absolute;
  top: -100%;
  transition: top 300ms ease;
}
.menu.open { top: 0; }
```

**Why this is bad:** `top` / `left` / `width` / `height` are layout-affecting properties. Animating them forces the browser to re-compute layout for every animation frame, which counts toward CLS *and* burns main-thread time. Use `transform` (translate, scale) instead — it runs on the compositor and doesn't trigger layout. See [css-triggers.com](https://csstriggers.com/) for which properties trigger layout vs. paint vs. composite.

```css
/* Good — transform runs on compositor, no layout shift */
.menu {
  transform: translateY(-100%);
  transition: transform 300ms ease;
}
.menu.open { transform: translateY(0); }
```

## Flavor-specific notes

### EDS

EDS layout shift is usually a **loading-sequence / reveal-gating** problem, not a
per-element shim — see "(EDS) Lazy-section grow-in-place — fix the loading
sequence, not the element" and "Hydrated tab / accordion default-state mismatch"
above. The fix lands on the shared frontend (`scripts/scripts.js`,
`scripts/aem.js`, `styles/styles.css`) and ships site-wide, so **recommend it —
don't emit a per-page CSS gate.**

### CS

A CLS/layout fix on AEM CS gives you a runtime selector, but it has to land in the right layer —
and that is rarely obvious. The decision that matters most: **is the styling CSS actually in the
repo?** Many CS sites ship component CSS as **vendor-built content packages** (a compiled
`ui.frontend` or built `.all` packages), so that CSS is **not in Cloud Manager git** — a
source-faithful edit against the import is impossible. In that case the deliverable is an
**override clientlib in the customer's own `apps/`**, with its category embedded in the page
`<head>` *after* the vendor styles so `!important` wins — not an edit to HTL or to a clientlib
that doesn't contain the rule. Only when the rule is committed in the repo should you recommend a
direct edit. (Authored position/size flowing through a Sling model from a `_cq_dialog` is a
zero-code content change, but it repositions only — it won't fix an entrance/reflow shift.)
