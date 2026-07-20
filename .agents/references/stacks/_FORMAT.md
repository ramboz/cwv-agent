# Stack pack format

`.agents/references/stacks/` holds per-stack knowledge packs. A stack pack
teaches the toolkit what a specific platform owns, where fixes land, and
which generic advice is wrong there. V3 ships one worked example
(`wordpress.md`); add your own by following this format.

## How a stack pack plugs in

1. **Fingerprints** — `topics/stack-detection.md` lists the detection
   heuristics; your pack's doc restates the decisive ones so an agent can
   confirm the match. (`detectStack` in `source-mapper.js` is the code seam —
   a pack may extend it with file-tree fingerprints and edit strategies.)
2. **Playbook applicability** — playbooks may restrict themselves via
   `applicable_stacks: [<name>, ...]` front matter; your pack's stack name is
   the vocabulary those lists use. A playbook that excludes your stack is a
   platform-managed / N/A signal for ownership attribution.
3. **Ownership** — `attribution.js` accepts the stack name via
   `--flavor/--stack` and threads it through `ownership.flavor`.

## Document structure

```markdown
# <Stack name>

## Fingerprints
<the decisive detection signals, from stack-detection.md>

## Who owns each layer
<platform-managed vs site-editable vs CDN: where does a fix land?>

## Where fixes land
<per patch type: preloads / markup / block / headers / CSS — the concrete
file or config location in a typical repo>

## Platform-specific anti-patterns
<generic advice that is wrong on this stack, and why>

## Known CWV patterns
<recurring issue shapes on this stack and the proven fix path>
```

Keep it operational: an agent reads this mid-diagnosis to avoid shipping a
fix to a layer the site owner cannot edit.
