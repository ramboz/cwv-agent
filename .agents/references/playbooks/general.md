---
issue_type: general
risk_tier: high

required_validation:
  - cannot_classify_to_specific_type

forbidden_techniques: []
---

# General (catch-all)

> **Risk tier:** high · **CWV metric:** any (unclassified)
>
> **⚠️ Recommendation-only.** The agent should NOT emit a code change for `general` issues. Emit a recommendation that surfaces the audit data and asks for manual triage.

## What this addresses

`general` is the catch-all fallback when the suggestion engine can't classify a CWV issue into one of the 17 specific types. It signals that we have evidence of a CWV problem (the metric is bad) but the heuristics couldn't match the symptoms to a known pattern.

## Why this is recommend-only

If we couldn't classify the issue, we don't know what the right fix is. Letting the coding agent loose without a known fix path is exactly the failure mode this playbook system exists to prevent — the agent will pick *some* approach, and there's no playbook backing it. The result is the "runs wild" scenario.

## What the recommendation should say

When the audit emits `general` as the issue type, surface to the user:

1. The CWV metric that's degraded (LCP / CLS / INP / TTFB / FCP)
2. The raw Lighthouse / PSI / RUM data that triggered the suggestion
3. A note that the issue couldn't be auto-classified and needs manual triage
4. A pointer to the 17 specific playbooks so the human can match the symptoms

The recommendation should NOT propose a specific fix path.

## When to apply / when to skip

**Apply when:** never (always recommend-only).

**Skip when:** always — emit a recommendation only, no code change.

## Recommended approaches

**None.** This playbook is recommend-only by design. The agent should not propose any code change for `general` issues.

The recommendation surfaced to the user should describe the symptoms, list the audit data, and point at the 17 specific playbooks for manual triage (see "What to look at during manual triage" below).

## What to look at during manual triage

If a human is reviewing a `general` suggestion, the most useful first checks are:

1. **Lighthouse element attribution** for LCP / CLS — narrows down to a specific element, often re-classifying the issue as `lcp-image`, `image-sizing`, or `layout-shift`
2. **Lighthouse network waterfall** — if the chain is long, the issue is likely `request-chain` or `blocking-resource`
3. **Coverage data** — large unused bytes hint at `unused-code` or `bundling`
4. **Long-task attribution** — if any single task is >50ms, the issue is likely `js-execution`
5. **Server timing headers** — if `Server-Timing` shows a slow component, the issue is likely `ttfb`

If one of those re-classifies the issue, switch to the matching playbook and re-run the suggestion engine.

## Anti-patterns

### Picking a "close enough" playbook and applying its fix

```text
"This looks kinda like an lcp-image issue, let me try fetchpriority=high on every img."
```

**Why this is bad:** The classifier saw symptoms that didn't match `lcp-image`. Forcing the `lcp-image` fix is a guess that may not move the metric (or may regress it). The correct response to `general` is **always** a recommendation, never a code change.

### Auto-improving the classifier from inside the agent

The classifier lives outside this agent. If you're seeing a recurring `general` pattern that should map to a known type, that's signal for the classification team to add a rule — not for the agent to invent one on the fly.
