---
description: Zod schema conventions for Gemini API compatibility
paths:
  - src/core/multi-agents/**
---

# Zod Schema Conventions

These rules apply to schemas passed to Gemini via `withStructuredOutput()`. Violations fail silently — Gemini either rejects the schema or returns malformed output without a clear error message.

## No shared Zod constants across schemas

Zod converts cross-schema references into JSON `$ref`. Gemini does not support `$ref`. Always inline enum definitions:

```js
// correct — inlined in each schema
metric: z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB'])

// wrong — shared constant produces $ref when two schemas reference it
const METRICS_ENUM = z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB']);
// ...later in a different schema...
metric: METRICS_ENUM
```

## No union types

`z.union()` and `z.discriminatedUnion()` generate `anyOf`/`oneOf`, which Gemini rejects. Use `z.array()` for multi-value fields:

```js
// correct
metric: z.array(z.enum(['LCP', 'CLS', 'INP'])).optional()

// wrong
metric: z.union([z.string(), z.array(z.string())])
```

## `withStructuredOutput()` — use `method: 'jsonSchema'`

The camelCase form is required. The underscored form (`'json_schema'`) is the v0.3 API and fails silently:

```js
// correct
model.withStructuredOutput(schema, { method: 'jsonSchema' })

// wrong — v0.3 syntax, silently produces wrong output
model.withStructuredOutput(schema, { method: 'json_schema' })
```

## Scope of these constraints

These constraints apply only to schemas passed to Gemini's `withStructuredOutput()` — currently `suggestionSchema` and `agentFindingSchema` when used directly. Schemas used only for internal validation (e.g., `agentOutputSchema`) are exempt and may reference other schemas.
