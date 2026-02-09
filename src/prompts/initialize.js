import { getTechnicalContext, getCriticalFilteringCriteria, getCommonAnalysisPriorities } from './shared.js';

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

${getCommonAnalysisPriorities()}

${getCriticalFilteringCriteria()}
${dataQualityNotice}`;
}
