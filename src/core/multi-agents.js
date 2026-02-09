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
    agentOutputSchemaFlat,
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
// Transformer Functions
// ============================================================================
export {
    transformFindingsToSuggestions,
    formatSuggestionsToMarkdown
} from './multi-agents/utils/transformers.js';
