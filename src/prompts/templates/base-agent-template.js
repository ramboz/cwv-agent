/**
 * Base template for all agent prompts
 * Provides consistent structure while allowing agent-specific customization
 */

import {
  PHASE_FOCUS,
  getDataPriorityGuidance,
  getChainOfThoughtGuidance,
  getStructuredOutputFormat,
} from '../shared.js';

/**
 * Creates a standardized agent prompt with shared components
 *
 * @param {Object} config - Agent configuration
 * @param {string} config.agentName - Display name (e.g., 'CrUX Agent', 'PSI Agent')
 * @param {string} config.role - Role description for getBasePrompt (e.g., 'analyzing Chrome User Experience Report field data')
 * @param {string} config.dataSource - Data source key for priority guidance (e.g., 'crux', 'psi', 'har')
 * @param {string} config.focusKey - Key in PHASE_FOCUS object (e.g., 'CRUX', 'PSI', 'HAR')
 * @param {string} config.examples - Few-shot examples specific to this agent
 * @param {string} [config.additionalContext] - Optional additional context sections
 * @returns {string} Complete agent prompt
 */
export function createAgentPrompt(config) {
  const {
    agentName,
    role,
    dataSource,
    focusKey,
    examples,
    additionalContext = '',
  } = config;

  return `You are ${role} for Core Web Vitals optimization.

${getDataPriorityGuidance(dataSource)}

${getChainOfThoughtGuidance()}

## Few-Shot Examples

${examples}

${additionalContext ? `${additionalContext}\n\n` : ''}## Your Analysis Focus
${PHASE_FOCUS[focusKey]}

${getStructuredOutputFormat(agentName)}
`;
}

/**
 * Utility function to format a single example
 * Standardizes example formatting across agents
 *
 * @param {Object} example - Example configuration
 * @param {string} example.title - Example title
 * @param {string} example.input - Input description
 * @param {string} example.output - Output description
 * @param {number} [example.number] - Example number (optional)
 * @returns {string} Formatted example
 */
export function formatExample({ title, input, output, number }) {
  const prefix = number ? `**Example ${number}: ${title}**` : `**${title}**`;
  return `${prefix}
Input: ${input}
Output:
${output}`;
}

/**
 * Formats multiple examples with automatic numbering
 *
 * @param {Array<Object>} examples - Array of example objects
 * @returns {string} All examples formatted and joined
 */
export function formatExamples(examples) {
  return examples
    .map((example, index) => formatExample({ ...example, number: index + 1 }))
    .join('\n\n');
}
