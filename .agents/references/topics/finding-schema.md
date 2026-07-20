# Finding Schema

Every measurement skill in this workbench (`cwv-triage`, `cwv-analyze`,
`cwv-diagnose`, `cwv-fix`, `cwv-validate`) emits and consumes **Findings**. A
Finding is a single structured observation about a performance issue on a URL,
carrying enough evidence and scoring to be acted on, filtered, or chained with
other findings.

This schema is the output contract that lets skills compose:

```
triage (draft)  →  diagnose (proposed + patches)  →  fix (applied + measured)  →  validate (validated | rejected | regression | no_op)
```

All skills MUST emit findings that conform to this schema. All skills MUST accept findings in this schema as input when chaining.

---

## Envelope Phase Handoffs

Every artifact envelope has the normal wrapper fields:

```json
{
  "schemaVersion": "1.0",
  "skill": "cwv-triage",
  "url": "https://www.example.com/",
  "timestamp": "2026-06-20T12:00:00.000Z",
  "findings": []
}
```

`cwv-triage` may also carry a selected-target handoff:

```json
{
  "rawTop": { "...": "highest-pressure exact row" },
  "selectedTop": {
    "url": "https://www.example.com/load-bearing",
    "canonicalUrl": "https://www.example.com/load-bearing",
    "source": "rum",
    "rank": 2,
    "bundleCount": 125,
    "sampleCount": 125,
    "traffic": { "bundleCount": 125 },
    "sampleConfidence": "load-bearing",
    "failingMetrics": ["LCP"],
    "pressure": 1.28,
    "recommendedFormFactor": "PHONE",
    "recommendedProfile": "mobile-slow4g-4xcpu",
    "selectionReason": "Selected because it is the highest-pressure load-bearing URL."
  },
  "nearMisses": []
}
```

When present, `selectedTop` is the durable triage-to-diagnosis phase boundary:
downstream phases should measure `selectedTop.url` and use
`selectedTop.recommendedProfile` unless the operator explicitly overrides the
surface. For RUM, `selectedTop`, `rawTop`, and `nearMisses` are selected within
the recommended form-factor surface so the URL and profile describe the same
field population; aggregate URL rows remain supporting evidence. `rawTop` and
`nearMisses` preserve ranking evidence for review.

---

## Schema

```json
{
  "schemaVersion": "1.0",
  "id": "diagnose-lcp-1",
  "timestamp": "2026-04-16T12:00:00Z",
  "url": "https://www.adobe.com/",
  "skill": "cwv-diagnose",
  "source": "har",
  "metric": ["LCP"],
  "type": "bottleneck",
  "severity": "high",
  "rootCause": true,
  "cause": "Hero image not preloaded; discovered only after render-blocking CSS parses",
  "evidence": [
    {
      "kind": "cwv-attribution",
      "metric": "LCP",
      "data": { "resourceLoadDelay": 1420, "timeToFirstByte": 380, "target": "img.hero" }
    },
    {
      "kind": "resource-timing",
      "data": { "url": "https://www.adobe.com/hero.jpg", "startTime": 1850, "transferSize": 320000, "type": "img" }
    }
  ],
  "recommendation": "Add `<link rel=preload as=image href=/hero.jpg fetchpriority=high>` in `<head>` above the render-blocking stylesheet.",
  "patches": {
    "preloads": [
      { "href": "/hero.jpg", "as": "image", "fetchpriority": "high" }
    ]
  },
  "confidence": 0.85,
  "impactReduction": { "metric": "LCP", "valueMs": 1200 },
  "status": "proposed",
  "relatedFindingIds": ["triage-lcp-1"],
  "mergedSources": []
}
```

---

## Field semantics

### Identity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | string | yes | Always `"1.0"` for this revision. Bump on breaking change. |
| `id` | string | yes | Stable, unique per finding within a session. Format: `{skill-shortname}-{metric}-{n}` (e.g. `triage-lcp-1`, `diagnose-inp-2`). Preserved when a finding is enriched by a downstream skill. |
| `timestamp` | string (ISO 8601 UTC) | yes | When the finding was last mutated. |
| `url` | string | yes | Absolute URL the finding pertains to. |
| `skill` | enum | yes | Which skill emitted or last mutated this finding: `cwv-triage` \| `cwv-analyze` \| `cwv-diagnose` \| `cwv-fix` \| `cwv-validate`. |

### Classification

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | enum | yes | Evidence origin: `crux` \| `rum` \| `psi` \| `har` \| `html` \| `coverage` \| `perf_observer` \| `rules` \| `code`. Drives the confidence cap (see below). |
| `metric` | array of enum | yes | One or more of `LCP` \| `CLS` \| `INP` \| `FCP` \| `TTFB` \| `TBT` \| `SI`. Multi-entry when a cause affects several metrics (e.g. render-blocking JS affects LCP+TBT+INP). |
| `type` | enum | yes | `bottleneck` (on critical render path) \| `waste` (unused bytes/work) \| `opportunity` (missing hint). |
| `severity` | enum | yes | `high` \| `medium` \| `low`. Derived from `impactReduction` vs MIN_ACTIONABLE_IMPACT (see below). |
| `rootCause` | boolean | yes | `true` = fundamental driver; `false` = observable symptom of another finding. Used for causal-graph prioritization. |

### Content

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cause` | string | yes | One-sentence description of the underlying cause. Concrete, cites the mechanism. |
| `evidence` | array of object | yes | ≥1 typed evidence entries. See "Evidence kinds" below. |
| `recommendation` | string | yes | What to do, in plain language. Specific and actionable. |
| `patches` | object | no | A fragment of `patches.json` that the workbench harness can apply to validate the fix. CDP/DOM **runtime mutations** (`markup`/`preloads`/`block`/`responseHeaders`/`rewriteBody`) — **not** a diff. Omitted for findings that can't be tested via patch (e.g. server-side TTFB). |
| `sourceEdits` | array of object | no | The structured **source-edit records** from [`source-mapper.js`](../../scripts/source-mapper.js) — the load-bearing subset `{ file, before, after, line? }`. The raw, tool-agnostic material from which `cwv-publish` (003-02) derives the SpaceCat unified-diff `patchContent` at upload. Required only for a deployable patch publish; guidance-mode publishes (`rootCause: true` with no safe patch) intentionally omit it. See "[fix-findings.json → suggestion-payload mapping](#fix-findingsjson--suggestion-payload-mapping)". |
| `sourceAvailability` | object | no | Source-probe status for the source-translation/publish handoff. Shape: `{ status, siteId?, baseURL?, deliveryType?, sourceRoot?, manifestPath?, s3Key?, reason?, checkedAt? }`, where `status` is `unattempted` \| `fetched` \| `not_found` \| `auth_blocked` \| `mapping_failed`. Required in practice when a validated finding lacks `sourceEdits`, so `cwv-publish` can distinguish "source was never tried" from "source-s3 was attempted but unavailable/unmappable." |
| `title` | string | no | **Publish presentation.** Short imperative phrase used as the SpaceCat issue heading (the `value` H2). Falls back to `recommendation` — but that is usually a paragraph, so set a real `title` for a publish-bound finding. |
| `publishDescription` | string | no | **Publish presentation.** Concise, customer-facing problem statement for the issue Description. Falls back to `cause`. Use it to keep internal diagnostic detail (repo names, ref counts, "VERIFIED", N=runs) OUT of the customer record — Description = the problem, Implementation Details (`recommendation`) = the fix. |
| `issueType` | string | no | **Publish presentation.** Overrides the metric-derived issue LABEL — but it MUST itself be an approved CWV metric (`lcp`/`cls`/`inp`/`ttfb`); a non-approved value throws. The default is the canonical metric (e.g. `cls`), NOT playbook vocab. (ADR-0009 amendment 2026-06-15.) |

### Scoring

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `confidence` | number (0..1) | yes | Calibrated per the source-tier caps in [evidence-and-confidence.md](./evidence-and-confidence.md). Findings with `confidence < 0.5` MUST be suppressed. |
| `impactReduction` | object | yes | Estimated metric improvement. Shape: `{ metric: "LCP"\|"INP"\|... , valueMs?: number, score?: number }`. Use `valueMs` for time metrics, `score` for CLS. |

### Lifecycle

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | enum | yes | `draft` (triage surfaced it) \| `proposed` (diagnose ranked it, patch candidate) \| `applied` (fix ran the patch and measured delta) \| `validated` (validate confirmed with stats) \| `rejected` (below threshold or no measured improvement) \| `regression` (measured delta is worse than baseline) \| `no_op` (treatment samples tolerance-identical to baseline — patch applied cleanly in the pipeline but did not alter runtime behaviour; distinct from `rejected` so downstream analytics can surface silent no-ops separately from measured failures). |
| `relatedFindingIds` | array of string | no | IDs this finding is causally linked to or derived from. A diagnose finding enriched from a triage finding SHOULD reference the triage id here. |
| `mergedSources` | array of string | no | Source enums that were deduped into this finding (e.g. `["psi", "har"]` for a finding synthesized from both PSI and HAR evidence). |

### Attribution (platform-vs-customer ownership)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `owner` | enum | no | Who owns the cause: `platform-default` \| `dispatcher-cdn` \| `customer-code` \| `customer-content` \| `third-party`. The literal "is it AEM or the customer?" answer. Added by `attribution.js`. |
| `ownership` | object | no | Derivation detail: `{ owner, confidence (0..1), flavor, playbook (issue_type consulted), deliveryConstraint, rationale, signals[] }`. See "Platform-vs-customer attribution" below. |

When both are present, `owner` MUST equal `ownership.owner`. Both are optional — findings emitted before the attribution pass simply omit them.

---

## Evidence kinds

`evidence[].kind` is an open enum — start with these, extend as needed. Every entry MUST include `kind` and `data`.

| `kind` | `data` shape | Used when |
|--------|-------------|-----------|
| `cwv-attribution` | web-vitals attribution object, optionally filtered to relevant fields. Always include `metric` sibling. | LCP/CLS/INP/FCP/TTFB finding grounded in harness measurement. |
| `resource-timing` | `{ url, startTime, transferSize, duration, ttfb?, renderBlockingStatus?, priority?, type?, nextHopProtocol?, serverTiming? }` | Pointing at a specific network resource from `collect-resources.js`, including transport/cache fields when exposed by Resource Timing. |
| `crux-percentile` | `{ metric, p75, distribution: { good, needs_improvement, poor }, formFactor }` | Field data from CrUX API. |
| `rum-bundle` | `{ metric, p75, samples, dateRange, byElement? }` | Field data from Helix RUM Bundler. |
| `psi-audit` | `{ auditId, displayValue, numericValue, savings? }` | PSI/Lighthouse audit row. |
| `har-entry` | `{ url, startedDateTime, time, request, response }` (subset) | HAR-level evidence. |
| `coverage-row` | `{ url, totalBytes, unusedBytes, unusedPct }` | JS/CSS coverage evidence. |
| `rule-violation` | `{ ruleId, match, context }` | Static rule fired. See [rules.md](./rules.md). |
| `long-animation-frame` | `{ startTime, duration, scripts }` | PerformanceObserver LoAF entry. |
| `csp-violation` | `{ blockedURI, effectiveDirective, matchedPatch? }` | CSP policy blocked a page or patched resource. Used as diagnosis evidence, not as a standalone CWV finding. |
| `screenshot` | `{ path, viewport, phase }` | Visual evidence (`phase` = `baseline` \| `attempt-N`). |
| `measurement-delta` | `{ metric, baseline, treatment, deltaMs?, deltaScore?, runs }` | Fix/validate skills attach this to prove effect. |

---

## Source-tier confidence caps

Confidence MUST NOT exceed the cap for the finding's `source`. When a finding merges multiple sources, use the cap of the strongest (lowest-tier-number) source actually cited in `evidence`.

| Tier | Sources | Max confidence |
|------|---------|----------------|
| 1 — Field | `crux`, `rum` | 0.95 |
| 2 — Lab | `psi`, `har`, `perf_observer`, `coverage` | 0.85 |
| 3 — Static | `html`, `rules` | 0.75 |
| 4 — Speculative | `code` | 0.65 |

Rationale — see [evidence-and-confidence.md](./evidence-and-confidence.md). A lab measurement that matches field data (CrUX/RUM) may reach 0.95 only by adding a `crux` or `rum` evidence entry and setting `source` accordingly.

---

## Platform-vs-customer attribution (the `owner` field)

Findings carry an optional `owner` answering the literal customer question —
**"is it AEM or the customer?"** It is set by
[`../../scripts/attribution.js`](../../scripts/attribution.js), which derives it
from three inputs in order of strength: the **mystique CWV playbook** for the
finding's issue type (its `applicable_flavors` front matter — a type whose
playbook *excludes* the detected stack is platform-managed there), the **stack
docs** (`stacks/aem-{eds,cs,ams}.md` — who owns each layer), and the finding's
own **evidence + response headers** (third-party resource domains, cache
HIT/MISS, the shifting selector).

| `owner` | Means | Typical fix locus |
|---------|-------|-------------------|
| `platform-default` | The hosting platform's own behaviour / defaults (operator-managed). | EDS Fastly/VCL, fixed `head.html`, CDN minify + auto `Link: rel=preload`, platform-managed compression. Customer can't change without the operator. |
| `dispatcher-cdn` | The caching / edge layer. | Dispatcher cache rules, CDN headers, `Cache-Control`. On AMS this is an Adobe ticket; on CS it's `cdn.yaml` via Cloud Manager. |
| `customer-code` | The customer's own code. | EDS block JS/CSS + `scripts.js` phases; AEM CS/AMS clientlibs, HTL templates, Sling models. **Default for AEM** — most CWV issues are the customer's implementation. |
| `customer-content` | Authored values. | DAM assets, component-dialog config, content positioning — fixable in the CMS without a code deploy. |
| `third-party` | An external vendor's script. | analytics, tag managers, A/B test, chat, consent CMP (OneTrust/Cookiebot), ads, social pixels. Defer/async/gate safely; if Launch/DTM-injected, it's a Launch rule change. |

A **first-party selector with no third-party resource in evidence is NOT
`third-party`** — e.g. a site's own custom consent banner component
(`.cookies__container` on otempo, AEM CS) is `customer-code`, not `third-party`,
because the bytes/behaviour are the customer's even though the feature is a
cookie bar. This is the exact distinction the otempo verdict turned on.

`ownership.deliveryConstraint` flags when the fix isn't a normal code change:
`requires-operator` (Fastly/Dispatcher/CDN/platform — Adobe ticket or Cloud
Manager), `requires-launch-rule` (Adobe Launch/DTM-injected — editing markup is
futile), or `null` (a normal in-repo fix).

Tag findings with:
```bash
node .agents/scripts/attribution.js analyze-findings.json --flavor <eds|cs|ams|headless> \
  --output analyze-findings.json
# or ask which playbooks apply to a metric:
node .agents/scripts/attribution.js --explain CLS --flavor cs
```

---

## `fix-findings.json` → suggestion-payload mapping

A `validated` finding in `fix-findings.json` is the hand-off `cwv-publish`
(spec 003-02) consumes to author a SpaceCat **`CODE_CHANGE` suggestion**
([spacecat-api.md](./spacecat-api.md)). `fix-findings.json` stays
**Finding-native** — it carries the raw materials, **not** pre-built SpaceCat
shapes. The SpaceCat-specific shapes (the unified-diff `patchContent`, the
`kpiDeltas` keying, the `issue.value` Markdown) are **derived by `cwv-publish`
at upload**, because the diff is needed only at SpaceCat upload and is best
formatted against the source then (spec 003-04 publish-time-derivation decision;
[ADR-0006](../../../docs/decisions/adr-0006-publish-findings-to-spacecat.md)).

This table is the contract that lets `cwv-publish` map fields with **no
transformation guesswork**. Each row is tagged:

- **direct** — copied verbatim into the payload.
- **keyed-at-publish** — read from a Finding field and re-keyed into the payload
  structure (e.g. measurement-delta → `kpiDeltas{metric}`).
- **formatted-at-publish** — assembled by `cwv-publish` (Markdown / unified diff).

| `fix-findings.json` source | → suggestion-payload destination | Disposition |
|---|---|---|
| `url` | `data.url` | **direct** |
| (constant) | `data.type` = `"url"` | **direct** (literal) |
| `metric[0]` | `data.aggregationKey` = `<url>\|<metric>` (the UI shows ONE row per key) | **keyed-at-publish** |
| `title` (fallback `recommendation`) | issue `value` H2 title (`## <title>`) — keep it SHORT; escape HTML | **formatted-at-publish** |
| `publishDescription` (fallback `cause`) | issue `value` `### Description` — concise, customer-facing PROBLEM (no internal diagnostics) | **formatted-at-publish** |
| `recommendation` | issue `value` `### Implementation Details` — the FIX (code-level guidance) | **formatted-at-publish** |
| `sourceEdits[]` | issue `patchContent` (clean unified diff) **only for patch publishes** — NOT re-embedded in `value`; omitted for guidance mode | **formatted-at-publish** — via [`editsToUnifiedDiff`](../../scripts/source-edits.js); reconcile vs real source for a git-applicable diff |
| `evidence[kind=measurement-delta]` + `profile` | `kpiDeltas{<metric>}` — **only when `status==='validated'`; OMIT the key when empty** (an empty `{}` 500s the API). Lab-only numbers stay in the issue body. | **keyed-at-publish** |
| FIELD p75 (triage/RUM) | `data.metrics[].<metric>` — use the FIELD value (drives the UI's "LCP x.xs"), NOT a lab baseline | **keyed-at-publish** |
| `profile` (`*desktop*` ⇒ `desktop`, else `mobile`) | `deviceType` in `data.metrics[]` (+ `kpiDeltas` when present) | **keyed-at-publish** |
| `issueType` (fallback `metricToIssueType(metric)`) | issue `type` (UI category hint; not validated; ADR-0008 locks CWV publishes to lowercase metric labels like `cls`/`lcp`/`inp`) | **keyed-at-publish** |
| any issue carries a patch | `data.isCodeChangeAvailable` = `true` | **keyed-at-publish** |
| **ALL findings for one URL** | **ONE** suggestion record; `data.issues[]` = one issue per finding (**NEVER split a URL across records**) — built by [`buildSuggestionFromFindings`](../../scripts/publish-payload.js) | **formatted-at-publish** |
| publish gate | `status==='validated'` **OR** `rootCause===true` (guidance, ADR-0008) **OR** carries `sourceEdits`/patch | (pre-publish filter) |

### Source availability gate for patch publishes

A validated runtime patch without `sourceEdits` is not the same as "no customer
code exists." Before producing a guidance-only SpaceCat record, the workflow must
attempt the source path and record the result:

1. Resolve the SpaceCat site via `query-sites` or the Mysticat CLI fallback:
   `mysticat site get <url> --json`.
2. If the site record has imported code, run `cwv-source-fetch` /
   `source-fetch.js --site-id <id>` and record `sourceAvailability.status:
   "fetched"` with `manifestPath` / `sourceRoot`.
3. Map/reconcile the source change into `sourceEdits`; publish uses those records
   to derive `patchContent`.
4. If source cannot become a patch, record the terminal status:
   `not_found`, `auth_blocked`, or `mapping_failed` with `reason`.

`sourceAvailability.status:"unattempted"` (or a missing field) means the handoff
is incomplete for a validated finding without `sourceEdits`; it should not be
treated as proof that patch content cannot be generated.

### Known-absent / optional payload inputs

These payload inputs are **not** captured in `fix-findings.json` today.
`cwv-publish` defaults or omits them — they are explicitly **not silent gaps**:

| Payload input | Disposition at publish |
|---|---|
| `data.metrics[]`, `data.organic`, `data.pageviews` | **read-probe enriched** — `fix-findings.json` carries lab measurements, not field traffic. For SpaceCat publishes, reuse the audit/read-probe values for the URL when available; otherwise omit optional traffic fields. |
| `value` **Effort** line (`**Effort**: Low\|Medium\|High`) | **optional / known-absent** — not modelled on the Finding. `cwv-publish` defaults (e.g. from `severity`) or omits. |
| suggestion `rank` | **read-probe enriched** — reuse the audit suggestion's rank for the URL when available (ADR-0008); severity-derived rank is only the local/dry-run fallback. |
| issue `status` (e.g. `"NEW"`) | **derived-at-publish** — `cwv-publish` defaults to `"NEW"` for a fresh suggestion. |

### What `cwv-publish` does NOT find here (and must do itself)

- **Reconcile each `sourceEdits` record against the real source file** — line
  numbers / surrounding context for a git-applicable diff. `sourceEdits` carries
  the `before`/`after` snippets and a best-effort `line`; the
  [`editsToUnifiedDiff`](../../scripts/source-edits.js) formatter produces a
  diff from exactly those snippets, and 003-02 may widen hunks against the
  checked-out source.
- **Resolve URL → `siteId` and the existing `cwv` opportunity** (via
  `query-sites`); **dedup** prior `NEW` suggestions for the URL → `OUTDATED`.
- **Auth + POST** (mysticat Bearer token, 207 array handling). All of this is
  spec 003-02 — see [spacecat-api.md](./spacecat-api.md).

---

## MIN_ACTIONABLE_IMPACT gates

A finding MUST be suppressed (status = `rejected`, reason = `below-threshold`) when its `impactReduction` is under these floors AND the metric itself is currently above the "good" boundary:

| Metric | MIN_ACTIONABLE_IMPACT | Also require metric currently > |
|--------|----------------------|-------------------------------|
| LCP | 200 ms | 2500 ms |
| CLS | 0.03 | 0.10 |
| INP | 50 ms | 200 ms |
| TBT | 100 ms | 200 ms |
| FCP | 150 ms | 1800 ms |
| TTFB | 150 ms | 800 ms |

Severity mapping derived from `impactReduction` (using LCP gates as reference, scale for other metrics):

- `high`: ≥ 3× MIN_ACTIONABLE_IMPACT
- `medium`: 1–3× MIN_ACTIONABLE_IMPACT
- `low`: < 1× MIN_ACTIONABLE_IMPACT (and therefore `rejected`)

---

## Lifecycle transitions

```
draft ──► proposed ──► applied ──► validated
                ▲          │           │
                │          ├──────────►│ rejected
                │          ├──────────►│ regression
                └──────────┴──────────►  no_op
```

Skills are the only entities that mutate `status`:

- **`cwv-triage`** emits new findings with `status="draft"`, `source` ∈ {`crux`, `rum`, `psi`}, no `patches`.
- **`cwv-diagnose`** takes draft findings (or generates new ones from lab data), fills `cause`/`evidence`/`recommendation`/`patches`, sets `status="proposed"`. Sets `relatedFindingIds` to upstream triage ids when applicable.
- **`cwv-fix`** takes proposed findings, runs `launcher.js --patches`, appends a `measurement-delta` evidence entry, and sets `status="applied"` on net-positive attempts or `status="rejected"` on no-effect attempts.
- **`cwv-validate`** takes applied findings, runs N-run stats comparison, sets `status="validated"` (non-overlapping IQR, positive delta), `status="regression"` (negative delta), `status="rejected"` (inconclusive with negative median), or `status="no_op"` (oracle verdict `NO_OP` — treatment samples tolerance-identical to baseline; the patch pipeline succeeded but did not alter runtime behaviour). `no_op` is deliberately separated from `rejected` so the orchestrator can count silent patch-applier failures without string-sniffing reason prefixes.

Once a finding reaches `validated`, `rejected`, `regression`, or `no_op`, it is terminal for that session.

---

## Output envelope

Skills SHOULD emit findings inside a small envelope so downstream tooling can pick up the schema version and session metadata:

```json
{
  "schemaVersion": "1.0",
  "skill": "cwv-diagnose",
  "url": "https://www.adobe.com/",
  "timestamp": "2026-04-16T12:00:00Z",
  "findings": [ /* Finding objects */ ]
}
```

The validator at [`../../../scripts/finding-schema.js`](../../scripts/finding-schema.js) accepts either a single Finding or an envelope.

### Envelope-level `status` (terminal states)

Individual findings carry per-finding lifecycle statuses (`draft` → … →
`validated`/`rejected`/etc — see above). The **envelope itself** may also
carry an optional top-level `status` field that signals a session-level
terminal outcome to downstream skills. These are distinct from per-finding
statuses and the validator tolerates them as unknown top-level fields (the
envelope schema only asserts `schemaVersion` / `skill` / `url` /
`timestamp` / `findings`).

| Envelope `status` | Emitted by | Meaning | Downstream effect |
|-------------------|-----------|---------|-------------------|
| (absent)          | all skills | normal — proceed | no effect |
| `"passing"`       | `cwv-triage` | field CWV is already GOOD on every queried form factor × metric pair, measured from real field data (`crux` / `rum`, never `psi`-only) | `cwv-analyze`, `cwv-orchestrate` refuse to start without `--force` — running the lab loop on a field-green URL is wasted compute |

When `status: "passing"` is present, the envelope SHOULD include a
`passing` block describing the signals that triggered the rule:
```json
{
  "status": "passing",
  "passing": {
    "reason": "field-already-good",
    "checked": ["LCP", "CLS", "INP"],
    "byFormFactor": {
      "PHONE":   { "LCP": 1393, "CLS": 0.02, "INP": 106, "source": "crux", "maxPressure": 0.557 }
    },
    "thresholds": { "LCP": 2500, "CLS": 0.1, "INP": 200 }
  }
}
```
`findings` may be empty or carry one `status: "rejected"`,
`reason: "field-already-good"` entry per metric for traceability. The
thresholds block echoes the web.dev GOOD boundaries for audit — changing
them in the future (e.g. tightening the INP target) requires updating
both triage Step 6b and these fixtures.

---

## Worked examples

### Triage draft (CrUX-sourced)

```json
{
  "schemaVersion": "1.0",
  "id": "triage-lcp-1",
  "timestamp": "2026-04-16T12:00:00Z",
  "url": "https://www.adobe.com/",
  "skill": "cwv-triage",
  "source": "crux",
  "metric": ["LCP"],
  "type": "bottleneck",
  "severity": "high",
  "rootCause": false,
  "cause": "Origin-level CrUX LCP p75 exceeds 2500ms threshold on mobile.",
  "evidence": [
    { "kind": "crux-percentile",
      "data": { "metric": "LCP", "p75": 3200, "distribution": { "good": 0.55, "needs_improvement": 0.30, "poor": 0.15 }, "formFactor": "PHONE" } }
  ],
  "recommendation": "Run `cwv-diagnose` on this URL to identify LCP root cause.",
  "confidence": 0.90,
  "impactReduction": { "metric": "LCP", "valueMs": 700 },
  "status": "draft"
}
```

### Fix applied (with measurement-delta)

```json
{
  "schemaVersion": "1.0",
  "id": "diagnose-lcp-1",
  "timestamp": "2026-04-16T13:05:00Z",
  "url": "https://www.adobe.com/",
  "skill": "cwv-fix",
  "source": "har",
  "metric": ["LCP"],
  "type": "bottleneck",
  "severity": "high",
  "rootCause": true,
  "cause": "Hero image not preloaded; discovered only after render-blocking CSS parses",
  "evidence": [
    { "kind": "cwv-attribution", "metric": "LCP",
      "data": { "resourceLoadDelay": 1420, "target": "img.hero" } },
    { "kind": "measurement-delta",
      "data": { "metric": "LCP", "baseline": 3911, "treatment": 2487, "deltaMs": -1424, "runs": 3 } },
    { "kind": "screenshot", "data": { "path": "screenshots/attempt-1.png", "phase": "attempt-1" } }
  ],
  "recommendation": "Add `<link rel=preload as=image href=/hero.jpg fetchpriority=high>` in `<head>`.",
  "patches": { "preloads": [ { "href": "/hero.jpg", "as": "image", "fetchpriority": "high" } ] },
  "confidence": 0.90,
  "impactReduction": { "metric": "LCP", "valueMs": 1424 },
  "status": "applied",
  "relatedFindingIds": ["triage-lcp-1"]
}
```

### Validate regression

```json
{
  "schemaVersion": "1.0",
  "id": "diagnose-inp-2",
  "timestamp": "2026-04-16T14:00:00Z",
  "url": "https://www.adobe.com/",
  "skill": "cwv-validate",
  "source": "perf_observer",
  "metric": ["INP"],
  "type": "bottleneck",
  "severity": "medium",
  "rootCause": false,
  "cause": "Blocking GTM bootstrap hypothesized to reduce INP processingDuration",
  "evidence": [
    { "kind": "measurement-delta",
      "data": { "metric": "INP", "baseline": 144, "treatment": 187, "deltaMs": 43, "runs": 15 } }
  ],
  "recommendation": "Do not block GTM — INP got worse. Investigate other INP sources.",
  "confidence": 0.85,
  "impactReduction": { "metric": "INP", "valueMs": -43 },
  "status": "regression",
  "relatedFindingIds": ["diagnose-inp-2"]
}
```

### Validated fix with `sourceEdits` (the publish hand-off)

A terminal `validated` finding carrying the structured `sourceEdits` records
`cwv-publish` formats into the unified diff. See "[fix-findings.json →
suggestion-payload mapping](#fix-findingsjson--suggestion-payload-mapping)". A
runnable copy is [`fix-findings.example.json`](../../scripts/test/fixtures/fix-findings.example.json).

```json
{
  "schemaVersion": "1.0",
  "id": "diagnose-cls-1",
  "timestamp": "2026-06-11T18:00:00.000Z",
  "url": "https://www.parcelpro.com/us/en/home.html",
  "skill": "cwv-validate",
  "source": "perf_observer",
  "metric": ["CLS"],
  "type": "opportunity",
  "severity": "high",
  "rootCause": true,
  "cause": "The sticky nav header is position:fixed and a late header.js paddingTop spacer shifts main content (measured CLS contribution 0.119).",
  "evidence": [
    { "kind": "measurement-delta",
      "data": { "metric": "CLS", "baseline": 0.144, "treatment": 0.025, "deltaScore": -0.119, "runs": 15, "iqrOverlap": false } }
  ],
  "recommendation": "Make the sticky header position:sticky so it reserves its own space, and drop the header.js paddingTop spacer toggle.",
  "patches": { "markup": [ { "selector": "header.nav", "attrs": { "style": "position:sticky;top:0" } } ] },
  "sourceEdits": [
    { "file": "styles/header.css", "line": 42, "before": "  position: fixed;\n  top: 0;", "after": "  position: sticky;\n  top: 0;" },
    { "file": "scripts/header.js", "line": 18, "before": "  document.body.style.paddingTop = header.offsetHeight + 'px';", "after": "  // paddingTop spacer no longer needed: header is position:sticky" }
  ],
  "confidence": 0.85,
  "impactReduction": { "metric": "CLS", "score": 0.119 },
  "status": "validated",
  "owner": "customer-code"
}
```

The envelope around publish-bound findings SHOULD carry the top-level
`profile` (and `formFactor`) — `cwv-publish` maps `profile` → `deviceType`
(`*desktop*` ⇒ `desktop`, else `mobile`) for `kpiDeltas`.

---

## Validation

Use the JS validator to check any finding or envelope:

```bash
node --input-type=module -e "import { validateFinding } from './.agents/scripts/finding-schema.js'; \
  import { readFileSync } from 'node:fs'; \
  const f = JSON.parse(readFileSync('./my-finding.json', 'utf8')); \
  const r = validateFinding(f); \
  if (!r.valid) { console.error(r.errors); process.exit(1); } \
  console.log('OK');"
```

The validator enforces: required fields, enum values, confidence source-tier caps, MIN_ACTIONABLE_IMPACT gates, lifecycle transitions (when `prevStatus` is supplied).
