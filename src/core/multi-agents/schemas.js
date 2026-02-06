/**
 * Zod Schemas for Multi-Agent System
 * 
 * Centralized schema definitions for structured LLM outputs
 * and agent communication formats.
 * 
 * IMPORTANT: Do NOT use shared Zod constants (like a shared enum) across schemas.
 * When Zod converts schemas to JSON Schema, shared references become $ref which
 * the Gemini API does not support. Always inline enum definitions.
 */

import { z } from 'zod';

// ============================================================================
// Suggestion Schema - Final synthesis output
// ============================================================================

/**
 * Zod Schema for Structured Suggestions Output (Final synthesis)
 * Note: url and timestamp are NOT included - they are injected from known input values
 * to prevent LLM typos (e.g., "https.www.example.com" instead of "https://www.example.com")
 */
export const suggestionSchema = z.object({
    deviceType: z.enum(['mobile', 'desktop']),
    suggestions: z.array(z.object({
        semanticType: z.string().optional(),
        title: z.string().min(1),
        description: z.string().min(1),
        // Solution: Plain language explanation of the fix (required)
        solution: z.string().min(1),
        // Allow either single metric or array of metrics (for multi-metric improvements)
        // NOTE: Enums are inlined (not shared) to avoid $ref in JSON Schema which Gemini doesn't support
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
        validationCriteria: z.array(z.string()).optional(),
        // Verification instructions for customers to validate fixes
        verification: z.object({
            tool: z.enum(['lighthouse', 'chrome-devtools', 'web-vitals-library', 'crux', 'psi', 'manual']),
            method: z.string().describe('Step-by-step instructions to verify fix'),
            expectedImprovement: z.string().describe('What user should see if fix is successful'),
            acceptanceCriteria: z.string().optional().describe('How to know if fix meets threshold')
        }).optional()
    }))
});

// ============================================================================
// Agent Finding Schema - Individual agent outputs
// ============================================================================

/**
 * Zod Schema for Agent Findings (Phase 1 - Individual Agent Outputs)
 */
export const agentFindingSchema = z.object({
    id: z.string(), // Unique ID for cross-referencing (e.g., "psi-lcp-1")
    type: z.enum(['bottleneck', 'waste', 'opportunity']),
    // NOTE: Enum inlined to avoid $ref in JSON Schema
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

// ============================================================================
// Agent Output Schema - Complete agent response
// ============================================================================

/**
 * NOTE: This schema uses agentFindingSchema which will create a $ref.
 * This is acceptable because agentOutputSchema is NOT used with Gemini's
 * withStructuredOutput() - only suggestionSchema is used that way.
 */
export const agentOutputSchema = z.object({
    agentName: z.string(),
    findings: z.array(agentFindingSchema),
    metadata: z.object({
        executionTime: z.number(),
        dataSourcesUsed: z.array(z.string()),
        coverageComplete: z.boolean() // Did agent examine all relevant data?
    })
});

/**
 * Flat Agent Output Schema - For use with withStructuredOutput()
 *
 * This is identical to agentOutputSchema but with agentFindingSchema inlined
 * to avoid $ref in JSON Schema (which Gemini doesn't support).
 *
 * CRITICAL: This fixes Issue #1 from architectural review - agents now use
 * withStructuredOutput() instead of StringOutputParser() to guarantee valid JSON.
 */
export const agentOutputSchemaFlat = z.object({
    agentName: z.string(),
    findings: z.array(z.object({
        id: z.string(), // Unique ID for cross-referencing (e.g., "psi-lcp-1")
        type: z.enum(['bottleneck', 'waste', 'opportunity']),
        // NOTE: Enum inlined to avoid $ref in JSON Schema
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
    })),
    metadata: z.object({
        executionTime: z.number(),
        dataSourcesUsed: z.array(z.string()),
        coverageComplete: z.boolean() // Did agent examine all relevant data?
    })
});

// ============================================================================
// Quality Metrics Schema - Track suggestion quality
// ============================================================================

/**
 * Quality Metrics Schema (Phase 1 - Track Suggestion Quality)
 */
export const qualityMetricsSchema = z.object({
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
