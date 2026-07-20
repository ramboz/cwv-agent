# Skill: cwv-fix

## Purpose
Interactively develop and measure a performance fix for a specific URL. Build `patches.json` incrementally from the hypotheses produced by `cwv-diagnose`, apply via the pre-navigation Puppeteer harness, measure the delta over a small number of runs, and iterate until the fix is accepted. On acceptance, translate the lab patch into permanent source-level implementation instructions (HTML, CDN config, framework-specific code).

## When to invoke
- After `cwv-diagnose` has produced a ranked hypothesis list and at least one suggested `patches.json`.
- When a user wants to test "would fix X actually help?" before committing to permanent source changes.
- When iterating on a fix where the first attempt only partially helped.
- NOT for statistical proof — use `cwv-validate` for that (N≥15 runs).

## Prerequisites
- Provider profile: `local` runtime patching with the in-repo launcher. Source
  translation can use a local checkout or an explicitly fetched `source-s3`
  tree, but source access is not required to measure a patch.
- `cwv-diagnose` already ran and a `patches.json` draft exists (or the user has a hypothesis in mind).
- `npm ci` completed; `launcher.js` syntax-checked.
- Writable `screenshots/` directory.
- Target URL reachable.
- If the target metric is INP, a known interaction selector (primary CTA, nav link, search button).

## Workflow

### Step 0 — Doctor preflight (ADR-0014 / spec 014)
Before any lab measurement, run the same standalone doctor preflight gate the
5-step runbook enforces at every step. Resolve this skill's provider profile
(the one on the "Provider profile:" line above — `local` for runtime
patching), then run:
```
node .agents/scripts/preflight.js --profile local
# or: npm run preflight -- --profile local
```
Exit codes: `0` = ready (or advisory-only), `1` = a required prerequisite is
**verifiably missing** (doctor `fail`/`not-wired`), `2` = usage error. On exit
1, surface the command's own doctor rows verbatim and **stop** before any
browser/measurement work — do not re-derive the message. Prerequisites doctor
**cannot self-verify** (status `unknown`, e.g. manual auth checks) are printed
as non-blocking advisories (`⚠ preflight: could not verify …`) and the run
**proceeds** — the gate never refuses on an `unknown` alone. The identical
`--skip-preflight` escape hatch bypasses the gate (visible in output); use it
only to intentionally reproduce a mid-run failure. This is a read-only
`doctor.js` call — it never runs `setup.js`. When this skill is invoked as a
sub-step of a `cwv-orchestrate` run, that loop already ran its own session
preflight, so a standalone re-run here is only for the manual/standalone path
(see AGENTS.md "The 5-step workflow").

### Step 1 — Establish the baseline (3 runs)
**Resolve `$PROFILE` first.** Read it from the upstream envelope (set by
`cwv-triage` / `cwv-analyze` via the top-level `profile` / `recommendedProfile`
field). Fall back to `mobile-slow4g-4xcpu` only when no upstream envelope
exists. The profile is a hard invariant across baseline + every treatment
attempt in this session — changing it mid-flight invalidates every delta
computed so far, because CPU throttle and network shape change LCP/INP/CLS
distributions non-linearly.

If the upstream diagnosis required Cloudflare/anti-bot bypass, set
`STEALTH="--stealth"` and pass it to the baseline and every treatment attempt.
Never compare a default headless baseline to a stealth/headful treatment.

Always measure before changing anything. Run:
```
node .agents/scripts/launcher.js --url <URL> \
  --profile $PROFILE --runs 3 --scroll $STEALTH \
  --screenshot screenshots/baseline.png
```
**Field-faithful measurement (default).** `--scroll` is on by default (explicit here) so the baseline captures the field-faithful CLS of record (post-load shifts: consent banners, scroll-lazy ads). Use the SAME scroll mode for the baseline and every attempt below so the comparison holds — it's required to see a CLS fix land. Pass `--no-scroll` on all runs only when CLS is not the target (it adds ~20–30 s/run).

**If the target metric is INP**, append `--interact "<selector>" --interact-delay 500`. Use the SAME selector for baseline and every subsequent attempt so the interaction path is comparable. Document the selector — record it in the session notes.

Take the median of the 3 runs per metric as the baseline. Save baseline values (LCP, CLS, INP, FCP, TTFB) and baseline attribution phase numbers (the launcher preserves attribution in every run).

### Step 2 — Present hypotheses and pick one
Show the user the hypotheses from `cwv-diagnose` ranked by confidence. Let the user pick which to test first, or accept a user-proposed fix. One hypothesis per attempt — do not combine fixes in a single attempt or you cannot attribute the delta.

**Risk-tier gate (ADR-0015 §4, ADR-0008) — check before generating any patch.**
Resolve the hypothesis's `issue_type` (from the Finding, or via
`classifyFindingIssueType`) and consult its playbook risk tier:

```
node -e 'import("./.agents/scripts/forbidden-technique-validator.js").then(m => console.log(JSON.stringify(m.riskTierPolicy(process.argv[1], process.argv[2]))))' <issue_type> <flavor>
```

If `allowsCodeChange` is `false` (i.e. `risk_tier: high` — `interaction`,
`js-execution`, `ttfb`, …), **do not build a code-change patch**. Route the
finding to **guidance-mode publish** (ADR-0008): a `rootCause: true` finding
with a recommendation + mechanism and **no `patchContent`**. `medium` requires
the validation loop below; `low` is auto-fixable.

If the upstream `diagnose-findings.json` / `analyze-findings.json` or
`ranked_patches.json` contains `structuralGate.result: "fail"` for
`eds-structural-contract`, call that out before testing: selector-level CLS
layout shims are **probe-only**. They can be useful discriminating tests, but
the production fix must restore the EDS reveal/page-shape contract or be emitted
as guidance if no safe local patch exists.

### Step 3 — Build `patches.json`
> **`block` / `rewriteBody` / header patches only fire on a network request.** The
> launcher disables the HTTP cache for the default `first-visit` cohort, so they
> intercept correctly. If you ever see a `block`/`rewriteBody` patch produce **zero
> delta**, first confirm the targeted resource was actually fetched (`transferSize > 0`)
> — a cache-served immutable asset bypasses CDP `Fetch` and the patch silently no-ops.

Compose the patch bundle from the valid pre-nav patch types:
- `preloads` — array of `{href, as, crossorigin?, fetchpriority?}`; emitted as a single `Link` response header on the HTML document.
- `markup` — array of `{selector, attrs}`; injected via DOMContentLoaded listener (applied pre-nav via `evaluateOnNewDocument`).
- `responseHeaders` — array of rules `{urlPattern, set?, append?, remove?}`; rewritten at the CDP Fetch response stage.
- `requestHeaders` — array of rules; rewritten at the request stage.
- `block` — glob patterns; matched URLs are `Fetch.failRequest`'d.
- `rewriteBody` — body rewrites `{urlPattern, replacements:[{find, replace, isRegex?}]}`; applied at the CDP Fetch **response** stage against **any** served URL whose glob matches — **including cross-origin vendor JS bundles**, not just first-party CSS/HTML. So a fix living in compiled/vendored JavaScript can be lab-validated before a rebuild (e.g. otempo `theme.js` `.show(e)`→`.show()` to de-animate a consent-banner reveal). `find`/`replace` runs on the decoded body, so it must match the served (possibly minified) bytes. See `cwv-validate.md` → "Validating a served-JS fix with `rewriteBody`".

Example — testing a preload + fetchpriority combination:
```json
{
  "preloads": [
    { "href": "/images/hero.webp", "as": "image", "fetchpriority": "high" }
  ],
  "markup": [
    { "selector": "img.hero", "attrs": { "fetchpriority": "high", "loading": "eager" } }
  ]
}
```

### Step 4 — Run the attempt (3 runs)
```
node .agents/scripts/launcher.js --url <URL> \
  --profile $PROFILE --runs 3 --scroll $STEALTH \
  --patches patches.json \
  --screenshot screenshots/attempt-1.png
```
Add `--interact` flags if targeting INP, using the baseline's selector.

### Step 5 — Compute the delta
For each metric, compute:
- Absolute delta (ms or score): `treatment_median - baseline_median`.
- Percent delta: `(delta / baseline_median) * 100`.
- Which attribution sub-phase moved and by how much (e.g., `resourceLoadDelay: 1200 → 400`).

Check the screenshot against `screenshots/baseline.png` for visual regressions — layout shifts, missing above-fold content, altered hero image dimensions.

### Step 5b — CLS shift-source fixes: judge per-source, and iterate the *mechanism* (don't stop at a structural scaffold)
When the candidate is a CLS shift-source fix (from `cls.shiftSources` / chain-rum-correlator C6), **total CLS is the wrong yardstick** on a multi-source page — it's dominated by run-to-run variance in the *non-targeted* sources and can hide (or fake) the fix (V1/V4). Judge the **targeted source's own contribution**:

```
# the dominant stable source comes from the V4 variance probe
node .agents/scripts/cls-variance.js progress/{slug}/baseline.json > /tmp/clsvar.json   # → recommendedClsSource
node .agents/scripts/oracle.js --baseline progress/{slug}/baseline.json \
  --treatment progress/{slug}/attempt-N.json --metrics CLS,LCP \
  --cls-source <recommendedClsSource> --baseline2 progress/{slug}/baseline-2.json
```
Accept only when **`CLS@<source>` actually drops** (a stable source validates cleanly; a volatile one self-reports `UNRELIABLE` — re-target).

**The structural scaffold is a starting point, not the fix.** Step 8.5 may scaffold an `override-clientlib` that pins position / reserves `min-height`. Verify it: if `CLS@<source>` is **unchanged**, the scaffold is **causally inert** and you must iterate the *real* mechanism — do not accept it. The most common inert case is an **animated reveal** (`evidence.data.mechanism === "animated-reveal"`, V5): the element already has its final geometry (e.g. `position:fixed`), so pinning it does nothing — the shift is the *entrance animation* (jQuery `.show(duration)` / `display:none→flex` tweening width/height). Iterate the de-animation fix and re-measure per-source:
- **Prove it in the lab without a rebuild** — `rewriteBody` the served bundle (incl. a cross-origin vendor JS file) to remove the animation, e.g. otempo `theme.js` `$(".cookies__container").show(e)` → `.show()`. See `cwv-validate.md` → "Validating a served-JS fix with `rewriteBody`".
- **Map to the permanent fix** — the reveal recipe in [`playbooks/layout-shift.md`](../references/playbooks/layout-shift.md) → "Reveal or expand content without shifting layout" (render at final size; animate only `opacity`/`transform`; class toggle, not `.show(duration)`).

Only once the per-source delta is real does the fix proceed to Step 8 (where `rewriteBody`/CSS maps to the source change).

### Step 5c — CLS cross-metric guard: separate scroll side-effects from real LCP regressions
CLS fixes often change the scrolled page state enough that scroll-mode LCP selects
a different candidate, or records a worse LCP value, even when the load path did
not regress. Do not immediately reject or accept a CLS patch solely from that
scroll-mode LCP movement.

When the target CLS (or `CLS@<source>`) improves but **LCP regresses by ≥200ms**
or the LCP attribution element/resource changes in the scrolled treatment, run a
load-only LCP guard with the same profile and patch:

```
node .agents/scripts/launcher.js --url <URL> \
  --profile $PROFILE --runs 3 --no-scroll $STEALTH \
  --output progress/{slug}/baseline-load-only.json

node .agents/scripts/launcher.js --url <URL> \
  --profile $PROFILE --runs 3 --no-scroll $STEALTH \
  --patches patches.json \
  --output progress/{slug}/attempt-N-load-only.json
```

Judge the LCP guard by median LCP, attribution target/resource, and the dominant
phase deltas. If load-only LCP is stable (<200ms worse and same candidate), keep
judging the CLS patch by the per-source CLS result and record a
`measurement-delta` evidence entry with `data.guard = "load-only-lcp"` and
`data.verdict = "scroll-candidate-change"`. If load-only LCP also regresses or
the load-only candidate changes, mark the attempt `status: "regression"` and
iterate the patch before validation. If the guard is noisy, mark the attempt
`status: "rejected"` with `data.verdict = "guard-unreliable"` and re-measure
instead of carrying ambiguous evidence forward.

For a failing EDS structural gate, this guard is mandatory for any vertical-space
reservation, min-height, hidden-state, display, or class patch. A numerically
successful CLS result is not enough: if the load-only LCP candidate changes or
regresses, reject the selector shim and return to the structural contract fix.

### Step 6 — Present results
Emit a table:

| Metric | Baseline | Attempt | Delta | % | Dominant phase Δ | Verdict |
|--------|----------|---------|-------|---|------------------|---------|
| LCP | 3420 | 2180 | -1240 | -36% | resourceLoadDelay: 1400→150 | improved |
| CLS | 0.08 | 0.08 | 0.00 | 0% | — | unchanged |
| INP | 180 | 175 | -5 | -3% | — | noise |

### Step 6b — Forbidden-technique gate (deterministic — run before promoting any candidate)
Before a candidate may be promoted (accepted → Step 8) or published, its
**source-level diff** must clear the playbook forbidden-technique validator
(spec 015-05, ADR-0015 §3). This is the deterministic guard against the
project's recurring failure mode — reintroducing a documented anti-pattern
(`min-height: 0`, `font-display: block`, HTTP `Link:` preload, …).

Build the candidate's unified diff (the source edits mapped in Step 8, or the
`patchContent` a publish would carry), then run `validateFixDiff` against the
fix's resolved `issue_type` + `flavor`:

```
node .agents/scripts/forbidden-technique-validator.js <candidate.diff> <issue_type> --flavor <flavor>
```

or programmatically:

```
import { validateFixDiff } from './.agents/scripts/forbidden-technique-validator.js';
const { ok, violations } = validateFixDiff(diffText, issueType, flavor);
```

Rules are scoped to the resolved `issue_type`'s playbook **plus `complements`
edges only** — `prefer_instead`/`orthogonal` edges contribute no rules (guards
false rejections). Each rule respects its `on_flavors`.

**On any violation (`ok === false`): do NOT promote the diff.** Reject the
candidate, surface **each `violation.reason` verbatim** to the fix agent as
feedback, and **re-prompt** — amend the fix to avoid the anti-pattern and loop
back to Step 4 (re-measure) before considering acceptance again. A candidate
that trips the validator is never accepted, never published as a `CODE_CHANGE`,
and never mapped to `sourceEdits`.

### Step 7 — User decision
Prompt: "iterate with modifications / try next hypothesis / accept." On iterate, amend the `patches.json` and loop to Step 4. On next hypothesis, reset to Step 2 with the next-highest-confidence entry. On accept, **first confirm the candidate cleared the Step 6b forbidden-technique gate**, then proceed to Step 8.

### Step 8 — On acceptance: output final artifacts
Emit:
- The accepted `patches.json` verbatim.
- Paths to `screenshots/baseline.png` and `screenshots/attempt-N.png`.
- Median baseline vs treatment values for record.
- **Permanent implementation instructions** — map each accepted patch to its source-level equivalent. For any fix that may become a SpaceCat `CODE_CHANGE`, do not stop at runtime `patches.json` when `sourceEdits` is missing. First try a local checkout; if none is present, run the `source-s3` provider (`cwv-source-fetch`) to check SpaceCat's imported source, then map/reconcile against that tree. Record the result in `sourceAvailability` (`fetched`, `not_found`, `auth_blocked`, or `mapping_failed`). Only publish guidance-only after this probe proves there is no safe deployable patch path. When the user's repo or fetched source tree is in the workspace, run `source-mapper.js` (`mapToSource({ patches, repoRoot })`) where applicable to compute the concrete edits; it returns `edits[]` of `{ file, before, after, line?, … }`. Render the prose instructions below for the human report **and** capture the `{ file, before, after, line? }` subset of each edit for the structured `sourceEdits` field (see "Structured findings" below) — that subset is what `cwv-publish` (003-02) turns into the unified diff. The mapping is documented in [finding-schema.md → fix-findings.json → suggestion-payload mapping](../references/topics/finding-schema.md#fix-findingsjson--suggestion-payload-mapping).
  - `preloads` → `<link rel="preload" href="..." as="..." fetchpriority="high">` in the HTML `<head>`, OR a CDN `Link` response header rule (Fastly VCL, CloudFront function, Vercel `headers` config).
  - `markup` attr changes → edit the HTML template or component source. For AEM EDS, edit the block decorator (`blocks/<name>/<name>.js`) or the `scripts/scripts.js` decorators. For AEM CS, edit the HTL template or Sightly expression — use `selector-resolver.js` (Step 8.5) to pinpoint the component + HTL file rather than guessing the path. For an AEM CS **CSS/layout** fix specifically, the resolver also tells you whether to edit source or ship an override clientlib.
  - `responseHeaders` → CDN-layer rule. Write the rule in the format appropriate to the CDN (Fastly VCL snippet, CloudFront function, Vercel `headers`, Cloudflare Worker, nginx `add_header`).
  - `requestHeaders` → often not portable to production; flag as lab-only if the target is a 3rd-party domain you don't control.
  - `block` URLs → the permanent equivalent is to move the blocked script to `loadDelayed()` (AEM EDS), add `defer`/`async` attrs, remove the script entirely, or gate it on consent / interaction.
- `rewriteBody` → source code change (or CDN body rewrite rule if available). Cannot be a runtime-only fix in prod.

After `fix-findings.json` is written and validated, emit the phase handoff
artifacts:

```
node .agents/scripts/remediation-payload.js fix-findings.json \
  --output remediation-payload.json \
  --report remediation-report.md \
  --patches patches.json
```

`patches.json` is the runtime treatment applied by the launcher. It stays linked
as lab evidence and is not the deployable SpaceCat diff. `remediation-payload.json`
is the publish-facing handoff: each issue is explicitly `CODE_CHANGE` or
`GUIDANCE`. `CODE_CHANGE` issues must carry `sourceEdits` and derived
`patchContent`; if diff material is missing, the helper classifies the issue as
`GUIDANCE`, and `publish-payload.js` still rejects any validated `CODE_CHANGE`
attempt that lacks diff material. `remediation-report.md` is the AEM expert
review view: source locations, expected CWV effect, risk, and what to verify.

### Step 8.5 — Resolve selector → source (AEM CS CSS/layout fixes)
When the accepted fix targets a **CSS / layout** problem on **AEM CS** (e.g. a CLS shift-source selector from `cls.shiftSources` / chain-rum-correlator C6), the hard part is not the patch — it is finding *where* that element is styled and *how a fix actually reaches production*. Editing the wrong layer (a built/vendor clientlib, or HTL when the CSS isn't even in git) ships a no-op.

Run the resolver against the pulled source tree (from `cwv-source-fetch`):

```
node .agents/scripts/selector-resolver.js --selector '<runtime-selector>' --source progress/<slug>/source --md
```

It returns: the owning **component** (+ resource type, HTL path), a **styling trace** (inline / Sling model / authored dialog / clientlib CSS), the **base-CSS origin** (committed vs vendor-built / not-in-git), and a **recommended delivery**:

- `direct-source-edit` — the styling CSS is committed; edit it and let the clientlib build ship it.
- `override-clientlib` — the base CSS is vendor-built / not in git; deliver an override clientlib loaded after the vendor styles (the resolver emits the `.content.xml` / `css.txt` / `css/*.css` scaffold; `--emit <dir>` writes it). This is the otempo `t004-cookie` / `.cookies__container` case. **Caveat (V3): the emitted scaffold is structural (position/min-height) and may be causally inert** — on otempo the banner already ships `position:fixed` inline, so pinning it did nothing for CLS; the real shift is its `.show(e)` *entrance animation*. Always verify the scaffold against the **per-source** delta (Step 5b) and, if `CLS@<source>` doesn't move, iterate the mechanism fix (de-animate the reveal) rather than shipping the inert scaffold.
- `content-dialog` — the property is authored; a content change repositions it with zero code (but won't change entrance/reflow behaviour).

Use this to fill in the "Permanent implementation instructions" precisely instead of guessing the layer. `source-mapper.js`'s AEM CS `markup` path calls the same resolver to name the component+HTL automatically.

> **AEM XWalk (Crosswalk):** XWalk publishes via Edge Delivery, so its fix surface
> is the **EDS frontend repo**, not the AEM CS author — this Step 8.5 AEM-CS
> resolver / override-clientlib path does **not** apply. Pull the EDS frontend with
> `source-fetch --channel aemy` (XWalk sites store both a `cm` author package and
> an `aemy` frontend; `detectStack` then routes the `aemy` repo to `aem-eds`), and
> use the EDS block-decorator / `scripts/scripts.js` / `head.html` edits above. The
> CS author side is content-only: if a root cause is authored-content shape (e.g. an
> unsized hero `<img>`), prefer a defensive block-decorator fix and hand off any
> author-side change as a recommendation.

### Step 9 — Offer direct source edits (optional)
If the user's repo is present in the workspace, offer to apply the permanent source edits directly (Edit tool on HTML/CSS/JS files). Do NOT edit source unless the user explicitly confirms. For AEM CS, prefer the delivery the resolver recommends (Step 8.5) — for an `override-clientlib` recommendation, scaffold the new clientlib rather than editing vendor-built CSS that isn't in the repo.

### Step 10 — Source probe status for publish handoff
Before handing a validated runtime fix to `cwv-publish`, ensure the finding says what happened to source mapping:

- `sourceEdits` present → `sourceAvailability.status: "fetched"` (or local checkout equivalent) and publish can build `patchContent`.
- Source was not present in the workspace → try `cwv-source-fetch` / `source-s3` before declaring the fix guidance-only.
- S3 has no import → `sourceAvailability.status: "not_found"`.
- Mysticat/AWS credentials blocked the check → `sourceAvailability.status: "auth_blocked"` with a short `reason`.
- Source was fetched but the runtime patch cannot be mapped safely → `sourceAvailability.status: "mapping_failed"` with a short `reason`.

Treat `sourceAvailability.status: "unattempted"` (or an absent field) as an incomplete SpaceCat handoff for any validated finding without `sourceEdits`.

## Why pre-navigation only
Post-load DOM mutations cannot test preload hints (preload must be present when browser parses the HTML `<head>`), cannot rewrite response headers (already received), and cannot alter the LCP resource's priority (already picked up by the preload scanner). Every patch in this workflow is applied via `evaluateOnNewDocument` (markup) or the CDP Fetch domain (headers/block/body) before navigation, so lab results genuinely predict source-level fix behavior.

## Output format

Emit BOTH a human-readable report and a structured Findings envelope.

### Human report
- Baseline + attempt tables (median per metric, attribution phase deltas).
- Before/after screenshot paths.
- Final `patches.json`.
- Permanent implementation instructions per patch type.
- A suggested next step: run `cwv-validate` with N=15 to statistically prove the fix.

### Structured findings (REQUIRED)
Emit `fix-findings.json` conforming to [finding-schema.md](../references/topics/finding-schema.md). Take the `proposed` findings from `diagnose-findings.json` (or the one the user selected), apply each, and emit an updated Finding per attempt:

- Preserve the upstream `id` (e.g. `diagnose-lcp-1`) and `cause` / `recommendation` / `patches`.
- Preserve top-level envelope `formFactor` and `profile` from the upstream
  (diagnose/analyze) envelope. Both baseline and treatment runs must use this
  profile — they are recorded here so the validate gate can refuse a
  mismatched profile.
- Set `skill: "cwv-fix"`.
- Append a `measurement-delta` evidence entry: `{ kind: "measurement-delta", data: { metric, baseline, treatment, deltaMs|deltaScore, runs: 3 } }`.
- Append a `screenshot` evidence entry with `phase: "attempt-N"`.
- **Persist the structured source-edit records** as a top-level `sourceEdits`
  array — `source-mapper.js`'s `{ file, before, after, line? }` per edit (the
  load-bearing subset of its edit objects; drop the runtime-only
  `rationale`/`autoApplicable`/`patchType`/`insertion`). Emit the records
  themselves, **not** a prose rendering of them — this is the raw material
  `cwv-publish` (003-02) formats into the SpaceCat unified-diff `patchContent`
  at upload (see [finding-schema.md → fix-findings.json → suggestion-payload
  mapping](../references/topics/finding-schema.md#fix-findingsjson--suggestion-payload-mapping)).
  `sourceEdits` is **optional** (omit it for a `rejected`/`regression`/`no_op`
  finding, or when source can't be mapped) but **required for a deployable patch
  publish**. When a validated finding omits it, also emit `sourceAvailability`
  so `cwv-publish` can distinguish "not attempted" from "source unavailable" or
  "mapping failed." The Step 8 prose "Permanent implementation instructions"
  stays in the human report; `sourceEdits` is its machine-readable twin.
- Update `impactReduction` with the MEASURED delta (not the diagnose estimate).
- Set `status`:
  - `applied` if the net median delta is positive and clears MIN_ACTIONABLE_IMPACT for the targeted metric.
  - `rejected` if no improvement (or sub-threshold).
  - `regression` if median got worse or another metric regressed past MIN_ACTIONABLE_IMPACT.
- Update `severity` via `deriveSeverity()` in `finding-schema.js`.
- Keep `source` as set by diagnose; evidence source did not change.

Validate before writing:
```bash
node .agents/scripts/finding-schema.js fix-findings.json
```

Downstream: `cwv-validate` reads `applied` findings and re-measures with N=15 for statistical verdict.

## References to read
- `.agents/references/topics/finding-schema.md` — output contract; lifecycle transitions proposed → applied/rejected/regression.
- `.agents/references/metrics/*.md` — each metric runbook has a "Most Common Optimizations" section and patch snippets.
- `.agents/references/stacks/aem-eds.md`, `stacks/aem-cs.md` — framework-specific source-edit mappings (e.g., `loadEager` vs `loadLazy` vs `loadDelayed` placements, clientlib categorization).
- `.agents/references/topics/request-chains.md` — guidance on which chains to preload vs defer.
- `.agents/references/topics/martech.md` — anti-patterns (never preconnect/preload analytics).

## Tools required
- `.agents/scripts/launcher.js` — Puppeteer harness with `--runs`, `--patches`, `--screenshot`, `--interact`, `--interact-delay` flags.
- Filesystem read/write (for `patches.json` and screenshots).
- JSON parsing of launcher output.
- Optional: Edit tool on source files for permanent implementation (only with user consent).

## Known limitations
- **Patches simulate, not persist.** The lab harness shows what a CDN/source change would do; the fix still has to be implemented permanently via CDN config, HTML edits, or source code. Output instructions make this explicit.
- **3rd-party CDN headers may not be rewritable in production.** If a fix depends on rewriting a response header on a domain you don't control (e.g., `googletagmanager.com`), explicitly flag the patch as lab-only and explain that the production workaround is usually to not load the resource, not to rewrite its headers.
- **INP validation requires synthetic click.** `--interact <selector>` drives a single click, which cannot represent the full diversity of real-user interactions. The fix may reduce synthetic INP while leaving other user journeys unchanged. Note this limitation in the output.
- **3-run median is indicative, not statistical.** Use `cwv-validate` (N=15, IQR comparison) for claims of the form "this fix improves LCP by 37%".
- **Visual regression check is manual (by screenshot).** No automated pixel diff is included; the user must inspect `baseline.png` vs `attempt-N.png`.
