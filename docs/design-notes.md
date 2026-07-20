# Design notes

Distilled, self-contained records of the load-bearing design decisions this
toolkit carries. Each note states the decision and the evidence that forced
it, so future changes don't relearn them the expensive way.

## 1. Patch at the CDP Fetch layer, pre-navigation

All treatments are applied before navigation via `evaluateOnNewDocument`
(markup mutations) or the CDP `Fetch` domain (headers / blocking / body
rewrites). Post-load DOM hacks cannot test preload hints (the preload scanner
has already run), cannot rewrite received headers, and cannot change the LCP
resource's priority. Pre-navigation application is what makes lab results
predict source-level fixes.

**Interception neutrality (verified).** A 3-arm probe (no-interception /
passthrough-interception / patched) showed CDP `fulfillRequest` overhead is
fixed and body-size-independent (+250 KB → ~0 ms LCP delta), so it cancels in
a baseline-vs-treatment comparison — both arms pay it. Caveat: fulfillment
de-streams responses, inflating *absolute* timings by ~60–500 ms; the harness
therefore measures faithful **deltas**, not absolute values. Compare
patched-vs-baseline runs, never a patched run against an uninstrumented one.

## 2. Cold cache by default (first-visit cohort)

The launcher disables the HTTP cache for the default `first-visit` cohort.
Warm caches both under-measure cold LCP (warm bundles masked ~3 s on a real
case) and silently no-op every `block`/`rewriteBody`/header patch — cache
hits never reach `Fetch.requestPaused`. The `returning` cohort keeps the
cache warm on purpose (a throwaway warm-up load defines the repeat visitor).

## 3. Desktop viewport fidelity: 1350×940

Desktop lab runs render at 1350×940 — Lighthouse's `DESKTOP_EMULATION_METRICS`
— instead of Puppeteer's 800×600 default. CLS *score* is viewport-relative,
so results at different viewports are not comparable. The oracle records
`output.viewport` and refuses (`UNRELIABLE` with `incomparable` details) any
baseline-vs-treatment pair whose recorded viewports mismatch.

## 4. The oracle decides, and refusal is a first-class verdict

Verdicts come from a numeric cascade (sample extraction → reliability gates →
IQR-overlap comparison → minimum-impact floors → roll-up), never from agent
self-assessment. Two refusal verdicts are deliberate features:

- `UNRELIABLE` — the measurement itself can't support a claim (noise,
  incomparable viewports, A/A control failure).
- `manual-review` — a structural DOM-shape / execution-order change that a
  served-byte patch cannot faithfully emulate. Minted at the
  classify→validate boundary *without measuring*; an honest refusal beats a
  faked low-fidelity pass. The fix ships as guidance: land it in source,
  re-measure live.

## 5. Mechanism before fix

A `rootCause: true` claim requires: reproduction of the symptom, a negative
control (the symptom absent when the suspected mechanism is disabled), and a
discriminating test that separates the hypothesis from its nearest rival.
Structural scaffolds (min-height shims, position pins) are probes until the
per-source CLS delta proves them causal — the common failure is an animated
reveal, where the element already has final geometry and the shift *is* the
entrance animation.

## 6. Per-source CLS judgment

Total CLS is the wrong yardstick on a multi-source page — run-to-run variance
in non-targeted sources hides (or fakes) a targeted fix. `cls-variance.js`
identifies the dominant stable source; the oracle compares `CLS@<source>`
with an optional A/A control (`--baseline2`) so volatile sources self-report
`UNRELIABLE` instead of producing false verdicts.

## 7. Local-first execution profiles

The default `local` profile runs everything from this repo against a public
URL — no keys, no external services. Optional providers (`field-google`,
`stealth-headful`) are opt-in gates resolved per skill; environment variables
never activate a provider by themselves. The doctor/preflight gate is
read-only and blocks only on positively-verifiable missing prerequisites.

## 8. The two-class fix taxonomy

`fix-classifier.js` routes every proposed fix:

- **Class 1 — generic mutation → `patch`**: expressible directly as a
  served-byte patch; validate now.
- **Class 2 — source edit → `source-edit`**: the deliverable is a repo diff;
  `source-mapper.js` maps it to equivalent byte patches so the oracle can
  validate the effect before the change lands.
- **Class 3 — structural → `manual-review`**: no faithful byte-delta
  emulation exists; ships as guidance (see note 4).

Ambiguous/unknown ops classify to the highest applicable class — never
silently Class 1.

## 9. Honest validation-claim ladder

`validation-layers.js` tracks two layers: `runtime` (lab-proven on the live
URL under the fixed profile) and `deployment` (landed + re-measured live,
evidenced by a `deployment-remeasurement.json` artifact). Customer-facing
text claiming deployment without the artifact throws
(`assertNoDeploymentClaim`). A lab win and a production win are different
sentences.

## 10. Playbooks as enforceable knowledge

The per-issue-type playbooks are not prose-only: `forbidden_techniques`
regexes reject anti-pattern diffs at fix time, `required_validation` ids feed
the mechanism gate, and the typed `see_also` graph (`routes_to` /
`prefer_instead` / `complements` / `orthogonal`) is walked with per-edge
policy so rules never union across a redirect. `PROVENANCE.json` pins a
checksum over the enforced set so silent edits are detectable.
