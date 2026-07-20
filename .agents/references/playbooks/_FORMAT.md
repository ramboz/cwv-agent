# CWV Playbook Format

This directory contains per-issue-type playbooks that the CWV code-fix agent in mystique consumes to constrain its output. Each playbook is a single Markdown file with a YAML front-matter header and a structured prose body.

The format is **single-file per issue type** (not per `type × flavor`). Generic guidance lives in the body; flavor-specific divergence is expressed via the `on_flavors` field on individual rules and the optional `## Flavor-specific notes` section.

For background on why these exist and how they fit into the CWV autofix flow, see the hub doc at [`../e2e-flow.md`](../e2e-flow.md). For the source taxonomy of issue types and risk tiers, see the **CWV Issue Types** document.

---

## File naming

`{issue_type}.md` — kebab-case, matching the issue-type identifier emitted by the audit (e.g. `lcp-image.md`, `font-format.md`, `ttfb.md`).

---

## Front-matter schema

```yaml
---
issue_type: <string>                    # REQUIRED. Matches the file name.
applicable_flavors: [<flavor>, ...]     # REQUIRED. Subset of: eds, cs, ams, headless.
risk_tier: <low|medium|high>            # REQUIRED. Mirrors the CWV Issue Types tier.

required_validation:                     # OPTIONAL. Pre-conditions to check before invoking the agent.
  - <validation_id>
  - <validation_id>

forbidden_techniques:                    # OPTIONAL. Regex post-validators on the agent's diff.
  - pattern: '<regex>'                  #   REQUIRED for each entry. Python re syntax.
    reason: "<short reason>"            #   REQUIRED. Surfaced to the agent on rejection.
    on_flavors: [<flavor>, ...]         #   OPTIONAL. Default: applies to every flavor in applicable_flavors.

see_also:                                # OPTIONAL. Typed cross-references to other playbooks.
  - playbook: <issue_type>              #   REQUIRED. Target issue_type (kebab-case, matches a playbook filename without .md).
    edge: <routes_to|prefer_instead|complements|orthogonal>  # REQUIRED. Exactly one of the four edge types.
    reason: "<short reason>"            #   REQUIRED. Why the two playbooks relate.

flavor_overrides:                        # OPTIONAL. Per-flavor extras (only when divergence exists).
  <flavor>:
    extra_validation:
      - <validation_id>
    extra_forbidden_techniques:
      - pattern: '<regex>'
        reason: "<short reason>"
---
```

### Field-by-field

| Field | Required | Notes |
|---|---|---|
| `issue_type` | yes | String identifier; must match the filename (without `.md`). |
| `applicable_flavors` | yes | List of AEM flavors the playbook applies to. Allowed values: `eds`, `cs`, `ams`, `headless`. Flavors not in the list mean "this issue type is N/A or recommend-only on that flavor" — the loader will not load this playbook for sites of that delivery type. |
| `risk_tier` | yes | One of `low`, `medium`, `high`. Mirrors the CWV Issue Types tier classification. `low` = agent can auto-fix confidently; `medium` = needs validation; `high` = recommendation-only (the agent should NOT emit a code change). |
| `required_validation` | no | Identifiers of pre-conditions that must hold before the agent is invoked. Phase 2 will register handlers for each ID; Phase 1 is documentation only. |
| `forbidden_techniques` | no | Regex patterns that the Phase 2 validator will match against the `+` lines of the agent's unified diff. A match → reject + re-prompt. |
| `see_also` | no | Typed cross-references to other playbooks. Each entry has `playbook` (target `issue_type`, kebab-case, matching a playbook filename without `.md`), `edge` (exactly one of `routes_to`, `prefer_instead`, `complements`, `orthogonal`), and `reason` (a short string). This is the **machine-readable mirror** of the prose body links (authoring guideline #5); a resolver walks these edges with per-edge policy (ADR-0015). Validated by `playbook-see-also-lint.js` — targets must exist and edges must be one of the four types. Cycles are permitted (the resolver is cycle-safe) and reported as warnings, not errors. |
| `flavor_overrides` | no | Per-flavor additions that layer on top of the universal rules. Use sparingly — most rules should be universal. |

### `applicable_flavors` flavor matrix

The `applicable_flavors` list mirrors the CWV Issue Types risk matrix. Some types are deliberately omitted from a flavor:

- **`eds` excluded** when the fix doesn't apply to EDS (e.g. `compression` is platform-managed; `ttfb` is CDN-only with no server-side rendering path; `font-preload` and `resource-preload` rely on a per-page preload that EDS's fixed `head.html` doesn't support).
- **`ams` excluded** when the type is recommend-only on AMS legacy stacks (e.g. `inline-css` and `layout-shift` are too variable in JSP-driven AMS to auto-fix).
- **`headless` excluded** for almost everything — headless renders client-side, so most page-level CWV fixes don't apply.

### `forbidden_techniques` patterns

Patterns are Python `re` regex strings. The Phase 2 validator runs them against text extracted from the `+` lines of the agent's unified diff (additions only — pre-existing forbidden patterns in the customer's codebase are out of scope by construction).

Conventions:

- Use **single quotes** in YAML to avoid escaping backslashes
- Use `\s*` liberally to match whitespace variation; HTML attribute style is not consistent
- Prefer **specific patterns over broad ones**. `'rel\s*=\s*"preload"'` is fine; `'preload'` would false-positive on every legitimate use of the word
- The `reason` field is surfaced verbatim to the agent on rejection — write it as feedback, not as a code comment
- **Patterns must be backtracking-safe.** They run unguarded via `re.search()` against every added line in the diff. A catastrophically backtracking pattern (e.g. `(a+)+$`) on a long line can hang the validator. Keep patterns simple and anchored where possible

Example:

```yaml
forbidden_techniques:
  - pattern: 'Link:\s*<.*>;\s*rel=preload'
    reason: "HTTP Link header preload is not maintainable at site scale"
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"'
    on_flavors: [eds]
    reason: "EDS has a fixed head.html — per-page preload is not feasible"
```

### `see_also` typed cross-references

Playbooks relate to one another in heterogeneous ways: some are routers that
dispatch to a specific fix playbook, some supersede another, some are additive,
and some are entirely orthogonal concerns. Following all of them the same way
would union rules across redirect and orthogonal edges and cause false
rejections (ADR-0015). `see_also` makes each relationship **machine-typed** so a
resolver can apply the right per-edge policy. It is the machine-readable mirror
of the prose body links in authoring guideline #5 — keep the body links for
human readers; `see_also` is the source of truth for tooling.

Each entry names a target `playbook` (the target's `issue_type`, kebab-case,
matching a playbook filename without `.md`), an `edge` type, and a short
`reason`. The four edge types are:

- **`routes_to`** — diagnostic router dispatch. This playbook is a router that,
  for a given root cause, sends you to the target's fix playbook (e.g.
  `layout-shift` → `image-sizing` for an unsized image). The mechanism gate
  unions `required_validation` along `routes_to` edges.
- **`prefer_instead`** — this playbook is superseded/redirected; the **target's**
  rules apply, not this one's (e.g. `font-preload` is superseded by
  `font-fallback` for the common case). Never union `forbidden_techniques`
  across this edge.
- **`complements`** — genuinely additive; **both** fix paths apply together
  (e.g. "pair with `font-preload`"). The forbidden-technique validator may union
  rules along `complements` edges.
- **`orthogonal`** — a different concern that applies only if that path is
  independently taken (e.g. `font-format` is a file-format concern vs.
  `font-fallback`'s swap-time concern). Never union rules across this edge.

Example:

```yaml
see_also:
  - playbook: font-fallback
    edge: prefer_instead
    reason: "font-display: swap + size-adjusted fallback supersedes preload for the common case"
  - playbook: font-format
    edge: orthogonal
    reason: "file-format (WOFF2) concern, independent of the swap-time fix"
  - playbook: resource-hints
    edge: complements
    reason: "pair a font preload with a crossorigin preconnect to the font origin"
```

The `see_also` graph is validated by `.agents/scripts/playbook-see-also-lint.js`
(run via `node --test .agents/scripts/test/playbook-see-also-lint.test.js`):
every `playbook` target must name an existing file, and every `edge` must be one
of the four types. **Cycles are permitted** — the resolver (ADR-0015 §3) walks
the graph with a visited-set, so reciprocal edges (e.g. `font-preload` ⇄
`font-fallback`) are safe. The lint still **detects and reports** cycles as
warnings so authors can see the graph shape, but a cycle does not fail the lint.

---

## Body structure

Every playbook MUST have these sections, in order:

```markdown
# <Issue Type Name>

> **Risk tier:** <tier> · **Applies to:** <flavors> · **CWV metric:** <metric>

## What this addresses

<1–2 sentences: the underlying problem and which CWV metric it targets>

## When to apply / when to skip

**Apply when:**
- <condition>

**Skip when:**
- <condition>

## Recommended approaches

### <Approach name>

<Brief description>

```html
<!-- Good: ... -->
<concrete code example>
```

<Why this works (1–2 sentences)>

## Anti-patterns

### <Anti-pattern name>

```html
<!-- Bad: ... -->
<concrete code example>
```

**Why this is bad:** <1–2 sentences explaining the failure mode>
```

After the four required sections, OPTIONAL flavor-specific sections may follow. Only include them when there's actual divergence:

```markdown
## Flavor-specific notes

### EDS

<EDS-specific guidance, code paths, file locations>

### CS

<CS-specific guidance>

### AMS

<AMS-specific guidance>
```

The Phase 2 loader will strip flavor sections that don't match the site's `delivery_type` before passing the playbook to the agent.

---

## Authoring guidelines

1. **Concrete code examples beat abstract rules.** Every "Recommended" and "Anti-pattern" entry should include real HTML / CSS / JS / config snippets, not just descriptions.
2. **Anti-patterns are the highest-leverage content.** Tell the agent what NOT to do and WHY. The "why" prevents the agent from rationalizing its way back into the bad pattern under edge cases.
3. **Keep universal content universal.** If a recommendation works on all `applicable_flavors`, put it in the main body — not the flavor section. Only use `## Flavor-specific notes` when the implementation surface genuinely differs (e.g. EDS block JS vs. AEM clientlibs).
4. **Use the PDF as the source of truth for `required_validation` IDs.** Each playbook's `required_validation` list should mirror the "Validation before emitting fix" bullets in the CWV Issue Types document. New validation IDs are introduced here first, then registered as handlers in Phase 2.
5. **Cross-reference shared mechanisms.** If two playbooks (e.g. `image-sizing` and `layout-shift`) share a fix path, link from one to the other rather than duplicating content. Add a typed `see_also` front-matter entry alongside the prose link (see [`see_also` typed cross-references](#see_also-typed-cross-references)) — the body link is for humans, `see_also` is the machine source of truth.

---

## Phase 1 vs Phase 2

This directory ships in **Phase 1 — authoring only**. The playbooks are human-readable references right now and will be programmatically loaded once **Phase 2** delivers:

- A loader that parses the YAML front matter and strips non-matching `## Flavor-specific notes` sections
- A validator that runs `forbidden_techniques` regexes against the `+` lines of the agent's diff and rejects + re-prompts on match
- Wiring into `app/agents/cwv/cwv_code_fix_flow.py` and `app/tasks/generate_cwv_code_fix_task.py`

Until Phase 2 lands, the format is a contract for authors — not yet enforced by code.
