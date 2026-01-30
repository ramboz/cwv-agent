import { getTechnicalContext, getCriticalFilteringCriteria, getDeliverableFormat, PHASE_FOCUS } from './shared.js';

/**
 * Initialize the system with appropriate CMS context
 * @param {string} cms - The CMS type ('eds', 'cs', or 'ams')
 * @returns {string} System initialization prompt
 */
export const initializeSystem = (cms = 'eds') => `
You are a web performance expert analyzing Core Web Vitals for an AEM website. Your goal is to identify optimization opportunities to achieve Google's "good" thresholds:
 
- Largest Contentful Paint (LCP): under 2.5 seconds
- Cumulative Layout Shift (CLS): under 0.1
- Interaction to Next Paint (INP): under 200ms

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
 * Initial context optimized for multi-agent flow (global system prompt)
 * Includes only CMS technical context, critical filtering criteria,
 * and deliverable/structured JSON instructions to avoid duplication
 * across agent-specific prompts.
 * @param {String} cms
 * @param {Object} dataQuality - Optional data quality information
 * @return {String}
 */
export function initializeSystemAgents(cms = 'eds', dataQuality = null) {
  let dataQualityNotice = '';

  if (dataQuality && dataQuality.issues && dataQuality.issues.length > 0) {
    const errorIssues = dataQuality.issues.filter(i => i.severity === 'error');
    const warningIssues = dataQuality.issues.filter(i => i.severity !== 'error');

    dataQualityNotice = `

## ⚠️ DATA QUALITY NOTICE

The following data sources were unavailable during collection:

${dataQuality.issues.map(issue => `- **${issue.source}**: ${issue.impact}`).join('\n')}

**Important:**
- Adjust your analysis to account for missing data sources
- Only analyze metrics and evidence that are actually available
- Explicitly note in your findings which data limitations affect your recommendations
- Do NOT make assumptions about missing data or suggest fixes that require unavailable metrics
${errorIssues.length > 0 ? '- Some critical data sources failed - analysis may be significantly limited' : ''}
`;
  }

  return `You are a web performance expert analyzing Core Web Vitals for an AEM website.

## Technical Context
${getTechnicalContext(cms)}

${getCriticalFilteringCriteria()}
${dataQualityNotice}`;
}
