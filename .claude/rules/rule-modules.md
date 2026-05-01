---
description: Structural contract for CWV rule modules
paths:
  - src/rules/**
---

# Rule Module Conventions

Each rule module exports a single default `evaluate` function — nothing else.

## Function signature

```js
export default function evaluate({ summary, report, har }) {
  return results; // Array of violation objects
}
```

## Return shape

Only return violations. Never include passing results.

```js
{
  category: string,       // e.g. 'critical-path', 'main-thread', 'cls'
  message: string,        // what was found (specific, measurable)
  recommendation: string, // what to do about it
  passing: false,         // always false — omit passing entries entirely
  url: string,            // resource URL (omit if not applicable)
  time: number,           // timing in ms (omit if not applicable)
  initiator: string,      // from getInitiator() (omit if not applicable)
}
```

## Thresholds — import, never hardcode

```js
// correct
import { CRITICAL_PATH_THRESHOLDS } from '../../config/thresholds.js';
const THRESHOLD = CRITICAL_PATH_THRESHOLDS.THIRD_PARTY_DURATION;

// wrong
const THRESHOLD = 60;
```

If a threshold doesn't exist yet, add it to `src/config/thresholds.js` under the appropriate export group.

## Shared utilities — import from `../shared.js`

```js
import { getSequence, getInitiator } from '../shared.js';
```

Don't re-implement `getSequence` or `getInitiator` locally. If a shared helper is missing, add it to `shared.js`.

## Purity

Rules are pure functions: no side effects, no API calls, no LLM interaction. `console.warn` is acceptable for genuinely unrecoverable input (e.g., malformed URLs that can't be parsed).
