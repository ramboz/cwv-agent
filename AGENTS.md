# AGENTS.md — cwv-agent

> Entry-point orientation doc. Read this first before invoking any skill or
> running any script in this repo.

## What this repo is

`cwv-agent` is a Core Web Vitals (CWV) performance-fixing toolkit designed
for agentic CLIs. It bundles three things:

1. **Skills** (`.agents/skills/`) — opinionated workflows an agent invokes to
   triage, diagnose, fix, validate, and report CWV issues on a target URL.
2. **Knowledge base** (`.agents/references/`) — curated runbooks for each CWV
   metric, cross-cutting topics (request chains, field-vs-lab signal
   reconciliation, evidence/confidence scoring), per-issue-type remediation
   playbooks, and a pluggable per-stack knowledge seam.
3. **Deterministic measurement scripts** (`.agents/scripts/`) — a Puppeteer
   launcher that runs cold-cache measurements with pinned throttling profiles
   (aligned to Lighthouse / PSI "Mobile Slow 4G"), injects web-vitals v4
   attribution, captures resource timing, and applies `patches.json` bundles
   at the CDP Fetch layer (no post-load DOM hacks).

The goal: make CWV debugging reproducible, evidence-driven, and patch-first.
Every recommendation must be justified by a measurement, and every fix must
be validatable via a statistical re-measurement.

## The 4-step loop

```
0. triage    → optional field profile: identify failing pages, rank by urgency
1. diagnose  → deep lab measurement of the worst page, map attribution,
               mechanism-before-fix (reproduce + negative control)
2. fix       → propose patches, re-measure, iterate, translate to source
3. validate  → statistical confirmation (N-run IQR comparison by the oracle)
4. report    → assemble the handoff: diffs, ownership verdict, honest
               validation claims, artifact manifest
```

Each step is encoded as a skill. Skills are invoked in order for a full
workflow, but individual skills can be run standalone for targeted work
(e.g. validate a fix an engineer already wrote). `cwv-orchestrate` runs the
loop autonomously across ranked candidates with the numeric oracle as the
gate.

### Doctor preflight is an enforced property of every step

Each skill runs the **same** standalone doctor preflight as its Step 0 —
`node .agents/scripts/preflight.js --profile <resolved>` (also
`npm run preflight -- --profile <resolved>`) — before doing any
provider-specific work (field API fetch, browser measurement). The resolved
profile is each skill's documented "Provider profile" (`local` for
diagnose/fix/validate/report, `field-google` for triage).

The gate is read-only (`doctor.js` only — it **never** runs `setup.js`). It
**refuses (exit 1) only on prerequisites doctor can positively determine are
absent** — status `fail` (missing binary, unwritable dir, unresolvable
module) or `not-wired`. Prerequisites doctor **cannot self-verify** (status
`unknown`) surface as non-blocking advisories and the run proceeds.
`--skip-preflight` is the visible escape hatch.

## Skills

| Skill | Step | Purpose |
|-------|------|---------|
| `cwv-setup` | — | Report/prepare prerequisites for a profile. No validation claims. |
| `cwv-triage` | 0 | CrUX/PSI field triage → ranked URL table (`field-google`). |
| `cwv-analyze` | 1 | One-shot collectors + analyzers pass → prioritized findings. |
| `cwv-diagnose` | 1 | Deep lab diagnosis with the mechanism-confirmed gate. |
| `cwv-fix` | 2 | Patch → A/B measure → iterate → map to `sourceEdits`. |
| `cwv-validate` | 3 | N≥15-run oracle validation; terminal finding states. |
| `cwv-report` | 4 | Terminal handoff: report.md + artifacts-manifest.json + diffs. |
| `cwv-orchestrate` | 1–4 | Autonomous candidate-racing loop over the whole cycle. |

## Ground rules for agents

- **Never claim a fix works without an oracle verdict.** `VALIDATED` comes
  from `oracle.js`, not from eyeballing two numbers.
- **Never claim deployment.** A lab-validated patch is not live; the report
  keeps `runtime` and `deployment` layers distinct
  (`validation-layers.js` enforces the language).
- **Mechanism before fix.** Reproduce, negative-control, and run a
  discriminating test before setting `rootCause: true`.
- **One hypothesis per attempt.** Combined patches can't be attributed.
- **Match scroll/interact modes across baseline and treatment.** Mixed modes
  invalidate the comparison; the oracle's comparability gates will refuse.
- **Findings are the interface.** Every skill emits schema-valid Finding
  envelopes (`finding-schema.js` validates; see
  `topics/finding-schema.md`).
- **Playbooks constrain fixes.** `forbidden_techniques` regexes reject
  anti-pattern diffs; `required_validation` ids gate mechanism claims.

## Key scripts

```
node .agents/scripts/launcher.js --url <URL> --profile mobile-slow4g-4xcpu --runs 3
node .agents/scripts/oracle.js --baseline a.json --treatment b.json --metrics LCP,CLS
node .agents/scripts/fix-classifier.js --patches patches.json --repo <src>
node .agents/scripts/source-mapper.js --patches patches.json --repo <src>
node .agents/scripts/local-artifacts.js --progress progress/<slug>
npm run doctor / npm run setup / npm run preflight
```

## Repo conventions

- Node >=20, ESM only, zero runtime deps beyond `puppeteer`, `web-vitals`,
  `dotenv`. Diagnostics → stderr, machine output → stdout.
- Tests: `npm test` (node:test, no network). Lint: `npm run lint`.
- Output artifacts live under `progress/<slug>/` (git-ignored).
- Secrets live in `.env` (git-ignored); `.env.example` documents the keys.
