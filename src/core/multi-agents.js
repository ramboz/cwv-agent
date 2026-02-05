/**
 * Multi-Agent System - Barrel Exports
 * 
 * This file serves as the public API for the multi-agent system.
 * Import from this file for backward compatibility.
 */

// ============================================================================
// Zod Schemas
// ============================================================================
export {
    suggestionSchema,
    agentFindingSchema,
    agentOutputSchema,
    qualityMetricsSchema
} from './multi-agents/schemas.js';

// ============================================================================
// Agent System Classes
// ============================================================================
export { Tool, Agent, MultiAgentSystem } from './multi-agents/agent-system.js';

// ============================================================================
// Main Orchestration Functions
// ============================================================================
export { runAgentFlow } from './multi-agents/orchestrator.js';
export { runMultiAgents, generateConditionalAgentConfig } from './multi-agents/suggestions-engine.js';

// ============================================================================
// Helper Functions (from orchestrator)
// ============================================================================
export {
    extractPsiSignals,
    computeHarStats,
    computePerfSignals,
    selectCodeResources,
    getPsiAudit,
    DEFAULT_THRESHOLDS
} from './multi-agents/orchestrator.js';

// ============================================================================
// Parser and Transformer Functions
// ============================================================================
export { extractStructuredSuggestions } from './multi-agents/utils/json-parser.js';
export {
    transformFindingsToSuggestions,
    formatSuggestionsToMarkdown
} from './multi-agents/utils/transformers.js';

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extract markdown portion from LLM output (strips structured data section)
 * @param {string} content - Raw LLM output
 * @return {string} Markdown content without structured data section
 */
export function extractMarkdownSuggestions(content) {
    if (!content || typeof content !== 'string') return '';
    const marker = /\n## STRUCTURED DATA FOR AUTOMATION[\s\S]*$/;
    const idx = content.search(marker);
    if (idx === -1) {
        // No structured section found; return as-is
        return content.trim();
    }
    const md = content.slice(0, idx - 4);
    return md.trim();
}
