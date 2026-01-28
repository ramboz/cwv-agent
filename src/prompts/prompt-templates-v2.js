/**
 * Prompt templates using LangChain's native ChatPromptTemplate
 * This replaces the custom template engine with LangChain's built-in solution
 */

import { ChatPromptTemplate } from "@langchain/core/prompts";
import { examplesLibrary, getExamples } from './examples-library.js';

/**
 * Format examples for inclusion in prompts
 * @param {Array} examples - Examples array
 * @returns {string} Formatted examples
 */
function formatExamples(examples) {
  return examples
    .map((example, index) => {
      let output = `### Example ${index + 1}: ${example.title}\n\n`;
      output += `**Input**: ${example.input}\n\n`;
      output += `**Good Output**:\n\`\`\`json\n${example.goodOutput}\n\`\`\`\n\n`;
      output += `**Why Good**: ${example.reasoning}\n`;

      if (example.badOutput) {
        output += `\n**Bad Output**:\n\`\`\`json\n${example.badOutput}\n\`\`\`\n`;
        output += `**Why Bad**: ${example.badReasoning}\n`;
      }

      return output;
    })
    .join('\n---\n\n');
}

/**
 * Common prompt sections
 */
const CHAIN_OF_THOUGHT_SECTION = `## Chain-of-Thought Reasoning (MANDATORY)

For EVERY finding, you MUST provide structured reasoning using this 4-step chain:

1. **Observation**: What specific data point did you observe?
   - Be concrete: Include file names, sizes (in KB/MB), timings (in ms)

2. **Diagnosis**: Why is this observation problematic for CWV?

3. **Mechanism**: How does this problem affect the specific metric?

4. **Solution**: Why will your proposed fix address the root cause?`;

const OUTPUT_SCHEMA_SECTION = `## Output Schema

You MUST output valid JSON matching this schema:

\`\`\`json
{
  "findings": [
    {
      "id": "string (unique identifier)",
      "type": "bottleneck | waste | opportunity",
      "metric": "LCP | TBT | CLS | INP | TTFB | FCP",
      "description": "string (human-readable finding)",
      "reasoning": {
        "observation": "string",
        "diagnosis": "string",
        "mechanism": "string",
        "solution": "string"
      },
      "evidence": {
        "source": "string (data source)",
        "reference": "string (specific data point)",
        "confidence": number (0-1)
      },
      "estimatedImpact": {
        "metric": "string",
        "reduction": number,
        "confidence": number (0-1)
      },
      "rootCause": boolean
    }
  ]
}
\`\`\``;

const FOOTER_SECTION = `## Critical Requirements
- Output valid JSON only (no markdown, no commentary)
- Include reasoning for every finding
- Be specific with evidence (file:line, sizes, timings)
- Distinguish root causes from symptoms
- Estimate realistic impacts with confidence scores`;

/**
 * Agent expertise descriptions
 */
const AGENT_EXPERTISE = {
  psi: 'You are an expert at interpreting Lighthouse audits and PSI metrics. You understand how browser rendering works and can trace performance bottlenecks from audit data.',
  coverage: 'You are an expert at analyzing code coverage data. You can identify unused code, understand tree-shaking limitations, and recommend code-splitting strategies.',
  har: 'You are an expert at analyzing network waterfalls. You can identify slow TTFB, large transfers, third-party bottlenecks, and network timing issues.',
  rum: 'You are an expert at interpreting real user data. You understand INP measurement, interaction attribution, and how to identify slow interactions.',
  crux: 'You are an expert at analyzing aggregate field data. You understand p75 metrics, statistical significance, and real user experience analysis.',
  code: 'You are an expert at code review for performance. You can identify anti-patterns, inefficient algorithms, and suggest optimizations.',
  perfobserver: 'You are an expert at analyzing browser performance entries. You can identify LCP elements, CLS sources, long tasks, and resource timing issues.',
  html: 'You are an expert at HTML optimization. You understand resource hints, critical rendering path, font loading strategies, and image optimization.',
};

/**
 * Create PSI agent prompt template
 */
export function createPSIAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a PSI (PageSpeed Insights) Agent analyzing PageSpeed Insights data for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.psi}

## Data Available
You have access to PageSpeed Insights data including:
- Lighthouse audits (20 prioritized audits)
- Performance metrics (LCP, CLS, TBT, FCP, SI, TTI)
- Opportunities with estimated savings
- Diagnostics explaining metric failures

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

## Examples

{examples}

${FOOTER_SECTION}`],
    ["human", `Analyze the PSI data below and identify performance issues.

**PSI Data**:
\`\`\`json
{data}
\`\`\``]
  ]);
}

/**
 * Create Coverage agent prompt template
 */
export function createCoverageAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a Coverage Agent analyzing code coverage data for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.coverage}

## Data Available
You have access to code coverage data including:
- JavaScript coverage (bytes used vs total)
- CSS coverage (bytes used vs total)
- File-level breakdowns
- Unused code segments{hasRichDataNote}

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

## Examples

{examples}

${FOOTER_SECTION}`],
    ["human", `Analyze the coverage data below and identify unused code that should be removed.

**Coverage Data**:
\`\`\`json
{data}
\`\`\``]
  ]);
}

/**
 * Create HAR agent prompt template
 */
export function createHARAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a HAR Agent analyzing HTTP Archive data for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.har}

## Data Available
You have access to HAR (HTTP Archive) data including:
- Request/response timeline
- Resource sizes and types
- Network timing breakdown{hasRichDataNote}
- Third-party script detection

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

## Examples

{examples}

${FOOTER_SECTION}`],
    ["human", `Analyze the HAR data below and identify network bottlenecks.

**HAR Data**:
\`\`\`json
{data}
\`\`\``]
  ]);
}

/**
 * Create RUM agent prompt template
 */
export function createRUMAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a RUM Agent analyzing Real User Monitoring data for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.rum}

## Data Available
You have access to Real User Monitoring (RUM) data including:
- p75 INP measurements
- Interaction types (click, keydown, etc.)
- Slowest interactions
- Sample sizes for confidence

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

## Examples

{examples}

${FOOTER_SECTION}`],
    ["human", `Analyze the RUM data below and identify interaction performance issues.

**RUM Data**:
\`\`\`json
{data}
\`\`\``]
  ]);
}

/**
 * Create CrUX agent prompt template
 */
export function createCrUXAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a CrUX Agent analyzing Chrome UX Report data for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.crux}

## Data Available
You have access to Chrome UX Report (CrUX) data including:
- Real user p75 metrics (LCP, CLS, INP, TTFB)
- Origin-level aggregates
- Good/Needs Improvement/Poor distributions

Note: CrUX provides aggregate data without file-level details. Focus on metric-level analysis.

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

${FOOTER_SECTION}`],
    ["human", `Analyze the CrUX data below and identify which metrics fail for real users.

**CrUX Data**:
\`\`\`json
{data}
\`\`\``]
  ]);
}

/**
 * Create Code agent prompt template
 */
export function createCodeAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a Code Review Agent analyzing first-party source code for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.code}

## Data Available
You have access to first-party source code including:
- Import statements
- Code patterns
- Anti-patterns
- Library usage

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

${FOOTER_SECTION}`],
    ["human", `Review the source code below and identify performance anti-patterns.

**Source Code**:
\`\`\`
{data}
\`\`\``]
  ]);
}

/**
 * Create Performance Observer agent prompt template
 */
export function createPerfObserverAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are a Performance Observer Agent analyzing browser performance entries for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.perfobserver}

## Data Available
You have access to Performance Observer data including:
- LCP element identification
- CLS source attribution
- Long tasks (LoAF)
- Resource timing

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

${FOOTER_SECTION}`],
    ["human", `Analyze the performance entries below and identify bottlenecks.

**Performance Entries**:
\`\`\`json
{data}
\`\`\``]
  ]);
}

/**
 * Create HTML agent prompt template
 */
export function createHTMLAgentTemplate() {
  return ChatPromptTemplate.fromMessages([
    ["system", `You are an HTML Agent analyzing document structure for {cms} on {deviceType}.

## Your Expertise
${AGENT_EXPERTISE.html}

## Data Available
You have access to HTML document structure including:
- Resource hints (preload, preconnect, dns-prefetch)
- Critical path analysis
- Image attributes (loading, fetchpriority)
- Font loading strategies

${CHAIN_OF_THOUGHT_SECTION}

${OUTPUT_SCHEMA_SECTION}

${FOOTER_SECTION}`],
    ["human", `Analyze the HTML structure below and identify optimization opportunities.

**HTML Document**:
\`\`\`html
{data}
\`\`\``]
  ]);
}

/**
 * Template registry
 */
const TEMPLATE_REGISTRY = {
  psi: createPSIAgentTemplate,
  coverage: createCoverageAgentTemplate,
  har: createHARAgentTemplate,
  rum: createRUMAgentTemplate,
  crux: createCrUXAgentTemplate,
  code: createCodeAgentTemplate,
  perfobserver: createPerfObserverAgentTemplate,
  html: createHTMLAgentTemplate,
};

/**
 * Build agent prompt using LangChain templates
 * @param {string} agentType - Agent type (psi, coverage, har, etc.)
 * @param {Object} context - Context variables
 * @param {Object} options - Build options
 * @returns {Promise<string>} Rendered prompt
 */
export async function buildAgentPrompt(agentType, context, options = {}) {
  const templateCreator = TEMPLATE_REGISTRY[agentType];
  if (!templateCreator) {
    throw new Error(`No template found for agent type: ${agentType}`);
  }

  const template = templateCreator();

  // Get relevant examples
  const maxExamples = options.maxExamples || 2;
  const examples = getExamples(agentType, {
    metric: context.metric,
    cms: context.cms,
    hasRichData: context.hasRichData,
  }).slice(0, maxExamples);

  // Format examples
  const formattedExamples = formatExamples(examples);

  // Add hasRichData note if applicable
  const hasRichDataNote = context.hasRichData
    ? ' (DNS, TCP, SSL, Wait, Download)'
    : '';

  // Build full context
  const fullContext = {
    cms: context.cms || 'aemcs',
    deviceType: context.deviceType || 'mobile',
    data: typeof context.data === 'string' ? context.data : JSON.stringify(context.data, null, 2),
    examples: formattedExamples || 'No examples available for this context.',
    hasRichDataNote,
    ...context,
  };

  // Format the prompt
  const formattedPrompt = await template.format(fullContext);

  return formattedPrompt;
}

/**
 * Get template for agent type (for direct LangChain usage)
 * @param {string} agentType - Agent type
 * @returns {ChatPromptTemplate} Template instance
 */
export function getAgentTemplate(agentType) {
  const templateCreator = TEMPLATE_REGISTRY[agentType];
  if (!templateCreator) {
    throw new Error(`No template found for agent type: ${agentType}`);
  }

  return templateCreator();
}

/**
 * List available agent templates
 * @returns {Array<string>} Agent types
 */
export function listTemplates() {
  return Object.keys(TEMPLATE_REGISTRY);
}
