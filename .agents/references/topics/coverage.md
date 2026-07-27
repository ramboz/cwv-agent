# JS/CSS Coverage Analysis

The Chrome DevTools Coverage API (exposed via Puppeteer as `page.coverage.startJSCoverage()` / `startCSSCoverage()`) reports, for every script and stylesheet the page loaded, which byte ranges were actually executed/used between `start` and `stop`. The analyzer at [`../../scripts/analyzers/coverage.js`](../../scripts/analyzers/coverage.js) collects this during an initial-load navigation and emits Findings per [finding-schema.md](./finding-schema.md).

## What it measures

- **JS**: every byte of executed script text across all V8 contexts. Unused bytes are code the V8 engine parsed but no function ever called during the observation window.
- **CSS**: every byte of every stylesheet. Unused bytes are selectors whose DOM matches were empty or selectors that never matched any element at rule-evaluation time.

The output per file: `{ url, totalBytes, usedBytes, unusedBytes, unusedPct }`.

## Accuracy caveats (important)

Coverage is a **snapshot of what ran during the observation window**, not a static analysis of dead code. Several false-positive patterns:

1. **Interaction-deferred code** — Event handlers, modals, dropdowns, and carousels won't run until the user scrolls, clicks, or types. They show as "unused" on initial load.
2. **Below-the-fold CSS** — A stylesheet that styles the footer isn't "used" if the footer didn't scroll into view before `stop`. This is why we set CSS thresholds (60% / 10KB) higher than JS (50% / 30KB).
3. **Polyfills & feature detection** — Code branches for older browsers may never execute on modern Chromium, but still need to be shipped for other users.
4. **A/B-test branches** — Only one variant runs; the others are "unused" but can't simply be removed.

Because of this, Coverage is tier 2 (lab) in the source hierarchy with a confidence cap of 0.85. Treat it as a **strong signal for investigation**, not a verdict. Cross-check large offenders against the HAR + runtime profile before recommending removal.

## Thresholds & heuristics

| # | Heuristic | Threshold | Finding shape |
|---|-----------|-----------|---------------|
| 1 | Unused JS per script | `unusedPct ≥ 50%` AND `totalBytes ≥ 30KB` AND render-blocking or pre-LCP | `type: waste`, metric `[LCP, TBT, INP]` |
| 2 | Unused CSS per stylesheet | `unusedPct ≥ 60%` AND `totalBytes ≥ 10KB` | `type: waste`, metric `[LCP, FCP]` |
| 3 | Aggregate critical-path waste | Sum of unused bytes on render-blocking JS+CSS ≥ 100KB | Single `type: waste, rootCause: true` summary with `coverage-row` evidence per offender |
| 4 | Vendor bundle signal | URL matches `/vendor\|chunk\|main\|bundle\|lib/i` AND `unusedPct ≥ 60%` | Adds a code-splitting recommendation to the per-script finding |

**Impact formula**: `valueMs = unusedBytes / 1024 * 10` — a rough 10ms-per-KB cost on slow-4G. Conservative enough to avoid inflating severity; gated below `MIN_ACTIONABLE_IMPACT` (200ms LCP) findings are emitted with `status: "rejected"`.

**Severity**: derived from `impactReduction.valueMs` vs `MIN_IMPACT.LCP.delta` by the shared validator — `high` at ≥ 3× floor (≥ 600ms), `medium` at 1–3×, `low` below.

**Confidence**: fixed at 0.75 (below the 0.85 coverage cap) to account for the false-positive patterns above. Upstream skills that cross-reference coverage with PSI or HAR may lift to 0.85 via `mergedSources`.

## How this composes with other analyzers

- **Waterfall-shift (Gap 1)**: a render-blocking script with 80% unused is both a `waste` finding here AND a `shift-right candidate` in the waterfall analyzer. Emit both — the diagnose skill deduplicates via `relatedFindingIds`. Coverage says "most of it is dead"; waterfall says "even if you keep it, push it later in the critical path."
- **PSI unused-javascript / unused-css-rules audits**: PSI runs its own Coverage-backed audits. When both fire, the diagnose skill should merge into one Finding with `mergedSources: ["psi", "coverage"]`, which allows lifting confidence to 0.85.
- **Resource-timing**: `coverage-row` evidence should be paired with `resource-timing` evidence when available so downstream fix patches (`block` + `preload` reshuffling) have the URL + priority context.

## Worked examples

### 1. Vendor bundle

```
URL: https://cdn.example.com/vendor.min.js
totalBytes: 620,000  unusedBytes: 495,000  unusedPct: 79.8%  renderBlocking: true
```

Fires both heuristic #1 (per-script JS waste) and heuristic #4 (vendor signal). Finding recommends code-splitting by route + lazy imports, valueMs ≈ 4,830. Severity: `high`.

### 2. Minified utility lib

```
URL: https://www.site.com/static/lodash.full.min.js
totalBytes: 72,000  unusedBytes: 61,200  unusedPct: 85%  renderBlocking: false, startTime<LCP: true
```

Fires heuristic #1. Finding recommends tree-shaking or switching to ES module `lodash-es` + per-function imports. valueMs ≈ 600. Severity: `medium`.

### 3. Over-inclusive stylesheet

```
URL: https://www.site.com/main.css
totalBytes: 180,000  unusedBytes: 153,000  unusedPct: 85%  renderBlocking: true
```

Fires heuristic #2 (CSS waste) AND contributes to heuristic #3 (aggregate). Per-sheet finding recommends critical-CSS extraction + async-load the rest. If summed with two other render-blocking files crossing 100KB, the analyzer also emits a single aggregate summary finding (`rootCause: true`) pointing at the top-three offenders.

## Cross-references

- [finding-schema.md](./finding-schema.md) — output contract
- [evidence-and-confidence.md](./evidence-and-confidence.md) — source tiers and confidence calibration
