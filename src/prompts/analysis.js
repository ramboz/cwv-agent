import { estimateTokenSize } from '../utils.js';
import { getTechnicalContext, PHASE_CONTEXT, PHASE_FOCUS } from './shared.js';

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

// ---------------------------------------------------------------------------
// Step prompts (human messages that deliver a data payload for a given phase)
//
// Each phase hands the agent a labelled input. The analysis task itself is
// carried by the matching agent system prompt (multi-agent flow) or by the
// initializeSystem walkthrough (single-shot flow). Keep the step prompts as
// pure data-delivery — don't restate the task here, or the multishot flow
// will start analysing before all inputs are loaded.
// ---------------------------------------------------------------------------

/**
 * Prompt for CrUX data analysis
 * @param {Object} crux - CrUX data object
 * @returns {string} CrUX analysis prompt
 */
export const cruxStep = (crux) => `
${stepVerbose()} CrUX field data for the page (JSON):

${JSON.stringify(crux, null, 2)}
`;

/**
 * Prompt for CrUX summary analysis
 * @param {string} cruxSummary - CrUX summary text
 * @returns {string} CrUX summary analysis prompt
 */
export const cruxSummaryStep = (cruxSummary) => `
${stepVerbose()} CrUX field data summary for the page:

${cruxSummary}
`;

/**
 * Prompt for PSI analysis
 * @param {Object} psi - PSI data object
 * @returns {string} PSI analysis prompt
 */
export const psiStep = (psi) => `
${stepVerbose()} full PSI/Lighthouse audit for the page load (JSON):

${JSON.stringify(psi, null, 2)}
`;

/**
 * Prompt for PSI summary analysis
 * @param {string} psiSummary - PSI summary text
 * @returns {string} PSI summary analysis prompt
 */
export const psiSummaryStep = (psiSummary) => `
${stepVerbose()} PSI/Lighthouse audit summary for the page load:

${psiSummary}
`;

/**
 * Prompt for HAR analysis
 * @param {Object} har - HAR data object
 * @returns {string} HAR analysis prompt
 */
export const harStep = (har) => `
${stepVerbose()} HAR network waterfall for the page (JSON):

${JSON.stringify(har, null, 2)}
`;

/**
 * Prompt for HAR summary analysis
 * @param {string} harSummary - HAR summary text
 * @returns {string} HAR summary analysis prompt
 */
export const harSummaryStep = (harSummary) => `
${stepVerbose()} HAR network waterfall summary for the page:

${harSummary}
`;

/**
 * Prompt for performance entries analysis
 * @param {Object} perfEntries - Performance entries object
 * @returns {string} Performance entries analysis prompt
 */
export const perfStep = (perfEntries) => `
${stepVerbose()} PerformanceObserver entries captured during page load:

${JSON.stringify(perfEntries, null, 2)}
`;

/**
 * Prompt for performance entries summary analysis
 * @param {string} perfEntriesSummary - Performance entries summary text
 * @returns {string} Performance entries summary analysis prompt
 */
export const perfSummaryStep = (perfEntriesSummary) => `
${stepVerbose()} PerformanceObserver entries summary for the page load:

${perfEntriesSummary}
`;

/**
 * Prompt for HTML markup analysis
 * @param {string} pageUrl - URL of the page
 * @param {Object} resources - Resources object containing HTML content
 * @returns {string} HTML markup analysis prompt
 */
export const htmlStep = (pageUrl, resourcesOrHtml) => `
${stepVerbose()} HTML markup for the page:

${typeof resourcesOrHtml === 'string' ? resourcesOrHtml : resourcesOrHtml?.[pageUrl]}
`;

/**
 * Prompt for rule analysis
 * @param {string} rules - Rule summary text
 * @returns {string} Rule analysis prompt
 */
export const rulesStep = (rules) => `
${stepVerbose()} set of custom performance rules that failed for the page:

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
${stepVerbose()} source code for the important files on the page (each file is preceded by a "// File: <url>" comment):

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
${stepVerbose()} code coverage data for the CSS and JS files on the page (JSON):

${JSON.stringify(codeCoverage, null, 2)}
`;

/**
 * Prompt for code coverage summary analysis
 * @param {string} codeCoverageSummary - Code coverage summary text
 * @returns {string} Code coverage summary analysis prompt
 */
export const coverageSummaryStep = (codeCoverageSummary) => `
${stepVerbose()} code coverage summary for the page:

${codeCoverageSummary}
`;

// ---------------------------------------------------------------------------
// Agent prompts (system messages for the multi-agent flow)
//
// Every agent already receives the shared baseline (CMS characteristics +
// filtering criteria) via initializeSystemAgents. These prompts only layer
// phase-specific optimization context on top, so an agent that doesn't need
// (e.g.) INP advice never sees the INP section.
// ---------------------------------------------------------------------------

/**
 * @param {Object} spec
 * @param {String} spec.cms
 * @param {String} spec.role - one-line description of the agent's job
 * @param {String[]} spec.sections - phase-specific context sections to include
 * @param {String} spec.focus - phase focus bullets (from PHASE_FOCUS)
 * @return {String}
 */
function buildAgentPrompt({ cms, role, sections, focus }) {
  const context = sections.length > 0 ? getTechnicalContext(cms, sections) : '';
  const contextBlock = context ? `\n\n## Phase-Specific Context\n${context}` : '';
  return `You are ${role} for Core Web Vitals optimization.${contextBlock}

## Your Analysis Focus
${focus}
`;
}

export function cruxAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing Chrome User Experience Report (CrUX) field data',
    sections: PHASE_CONTEXT.crux,
    focus: PHASE_FOCUS.CRUX(step()),
  });
}

export function psiAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing PageSpeed Insights/Lighthouse results',
    sections: PHASE_CONTEXT.psi,
    focus: PHASE_FOCUS.PSI(step()),
  });
}

export function perfObserverAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing Performance Observer data captured during page load simulation',
    sections: PHASE_CONTEXT.perfObserver,
    focus: PHASE_FOCUS.PERF_OBSERVER(step()),
  });
}

export function harAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing HAR (HTTP Archive) network waterfall data',
    sections: PHASE_CONTEXT.har,
    focus: PHASE_FOCUS.HAR(step()),
  });
}

export function htmlAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing the rendered HTML markup',
    sections: PHASE_CONTEXT.html,
    focus: PHASE_FOCUS.HTML(step()),
  });
}

export function rulesAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing failed custom performance rules',
    sections: PHASE_CONTEXT.rules,
    focus: PHASE_FOCUS.RULES(step()),
  });
}

export function coverageAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'analyzing JavaScript and CSS code coverage data',
    sections: PHASE_CONTEXT.coverage,
    focus: PHASE_FOCUS.COVERAGE(step()),
  });
}

export function codeReviewAgentPrompt(cms = 'eds') {
  return buildAgentPrompt({
    cms,
    role: 'reviewing JavaScript and CSS source code, informed by the code coverage findings',
    sections: PHASE_CONTEXT.codeReview,
    focus: PHASE_FOCUS.CODE_REVIEW(step()),
  });
}
