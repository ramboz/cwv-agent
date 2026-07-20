# Source Integration

## When to use this

Run the **source-mapper** after `cwv-fix` or `cwv-validate` has accepted a finding (`status = "applied"` or `"validated"`) and the operator is ready to translate the runtime patch into permanent source-code changes.

The `patches.json` bundle applied by `launcher.js` simulates what a CDN or source change would do in the running browser. It does not survive the session — the actual fix has to land in a repo (or, for header rules, in a CDN config). This module closes the loop.

```
cwv-diagnose  →  cwv-fix (patches.json, lab-validated)  →  source-mapper  →  repo PR / CDN ticket
```

Invoke via:

```
node .agents/scripts/source-mapper.js \
  --patches <finding-or-patches.json> \
  --repo <path-to-user-repo> \
  [--apply] \
  [--stack aem-eds|aem-cs|generic]
```

Or as a Node module: `import { mapToSource } from './source-mapper.js'`.

Default mode is **preview** — it prints a markdown report of proposed edits without touching files. `--apply` writes `.bak` copies first and prints the backup paths before editing.

## Supported stacks

Stack is detected from file-tree fingerprints in the target repo (no code execution). The detector is conservative: when signals are weak, it defaults to `generic` rather than guessing.

| Stack     | Signals                                                                                                      |
|-----------|--------------------------------------------------------------------------------------------------------------|
| `aem-eds` | `scripts/scripts.js` + any of (`head.html`, `blocks/`, `scripts/aem.js`, `fstab.yaml`, `helix-query.yaml`)    |
| `aem-cs`  | ≥ 2 of (`ui.apps/`, `ui.frontend/`, `apps/`, any `/clientlibs/` subdir, `.html` files under `apps/`)          |
| `generic` | Anything else with at least one `.html` file                                                                  |

Explicitly out of scope (the skill text calls these out): **Next.js, Nuxt, Vue, React SPA**. Their build pipelines and file layouts require framework-specific mapping research that hasn't been done yet. For those repos, use preview mode and apply edits manually.

Cross-reference full fingerprint list: [`stack-detection.md`](./stack-detection.md). Per-stack advice: [`stacks/aem-eds.md`](../stacks/aem-eds.md), [`stacks/aem-cs.md`](../stacks/aem-cs.md), [`stacks/aem-ams.md`](../stacks/aem-ams.md).

**AEM XWalk (Crosswalk)** is not a separate stack here: it authors in AEM CS but publishes via Edge Delivery, so its fix surface is the EDS frontend repo, which fingerprints (and routes) as **`aem-eds`**. Pull it with `source-fetch --channel aemy` (XWalk sites store both a `cm` author package and an `aemy` frontend); `detectStack` then pins `aem-eds` from the manifest channel even though the site's `deliveryType` is `aem_cs`. The CS author side is content-only. See [`stack-detection.md`](./stack-detection.md) → "AEM XWalk".

## Mapping rules (summary)

### `preloads`

| Stack     | Target                                                                                                                           | Auto-apply? |
|-----------|----------------------------------------------------------------------------------------------------------------------------------|-------------|
| generic   | Insert `<link rel="preload" ...>` near the top of `<head>` in `index.html` (or the most-recently-modified `.html` with a `<head>`). Dedupe by `href`. | yes         |
| aem-eds   | Prefer `head.html` (simpler, explicit). If absent, emit a programmatic-preload recommendation for `loadEager()` in `scripts/scripts.js`. | yes (head.html only) |
| aem-cs    | Recommend edit to page template HTL (`apps/<proj>/components/structure/page/customheaderlibs.html`) or custom clientlib.         | no (manual) |

Note: on EDS, a manual preload is usually the wrong answer — the CDN already emits `Link: rel=preload` headers for images marked `fetchpriority="high"` in the eager phase. Prefer editing the `<img>` tag via a `markup` patch. (See [aem-eds.md](../stacks/aem-eds.md).)

### `markup`

| Stack     | Target                                                                                                     | Auto-apply? |
|-----------|------------------------------------------------------------------------------------------------------------|-------------|
| generic   | Grep `.html` files for selector (simple grammar: `tag`, `.class`, `#id`, combinations). Edit attrs in place. | yes (unambiguous match only) |
| aem-eds   | Emit snippet to add to the block decorator in `blocks/<name>/<name>.js` — `block.querySelectorAll(sel).forEach(...)`. | no (manual)  |
| aem-cs    | Recommend the component HTL path (best-guess from clientlib structure). **Never** auto-edits HTL.          | no (manual) |

Selector grammar is deliberately simple. Combinators (`>`, `+`, `~`), attribute selectors (`[data-x]`), pseudo-classes (`:hover`), and commas are unsupported — they trip a "too complex" warning.

### `block` (URL patterns)

| Stack     | Target                                                                                                   | Auto-apply? |
|-----------|----------------------------------------------------------------------------------------------------------|-------------|
| generic   | Find matching `<script src="...">` lines in templates, comment them out.                                 | yes         |
| aem-eds   | Locate the loader call in `scripts/scripts.js`, flag it for relocation into `loadDelayed()`.             | no (manual) |
| aem-cs    | Emit Dispatcher `RewriteRule` snippet; recommend CDN-layer block.                                        | no (manual) |

### `responseHeaders` / `requestHeaders`

**Never auto-applied** on any stack. Emitted as a CDN config preview (Fastly VCL by default — most common with EDS). Operator translates to CloudFront Function JS, Nginx, Vercel rewrites, etc. as appropriate for their infrastructure.

## Output format

**Preview (default):** markdown report. Each edit has a numbered section with absolute file path + 1-indexed line number, Before/After code blocks, and a rationale line naming the source finding (`per finding diagnose-lcp-1 (confidence 0.85, +1200ms LCP)`).

**Apply mode (`--apply`):** writes `.bak` files first and prints their paths, then applies only `autoApplicable: true` edits. Non-autoApplicable edits always go to the "Manual review needed" section regardless of the flag.

The "Manual review needed" section lists:

- All `responseHeaders` / `requestHeaders` (CDN config only).
- All AEM CS HTL edits under `apps/`.
- Ambiguous selector matches (>1 file/line match) — all candidates listed.
- Preload patches on AEM CS.
- Block patches on EDS (require `loadDelayed` relocation) or AEM CS (Dispatcher rule).

## Module API

```js
import { mapToSource } from './.agents/scripts/source-mapper.js';
const result = await mapToSource({ patches, repoRoot, apply: false, stack: undefined });
// result = { edits, warnings, stack, signals }
// edits[] = { file, line, before, after, rationale, autoApplicable, patchType, insertion? }
// warnings[] = { kind, reason?, recommendation, file?, stage?, candidates? }
```

`patches` accepts either a raw `patches.json` object (with top-level `preloads`, `markup`, `block`, etc.) or a full Finding (object with a `patches` field) — the module picks the right shape automatically, and when a Finding is passed it uses `id`/`confidence`/`impactReduction` to build richer rationales.

## Known limitations

- **HTL is not auto-edited.** AEM CS components are full Sling models — a syntactic edit can break `data-sly-*` semantics, Sling resolution, or component dialogs. The mapper emits a best-guess path and stops.
- **AEM CS source-mapping + publish is verified; clientlib *rebuild* is not.** The end-to-end path — pull the `cm` repo (`source-fetch --site-id`), resolve selectors→files, reconcile a git-applicable diff against the real source, and publish it as a SpaceCat guidance suggestion — is verified live (the law-firm case `/super-claim-check/`, 2026-06-15). What stays out of scope: **rebuilding the `.lc-<hash>` clientlib bundles from source to lab-validate the rebuilt output** — the harness measures the live prod URL, not a locally rebuilt clientlib. So AEM CS fixes ship as guidance + git-applicable diffs for the customer to build/deploy, not as post-rebuild lab-proven patches.
- **Selector grammar is simple.** See the "markup" table above. Complex selectors fall back to manual-review warnings.
- **Ambiguous matches are never auto-applied.** If a selector matches >1 location, all candidates are listed and the operator picks.
- **CDN config is preview-only.** Fastly VCL, CloudFront Functions, Nginx, and Vercel rewrites have incompatible syntaxes — and header changes are operational, not code. The mapper prints a VCL starting point; operators translate.
- **SPAs unsupported.** Next.js / Nuxt / Vue / React-SPA stacks are not fingerprinted and will fall through to `generic`, which will usually miss because the served markup is hydrated at runtime. Use `--stack generic` with eyes open, or skip.
- **No build-tool awareness.** The mapper edits source directly. If the repo has a build step (bundler, templating), operators must re-run it after `--apply`.
- **Backups are per-run.** `--apply` creates `<file>.bak` before touching `<file>`. A second `--apply` would overwrite the first backup. Commit between runs.

## Selector → source resolution (AEM CS) — `selector-resolver.js`

`source-mapper` answers "given a patch, what edit?" — but for an **AEM CS CSS/layout**
fix there is a harder upstream question: *given a runtime selector (a CLS shift-source
from `cls.shiftSources` / chain-rum-correlator C6, e.g. `.cookies__container`), where does
that element live in the repo, how is it styled, and how does a fix actually reach
production?* AEM CS makes this multi-hop, and editing the wrong layer ships a no-op.
`selector-resolver.js` (ROADMAP **G4**) closes that gap.

```
node .agents/scripts/selector-resolver.js \
  --selector '<runtime-selector>' \
  --source   progress/<slug>/source \
  [--md] [--emit <dir>] [--stack aem-cs] [--project <name>]
```

Or as a module: `import { resolveSelector } from './selector-resolver.js'; await resolveSelector({ selector, sourceRoot });`

It runs four stages over the pulled source tree (the one `cwv-source-fetch` extracts):

1. **parse** the runtime selector into a token path;
2. **identify the component** — two reconciled strategies: the *decoration class* (AEM
   wraps each component in `<div class="<nodeName>">`, so a token like `div.t004-cookie`
   names the component) and an *HTL-class grep* of the leaf's **structural** class
   (typography utilities like `.font-lato` are excluded — they match everything). Both
   agree → confidence 0.85; one only → 0.7/0.55; rivals → surfaced as candidates;
3. **trace styling** — inline style (and whether it's Sling-model-driven), the Sling model
   (`data-sly-use.model` FQCN → interface + `impl/<Name>Impl.java`), the authored dialog
   fields (`_cq_dialog`), and whether any **committed** stylesheet has a rule for the
   structural class;
4. **classify base-CSS origin + recommend delivery.**

### Delivery recommendations

| Recommendation        | When                                                                                  | What to do |
|-----------------------|---------------------------------------------------------------------------------------|------------|
| `direct-source-edit`  | the structural class's CSS **is committed** in the repo                               | edit it; the clientlib build ships it |
| `override-clientlib`  | the CSS is **not in git** + build-package/submodule signals (vendor-built)            | ship an override clientlib loaded *after* the vendor styles (`!important` wins); the resolver emits the `.content.xml` / `css.txt` / `css/*.css` scaffold (category `<project>.cwv-fixes`), and `--emit <dir>` writes it |
| `content-dialog` (alt)| the property is authored (dialog field feeds the model)                               | a content change repositions with zero code — but won't change entrance/reflow behaviour |

**Graceful degradation:** when no committed CSS is found *and* the build origin can't be
confirmed, it recommends `override-clientlib` as the safe, reversible default rather than
inventing a source path to edit. It never claims a styling source it can't see.

### Stack detection

`detectStack` is **manifest-aware and channel-first**: it reads the importer's
`.cwv-source-manifest.json`. The code **channel** wins — `aemy` (GitHub = the EDS frontend)
⇒ `aem-eds`, which is what makes **XWalk** resolve correctly: a XWalk site's `deliveryType` is
its *author* stack (often `aem_cs`), but the pulled `aemy` repo is the published EDS frontend
we actually edit. For a `cm`/unknown channel it falls back to `deliveryType`
(`aem_cs`/`aem_ams` → `aem-cs`, `aem_edge` → `aem-eds`) — except an unmistakably-EDS file tree
(`scripts/scripts.js` + `head.html`/`blocks/`) overrides a CS `deliveryType`, since the pulled
repo is ground truth. Its file-tree heuristics are depth-tolerant and recognize the
`jcr_root/apps/` content-package marker — so the deeply-nested importer layout
(`portais/<site>/apps/src/main/content/jcr_root/apps/<project>/…`) is detected correctly. (It
*previously* mis-read as `generic` — a depth-6 walk limit that this work fixed.) The resolver
delegates to `detectStack`, and as a final backstop infers `aem-cs` from the presence of real
`cq:Component` dirs under `/apps/`. Pass `--stack aem-cs` / `--stack aem-eds` to force it.

### Worked example (the news-site case golden case)

`.cookies__container` → component **`t004-cookie`** (`the news-site case/components/content/the news-site case/t004-cookie`,
matching the model's `RESOURCE_TYPE`) → trace: inline `position:fixed` (model-driven) + Sling
model `T004Cookie`/`T004CookieImpl` (emits left/right/top|bottom from authored values) +
authored dialog (`positionProperty`/`marginValue`/`marginLeft`/`marginRight`) + **no committed
CSS** for `.cookies__container` (the base CSS ships in the vendor-built netbiis `.all` package)
→ base-CSS origin **vendor-built** → delivery **`override-clientlib`** (category
`the news-site case.cwv-fixes`), matching the hand-shipped `progress/the news-site case-com-br/fix/clientlib-cwv-fixes/`.

`source-mapper`'s AEM CS `markup` path calls this resolver automatically, so a markup patch's
manual-review note names the actual component + HTL file instead of a guessed path.

## Cross-references

- [`finding-schema.md`](./finding-schema.md) — the Finding object the mapper consumes.
- [`stack-detection.md`](./stack-detection.md) — full fingerprint catalogue.
- [`stacks/aem-eds.md`](../stacks/aem-eds.md) — EDS loading phases, CSS split, block decorators.
- [`stacks/aem-cs.md`](../stacks/aem-cs.md) — clientlib architecture, Dispatcher cache, HTL.
- [`stacks/aem-ams.md`](../stacks/aem-ams.md) — legacy AEM (maps the same as CS for source edits; differs in CDN tooling).
- `.agents/scripts/patches/` — the runtime patch modules whose fragment shapes the mapper consumes.
