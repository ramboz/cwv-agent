# Skill: cwv-orchestrate

## Purpose
Long-running autonomous loop that races CWV intervention candidates against a
target URL, measures each with `launcher.js`, verdicts each with `oracle.js`,
and **additively** promotes validated patches — with the user as final
reviewer. The loop is gated by the numeric oracle, not by the agent's
self-assessment. Experiments that don't clear the oracle are preserved in
`session.json` with a reason, so the loop never silently forgets a rejection.

## When to invoke
- You have a target URL and want to iteratively improve its CWV metrics
  without manually chaining `diagnose → fix → validate`.
- You have a frontend source repo checked out locally alongside
  cwv-agent, and you want validated patches handed off as local branch refs
  plus git-applicable patch files.
- Running in a fresh session with no prior state — the orchestrator will
  create `progress/{slug}/` and do its own baseline + diagnose.
- Resuming an interrupted session — the orchestrator reads `session.json`,
  skips completed experiments, and continues from the first pending
  candidate.

Do not invoke if:
- You only want a one-shot analysis (use `cwv-analyze`).
- You need a formatted review handoff only (use `cwv-report` after
  validation).
- You have a single fix in mind already (use `cwv-fix` + `cwv-validate`).

## Prerequisites

### Hard preconditions (skill refuses to start if missing)
- **Target URL** — the page to optimize.
- **`npm ci` completed** in cwv-agent (puppeteer, web-vitals IIFE).
- **Doctor preflight (ADR-0014)** — see Step 0. Before any directory or
  launcher work, `node .agents/scripts/preflight.js --profile <resolved>`
  must exit 0 (no verifiably-missing required prerequisite — `fail`/`not-wired`
  block; unverifiable `unknown` checks only advise), unless `--skip-preflight`
  was explicitly passed.

### Optional local-git preconditions
- **Source repo path** — required only when the operator wants source patches
  or local branches. The skill verifies it is a git working tree (`.git` file
  or directory) before creating branch refs. Without source, the run still
  measures, verdicts, and emits `artifacts-manifest.json` with
  `branchOutput.mode: "none"`.

### Optional field-profile preconditions
- **`.env` Google keys** (`GOOGLE_CRUX_API_KEY`,
  `GOOGLE_PAGESPEED_INSIGHTS_API_KEY`) are required only when the
  `field-google` triage profile is enabled.

### Soft preconditions
- Time budget: a full run with 5 candidates × (5 baseline + 5 treatment runs
  each) + translate + validate at 30s/run on `mobile-slow4g-4xcpu` ≈ 30 min.
- `maxWorkers` default 2 (hard cap 4). Beyond that, Puppeteer noise on a
  laptop dominates the oracle's IQR.

## Degraded mode (field unavailable)
For the default `local` profile, missing field providers are normal: the skill
uses the lab baseline + in-repo analyzers and records `degradedMode:
"lab-only"` in `session.json` only when an optional field profile was requested
but unavailable or under-sampled. This is a warning, not a failure.

## Workflow

### Step 0 — Preflight
Read `sourceRepoPath`, `url`, `targetMetrics` (default: `["LCP","CLS","INP"]`),
`maxWorkers` (default 2), and the optional `--force` flag (see below). Fail
fast if:
- `url` is not a valid http(s) URL.
- `targetMetrics` contains unknown metrics.
- branch output was requested and `sourceRepoPath` is missing, not a directory,
  or not a git repo.

**Doctor preflight gate (ADR-0014 / spec 014-01) — run this FIRST, before
creating any directory.** Resolve the execution/provider profile this run is
about to exercise — default `local`, escalated to whichever optional provider
profile the operator named (e.g. `field-google` when the run will start from
field triage). This is the same
"Provider profile" line already documented in
`cwv-diagnose.md`/`cwv-validate.md`/`cwv-fix.md`'s Prerequisites sections —
not new vocabulary. Then run the standalone preflight as the very first action
of the run — **before** deriving `slug`, **before** creating `progress/{slug}/`,
and **before** the Step 1 baseline `launcher.js` call:

```
node .agents/scripts/preflight.js --profile {resolved execution/provider profile}
# or: npm run preflight -- --profile {resolved}
```

Exit codes: `0` = ready (or skipped, or advisory-only — see below), `1` = a
required prerequisite is **verifiably missing**, `2` = unknown profile / usage
error. On exit 1, surface the command's own stdout (doctor's failing rows)
verbatim and **stop immediately** — do not derive `slug`, do not create
`progress/{slug}/`, do not invoke `launcher.js`, and do not run any
measurement, diagnosis, patch, or report work. Do not re-derive the error
message.

**Block vs. advise.** The gate refuses only on prerequisites doctor can
**positively determine are absent** — status `fail` (missing binary,
unwritable dir, unresolvable module) or `not-wired` (an unwired provider
adapter). Prerequisites a zero-write doctor **cannot self-verify** — status
`unknown` — are surfaced as **non-blocking advisories**
(`⚠ preflight: could not verify …`) and the run **proceeds (exit 0)**. A
genuinely missing tool still blocks.

An operator who intentionally wants the old late-failure behavior (e.g. to
reproduce a bug report) may pass `--skip-preflight`:

```
node .agents/scripts/preflight.js --profile {resolved} --skip-preflight
```

When used, the command prints `preflight: skipped (--skip-preflight) for
profile "<resolved>"` to stdout and exits 0, so a bypassed run is never
silently indistinguishable from a gated one. Do not pass `--skip-preflight`
in normal auto-mode runs.

This gate calls `doctor.js` only (read-only, via `preflight.js`) — never
`setup.js` or any of its mutating flags. Remediation (`npm run setup ...`)
stays an explicit operator action; the orchestrator never runs it on the
operator's behalf.

`launcher.js` also accepts `--preflight-profile`/`--skip-preflight` as a
defense-in-depth second layer (same gate, embedded in the launcher's own
arg-validation), but the **authoritative** Step-0 gate is the standalone
`preflight.js` call above — it is what satisfies "refuse before creating
`progress/{slug}/` or invoking `launcher.js`."

**Field-already-passing check (only when field data is available; refuse unless
`--force`).** If a triage
envelope already exists at `progress/{slug}/triage-findings.json` (from a
prior `cwv-analyze` or explicit triage run), read it. Otherwise, run
`cwv-triage` for the single URL only when `field-google` is
enabled and persist the envelope there. With the default local profile and no
field data, skip this gate and proceed to the lab baseline. Then:
- If the envelope's top-level `status === "passing"`, **do not start the
  loop**. Emit a single line to stdout:
  ```
  field already passing on <metrics> (<form factor>); no action — pass --force to override
  ```
  Where `<metrics>` is the comma-separated list from `passing.checked` and
  `<form factor>` is `passing.byFormFactor`'s keys. Exit 0 without creating
  `progress/{slug}/session.json`. The triage envelope itself is preserved
  as the audit trail.
- If `--force` was passed, proceed normally, BUT echo the override into
  `session.json` as `forcedPastPassing: true` + copy the triage
  `passing` block verbatim into `session.forcedPastPassingContext` so the
  SUMMARY.md shows why the user overrode the gate.

`--force` is intended for the "investigate field/lab gap" use case: CrUX is
green but the user feels the page is slow (small cohort, recent regression
not yet in the 28-day window, or an interaction not measured by CrUX).
Normal auto-mode runs should never pass it.

Derive `slug` from `url` (hostname + path, slugified; e.g.
`https://www.example.com/products/` → `www-example-com-products`).
Create `progress/{slug}/` if missing.

### Step 1 — Baseline
```
node .agents/scripts/launcher.js \
  --url <url> --profile mobile-slow4g-4xcpu --runs 5 --scroll $STEALTH \
  --output progress/{slug}/baseline.json
```
Five cold-cache runs. This baseline is the reference for the *final* total-gain
report. The *effective baseline* for each subsequent candidate comparison is
the last validated experiment's result (see Step 5 — Additive winners).

The doctor preflight already ran and passed in Step 0 (standalone
`preflight.js`), so no `--preflight-profile` flag is needed here. You *may*
pass `--preflight-profile {resolved}` on this baseline call as harmless
defense-in-depth, but it is redundant with Step 0 and must never appear on the
repeated racing-loop calls in Step 4 (it would re-pay doctor's checks on every
candidate).

**Field-faithful measurement (default), and its cost.** `--scroll` is on by
default (explicit here) so the baseline + every experiment capture the
field-faithful CLS of record — required for any CLS-class candidate to be
measurable (a consent/scroll-lazy CLS fix is invisible to a load-only run).
**Baseline and all experiments MUST use the same scroll mode** so the oracle
comparison is valid. Scroll adds ~20–30 s/run; a session is 30+ runs, so this
is a real wall-clock cost. **Cost opt-out:** if the session's target metrics are
LCP/INP-only (no CLS candidate in the ranked pool), pass `--no-scroll` on the
baseline AND every experiment to skip it — but never mix modes within a session.

**Cloudflare / anti-bot opt-in.** If default headless measurement reaches a
challenge stub instead of the real page, set `STEALTH="--stealth"` for the whole
session and pass it to baseline, baseline-2, and every experiment launcher run.
Never mix stealth and non-stealth runs inside one oracle comparison.

### Step 1b — CLS noise-floor probe (only when CLS is a target metric)
A page whose CLS comes from several shift sources (news / ad-heavy / content-variable)
has a total CLS that swings run-to-run from the *non-targeted* sources — so a total-CLS
A/B comparison can false-VALIDATE (an A/A control on the news-site case oracle'd to VALIDATED/HIGH
from zero intervention). This step decides, from data, whether to validate a single
stable shift source instead of total CLS, and auto-captures the A/A control the oracle
needs. It removes the "a human has to know to pass `--cls-source`" gap.

```
node .agents/scripts/cls-variance.js progress/{slug}/baseline.json \
  > progress/{slug}/cls-variance.json
```
Read the report (pure transform — no LLM, no browser). It pools the baseline runs and
emits, per shift source (grouped by a stable cross-run signature), a `stable|volatile`
classification (presence gate + `measure-quality.assessReliability` CLS abs floor 0.1),
the total-CLS `noiseFloor` (run-to-run range), a `noiseDominated` flag (noiseFloor >
MIN_ACTIONABLE_IMPACT.CLS = 0.03), and a `recommendedClsSource` — the dominant *stable*
source's oracle token, re-validated under oracle's substring-sum semantics so the
recommended number is the number the oracle will produce.

**If `noiseDominated` is true AND `recommendedClsSource` is non-null:**
1. Set `session.clsNoiseDominated = true`, `session.recommendedClsSource =
   report.recommendedClsSource`, and copy `report.volatileSources` /
   `report.stableSources` into the session for the SUMMARY.
2. Capture a **second** no-patch baseline (identical conditions — same profile, same
   `--scroll` mode) for the A/A noise-floor gate:
   ```
   node .agents/scripts/launcher.js \
     --url <url> --profile mobile-slow4g-4xcpu --runs 5 --scroll $STEALTH \
     --output progress/{slug}/baseline-2.json
   ```
   Set `session.baseline2File = "progress/{slug}/baseline-2.json"`.
3. Re-run the probe pooled over **both** baselines for the firmer ≥10-run classification
   (the 2nd baseline does double duty — A/A control *and* more runs for the source
   stability call):
   ```
   node .agents/scripts/cls-variance.js \
     progress/{slug}/baseline.json progress/{slug}/baseline-2.json \
     > progress/{slug}/cls-variance.json
   ```
   Refresh `session.recommendedClsSource` from the pooled report.

If `noiseDominated` is false, skip all of the above — total CLS is trustworthy on this
page; do not pay for a 2nd baseline. If the probe is `insufficientRuns` (a flaky target
aborted runs — pairs with V2), proceed without the gate and note it in the SUMMARY.

### Step 2 — Diagnose → rank
Two sub-steps. Skip both if `progress/{slug}/ranked_patches.json` already
exists from a prior run.

**2a.** Invoke `cwv-diagnose` on the baseline. It reads `baseline.json`,
runs the five analyzers in parallel, and emits a Finding envelope to
`progress/{slug}/diagnose-findings.json` (shape defined in
[finding-schema.md](../references/topics/finding-schema.md)). Every
`status: "proposed"` finding with non-empty `patches` is a candidate.

`cwv-diagnose` Step 8b already tagged each finding with an `owner`
(ownership attribution). Preserve it — the loop carries it through and the
summary reports the **"platform, site code, or third party?"** verdict
(Step 7). Findings with a `requires-operator` / `requires-tag-manager-rule`
`deliveryConstraint` are not patchable by the branch-based loop; note them but
don't expect a validated lab delta (they route to the operator or a
tag-manager rule, not the `perf/*` branch loop).

**2b.** Transform the findings envelope into the ranked candidate list the
loop consumes:
```
node .agents/scripts/rank-candidates.js \
  --findings progress/{slug}/diagnose-findings.json \
  --output   progress/{slug}/ranked_patches.json
```

`rank-candidates.js` is deterministic (pure transformation — no LLM). It
filters findings where `status !== "proposed"` or `patches` is empty or
`confidence < 0.5`, then sorts by `expectedImpactMs × confidence` (for CLS,
`score × 1000` normalizes to an ms-equivalent for ranking). Tie-breakers:
confidence desc, then id ascending (stable order across reruns).

Output shape:
```json
{
  "schemaVersion": "1.0",
  "url": "...",
  "generatedAt": "...",
  "sourceFindings": 12,
  "dropped": 4,
  "candidates": [
    {
      "id": "diagnose-lcp-1",
      "findingId": "diagnose-lcp-1",
      "metric": "LCP",
      "expectedImpactMs": 1200,
      "expectedImpactScore": null,
      "confidence": 0.85,
      "rankScore": 1020,
      "patch": { "preloads": [ { "href": "/hero.jpg", "as": "image", "fetchpriority": "high" } ] },
      "recommendation": "Add <link rel=preload as=image ...> above the render-blocking stylesheet.",
      "severity": "high",
      "source": "har",
      "rootCause": true
    }
  ]
}
```

Candidate `id` equals the upstream `findingId`, so the Finding lifecycle
stays linked across diagnose → orchestrate → cwv-fix.

Exit codes: `0` = candidates ranked; `2` = zero candidates after filtering
(the orchestrator should stop with "nothing actionable").

### Step 3 — Initialize session.json
Write `progress/{slug}/session.json`:
```json
{
  "schemaVersion": "1.0",
  "slug": "...",
  "url": "...",
  "sourceRepoPath": "/absolute/path",
  "targetMetrics": ["LCP","CLS","INP"],
  "maxWorkers": 2,
  "degradedMode": null,
  "baselineFile": "progress/{slug}/baseline.json",
  "rankedPatchesFile": "progress/{slug}/ranked_patches.json",
  "cumulativePatchFile": "progress/{slug}/cumulative.json",
  "effectiveBaselineFile": "progress/{slug}/baseline.json",
  "clsNoiseDominated": false,
  "recommendedClsSource": null,
  "baseline2File": null,
  "integrationProviders": {
    "fieldData": { "status": "not-used", "profiles": [], "providers": [], "artifacts": [] },
    "source": { "status": "not-used", "profiles": [], "providers": [], "artifacts": [] },
    "diagnosis": { "status": "used", "profiles": ["local"], "providers": ["cwv-agent"], "artifacts": ["progress/{slug}/diagnose-findings.json"] },
    "validation": { "status": "used", "profiles": ["local"], "providers": ["oracle"], "artifacts": [] },
    "reporting": { "status": "not-used", "profiles": [], "providers": ["cwv-report"], "artifacts": [] }
  },
  "experiments": [],
  "promoted": [],
  "rejected": [],
  "pendingCandidateIds": ["exp-001-preload-hero", "exp-002-defer-analytics", ...],
  "startedAt": "...",
  "updatedAt": "...",
  "status": "running"
}
```
Initialize `progress/{slug}/cumulative.json` to `{}` — an empty patch bundle.
Keep `integrationProviders` current when optional profiles are enabled. The
local artifact manifest preserves this block when present and otherwise infers
it from the emitted Finding/source/verdict files.

### Step 4 — Main loop

```
while session.pendingCandidateIds is non-empty:
  id = session.pendingCandidateIds.shift()
  candidate = ranked_patches.candidates[id]

  # 4.1 — Build candidate patch bundle = cumulative ∪ candidate.patch
  mkdir progress/{slug}/experiments/{id}/
  merged = mergePatches(cumulative, candidate.patch)
  if merged.conflict:
    mark-rejected(id, reason="merge conflict with cumulative: " + merged.conflictDetail)
    continue
  write progress/{slug}/experiments/{id}/patch.json = merged.bundle

  # 4.2 — Measure (one worker at a time unless user set maxWorkers>1 and 2+ candidates pending)
  node .agents/scripts/launcher.js \
    --url <url> --profile mobile-slow4g-4xcpu --runs 5 --scroll $STEALTH \
    --patches progress/{slug}/experiments/{id}/patch.json \
    --output  progress/{slug}/experiments/{id}/result.json
  # --scroll MUST match the baseline's mode (see Step 1). Use --no-scroll on both
  # only for an LCP/INP-only session with no CLS candidate.

  # 4.3 — Oracle
  #
  # On a CLS-noise-dominated page (set by Step 1b), total-CLS A/B can false-VALIDATE
  # from run-to-run drift in the NON-targeted sources, so for a CLS candidate auto-thread
  # the per-source gate + the A/A control captured in Step 1b — no human decision needed:
  clsFlags = ""
  if candidate.metric == "CLS" and session.clsNoiseDominated:
    # Validate THIS fix's own shift source. Prefer the candidate's own attribution
    # target when Step 1b classified it stable; else fall back to the dominant stable
    # source. Reduce a full selector to the oracle token (leaf-most class) the same way
    # cls-variance does. Skip the per-source gate if the candidate targets a source the
    # probe flagged volatile (its clsShare itself is untrustworthy → it'll self-UNRELIABLE).
    target = tokenFor(candidate.attribution.target) or session.recommendedClsSource
    clsFlags = "--cls-source {target}"
    if session.baseline2File: clsFlags += " --baseline2 {session.baseline2File}"

  node .agents/scripts/oracle.js \
    --baseline  {session.effectiveBaselineFile} \
    --treatment progress/{slug}/experiments/{id}/result.json \
    --metrics   {session.targetMetrics.join(',')} \
    {clsFlags} \
    --output    progress/{slug}/experiments/{id}/verdict.json
  # A stable targeted source validates cleanly (the news-site case banner: CLS@cookies__container
  # 0.138→0, VALIDATED/high) while total CLS is correctly A/A-gated UNRELIABLE. A volatile
  # source self-flags UNRELIABLE rather than false-VALIDATE. See cwv-validate.md
  # "Multi-source / content-variable pages" + the V1/V4 ROADMAP entries.
  verdict = read(progress/{slug}/experiments/{id}/verdict.json).verdict

  # 4.4 — Act on verdict
  switch verdict:
    case "VALIDATED":
      cumulative = merged.bundle
      write progress/{slug}/cumulative.json = cumulative
      session.effectiveBaselineFile = progress/{slug}/experiments/{id}/result.json
      session.promoted.push(id)
      # Translate to source only when a local source repo is attached (see Step 6).
      # URL-only local sessions still complete with measurements, verdicts,
      # patches, and an artifacts-manifest.json handoff.
      if session.sourceRepoPath:
        runTranslate(id, candidate, session.sourceRepoPath)
      else:
        record-source-translation-skipped(id, reason="no source repo attached")

    case "REGRESSION":
      mark-rejected(id, reason="REGRESSION on " + verdict.metrics.filter(regressed).map(m => m.metric))

    case "INCONCLUSIVE":
      if experiment.retryCount < MAX_RETRIES (default 1):
        re-run Step 4.2 with --runs 10
        re-run oracle
      else:
        mark-rejected(id, reason="INCONCLUSIVE after MAX_RETRIES; IQR overlap persists")

    case "BELOW_THRESHOLD":
      mark-rejected(id, reason="delta below MIN_ACTIONABLE_IMPACT")

    case "NO_OP":
      # Treatment samples match baseline within numeric tolerance — the
      # patch did not apply. Do not retry; the patch applier is at fault,
      # not variance. Emit `status: "no_op"` (first-class terminal state)
      # so SUMMARY.md can count silent no-ops without string-sniffing the
      # `reason` field of generic `rejected` findings.
      mark-no-op(id, reason="no-op metrics: " + verdict.metrics.filter(m => m.verdict === 'NO_OP').map(m => m.metric).join(','))
      session.noOpCount = (session.noOpCount || 0) + 1
      # Systemic-failure abort: if ≥3 consecutive experiments return NO_OP
      # (or ≥50% of the last 4), the patch applier is broken. Stop and
      # surface the issue rather than burning time on candidates that
      # cannot possibly apply.
      if consecutiveNoOps(session) >= 3:
        session.status = "aborted"
        write SUMMARY.md with explicit systemic-no-op callout
        exit "aborted-systemic-no-op"

    case "NOT_MEASURED":
      # Every target metric had 0 samples on both sides — the runner
      # didn't capture what the user asked to validate. This is a session-
      # level misconfiguration (e.g. INP in targetMetrics without
      # `--interact`). Not a per-experiment problem, so abort rather than
      # burn runs on the same misconfig repeatedly.
      session.status = "aborted"
      session.abortReason = "not-measured: " + verdict.metrics.filter(m => m.verdict === 'NOT_MEASURED').map(m => m.metric).join(',')
      write SUMMARY.md noting the misconfiguration and which metrics to
        drop (or how to re-run, e.g. `--interact` for INP)
      exit "aborted-not-measured"

    case "UNRELIABLE":
      # A target metric HAS samples but too few / too noisy to trust (a heavy
      # ad page yielding 0–1 usable samples under throttle; ad/3p variance).
      # This is a MEASUREMENT problem, not a bad candidate — re-measure harder
      # before judging the patch. Escalate measurement on retry:
      if experiment.retryCount < MAX_RETRIES (default 1):
        re-run Step 4.2 with escalated reliability settings:
          --max-runs 12   (adaptive: collect until stable)
          + consider --block on the noisiest ad/3p domains (from result.resources.byDomain)
          + consider a lighter profile (desktop-cable-1xcpu) if the slow-4G/4×CPU
            profile is starving samples
        re-run oracle
      else:
        # Still unreliable after escalation — the page can't be measured
        # reliably in lab for these metrics. Record honestly; do NOT promote
        # and do NOT count as a patch-applier (NO_OP) failure.
        mark-rejected(id, reason="UNRELIABLE after escalation: " + verdict.metrics.filter(m => m.verdict === 'UNRELIABLE').map(m => m.metric).join(',') + " — page not lab-measurable for these metrics (try field data / --block / lighter profile)")
      # If EVERY candidate keeps returning UNRELIABLE, this is a session-level
      # measurement problem (profile too aggressive for the page). Surface it:
      session.unreliableCount = (session.unreliableCount || 0) + 1
      if consecutiveUnreliable(session) >= 3:
        session.status = "aborted"
        session.abortReason = "unreliable: page not lab-measurable under the chosen profile — switch profile, add --block, or rely on field data"
        write SUMMARY.md with the measurement-reliability callout
        exit "aborted-unreliable"

  session.updatedAt = now
  write session.json
```

**Concurrency.** When `maxWorkers > 1` and ≥2 candidates are pending, start
up to `maxWorkers` measure-and-verdict tasks in parallel. Each worker
operates on its own `experiments/{id}/` directory — no file collisions. The
**promote-to-cumulative step is serialized**: once a worker returns
VALIDATED, pause dispatch, update `cumulative.json` and
`effectiveBaselineFile`, then resume the remaining workers *against the new
effective baseline*. In-flight candidates whose patches no longer merge
cleanly with the updated cumulative are re-queued for merge-recheck.

### Step 5 — Additive winners
Each VALIDATED patch is merged into `cumulative.json`. The next candidate is
measured against `cumulative + next`, and the oracle's baseline becomes the
last VALIDATED result — not the original `baseline.json`. This tests
**marginal gain**, which is the right question for stacking patches.

`baseline.json` is preserved and only used for the final total-gain summary
in Step 7.

**Patch merge rules** (the orchestrator enforces these when combining
cumulative + candidate):

| Field                | Merge strategy                              | Conflict                                      |
|----------------------|---------------------------------------------|-----------------------------------------------|
| `block`              | union of pattern strings                    | (never conflicts)                             |
| `preloads`           | append; dedupe by `href`                    | same `href` with different `as` or `fetchpriority` → conflict |
| `requestHeaders`     | append rules; key by `urlPattern`           | same `urlPattern` with contradicting `set` → conflict |
| `responseHeaders`    | append rules; key by `urlPattern`           | same rule as requestHeaders                   |
| `markup`             | append; key by `selector`                   | same `selector` with contradicting `attrs`    |
| `rewriteBody`        | append rules; key by `urlPattern`           | same `urlPattern` with overlapping `find`     |

Conflicts mean the candidate is rejected with a specific reason recorded in
`session.json`. The user can resolve manually.

### Step 6 — Translate to source
For each promoted patch, invoke the `cwv-fix` source-mapping step with
`--source-repo <session.sourceRepoPath>` and the finding id when a local source
repo is available. `cwv-fix` / `source-mapper.js`:

1. maps the candidate's `recommendation` / `patch` to actual source files;
2. records the machine-readable `{ file, before, after, line? }` entries in the
   finding's `sourceEdits` field;
3. leaves branch refs, generated patch files, and cumulative/per-fix grouping
   to the terminal `local-artifacts.js` handoff.

If source translation fails (file not found, patch doesn't apply cleanly, or no
source repo is available), keep the lab-validated candidate in the local
artifact set and record the missing `sourceEdits` in the summary. The manifest's
`branchOutput.skipped[]` preserves validated findings that cannot become source
patch files yet. Do not silently drop the validated lab evidence.

### Step 7 — Termination & summary
Loop exits when:
- `pendingCandidateIds` is empty, OR
- All target metrics have reached `good` rating on the current
  `effectiveBaselineFile`, OR
- User-set `maxExperiments` ceiling hit, OR
- User aborts (the caller may send a signal; the skill writes
  `status: "aborted"` into `session.json` before exiting).

Emit `progress/{slug}/SUMMARY.md`:

```
# CWV Orchestration Summary — {url}

Started:  {startedAt}
Finished: {finishedAt}
Mode:     {degradedMode || "full (field + lab)"}
Stack:    {stack}

## Ownership verdict — platform, site code, or third party?

Tally the diagnose findings by `owner` and state the headline plainly:

| Owner            | Findings | Notes |
|------------------|----------|-------|
| customer-code    | {n}      | site templates / CSS / JS — fix in the site repo |
| customer-content | {n}      | authored assets / CMS config — content change |
| third-party      | {n}      | vendor scripts ({requires-tag-manager-rule} count flagged) |
| cdn-edge         | {n}      | caching/edge — {requires-operator} |
| platform-default | {n}      | hosting platform — operator-managed |

Headline (e.g. "**Site-implementation, not the platform** — the failing CWV
(CLS) is the site's own banner component; the platform serves fast"). This is
the literal question the engagement asks; lead the summary with it.

## Total gain (original baseline → final cumulative)

| Metric | Baseline median | Final median | Delta    | Delta % |
|--------|-----------------|--------------|----------|---------|
| LCP    | 4200ms          | 2150ms       | -2050ms  | -48.8%  |
| ...    |                 |              |          |         |

If Step 1b flagged the page CLS noise-dominated, add a one-line note here so the
CLS row isn't read as a trustworthy total: e.g. "**CLS: total is noise-dominated**
(baseline run-to-run range {noiseFloor} > 0.03); validated per-source on
`{recommendedClsSource}` instead — volatile sources: {volatileSources}." This is
why a CLS win is reported as `CLS@{source}` rather than a total-CLS delta.

## Promoted patches ({N})

1. validate-lcp-preload-hero — LCP -1450ms — patch file `source-patches/validate-lcp-preload-hero.diff`
2. validate-lcp-font-display  — LCP -600ms  — patch file `source-patches/validate-lcp-font-display.diff`

## Rejected candidates ({M})

- exp-002-defer-analytics — REGRESSION: CLS 0.04 → 0.12
- exp-003-block-martech   — BELOW_THRESHOLD: LCP -80ms (< 200ms floor)
- exp-005-inline-critical — INCONCLUSIVE: IQR overlap persists after 10 runs

## Silent no-ops ({K})

- exp-006-cls-set-attr    — CLS (treatment samples bit-identical to baseline; patch did not apply — investigate patch applier)

If K > 0, list experiments whose validate-finding has `status: "no_op"`.
A non-zero count signals the patch applier misclassified the action and must
be investigated before the next orchestration run. If K ≥ 3 consecutive
(`status: "aborted"` with `abortReason: "systemic-no-op"`), the run was
halted early — fix the applier first, then resume.

## Next steps

- Review `artifacts-manifest.json`, inspect each recorded source patch file,
  and apply the accepted patches to the source repo.
- Monitor CrUX p75 for 28 days post-deploy.
- Run `cwv-orchestrate` again in 2 weeks to pick up new opportunities.
```

Then assemble the local artifact manifest. This is the terminal handoff for the
default `local` profile. For URL-only sessions with no source checkout:

```
node .agents/scripts/local-artifacts.js \
  --progress progress/{slug} \
  --output progress/{slug}/artifacts-manifest.json
```

When `session.sourceRepoPath` is present, create local source branch refs and
record their generated patch files in the same manifest:

```
node .agents/scripts/local-artifacts.js \
  --progress progress/{slug} \
  --source-repo {session.sourceRepoPath} \
  --branch-mode per-fix \
  --create-branches \
  --output progress/{slug}/artifacts-manifest.json
```

## Output format

The skill emits four files (all under `progress/{slug}/`):

- `session.json` — terminal state (status, experiments list, promoted/rejected).
- `cumulative.json` — the final union of validated patches (equivalent to
  "the patch bundle that, if applied, reproduces all promoted fixes in lab").
- `SUMMARY.md` — human-readable report per Step 7.
- `artifacts-manifest.json` — local handoff manifest indexing baselines,
  Finding envelopes, patch bundles, treatment measurements, oracle verdicts,
  screenshots, validated source edits, generated source patch files, and
  optional source branch names. The manifest builder validates every
  `*-findings.json` before setting `localCompletion.status: "complete"`.

Additionally, per experiment under `progress/{slug}/experiments/{id}/`:
- `patch.json` — the exact bundle tested (cumulative + candidate).
- `result.json` — launcher output (5 runs, or 10 on INCONCLUSIVE retry).
- `verdict.json` — oracle output.

And, when source branch output is requested: one generated patch file per
promoted validated fix, plus optional local `perf/{slug}-{finding-id}` branch
refs as navigation anchors. The patch files are the source handoff; the branch
refs are not auto-committed fix branches.

## References to read
- `.agents/skills/cwv-diagnose.md` — produces `ranked_patches.json`.
- `.agents/skills/cwv-fix.md` — step 5 implements the translate-to-source
  step invoked here.
- `.agents/skills/cwv-validate.md` — shares the IQR comparison logic that
  `oracle.js` encodes in code.
- `.agents/references/topics/finding-schema.md` — Finding lifecycle and
  confidence caps; the orchestrator preserves lifecycle correctness across
  the chain diagnose → validated/rejected.
- `.agents/references/topics/field-vs-lab.md` — reminder that VALIDATED in
  lab is a leading indicator, not a guarantee of CrUX p75 movement.
- `progress/README.md` — exact directory layout and file schemas.

## Tools required
- `.agents/scripts/preflight.js` (`npm run preflight`) — the authoritative
  ADR-0014 Step-0 gate. `--profile <name>` runs `doctor.js`'s checks
  (read-only) and exits 0 ready / 1 not-ready / 2 usage; `--skip-preflight`
  is the explicit, output-visible bypass. Run before any directory/launcher
  work.
- `.agents/scripts/launcher.js` with `--output` (parallel workers require
  per-experiment output paths). Also accepts `--preflight-profile` /
  `--skip-preflight` as a defense-in-depth second layer of the same gate;
  never pass them on the repeated Step-4 racing-loop calls.
- `.agents/scripts/rank-candidates.js` — deterministic transform of
  `diagnose-findings.json` into `ranked_patches.json`. Pure function; safe
  to re-run.
- `.agents/scripts/oracle.js` — the numeric verdict. Exit code is the
  primary loop-control signal; don't parse the human stdout. Exit codes:
  `0` VALIDATED, `1` REGRESSION, `2` INCONCLUSIVE, `3` BELOW_THRESHOLD,
  `4` ERROR, `5` NO_OP (patch did not apply — investigate the patch
  applier, not the metric), `6` NOT_MEASURED (all target metrics had 0
  samples on both sides — drop the metric from `targetMetrics` or
  re-run with the missing prerequisite, e.g. `--interact` for INP).
- `node .agents/scripts/finding-schema.js <file>` — validate any Finding
  envelope before persisting.
- `git` in the source repo — optional local branch-ref creation and
  `git apply --check` review of generated patch files; commits are human-owned.

## Execution in Claude Code

The skill is invoked from a Claude Code session. A few runtime patterns
keep the main conversation coherent across a 30+ min loop:

- **Subagent per experiment (context protection).** Each 5-run
  `launcher.js` output is 500KB–1MB of JSON. Loading every experiment's
  raw result into the main context blows the window after 3–4
  experiments. Spawn a `general-purpose` subagent per experiment that
  runs `launcher → oracle → (on VALIDATED) cwv-fix translate` and
  returns only a short verdict summary (verdict, deltas, branch name if
  promoted, one-line reason if rejected). The main conversation holds
  `session.json`, `ranked_patches.json`, and the running verdict list
  only.

- **Background bash for parallel workers.** When `maxWorkers > 1`,
  launch each `launcher.js` invocation with `run_in_background: true`
  so both workers measure in parallel. The runtime notifies on
  completion — do not poll or sleep-loop.

- **`maxExperiments` ceiling for first runs.** The first orchestration
  run against a new URL should cap at 5 candidates. Inspect the
  resulting `SUMMARY.md`, decide whether the remaining candidates are
  still worth trying under the new effective baseline, then resume via
  the same session (orchestrator reads `pendingCandidateIds` from
  `session.json`).

- **Abort hatch on noise.** If 2+ consecutive experiments return
  INCONCLUSIVE even after the 10-run retry, stop and ask the user
  rather than burn the remaining time budget — the profile may be too
  noisy on this hardware, or the candidates may be genuinely sub-noise.

- **Auto mode required.** The loop makes many tool calls without
  meaningful per-call human value. Run in auto mode so workers are not
  gated on per-bash approval.

## Known limitations
- **Lab-only gate.** The oracle uses Puppeteer-measured metrics. Field
  improvement (CrUX p75) is confirmed only after deploy + 28-day observation.
  A VALIDATED verdict is a *necessary* but not *sufficient* condition for
  real-world improvement.
- **Additive ≠ optimal.** Greedy promotion in rank order may miss a
  combination where two mid-ranked patches together beat the top one. If
  you suspect this, re-run with a different `ranked_patches.json` ordering
  or author a combined candidate manually.
- **Single-URL scope.** The orchestrator optimizes one page at a time.
  Shared-infrastructure wins (cache headers, font preloads in the shared
  template) should be validated on 2+ representative URLs before promotion.
- **Concurrency ceiling is hardware-dependent.** `maxWorkers=4` on a
  16GB-RAM laptop will inflate IQRs and push the oracle toward
  INCONCLUSIVE. If INCONCLUSIVE rate > 30%, reduce to 2 or 1.
- **Merge-conflict rejections are conservative.** Two patches touching the
  same selector get rejected even if they could be hand-merged. Reauthor
  as a single combined candidate.
- **Translate step can fail silently if cwv-fix writes to the wrong
  file.** Always review the generated source patch files before applying them.
  Do not auto-merge or push branch refs.
