/**
 * Template loader - Initializes prompt templates and examples
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promptManager } from './template-engine.js';
import { examplesLibrary } from './examples-library.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load all prompt templates
 */
export function loadPromptTemplates() {
  // Load base agent template
  const baseAgentTemplate = readFileSync(
    join(__dirname, 'templates/base-agent.txt'),
    'utf-8'
  );

  // Register base agent template (v1)
  promptManager.registerTemplate('base-agent', baseAgentTemplate, 'v1');

  // Register agent-specific templates
  registerPSIAgentTemplates();
  registerCoverageAgentTemplates();
  registerHARAgentTemplates();
  registerRUMAgentTemplates();
  registerCrUXAgentTemplates();
  registerCodeAgentTemplates();
  registerPerfObserverAgentTemplates();
  registerHTMLAgentTemplates();

  // Load examples
  loadExamples();

  console.log('✅ Prompt templates loaded');
  console.log(`   - Templates: ${promptManager.listTemplates().length}`);
  console.log(`   - Examples: ${Object.keys(examplesLibrary).reduce((sum, key) => sum + examplesLibrary[key].length, 0)}`);
}

/**
 * Register PSI agent templates
 */
function registerPSIAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to PageSpeed Insights data including:
- Lighthouse audits (20 prioritized audits)
- Performance metrics (LCP, CLS, TBT, FCP, SI, TTI)
- Opportunities with estimated savings
- Diagnostics explaining metric failures

{{> chainOfThought}}

{{> outputSchema}}

## Examples
{{#each examples}}
### Example {{@index}}: {{this.title}}

**Input**: {{this.input}}

**Good Output**:
\`\`\`json
{{this.goodOutput}}
\`\`\`

**Why Good**: {{this.reasoning}}

{{/each}}

## Your Task
Analyze the PSI data below and identify performance issues.

**PSI Data**:
\`\`\`json
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('psi-agent', template, 'v1');
  promptManager.registerExamples('psi-agent', examplesLibrary.psi);
}

/**
 * Register Coverage agent templates
 */
function registerCoverageAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to code coverage data including:
- JavaScript coverage (bytes used vs total)
- CSS coverage (bytes used vs total)
- File-level breakdowns
- Unused code segments

{{#if hasRichData}}
**Enhanced**: Coverage includes byte-level unused code detection and segment analysis.
{{/if}}

{{> chainOfThought}}

{{> outputSchema}}

## Examples
{{#each examples}}
### Example {{@index}}: {{this.title}}

**Input**: {{this.input}}

**Good Output**:
\`\`\`json
{{this.goodOutput}}
\`\`\`

**Why Good**: {{this.reasoning}}

{{/each}}

## Your Task
Analyze the coverage data below and identify unused code that should be removed.

**Coverage Data**:
\`\`\`json
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('coverage-agent', template, 'v1');
  promptManager.registerExamples('coverage-agent', examplesLibrary.coverage);
}

/**
 * Register HAR agent templates
 */
function registerHARAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to HAR (HTTP Archive) data including:
- Request/response timeline
- Resource sizes and types
- Network timing breakdown{{#if hasRichData}} (DNS, TCP, SSL, Wait, Download){{/if}}
- Third-party script detection

{{> chainOfThought}}

{{> outputSchema}}

## Examples
{{#each examples}}
### Example {{@index}}: {{this.title}}

**Input**: {{this.input}}

**Good Output**:
\`\`\`json
{{this.goodOutput}}
\`\`\`

**Why Good**: {{this.reasoning}}

{{/each}}

## Your Task
Analyze the HAR data below and identify network bottlenecks.

**HAR Data**:
\`\`\`json
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('har-agent', template, 'v1');
  promptManager.registerExamples('har-agent', examplesLibrary.har);
}

/**
 * Register RUM agent templates
 */
function registerRUMAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to Real User Monitoring (RUM) data including:
- p75 INP measurements
- Interaction types (click, keydown, etc.)
- Slowest interactions
- Sample sizes for confidence

{{> chainOfThought}}

{{> outputSchema}}

## Examples
{{#each examples}}
### Example {{@index}}: {{this.title}}

**Input**: {{this.input}}

**Good Output**:
\`\`\`json
{{this.goodOutput}}
\`\`\`

**Why Good**: {{this.reasoning}}

{{/each}}

## Your Task
Analyze the RUM data below and identify interaction performance issues.

**RUM Data**:
\`\`\`json
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('rum-agent', template, 'v1');
  promptManager.registerExamples('rum-agent', examplesLibrary.rum);
}

/**
 * Register CrUX agent templates
 */
function registerCrUXAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to Chrome UX Report (CrUX) data including:
- Real user p75 metrics (LCP, CLS, INP, TTFB)
- Origin-level aggregates
- Good/Needs Improvement/Poor distributions

Note: CrUX provides aggregate data without file-level details. Focus on metric-level analysis.

{{> chainOfThought}}

{{> outputSchema}}

## Your Task
Analyze the CrUX data below and identify which metrics fail for real users.

**CrUX Data**:
\`\`\`json
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('crux-agent', template, 'v1');
}

/**
 * Register Code agent templates
 */
function registerCodeAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to first-party source code including:
- Import statements
- Code patterns
- Anti-patterns
- Library usage

{{> chainOfThought}}

{{> outputSchema}}

## Your Task
Review the source code below and identify performance anti-patterns.

**Source Code**:
\`\`\`
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('code-agent', template, 'v1');
}

/**
 * Register Performance Observer agent templates
 */
function registerPerfObserverAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to Performance Observer data including:
- LCP element identification
- CLS source attribution
- Long tasks (LoAF)
- Resource timing

{{> chainOfThought}}

{{> outputSchema}}

## Your Task
Analyze the performance entries below and identify bottlenecks.

**Performance Entries**:
\`\`\`json
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('perfobserver-agent', template, 'v1');
}

/**
 * Register HTML agent templates
 */
function registerHTMLAgentTemplates() {
  const template = `{{> header}}

## Data Available
You have access to HTML document structure including:
- Resource hints (preload, preconnect, dns-prefetch)
- Critical path analysis
- Image attributes (loading, fetchpriority)
- Font loading strategies

{{> chainOfThought}}

{{> outputSchema}}

## Your Task
Analyze the HTML structure below and identify optimization opportunities.

**HTML Document**:
\`\`\`html
{{data}}
\`\`\`

{{> footer}}`;

  promptManager.registerTemplate('html-agent', template, 'v1');
}

/**
 * Load examples into prompt manager
 */
function loadExamples() {
  // Examples already registered in registerXAgentTemplates() calls
  // This function is a placeholder for future dynamic example loading
}

/**
 * Build agent prompt using templates
 * @param {string} agentType - Agent type (psi, coverage, har, etc.)
 * @param {Object} context - Context variables
 * @param {Object} options - Build options
 * @returns {string} Rendered prompt
 */
export function buildAgentPrompt(agentType, context, options = {}) {
  const templateName = `${agentType}-agent`;

  // Set default context values
  const fullContext = {
    agentName: `${agentType.toUpperCase()} Agent`,
    dataSource: getDataSourceName(agentType),
    cms: context.cms || 'aemcs',
    deviceType: context.deviceType || 'mobile',
    hasRichData: context.hasRichData || false,
    expertise: getAgentExpertise(agentType),
    data: context.data || '{}',
    ...context,
  };

  return promptManager.buildPrompt(templateName, fullContext, {
    version: options.version || 'v1',
    maxExamples: options.maxExamples || 2,
  });
}

/**
 * Get data source name for agent type
 * @param {string} agentType - Agent type
 * @returns {string} Data source name
 */
function getDataSourceName(agentType) {
  const names = {
    psi: 'PageSpeed Insights',
    coverage: 'Code Coverage',
    har: 'HTTP Archive (HAR)',
    rum: 'Real User Monitoring (RUM)',
    crux: 'Chrome UX Report (CrUX)',
    code: 'First-Party Source Code',
    perfobserver: 'Performance Observer',
    html: 'HTML Document',
  };

  return names[agentType] || agentType;
}

/**
 * Get agent expertise description
 * @param {string} agentType - Agent type
 * @returns {string} Expertise description
 */
function getAgentExpertise(agentType) {
  const expertise = {
    psi: 'You are an expert at interpreting Lighthouse audits and PSI metrics. You understand how browser rendering works and can trace performance bottlenecks from audit data.',
    coverage: 'You are an expert at analyzing code coverage data. You can identify unused code, understand tree-shaking limitations, and recommend code-splitting strategies.',
    har: 'You are an expert at analyzing network waterfalls. You can identify slow TTFB, large transfers, third-party bottlenecks, and network timing issues.',
    rum: 'You are an expert at interpreting real user data. You understand INP measurement, interaction attribution, and how to identify slow interactions.',
    crux: 'You are an expert at analyzing aggregate field data. You understand p75 metrics, statistical significance, and real user experience analysis.',
    code: 'You are an expert at code review for performance. You can identify anti-patterns, inefficient algorithms, and suggest optimizations.',
    perfobserver: 'You are an expert at analyzing browser performance entries. You can identify LCP elements, CLS sources, long tasks, and resource timing issues.',
    html: 'You are an expert at HTML optimization. You understand resource hints, critical rendering path, font loading strategies, and image optimization.',
  };

  return expertise[agentType] || 'You are a performance analysis expert.';
}
