---
description: Prompt authoring conventions for the template system in src/prompts/
paths:
  - src/prompts/**
---

# Prompt Construction Conventions

## Agent prompts use `createAgentPrompt()`

Never build agent prompt strings by hand. Always go through the template:

```js
// correct
import { createAgentPrompt, formatExamples } from './templates/base-agent-template.js';

export function myAgentPrompt(cms = 'eds') {
  const examples = formatExamples([...]);
  return createAgentPrompt({ agentName, role, dataSource, focusKey, examples });
}

// wrong — bypasses the shared template system
export function myAgentPrompt() {
  return `You are analyzing...${getChainOfThoughtGuidance()}...`;
}
```

## Few-shot examples go in a named const

Extract examples before the function — don't inline them in the `createAgentPrompt()` call:

```js
// correct
const examples = formatExamples([
  { title: '...', input: '...', output: '...' },
]);
return createAgentPrompt({ ..., examples });

// wrong — inline string makes the function unreadable and hard to update
return createAgentPrompt({ ..., examples: `**Example 1: ...**\nInput: ...` });
```

## Shared fragments live in `shared.js`

`PHASE_FOCUS`, `getChainOfThoughtGuidance()`, `getDataPriorityGuidance()`, and `getStructuredOutputFormat()` are the shared components. Import them from `shared.js`; don't copy the content into agent functions.

If the same text appears in two agents' `additionalContext`, it belongs in `shared.js` or `PHASE_FOCUS` — not duplicated.

## CMS context belongs in `contexts/`

CMS-specific knowledge (EDS, AMS, AEMCS) lives in `contexts/` — one file per CMS, exporting a named context string. Don't embed CMS-specific knowledge in agent prompt functions or in `shared.js`.

## `additionalContext` is a last resort

Only use `additionalContext` in `createAgentPrompt()` for content that is genuinely unique to one agent and cannot be abstracted. If two agents need similar additional context, extract it.
