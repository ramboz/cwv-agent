# Skill: cwv-validate

## Purpose
Statistically validate that a `patches.json` (or a permanently implemented fix) produces a real, significant CWV improvement — not random lab variance. Run N repetitions per condition (baseline + treatment), compute summary statistics (median, p75, p95, stddev, IQR), compare distributions, and emit an explicit VALIDATED / INCONCLUSIVE / REGRESSION / BELOW_THRESHOLD / NO_OP / NOT_MEASURED / UNRELIABLE verdict per metric.

## When to invoke
- After `cwv-fix` produces an accepted `patches.json` and you need to claim "this fix improves LCP by X%".
- Before deploying a change to production, to confirm it helps (and doesn't regress other metrics).
- After deploying, to measure the actual impact with the patch vs original.
- Any time you need to distinguish signal from noise in lab runs.

Do not invoke for early hypothesis testing — use `cwv-fix` (3 runs, indicative) for that.

## Prerequisites
- Provider profile: `local` validation with the in-repo launcher and
  `oracle.js`.
- `patches.json` from `cwv-fix` (or a modified source URL for pre/post comparison).
- Enough time budget: N=15 with ~30s per run on `mobile-slow4g-4xcpu` ≈ 7.5 min per condition = 15 min total for baseline + treatment.
- `npm ci` completed; harness scripts syntax-checked.
- Writable `screenshots/` (optional but recommended for visual diff).

## Workflow

### Step 0 — Doctor preflight (ADR-0014 / spec 014)
Before any lab measurement, run the same standalone doctor preflight gate the
5-step runbook enforces at every step. Resolve this skill's provider profile
(the one on the "Provider profile:" line above — `local` for the in-repo
oracle), then run:
```
node .agents/scripts/preflight.js --profile local
```
Exit codes: `0` = ready (or advisory-only), `1` = a required prerequisite is
**verifiably missing** (doctor `fail`/`not-wired`), `2` = usage error. On
exit 1, surface the command's own doctor rows verbatim and **stop** before any
browser/measurement
submission work — do not re-derive the message. Prerequisites doctor **cannot
self-verify** (status `unknown`) are printed as non-blocking advisories
(`⚠ preflight: could not verify …`) and the run **proceeds** — the gate never
refuses on an `unknown` alone. The identical `--skip-preflight` escape hatch
bypasses the gate (visible in output); use it only to intentionally reproduce
a mid-run failure. This is a read-only `doctor.js` call — it never runs
`setup.js`. When this skill runs as part of a `cwv-orchestrate` loop, the
numeric verdict is produced by `oracle.js` directly (not this skill) and the
loop already ran its own session preflight, so a standalone re-run here is only
for the manual/standalone path (see AGENTS.md "The 5-step workflow").

### Step 1 — Configure run parameters
Defaults:
- `N = 15` total runs per condition.
- `warmup = 2` runs discarded at the start of each condition (first runs are often outliers from cold DNS, TLS session setup).
- `$PROFILE` — read from the upstream `fix-findings.json` envelope's
  top-level `profile` field. Falls back to `mobile-slow4g-4xcpu` if no
  upstream envelope. The profile must match what cwv-fix used for
  baseline/treatment; refuse to proceed (or loudly warn and re-run) if the
  CLI-provided `--profile` disagrees with the envelope — a profile change
  invalidates the IQR comparison because throttled and unthrottled
  distributions differ by more than typical fix deltas.

Profile ↔ form factor pairing (for the report header):
- `mobile-slow4g-4xcpu` — PHONE, Lighthouse/PSI mobile calibration, correlates with CrUX mobile p75.
- `desktop-cable-1xcpu` — DESKTOP, Lighthouse/PSI desktop calibration, correlates with CrUX desktop p75. Renders at a representative **~1350×940** viewport (see below).

**Desktop renders at the Lighthouse desktop viewport (spec 003-06 / [ADR-0007](../../docs/decisions/adr-0007-desktop-viewport-fidelity.md)).** The `desktop-cable-1xcpu` profile renders at **1350×940 (deviceScaleFactor 1)** — Lighthouse's desktop `DESKTOP_EMULATION_METRICS`, the same standard its throttling is calibrated to — not Puppeteer's 800×600 default. The launcher records the rendered viewport at `output.viewport`; the oracle carries it onto the verdict (`viewport`). **CLS *score* is viewport-relative**: the distance fraction = shiftDistance / max(viewportWidth, viewportHeight), so the same shift *distance* (itself viewport-independent) scores higher in a smaller-max viewport — a fixed 300 px shift measures CLS **0.375 at 800×600** vs **0.222 at 1350×940** (denominator 800 → 1350). Baseline, treatment, and `--baseline2` MUST share the recorded viewport. The oracle now gates on `output.viewport` (`width` × `height`, plus `deviceScaleFactor` when both sides record it) and returns `UNRELIABLE` with an `incomparable` object when a viewport is missing or mismatched. A desktop CLS captured before the 003-06 viewport change (`800×600`) must still be re-baselined, but stale artifacts now fail closed instead of producing a clean verdict.

**Cloudflare / anti-bot opt-in.** If the upstream diagnosis required
`launcher.js --stealth` to reach the real page, set `STEALTH="--stealth"` and
pass it to BOTH baseline and treatment launcher runs. Never compare a default
headless baseline to a stealth/headful treatment (or vice versa) — that changes
the browser/runtime cohort instead of isolating the patch.

The caller may override N if the initial comparison is inconclusive. Recommend N≥25 when IQRs overlap strongly.

### Step 2 — Baseline runs
```
node .agents/scripts/launcher.js --url <URL> \
  --runs 15 --profile $PROFILE --scroll $STEALTH \
  --screenshot screenshots/baseline.png
```
Each run uses a fresh browser context (cold cache, cold cookies, cold service workers). Output JSON has `runs[0..14]`; drop the first 2 (warm-up), use runs 2..14 (13 effective samples) for stats.

### Step 3 — Treatment runs
Same invocation with `--patches patches.json`:
```
node .agents/scripts/launcher.js --url <URL> \
  --runs 15 --profile $PROFILE --scroll $STEALTH \
  --patches patches.json \
  --screenshot screenshots/treatment.png
```

**Field-faithful measurement (default) — baseline and treatment MUST match.** `--scroll` is on by default and is passed on BOTH runs above so the CLS oracle comparison is apples-to-apples. This is **required** to validate a CLS fix: a consent/scroll-lazy CLS fix is invisible to a load-only run (the shift happens post-load), which is why such fixes used to come back NOT_MEASURED/INCONCLUSIVE. The field-faithful CLS of record is `cwv.cls.value` (corroborated by `cwv.cls.shiftSummary.windowedFromShifts`). Only when **CLS is not among the target metrics** may you pass `--no-scroll` to BOTH runs to cut wall-clock (scroll adds ~20–30 s/run × 2×N runs); never mix scroll modes across baseline and treatment.

**INP note:** If INP is a target, add `--interact "<selector>" --interact-delay 500` to BOTH baseline and treatment, using the identical selector so the interaction path is comparable. Without `--interact`, `cwv.inp = { value: null, reason: 'not-observed' }` in every run — do not interpret that as "INP validated."

### Step 4 — Per-metric summary statistics
For each metric in {LCP, CLS, INP, FCP, TTFB}, compute over the 13 post-warmup samples:
- `median` (p50).
- `p75` — 75th percentile (the CWV-relevant one).
- `p95` — 95th percentile (tail behavior).
- `stddev` — population standard deviation.
- `IQR` — interquartile range, i.e., `[p25, p75]`.

Emit both the baseline and treatment stat blocks.

### Step 5 — Apply comparison rules
**UNRELIABLE pre-pass (runs before NO_OP, per metric).** If either side has too few valid samples (`n < --min-samples`, default 3) or is too noisy (IQR large in BOTH relative and absolute terms — `IQR/|median| > --max-rel-spread` AND `IQR` above a per-metric absolute floor), emit **`UNRELIABLE`** for that metric. This is the explicit "could-not-measure-reliably" outcome: a heavy ad page that yields 0–1 usable samples under throttle, or a metric whose lab readings swing wildly run-to-run. The right action is to **re-measure** (more runs via `--max-runs`, a lighter profile, or `--block` the noise source), **not** to treat the number as a verdict. `UNRELIABLE` is distinct from `INCONCLUSIVE` (a real comparison whose delta is within noise) and from `NOT_MEASURED` (0 samples on *both* sides — the metric wasn't captured at all). Asymmetric zero-samples (one side empty) is `UNRELIABLE`, not `NOT_MEASURED`. In the roll-up, `UNRELIABLE` is silent when a sibling target metric measured cleanly, but a sole-target or all-silent `UNRELIABLE` makes the overall verdict `UNRELIABLE` (exit 7).

**NO_OP pre-pass (runs after UNRELIABLE, per metric).** If the paired baseline and treatment sample arrays are tolerance-identical — i.e., after sorting both sides, `max(|bᵢ − tᵢ|) < max(1e-9 × |baseline_median|, 1e-6)` — emit **`NO_OP`** for that metric. This catches silent patch-application failures (bad selector, unrecognized `action` name) where treatment samples are bit-identical to baseline. The right action on `NO_OP` is to investigate the patch applier, **not** the metric. Do not confuse `NO_OP` with `BELOW_THRESHOLD`: a real but tiny delta (e.g. LCP 2000 → 2050, below the 200ms floor) still routes to `BELOW_THRESHOLD`, not `NO_OP`.

Then compare the two IQRs and medians per metric:
- **Treatment IQR does not overlap baseline IQR** AND **treatment median < baseline median** → **HIGH CONFIDENCE IMPROVEMENT**. Verdict: `VALIDATED`.
- **IQRs overlap but medians are clearly separated** (specifically: treatment median < baseline p25, OR baseline median > treatment p75) → **MODERATE CONFIDENCE IMPROVEMENT**. Verdict: `VALIDATED` with caveat.
- **Medians are within each other's IQR** (treatment median within `[baseline_p25, baseline_p75]` AND baseline median within `[treatment_p25, treatment_p75]`) → **INCONCLUSIVE**. Verdict: `INCONCLUSIVE`; recommend larger N or investigate variance sources.
- **Treatment median > baseline median** (worse, past MIN_ACTIONABLE_IMPACT) → **REGRESSION DETECTED**. Verdict: `REGRESSION`. Flag loudly.
- **|delta| < MIN_ACTIONABLE_IMPACT** and not a regression and samples not tolerance-identical → **`BELOW_THRESHOLD`**.

**Multi-source / content-variable pages — validate the *targeted shift source*, not total CLS (`--cls-source`, `--baseline2`).** On pages whose CLS comes from several elements (a consent banner + lazy ad/editorial modules), total-CLS A/B is dominated by run-to-run variance in the *non-targeted* sources and can manufacture a spurious `VALIDATED` — a no-patch A/A control on such a page can itself "validate" a larger delta than a real fix. **When validating a CLS fix on a busy page (e.g. a news homepage), pass both:**
- **`--cls-source <selector>`** adds a `CLS@<selector>` target that compares only the matching shift sources' summed `clsShare` (from `cwv.cls.shiftSources[]`; a run that didn't shift that source counts as `0`). The normal reliability gate applies, so a **stable** target source (e.g. `cookies__container`) validates cleanly while a **volatile** one (e.g. a lazy `list__wrapper` carousel) self-reports `UNRELIABLE` — precisely the sources you can vs. cannot trust an A/B on. Matching is a node substring, so an ancestor token (`cookies__container`) captures the whole banner stack.
- **`--baseline2 <path>`** supplies a *second no-patch baseline* and turns on the **A/A noise-floor gate**: any metric (total or per-source) whose two baselines themselves differ past `MIN_ACTIONABLE_IMPACT` (with separated medians) is forced to `UNRELIABLE` (with an `aa` field recording the control delta) — the page's run-to-run drift exceeds the effect size, so an A/B verdict there can't be trusted. A gated total-CLS verdict is silent in the roll-up, so a clean `CLS@<source>` target still decides the overall result.

Worked example (news.example.com consent-banner fix): total `CLS` read Δ−0.041 → `VALIDATED (moderate)` under the plain comparison, but `--baseline2` showed a *no-patch* A/A control moving Δ−0.074 → total `CLS` → `UNRELIABLE`; `--cls-source cookies__container` showed the banner Δ+0.014 → `BELOW_THRESHOLD`. Net: that fix (a structural position-pin override) did **not** validate — the plain total-CLS `VALIDATED` was a false positive, and the per-source target showed the override was causally inert (the real shift is the banner's *entrance animation*, not its position). (Diagnosis + data: `progress/the news-site case-com-br/loop-2026-06-10/`.)

**Validating a served-JS fix with `rewriteBody` (incl. cross-origin vendor bundles).**
`rewriteBody` is not limited to CSS/HTML. The launcher intercepts **every** served response
(CDP `Fetch.enable` with `urlPattern: '*'` at the Response stage), reads the body, and byte-
patches any response whose URL-glob matches — **including a cross-origin vendor JS bundle**.
So you can lab-validate a fix that lives in *compiled / vendored JavaScript* before anyone
rebuilds it — not just markup and stylesheets. (Corrects the common misconception that the
lab can only patch first-party CSS/HTML.) A `rewriteBody` rule is
`{ urlPattern, replacements: [{ find, replace, isRegex? }] }`; the `find`/`replace` runs on the
decoded response body, so it must match the **served** bytes (use `isRegex` for minified
bundles where whitespace/identifiers vary).

Worked example (the news-site case — the fix that *did* validate): the consent banner is revealed by
jQuery `$('.cookies__container').show(e)` (an animation duration → it tweens width/height open;
this is the `animated-reveal` C6 flags) inside a vendored `theme.js`. The treatment patch
rewrites the reveal to be instant:
```json
{
  "rewriteBody": [
    { "urlPattern": "*theme.js*", "replacements": [ { "find": ".show(e)", "replace": ".show()" } ] }
  ]
}
```
Validated **per shift source**: `--cls-source cookies__container` read `CLS@cookies__container`
**0.138 → 0.000 → VALIDATED (high)** while total `CLS` was A/A-gated `UNRELIABLE`. That proves
the one-line source change before the vendor rebuilds it. **Caveat — this is shallow
validation:** it proves the fix's *effect* in the lab; shipping still requires the real
source/bundle change (`cwv-fix` maps a `rewriteBody` treatment to a *source edit*, never a
runtime-only prod patch). See the reveal fix recipe in
[`playbooks/layout-shift.md`](../references/playbooks/layout-shift.md) → "Reveal or expand
content without shifting layout".

### Step 6 — Emit per-metric report
Example for LCP:
```
Metric: LCP
Baseline:  median=3420ms, p75=3800ms, p95=4100ms, stddev=280, IQR=[3200, 3900]
Treatment: median=2150ms, p75=2400ms, p95=2600ms, stddev=180, IQR=[2000, 2600]
Delta:     -1270ms median (-37%), IQRs non-overlapping
Verdict:   FIX VALIDATED (high confidence)
```

Do this for every metric — including metrics NOT targeted by the fix, to catch unintended regressions. A fix that halves LCP but doubles INP is a net loss, and only a per-metric comparison surfaces this.

### Step 7 — Overall pass/fail
Aggregate the per-metric verdicts into a single gate:
- **PASS** only if:
  - No metric has verdict `REGRESSION`.
  - All targeted metrics have verdict `VALIDATED`, OR have verdict `INCONCLUSIVE` with a positive median delta (treatment median ≤ baseline median).
- **FAIL** otherwise, with the failing metric(s) named.

### Step 8 — Output the final report
Include:
- URL, profile, **viewport** (`output.viewport` / the oracle's `viewport`), N, warmup count. State the viewport explicitly so a desktop CLS is read as viewport-relative (003-06).
- `patches.json` path (or description of source change).
- Per-metric stat table (baseline vs treatment).
- Per-metric verdict.
- Overall PASS / FAIL.
- Baseline and treatment screenshot paths for qualitative check.
- Any warnings (e.g., "INP validated on synthetic `a.cta` click; real-user INP may differ across interaction types").
- Recommended next step on FAIL (try larger N, or return to `cwv-fix` to iterate the patch).

## Output format

Emit BOTH a human-readable report and a structured Findings envelope.

### Human report
A markdown report with:
1. Configuration block (URL, profile, viewport, N, warmup, patches).
2. Per-metric stats table for baseline.
3. Per-metric stats table for treatment.
4. Per-metric comparison with explicit `VALIDATED` / `INCONCLUSIVE` / `REGRESSION` / `BELOW_THRESHOLD` / `NO_OP` / `NOT_MEASURED` / `UNRELIABLE` verdict. `NOT_MEASURED` fires when a metric has 0 samples on both sides (e.g. INP without `--interact`, TBT where no long tasks occurred) — silent in the overall roll-up, so targeting a metric the runner doesn't capture no longer forces `INCONCLUSIVE`. `UNRELIABLE` (exit 7) fires when a metric *has* samples but too few (`< --min-samples`) or too noisy to trust, or when baseline/treatment/`--baseline2` launcher outputs have missing or mismatched recorded viewports — re-measure rather than reject.
5. Overall `PASS` / `FAIL` line.
6. Caveats (INP synthetic, variance sources if INCONCLUSIVE).
7. Screenshot paths.

Example comparison table row:
```
| Metric | Base median | Treat median | Base IQR | Treat IQR | Overlap? | Verdict |
|--------|-------------|--------------|----------|-----------|----------|---------|
| LCP    | 3420        | 2150         | [3200,3900] | [2000,2600] | No     | VALIDATED |
| CLS    | 0.08        | 0.07         | [0.06,0.09] | [0.05,0.09] | Yes    | INCONCLUSIVE |
| INP    | 180         | 195          | [160,210] | [170,230]  | Yes     | REGRESSION |
```

### Structured findings (REQUIRED)
Emit `validate-findings.json` conforming to [finding-schema.md](../references/topics/finding-schema.md). Take the `applied` findings from `fix-findings.json` and emit a terminal-status Finding per fix verified:

- Preserve `id`, `cause`, `recommendation`, `patches` from upstream.
- Set `skill: "cwv-validate"`.
- Replace the 3-run `measurement-delta` evidence entry with a 15-run one: `{ kind: "measurement-delta", data: { metric, baseline, treatment, deltaMs|deltaScore, runs: 15, baselineIQR, treatmentIQR, iqrOverlap } }`.
- Update `impactReduction` with the median-over-15-runs delta.
- Set `status`:
  - `validated` — non-overlapping IQRs and positive median delta.
  - `rejected` — INCONCLUSIVE (overlapping IQRs) or delta below MIN_ACTIONABLE_IMPACT.
  - `regression` — treatment median worse than baseline, or non-target metric regressed past MIN_ACTIONABLE_IMPACT.
  - `no_op` — oracle verdict `NO_OP` (treatment samples match baseline within tolerance; the patch did not alter runtime behaviour). First-class terminal status so the orchestrator can filter silent no-ops from real rejections. Retain `reason` text for surfacing which metrics were tolerance-identical.
- `confidence`: field-tier cap still applies — bump to the maximum of the source cap when IQRs are non-overlapping (strong lab signal, but still capped at source tier).

Validate before writing:
```bash
node .agents/scripts/finding-schema.js validate-findings.json
```

Terminal statuses — a `validated` | `rejected` | `regression` finding is not mutated further in this session.

### Report handoff
`cwv-validate` promotes only findings that are still eligible after the oracle
verdict:

- A code-change fix is handoff-ready only when the target metric's oracle
  verdict is `VALIDATED`. The emitted `validate-findings.json` /
  `fix-findings.json` finding must carry `status:"validated"` plus deployable
  source material (`sourceEdits`, from which `cwv-report` derives the unified
  diff).
- `INCONCLUSIVE`, `UNRELIABLE`, `REGRESSION`, `BELOW_THRESHOLD`, `NO_OP`, and
  `NOT_MEASURED` outcomes remain non-shippable as code changes. Emit
  `rejected`, `regression`, or `no_op` as appropriate and return to
  diagnosis/fix rather than handing them to the report.
- Guidance-only findings (including `manual-review` classifications) are not
  oracle-promoted as code changes. They enter the report only with a
  mechanism-confirmed `rootCause:true` and honest confidence, and must remain
  patchless/advisory.

## References to read
- `.agents/references/topics/finding-schema.md` — terminal lifecycle states; `measurement-delta` evidence shape.
- `.agents/references/metrics/*.md` — each metric's Good / Needs Improvement / Poor thresholds (used for framing severity of regression or improvement).
- `.agents/references/topics/field-vs-lab.md` — context on why each profile (`mobile-slow4g-4xcpu` ↔ CrUX mobile p75, `desktop-cable-1xcpu` ↔ CrUX desktop p75) pairs with a specific form factor; note that validated lab improvement on one form factor does NOT transfer to the other and is a leading indicator, not a guarantee, of field improvement.
- `.agents/references/topics/evidence-and-confidence.md` — confidence scale; a VALIDATED verdict corresponds to 0.9–1.0 confidence (direct measurement).

## Tools required
- `.agents/scripts/launcher.js` — with `--runs 15` and `--patches` and optional `--interact`.
- JSON parsing for statistics (median, p25/p75, stddev, IQR).
- Filesystem for reading launcher output and writing report.
- No external statistical library required — all stats are elementary and computable in-line.

## Known limitations
- **Lab is a proxy for field.** A VALIDATED lab improvement on `mobile-slow4g-4xcpu` predicts but does not guarantee CrUX p75 improvement. Monitor CrUX for 28 days post-deployment to confirm in the field.
- **INP validation is synthetic.** `--interact <selector>` fires a single click. Real users click many different elements; a validated INP fix at one interaction target does not guarantee INP improvement across the full interaction surface. State this limitation explicitly in the output.
- **CLS is often 0 in cold-cache lab runs** because there's no scroll, no lazy content injection post-LCP, no user interaction. A lab CLS VALIDATED verdict carries less weight than LCP or INP; prefer field CLS data for validation.
- **N=15 catches most real effects but not subtle ones.** For effects smaller than ~5% of baseline median, recommend N≥30.
- **IQR-based comparison is non-parametric and conservative** — it avoids assuming normality (CWV distributions are usually right-skewed). A formal Mann-Whitney U test would be slightly more powerful but adds complexity; IQR comparison is sufficient for the lab-validation use case.
- **Network / server variance outside our control** will inflate IQRs. If baseline IQR is unexpectedly wide, the run environment may be noisy — rerun at a different time, or increase N.
