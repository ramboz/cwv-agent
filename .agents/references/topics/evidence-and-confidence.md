# Evidence and Confidence

Every CWV finding this toolkit produces must follow a structured reasoning template, be scored with a calibrated confidence value, and clear both improvement and metric-severity thresholds before being reported. This document is the canonical reference for all three.

## Chain-of-Thought format (MANDATORY)

For EVERY finding, produce four sections in this exact order:

```
Observation: [what the data shows, with concrete numbers]
Diagnosis:   [what performance issue this causes]
Mechanism:   [why this causes the issue, technically]
Solution:    [specific actionable fix with implementation path]
```

Rules:

- Be concrete. Cite file names, byte sizes (KB), timings (ms), metric values, CSS selectors, specific URLs.
- Reference exact data sources: HAR entry, web-vitals attribution field, PSI audit name, coverage row.
- Connect observations to specific metric impacts (LCP ms, CLS score, INP ms) — not "improves performance."
- Mechanism must explain the causal chain: why does this observation cause this diagnosis?
- Solution must be actionable — WHAT to change and HOW, not just "fix it" or "add async."

### Good example

```
Observation: HAR shows /hero.jpg fetched at t=1850ms; web-vitals LCP
             attribution.resourceLoadDelay=1400ms. The image is 320KB,
             JPEG, served from the same origin as the HTML.
Diagnosis:   LCP image discovered late — not present in initial HTML,
             no preload hint, not referenced before render-blocking CSS.
Mechanism:   Browser parses render-blocking CSS (~1.2s on slow 4G) before
             discovering the <img> tag. That 1.4s discovery gap is pure
             LCP cost — the image itself only takes ~400ms to download once
             found.
Solution:    Add <link rel="preload" as="image" href="/hero.jpg"
             fetchpriority="high"> in <head>, before the render-blocking CSS.
             Expected LCP improvement: ~1200ms (removes discovery gap,
             parallelizes with CSS).
```

### Bad example (do not do this)

```
Observation: Site has a slow hero image.
Diagnosis:   Images are slow.
Mechanism:   It takes time to download.
Solution:    Optimize the image.
```

No numbers. No selector. No mechanism. No specific fix. This is not a finding — it's a complaint.

## Confidence scale

Attach a confidence score (0.0 – 1.0) to every finding. Use the calibration below. The score is also a field in the [Finding schema](./finding-schema.md) — skills and the validator enforce source-tier caps on it.

| Range | Meaning | Examples |
|-------|---------|----------|
| 0.9 – 1.0 | Direct measurement | web-vitals attribution field, HAR timing for a specific resource, CrUX p75 from the API, Performance Observer entry |
| 0.7 – 0.8 | Strong audit signal | PSI audit with explicit savings estimate (e.g. `unused-javascript` with `wastedBytes`), Coverage showing >30% unused on a loaded resource |
| 0.5 – 0.6 | Inference | Pattern match without direct measurement ("this looks like a third-party chain because domain X and depth Y"), static code smell, HTML hint missing |
| < 0.5 | Speculative | Guess, single weak signal, no measurement backing — **SUPPRESS. Do not report.** |

When you have multiple weak signals that corroborate each other, you may raise confidence by ~0.1 — but cap at the best single piece of direct evidence. Never claim 0.9+ confidence without a measurement.

## Filtering thresholds

A finding must clear BOTH the improvement threshold AND the metric-severity threshold to be worth reporting. The toolkit is intentionally biased toward suppressing low-signal noise.

| Metric | Improvement ≥ | AND current value > |
|--------|---------------|---------------------|
| LCP    | 300 ms        | 2.8 s (300ms worse than "good" 2.5s) |
| CLS    | 0.05          | 0.12                |
| INP    | 100 ms        | 250 ms              |
| TTFB   | 200 ms        | 1.0 s               |

Do NOT report:

- Metrics already in the "good" bucket (LCP <2.5s, CLS <0.1, INP <200ms).
- Micro-optimizations with <100ms expected impact on mobile.
- Generic best-practice advice that doesn't address a measured problem on this page.
- Image optimizations saving <50KB or <200ms.
- Speculative optimizations without clear evidence of impact (confidence <0.5).

If nothing clears these thresholds, the correct output is "no findings" — don't pad.

## Severity taxonomy

Every finding is one of three types:

- **`bottleneck`** — on the critical render path; directly blocks a metric right now. Examples: render-blocking script in `<head>` before LCP element, long task pre-LCP, slow TTFB from a CDN cache MISS, CLS from above-fold unsized image.
- **`waste`** — unused code/bytes loaded before LCP (opportunity for savings ≥30KB). Not blocking per se, but costs bandwidth and parse time. Examples: tree-shakeable library imported in full, unused CSS rules in critical bundle.
- **`opportunity`** — missing optimization hint. Examples: missing `fetchpriority="high"` on hero image, missing preload, unused `async` candidate, missing dimensions on below-fold image (not currently shifting but might).

Order findings in reports: bottleneck first (blocking), then waste (quantifiable savings), then opportunity (hygiene).

### Root cause vs symptom

Tag each finding:

- `rootCause: true` — the fundamental issue ("full lodash import instead of tree-shaken pick").
- `rootCause: false` — observable effect ("LCP is 4.2s").

Reports should connect symptoms to root causes with explicit links, not list both as independent findings.

## Field vs lab signal priority

When field data and lab data conflict, field wins for "is this a real problem" — lab wins for "what specifically causes it."

1. **CrUX (28-day real-user p75)** — ground truth for "is this metric failing in production."
2. **RUM (7-day, page-specific)** — catches recent regressions; higher granularity than CrUX.
3. **PSI / Lighthouse (synthetic lab)** — reproducible, attributable; needed to identify root cause.
4. **Local Lighthouse** — lowest trust; environment varies.

Interpretation rule: if lab is >2× better than field (e.g. PSI LCP 2.0s but CrUX p75 4.5s), there's an environmental mismatch — likely personalization, A/B tests, logged-in state, or real-device cost the lab doesn't model. Investigate with multiple synthetic profiles before concluding.

If lab is worse than field, the lab profile is too aggressive — trust field.

## Impact estimation

- Quantify every estimate in concrete units (ms, KB, score delta). Never "improves performance."
- Show your calculation when non-obvious (e.g. "resourceLoadDelay is 1400ms; preload removes most of it → expect ~1200ms LCP improvement with 80% conversion efficiency from cascade effects").
- Be conservative — under-promise. Real-world improvements typically capture 60-80% of lab estimates due to cascade effects (FCP → LCP isn't 1:1).
- Account for interaction with other findings. If two fixes target the same bottleneck, don't double-count savings.

## Source-Tier Confidence Model

The confidence scale above reflects agent-side judgment: "how strong is my reasoning on this specific finding?" The source-tier model adds a second axis: "how reliable is the class of evidence this came from, regardless of how airtight it looks?"

Use both. The finding's effective confidence is `min(agent_judgment, source_tier_cap)`. You can't have 1.0 confidence from a pattern match even if every signal aligns — the measurement class doesn't support that certainty.

| Tier | Source | Max confidence |
|------|--------|----------------|
| Field | CrUX (real-user 28-day p75) | 0.95 |
| Field | RUM (real-user 7-day, page-specific) | 0.95 |
| Lab | PSI / Lighthouse | 0.85 |
| Lab | HAR (network trace) | 0.85 |
| Lab | PerformanceObserver entries | 0.85 |
| Lab | JS/CSS coverage | 0.80 |
| Static | HTML pattern matching | 0.75 |
| Static | Heuristic rules (this toolkit's `rules.md`) | 0.75 |
| Speculative | Code-level inference (source read, guessed flow) | 0.65 |
| Unknown | Source not classifiable | 0.60 |

Rationale: Field tells you it IS happening. Lab tells you what's CAUSING it — under lab conditions, which may diverge from reality. Static analysis tells you what MIGHT cause it based on code patterns. Speculative is informed guessing.

When computing a finding's final confidence:

1. Start with your agent-judgment confidence from the scale at the top.
2. Identify the source tier of the strongest piece of evidence.
3. Cap at that tier's max.
4. If the source is speculative AND your raw confidence was > 0.8, multiply the capped value by 0.85 (speculative-high-confidence penalty — prevents inflated certainty on inference).

## Minimum Actionable Impact Thresholds

This is a second, independent gate on top of the "Filtering thresholds" table above. The two gates answer different questions:

- **Filtering thresholds (above)** — "Is this page's metric bad enough AND is the improvement large enough to be worth a human reading the report?" This is a triage gate. It suppresses findings on pages that are already fine.
- **MIN_ACTIONABLE_IMPACT (below)** — "Regardless of how bad the page is, is THIS specific fix large enough to be worth surfacing as a separate finding?" This is an anti-noise gate. It suppresses micro-optimizations even when the page is genuinely slow.

Apply **both**. A finding must clear both gates. Effectively: `keep if improvement >= max(filtering_gate[metric], MIN_ACTIONABLE_IMPACT[metric])` — or equivalently, drop if either gate rejects.

| Metric | MIN_ACTIONABLE_IMPACT |
|--------|------------------------|
| LCP    | 200 ms                 |
| CLS    | 0.03                   |
| INP    | 50 ms                  |
| TBT    | 100 ms                 |

Example: a page with LCP = 5.2 s (clearly failing). A finding claims 150 ms improvement. The filtering gate requires ≥300 ms — rejected. A different finding claims 250 ms improvement — passes MIN_ACTIONABLE_IMPACT (200 ms) but fails the filtering gate (300 ms). Also rejected. Surface only findings ≥300 ms on this page.

Conversely: a page with LCP = 3.0 s (borderline). A finding claims 60 ms improvement. Even if the filtering gate were lower, MIN_ACTIONABLE_IMPACT (200 ms) rejects — the fix is too small to be worth the surface area.

Findings without any impact estimate are **not** filtered here (treat missing-impact as "unknown, pass through"); but they will usually fail elsewhere (vague recommendation, missing evidence).

## Early-Exit Routing

Before running lab-heavy diagnosis (HAR collection, coverage analysis, rule evaluation), check field data first.

**Rule:** If CrUX (or RUM) p75 is in the "good" bucket for **all three** of LCP, CLS, and INP — skip the deep lab analysis. The correct output is "no action needed."

Good bucket reminder:

| Metric | Good (p75) |
|--------|------------|
| LCP    | < 2500 ms  |
| CLS    | < 0.1      |
| INP    | < 200 ms   |

Workflow note for `cwv-triage` and similar skills: short-circuit to a "no action needed" response for URLs where all three field metrics are green, unless the user has explicitly requested deep analysis ("audit this page even if CrUX is green", "I want a full report regardless"). The short-circuit saves tokens and prevents confabulation — lab tools WILL find issues on a genuinely-green page, but fixing them has no observable impact on users.

If field data is missing (new page, low traffic, no CrUX bucket), fall back to lab-first analysis as normal.

## Evidence Reliability Penalties

Two independent confidence adjustments apply after source-tier calibration, based on structural quality of the finding itself:

| Signal | Penalty | Rationale |
|--------|---------|-----------|
| Structural warnings (vague evidence, missing file reference, missing metric numbers, unusual source) | × 0.9 | Soft quality signals — likely still useful but reduced trust |
| Structural errors (cause < 20 chars, recommendation < 20 chars, too-deep root-cause chain) | × 0.7 | Hard quality failures — finding may be unactionable |
| Speculative source AND raw confidence > 0.8 | × 0.85 (after capping) | Prevents inflated certainty from inference — see source-tier table |

Overall confidence floor for a finding to survive: **0.6**. If cumulative penalties drive the score below 0.6, suppress the finding — it's unlikely to be trustworthy enough for a human to act on.

Structural errors (not warnings) in "blocking mode" cause the finding to be **dropped**, not just penalized — structural errors mean the finding failed basic quality gates (no actual cause text, no actionable recommendation) and there's nothing to salvage.

Application order:

1. Compute raw confidence from agent judgment (scale at top of doc).
2. Cap by source-tier max.
3. Apply speculative-high-confidence penalty if applicable.
4. Multiply by 0.9 per warning set, 0.7 per error set (if not dropped).
5. Gate at 0.6 minimum, drop below.
6. Apply MIN_ACTIONABLE_IMPACT and filtering thresholds.
7. What's left is reported.
