# Source Integration

## When to use this

Run the **source-mapper** after `cwv-fix` or `cwv-validate` has accepted a
finding (`status = "applied"` or `"validated"`) and the operator is ready to
translate the runtime patch into permanent source-code changes.

The `patches.json` bundle applied by `launcher.js` simulates what a CDN or
source change would do in the running browser. It does not survive the
session — the actual fix has to land in a repo (or, for header rules, in a CDN
config). This module closes the loop.

```
cwv-diagnose  →  cwv-fix (patches.json, lab-validated)  →  source-mapper  →  repo PR / CDN ticket
```

Invoke via:

```
node .agents/scripts/source-mapper.js \
  --patches <finding-or-patches.json> \
  --repo <path-to-user-repo> \
  [--apply] \
  [--stack <name>]
```

Or as a Node module: `import { mapToSource } from './source-mapper.js'`.

Default mode is **preview** — it prints a markdown report of proposed edits
without touching files. `--apply` writes `.bak` copies first and prints the
backup paths before editing.

## Supported stacks

Stack is detected from file-tree fingerprints in the target repo (no code
execution). V3 ships one built-in strategy — `generic` (plain HTML
templates) — and `detectStack` is the pluggable seam a stack pack extends
with its own fingerprints and edit strategies (document the stack under
`.agents/references/stacks/`, see `stacks/_FORMAT.md`).

Framework build pipelines (Next.js, Nuxt, Vue, React SPA) require
framework-specific mapping a stack pack would provide. For those repos, use
preview mode and apply edits manually.

Cross-reference full fingerprint list: [`stack-detection.md`](./stack-detection.md).

## Patch-type mapping (generic strategy)

| Patch type        | Mapping | Auto-applied? |
|-------------------|---------|---------------|
| `preloads`        | Insert `<link rel="preload">` after `<head>` in the best-matching `.html` template (prefers `index.html`), deduped against existing preloads. | yes |
| `markup`          | Selector-matched attribute edits on template lines (simple selectors only: `tag`, `.class`, `#id` combinations). Ambiguous/multi-match selectors emit a manual-review warning instead. | yes (single match only) |
| `block`           | Matching `<script src>` lines are replaced with a removal comment; prefer relocating the loader into a delayed phase manually. | yes |
| `responseHeaders` / `requestHeaders` | **Never auto-applied.** Emitted as a CDN config preview (Fastly VCL shown; translate to CloudFront Functions, Nginx, Vercel, etc.). | no |
| `rewriteBody`     | Source change to the emitting code; the mapper cannot place it automatically — carried as prose instructions + `sourceEdits`. | no |

## Invariants

- Preview mode never writes to disk.
- `--apply` always creates a `.bak` next to any edited file and prints the
  backup paths first.
- CDN header patches are never auto-applied.
- Edits carry `{ file, line, before, after, rationale, autoApplicable }`; the
  `{ file, before, after, line? }` subset feeds the finding's `sourceEdits`
  field, from which `cwv-report` derives the unified diff
  (`source-edits.js editsToUnifiedDiff`).

## Known limitations

- The selector grammar is deliberately simple (no combinators/pseudo
  selectors); anything more exotic becomes a manual-review warning.
- Line-based matching assumes template-authored HTML; heavily minified or
  generated markup maps poorly — expect manual-review output there.
- JS-emitted markup (image helpers, component decorators) needs the edit in
  the emitting code, not the template; the mapper flags this rather than
  guessing.
