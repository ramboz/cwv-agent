import {
  getTechnicalContext,
  getCriticalFilteringCriteria,
  PHASE_FOCUS,
  BASELINE_CONTEXT_SECTIONS,
} from './shared.js';

/**
 * Spec components used for every prompt in this module:
 *   - Task: what "done" looks like
 *   - Context: CMS characteristics and phase-relevant optimizations
 *   - Constraints: critical filtering criteria (when a finding is worth reporting)
 *   - Examples / Output: deliverable format (lives in action.js for the final step)
 *
 * The single-shot prompt bundles all phases into one conversation, so it keeps
 * the full technical context. The multi-agent global baseline strips it down to
 * "characteristics" only — each agent layers phase-specific sections on top.
 */

const TASK = `Analyze Core Web Vitals for an AEM website and identify optimization opportunities to hit Google's "good" thresholds:

- Largest Contentful Paint (LCP): under 2.5 seconds
- Cumulative Layout Shift (CLS): under 0.1
- Interaction to Next Paint (INP): under 200ms`;

/**
 * Single-shot system prompt: one agent walks through all 8 phases in a single
 * conversation. Ships the full technical context because every phase runs.
 * @param {String} cms
 * @return {String}
 */
export const initializeSystem = (cms = 'eds') => `
You are a web performance expert. ${TASK}

## Technical Context
${getTechnicalContext(cms)}

## Analysis Process
You perform your analysis in multiple phases:

${PHASE_FOCUS.CRUX(1)}

${PHASE_FOCUS.PSI(2)}

${PHASE_FOCUS.PERF_OBSERVER(3)}

${PHASE_FOCUS.HAR(4)}

${PHASE_FOCUS.HTML(5)}

${PHASE_FOCUS.RULES(6)}

${PHASE_FOCUS.COVERAGE(7)}

${PHASE_FOCUS.CODE_REVIEW(8)}

${getCriticalFilteringCriteria()}

Phase 1 will start with the next message.
`;

/**
 * Multi-agent global baseline: every agent sees this, so keep it to the
 * shared characteristics only. Phase-specific optimization lists and anti-
 * patterns are layered in by each agent's own system prompt.
 * @param {String} cms
 * @return {String}
 */
export function initializeSystemAgents(cms = 'eds') {
  return `You are a web performance expert. ${TASK}

## Platform Context
${getTechnicalContext(cms, BASELINE_CONTEXT_SECTIONS)}

${getCriticalFilteringCriteria()}
`;
}
