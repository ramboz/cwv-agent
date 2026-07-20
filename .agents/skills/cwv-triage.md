# Skill: cwv-triage

## Purpose
Identify which pages on a domain need Core Web Vitals (CWV) work and prioritize them by urgency. Produce a ranked table of URLs so downstream skills (`cwv-diagnose`, `cwv-fix`, `cwv-validate`, `cwv-publish`) can focus on the highest-leverage targets first. This skill is the entry point of the 5-step CWV workflow (triage → diagnose → fix → validate → publish) — it never measures in lab; it reads real-user field data from the Chrome UX Report (CrUX) and falls back to PageSpeed Insights (PSI) when field data is unavailable.

## When to invoke
- A user asks "which pages on my site need performance work?"
- A user names a domain but doesn't know which specific URL to fix.
- After a deployment, to confirm no page regressed on CWV metrics.
- Before a quarterly performance review where you need to pick priorities.
- Any time the workflow starts with a domain (not a specific URL).

If the user has already picked a URL and wants lab diagnosis, skip this skill and go straight to `cwv-diagnose`.

## Prerequisites
- Provider profile: `field-google` for CrUX/PageSpeed Insights, and/or
  `field-aem-rum` for AEM RUM Bundler. `cwv-triage` is optional; the default
  `local` workflow starts at diagnosis for a chosen URL when no field profile is
  selected.
- `field-google`: `GOOGLE_CRUX_API_KEY` set in `.env`; optional
  `GOOGLE_PAGESPEED_INSIGHTS_API_KEY` for PSI fallback when CrUX lacks data.
- `field-aem-rum`: `RUM_DOMAIN_KEY` set in `.env` for any AEM site (EDS/CS/AMS)
  with a provisioned domain key; see `topics/rum.md`.
- Node.js >=20 for running one-off `fetch` scripts (no browser needed).
- Optional: a sitemap URL (`sitemap.xml`) if the user wants a multi-URL scan.

No Puppeteer/browser required for triage — this is pure API fetching.
Environment variables are only provider prerequisites. They do not activate
field triage inside the `local` profile by themselves.

## Workflow

### Step 0 — Doctor preflight (ADR-0014 / spec 014)
Before any field-API fetch, run the same standalone doctor preflight gate the
5-step runbook enforces at every step. Resolve this skill's provider profile
(the "Provider profile:" line above — `field-google` for CrUX/PSI,
`field-aem-rum` for RUM), then run:
```
node .agents/scripts/preflight.js --profile field-google
# or: npm run preflight -- --profile field-aem-rum
```
Exit codes: `0` = ready (or advisory-only), `1` = a required prerequisite is
**verifiably missing** (doctor `fail`/`not-wired`, e.g. `GOOGLE_CRUX_API_KEY`
or `RUM_DOMAIN_KEY` unset), `2` = usage error. On exit 1, surface the command's
own doctor rows verbatim and **stop** before any field fetch — do not re-derive
the message. Prerequisites doctor **cannot self-verify** (status `unknown`) are
printed as non-blocking advisories (`⚠ preflight: could not verify …`) and the
run **proceeds** — the gate never refuses on an `unknown` alone. The identical
`--skip-preflight` escape hatch bypasses the gate (visible in output). This is
a read-only `doctor.js` call — it never runs `setup.js`. Triage is step 1 of
the manual runbook; run this preflight when invoking triage standalone.

### Step 1 — Gather input
Ask the user for:
- The domain (origin) — e.g. `https://www.example.com`.
- Optional: specific URLs of interest.
- Optional: sitemap URL.
- Optional: target form factor. Default is **auto-detect** — query both `PHONE`
  and `DESKTOP`, compute pressure on each, and recommend whichever is worse.
  The user can override with an explicit `PHONE` | `DESKTOP` | `TABLET` to
  constrain the audit to one surface.

### Step 2a — RUM first (any AEM site with a domain key)
If the `field-aem-rum` profile is selected and `RUM_DOMAIN_KEY` is set, run:
```
node .agents/scripts/rum-fetch.js --domain <domain> --output /tmp/rum.json
```
RUM beats CrUX on this workflow because it is 7-day (vs 28-day) and exposes
per-URL breakdowns directly, so you can skip the sitemap parse + per-URL
CrUX loop entirely.

`rum-fetch.js` always emits a `byFormFactor` block (PHONE / DESKTOP / TABLET
p75s computed from the same bundles) so you can see which surface is worse
without a second fetch. If the user explicitly scoped to one form factor,
add `--form-factor PHONE|DESKTOP|TABLET` — the top-level `siteWide` and
`byUrl` then reflect only that slice while `byFormFactor` still covers all
three for comparison. Bot traffic is always excluded.

If `rum-fetch.js` exits 0 with non-empty `byUrl`, keep BOTH RUM rankings:
`byUrl` is the raw URL list, while `byCanonicalUrl` folds protocol/trailing-slash
variants (e.g. `http://example.com/savings` + `https://example.com/savings`)
and adds `sampleConfidence`. Use `byCanonicalUrl` for target selection and keep
`byUrl` as supporting evidence. If it exits 3 (no data), `RUM_DOMAIN_KEY` is not
set, or the `field-aem-rum` profile was not selected, continue with CrUX only
when `field-google` is selected. Exit 3 means the key is wrong / scoped to a
different host (apex vs `www`) or the site is genuinely non-AEM — it does
**not** mean "CS/AMS, so no RUM" (all AEM delivery types emit RUM). See
`topics/rum.md` for detection heuristics.

### Step 2 — Query CrUX at origin level
Skip this step unless the `field-google` profile is selected.

Issue a POST to `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=$GOOGLE_CRUX_API_KEY` with body:
```json
{ "origin": "https://www.example.com", "formFactor": "PHONE" }
```

**Run this query TWICE** — once with `"formFactor": "PHONE"` and once with
`"formFactor": "DESKTOP"` — unless the user explicitly scoped to one. Keep
both result blocks; Step 6a picks the dominant form factor from them.
`TABLET` is a valid CrUX formFactor but low-traffic; only query it when
the user explicitly asked. Omitting `formFactor` entirely returns the
combined (all-device) record — don't use that for triage because a good
desktop can mask a bad mobile.

Extract `record.metrics.largest_contentful_paint.percentiles.p75`, `cumulative_layout_shift.percentiles.p75`, `interaction_to_next_paint.percentiles.p75`. This gives a site-wide baseline.

### Step 3 — Query CrUX at URL level
For each specific URL provided, POST again but with `url` instead of `origin`, and again split by form factor:
```json
{ "url": "https://www.example.com/landing", "formFactor": "PHONE" }
```
Same rule as Step 2 — query both PHONE and DESKTOP unless the user scoped.
URL-level CrUX requires ~1000 real-user visits per form factor in 28 days.
If the API returns `404` / `"not found"`, note that URL+form-factor pair has
insufficient traffic; do not treat absence as "good."

### Step 4 — Fall back to PSI when CrUX has no data
(Fallback order at this point: RUM → CrUX → PSI. Step 4 is the last-resort
single-URL lab proxy for pages CrUX has no data for.)

For URLs with no CrUX data, issue:
```
GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=<URL>&key=$GOOGLE_PAGESPEED_INSIGHTS_API_KEY&strategy=mobile
```
Use the `lighthouseResult.audits['largest-contentful-paint'].numericValue` etc. as a lab proxy. Flag these rows as "lab-only" in the output table — they are NOT field data and must be interpreted with lower confidence.

**Form factor in PSI**: PSI's `strategy` flag takes `mobile` or `desktop`.
Run the same strategy the user scoped to (or both if auto-detect). The
strategy-to-profile mapping is identical to the CrUX-to-profile mapping:
`mobile` ↔ `mobile-slow4g-4xcpu`, `desktop` ↔ `desktop-cable-1xcpu`.

### Step 5 — Parse sitemap (if provided)
Fetch the sitemap URL, extract `<loc>` entries. Batch URLs in groups of 5 (to respect API rate limits and keep latency manageable). Query CrUX URL-level for each; fall back to PSI for misses.

### Step 6 — Compute threshold pressure
For every row, compute:
```
pressure = max(lcp_p75 / 2500, cls_p75 / 0.1, inp_p75 / 200)
```
Higher = more urgent. Values >1.0 mean the metric exceeds the "Good" threshold; >1.6 means "Poor". Note that thresholds come from the web.dev CWV definitions; `topics/field-vs-lab.md` has the full formula rationale.

The CWV thresholds (2500/0.1/200) are **user-experience thresholds, not
device-specific** — web.dev uses the same numbers for both form factors.
A desktop URL hitting LCP=3200ms is just as urgent to users as a mobile
URL at the same number. Pressure is therefore comparable across form
factors on the same axis.

### Step 6a — Pick the dominant form factor
Compute pressure **per form factor** on every row. For the overall triage
recommendation, pick the form factor whose origin-level max-pressure is
higher. Tie-break by bundle count (RUM) or URL-level sample count (CrUX) —
more samples = more confidence in the signal.

Record the choice as `recommendedFormFactor` on the output envelope. The
matching lab profile (`recommendedProfile`) is derived mechanically via
`profiles.js` `mapFormFactorToProfile()`:
- `PHONE`   → `mobile-slow4g-4xcpu`
- `DESKTOP` → `desktop-cable-1xcpu`
- `TABLET`  → `mobile-slow4g-4xcpu` (no dedicated tablet profile; mobile is the
  conservative default for tablet CSS)

If pressures are close on both form factors (within 10%), emit BOTH form
factors' recommendations with a note "both surfaces need work" — downstream
skills will have to pick one or run twice.

### Step 6a.5 — Sample-gated top URL selection
Raw field rankings are evidence, not an automatic instruction. Before naming
the "top URL to analyze", apply these gates:

0. Select `rawTop` / `selectedTop` from the `recommendedFormFactor` surface,
   so the target URL and `recommendedProfile` describe the same field
   population. In auto mode, aggregate `byUrl` remains supporting evidence;
   the durable handoff is the form-factor-scoped `selectedTop`.
1. Preserve `rawTop` exactly as the highest-pressure / highest-score raw row
   within that recommended surface.
2. Collapse obvious URL variants via `byCanonicalUrl` when RUM is the source
   (`http` vs `https`, trailing slash, fragments). Use the highest-traffic
   variant as the navigable URL, but carry all variants in the evidence.
3. Prefer `sampleConfidence: "load-bearing"` rows (`bundleCount >= 100`) for
   the primary `selectedTop`. Rows below 100 bundles are **directional**: keep
   them in the table and in `nearMisses`, but do not let a 1-bundle outlier beat
   a slightly lower-pressure page with enough traffic.
4. If every failing row is directional, pick the highest-pressure directional
   row but label the selection `sampleConfidence: "directional"` and recommend
   widening `--days` before spending fix/validate compute.

The output should explicitly show any disagreement:
```json
{
  "rawTop": {
    "url": "http://example.com/savings",
    "bundleCount": 1,
    "sampleConfidence": "directional",
    "pressure": 9.6
  },
  "selectedTop": {
    "url": "https://example.com/savings",
    "canonicalUrl": "https://example.com/savings",
    "bundleCount": 192,
    "sampleConfidence": "load-bearing",
    "pressure": 8.0,
    "selectionReason": "highest-pressure canonical URL with bundleCount >= 100"
  }
}
```

### Step 6b — Field-already-passing early exit
After pressure is computed on every queried form factor, decide whether the
page has **zero headroom below the GOOD threshold** — in which case running
the expensive diagnose/analyze/orchestrate loop is pure compute waste (a
VALIDATED lab delta on a field-green URL cannot move field metrics below an
already-green floor).

Rule:
- For **every** queried form factor (PHONE / DESKTOP — and TABLET if the user
  scoped to it), AND for **every** target metric (LCP, CLS, INP), check
  `metric_p75 / GOOD_threshold < 1.0` — i.e. the per-metric pressure is
  strictly under 1.0. GOOD thresholds: LCP ≤ 2500ms, CLS ≤ 0.1, INP ≤ 200ms.
- If the dominant signal is **RUM** and RUM is GOOD, but CrUX is available
  and shows NI/Poor on the same surface, be conservative and **do NOT
  early-exit** — CrUX's 28-day window is authoritative and RUM's shorter
  window may be masking a regression's ramp. Prefer RUM when it disagrees
  downward (RUM worse than CrUX) but not upward.
- If the only available field signal is **CrUX** and CrUX is GOOD, early-exit.
- If the only available signal is **PSI lab** (CrUX missing due to low URL
  traffic), **do NOT early-exit** — PSI is a single-location lab run, not
  field ground truth. Emit the normal envelope and let downstream proceed.
- If INP p75 is missing entirely (common — requires interaction events
  in the 28-day window), treat it as "not measured" rather than GOOD: the
  absence of INP samples is not evidence of goodness. Require at least LCP
  and CLS to be GOOD *and* INP to be either GOOD or explicitly absent with
  a note in the envelope.

When the rule fires, set envelope top-level `status: "passing"`. Keep
`recommendedFormFactor` and `recommendedProfile` populated (for audit + the
`--force` downstream case). `findings` may be empty, OR carry one
`status: "rejected"`, `reason: "field-already-good"` entry per metric per
surface for traceability (this is the recommended shape — it preserves the
evidence trail without implying actionable work).

When the rule does NOT fire, proceed as before (no `status` on the envelope,
or `status: "needs-action"` if you want an explicit positive marker — the
absence of `"passing"` is what downstream checks).

### Step 7 — Rank and output
Produce a markdown table sorted by pressure descending. Include a form
factor column so the reader sees which surface each row came from:

| URL | Form | LCP p75 | CLS p75 | INP p75 | Worst metric | Pressure | Recommendation |
|-----|------|---------|---------|---------|--------------|----------|----------------|
| /slow-page | PHONE | 4200 | 0.08 | 180 | LCP | 1.68 | diagnose now |
| /slow-page | DESKTOP | 2100 | 0.05 | 120 | — | 0.84 | monitor |
| /checkout | PHONE | 2800 | 0.15 | 240 | INP | 1.50 | diagnose |

Above the table, call out the `recommendedFormFactor` + `recommendedProfile`
explicitly (e.g. "Primary target: PHONE — run downstream skills with
`--profile mobile-slow4g-4xcpu`").
Add a short **Selected for analysis** section before the table. It must name
`selectedTop.url`, its dominant failing metric, bundle/sample count, pressure,
and `selectionReason`; then list the top `nearMisses` so an operator can see why
the selected URL beat raw outliers.

### Step 8 — Recommend next step
**If envelope `status: "passing"`** (Step 6b fired): the recommendation is
"no action — field is already passing on <metrics> on <form factors>". Do NOT
suggest `cwv-diagnose` / `cwv-analyze` / `cwv-orchestrate` — those skills
will refuse to run on a passing envelope (see their Preflight steps). If the
user wants to investigate a field/lab gap (e.g. CrUX is green but a specific
interaction feels slow), they must pass `--force` to the downstream skill,
which echoes the override into the downstream envelope for audit.

**Otherwise**: Recommend running `cwv-diagnose` on the highest-pressure URL
**using the recommended profile**. Example:
```
node .agents/scripts/launcher.js --url https://www.example.com/slow-page \
  --profile <recommendedProfile> --scroll --screenshot screenshots/before.png
```
Substitute the concrete profile name in the final output (don't leave the
`<recommendedProfile>` placeholder). If the top URL has an INP pressure >1.0,
advise including `--interact "<primary CTA selector>"` when diagnosing —
otherwise `cwv.inp` will come back as `{value: null, reason: 'not-observed'}`.

**Critical**: whatever profile triage recommends is the profile the entire
downstream chain (`cwv-analyze`, `cwv-diagnose`, `cwv-fix`, `cwv-validate`)
MUST use — baseline and treatment runs have to match the field's form
factor for the lab delta to predict field impact, and validate runs have
to match the fix run for the IQR comparison to be meaningful.

## Output format

Emit BOTH a human-readable summary and a structured Findings envelope.

### Human summary
- A ranked markdown table (URL × form factor × metrics × pressure × recommendation).
- A short written summary naming the top 3 URLs and their dominant failing metric.
- The raw top row and the selected top row when sample gating or canonical URL
  grouping changes the recommendation.
- The `recommendedFormFactor` and `recommendedProfile` stated explicitly at the top.
- A suggested `cwv-diagnose` command for the #1 URL using `recommendedProfile`.
- A flag list for any rows sourced from PSI (lab) vs CrUX (field) so confidence is explicit.

### Structured findings (REQUIRED)
Emit one Finding per failing metric per URL into a `triage-findings.json` envelope conforming to [finding-schema.md](../references/topics/finding-schema.md). All findings from this skill have:
- `skill: "cwv-triage"`
- `source`: `crux` | `rum` | `psi` (whichever was used)
- `status: "draft"` — pick-ready candidates, no patches yet
- no `patches` field
- `confidence` capped at source tier (field 0.95, lab 0.85)
- `id` format: `triage-<metric-lowercase>-<n>` (e.g. `triage-lcp-1`)
- `evidence[]` containing a `crux-percentile` or `rum-bundle` or `psi-audit` entry
- `evidence[0].data.formFactor` — `"PHONE"` | `"DESKTOP"` | `"TABLET"` — always recorded
  so downstream skills can filter/group by surface

The envelope also carries two top-level fields that downstream skills key off:
```json
{
  "schemaVersion": "1.0",
  "skill": "cwv-triage",
  "url": "...",
  "timestamp": "...",
  "rawTop": { "...": "..." },
  "selectedTop": { "...": "..." },
  "nearMisses": [ { "...": "..." } ],
  "recommendedFormFactor": "PHONE",
  "recommendedProfile": "mobile-slow4g-4xcpu",
  "findings": [ ... ]
}
```
`selectedTop` is the durable triage-to-diagnosis phase contract. It includes at
least `url`, `canonicalUrl` when known, `source`, `rank`, `bundleCount` or
`sampleCount`, `traffic`, `sampleConfidence`, `failingMetrics`, `pressure`,
`recommendedFormFactor`, `recommendedProfile`, and a machine-readable
`selectionReason`. `rawTop` preserves the highest-pressure raw row even when a
directional low-sample URL is not selected. `nearMisses` preserves the next
ranked URLs or rejected outliers needed to audit the choice.

`cwv-analyze` / `cwv-diagnose` / `cwv-fix` / `cwv-validate` each read
`selectedTop.url` as the lab target when this envelope is supplied; they read
`selectedTop.recommendedProfile` (falling back to top-level
`recommendedProfile`) and pass it as `--profile` to `launcher.js` and the
analyzers. If the user overrode the form factor on the CLI, the override wins —
but it must be echoed back into the envelope so the audit trail shows which
surface the downstream measurements target.

When the field-already-passing rule (Step 6b) fires, add the top-level
`status: "passing"` plus a structured `passing` block describing which
form-factor × metric pairs were all-GOOD — downstream skills read these for
the refusal message:
```json
{
  "schemaVersion": "1.0",
  "skill": "cwv-triage",
  "url": "https://pets.example.com/",
  "timestamp": "2026-04-17T12:00:00.000Z",
  "status": "passing",
  "recommendedFormFactor": "PHONE",
  "recommendedProfile": "mobile-slow4g-4xcpu",
  "passing": {
    "reason": "field-already-good",
    "checked": ["LCP", "CLS", "INP"],
    "byFormFactor": {
      "PHONE":   { "LCP": 1393, "CLS": 0.02, "INP": 106, "source": "crux", "maxPressure": 0.557 },
      "DESKTOP": { "LCP": 1120, "CLS": 0.01, "INP": 88,  "source": "crux", "maxPressure": 0.448 }
    },
    "thresholds": { "LCP": 2500, "CLS": 0.1, "INP": 200 }
  },
  "findings": []
}
```
The absence of `status: "passing"` (or `status: "needs-action"`) means
"proceed normally". `status: "passing"` is the **only** terminal envelope
status emitted by triage today — it blocks the downstream chain.

Validate before writing:
```bash
node .agents/scripts/finding-schema.js triage-findings.json
```

Downstream: `cwv-diagnose` reads this file and picks findings to deepen.

## References to read
- `.agents/references/topics/finding-schema.md` — output contract for findings.
- `.agents/references/topics/rum.md` — Helix RUM Bundler API, detection heuristics, `rum-fetch.js` usage, interpretation guide.
- `.agents/references/topics/field-vs-lab.md` — threshold pressure formula, CrUX vs PSI signal hierarchy, 28-day data window caveats.
- CWV thresholds (web.dev): Good/NI/Poor boundaries for LCP (2500/4000), CLS (0.1/0.25), INP (200/500).

## Tools required
- `fetch` (Node.js built-in) or `curl` for HTTP calls.
- `dotenv` for loading API keys from `.env`.
- Filesystem read for sitemap parsing.
- Output: stdout markdown table.

Never use `launcher.js` in this skill — triage is an API-only pass, no browser.

## Known limitations
- CrUX only reports URL-level data for pages with ≥1000 real-user visits in the past 28 days. Low-traffic pages always fall back to PSI (lab-only, lower confidence).
- CrUX data is 28-day aggregate — cannot detect a regression that landed yesterday. For recent regressions, cross-reference RUM (if available) with `cwv-diagnose` lab results.
- PSI runs from a single Google-owned location; it cannot replicate real-user device/network diversity. Treat PSI numbers as directional, not ground truth.
- Pressure thresholds (2500/0.1/200) are the same on PHONE and DESKTOP — they
  are user-experience thresholds, not device-specific — so pressure numbers are
  directly comparable across form factors. What differs is achievability: 2500ms
  LCP is common on slow-4G mobile and anomalous on cable desktop, so a DESKTOP
  pressure >1.0 usually signals a more severe underlying issue than a PHONE
  pressure at the same level.
- TABLET form factor in CrUX is low-traffic and frequently returns 404. Only
  query it when the user explicitly scopes to tablet; otherwise stick with
  PHONE+DESKTOP.
- RUM userAgent classification is coarse: Helix splits into `mobile` / `desktop`
  / `tablet` / `bot` prefixes only. Bots are always dropped; TABLET is treated
  as a permissive superset of PHONE (matches CrUX's mobile-CSS-on-tablet
  fallback) when filtering.
- Rate limits: CrUX allows ~150 QPM; PSI ~240 QPM. For very large sitemaps (>500 URLs), chunk the work and cache responses locally. Querying two form factors doubles the call count — budget accordingly.
