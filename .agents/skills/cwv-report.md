# Skill: cwv-report

## Purpose
Assemble the final, reviewable handoff for a completed diagnose → fix →
validate loop: a human-readable report plus the machine-readable local
artifact manifest, with unified diffs for every validated fix that carries
`sourceEdits`. This is the terminal step of the 4-step loop — it replaces
nothing upstream and mutates nothing; it formats what the loop proved.

## When to invoke
- After `cwv-validate` (or `cwv-orchestrate`) has produced at least one
  terminal finding (`validated`, `rejected`, `regression`, or `no_op`).
- When the operator asks for "the report", "the handoff", or "what do I ship?".

Do not invoke to *create* evidence — every number in the report must already
exist in `progress/{slug}/` artifacts. If validation hasn't run, route to
`cwv-validate` first.

## Prerequisites
- A `progress/{slug}/` directory with finding envelopes
  (`diagnose-findings.json`, `fix-findings.json`, `validate-findings.json` as
  applicable) and launcher/oracle artifacts.
- Optional: a local source repo for branch refs + git-applicable patch files.

## Workflow

### Step 1 — Assemble the manifest
```
node .agents/scripts/local-artifacts.js \
  --progress progress/{slug} \
  --output progress/{slug}/artifacts-manifest.json
```
With a source repo and validated `sourceEdits`, add branch/patch output:
```
node .agents/scripts/local-artifacts.js \
  --progress progress/{slug} \
  --source-repo <path> --branch-mode per-fix --create-branches \
  --output progress/{slug}/artifacts-manifest.json
```
The manifest indexes every artifact, validates every finding envelope, writes
`source-patches/*.diff` files, and records the two-layer validation ladder
(`runtime` / `deployment`) plus the integration-provider slots.

### Step 2 — Write the report (`progress/{slug}/report.md`)
Structure, in order:

1. **Headline** — the ownership verdict ("platform, site code, or third
   party?") and the total measured gain (baseline → final medians per metric).
2. **Validated fixes** — one section per validated finding: mechanism, the
   oracle verdict + per-metric deltas, the unified diff (from `sourceEdits`
   via `source-edits.js editsToUnifiedDiff`) or the prose implementation
   instructions when no source was available, and any risk notes from the
   playbook.
3. **Manual-review items** — Class-3 / `manual-review` classifications and
   guidance-only findings: what to change in source, why the lab could not
   prove it as a byte delta, and how to re-measure after landing.
4. **Rejected / no-op attempts** — one line each with the oracle reason
   (preserving the negative results is part of the handoff's value).
5. **Validation-claim honesty** — state exactly what was proven: lab-validated
   on the live URL under the fixed profile; NOT deployed, NOT re-measured
   live. Never claim deployment — `validation-layers.js` guards this
   (`assertNoDeploymentClaim`).
6. **Next steps** — land the diffs, deploy, re-measure (`launcher.js` against
   the live page), and record a `deployment-remeasurement.json` artifact to
   close the deployment layer.

### Step 3 — Surface the handoff
Present the report path, the manifest path, and (when present) the branch
refs / patch files. Offer — do not auto-run — a re-measurement command for
post-deploy verification.

## Safety
- Read-only over findings; writes only report/manifest/patch files under
  `progress/{slug}/` and (opt-in) branch refs in the local source repo.
- Never overstate the validation layer. A lab delta is not a production win;
  the report must keep the two claims visibly distinct.

## References to read
- `topics/finding-schema.md` — finding lifecycle + `sourceEdits` contract.
- `topics/evidence-and-confidence.md` — how to phrase confidence honestly.
