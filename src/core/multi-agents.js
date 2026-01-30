import {ChatPromptTemplate} from '@langchain/core/prompts';
import {RunnableSequence} from '@langchain/core/runnables';
import {StringOutputParser} from '@langchain/core/output_parsers';
import {cacheResults, estimateTokenSize} from '../utils.js';
import { z } from 'zod';
import {
    actionPrompt, codeStep, coverageSummaryStep,
    cruxSummaryStep, harSummaryStep,
    htmlStep, perfSummaryStep,
    psiSummaryStep, rulesStep, rumSummaryStep
} from '../prompts/index.js';
import {HumanMessage, SystemMessage} from '@langchain/core/messages';
import {
    codeReviewAgentPrompt, coverageAgentPrompt,
    cruxAgentPrompt, harAgentPrompt, htmlAgentPrompt,
    perfObserverAgentPrompt, psiAgentPrompt, rulesAgentPrompt,
    initializeSystemAgents,
} from '../prompts/index.js';
import { buildCausalGraph, generateGraphSummary } from './causal-graph-builder.js';
import { AgentGating } from './gating.js';
import { validateFindings, saveValidationResults } from './validator.js';
import { getCrux, getPsi, getRUM, getLabData, getCode } from './collect.js';
import { detectAEMVersion } from '../tools/aem.js';
import merge from '../tools/merge.js';
import { applyRules } from '../tools/rules.js';
import { LLMFactory } from '../models/llm-factory.js';
import { getTokenLimits } from '../models/config.js';

// Import refactored Agent System classes
import { Tool, Agent, MultiAgentSystem } from './multi-agents/agent-system.js';

// Import refactored Orchestration logic
import {
    runAgentFlow as runAgentFlowImpl,
    extractPsiSignals,
    computeHarStats,
    computePerfSignals,
    selectCodeResources,
    getPsiAudit,
    DEFAULT_THRESHOLDS
} from './multi-agents/orchestrator.js';

// Import refactored Suggestions Engine
import {
    runMultiAgents as runMultiAgentsImpl,
    generateConditionalAgentConfig
} from './multi-agents/suggestions-engine.js';

// Import refactored JSON Parser utilities
import { extractStructuredSuggestions as extractStructuredSuggestionsImpl } from './multi-agents/utils/json-parser.js';

// Import refactored Transformer utilities
import {
    transformFindingsToSuggestions as transformFindingsToSuggestionsImpl,
    formatSuggestionsToMarkdown as formatSuggestionsToMarkdownImpl
} from './multi-agents/utils/transformers.js';

// ============================================================================
// BARREL EXPORTS - Public API for backward compatibility
// ============================================================================

// Agent System Classes (from ./multi-agents/agent-system.js)
export { Tool, Agent, MultiAgentSystem };

// Main Orchestration Functions
export { runAgentFlow as runAgentFlowImpl } from './multi-agents/orchestrator.js';
export const runAgentFlow = runAgentFlowImpl;

export { runMultiAgents as runMultiAgentsImpl } from './multi-agents/suggestions-engine.js';
export const runMultiAgents = runMultiAgentsImpl;

// Parser and Transformer Functions
export { extractStructuredSuggestions as extractStructuredSuggestionsImpl } from './multi-agents/utils/json-parser.js';
export const extractStructuredSuggestions = extractStructuredSuggestionsImpl;

export { transformFindingsToSuggestions as transformFindingsToSuggestionsImpl } from './multi-agents/utils/transformers.js';
export const transformFindingsToSuggestions = transformFindingsToSuggestionsImpl;

export { formatSuggestionsToMarkdown as formatSuggestionsToMarkdownImpl } from './multi-agents/utils/transformers.js';
export const formatSuggestionsToMarkdown = formatSuggestionsToMarkdownImpl;

// Helper Functions (from ./multi-agents/orchestrator.js)
export {
    extractPsiSignals,
    computeHarStats,
    computePerfSignals,
    selectCodeResources,
    getPsiAudit,
    DEFAULT_THRESHOLDS
};

// Conditional Agent Configuration (from ./multi-agents/suggestions-engine.js)
export { generateConditionalAgentConfig };

/** Zod Schema for Structured Suggestions Output (Final synthesis)
 * Note: url and timestamp are NOT included - they are injected from known input values
 * to prevent LLM typos (e.g., "https.www.example.com" instead of "https://www.example.com")
 */
const suggestionSchema = z.object({
    deviceType: z.enum(['mobile', 'desktop']),
    suggestions: z.array(z.object({
        title: z.string().min(1),
        description: z.string().min(1),
        // Solution: Plain language explanation of the fix (required)
        solution: z.string().min(1),
        // Allow either single metric or array of metrics (for multi-metric improvements)
        metric: z.union([
            z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB', 'FCP', 'TTI', 'SI']),
            z.array(z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB', 'FCP', 'TTI', 'SI']))
        ]).optional(),
        priority: z.enum(['High', 'Medium', 'Low']).optional(),
        effort: z.enum(['Easy', 'Medium', 'Hard']).optional(),
        estimatedImpact: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.array(z.string()).optional(),
        codeChanges: z.array(z.object({
            file: z.string(),
            line: z.number().optional(),
            before: z.string().optional(),
            after: z.string().optional()
        })).optional(),
        validationCriteria: z.array(z.string()).optional()
    }))
});

/** Zod Schema for Agent Findings (Phase 1 - Individual Agent Outputs) */
const agentFindingSchema = z.object({
    id: z.string(), // Unique ID for cross-referencing (e.g., "psi-lcp-1")
    type: z.enum(['bottleneck', 'waste', 'opportunity']),
    metric: z.enum(['LCP', 'CLS', 'INP', 'TBT', 'TTFB', 'FCP', 'TTI', 'SI']),
    description: z.string().min(10), // Human-readable finding

    // Evidence structure
    evidence: z.object({
        source: z.string(), // 'psi', 'har', 'coverage', 'perfEntries', 'crux', 'rum', 'code', 'html', 'rules'
        reference: z.string(), // Specific data point (audit name, file:line, timing breakdown, etc.)
        confidence: z.number().min(0).max(1) // 0-1 confidence score
    }),

    // Impact estimation
    estimatedImpact: z.object({
        metric: z.string(), // Which metric improves
        reduction: z.number(), // Estimated improvement (ms, score, bytes, etc.)
        confidence: z.number().min(0).max(1), // Confidence in estimate
        calculation: z.string().optional() // Show your work
    }),

    // Causal relationships (for Phase 3 graph building)
    relatedFindings: z.array(z.string()).optional(), // IDs of related findings
    rootCause: z.boolean(), // true = root cause, false = symptom

    // Chain-of-thought reasoning (Phase 2 will populate)
    reasoning: z.object({
        symptom: z.string(), // What is observed
        rootCauseHypothesis: z.string(), // Why it occurs
        evidenceSupport: z.string(), // How evidence supports hypothesis
        impactRationale: z.string() // Why this impact estimate
    }).optional()
});

const agentOutputSchema = z.object({
    agentName: z.string(),
    findings: z.array(agentFindingSchema),
    metadata: z.object({
        executionTime: z.number(),
        dataSourcesUsed: z.array(z.string()),
        coverageComplete: z.boolean() // Did agent examine all relevant data?
    })
});

/** Quality Metrics Schema (Phase 1 - Track Suggestion Quality) */
const qualityMetricsSchema = z.object({
    runId: z.string(),
    timestamp: z.string(),
    url: z.string(),
    deviceType: z.string(),
    model: z.string(),

    // Finding counts
    totalFindings: z.number(),
    findingsByType: z.object({
        bottleneck: z.number(),
        waste: z.number(),
        opportunity: z.number()
    }),
    findingsByMetric: z.object({
        LCP: z.number(),
        CLS: z.number(),
        INP: z.number(),
        TBT: z.number(),
        TTFB: z.number(),
        FCP: z.number(),
        TTI: z.number().optional(),
        SI: z.number().optional()
    }),

    // Evidence quality
    averageConfidence: z.number(),
    withConcreteReference: z.number(), // Ratio (0-1) with specific data references
    withImpactEstimate: z.number(), // Ratio (0-1) with quantified impact

    // Root cause analysis
    rootCauseCount: z.number(),
    rootCauseRatio: z.number(), // Ratio (0-1) marked as root cause vs symptoms

    // Agent performance
    agentExecutionTimes: z.record(z.number()),
    totalExecutionTime: z.number(),

    // Coverage completeness
    agentCoverageComplete: z.record(z.boolean()),

    // Validation (Phase 4 will populate)
    validationStatus: z.object({
        passed: z.boolean(),
        issueCount: z.number(),
        blockedCount: z.number()
    }).optional()
});

// Export Zod Schemas (used by refactored modules)
export {
    suggestionSchema,
    agentFindingSchema,
    agentOutputSchema,
    qualityMetricsSchema
};

// Tool, Agent, and MultiAgentSystem classes moved to ./multi-agents/agent-system.js
// and re-exported above for backward compatibility

/** Utility Functions */

// isPromptValid moved to ./multi-agents/suggestions-engine.js


function extractMarkdownSuggestions(content) {
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

// transformFindingsToSuggestions and formatSuggestionsToMarkdown moved to ./multi-agents/utils/transformers.js
// Re-exported above (lines 52-69) for backward compatibility

// extractStructuredSuggestions moved to ./multi-agents/utils/json-parser.js
// Re-exported above for backward compatibility

/**
 * Collect quality metrics from agent findings (Phase 1)
 * @param {Array} agentOutputs - Array of agent output objects with findings
 * @param {string} pageUrl - URL being analyzed
 * @param {string} deviceType - Device type (mobile/desktop)
 * @param {string} model - Model name used
 * @returns {Object} Quality metrics object
 */
function collectQualityMetrics(agentOutputs, pageUrl, deviceType, model) {
    // Extract all findings from all agents
    const allFindings = agentOutputs.flatMap(output => {
        // Handle both old format (string output) and new format (structured findings)
        if (output.findings && Array.isArray(output.findings)) {
            return output.findings;
        }
        return [];
    });

    // If no structured findings yet, return minimal metrics
    if (allFindings.length === 0) {
        return {
            runId: generateRunId(),
            timestamp: new Date().toISOString(),
            url: pageUrl,
            deviceType,
            model,
            totalFindings: 0,
            findingsByType: { bottleneck: 0, waste: 0, opportunity: 0 },
            findingsByMetric: { LCP: 0, CLS: 0, INP: 0, TBT: 0, TTFB: 0, FCP: 0, TTI: 0, SI: 0 },
            averageConfidence: 0,
            withConcreteReference: 0,
            withImpactEstimate: 0,
            rootCauseCount: 0,
            rootCauseRatio: 0,
            agentExecutionTimes: {},
            totalExecutionTime: 0,
            agentCoverageComplete: {}
        };
    }

    // Calculate metrics
    const metrics = {
        runId: generateRunId(),
        timestamp: new Date().toISOString(),
        url: pageUrl,
        deviceType,
        model,

        totalFindings: allFindings.length,
        findingsByType: {
            bottleneck: allFindings.filter(f => f.type === 'bottleneck').length,
            waste: allFindings.filter(f => f.type === 'waste').length,
            opportunity: allFindings.filter(f => f.type === 'opportunity').length
        },
        findingsByMetric: {
            LCP: allFindings.filter(f => f.metric === 'LCP').length,
            CLS: allFindings.filter(f => f.metric === 'CLS').length,
            INP: allFindings.filter(f => f.metric === 'INP').length,
            TBT: allFindings.filter(f => f.metric === 'TBT').length,
            TTFB: allFindings.filter(f => f.metric === 'TTFB').length,
            FCP: allFindings.filter(f => f.metric === 'FCP').length,
            TTI: allFindings.filter(f => f.metric === 'TTI').length,
            SI: allFindings.filter(f => f.metric === 'SI').length
        },

        averageConfidence: allFindings.reduce((sum, f) => sum + (f.evidence?.confidence || 0), 0) / allFindings.length,
        withConcreteReference: allFindings.filter(f => f.evidence?.reference && f.evidence.reference.length > 10).length / allFindings.length,
        withImpactEstimate: allFindings.filter(f => f.estimatedImpact?.reduction && f.estimatedImpact.reduction > 0).length / allFindings.length,

        rootCauseCount: allFindings.filter(f => f.rootCause === true).length,
        rootCauseRatio: allFindings.filter(f => f.rootCause === true).length / allFindings.length,

        agentExecutionTimes: Object.fromEntries(
            agentOutputs
                .filter(a => a.metadata?.executionTime)
                .map(a => [a.agentName, a.metadata.executionTime])
        ),
        totalExecutionTime: agentOutputs
            .filter(a => a.metadata?.executionTime)
            .reduce((sum, a) => sum + a.metadata.executionTime, 0),

        agentCoverageComplete: Object.fromEntries(
            agentOutputs
                .filter(a => a.metadata?.coverageComplete !== undefined)
                .map(a => [a.agentName, a.metadata.coverageComplete])
        )
    };

    // Validate with Zod schema (logs warnings but doesn't block)
    try {
        qualityMetricsSchema.parse(metrics);
    } catch (zodError) {
        console.warn('Multi-agent: Quality metrics schema validation failed:', zodError.errors);
    }

    // Save metrics alongside suggestions
    try {
        cacheResults(pageUrl, deviceType, 'quality-metrics', metrics, '', model);
    } catch (error) {
        console.warn('Failed to cache quality metrics:', error.message);
    }

    return metrics;
}

/**
 * Generate unique run ID for tracking
 * @returns {string} Unique run ID
 */
function generateRunId() {
    return `run-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Conditional Utilities */
/**
 * Safely extract a Lighthouse audit by id
 * @param {Object} psi
 * @param {String} auditId
 * @return {Object|null}
 */
// Helper functions moved to ./multi-agents/orchestrator.js
// Re-exported above for backward compatibility

// generateConditionalAgentConfig moved to ./multi-agents/suggestions-engine.js

// runMultiAgents function moved to ./multi-agents/suggestions-engine.js
// Re-exported above for backward compatibility

/** Reducer: Schema-first aggregation */
async function reduceAgentOutputs(responses, pageData, llm) {
    try {
        const schemaPrompt = `You are a reducer. Merge the following agent outputs into a compact JSON object.\nSchema:\n{\n  \"url\": string,\n  \"deviceType\": \"mobile\"|\"desktop\",\n  \"timestamp\": string (ISO),\n  \"insights\": [{ \"source\": string, \"text\": string }],\n  \"evidence\": [{ \"type\": string, \"detail\": string }],\n  \"actions\": [{\n    \"title\": string,\n    \"description\": string,\n    \"metric\": \"LCP\"|\"CLS\"|\"INP\"|\"TBT\"|\"TTFB\"|\"CWV\",\n    \"priority\": \"High\"|\"Medium\"|\"Low\",\n    \"effort\": \"Easy\"|\"Medium\"|\"Hard\",\n    \"impact\": string\n  }]\n}\nRules: Be concise; cap insights/actions to top 10 each. Output strictly JSON.`;

        const body = responses.map(r => `### ${r.agent}\n${r.output}`).join('\n\n');
        const prompt = ChatPromptTemplate.fromMessages([
            new SystemMessage(schemaPrompt),
            new HumanMessage(`URL: ${pageData.pageUrl}\nDevice: ${pageData.deviceType}\n\nAgent outputs:\n${body}`)
        ]);
        const baseLLM = llm.getBaseLLM ? llm.getBaseLLM() : llm;
        const chain = RunnableSequence.from([prompt, baseLLM, new StringOutputParser()]);
        const raw = await chain.invoke({});
        const jsonMatch = raw.match(/\{[\s\S]*\}$/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
        const now = new Date().toISOString();
        return {
            url: parsed.url || pageData.pageUrl,
            deviceType: parsed.deviceType || pageData.deviceType,
            timestamp: parsed.timestamp || now,
            insights: Array.isArray(parsed.insights) ? parsed.insights : [],
            evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
            actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        };
    } catch (e) {
        console.warn('Reducer: failed to aggregate structured outputs:', e.message);
        return null;
    }
}

/** High-level Orchestration (Agent Action) */
/**
 * Runs the agent flow (parallel or conditional multi-agent) end-to-end
 * @param {String} pageUrl
 * @param {String} deviceType
 * @param {Object} [options={}]
 * @return {Promise<String>}
 */
// runAgentFlow function moved to ./multi-agents/orchestrator.js
// Re-exported above for backward compatibility

// ============================================================================
// Export Utility Functions (still in this file, to be refactored in future phases)
// ============================================================================
export {
    extractMarkdownSuggestions,
    collectQualityMetrics,
    generateRunId,
    reduceAgentOutputs
};
