# CWV remediation playbooks (vendored)

Per-issue-type remediation playbooks consumed by the workbench's
**platform-vs-customer attribution** and **playbook-guided diagnosis** (G5).
Each file is a single Markdown doc with a YAML front-matter header
(`issue_type`, `applicable_flavors`, `risk_tier`, `forbidden_techniques`, …)
and a structured prose body. The format is documented in
[`_FORMAT.md`](./_FORMAT.md).

## Why these live here

These are the knowledge artifact that "was never consulted during detection."
A failing metric loads its playbook (CLS → [`layout-shift.md`](./layout-shift.md)),
and the playbook's `applicable_flavors` + signals drive **what to measure** and
**how to classify ownership**:

- A type whose `applicable_flavors` **excludes** the detected stack is a
  platform-managed / N/A signal (e.g. `compression`, `ttfb`, `font-preload`,
  `resource-preload` exclude `eds` because they're CDN/`head.html`-managed there).
- The body's router (e.g. `layout-shift.md`'s "dynamically inserted content /
  font swap / ad slot" table) classifies the shifting element.

The parser + classifier that read these files are
[`.agents/scripts/attribution.js`](../../scripts/attribution.js).

## Provenance & sync

Source of truth: **`spacecat/mystique`** →
`docs/opportunities/cwv/playbooks/`. These are a **vendored copy** so the
workbench is self-contained and its tests are hermetic (they parse the local
files, not an external checkout).

Since the 015-03/04/05 gates (diagnose body-injection, mechanism gate,
forbidden-technique validator) enforce this set, its freshness is **explicit**,
not a silent manual `cp` (ADR-0015 §Consequences). A committed
[`PROVENANCE.json`](./PROVENANCE.json) pins a stable checksum over the
issue-type playbook `.md` files (excluding this `README.md` and `_FORMAT.md`);
`node .agents/scripts/playbook-provenance.js` computes it and
`npm run doctor` surfaces a `playbooks:freshness` row (present / stale /
missing) so drift is never silent.

To re-sync from a local mystique checkout (**this replaces the old raw `cp`**):

```bash
# Point at the source, then refresh + rewrite PROVENANCE.json:
CWV_PLAYBOOKS_DIR=~/Projects/spacecat/mystique/docs/opportunities/cwv/playbooks \
  npm run playbooks:sync
# or explicitly:
node .agents/scripts/playbook-sync.js \
  --source ~/Projects/spacecat/mystique/docs/opportunities/cwv/playbooks \
  --source-ref <commit-or-snapshot>
```

To check for drift WITHOUT writing (CI/preflight dry-run; exits non-zero when
out of sync):

```bash
CWV_PLAYBOOKS_DIR=~/Projects/spacecat/mystique/docs/opportunities/cwv/playbooks \
  npm run playbooks:check
```

The source directory resolves from `--source`, then `CWV_PLAYBOOKS_DIR`, then
the mystique default `$HOME/Projects/spacecat/mystique/docs/opportunities/cwv/playbooks`.

To point the loader at a live checkout instead of this copy at runtime, set
`CWV_PLAYBOOKS_DIR=/path/to/mystique/docs/opportunities/cwv/playbooks`
(honored by `attribution.js`).

These are **Phase-1 authoring-only** in mystique — human-readable references,
not yet enforced by mystique's Phase-2 loader/validator. The workbench reads
the front-matter + body signals; it does not run the `forbidden_techniques`
regexes (that is mystique's code-fix agent's job).
