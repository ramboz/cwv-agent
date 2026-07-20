---
issue_type: bundling
applicable_flavors: [eds, cs, ams]
risk_tier: medium

required_validation:
  - block_init_order_preserved
  - clientlib_dependency_graph_clear
  - file_size_inventory_built
  - target_template_scope_clear

forbidden_techniques:
  - pattern: '\beval\s*\(|\bnew\s+Function\s*\('
    reason: "Don't use eval/Function to lazy-load code — CSP-hostile and parse-time costs defeat the bundling fix"
  - pattern: 'document\.write\s*\(\s*[''"]<script'
    reason: "Don't use document.write to inject scripts — blocks parser, breaks async/defer semantics"

flavor_overrides:
  cs:
    extra_validation:
      - clientlib_categories_traced
      - templates_using_each_category_known
  ams:
    extra_validation:
      - clientlib_categories_traced
---

# Bundling

> **Risk tier:** medium · **Applies to:** EDS, CS, AMS · **CWV metric:** LCP, TBT

## What this addresses

Large monolithic bundles ship code to every page that only some pages use. Splitting bundles by route or feature reduces what each page parses and executes, improving LCP and TBT.

EDS doesn't have traditional bundling — code is split per-block by design. The fix on EDS is making sure block JS is loaded lazily (not in the head). On CS/AMS, the fix is splitting clientlib categories so a page only includes what it actually uses.

## When to apply / when to skip

**Apply when:**
- A specific bundle (or clientlib category) is identified as oversized for its usage on this page
- Block initialization order is statically traceable (EDS) or the clientlib dependency graph is clear (CS/AMS)
- The split target template is known — splitting a global category by template is the typical move

**Skip when:**
- Splitting requires a build-tool change that's out of scope
- (CS/AMS) Clientlib graph isn't fully traced — risk of breaking dependents is too high
- Site-wide global clientlib is the candidate — blast radius too large for auto-fix; recommend manually-reviewed split

## Recommended approaches

### EDS: block-level lazy loading

```javascript
// Good — heavy feature loads only when block is in viewport
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

### CS/AMS: split a global clientlib by template

```xml
<!-- Before: clientlib-base shipping to every page -->
<!-- jcr_root/.../clientlib-base/.content.xml -->
<jcr:root jcr:primaryType="cq:ClientLibraryFolder"
          categories="[clientlib-base]"/>

<!-- After: split into core + product-specific -->
<!-- jcr_root/.../clientlib-base-core/.content.xml -->
<jcr:root jcr:primaryType="cq:ClientLibraryFolder"
          categories="[clientlib-base-core]"/>

<!-- jcr_root/.../clientlib-product/.content.xml -->
<jcr:root jcr:primaryType="cq:ClientLibraryFolder"
          categories="[clientlib-product]"
          dependencies="[clientlib-base-core]"/>
```

Then update template HTL to include only the categories the template actually uses (e.g. product templates include `clientlib-product`; article templates include `clientlib-base-core` only).

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

### Splitting without verifying init order (EDS)

If `block-A.js` calls a function exported by `utils.js`, and the split causes `block-A.js` to load before `utils.js` is fetched, runtime errors result. Trace the static `import` graph before splitting.

### Splitting a clientlib that other clientlibs `embed` (CS/AMS)

If `clientlib-product` is embedded by `clientlib-checkout`, splitting `clientlib-product` into two categories without updating `clientlib-checkout`'s embed list breaks checkout silently. Always update embedders when splitting.

## Flavor-specific notes

### EDS

Block-level dynamic `import()` is the natural unit. Code splits cleanly per-block by file structure. Verify no inline page script calls into the split code synchronously.

### CS / AMS

Splitting requires `.content.xml` changes for new clientlib categories and HTL updates to include the right categories per template. Build-time the clientlib pipeline aggregates these into `clientlib.css` / `clientlib.js` per category — verify the resulting file-size inventory matches expectations before shipping.
