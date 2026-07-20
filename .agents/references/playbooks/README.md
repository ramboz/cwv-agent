# CWV remediation playbooks

Per-issue-type remediation playbooks consumed by the toolkit's **ownership
attribution** and **playbook-guided diagnosis**. Each file is a single
Markdown doc with a YAML front-matter header (`issue_type`, `risk_tier`,
`forbidden_techniques`, …) and a structured prose body. The format is
documented in [`_FORMAT.md`](./_FORMAT.md).

## Why these live here

A failing metric loads its playbook (CLS → [`layout-shift.md`](./layout-shift.md)),
and the playbook's signals drive **what to measure** and **how to classify
ownership**:

- An optional `applicable_stacks` front-matter key marks a type as
  platform-managed / N/A on stacks it excludes (absent = applies everywhere).
- The body's router (e.g. `layout-shift.md`'s "dynamically inserted content /
  font swap / ad slot" table) classifies the shifting element.

The parser + classifier that read these files are
[`.agents/scripts/attribution.js`](../../scripts/attribution.js).

For the *why* behind each metric and technique, see the companion
[performance-runbooks](https://github.com/ramboz/performance-runbooks) —
the human-readable knowledge base these playbooks operationalize.

## Provenance & sync

The playbook set is **owned in this repo**. `PROVENANCE.json` pins a stable
checksum over the enforced set (every `.md` except `README.md` and
`_FORMAT.md`) so downstream gates can detect a silently-edited set.

After editing playbooks, re-mint the marker:

```
npm run playbooks:sync -- --source .agents/references/playbooks
```

`npm run playbooks:check` verifies the vendored set against an external
source directory when `CWV_PLAYBOOKS_DIR` (or `--source`) is set.

## Enforcement

The `forbidden_techniques` regexes are enforced by
[`forbidden-technique-validator.js`](../../scripts/forbidden-technique-validator.js)
at fix time; `required_validation` items feed the mechanism gate. The prose
bodies are agent-readable guidance, not executable code.
