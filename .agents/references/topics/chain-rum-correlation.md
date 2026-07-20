# Chain-to-RUM Correlation

Bridges field signal (Helix RUM Bundler) and lab evidence (launcher output with
`resources` + `cwv` attribution) into a single finding that carries both
"users feel it" and "here is the cause." The output is emitted by
`.agents/scripts/analyzers/chain-rum-correlator.js`.

## Why field+lab fusion matters

- **Lab alone** may flag a render-blocking script or a low-priority image that
  no real user is slow on — form-factor and network conditions in the lab do
  not always represent the median user. Fixing a lab-only symptom moves no
  field metric.
- **Field alone** tells you *whether* a metric is failing (CrUX/RUM p75) but
  not *why*. The RUM bundle carries interaction target selectors and LCP
  element hints but no waterfall, attribution phases, or resource priorities.
- **Fused findings** pair a RUM element with the lab resource/chain that best
  explains it. Confidence rises (source tier 1, field) without losing the
  concrete mechanism a diagnose skill can patch.

Rule of thumb: if a finding emitted by a lab-only analyzer (e.g.
`waterfall-shift`) names a resource that the RUM bundle also implicates by
element target, the chain-rum-correlator finding supersedes it via
`mergedSources: ["rum", "har"]` and takes precedence in ranking.

## The eight heuristics plus CSP diagnostics

### C1 — INP element → LoAF culprit script or deferrable chain

Fires when the RUM URL p75 INP > 200 ms. For each interaction target selector
in `siteWide.inp.topSlow`:

1. Try to match the selector against `cwv.inp.attribution.interactionTarget`
   from the lab run (loose match on tag + class/id; see caveats).
2. If `cwv.mainThread.loaf[]` overlaps the lab interaction window, rank the
   LoAF `scripts[]` by blocking duration and emit a `source: "perf_observer"`
   finding with `long-animation-frame` evidence naming the blocking script URL.
   See [`loaf.md`](./loaf.md).
3. If no LoAF script evidence is available, scan `resources.preLCP` +
   `resources.postLCP` for scripts whose domain is
   in the DEFERRABLE list (analytics, tag managers, A/B testing,
   session replay — same list as `waterfall-shift` H2).
4. Emit a Finding with:
   - `source: "perf_observer"` when LoAF identifies the culprit script, else
     `source: "rum"` for the RUM/HAR fallback.
   - `mergedSources: ["rum", "har"]` when the lab target matched, else
     `["rum"]`; LoAF-backed findings use `["rum", "perf_observer"]`.
   - Evidence: `rum-bundle` (primary) + `cwv-attribution` (if lab matched)
     + either `long-animation-frame` or one `resource-timing` per suspected
     fallback script.
   - `impactReduction.valueMs` from top LoAF blocking duration, or
     `min(200, sum(chain_transferSize_kb) * 2)` for fallback.
   - Confidence ≤ 0.85 for LoAF-backed `perf_observer`, ≤ 0.90 for lab-matched
     RUM/HAR fallback, or ≤ 0.75 for RUM only.

**Worked example.** RUM shows `button.cta` with p75 INP 620ms at
`www.example.com/pricing`. Lab attribution lists `BUTTON.cta`. Pre/post-LCP
scripts include `googletagmanager.com/gtm.js` (55KB), `google-analytics.com`
(48KB), `cdn.optimizely.com` (90KB). Finding recommends deferring all three;
estimated INP saving 200ms (capped).

### C2 — LCP element → late/low-priority resource

Fires when RUM URL p75 LCP > 2500 ms. For each LCP sample:

1. Match `rum.target` against `cwv.lcp.attribution.target` (selector match).
2. Find the lab LCP resource: prefer `cwv.lcp.attribution.url`, else largest
   `resources.byType.img` in `preLCP`.
3. Require the lab resource to be *suspicious*: `priority` is `Low`/`Medium`,
   OR `renderBlockingStatus === 'non-blocking'`, OR started >50% into LCP
   time.
4. Emit Finding: `metric: ["LCP"]`, `type: "bottleneck"`,
   `mergedSources: ["rum", "har"]`. Evidence: `rum-bundle` +
   `cwv-attribution` + `resource-timing`. `patches` carries both
   `markup` (`fetchpriority="high"`) and `preloads`.
5. `impactReduction.valueMs = attribution.resourceLoadDelay` (or
   `max(0, startTime - 100)` fallback).
6. Confidence ≤ 0.90.

### C3 — CLS element → missing-dimensions image

Fires when RUM has any CLS sample ≥ 0.05 OR siteWide CLS p75 ≥ 0.1. RUM
`topSlow` rows are raw worst-case samples, so first resolve each row to a
selector (prefer the lab `largestShiftTarget` when field CLS has no target) and
aggregate rows by selector. Emit one C3 finding per selector, not one per raw
sample.

1. If the target looks like an `<img>`, find the suspected culprit in
   `resources.byType.img` — prefer a url that also appears in `htmlFindings`
   with a rule-violation like `img-missing-dimensions`; else match by
   `cwv.cls.attribution.url`; else the first image.
2. Emit Finding: `metric: ["CLS"]`, `type: "opportunity"`,
   `impactReduction.score = max_shift_value_for_selector`.
3. `mergedSources`: `["rum"]` + `"har"` (if lab attribution present) +
   `"html"` (if `htmlFindings` was supplied and matched).
4. `rum-bundle` evidence includes `sampleAggregation` with `{selector, count,
   min, max, values}` so the field distribution remains visible.
5. Confidence ≤ 0.85 (lab match) or ≤ 0.70 (RUM only).

`htmlFindings` is optional; C3 still fires without it, but at lower
confidence and `rootCause: false`.

### C4 — Field/lab disagreement meta-findings

For each metric (LCP, INP):

- `lab_value / rum_p75 < 0.5` → lab is far better than field. Likely
  personalization, auth state, A/B variant, geo CDN difference, or lab
  throttling too lenient.
- `lab_value / rum_p75 > 1.5` → lab is far worse. Throttling too aggressive
  or real users have better devices.

Emit `type: "opportunity"`, `severity: "low"`, `status: "draft"`,
`impactReduction: { valueMs: 0 }` (meta; no concrete patch). These findings
steer the analyst — they are not fix candidates.

### C5 — Lab INP interactions from event log

Fires on every run that has `cwv.inp.interactions` populated by
`measure-cwv.js` (raw PerformanceEventTiming event log, grouped by
`interactionId`). For each interaction with `duration ≥ MIN_IMPACT.INP.delta`
(50 ms), top 5 by duration:

1. Compute phase breakdown from the grouped entry:
   - `inputDelay = processingStart - startTime`
   - `processingDuration = processingEnd - processingStart`
   - `presentationDelay = (startTime + duration) - processingEnd`
2. Dedupe against existing C1 findings by `normalizeSelector(target)` —
   RUM-driven findings (source tier 1) take precedence over lab-only
   (source tier 2).
3. Emit Finding: `source: "perf_observer"`, `metric: ["INP"]`,
   `type: "bottleneck"`, confidence cap 0.85. Evidence carries the raw
   interaction entry with name/duration/target/phase split.

C5 fires regardless of RUM availability — `chain-rum-correlator` works in
pure lab mode when `rumBundle` is null. Useful when real users can't be
queried yet (pre-launch, local dev) but you still want event-granular
prioritization over the single worst-interaction web-vitals summary.

### C7 — Font-face descriptors → text-LCP / font-CLS

Fires on every run that has a `fonts` block from `collect-fonts.js`. It looks
for swap-risk faces (`font-display: swap`, `auto`, or unset) that appear in the
computed font stack for representative text elements.

Text-LCP path:

1. Read `cwv.lcp.attribution.element` and require a text selector leaf
   (`h1`-`h6`, `body`, `p`, `button`, or `a`).
2. Match that selector to `fonts.usedFonts[tag]`, then match the computed stack
   against `fonts.faces[].family`.
3. Require high lab LCP or high `elementRenderDelay`.
4. Emit a `source: "perf_observer"` LCP finding capped at 0.85 confidence.

Font-CLS path:

1. Walk `cwv.cls.shifts[]`.
2. For each non-input shift above `MIN_IMPACT.CLS.delta`, inspect its text
   sources.
3. Match the text source's computed stack to a swap-risk face.
4. Emit a `source: "perf_observer"` CLS finding capped at 0.85 confidence.

Evidence includes `cwv-attribution` plus `font-face` with the descriptor set and
the missing metric overrides. The recommendation is to add a size-adjusted
fallback face (`size-adjust`, `ascent-override`, `descent-override`,
`line-gap-override`) immediately after the brand face in the stack. See
[`fonts.md`](./fonts.md).

### C8 - Lab transport/cache signal

Fires on every run that has `resources` from `collect-resources.js`; no RUM
bundle is required. C8 turns protocol/cache/TTFB clues into measured HAR-tier
findings instead of asking the analyst to infer them from a slow aggregate TTFB.

1. Read `resources.all[]` (subresources plus the top-level navigation timing
   entry when exposed) and the derived buckets:
   - `resources.http1[]` for `nextHopProtocol` values matching `http/1.x`;
   - `resources.cdnCacheMiss[]` for `serverTiming` names that look like
     cache/CDN/edge and descriptions that look like `MISS`, `expired`,
     `stale`, `bypass`, `revalidate`, or `fwd=uri-miss`.
2. Emit an HTTP/1.x connection finding when a render-blocking or pre-LCP
   resource is served over HTTP/1.x. Evidence is one `resource-timing` row per
   offending resource, including URL, protocol, duration, TTFB, and
   `serverTiming` when present.
3. Emit a CDN/cache miss finding when a navigation or critical-path resource has
   a cache-miss server-timing signal and `ttfb >= 800ms`.
4. Emit a slow per-resource TTFB finding for any resource with
   `ttfb >= 800ms`, even when cache status is unknown. Suppress generic
   slow-TTFB duplicates for URLs already explained by the more specific
   CDN/cache-miss finding.
5. Do not infer a cache miss from absent `serverTiming`. Cross-origin resources
   without `Timing-Allow-Origin` often expose no server timing; C8 treats that
   as unknown and only emits cache-miss findings from explicit server-timing
   evidence.

All C8 findings use `source: "har"` and stay under the HAR confidence cap
(0.85). They normally omit `patches` because protocol, CDN cache policy, and
origin latency are server/CDN configuration or backend-source work rather than
CDP-mutatable DOM changes.

### CSP diagnostics — blocked lab patches

The correlator also reads `runs[].cwv.cspViolations[]` from `measure-cwv.js`.
This is not a standalone CWV Finding path. A violation on a baseline run is
kept as `diagnostics.csp.violations` for context only.

When a patched run has `launcherOutput.appliedPatches` (or an explicit
`patchBundle`) and a violation's `blockedURI` matches a patched resource, the
match is added to `diagnostics.csp.blockedPatches`. If an emitted Finding's own
`patches` object matches the same blocked URI, the Finding gains
`csp-violation` evidence. Treat this as a failed-treatment explanation: the
patch may have been blocked by CSP, so "no metric movement" is not enough to
call the hypothesis causally inert. See [`csp.md`](./csp.md).

### C6 — Lab CLS shifts from event log

Fires on every run that has `cls.shifts` populated. For each shift with
`value ≥ MIN_IMPACT.CLS.delta` (0.03) AND `!hadRecentInput`
(user-initiated shifts are excluded by web-vitals scoring), top 5 by score:

1. **Classify every source by grown-vs-moved.** The browser's
   `LayoutShift.sources[]` includes BOTH the element that grew and the
   elements that were pushed by that growth (the victims). Compare
   `previousRect` with `currentRect`:
   - `grew` if `currentRect.height - previousRect.height > 1px`
     (epsilon to ignore sub-pixel noise)
   - `moved` if `|currentRect.y - previousRect.y| > 1px` and the height
     is unchanged
2. **Prefer the grown source as `attribution.target`.** The element that
   grew is the root cause of the shift; the moved elements are victims.
   When multiple sources grew in the same frame, pick the one closest to
   the document start (smallest `previousRect.y`) — injection banners
   typically live near the top and push everything below.
3. **Fallback: no source grew.** Rare — e.g. explicit margin changes,
   transform animations, font-swap reflow. Fall back to the widest-rect
   source and set `evidence.data.shiftWithoutGrowth = true` so the
   reader knows this isn't the typical injection-shift pattern. The
   recommendation text changes too (investigate animations / font-swap
   instead of "reserve space for injection").
4. **Preserve the victim for traceability.** Record the first moved
   source under `evidence.data.movedTarget`. This keeps the full
   cause/victim chain visible in the finding without mutating the
   schema.
5. **Dedupe** against existing C3 findings by normalized selector.
6. **Emit Finding:** `source: "perf_observer"`, `metric: ["CLS"]`,
   `type: "opportunity"`. Evidence carries the
   shift entry plus `{target, movedTarget, shiftWithoutGrowth,
   previousRect, currentRect, otherTargets, loadState}`. Patch defaults
   to `min-height` on the grown element.
7. **`rootCause` + confidence (G3 — runtime shift sources are authoritative).**
   A confirmed grown-source shift is the strongest possible CLS attribution —
   the browser *observed* this element grow and produce a measured shift — so it
   sets **`rootCause: true`** at the `perf_observer` cap (**0.85**). This is the
   authoritative CLS analyzer; static element guesses (e.g.
   `html/img-missing-dimensions`) are demoted to `rootCause: false` hypotheses
   that this finding confirms or overrides. A pure-repositioning shift
   (`shiftWithoutGrowth: true`) is a *victim* pushed by an unidentified cause, so
   it stays **`rootCause: false`** at a lower confidence (0.65).
8. **Animated-reveal mechanism classifier (V5 — `detectAnimatedReveals`).** Run
   once over **all** `cls.shifts[]` (not just the significant ones — the growth
   spans many sub-0.03 frames). It groups every source by `target` across frames
   and tags a target `mechanism: "animated-reveal"` when it shows either:
   - **`monotonic-growth`** — `currentRect` width AND height non-decreasing across
     **≥3** consecutive frames with meaningful net growth in both (a width/height
     tween, e.g. jQuery `.show(duration)` / `.slideDown()`); or
   - **`appears-from-zero`** — the first frame's `previousRect` is ~0×0 in **both**
     dims (revealed from `display:none`), present across **≥2** frames.

   A **single** one-time grow-from-0 is deliberately *not* flagged — that's the
   generic unsized-element / late-injection case step 6's "reserve space" advice
   already covers; flagging it would mislabel ordinary CLS. When the C6 finding's
   `primary.target` matches a reveal, the `cause` names the mechanism, `evidence.data`
   gains `{mechanism, revealSignal, revealSteps, finalRect}`, the patch reserves the
   **final** size (`finalRect.height`, not the captured mid-animation frame), and the
   recommendation switches to: *render at final size from first paint and animate only
   `transform`/`opacity`; never animate `width`/`height`/`display` or use jQuery
   `.show(duration)`; for conditional reveals toggle a class or use `@starting-style` +
   `transition-behavior: allow-discrete`.*

Worked example — the news-site case consent banner 2026-06-10 (animated-reveal, V5):

```
The banner is revealed by jQuery .show(duration), which tweens its box over ~6 frames:
  t=26212  110×35   → 353×114
  t=26236  353×114  → 696×225
  t=26259  696×225  → 1069×346     ← the significant (0.045) frame that emits the C6 finding
  t=26274  1069×346 → 1269×411
  t=26290  1269×411 → 1426×462
  t=26307  1426×462 → 1514×490     ← final size
```

`detectAnimatedReveals` flags `section.cookies__container` as `monotonic-growth` (6
steps, 110×35 → 1514×490). The C6 finding tags `mechanism: "animated-reveal"`, reserves
`min-height:490px` (the **final** size — the emitting frame was only 346px tall), and
recommends animating `transform`/`opacity` instead of the size — matching the hand
diagnosis (the as-shipped position-pin override was causally inert; the real fix is the
entrance animation). The sibling close-button (`64×64` every frame — no growth) and the
accept/settings buttons (one frame each) are correctly **not** flagged.

Worked example — the pets-site case 2026-04-17:

```
Before:
  <header class="site-header">    y=0    h=80
  <main id="main">                y=80   h=1200

After promo banner injects into header:
  <header class="site-header">    y=0    h=160   ← GREW (+80)
  <main id="main">                y=160  h=1200  ← MOVED (+80)
```

`LayoutShift.sources[]` lists both. The pre-fix heuristic picked
`main#main` (victim) and suggested `min-height` on `<main>` — a no-op,
because `<main>`'s height never changed. The correct attribution is
`header.site-header` (grown), and the patch reserves space there
(`min-height:160px` or a pre-rendered placeholder of the banner's final
dimensions). `evidence.data.movedTarget = "main#main"` preserves the
victim chain.

Like C5, C6 runs in lab-only mode. It also surfaces secondary shifts that
C3 misses — web-vitals attribution only reports the largest single shift,
but a session can have multiple independent shifts above the 0.03
actionable threshold that each deserve their own finding.

## Selector matching caveats

Lab and RUM capture selectors at different times and from different runtimes,
so exact-string match is fragile. The correlator uses a loose comparison:

- **Leaf-only.** Only the last compound selector is compared
  (`div#main > button.cta` → `button.cta`). Ancestor paths are unreliable
  because RUM beacons often truncate and lab snapshots capture the full path.
- **Tag + class/id token match.** Match if tag names agree (when both
  specified) and at least one class or id token overlaps. `IMG.hero` and
  `img.hero` match; `button.cta.primary` and `button.cta` match;
  `button.cta` and `button.submit` do not.
- **Ignore positional indexes** (`:nth-child(N)` stripped). Positional
  selectors are fragile: DOM shape differs between lab snapshot and
  aggregated RUM.
- **No DOM walk.** The correlator does not reach into a lab DOM snapshot to
  re-query; match is string-shape only.

When a match fails, the correlator still emits the RUM-only finding at lower
confidence so the analyst can investigate.

## Composing with waterfall-shift

When both analyzers run and both flag the same deferrable script or same LCP
image:

- The chain-rum-correlator finding is **preferred** — its `source: "rum"`
  gives a higher confidence cap (0.95) than `perf_observer` (0.85), and
  `mergedSources: ["rum", "har"]` records that the lab finding is
  corroborated.
- Skills orchestrating both analyzers SHOULD dedupe by resource URL: if a
  `chain-rum-correlator` finding cites a resource URL that a
  `waterfall-shift` finding also cites, drop the `waterfall-shift` one or
  append its id to `relatedFindingIds`.
- When only `waterfall-shift` flags it (no RUM signal on that URL), keep
  the `waterfall-shift` finding — lab-only findings are still actionable
  when RUM is missing or below sample size.

## Source-tier reminder

`source: "rum"` is tier 1 (field), cap 0.95. The correlator emits at most
0.90 on any single finding because per-element correlation carries some
uncertainty (the RUM beacon and the lab run are not measuring the same
session). Skills that consume these findings MUST NOT promote confidence
above 0.90 without adding a `measurement-delta` evidence entry from a
validate run.

## Real-world validation — 2026-04-16 (www.cox.com, 930 bundles / 3 days)

First live run against a Helix-instrumented production site exposed three
shape gaps the fixture tests couldn't have caught. All are now handled in the
correlator; they're documented here so future work knows where live data
deviates from the idealized shape.

**Helix bundle event semantics (measured on raw bundles, not through rum-fetch.js):**

The Helix collector uses two general-purpose fields on every event:

- `source` = DOM selector of the element involved (when applicable).
- `target` = destination URL (for nav/click) or a flag/value (for
  consent/a11y/language). NOT a DOM selector.

Per-metric attribution, measured across 525 aetna.com bundles 2026-04-14:

| Event         | total | has `target` | has `source` | What this means |
|---------------|-------|-------------:|-------------:|-----------------|
| `cwv-lcp`     | 292   | 55%          | **100%**     | Every LCP event carries the LCP element's selector in `source`. |
| `cwv-inp`     | 223   | 0%           | 0%           | The event itself is just `{value, timeDelta}` — but the bundle also contains `click` events with full element attribution. |
| `cwv-cls`     | 224   | 0%           | 0%           | Only `{value, timeDelta}` — the collector does not beacon per-shift element info at this version. No recovery path. |
| `click`       | 692   | URL          | selector     | Universal. `target` is the navigation destination; `source` is the clicked element. |

**Consequence per heuristic — corrected picture:**

- **C1 (INP chain):** Attribution IS recoverable for most interactions. Each
  bundle has ~3× more clicks than cwv-inp events, and every click carries a
  `source` selector. The join is: for each cwv-inp, find the click in the same
  bundle whose value/timing best matches the INP. `cwv-inp.timeDelta` is the
  *report* time (often visibilitychange), not the interaction time — so the
  correlation window needs to be several seconds, not ±100ms. Today C1 is
  silent on all Helix sites because `rum-fetch.js` uses too narrow a window
  AND reads the wrong field (`target` instead of `source`). Fixing
  `rum-fetch.js` should unlock C1 broadly.
- **C2 (LCP resource):** Every `cwv-lcp` event has an element selector in
  `source`. Today `rum-fetch.js` drops it — the `topSlow` lcp array comes
  out empty even though the raw data is fully populated. This is an
  extraction bug, not a collector limit. Fixing it unlocks C2 RUM-side
  matching on every Helix site.
- **C3 (CLS element):** Genuinely stuck at the collector boundary. No
  per-shift element info is emitted. C3 falls through to "rum-only" low
  confidence; C6 (lab PerformanceObserver shifts) is the real fix path.
  Upgrading the Helix RUM collector to beacon `LayoutShiftAttribution.node`
  per shift is the only way to improve this.
- **C4 (field/lab disagreement):** Extended to cover CLS (originally LCP/INP
  only). Live data produced a legitimate LCP disagreement finding (lab 8417ms
  vs field 4168ms, ratio 2.02) recommending throttling-profile review, and
  on aetna flagged a 29× CLS disagreement (field 0.58 vs lab 0.02 stub).

**`rum-fetch.js` extraction fixes — LANDED 2026-04-16:**

1. **LCP** reads `ev.source` directly. Post-fix target coverage: 100% of
   `topSlow` rows across 5 Helix sites (was 0%).
2. **INP** joins each `cwv-inp` to the nearest-time interaction event in the
   same bundle via `findBestInteraction()`. The scorer weights before-report
   interactions 2× (matches the normal report-after-interaction flow) and
   requires the interaction to have a `source` selector. Post-fix INP join
   recovery across 5 sites: 70% (adobe) / 94% (lexmark) / 96% (aetna) /
   98% (fcsamerica, metrobyt). Bundles with no interactions still emit the
   INP sample (so p75 stays correct) but omit `target`.
3. **CLS** samples emit no `target` field at all. The `summarizeMetric`
   output omits `target` conditionally so downstream consumers don't
   special-case a sentinel string. The `isUnknownTarget()` filter in the
   correlator stays as defensive coverage for older cached bundles.

Post-fix correlator behavior on aetna.com: C2 (LCP resource) fires with
`source: "rum"` and `confidence: 0.9`, citing the actual LCP element
(`#content__main img`) instead of matching against a null. C1 (INP chain)
remains gated on URL p75 INP > 200 ms; it stayed silent on aetna because
site-wide INP p75 is 72 ms — but when a URL does cross the threshold, the
attribution is now available instead of "unknown".

Remaining collector-side gap (not fixable client-side): `cwv-cls` events
carry no `LayoutShiftAttribution.node`. Until the Helix collector beacons
per-shift element info, C3 continues to rely on lab data (C6) for CLS
attribution. File this as an upstream ask if/when CLS attribution becomes
load-bearing for the workflow.

## Cross-references

- [`finding-schema.md`](./finding-schema.md) — source tiers, evidence kinds,
  MIN_ACTIONABLE_IMPACT gates, lifecycle transitions.
- [`rum.md`](./rum.md) — Helix RUM Bundler API and response shape.
- [`request-chains.md`](./request-chains.md) — CRITICAL/DEFERRABLE/MIXED
  classification used to pick INP chain suspects.
- [`csp.md`](./csp.md) — CSP violation capture and failed-patch evidence.
- [`waterfall-shift.md`](./waterfall-shift.md) — lab-only analyzer this
  correlator composes with.
- [`field-vs-lab.md`](./field-vs-lab.md) — rationale for C4 disagreement
  detection; field/lab ratio interpretation table.
