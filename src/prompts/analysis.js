import { estimateTokenSize } from '../utils.js';
import { getTechnicalContext, PHASE_FOCUS } from './shared.js';

// Counter for tracking analysis steps
let stepCounter = 0;

/**
 * Resets the step counter to zero
 */
export function resetStepCounter() {
  stepCounter = 0;
}

function step() {
  stepCounter += 1;
  return stepCounter;
}

/**
 * Helper function to generate phase transition text
 * @returns {string} Phase transition text with incremented step number
 */
function stepVerbose() {
   const n = step();
   if (n === 1) {
      return 'Starting with phase 1,';
   }
   return `Continuing with phase ${n},`;
}

/**
 * Prompt for CrUX data analysis
 * @param {Object} crux - CrUX data object
 * @returns {string} CrUX analysis prompt
 */
export const cruxStep = (crux) => `
${stepVerbose()} here is the detailed CrUX data for the page (in JSON format):

${JSON.stringify(crux, null, 2)}
`;

/**
 * Prompt for CrUX summary analysis
 * @param {string} cruxSummary - CrUX summary text
 * @returns {string} CrUX summary analysis prompt
 */
export const cruxSummaryStep = (cruxSummary) => `
${stepVerbose()} here is the summarized CrUX data for the page:

${cruxSummary}
`;

/**
 * Prompt for PSI analysis
 * @param {Object} psi - PSI data object
 * @returns {string} PSI analysis prompt
 */
export const psiStep = (psi) => `
${stepVerbose()} here is the full PSI audit in JSON for the page load.

${JSON.stringify(psi, null, 2)}
`;

/**
 * Prompt for PSI summary analysis
 * @param {string} psiSummary - PSI summary text
 * @returns {string} PSI summary analysis prompt
 */
export const psiSummaryStep = (psiSummary) => `
${stepVerbose()} here is the summarized PSI audit for the page load.

${psiSummary}
`;

/**
 * Prompt for HAR analysis
 * @param {Object} har - HAR data object
 * @returns {string} HAR analysis prompt
 */
export const harStep = (har) => `
${stepVerbose()} here is the HAR JSON object for the page:

${JSON.stringify(har, null, 2)}
`;

/**
 * Prompt for HAR summary analysis
 * @param {string} harSummary - HAR summary text
 * @returns {string} HAR summary analysis prompt
 */
export const harSummaryStep = (harSummary) => `
${stepVerbose()} here is the summarized HAR data for the page:

${harSummary}
`;

/**
 * Prompt for performance entries analysis
 * @param {Object} perfEntries - Performance entries object
 * @returns {string} Performance entries analysis prompt
 */
export const perfStep = (perfEntries) => `
${stepVerbose()} here are the performance entries for the page:

${JSON.stringify(perfEntries, null, 2)}
`;

/**
 * Prompt for performance entries summary analysis
 * @param {string} perfEntriesSummary - Performance entries summary text
 * @returns {string} Performance entries summary analysis prompt
 */
export const perfSummaryStep = (perfEntriesSummary) => `
${stepVerbose()} here are summarized performance entries for the page load:

${perfEntriesSummary}
`;

/**
 * Prompt for HTML markup analysis
 * @param {string} pageUrl - URL of the page
 * @param {Object} resources - Resources object containing HTML content
 * @returns {string} HTML markup analysis prompt
 */
export const htmlStep = (pageUrl, resourcesOrHtml) => `
${stepVerbose()} here is the HTML markup for the page:

${typeof resourcesOrHtml === 'string' ? resourcesOrHtml : resourcesOrHtml?.[pageUrl]}
`;

/**
 * Prompt for rule analysis
 * @param {string} rules - Rule summary text
 * @returns {string} Rule analysis prompt
 */
export const rulesStep = (rules) => `
${stepVerbose()} here is the set of custom rules that failed for the page:

${rules}
`;

/**
 * Prompt for code analysis
 * @param {string} pageUrl - URL of the page
 * @param {Object} resources - Resources object containing code files
 * @param {number} threshold - Maximum token size to include (default: 100,000)
 * @returns {string} Code analysis prompt
 */
export const codeStep = (pageUrl, resources, threshold = 100_000) => {
  try {
    const html = resources[pageUrl];
    const code = Object.entries(resources)
       .filter(([key]) => key !== pageUrl)
       .filter(([key]) => !html || html.includes((new URL(key)).pathname) || key.match(/(lazy-styles.css|fonts.css|delayed.js)/))
       .filter(([,value]) => estimateTokenSize(value) < threshold) // do not bloat context with too large files
       .map(([key, value]) => `// File: ${key}\n${value}\n\n`).join('\n');
    return `
${stepVerbose()} here are the source codes for the important files on the page (the name for each file is given
to you as a comment before its content):

${code}
`;
  } catch (err) {
    return `Could not collect actual website code.`;
  }
};

/**
 * Prompt for code coverage analysis
 * @param {string} codeCoverage - Code coverage JSON
 * @returns {string} Code coverage analysis prompt
 */
export const coverageStep = (codeCoverage) => `
${stepVerbose()} here is the detailed JSON with code coverage data for the CSS and JS files in the page:

${JSON.stringify(codeCoverage, null, 2)}
`;

/**
 * Prompt for code coverage summary analysis
 * @param {string} codeCoverageSummary - Code coverage summary text
 * @returns {string} Code coverage summary analysis prompt
 */
export const coverageSummaryStep = (codeCoverageSummary) => `
${stepVerbose()} here is the summarized code coverage data for the page:

${codeCoverageSummary}
`;


function getBasePrompt(cms, role) {
  return `You are ${role} for Core Web Vitals optimization.

## Technical Context
${getTechnicalContext(cms)}`;
}

export function cruxAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing Chrome User Experience Report (CrUX) field data')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.CRUX(step())}
`;
}

export function psiAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing PageSpeed Insights/Lighthouse results')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.PSI(step())}
`;
}

export function perfObserverAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing Performance Observer data captured during page load simulation')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.PERF_OBSERVER(step())}
`;
}

export function harAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing HAR (HTTP Archive) file data for Core Web Vitals optimization focused on network performance')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.HAR(step())}
`;
}

export function htmlAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing HTML markup for Core Web Vitals optimization opportunities')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.HTML(step())}
`;
}

export function rulesAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing failed performance rules to identify Core Web Vitals optimization opportunities')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.RULES(step())}
`;
}

export function coverageAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing JavaScript and CSS code coverage data to identify optimization opportunities for Core Web Vitals')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.COVERAGE(step())}
`;
}

export function codeReviewAgentPrompt(cms = 'eds') {
  return `${getBasePrompt(cms, 'analyzing JavaScript and CSS code for Core Web Vitals optimization opportunities, informed by code coverage analysis')}
\n\n## Your Analysis Focus\n${PHASE_FOCUS.CODE_REVIEW(step())}
`;
}
