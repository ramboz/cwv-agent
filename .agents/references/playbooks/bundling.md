---
issue_type: bundling
risk_tier: medium

required_validation:
  - block_init_order_preserved
  - bundle_dependency_graph_clear
  - file_size_inventory_built
  - target_template_scope_clear

forbidden_techniques:
  - pattern: '\beval\s*\(|\bnew\s+Function\s*\('
    reason: "Don't use eval/Function to lazy-load code — CSP-hostile and parse-time costs defeat the bundling fix"
  - pattern: 'document\.write\s*\(\s*[''"]<script'
    reason: "Don't use document.write to inject scripts — blocks parser, breaks async/defer semantics"

---

# Bundling

> **Risk tier:** medium · **CWV metric:** LCP, TBT

## What this addresses

Large monolithic bundles ship code to every page that only some pages use. Splitting bundles by route or feature reduces what each page parses and executes, improving LCP and TBT.

Component-based frontends often split code per component by design — there the fix is making sure component JS loads lazily (not in the head). On bundled stacks, the fix is splitting oversized bundles so a page only includes what it actually uses.

## When to apply / when to skip

**Apply when:**
- A specific bundle is identified as oversized for its usage on this page
- Module initialization order is statically traceable and the bundle dependency graph is clear
- The split target template is known — splitting a global category by template is the typical move

**Skip when:**
- Splitting requires a build-tool change that's out of scope
- The bundle dependency graph isn't fully traced — risk of breaking dependents is too high
- A site-wide global bundle is the candidate — blast radius too large for auto-fix; recommend a manually-reviewed split

## Recommended approaches

### Component-level lazy loading

```javascript
// Good — heavy feature loads only when the component is in viewport
export default async function decorate(block) {
  const observer = new IntersectionObserver(async (entries) => {
    if (entries[0].isIntersecting) {
      const { initFeature } = await import('./heavy-feature.js');
      initFeature(block);
      observer.disconnect();
    }
  });
  observer.observe(block);
}
```

Dynamic `import()` puts `heavy-feature.js` in its own chunk that only loads when needed.

## Anti-patterns

### Lazy-loading via `eval`

```javascript
// Bad
const code = await fetch('/heavy-feature.js').then(r => r.text());
eval(code);
```

**Why this is bad:** CSP rejects `eval` by default, parse-time is unbounded, source maps don't work, and DevTools can't debug into the eval'd code. Use dynamic `import()` instead.

### `document.write` for script injection

```html
<!-- Bad -->
<script>document.write('<script src="/heavy-feature.js"><\/script>');</script>
```

**Why this is bad:** `document.write` after the parser has finished is silently ignored. Before that point, it blocks the parser. Either way, a behavior gotcha. Use dynamic `import()` or programmatic `<script>` insertion.

### Splitting without verifying init order

If `block-A.js` calls a function exported by `utils.js`, and the split causes `block-A.js` to load before `utils.js` is fetched, runtime errors result. Trace the static `import` graph before splitting.
