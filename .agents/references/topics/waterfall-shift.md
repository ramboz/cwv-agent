# Waterfall Shift

A mental model and heuristic set for reading a network waterfall the way a
human would in Chrome DevTools, then deciding which resources to **shift
left** (pull earlier, before LCP) and which to **shift right** (push later,
after LCP). Every byte that crosses the LCP vertical line has to justify its
presence.

Consumed by `.agents/scripts/analyzers/waterfall-shift.js`. Cross-references:
[request-chains.md](./request-chains.md) (DEFERRABLE / CRITICAL lists),
[finding-schema.md](./finding-schema.md) (Finding output contract),
[metrics/lcp.md](./metrics/lcp.md) (LCP attribution phases).

---

## The shift-left / shift-right model

Draw an imaginary vertical line through your waterfall at `lcp.value` ms. The
goal for LCP optimization is:

- **Left of the line**: only critical resources — render-blocking CSS, the LCP
  image, above-fold fonts, first-party bootstrap JS. Everything else is tax.
- **Right of the line**: everything deferrable — analytics, consent, chat,
  monitoring, session replay, social pixels, below-fold content.

Each finding the analyzer emits is a proposal to move a resource across (or
toward) that line.

---

## Input: launcher output fields used

All fields come from `.agents/scripts/launcher.js` output, shape:
`{ url, profile, runs: [{ cwv, resources, timestamp }, ...] }`.

Per run:

- `run.cwv.lcp.value` — LCP in ms.
- `run.cwv.lcp.attribution.target` — CSS selector of the LCP element.
- `run.cwv.lcp.attribution.url` — URL of the LCP image (when present).
- `run.cwv.lcp.attribution.resourceLoadDelay` — the phase the preload hint fixes.
- `run.cwv.lcp.attribution.lcpEntry.startTime` — when LCP fired (ms).
- `run.resources.preLCP[]` / `run.resources.postLCP[]` — classified by `collect-resources.js`.
- `run.resources.renderBlocking[]` — entries with `renderBlockingStatus === "blocking"`.
- Each resource: `{ url, type, transferSize, duration, renderBlockingStatus, priority, initiatorType, startTime, domain }`.

---

## The five heuristics

### H1 — Shift-left candidates (preload)

**Trigger**: a resource in `preLCP[]` with `startTime > 500ms` whose `type ∈
{img, font, script}`, and either

- its `url` matches `cwv.lcp.attribution.url` (it IS the LCP resource), or
- it is a font whose domain matches a render-blocking CSS's domain (blocked
  on that CSS being fetched and parsed).

**Why it matters**: late discovery is pure latency debt. The browser didn't
learn about the resource until well into the page, so it loses the chance to
overlap its download with other critical work. A preload hint in `<head>`
lets the preload scanner fire the request alongside HTML parsing.

**Finding type**: `opportunity`, `patches.preloads`. Savings estimate:
`startTime − 100ms` (best-case: we could shave nearly all discovery delay),
then corrected by two bandwidth guards below.

**Bandwidth guards (petplace 2026-04-17 learning)**. H1 originally predicted
raw discovery-delay savings and historically over-estimated by 10× on
bandwidth-constrained profiles — petplace baseline predicted -2130ms; live
measurement was +203ms regression because the preload stole bandwidth from
render-blocking CSS, delaying FCP. Three guards now fire in order:

1. **Pre-FCP discovery guard**. If the LCP image's `startTime ≤ fcpValue`,
   the HTML parser already discovered the resource pre-paint — a preload
   adds no discovery benefit and only competes for bandwidth. Emit a
   rejected finding with `valueMs = 0` and a cause that points the
   investigator at `elementRenderDelay` / `resourceLoadDuration` instead.
2. **Bandwidth-corrected savings cap**. For the LCP image, cap savings at
   `resourceLoadDelay − (renderBlockingBytesPreLCP / effectiveBandwidth)`.
   Effective bandwidth is read from the launcher profile (see
   `.agents/scripts/profiles.js`); `mobile-slow4g-4xcpu` → 204.8 bytes/ms.
3. **Heavy render-blocking confidence de-rate**. When pre-LCP
   render-blocking payload ≥ 50KB, drop confidence from 0.75 to 0.55 so
   the ranker prefers other candidates. The cause string calls out the
   bandwidth-competition context.

**Worked example (passes)**: Hero image at `startTime=2200ms`, FCP=1800ms,
LCP=3400ms, 10KB of render-blocking CSS. 2200 > 1800 → guard 1 skipped.
`rld = 1920`, `rbTransferMs ≈ 50` → cap ≈ 1870. Raw = 2100. Finding emits
with `valueMs = 1870`, `confidence = 0.75`.

**Worked example (rejected — petplace)**: Hero image at `startTime=1989ms`,
FCP=2047ms. `1989 ≤ 2047` → guard 1 fires. Finding emits as
`status: rejected`, `valueMs = 0`, cause cites the pre-FCP discovery.
`rank-candidates.js` filters it out.

### H2 — Shift-right candidates (defer)

**Trigger**: entry in `renderBlocking[]` whose domain matches the DEFERRABLE
list (analytics / consent / chat / monitoring / session replay / social —
see `request-chains.md`), OR a third-party script with `priority=Low` or
`Medium` that is still render-blocking.

**Why it matters**: by definition these resources don't paint pixels. Their
presence on the critical path is an accident of `<script>` placement or
missing `async/defer`. Moving them right of LCP both reduces LCP and frees
main-thread time for the real critical path.

**Finding type**: `waste`, `patches.markup` (set `defer` attribute) +
`patches.block` (harness probe). Savings estimate: 10–30% of
`transferSize / 1000` as CPU ms recovered; analyzer uses 20%.

**Anti-rule**: never emit a preload for a deferrable resource. If H1 and H2
target the same URL, H2 wins — see `request-chains.md` anti-rule.

### H3 — Chain depth

**Trigger**: longest same-origin sequential chain inside `preLCP[]` of depth
≥ 3, where each subsequent script's `startTime` falls within
`[tail.responseEnd − 10, tail.responseEnd + 150]` ms.

**Why it matters**: serialized requests cost a full RTT each. On Lighthouse's
"Slow 4G" profile (150 ms latency), every extra hop beyond the 3rd adds
≈150 ms to LCP. Bundling, static imports, or preloading every level all
flatten the chain. The root initiator's classification (CRITICAL vs
DEFERRABLE) determines which tactic applies.

**Finding type**: `bottleneck`. Savings estimate:
`(depth − 3 + 1) × 150 ms`.

**Worked example**: `main.js → framework.js → blocks.js → hero.js` (depth 4)
costs ≈300 ms in chain tail alone. A preload bundle for all four levels lets
the browser fetch them in parallel while still executing in dependency order.

### H4 — Main-thread pre-LCP blocking (large JS)

**Trigger**: script in `preLCP[]` with `transferSize > 50 KB`,
`renderBlockingStatus !== "blocking"` (so H2 hasn't already grabbed it),
and `priority ∈ {High, VeryHigh}`.

**Why it matters**: a non-blocking script can still starve the main thread
during LCP paint if the browser prioritizes its execution. Parse + compile
cost is ≈1 ms per KB on mobile (slow-4G / 4× CPU), so a 200 KB bundle is
≈200 ms of LCP-relevant main-thread time.

**Finding type**: `bottleneck`, metrics `[LCP, TBT]`. Savings estimate:
`transferSize / 1024` ms (proxy for parse+compile).

Recommendation: code-split, defer the non-critical half, or lower
`fetchpriority` so the LCP paint is not preempted.

### H5 — LCP resource priority mismatch

**Trigger**: LCP target is an image (detected via `target` selector
matching `img|picture` OR `attribution.url` ending in an image extension)
AND the matching resource in `preLCP[]` has `priority ∈ {Low, Medium}`.

**Why it matters**: the browser preload scanner sets initial priority from
static markup before the layout phase knows which element will be LCP. If
the LCP `<img>` lacks `fetchpriority="high"` (or is inside a lazy-loaded
wrapper), the scanner defaults it to low — costing a chunk of
`resourceLoadDelay`.

**Finding type**: `opportunity`, `patches.markup` (set `fetchpriority=high`)
plus a belt-and-braces `patches.preloads`. Savings estimate:
`attribution.resourceLoadDelay` (or `startTime − 100` fallback).

**Worked example**: a carousel hero with `loading="lazy"` on the first
slide. Remove `loading=lazy`, add `fetchpriority=high`, and preload the URL.

---

## Chain depth vs RTT on slow-4G

The launcher's `mobile-slow4g-4xcpu` profile pins latency at 150 ms.
Every serial leg of a request chain pays:

1. Discovery (script must finish executing before next request).
2. DNS (if cross-origin and not preconnected).
3. TCP + TLS handshake (if a new connection).
4. First byte RTT.

Only (1) and (4) are unavoidable in the best case. (4) alone is 150 ms per
hop, which is why the analyzer uses 150 ms/hop as its savings coefficient
for H3.

---

## Preload scanner priority: why it gets LCP wrong

The preload scanner runs before the main parser and assigns a priority per
resource using static heuristics:

- `<img>` in markup → **Low** (unless `fetchpriority=high` is set).
- `<img loading="lazy">` → **VeryLow**, and the scanner skips discovery until
  layout.
- `<link rel=preload as=image>` → **High**.
- `<script>` (blocking) → **High**.
- `<script async>` / `<script defer>` → **Low**.

The LCP element, if it is the first real content image, is usually the one
the scanner guessed wrong. `fetchpriority="high"` is the one-line fix.

Reference: Chrome Priority Hints design doc, and the `priority` field on
`PerformanceResourceTiming` (surfaced by `collect-resources.js` as
`resource.priority`).

---

## Tier and confidence calibration

The analyzer defaults to `source: "perf_observer"` — tier 2, lab-only data,
confidence capped at 0.85. Individual heuristics set their own ceilings:

- H1 (preload candidate): 0.75 — strong resource-timing evidence.
- H2 (defer candidate): 0.75 — domain match is categorical.
- H3 (chain depth): 0.70 — "chain" is inferred from timing gaps.
- H4 (large JS): 0.65 — main-thread blocking is an inference.
- H5 (priority mismatch): 0.80 — LCP element + priority is a direct read.

Findings below the LCP `MIN_ACTIONABLE_IMPACT` floor (200 ms) are emitted
with `status: "rejected"` so the lifecycle graph preserves the signal.
