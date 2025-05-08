import { estimateTokenSize } from '../utils.js';

// Counter for tracking analysis steps
let stepCounter = 0;

/**
 * Resets the step counter to zero
 */
export function resetStepCounter() {
  stepCounter = 0;
}

/**
 * Helper function to generate phase transition text
 * @returns {string} Phase transition text with incremented step number
 */
function step() {
   stepCounter++;
   if (stepCounter === 1) {
      return 'Starting with phase 1,';
   }
   return `Continuing with phase ${stepCounter},`;
}

/**
 * Prompt for CrUX data analysis
 * @param {Object} crux - CrUX data object
 * @returns {string} CrUX analysis prompt
 */
export const cruxStep = (crux) => `
${step()} here is the detailed CrUX data for the page (in JSON format):

${JSON.stringify(crux, null, 2)}
`;

/**
 * Prompt for CrUX summary analysis
 * @param {string} cruxSummary - CrUX summary text
 * @returns {string} CrUX summary analysis prompt
 */
export const cruxSummaryStep = (cruxSummary) => `
${step()} here is the summarized CrUX data for the page:

${cruxSummary}
`;

/**
 * Prompt for PSI analysis
 * @param {Object} psi - PSI data object
 * @returns {string} PSI analysis prompt
 */
export const psiStep = (psi) => `
${step()} here is the full PSI audit in JSON for the page load.

${JSON.stringify(psi, null, 2)}
`;

/**
 * Prompt for PSI summary analysis
 * @param {string} psiSummary - PSI summary text
 * @returns {string} PSI summary analysis prompt
 */
export const psiSummaryStep = (psiSummary) => `
${step()} here is the summarized PSI audit for the page load.

${psiSummary}
`;

/**
 * Prompt for HAR analysis
 * @param {Object} har - HAR data object
 * @returns {string} HAR analysis prompt
 */
export const harStep = (har) => `
${step()} here is the HAR JSON object for the page:

${JSON.stringify(har, null, 2)}
`;

/**
 * Prompt for HAR summary analysis
 * @param {string} harSummary - HAR summary text
 * @returns {string} HAR summary analysis prompt
 */
export const harSummaryStep = (harSummary) => `
${step()} here is the summarized HAR data for the page:

${harSummary}
`;

/**
 * Prompt for performance entries analysis
 * @param {Object} perfEntries - Performance entries object
 * @returns {string} Performance entries analysis prompt
 */
export const perfStep = (perfEntries) => `
${step()} here are the performance entries for the page:

${JSON.stringify(perfEntries, null, 2)}
`;

/**
 * Prompt for performance entries summary analysis
 * @param {string} perfEntriesSummary - Performance entries summary text
 * @returns {string} Performance entries summary analysis prompt
 */
export const perfSummaryStep = (perfEntriesSummary) => `
${step()} here are summarized performance entries for the page load:

${perfEntriesSummary}
`;

/**
 * Prompt for HTML markup analysis
 * @param {string} pageUrl - URL of the page
 * @param {Object} resources - Resources object containing HTML content
 * @returns {string} HTML markup analysis prompt
 */
export const htmlStep = (pageUrl, resources) => `
${step()} here is the HTML markup for the page:

${resources[pageUrl]}
`;

/**
 * Prompt for rule analysis
 * @param {string} rules - Rule summary text
 * @returns {string} Rule analysis prompt
 */
export const rulesStep = (rules) => `
${step()} here is the set of custom rules that failed for the page:

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
${step()} here are the source codes for the important files on the page (the name for each file is given
to you as a comment before its content):

${code}
`;
  } catch (err) {
    return `Could not collect actual website code.`;
  }
}; 