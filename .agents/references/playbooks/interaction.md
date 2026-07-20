---
issue_type: interaction
applicable_flavors: [eds, cs, ams]
risk_tier: high

required_validation:
  - runtime_profiling_available
  - interaction_handler_attributed
  - inp_phase_classified

forbidden_techniques:
  - pattern: 'addEventListener\s*\(\s*[''"](?:click|input|keydown)[''"][^,]+,\s*function\s*\([^)]*\)\s*\{[\s\S]{500,}'
    reason: "Don't author massive synchronous handlers (>500 chars body) for input events — break the work up or yield to the main thread"

see_also:
  - playbook: js-execution
    edge: routes_to
    reason: "router dispatch — input-delay INP is driven by long tasks during load (reduce TBT)"
  - playbook: third-party
    edge: routes_to
    reason: "router dispatch — third-party scripts running during interaction cause input delay"
---

# Interaction (INP)

> **Risk tier:** high · **Applies to:** EDS, CS, AMS · **CWV metric:** INP
>
> **⚠️ Recommendation-only across all flavors.** The agent should NOT emit a code change for this issue type without runtime profiling integration. Emit a checklist recommendation surfacing the audit data.

## What this addresses

INP (Interaction to Next Paint) measures the latency from user input (click, tap, keypress) to the next visible frame. A high INP score means the page felt unresponsive at least once during the user's session.

INP is composed of three phases:

| Phase | What it measures |
|---|---|
| **Input delay** | Time from input until the handler runs (main thread busy with other work) |
| **Processing time** | Time inside the handler |
| **Presentation delay** | Time from handler return until the next frame paints |

Each phase has a different fix. Without runtime profiling data, the fix is a guess.

## Why this is recommend-only

INP root cause is **inherently runtime**: which interaction (click on which element), which handler (which function fired), which phase (input delay vs. processing vs. presentation), under what main-thread state. No static analysis path leads to a targeted fix without one of:

- RUM INP attribution data (specific element + handler + duration)
- Long Animation Frame API traces
- CrUX interaction-type segmentation

Until that data is integrated, the agent should emit a **checklist recommendation** that asks the user to capture runtime data, not a code change.

## What the recommendation should say

When the audit emits `interaction` as the issue type, the recommendation surfaced to the user should:

1. State that INP fixes require runtime profiling
2. Suggest enabling RUM (or running a manual trace via Chrome DevTools "Performance Insights")
3. Point at the three phases and example fix paths for each (so the user knows what to look for)
4. Refer to per-phase guidance below — but **do not auto-edit any code**

## When to apply / when to skip

**Apply when:** never (always recommend-only) — until runtime profiling integration ships.

**Skip when:** always — emit a recommendation only.

## Recommended approaches

**None for v1 of this playbook system.** INP fixes require runtime profiling data that isn't currently integrated. The agent should emit a checklist recommendation pointing at the per-phase guidance below; see [Per-phase guidance](#per-phase-guidance-for-the-recommendation-text) for the specific paths a human reviewer should investigate.

## Per-phase guidance (for the recommendation text)

### Input delay (main thread busy)

The main thread was processing other work when the user clicked. The handler fired late. Causes:

- Long tasks during page load (see [`js-execution.md`](./js-execution.md))
- Heavy hydration work on SPAs
- Third-party scripts running during user interaction (see [`third-party.md`](./third-party.md))

**Recommended path:** reduce TBT (block fewer / shorter tasks).

### Processing time (handler is slow)

The handler ran long. Causes:

- Synchronous expensive work in the handler (DOM-wide query, large state update)
- Synchronous network call from the handler

**Recommended path:** break the handler into chunks with `await`, move CPU work to a Worker, debounce noisy events.

### Presentation delay (frame can't paint)

The browser couldn't render the next frame. Causes:

- Massive DOM update in the handler (1000+ nodes)
- Synchronous layout thrashing (`offsetHeight` reads inside a write loop)
- Heavy CSS containment changes

**Recommended path:** batch DOM writes, use `content-visibility` / `contain` for offscreen, move animations to compositor (transform / opacity).

## Anti-patterns

### Massive inline event handlers

```javascript
// Bad — single 600-line click handler
button.addEventListener('click', function() {
  // ... 600 lines of synchronous work ...
});
```

**Why this is bad:** This is the canonical INP regression — every click pays the full processing time. Break into smaller handlers, defer non-critical work, yield to the main thread.

### `setTimeout(fn, 0)` to "yield"

```javascript
// Bad
button.addEventListener('click', () => {
  setTimeout(doExpensiveWork, 0);
});
```

**Why this is bad:** The 0ms timeout still queues a task that runs synchronously when fired. INP attribution still attributes the work to this interaction. Use `scheduler.postTask()` with `priority: 'background'` for genuinely deferrable work, or break the work into chunks.

## Flavor-specific notes

Do not auto-fix interaction issues without runtime profiling data on any flavor — the fix path is a recommendation, never a code change in v1 of this playbook system. Stack-specific places to point the human investigator:

- **EDS:** INP is almost always expensive synchronous work inside a block's `decorate()` — a document-wide `querySelectorAll`, a sync `fetch` awaited during decoration, or a large DOM-construction loop. Recommend scoping `querySelectorAll` to the block root and yielding (`scheduler.yield()` or the project's yield helper) inside long decoration/click handlers.
- **CS / AMS:** legacy jQuery `document.ready` handlers doing hundreds of DOM operations, plus third-party metrics handlers firing first. Recommend patching `dataLayer.push` (and global `load`/`click` listeners) to yield to the main thread before third-party handlers run, and breaking long handlers into chunks.
