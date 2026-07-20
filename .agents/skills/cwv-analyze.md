# Skill: cwv-analyze

End-to-end CWV analysis orchestrator: URL in → ranked Findings + suggested fixes out. Composes `cwv-triage`, `cwv-diagnose`, and (optionally) `cwv-fix` into a single shot. Use this when the user wants the full-auto answer ("audit this URL"); use the individual skills when the user wants to drive the workflow step by step.

## Purpose

Given a URL (and optionally a domain for RUM context), run the minimum set of collectors and analyzers needed to produce a prioritized, schema-conformant Finding envelope covering LCP / CLS / INP / FCP / TTFB, with patch candidates ready for `cwv-fix`.

## When to invoke

- User provides a URL with no further detail: "What's wrong with `https://example.com/`?"
- User wants a one-shot audit report, not a guided walkthrough.
- A CI job or batch runner needs a reproducible output per URL.

Do NOT invoke this when:
- The user is iterating on a specific fix — go straight to `cwv-fix`.
- The user explicitly wants only field data (no lab run) — use `cwv-triage` alone.

## Prerequisites

- `launcher.js`, all four analyzers, and the finding-schema validator must be present and pass `node --check`.
- Default profile: `local`. Field collection is skipped unless the operator
  selects `field-google` and/or `field-aem-rum`.
- `field-google`: `GOOGLE_CRUX_API_KEY` in `.env`; optional
  `GOOGLE_PAGESPEED_INSIGHTS_API_KEY` for PSI fallback.
- `field-aem-rum`: `RUM_DOMAIN_KEY` in `.env`.
- Node ≥20, `npm ci` completed.

## Workflow

### Step 1 — Collect field signal (fast path)
When `field-google` or `field-aem-rum` is selected, run `cwv-triage` for the
single URL (or its origin if URL-level CrUX returns no data). This produces
`triage-findings.json` with `status: "draft"` entries tied to failing metrics.
If CrUX returns no data AND PSI is unavailable, emit a single informational
Finding (source `crux`, status `rejected`, reason: insufficient-traffic) and
proceed — the lab run still gives you a diagnosis. In the default `local`
profile, skip this step and record that field data was not consulted.

**Field-already-passing refusal (unless `--force`).** After the triage
envelope is in hand, check its top-level `status` field. If
`status === "passing"` (triage Step 6b determined all queried form factors
show every target metric strictly under the GOOD threshold with actual
field data — CrUX and/or RUM, never PSI-only), **do not run the lab
measurement or analyzers**. Emit a single line:
```
field already passing on <metrics> (<form factor>); no action — pass --force to override
```
Drawn from the envelope's `passing.checked` + `passing.byFormFactor` keys.
Exit 0 without writing `analyze-findings.json` or `patches.json`. The
triage envelope itself is the audit trail.

If `--force` was passed, proceed normally but set
`forcedPastPassing: true` on the emitted `analyze-findings.json` envelope
(top-level) and copy the triage `passing` block into
`forcedPastPassingContext` so the lab/field-gap investigation is
traceable. Use case: CrUX is green but the user believes a specific
interaction has regressed inside the 28-day window, or wants to
confirm a modest lab improvement before it surfaces in CrUX.

**Read `recommendedProfile` from the triage envelope.** Triage emits a
top-level `recommendedProfile` (e.g. `"mobile-slow4g-4xcpu"` or
`"desktop-cable-1xcpu"`) based on which form factor shows worse field
pressure. This skill — and every invocation of `launcher.js` / `coverage.js`
/ `image-analysis.js` below — MUST use that profile. If the user explicitly
overrode the form factor, the override wins and gets echoed back into
`analyze-findings.json` at the top level. Treat the profile as a single
variable `$PROFILE` threaded through every command in this skill; do not
hardcode `mobile-slow4g-4xcpu` anywhere.

If triage was skipped (user jumped straight to analyze), default `$PROFILE`
to `mobile-slow4g-4xcpu` and record `recommendedFormFactor: "PHONE"` with a
note that field data wasn't consulted.

If the target serves a Cloudflare/anti-bot challenge stub to default headless
Puppeteer, set `STEALTH="--stealth"` and pass it to every browser-owning command
below (`launcher.js`, `coverage.js`, `image-analysis.js`). Leave it empty by
default; it opens headful real Chrome and is an explicit opt-in only.

**Preserve the RUM bundle output.** When `field-aem-rum` is selected,
`cwv-triage` Step 2a runs `rum-fetch.js` and writes `/tmp/rum.json`. If that
file exists and is non-empty after triage, keep the path — Step 3 will feed it
to `chain-rum-correlator`. If `field-aem-rum` was not selected,
`RUM_DOMAIN_KEY` is unset, or `rum-fetch.js` exited 3 (wrong/mis-scoped key or
non-AEM site — NOT "CS/AMS so no RUM"), the correlator runs in lab-only mode
(C5/C6 still fire on `measure-cwv.js` event logs).

**Use triage's sample-gated selection, not raw RUM top rows.** If triage emits
both `rawTop` and `selectedTop`, the lab target is `selectedTop.url` with
`selectedTop.recommendedProfile`. A raw 1-bundle `http://` variant can remain
valuable evidence, but it must not silently steer a full lab/fix/validate run
away from the highest-pressure load-bearing canonical URL.

When `recommendedFormFactor` is not `"PHONE"`, re-fetch RUM with the matching
filter so the correlator sees only the target surface:
```
node .agents/scripts/rum-fetch.js --domain <domain> \
  --form-factor $RECOMMENDED_FORM_FACTOR --output /tmp/rum.json
```

### Step 2 — Lab measurement
Run the harness once with a screenshot, using the triage-recommended profile:
```
node .agents/scripts/launcher.js \
  --url <URL> \
  --profile $PROFILE --scroll $STEALTH \
  --screenshot screenshots/before.png \
  --output /tmp/launcher.json
```
If triage flagged INP, also pass `--interact "<CTA selector>" --interact-delay 500`. Pick the selector by inspecting the served HTML for a primary CTA (`button[type=submit]`, `a.cta`, `nav a`).

If the target fingerprints as AEM EDS, or if prior/source evidence suggests an
EDS reveal/page-shape issue, also pass `--eds-structure-snapshot`. This preserves
rendered gate evidence in `/tmp/launcher.json` even when static fetch is blocked.

**Field-faithful CLS (default).** `--scroll` is on by default (explicit above): the launcher dismisses consent, scrolls to quiescence, and captures post-load CLS, so `runs[0].cwv.cls.value` is the **field-faithful CLS of record** and `runs[0].cwv.cls.shiftSources[]` is the ranked shift attribution that the chain-rum-correlator's C6 consumes. Without it, CLS reads a false-negative and C6 has no runtime shift sources to flag. Add `--no-scroll` only for a load-only pass when CLS is not a target metric.

**Multi-run when CLS is a failing target.** A single lab run can't tell a *stable*
shift source from run-to-run *noise*, and on a multi-source page (news / ad-heavy /
content-variable) total CLS is dominated by variance in the non-targeted sources — so a
single-run CLS reading mis-ranks what to fix. When CLS is a failing target metric, pass
`--runs 5` here (the analyzers still read `runs[0]`; the extra runs feed the variance
probe below). Skip the extra runs when CLS is good — keep the one-shot fast.

### Step 2b — CLS shift-source variance / stability (only when CLS is a failing target)
```
node .agents/scripts/cls-variance.js /tmp/launcher.json > /tmp/cls-variance.json
```
Pure transform (no browser). It groups `runs[].cwv.cls.shiftSources[]` by a stable
cross-run signature and emits, per source, a `stable|volatile` classification (presence
gate + `measure-quality.assessReliability` CLS abs floor 0.1), the total-CLS `noiseFloor`
(run-to-run range), a `noiseDominated` flag (noiseFloor > 0.03), and a
`recommendedClsSource` — the dominant *stable* source's oracle token. Use it to:
- **Rank the right CLS finding.** When the C6 attribution points at a source the probe
  flagged `volatile`, down-weight it and prefer the dominant `stable` source — a fix on a
  volatile/intermittent source can't be validated. Note the classification on the CLS
  finding's `evidence[].data` (`clsStable: true|false`).
- **Drive the Step 8 hand-off.** A `noiseDominated` page must be validated per-source
  (`--cls-source`), never on total CLS. Carry `recommendedClsSource` forward.

### Step 3 — Fan out analyzers in parallel
All five are independent — they each read pre-collected inputs (launcher output / URL / RUM bundle); none spawns work that the others depend on. Pass `$PROFILE` to the two analyzers that spin up Puppeteer (coverage + image-analysis) so their measurements match the lab run:
```
node .agents/scripts/analyzers/waterfall-shift.js       /tmp/launcher.json                                      > /tmp/waterfall.json &
node .agents/scripts/analyzers/coverage.js              --url <URL> --profile $PROFILE $STEALTH --output /tmp/coverage.json &
node .agents/scripts/analyzers/html-parse.js            --url <URL> --output /tmp/html.json &
node .agents/scripts/analyzers/image-analysis.js        --url <URL> --profile $PROFILE $STEALTH --output /tmp/images.json &
# chain-rum-correlator needs BOTH the launcher output (Step 2) AND rum.json (Step 1).
# Pass --html after html-parse completes — it enriches C3 with missing-dimensions hints.
# For lab-only (no domain key / non-AEM site), substitute a stub RUM file: `{"siteWide":{},"byUrl":[]}`.
node .agents/scripts/analyzers/chain-rum-correlator.js \
  --rum /tmp/rum.json --launcher /tmp/launcher.json --output /tmp/correlator.json &
wait
```
Waterfall-shift, chain-rum-correlator, and html-parse do no browser work (pure data transforms / fetch). Coverage + image-analysis spawn their own Puppeteer sessions (this adds ~30–60s total on slow-4G). Parallelizing the five shaves the lab-time cost to roughly `max(coverage, images) + fast-analyzers`.

On EDS pages, `html-parse` also emits `html/eds-structural-contract` when the
reveal/page-shape gate fails. Keep that finding in the merged envelope and copy
its `structuralGate` block through; `rank-candidates.js` consumes it before
candidate promotion.

**When the correlator matters most:**
- C1 (INP chain) fires when URL p75 INP > 200ms and RUM has an interaction selector. Post the 2026-04-16 `rum-fetch.js` fix, INP attribution joins succeed at 70–98% across Helix sites.
- C2 (LCP resource) fires when RUM LCP > 2500ms on the URL and a lab resource matches the RUM element. Now works broadly on Helix sites.
- C5/C6 (lab-only INP/CLS event logs) fire regardless of RUM availability — the launcher's `measure-cwv.js` captures per-interaction and per-shift arrays that drive these findings.

If chain-rum-correlator emits a finding covering the same resource URL or element as a waterfall-shift / image-analysis / coverage finding, Step 5 deduplicates them with the correlator finding taking precedence (higher source tier — field > lab).

### Step 4 — Merge into one envelope
Load `triage-findings.json`, `/tmp/waterfall.json`, `/tmp/coverage.json`, `/tmp/html.json`, `/tmp/images.json`, and `/tmp/correlator.json`. Concatenate the Finding arrays into a single envelope:
```json
{
  "schemaVersion": "1.0",
  "skill": "cwv-analyze",
  "url": "<URL>",
  "timestamp": "<ISO>",
  "findings": [ /* all findings from triage + 5 analyzers */ ]
}
```
Validate with `node .agents/scripts/finding-schema.js /tmp/analyze-findings.json`.

### Step 5 — Dedupe and link
When two findings point at the same root cause, merge them. Apply rules in order — the first rule that matches wins:

**Rule 5a — chain-rum-correlator supersedes lab-only findings on the same resource URL.**
A chain-rum-correlator finding (`source: "rum"` with `mergedSources: ["rum", "har"]` or similar) preempts any waterfall-shift, image-analysis, or coverage finding whose `evidence[].data.url` matches a resource URL cited in the correlator finding's evidence. Reason: the correlator's source tier (field) caps higher (0.95) than `perf_observer` / `har` / `code` (0.85 / 0.85 / 0.65), and field evidence is ground truth for "users feel this." Preempt mechanics:
- Drop the lab-only finding from the emitted envelope.
- Append its `id` to the correlator finding's `relatedFindingIds` (so the causal chain is preserved for audit).
- Do NOT bump the correlator finding's confidence beyond its own cap — the lab finding corroborates the mechanism but the correlator already observed the user impact.

**Rule 5b — chain-rum-correlator C5/C6 supersede C1/C3 on the same selector.** This is already deduped inside the correlator (see C5/C6 dedupe checks), so no orchestrator work is needed — included here as a reminder that these findings are already reconciled.

**Rule 5c — generic merge for corroborating evidence (non-overriding).** When two findings point at the same root cause but neither supersedes the other by rule 5a:
- **Match key**: same `metric[0]` + same primary resource URL in evidence (or same `attribution.target`). Compare URLs under the canonicalization rules from `.agents/scripts/url-canonical.js` (resolve relative against finding.url, decode HTML entities like `&#x26;` → `&`, sort query params, lowercase scheme+host, strip default ports, drop fragments) — naive string-compare misses duplicates emitted with different URL forms.
- **Merge rule**: keep the highest-confidence finding's narrative; move the other's `source` into `mergedSources`; union `evidence[]` entries; bump `confidence` up to (but not past) the higher source tier's cap. E.g., a waterfall-shift finding corroborated by a coverage finding can reach the coverage cap (0.85).

**Rule 5d — causal links.** Set `relatedFindingIds` on derivative findings that point at the canonical root cause (e.g. a CLS finding whose root cause is a late-injected ad → link to the waterfall-shift finding for the ad script).

**Rule 5e — resource + intervention dedup.** When two findings target the same canonical resource URL *and* the same intervention type, collapse them: keep the **highest source-tier** finding (field > lab > static > speculative — Rule 5a precedence), breaking ties by rankScore then confidence; append the other's id to `relatedFindingIds`, union `evidence[]`, and move the lower-tier `source` into `mergedSources` on the kept finding. Also applies when two findings share the same `attribution.target` (same DOM element) and same intervention type — useful when two analyzers cite different URL forms for the same LCP element (e.g. `<picture><source>` webp sibling vs `<img>` jpg fallback).

- **Intervention type** is inferred from the patch shape:
  - `patches.markup[].name === 'fetchpriority'` (or `attr === 'fetchpriority'`, or `attrs.fetchpriority`) → `fetchpriority`
  - `patches.markup[].name === 'defer'` / `'async'` → `defer` / `async`
  - `patches.markup[].name === 'loading'` → `loading`
  - `patches.preloads[]` non-empty → `preload`
  - `patches.markup[].name === 'style'` → `style-inline`
  - Otherwise `other:<action>:<name|attr|?>`
- **Same attribution.target match key.** When both findings cite a non-null `evidence[].data.target` on a `kind: cwv-attribution` entry and the targets are identical, treat that as a dedup key regardless of URL form.
- **Belt-and-braces:** `rank-candidates.js` runs the same dedup pre-ranking and enforces the **source-tier precedence** of Rule 5a in its keeper selection (`sourceTierOf`: field=1 … speculative=4 — a field/RUM finding is kept over a *higher-rankScore* lab finding on the same resource+intervention, not the reverse). The skill is the canonical rule; the script is deterministic enforcement. Each merge logs `event: "rank-candidates.dedupe"` to stderr with `reason: "source-tier-precedence"` (tier decided the keeper) or `"same-resource-or-target"` (rankScore decided) for audit.

**Rule 5f — EDS structural gate controls CLS selector-shim promotion.** When the
merged envelope contains a failing `structuralGate` from
`html/eds-structural-contract`, selector-level CLS layout shims (`style`,
`class`, min-height/display/visibility rewrites) are probe-only. The
deterministic `rank-candidates.js` output sets `structuralGate` on the envelope
and marks these candidates `probeOnly: true`, `promotionBlocked: true`, and caps
confidence below the normal promotion threshold. They may still be measured, but
they must not be treated as root-cause fixes unless a later source patch restores
the EDS reveal/page-shape contract and passes the LCP guard.

Worked example — 2026-04-17 the pets-site case run emitted two candidates for the same LCP `<img>`:
- `img-lcp-fetchpriority-1` — selector `img[src='https://pets.example.com/media_…&format=webply&optimize=medium']`, markup patch, confidence 0.75, `rootCause: true`.
- `diagnose-lcp-opportunity-3` — selector `img[src="./media_…&#x26;format=jpg&#x26;optimize=medium"]`, markup patch, confidence 0.6.

Canonicalized the two URLs differ (`format=webply` vs `format=jpg` are genuinely different resources — picture `source` sibling vs `img` fallback), so URL-match alone does NOT fire. If both findings carry `evidence[].kind: cwv-attribution` with matching `data.target` (e.g. `div.hero-banner>…>picture>img`), Rule 5e collapses them via the attribution.target match key: keep `img-lcp-fetchpriority-1` (higher rankScore), fold `diagnose-lcp-opportunity-3` into `relatedFindingIds`, union evidence, merge sources. If attribution.target is null on both (as in the captured 2026-04-17 envelope), the rule does NOT fire — the two candidates legitimately point at different resources and should both run.

### Step 5b — Attribute ownership (is it AEM or the customer?)
Detect the stack flavor and tag every merged finding with an `owner`. When source was fetched, pass `--source <dir>` — flavor resolution is then **channel-aware**: an `aemy` (EDS-frontend) repo resolves to `eds` even when the site's `deliveryType` is `aem_cs`, i.e. **XWalk** (don't let the author stack mislabel the published one). An explicit bare `--flavor eds|cs|ams|headless` still overrides; otherwise `--source` (aemy ⇒ eds) wins over a raw `--delivery-type` label. Fingerprints: `topics/stack-detection.md`.
```
node .agents/scripts/attribution.js /tmp/analyze-findings.json \
  --source progress/<slug>/source --delivery-type <aem_cs|aem_edge> \
  --output /tmp/analyze-findings.json
```
This adds `owner` ∈ {`platform-default`, `dispatcher-cdn`, `customer-code`, `customer-content`, `third-party`} + an `ownership` block to each finding, derived from the metric's playbook `applicable_flavors` + the stack doc + the finding's evidence. It is a single pass over the **whole merged envelope** (all six sources), so it's the authoritative ownership step — not just the correlator's findings. A first-party selector with no third-party resource is `customer-code`/`customer-content`, not `third-party`. See `topics/finding-schema.md` → "Platform-vs-customer attribution". (You can also pass `--flavor` to `chain-rum-correlator.js` in Step 3 to pre-tag its findings, but Step 5b is what covers the full set.)

### Step 6 — Prioritize
Sort findings by:
1. `status != 'rejected'` first.
2. Descending `severity` (high → medium → low).
3. Descending `impactReduction` magnitude (valueMs or score × 1000 for CLS).
4. Ascending source tier (field > lab > static > speculative) — higher-tier evidence breaks ties.

Emit a "Top 5 findings" summary table for the human report.

### Step 7 — Emit report and patch bundle
Produce:
- **Markdown report** (human-readable) with: URL, timestamp, field vs lab summary, Top 5 findings with CoT blocks, a per-metric dashboard (baseline value vs projected improvement), screenshot path, and a suggested next step.
- **`analyze-findings.json`** — validated envelope.
- **`patches.json`** — merge the `patches` fragments from the top 3 non-rejected findings into a single bundle (unique preloads, dedup markup selectors, merge block lists). Ready for `cwv-fix` via `--patches`.

### Step 8 — Suggest next step
Recommend the exact `cwv-fix` invocation:
```
(pass analyze-findings.json + patches.json to cwv-fix)
```
Or, if Top 1 confidence is ≥0.85 and `impactReduction` is ≥3× MIN_ACTIONABLE_IMPACT, recommend jumping straight to `cwv-validate` with N=15 runs.

**CLS hand-off on a noise-dominated page (from Step 2b).** If the variance probe set
`noiseDominated: true`, the `cwv-validate` / `cwv-orchestrate` recommendation MUST validate
the stable source, not total CLS — append `--cls-source <recommendedClsSource>` and capture
a 2nd no-patch baseline for the A/A gate (`--baseline2`). Spell it out, e.g.: "total CLS is
noise-dominated (baseline range {noiseFloor} > 0.03); validate the fix on
`--cls-source={recommendedClsSource}` with `--baseline2`, not total CLS — otherwise the A/B
can false-VALIDATE." Without this the validator's per-source gate depends on the user knowing
to reach for it.

## Output format

Emit BOTH a human-readable report and a structured Findings envelope.

### Human report
```
# CWV Analysis — <URL> — <timestamp>
## Target surface
- Form factor: <PHONE|DESKTOP|TABLET>  (source: triage auto-detect | user override)
- Lab profile: <mobile-slow4g-4xcpu|desktop-cable-1xcpu>
## Field signal
- CrUX p75 on target FF: LCP X / CLS Y / INP Z (28-day)
- Other-FF comparison: LCP X' / CLS Y' / INP Z'  (one-liner so readers see the gap)
- RUM p75: (if available; filtered to target FF)
## Lab measurement ($PROFILE)
- LCP X / CLS Y / INP Z / FCP / TTFB
- Dominant LCP phase: <phase>, dominant INP phase: <phase>
## Ownership verdict
- Is it AEM or the customer? One-line tally by `owner` (e.g. "4 customer-code, 1 third-party, 0 platform") + any `requires-operator` / `requires-launch-rule` call-outs.
## Top 5 Findings
[table: # | metric | severity | impact | source | owner | recommendation]
## Recommended patches.json
[code block]
## Next step
Run: cwv-fix --patches patches.json --url <URL> --profile $PROFILE
```

### Structured findings (REQUIRED)
`analyze-findings.json` — envelope per [finding-schema.md](../references/topics/finding-schema.md). All findings from this skill have:
- `skill: "cwv-analyze"` — REWRITE the `skill` field on findings produced by sub-steps (triage / analyzers) to `cwv-analyze` when merging, preserving the original source via `source` and `mergedSources`.
- `status`: mostly `proposed` (diagnose-stage) with some `draft` (triage-stage) and `rejected` (sub-threshold). No `applied`/`validated` statuses — that's `cwv-fix` / `cwv-validate`.
- `relatedFindingIds` populated where findings were merged or causally linked.
- `owner` + `ownership` populated by the Step 5b attribution pass.

Top-level envelope fields (propagated forward to `fix-findings.json` /
`validate-findings.json`):
- `formFactor`: `"PHONE"` | `"DESKTOP"` | `"TABLET"` — the surface being audited.
- `profile`: the throttling profile name used on the lab run.
Downstream skills read these and refuse to run with a mismatched `--profile`
(would make the delta comparison meaningless).

Validate before writing:
```
node .agents/scripts/finding-schema.js /tmp/analyze-findings.json
```

## References to read
- `.agents/references/topics/finding-schema.md` — envelope contract, merge rules, confidence caps.
- `.agents/references/topics/evidence-and-confidence.md` — CoT format, filtering thresholds.
- `.agents/references/topics/waterfall-shift.md`, `coverage.md`, `html-structure.md`, `image-optimization.md`, `chain-rum-correlation.md` — per-analyzer methodology.
- `.agents/references/topics/field-vs-lab.md` — reconciling CrUX/RUM with the lab run in the summary.
- `.agents/references/topics/rum.md` — Helix RUM bundle shape + detection heuristics (relevant when deciding whether the correlator runs in field-fused or lab-only mode).
- Metric runbooks (`metrics/*.md`) — read only those whose rating is not `good`.
- Stack docs (`stacks/aem-eds.md`, `aem-cs.md`, `aem-ams.md`) + `topics/stack-detection.md` — detect the flavor (Step 5b).
- Playbooks (`.agents/references/playbooks/<issue-type>.md`) — the remediation playbook per failing metric; `attribution.js --explain <metric> --flavor <flavor>` lists the applicable ones.

## Tools required
- `.agents/scripts/launcher.js`
- `.agents/scripts/rum-fetch.js` (optional; required for C1/C2 field-fused findings on any AEM site with a provisioned domain key)
- All five analyzers under `.agents/scripts/analyzers/` — waterfall-shift, coverage, html-parse, image-analysis, chain-rum-correlator
- `.agents/scripts/finding-schema.js` validator
- `.agents/scripts/attribution.js` — ownership attribution + playbook router (`--explain`)
- `.agents/scripts/cls-variance.js` — CLS shift-source variance/stability probe (Step 2b; when CLS is a failing target)
- Filesystem read/write for intermediate JSON files and final report

## Known limitations

- **Single URL, single device.** For multi-URL / multi-device audits, run this skill N times — do not try to batch inside a single invocation (the shape becomes unclear).
- **Coverage and image analyzers each spin up their own browser.** Total wall time is dominated by these two Puppeteer sessions (~30–60s on slow-4G). Parallelizing the four analyzers shaves ~half that.
- **Merge rules are heuristic.** Two findings pointing at the same URL via different evidence kinds (e.g., `coverage-row` vs `rule-violation`) will merge; but a waterfall-shift finding about a chain and an image finding about a single image in that chain will not auto-merge. Downstream skills (cwv-fix) will still apply them as separate patches.
- **INP coverage is thin but better than it used to be.** If the user can't supply an `--interact` selector, `cwv.inp.value` is null but `measure-cwv.js` still records any interactions that happened during page load into `cwv.inp.interactions[]`. The correlator's C5 heuristic turns those into per-interaction findings (source `perf_observer`, cap 0.85) even without RUM. Field-side, C1 produces URL-level interaction findings when RUM has INP p75 > 200ms and at least one click event with a `source` selector in the same bundle (70–98% join recovery post the 2026-04-16 rum-fetch fix).
- **CLS attribution from RUM is not available.** `cwv-cls` events carry no element info from the Helix collector at this version. C3 falls back to RUM-only low-confidence or lab-driven (C6 via `cls.shifts[]`). Tracked as an upstream ask in `docs/roadmap.md`.
- **This is lab + field synthesis, not a real-user fix.** A `validated` status still requires `cwv-validate` with N=15 runs or a deployment + CrUX wait cycle.
