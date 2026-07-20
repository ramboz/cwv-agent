---
issue_type: request-chain
risk_tier: medium

required_validation:
  - chain_mapped_to_specific_calls
  - reordering_safe_per_dependency_graph
  - bundle_dependency_graph_clear

forbidden_techniques:
  - pattern: '<link\s+[^>]*rel\s*=\s*"preload"[^>]*>\s*<link\s+[^>]*rel\s*=\s*"preload"[^>]*>\s*<link\s+[^>]*rel\s*=\s*"preload"[^>]*>\s*<link\s+[^>]*rel\s*=\s*"preload"[^>]*>'
    reason: "Don't preload more than ~3 chained resources to flatten a chain — preload bandwidth is finite, focus on the LCP-blocking links only"

see_also:
  - playbook: resource-preload
    edge: routes_to
    reason: "router dispatch — the canonical preload mechanism for the 1-2 LCP-blocking links in the chain"
  - playbook: third-party
    edge: routes_to
    reason: "router dispatch — chains dictated by third-party tag managers are fixed via split / defer / gate"
  - playbook: resource-hints
    edge: complements
    reason: "when a chain link involves a cross-origin handshake, preconnect to that origin (LCP-critical-chain gate)"
  - playbook: bundling
    edge: complements
    reason: "splitting an oversized bundle often shortens the chain as a side effect"

---

# Request chain

> **Risk tier:** medium · **CWV metric:** LCP, FCP

## What this addresses

A request chain is a serial dependency: the browser can't request resource B until it has finished loading resource A. Long chains delay LCP because each link waits on the previous.

This playbook is a **router** — it covers the diagnosis (recognizing a deep waterfall, mapping the chain to code points) and dispatches to the right mechanism playbook for the actual fix:

| Root cause of the chain | Fix path |
|---|---|
| **Discoverable resource arrives late** in the document → browser doesn't preload it | [`resource-preload.md`](./resource-preload.md) — the canonical preload mechanism (correct `as=`, `crossorigin`, URL stability) |
| **JS-driven serial fetch chain** (handlers awaiting one fetch before kicking off the next) | Inline below — Promise.all parallelization |
| **Build-time bundle dependency graph** (bundles chained via declared dependencies) | Inline below — dependency reordering |
| **Configuration / data fetched late by JS** that could be inlined | Inline below — inline-the-trigger pattern |
| **Chain is dictated by external services** (third-party tag manager → analytics) | [`third-party.md`](./third-party.md) — defer / split / gate |

Lighthouse calls this audit ["Minimize critical request depth"](https://developer.chrome.com/docs/lighthouse/performance/critical-request-chains) — the goal is not just shorter chains but shallower depth (fewer serial dependencies between root HTML and the LCP element).

## When to apply / when to skip

**Apply when:**
- Lighthouse "critical request chains" identifies a specific chain feeding the LCP element
- The chain can be mapped to specific code points (loader calls or declared bundle dependencies)
- Reordering is safe per the dependency graph (no init-order breakage)

**Skip when:**
- Chain is dictated by external services (third-party tag manager → analytics → events) — different fix path, see [`third-party.md`](./third-party.md)
- The bundle dependency graph isn't fully traced — risk of init-order breakage too high

## Recommended approaches

### Preload an LCP-blocking link in the chain → [`resource-preload.md`](./resource-preload.md)

The most common fix for a long chain is to preload the one or two LCP-blocking links so they fetch in parallel with HTML parse instead of waiting on the chain. **Defer the mechanism — `as=` value, `crossorigin` for cross-origin, URL stability — to [`resource-preload.md`](./resource-preload.md).** That playbook is the canonical home for preload syntax and pitfalls.

This playbook's contribution is the *diagnosis*: after mapping the Lighthouse waterfall to code points, decide *which* 1–2 links to preload (the ones directly gating LCP), and emit the patch via the resource-preload contract. Don't preload the entire chain — see anti-patterns below.

### Reorder the chain by inlining or moving the trigger

If the chain is `HTML → CSS → JS that fetches a config → renders LCP`, inlining the config as a `<script type="application/json">` removes one link entirely (no preload needed):

```html
<!-- Good — config inlined, removing a chain link -->
<script type="application/json" id="page-config">{"hero":"...","cta":"..."}</script>
```

This is preferable to preload when the data is small (≤14KB) and stable across requests — it eliminates the chain link rather than just hinting it earlier.

### Parallelize otherwise-serial fetches

When two resources have no actual ordering dependency but happen to load serially (e.g. both fired from a JS handler that awaits the first before kicking off the second), kick them off in parallel:

```javascript
// Bad — serial fetch chain
const config = await fetch('/api/config').then(r => r.json());
const content = await fetch('/api/content').then(r => r.json());
render(config, content);

// Good — parallel fetches
const [config, content] = await Promise.all([
  fetch('/api/config').then(r => r.json()),
  fetch('/api/content').then(r => r.json()),
]);
render(config, content);
```

Same pattern at the `<link>` level: if both resources are statically discoverable, they should be in `<head>` rather than discovered via JS one after the other.

### Preloading every resource in the chain

```html
<!-- Bad — 6 preloads for a 6-link chain -->
<link rel="preload" href="/styles/main.css" as="style">
<link rel="preload" href="/scripts/utils.js" as="script">
<link rel="preload" href="/scripts/page.js" as="script">
<link rel="preload" href="/api/config.json" as="fetch">
<link rel="preload" href="/api/user.json" as="fetch">
<link rel="preload" href="/api/content.json" as="fetch">
```

**Why this is bad:** Preload bandwidth competes with the actual resources. Preloading 6 things means each gets ~16% of the available bandwidth instead of the LCP-critical resource getting close to 100%. Pick the 1-2 that directly gate LCP.

### Adding a new sequential dependency to "fix" the chain

```javascript
// Bad — adding a new fetch in the critical path "to wait for the right moment"
window.addEventListener('load', async () => {
  await fetch('/api/ready'); // new chain link
  doTheThingThatWasAlreadyChained();
});
```

**Why this is bad:** Adds a new sequential roundtrip to the chain instead of removing one. Always reduce chain length, never add to it.

## Related playbooks

- [`resource-preload.md`](./resource-preload.md) — **the canonical preload mechanism.** This playbook diagnoses long chains and decides *which* link to preload; resource-preload covers *how* to write the preload tag correctly.
- [`resource-hints.md`](./resource-hints.md) — when a chain link involves a cross-origin handshake, preconnect to that origin (only if it's on the LCP critical chain — same gate applies).
- [`third-party.md`](./third-party.md) — chains dictated by third-party tag managers (consent → analytics → events) can't be reordered from this repo; the fix is split / defer / gate via the third-party deferral-safety table.
- [`bundling.md`](./bundling.md) — splitting an oversized bundle often shortens the chain as a side effect.
