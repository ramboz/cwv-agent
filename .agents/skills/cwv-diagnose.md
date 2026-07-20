# Skill: cwv-diagnose

## Purpose
Perform a deep, evidence-based performance diagnosis for a single URL. Combine lab measurement (Puppeteer + web-vitals v4 attribution, injected via `evaluateOnNewDocument`) with reference cross-referencing (metric runbooks, topic guides, stack-specific patterns) to produce a ranked set of fix hypotheses in Chain-of-Thought format. Output ends with a suggested `patches.json` for the top hypothesis so the user can immediately proceed to `cwv-fix`.

## When to invoke
- After `cwv-triage` identifies a high-pressure URL.
- When a user points at a specific URL and asks "why is this slow?" or "why is LCP/CLS/INP bad here?".
- After a user's fix attempt underperformed and they need deeper root-cause analysis.
- When lab measurement is required (CrUX only tells you *what* is bad, not *why*).

Do not re-run this skill on the same URL if a diagnosis already exists in the session — iterate with `cwv-fix` instead.

## Prerequisites
- Provider profile: `local` diagnosis with in-repo launcher and analyzers. A
  future `diagnose-cwv-agent` provider is not wired today and must not be
  substituted for this skill.
- `npm ci` completed (Puppeteer + web-vitals + dotenv).
- Vendor file present: `.agents/scripts/vendor/web-vitals.attribution.iife.js` (created by `postinstall`).
- `.env` is not required for lab measurement. It is only needed if the operator
  explicitly selected a field profile and wants to cross-check CrUX or RUM.
- Writable `screenshots/` directory.
- Target URL is publicly reachable from the local environment.

## Workflow

### Step 0 — Doctor preflight (ADR-0014 / spec 014)
Before any lab measurement, run the same standalone doctor preflight gate the
5-step runbook enforces at every step. Resolve this skill's provider profile
(the one on the "Provider profile:" line above — `local` for a standard
diagnosis), then run:
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

### Step 1 — Confirm scope
Ask the user: which URL? Which target metric (LCP / CLS / INP / FCP / TTFB), or all failing metrics? If they came from `cwv-triage`, the URL + dominant metric are already known.

**Resolve the lab profile.** If `triage-findings.json` is present, read its
top-level `selectedTop` contract. Use `selectedTop.url` as the lab target and
`selectedTop.recommendedProfile` as `$PROFILE`; fall back to top-level
`recommendedProfile` only for older triage artifacts. Otherwise ask the user
which form factor to audit (default PHONE → `mobile-slow4g-4xcpu`). Store as
`$PROFILE` and use it in every `launcher.js` / analyzer invocation in this
skill. Never hardcode `mobile-slow4g-4xcpu` — it's the default, not the only
option.

> **Cold-load desktop CLS opt-in.** If a DESKTOP page reads CLS ≈ 0 on
> `desktop-cable-1xcpu` but field RUM p75 says CLS is failing, a warm edge cache
> is likely delivering images before first paint — a lab false-negative. Re-run
> with `--profile desktop-slow-1xcpu` (600/300 kbps + 500 ms + cold cache) to
> widen the paint→late-content gap and surface the shift. It's an explicit
> opt-in, never the DESKTOP default. (It renders at the real desktop viewport —
> 1350×940, slice 003-06 / ADR-0007 — so *width-dependent* desktop shifts surface
> too.)

**Cloudflare / anti-bot opt-in.** If the first lab run returns a 403 challenge
stub ("Just a moment…", `cdn-cgi/challenge-platform`, Turnstile) instead of the
real page, set `STEALTH="--stealth"` for the whole diagnosis. Pass it to
`launcher.js`, `coverage.js`, and `image-analysis.js`; all three own browser
sessions and must use the same headful real-Chrome recipe. Leave it empty by
default — stealth opens a real Chrome window and is only for authorized targets
that block default headless measurement.

### Step 2 — Run lab measurement
Invoke the harness:
```
node .agents/scripts/launcher.js --url <URL> \
  --profile $PROFILE --scroll $STEALTH \
  --screenshot screenshots/before.png
```
The launcher injects `measure-cwv.js` and `collect-resources.js` via `page.evaluateOnNewDocument(...)` before navigation — critical so CWV observers register before any page script runs.

**Cold cache by default (first-visit).** The launcher disables the HTTP cache for the default `first-visit` cohort, so the run measures the true cold-load cost **and** CDP `Fetch` patches actually intercept. Without this, immutable long-cache assets (e.g. AEM `.lc-<hash>` clientlibs) are served from Chrome's cache — which both **under-measures cold LCP** (warm clientlibs masked ~3 s on a real case) and **silently no-ops any `block`/`rewriteBody`/header patch** (cache hits never reach `Fetch.requestPaused`). The `returning` cohort keeps the cache warm on purpose (its throwaway warm-up load defines a repeat visitor).

**Field-faithful CLS (default).** `--scroll` is on by default (passed explicitly above for clarity): the launcher dismisses consent, scrolls to the bottom in viewport steps, and settles to layout/network quiescence so the post-load CLS that dominates the field — consent banners, scroll-lazy ads, late inserts — is captured. The reported `cwv.cls.value` is therefore the **field-faithful CLS of record**, and `cwv.cls.shiftSources[]` ranks the shifting elements (the input to CLS attribution / correlator C6); `cwv.cls.shiftSummary.windowedFromShifts` is an independent cross-check of `value`. A load-only run reads a false-negative CLS (e.g. the news-site case: 0.005 load-only vs 0.21 scrolled, banner-dominated). Add `--no-scroll` only for a fast load-only pass when CLS is out of scope (scroll adds ~20–30 s/run).

**INP measurement rule:** If the target metric is INP (or CrUX showed INP failing), add `--interact "<primary CTA selector>" --interact-delay 500`. Without `--interact`, the CWV snapshot returns `cwv.inp = { value: null, reason: 'not-observed' }`. Do NOT misread a null value as "INP is good" — it simply was not observed. Typical selectors: `button[type=submit]`, `a.cta`, `nav a:first-child`.

**Selector-scoped DOM snapshots.** When CLS attribution names an element but
static HTML is blocked or insufficient, add `--dom-snapshot-selector
"<selector-list>"` to the launcher command (repeatable). The run output gains
`runs[].domSnapshot` with rects, key attributes, computed layout styles, bounded
text, and bounded `outerHTML` for matching nodes in the same measured page
context. Use this for cases like `#FindCare,#select-your-insurance` where the
question is whether SSR/static state matches hydrated default state.

**EDS structure snapshot.** When the target fingerprints as AEM EDS, or when the
page shape itself is suspect (empty/spacer sections, overlay header, LCP content
several sections down), add `--eds-structure-snapshot` to the launcher command.
The run output gains `runs[].edsStructureSnapshot`: `body.appear`, first
top-level `main` sections, first meaningful section, header/main overlap, and
visible unloaded blocks in the same measured page context. This is rendered
evidence for the EDS structural gate; it complements, and can replace, static
HTML evidence on WAF-protected targets.

### Step 2b — Reproduce first, then run a negative control (anti-thrash)
**Before theorizing any mechanism, establish what the symptom actually *requires*.** A root cause inferred from correlation ("there's a dynamic thing near the top and CLS is bad") is the #1 source of diagnosis thrash — see the worked example at the end of this skill, where it cost two wrong hypotheses.

1. **Reproduce.** Confirm the failing metric reproduces in the lab run. If lab is GREEN where field (CrUX/RUM) is RED, the lab isn't faithful yet — vary the conditions below until it reproduces, or stop: you cannot diagnose what you cannot reproduce.
2. **Negative control — isolate the trigger.** Re-measure toggling **one condition at a time** to find which are *necessary* for the symptom. The launcher's knobs are your controls:
   - **scroll** (`--no-scroll` vs the default scrolled run): clean load-only but shifts when scrolled ⇒ post-load / scroll-lazy origin (consent, lazy ads, late inserts).
   - **consent / cohort** (`--consent none` vs `dismiss`; `--cohort returning` vs `first-visit`): clean on `returning` ⇒ the consent banner is the trigger.
   - **viewport / form factor** (`--profile desktop-cable-1xcpu` vs `mobile-slow4g-4xcpu`): is it form-factor-specific? (CLS *score* is viewport-relative — 003-06 / ADR-0007.)
   - **interaction** (`--interact`): INP only — does it need a specific interaction?
   For CLS, compare the **target shift-source's own contribution** across conditions, not the noisy page total — drive `.agents/scripts/cls-variance.js` (per-source) so a condition is judged by *its* shift, not the page's total CLS.
3. **Record the necessary conditions.** "CLS reproduces only when scrolled, with consent shown, on mobile" is a far stronger basis than "CLS is bad" — it has already ruled out whole classes of cause before any mechanism is theorized.

### Step 3 — Parse launcher output
From the JSON stdout, extract:
- `runs[0].cwv.lcp.{value, rating, attribution}`.
- `runs[0].cwv.cls.{value, rating, attribution}`.
- `runs[0].cwv.inp.{value, rating, attribution}` (or null reason).
- `runs[0].cwv.fcp` and `cwv.ttfb` for supporting context.
- `runs[0].resources.{renderBlocking, preLCP, postLCP, byType, byDomain}`.
- `runs[0].domSnapshot` when `--dom-snapshot-selector` was passed — selected
  nodes' rects and computed layout styles at the measured state.
- `runs[0].edsStructureSnapshot` when `--eds-structure-snapshot` was passed —
  rendered EDS page-shape evidence: reveal state, first sections, header overlap,
  first meaningful section depth, and visible unloaded blocks.
- `viewport` (top-level) / `runs[0].viewport` — the rendered viewport. On `desktop-cable-1xcpu` this is **1350×940** (Lighthouse's desktop preset; 003-06 / ADR-0007), not Puppeteer's 800×600 default. **Report it alongside any CLS number**: the CLS *score* is viewport-relative (distance fraction = shiftDistance / max(width, height)), so a desktop CLS is only interpretable paired with its viewport.

For the LCP element, look at `attribution.target` — **v4 renamed `element` to `target`**. The resource URL is `attribution.url`.

### Step 3a — Run analyzers
Fan out across analyzers. Each emits schema-conformant Findings that compose into the final diagnose envelope. Run ALL that apply:

- **Waterfall shift** (reads launcher output; no browser needed):
  ```
  node .agents/scripts/analyzers/waterfall-shift.js /path/to/launcher-output.json > waterfall-findings.json
  ```
  Emits: shift-left preload candidates, shift-right defer candidates, chain-depth bottlenecks, main-thread pre-LCP blocking JS, LCP priority mismatch.

- **Coverage** (spins its own Puppeteer session; pass the same `$PROFILE` as the launcher):
  ```
  node .agents/scripts/analyzers/coverage.js --url <URL> --profile $PROFILE $STEALTH --output coverage-findings.json
  ```
  Emits: unused JS/CSS waste findings and an aggregate critical-path waste summary.

- **HTML structural parse** (no browser, just `fetch`):
  ```
  node .agents/scripts/analyzers/html-parse.js --url <URL> --output html-findings.json
  ```
  Emits: blocking script in head, missing img dimensions, missing `fetchpriority`, missing viewport, inline-script bloat, preconnect-to-deferrable, etc.
  On EDS pages it also emits an `html/eds-structural-contract` finding when the
  reveal/page-shape gate fails: meaningful content buried behind placeholder or
  tab-shell sections, spacer/transparent abuse, source-visible reveal-rule
  contradictions, or header overlay hints. This finding carries
  `structuralGate.result` and must be kept in the merged diagnosis envelope.
  If the fetch is blocked (403/challenge), the analyzer still writes a
  zero-finding error envelope to `--output`; keep it as evidence that static
  parse was unavailable. If `launcher.js` reaches the real page, do **not**
  switch to a separate ad-hoc Puppeteer probe (it may get a different challenge
  state). Re-run the launcher that already has the correct profile/stealth
  settings with targeted DOM snapshots and, on EDS pages, the structure snapshot:
  ```
  node .agents/scripts/launcher.js --url <URL> --profile $PROFILE --scroll $STEALTH \
    --dom-snapshot-selector '#FindCare,#select-your-insurance,.tabs-wrapper' \
    --eds-structure-snapshot \
    --output launcher-with-dom.json
  ```
  Use `runs[].domSnapshot` for computed styles, rects, attributes, parent
  summary, and redacted trimmed `outerHTML` of suspect nodes. The comma-list
  form is a convenience for simple selectors; for complex selectors that contain
  commas (for example `:is()` lists), pass separate simple selectors instead.
  Use `runs[].edsStructureSnapshot` for pre-scroll/final EDS section state,
  body reveal state, header overlap, and visible unloaded blocks.

- **Image analysis** (spins its own Puppeteer session; same `$PROFILE`):
  ```
  node .agents/scripts/analyzers/image-analysis.js --url <URL> --profile $PROFILE $STEALTH --output image-findings.json
  ```
  Emits: oversized-for-display, wrong-format, missing-srcset, LCP image without `fetchpriority`, ATF `loading=lazy`, below-fold non-lazy.

Merge all analyzer envelopes + your CoT diagnosis into one `diagnose-findings.json`. When multiple analyzers corroborate the same issue (e.g., waterfall + coverage both flag a render-blocking vendor bundle), set `mergedSources` on the merged finding and bump `confidence` toward the strongest source's cap (see `finding-schema.md`). Validate with `node .agents/scripts/finding-schema.js diagnose-findings.json` before emitting.

### Step 4 — Always-read references
Read both regardless of which metric failed:
- `.agents/references/topics/evidence-and-confidence.md` — Chain-of-Thought format, confidence scale, filtering thresholds, severity taxonomy.
- `.agents/references/topics/request-chains.md` — chain classification heuristics (CRITICAL / DEFERRABLE / MIXED).

### Step 5 — Read metric-specific runbooks
Only read runbooks for metrics whose `rating !== 'good'`:
- **LCP failing** → `.agents/references/metrics/lcp.md`, `metrics/fcp.md`, `metrics/ttfb.md` (LCP is FCP + resource load; TTFB is FCP's floor).
- **INP failing** → `metrics/inp.md`, `metrics/tbt.md`, `topics/martech.md` (long tasks are usually 3rd-party tag work).
- **CLS failing** → `metrics/cls.md`.

Each runbook has an `## Attribution Phases (web-vitals v4)` section mapping attribution fields to root causes and a `## Patch Snippets` section with ready-to-use `patches.json` examples.

### Step 6 — Detect the stack
Inspect the initial HTML (`await page.content()` or via the resources snapshot). Fingerprints (see `topics/stack-detection.md` for the full weighted table):
- `data-block-name` attributes, `helix-` class prefix, `/blocks/` in script URLs → read `stacks/aem-eds.md` (AEM Edge Delivery Services). Pay special attention to `loadEager` / `loadLazy` / `loadDelayed` phases and Adobe Alloy/Target synchronous requirements.
- `cq:template` meta, `/etc.clientlibs/` in link hrefs → read `stacks/aem-cs.md` (AEM Cloud Service). Focus on Dispatcher cache HIT/MISS and clientlib bundling.
- `/etc/designs/`, `.min.<32hex>.js` clientlib hashes → read `stacks/aem-ams.md` (AEM Managed Services).
- `_next/` or `__NEXT_DATA__` → Next.js stack (future runbook).

Record the detected **flavor** (`eds` | `cs` | `ams` | `headless`) — it drives both playbook selection (Step 6b) and ownership attribution (Step 8b). If you fetched the source via `cwv-source-fetch`, the manifest's `deliveryType` (e.g. `aem_cs`) is authoritative; `attribution.js` normalizes it.

**EDS structural gate (ADR-0011).** If the flavor is `eds`, resolve the gate
before making selector-level root-cause claims:

1. Prefer the `html/eds-structural-contract` finding from `html-parse`.
2. If static fetch failed or the finding is inconclusive, re-run the launcher with
   `--eds-structure-snapshot` and inspect `runs[].edsStructureSnapshot`.
3. If the gate fails, frame the primary cause as an EDS reveal/page-shape
   contract failure. Selector-level CLS patches remain useful probes, but their
   confidence is capped and they must not be promoted as root-cause fixes unless
   they restore the structural contract and pass cross-metric guards.
4. If no safe patch can restore the contract locally, emit a guidance-ready
   finding instead of forcing a runtime shim.

### Step 6b — Consult the playbook for each failing metric
The mystique CWV playbooks (`.agents/references/playbooks/`) encode per-issue-type remediation knowledge that must drive detection, not just be referenced after. For each failing metric, list the applicable playbooks for the detected flavor:
```
node .agents/scripts/attribution.js --explain <CLS|LCP|INP|TTFB|...> --flavor <flavor>
```
This returns the candidate issue types in priority order, each flagged `applicable` (its `applicable_flavors` includes the flavor). **Read the top applicable playbook** and let its signals steer the diagnosis:
- **CLS → `layout-shift.md`** — it is a *router*: classify the shifting element (unsized image → `image-sizing.md`; dynamically inserted banner/ad/embed → `min-height`/`aspect-ratio` reservation; web-font swap → `font-fallback.md`). The "late-injected / consent / ad-slot" categories tell you *what to measure* (did you scroll? was consent triggered?) and *how to classify* the shift.
- **LCP → `lcp-image.md`** (+ `resource-preload`/`resource-hints`/`blocking-resource` as needed) — note its `on_flavors: [eds]` forbidden `<link rel=preload>` (EDS auto-emits the header).
- **INP → `interaction.md` / `js-execution.md`**; **TTFB → `ttfb.md` / `compression.md`** (both N/A on EDS — platform-managed).

A playbook that **excludes** the detected flavor is itself a signal: the issue is platform-managed / N/A on that stack (feeds Step 8b).

### Step 6c — Read the resolved playbook closure (routing tree)
`--explain` lists the *candidate* playbooks for a metric; before finalizing root
cause you must actually **read the resolved closure** — the root playbook plus
its typed `see_also` graph (router `routes_to` children, `prefer_instead`
redirects, `complements`, `orthogonal`) in one ordered, depth-capped, flavor-
filtered block. This is what makes the diagnosis route with the expert decision
tree (e.g. CLS → `layout-shift` → classify the shifting element → `image-sizing`
vs `font-fallback` vs a `min-height` reservation) instead of rediscovering it.

For the resolved issue_type + flavor (the Step 6b top applicable playbook and the
Step 6 flavor), assemble the closure's bodies and read them:
```bash
ISSUE=layout-shift   # the resolved root issue_type for the failing metric
FLAVOR=eds           # the detected flavor (Step 6)
node -e "import('./.agents/scripts/diagnose-playbook-context.js').then(m => process.stdout.write(m.buildDiagnosisPlaybookContext(process.env.ISSUE, process.env.FLAVOR)))"
```
`buildDiagnosisPlaybookContext(issueType, flavor, opts)` (ADR-0015 §3, diagnose
is noise-tolerant → follows ALL edge types) returns ONE string: the root body
first, then the closure order, each section headed by the playbook name + how it
was reached (edge types) + depth. It is depth-capped (`opts.depth`) and bounded
to a documented character budget (`opts.maxChars`, default 40000 — content
beyond the bound is omitted, not errored). An unknown issue_type yields an empty
string (no playbook → nothing to route with; degrade gracefully). Let the routing
tree in this closure drive the shifting-element classification and the
mechanism-confirmed root cause (Steps 8c/9) — the diagnosis rationale must
visibly reason over it, not just cite the top playbook.

### Step 7 — Identify dominant attribution phase
For each failing metric, determine which sub-phase dominates:
- **LCP:** compare `attribution.timeToFirstByte`, `resourceLoadDelay`, `resourceLoadDuration`, `elementRenderDelay`. Largest = dominant bottleneck.
- **CLS:** inspect `attribution.loadState` and `attribution.largestShiftTarget`. `loadState = dom-interactive` implies sync JS; `complete` implies async injection.
- **INP:** compare `attribution.inputDelay`, `processingDuration`, `presentationDelay`. Also inspect v4 LoAF breakdown: `longestScript`, `totalScriptDuration`, `totalStyleAndLayoutDuration`.

### Step 7a — When attribution is silent: box-metric diff
Sometimes a CLS shift is real and reproducible but `largestShiftTarget` blames a huge container (e.g. a page-spanning grid) whose before/after rects look unchanged — common for scroll-triggered shifts and sticky-header reflows, where the *visible* region is the whole viewport and the value is `movedPx / max(viewportW, viewportH)` (so a 130px move on a 1366px-wide viewport scores ~0.095). When intervening on the obvious culprit changes nothing, stop guessing and **diff every element's box metrics between two states** — `scrollY 0` vs `scrollY N`, or pre- vs post-injection — in one page context so element refs stay stable:
```js
const snap = () => [...document.querySelectorAll('*')].map((e) => {
  const cs = getComputedStyle(e);
  return { oh: e.offsetHeight, pt: cs.paddingTop, mt: cs.marginTop, pos: cs.position };
});
const before = snap(); window.scrollTo(0, 1000); /* settle */ const after = snap();
// report the elements whose offsetHeight / paddingTop / position changed
```
This pinpoints the exact element + property that moves (e.g. a header wrapper collapsing 132→0, or a container gaining `padding-top:130px`) when Lighthouse only names the symptom. Canonical case: `playbooks/layout-shift.md` → "Sticky header/nav that detaches on scroll".

For named elements, prefer the built-in launcher snapshot before writing an
ad-hoc probe:
```
node .agents/scripts/launcher.js --url <URL> \
  --profile $PROFILE --scroll $STEALTH \
  --dom-snapshot-selector '#FindCare,#select-your-insurance' \
  --output launcher-with-dom.json
```
This keeps the DOM evidence tied to the same profile, cohort, scroll behavior,
and anti-bot mode as the measurement.

### Step 8 — Classify request chains
For each chain of 3+ sequential fetches from the same origin (or initiator), classify per `topics/request-chains.md`:
- **CRITICAL** — must be preloaded or synchronous (first-party head scripts, A/B testing SDKs affecting above-fold, critical CSS, hero image).
- **DEFERRABLE** — must NOT be preloaded (analytics, consent, monitoring, chat widgets, social pixels). Anti-pattern to preconnect or preload these.
- **MIXED** — tag managers (GTM, Adobe Launch) — audit each tag.

### Step 8b — Attribute ownership (is it AEM or the customer?)
Tag every finding with an `owner` so the report answers the literal customer question. Run the attribution pass over the merged findings, passing the detected flavor:
```
node .agents/scripts/attribution.js diagnose-findings.json --flavor <flavor> \
  --output diagnose-findings.json
```
Each finding gains `owner` ∈ {`platform-default`, `dispatcher-cdn`, `customer-code`, `customer-content`, `third-party`} plus an `ownership` block (confidence, the playbook consulted, `deliveryConstraint`, rationale, signals). The classifier derives this from the playbook `applicable_flavors` (Step 6b) + the stack doc + the finding's evidence (third-party resource domains, cache headers, the shifting selector). See `topics/finding-schema.md` → "Platform-vs-customer attribution".

Key distinctions to sanity-check in the output:
- A **first-party selector** with no third-party resource in evidence is `customer-code` (or `customer-content` for authored images), **not** `third-party` — e.g. a site's own custom consent banner is the customer's implementation, even though it's a "cookie bar."
- `requires-operator` (Fastly/Dispatcher/CDN) and `requires-launch-rule` (Adobe Launch/DTM-injected) deliveryConstraints mean the fix is **not** a normal in-repo code change — call that out.

### Step 8c — Mechanism-confirmed gate (before any `rootCause: true`)
A finding may be emitted with **`rootCause: true`** (finding-schema: "fundamental driver", not "observable symptom") **only** when its mechanism is *confirmed by direct evidence* — not inferred from correlation:

- **Direct evidence = the actual DOM mutation / element rect / attribution** that produces the symptom, tied to the specific element and the code/insertion that caused it. For **CLS**: the named shifting node and its before/after rect (`cwv.cls.shiftSources[]`, `attribution.largestShiftTarget`) **and** the script/insert that moved it — plus the necessary conditions from Step 2b. For **LCP**: the dominant attribution sub-phase (Step 7) tied to the specific resource/element. "A banner exists and CLS is bad" is correlation, **not** confirmation.
- **Discriminating test when two hypotheses fit the same symptom.** If two causes both explain the observation, run a test that **separates** them before committing — typically a candidate `patches.json` (hand to `cwv-fix`/`cwv-validate`) that would fix *only* hypothesis A; if the target shift-source's contribution persists, A is refuted. A hypothesis you cannot discriminate stays `rootCause: false` (a ranked candidate/symptom), not a confirmed root cause.
- Until the mechanism is confirmed, emit the finding as a ranked **hypothesis** (`rootCause: false`, confidence capped below the confirmed tier) — do **not** hand a fix forward as if the cause were settled. The dominant finding's `Mechanism:` line (Step 9) must cite the direct evidence above, not a plausibility argument.
- **Playbook `required_validation` preconditions (ADR-0015 §3, 015-04).** Beyond the direct-evidence bar above, the finding's playbook chain declares the *specific* validations that must hold before the mechanism counts as confirmed — unioned along `routes_to` edges only (a `prefer_instead`/`complements`/`orthogonal` neighbour contributes none). Run the gate with the ids the diagnosis has actually confirmed (`satisfiedIds`):
  ```
  node -e "import('./.agents/scripts/mechanism-gate.js').then(async m => {
    const { ok, unmet } = m.checkMechanismPreconditions(issueType, flavor, satisfiedIds);
    if (!ok) { console.error('BLOCKED — unmet preconditions:', JSON.stringify(unmet, null, 2)); process.exit(1); }
  })"
  ```
  `checkMechanismPreconditions(issueType, flavor, satisfiedIds)` returns `{ ok, unmet }`. **Do NOT set `rootCause: true` while `ok` is false** — surface each `unmet` entry's `id` + originating `playbook` (a `known:false` entry is an *unknown* precondition, never silently satisfied) as the named, playbook-sourced reason the promotion is refused, and keep the finding at `rootCause: false` until every listed precondition is satisfied.

### Step 9 — Produce the diagnosis report
For each failing metric, emit one CoT-format finding:
```
Observation: [concrete numbers from cwv attribution and resources]
Diagnosis:   [the perf issue this causes]
Mechanism:   [why this causes it, technically — reference the attribution phase]
Solution:    [specific actionable fix with implementation path]
Owner:       customer-code | customer-content | third-party | dispatcher-cdn | platform-default  (from Step 8b)
Confidence:  0.85
Severity:    bottleneck | waste | opportunity
```
Rank findings by confidence. Suppress anything <0.5. Apply the filtering thresholds from `evidence-and-confidence.md` (e.g., only report LCP fixes projected to save ≥300ms when LCP >2.8s).

### Step 10 — Draft a `patches.json` for the top hypothesis
Emit a pre-nav patch bundle the user can feed into `launcher.js --patches`. Valid top-level keys: `requestHeaders`, `responseHeaders`, `markup`, `preloads`, `block`, `rewriteBody`.

Example (LCP image discovery issue):
```json
{
  "preloads": [
    { "href": "/images/hero.jpg", "as": "image", "fetchpriority": "high" }
  ],
  "markup": [
    { "selector": "img.hero", "attrs": { "fetchpriority": "high", "loading": "eager" } }
  ]
}
```

## Mechanism-before-fix: pitfalls & worked example
Concrete traps that caused diagnosis thrash; Step 2b (reproduce + negative control) and Step 8c (mechanism gate) exist to avoid them.

**Pitfalls**
- **A fix validated on one page does NOT auto-transfer to another page on the same site — re-measure each page's own lever.** Site-level levers (a shared clientlib CSS split, authoring-jQuery removal) may carry, but page-specific causes don't, and a prior page's *headline* lever can be a no-op here. (the law-firm case: deferring martech was the `/super-claim-check/` LCP win — **0 ms** on the homepage, whose LCP is gated by render-blocking head CSS instead; and the homepage's dominant issue, an Elfsight-driven CLS, was absent on the other page.) Phrase a fix "same as page X" only *after* measurement confirms it; anything new surfaced gets the full deep-dive.
- **A DCL-applied `markup` reservation can land *after* first paint and *add* a shift.** Reserving space by mutating the DOM on `DOMContentLoaded` (or later) can itself shift already-painted content, making CLS *worse*. For a CLS reservation fix, prefer a **parse-time `rewriteBody`** (the reservation is in the HTML before first paint) over a post-load `markup` mutation. (Patch vocabulary: `cwv-fix` / `cwv-validate`.)
- **Hydrated/default-state mismatches are a CLS root-cause class.** A common
  tab/accordion pattern renders one panel in the static layout, then hydration
  reveals a different default panel from `display:none` / zero height. The
  shifted selector in RUM/lab may be the *victim* (`#select-your-insurance`),
  while the causal source is the newly revealed panel (`#FindCare` growing
  from 0 to its final height). Treat the right fix as "make the static/SSR
  initial state match the hydrated default state and reserve the final panel
  geometry before first paint", not "patch the victim selector."
- **CLS *score* is viewport-relative; the shift *distance* is not.** Distance fraction = shiftDistance / max(viewportWidth, viewportHeight), so the same shift scores differently per viewport — 0.375 @800×600 vs 0.222 @1350×940. The desktop profile renders at **1350×940** (Lighthouse's preset; 003-06 / ADR-0007), no longer Puppeteer's 800×600 default. Always report a CLS *with* its viewport, and never compare CLS across viewports.
- **For CLS, use the field-faithful scroll path + per-source judgment.** Total CLS is noisy on content-variable pages; judge the *target shift-source's* own contribution via `cls-variance.js`, not the page total — otherwise a fix looks validated/refuted for the wrong reason.

**Worked example — parcelpro `/us/en/home.html` (the protocol catching two wrong hypotheses).** The desktop CLS (0.144) was first blamed on (1) an async **alert bar**, then (2) **personalized nav** — both inferred from "there's a dynamic thing near the top and CLS is bad" (correlation). A negative control (Step 2b) plus a discriminating candidate patch (Step 8c) refuted both: the real cause was a **sticky-on-scroll header** whose JS sets a late `padding-top` spacer — the shift only reproduced *on scroll*, and only a patch targeting the header's `padding-top`/`position` zeroed the target shift-source's contribution. Fix: header.css `fixed`→`sticky` + drop the header.js `paddingTop` toggle — **lab-validated: page-total CLS 0.144 → 0.025** (the header shift-source's *own* contribution, ~0.119, is the figure the per-source `cls-variance` judgment from Step 2b/8c actually gates on — not the page total). Two pivots' worth of thrash would have been avoided by confirming *which element actually moved, under which condition* before proposing a fix.

## Output format

Emit BOTH a human-readable report and a structured Findings envelope.

### Human report
- Markdown diagnosis report with one CoT block per failing metric.
- Ranked hypotheses table (hypothesis, confidence, severity, which metric it improves).
- Explicit call-out of dominant attribution phase per metric.
- Chain classification list (CRITICAL / DEFERRABLE / MIXED) for the chains identified.
- A `patches.json` code block for the top hypothesis, ready to paste into `patches.json`.
- The `screenshots/before.png` path for visual context.
- Stack fingerprint finding (which stack was detected, if any).
- **Ownership summary** — the "is it AEM or the customer?" verdict: a one-line tally of findings by `owner` (e.g. "3 customer-code, 1 third-party, 0 platform"), and an explicit call-out of any finding with a `requires-operator` / `requires-launch-rule` deliveryConstraint.
- A suggested next step (`cwv-fix` invocation with the generated `patches.json`).

### Structured findings (REQUIRED)
Emit `diagnose-findings.json` conforming to [finding-schema.md](../references/topics/finding-schema.md). One Finding per hypothesis. All findings from this skill have:
- `skill: "cwv-diagnose"`
- `source`: `har` | `perf_observer` | `coverage` | `psi` | `html` | `rules` (whichever dominated the evidence)
- `status: "proposed"` — ready for `cwv-fix` to try; `"rejected"` for hypotheses that failed the CoT filter or impact threshold
- `patches` field populated with a `patches.json` fragment the harness can apply
- `confidence` capped at source tier (see finding-schema.md)
- `id` format: `diagnose-<metric-lowercase>-<n>` (e.g. `diagnose-lcp-1`)
- `evidence[]` MUST include at least one of: `cwv-attribution`, `resource-timing`, `har-entry`, `coverage-row`, `rule-violation`
- `relatedFindingIds` SHOULD reference the upstream `triage-*` id if chained from triage
- `impactReduction` estimated per the metric-specific runbook guidance
- `owner` + `ownership` populated by the Step 8b attribution pass (the platform-vs-customer tag)

Suppress findings with `confidence < 0.5` or `impactReduction` below MIN_ACTIONABLE_IMPACT (see finding-schema.md) — emit them with `status: "rejected"` rather than dropping silently, so the causal record is preserved.

Validate before writing:
```bash
node .agents/scripts/finding-schema.js diagnose-findings.json
```

Downstream: `cwv-fix` reads this file and picks the top `proposed` finding to apply.

### SpaceCat draft + AEM review report (REQUIRED after `diagnose-findings.json`)
After `diagnose-findings.json` validates, derive the non-mutating publish draft
and the human review report:

```bash
node .agents/scripts/diagnose-draft.js diagnose-findings.json \
  --output diagnose-spacecat-draft.json \
  --report diagnose-report.md
```

`diagnose-spacecat-draft.json` is a **draft only**. It carries the selected URL,
metric, `aggregationKey`, draft `CODE_CHANGE` issue breakdown, evidence,
ownership, confidence limits, and `dedupIdentity`, but it must keep
`publishState: "draft"`, `mutatesBackend: false`, and `dedupPlan: null`.
Do not claim that any existing SpaceCat suggestion is already `OUTDATED`; the
publish read probe and confirm-before-write gate own that state transition.

`diagnose-report.md` is the AEM expert review surface. It summarizes selected
URL, failing metrics, root cause, evidence, ownership, risks, and the recommended
next remediation path without requiring the reviewer to inspect raw JSON.

## References to read
- Always: `topics/finding-schema.md`, `topics/evidence-and-confidence.md`, `topics/request-chains.md`.
- Analyzer references (read the one matching your dominant analyzer): `topics/waterfall-shift.md`, `topics/coverage.md`, `topics/html-structure.md`, `topics/image-optimization.md`.
- Metric-specific: `metrics/lcp.md`, `metrics/cls.md`, `metrics/inp.md`, `metrics/fcp.md`, `metrics/ttfb.md`, `metrics/tbt.md` (read only for metrics whose rating is not `good`).
- Topics: `topics/martech.md` (INP fails), `topics/field-vs-lab.md` (when reconciling with CrUX), `topics/performance-audit.md` (general audit checklist), `topics/stack-detection.md` (Step 6 fingerprints).
- Stacks: `stacks/aem-eds.md`, `stacks/aem-cs.md`, `stacks/aem-ams.md` (based on fingerprints).
- Playbooks: `.agents/references/playbooks/<issue-type>.md` — the remediation playbook for the failing metric (Step 6b), loaded via `attribution.js --explain`. Read the top applicable one before classifying.

## Tools required
- `.agents/scripts/launcher.js` — Puppeteer harness with `evaluateOnNewDocument` injection of web-vitals IIFE + `measure-cwv.js` + `collect-resources.js`.
- `.agents/scripts/attribution.js` — playbook-guided diagnosis (`--explain`) + ownership attribution (Steps 6b, 8b).
- `.agents/scripts/diagnose-playbook-context.js` — `buildDiagnosisPlaybookContext(issueType, flavor)` assembles the resolved playbook closure (routing tree) into one ordered, depth-capped, budget-bounded context string (Step 6c).
- Filesystem read for runbooks, stack docs, and playbooks.
- JSON parsing of launcher output.
- Screenshot file output.

## Known limitations
- Lab measurement (single run) has ~15–30% variance; the diagnosis identifies patterns but does not prove improvement. Use `cwv-validate` for statistical proof.
- `page.setRequestInterception` is deliberately NOT used by `launcher.js`; all network control uses raw CDP `Fetch.enable` with request + response stages. This means any local debugging using `setRequestInterception` alongside would conflict.
- INP in lab is a synthetic proxy via `--interact`; real-user INP depends on diverse interactions.
- Attribution fields use v4 names: `target` (not `element`), `resourceLoadDuration` (not `resourceLoadTime`), `waitingDuration` (not `waitingTime`). Do not assume v3 names.
- Stack detection is fingerprint-based; obfuscated or custom builds may not match. Fall back to manual inspection.
