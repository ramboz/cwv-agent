# cwv-agent

A Core Web Vitals performance-fixing toolkit for agentic CLIs (Claude Code,
Codex, and friends): skills, a curated knowledge base, and a deterministic
Puppeteer-based measurement harness that applies patch bundles at the CDP
Fetch layer and proves every fix with a statistical oracle.

**V3** is a ground-up rework: the LangChain pipeline of V1/V2 is replaced by
markdown skills your agentic CLI executes directly, and prose suggestions are
replaced by reproduced, negative-controlled, oracle-validated findings with
ready-to-land diffs.

## The loop

```
cwv-diagnose  →  cwv-fix  →  cwv-validate  →  cwv-report
```

1. **Diagnose** — measure the live URL under a fixed lab profile, attribute
   the failing metric to a mechanism (reproduce + negative control before any
   root-cause claim), and consult the per-issue-type playbooks.
2. **Fix** — express the hypothesis as a `patches.json` the launcher applies
   at the CDP Fetch layer (preloads, markup mutations, header rewrites,
   blocking, body rewrites) and A/B it against baseline.
3. **Validate** — N≥15-run baseline-vs-treatment comparison scored by a
   numeric oracle (IQR overlap, minimum-impact floors, A/A reliability
   gates) — the verdict is the oracle's, not the agent's.
4. **Report** — assemble the handoff: unified diffs from `sourceEdits`, the
   ownership verdict (platform, site code, or third party?), honest
   validation claims, and the full artifact manifest.

`cwv-triage` (optional, CrUX/PSI) picks the highest-leverage URLs first, and
`cwv-orchestrate` runs the loop autonomously across ranked candidates.

## Quick start

```
# Use Node 20+; nvm users can run `nvm use`.
npm ci
npm run setup
npm run doctor
node .agents/scripts/launcher.js --help
node .agents/scripts/launcher.js --url https://example.com --no-scroll --output /tmp/cwv-smoke.json
npm run artifacts -- --progress progress/example-com --output progress/example-com/artifacts-manifest.json
```

This runs the default `local` profile: no `.env` and no API keys required.
The first install downloads Puppeteer's pinned Chromium (~150MB); a portable
`postinstall` script copies the web-vitals v4 attribution IIFE into
`.agents/scripts/vendor/` so the harness can inject it into every page.

## Execution profiles

`local` is the default. Optional profiles add provider integrations without
changing the local loop's contract; environment variables never activate a
provider by themselves.

| Profile | Role | Prerequisites |
|---------|------|---------------|
| `local` | In-repo measurement, diagnosis, patching, oracle validation, and artifact handoff. | Node >=20, `npm ci`, target URL access. Optional local source checkout for source edits. |
| `field-google` | CrUX + PageSpeed Insights triage. | `GOOGLE_CRUX_API_KEY`, `GOOGLE_PAGESPEED_INSIGHTS_API_KEY` in `.env`. |
| `stealth-headful` | Headful Chrome measurement for bot-protected pages. | A local Chrome install; explicit opt-in. |

`npm run doctor -- --profile <name>` reports readiness without writes;
`npm run setup -- --profile <name>` adds safe local setup steps.

## What's inside

| Area | Contents |
|------|----------|
| `.agents/skills/` | The 8 skills (`cwv-setup`, `cwv-triage`, `cwv-analyze`, `cwv-diagnose`, `cwv-fix`, `cwv-validate`, `cwv-report`, `cwv-orchestrate`). |
| `.agents/scripts/` | The harness: `launcher.js` (CDP patch engine), `oracle.js` (statistical verdicts), analyzers (coverage, images, HTML structure, waterfall, RUM correlation), `source-mapper.js` (patch → source edits), `fix-classifier.js`, `local-artifacts.js`. |
| `.agents/references/playbooks/` | 19 per-issue-type remediation playbooks with enforceable front matter (`forbidden_techniques`, `required_validation`, typed `see_also` graph). |
| `.agents/references/metrics/`, `topics/` | Per-metric runbooks and methodology docs. |
| `.agents/references/stacks/` | Pluggable per-stack knowledge packs (ships with a WordPress example; see `_FORMAT.md`). |

For the *why* behind each metric and technique, see the companion
[performance-runbooks](https://github.com/ramboz/performance-runbooks).

## Design principles

- **Mechanism before fix.** No `rootCause: true` without reproduction, a
  negative control, and a discriminating test.
- **The oracle decides.** Verdicts come from a numeric comparison
  (`VALIDATED` / `REGRESSION` / `INCONCLUSIVE` / `NO_OP` / `UNRELIABLE` /
  `manual-review`), never from self-assessment.
- **Field-faithful lab.** Cold cache by default, consent + scroll handling,
  desktop viewport at 1350×940 (Lighthouse parity), and viewport
  comparability gates so stale artifacts can't fake a win.
- **Honest claims.** A lab delta is not a deployment. The validation-claim
  ladder (`runtime` / `deployment`) keeps handoff language truthful.
- **Local-first.** Everything runs from this repo against a public URL; the
  handoff is files, branches, and diffs — no external service required.

## License

MIT
