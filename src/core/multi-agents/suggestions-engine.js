/**
 * Suggestions Engine
 * Extracted from multi-agents.js for better maintainability
 *
 * Handles:
 * - runMultiAgents: Main multi-agent execution and synthesis
 * - generateConditionalAgentConfig: Conditional agent configuration based on gating
 * - Causal graph integration
 * - Validation and synthesis
 */

import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { cacheResults, estimateTokenSize } from '../../utils.js';
import { actionPrompt } from '../../prompts/index.js';
import {
    codeStep, coverageSummaryStep,
    cruxSummaryStep, harSummaryStep,
    htmlStep, perfSummaryStep,
    psiSummaryStep, rulesStep, rumSummaryStep
} from '../../prompts/index.js';
import {
    codeReviewAgentPrompt, coverageAgentPrompt,
    cruxAgentPrompt, harAgentPrompt, htmlAgentPrompt,
    perfObserverAgentPrompt, psiAgentPrompt, rulesAgentPrompt,
    initializeSystemAgents,
} from '../../prompts/index.js';
import { buildCausalGraph, generateGraphSummary } from '../causal-graph-builder.js';
import { AgentGating } from '../gating.js';
import { validateFindings, saveValidationResults } from '../validator.js';
import { MultiAgentSystem } from './agent-system.js';

// Import helper functions from orchestrator
import {
    extractPsiSignals,
    computeHarStats,
    computePerfSignals,
    DEFAULT_THRESHOLDS
} from './orchestrator.js';

// Import schema from parent module (will be moved to schemas.js in Issue 5)
import { suggestionSchema } from '../multi-agents.js';

// Import transformers from utils module
import {
    transformFindingsToSuggestions,
    formatSuggestionsToMarkdown
} from './utils/transformers.js';

/**
 * Utility: Check if prompt fits within token limits
 */
const isPromptValid = (length, limits) => length <= (limits.input - limits.output) * 0.9;

/**
 * Generate conditional agent configuration based on gating signals
 * @param {Object} pageData - All collected page data
 * @param {string} cms - CMS type (eds, aemcs, ams)
 * @returns {Array} Array of agent configurations
 */
function generateConditionalAgentConfig(pageData, cms) {
    const { psi, har, harSummary, perfEntries, perfEntriesSummary, pageUrl, resources, coverageData, coverageDataSummary, rulesSummary } = pageData;
    const signals = extractPsiSignals(psi);
    const harStats = computeHarStats(har);

    // Device-aware thresholds
    const device = (pageData.deviceType || 'mobile').toLowerCase();
    const TH = DEFAULT_THRESHOLDS[device] || DEFAULT_THRESHOLDS.mobile;

    // Multi-signal gating (include perf pre-LCP signals when available)
    const perfSig = computePerfSignals(perfEntries);

    // UNIFIED GATING: Use new AgentGating class for consistent logic
    const gating = new AgentGating(device);

    // Coverage gating using unified system
    const coverageDecision = gating.shouldRunAgent('coverage', {
        data: {
            unusedBytes: coverageData?.summary?.unusedBytes || 0,
            unusedRatio: (coverageData?.summary?.unusedPercent || 0) / 100
        },
        psi: {
            reduceUnusedJS: signals.reduceUnusedJS,
            renderBlocking: signals.renderBlocking
        }
    });

    // Fallback to legacy logic if no coverage data yet (backward compatibility)
    const coverageSignals = [
        signals.reduceUnusedJS === true,
        (signals.tbt ?? 0) > TH.TBT_MS,
        (signals.lcp ?? 0) > TH.LCP_MS,
        perfSig.hasLongTasksPreLcp === true,
    ];
    const shouldRunCoverage = coverageData?.summary
        ? coverageDecision.shouldRun
        : (perfSig.lcpTimeMs != null
            ? coverageSignals.filter(Boolean).length >= 2
            : coverageSignals.some(Boolean));

    // HAR Agent Gating - Unified logic with lower thresholds
    const harDecision = gating.shouldRunAgent('har', {
        data: {
            entriesCount: harStats.entriesCount,
            transferBytes: harStats.transferBytes
        },
        psi: {
            redirects: signals.redirects,
            serverResponseSlow: signals.serverResponseSlow,
            renderBlocking: signals.renderBlocking
        }
    });

    const shouldRunHar = harDecision.shouldRun;

    // Code agent gating - use legacy logic since resources aren't available at this point
    // (Code is collected earlier in runAgentFlow, before this function is called)
    const codeSignals = [
        shouldRunCoverage,
        signals.reduceUnusedJS === true,
        (signals.tbt ?? 0) > TH.TBT_MS,
        perfSig.hasLongTasksPreLcp === true,
    ];
    const shouldRunCode = perfSig.lcpTimeMs != null
        ? codeSignals.filter(Boolean).length >= 2
        : (shouldRunCoverage || (signals.reduceUnusedJS === true && (signals.tbt ?? 0) > TH.TBT_MS));

    const steps = [];

    // Always-on lightweight agents (use summaries where possible)
    steps.push({ name: 'CrUX Agent', sys: cruxAgentPrompt(cms), hum: cruxSummaryStep(pageData.cruxSummary) });

    // RUM Agent (only if RUM data is available)
    if (pageData.rumSummary) {
        steps.push({ name: 'RUM Agent', sys: cruxAgentPrompt(cms), hum: rumSummaryStep(pageData.rumSummary) });
    }

    steps.push({ name: 'PSI Agent', sys: psiAgentPrompt(cms), hum: psiSummaryStep(pageData.psiSummary) });
    steps.push({ name: 'Perf Observer Agent', sys: perfObserverAgentPrompt(cms), hum: perfSummaryStep(perfEntriesSummary) });
    // Prefer fullHtml when available for correctness; fallback to resources[pageUrl]
    const htmlPayload = pageData.fullHtml || resources;
    steps.push({ name: 'HTML Agent', sys: htmlAgentPrompt(cms), hum: htmlStep(pageUrl, htmlPayload) });
    steps.push({ name: 'Rules Agent', sys: rulesAgentPrompt(cms), hum: rulesStep(rulesSummary) });

    if (shouldRunHar) {
        steps.push({ name: 'HAR Agent', sys: harAgentPrompt(cms), hum: harSummaryStep(harSummary) });
    }

    if (shouldRunCoverage) {
        steps.push({ name: 'Code Coverage Agent', sys: coverageAgentPrompt(cms), hum: coverageSummaryStep(coverageDataSummary || coverageData) });
    }

    if (shouldRunCode) {
        steps.push({ name: 'Code Review Agent', sys: codeReviewAgentPrompt(cms), hum: codeStep(pageUrl, resources, 10_000) });
    }

    // Debug/log the gating outcome so users can see why agent count == N
    const selectedNames = steps.map(s => s.name);
    console.log(`- with → har: ${shouldRunHar}, coverage: ${shouldRunCoverage}, code: ${shouldRunCode}`);
    console.log(`- using ${selectedNames.length} agent(s): ${selectedNames.map((n) => n.replace(' Agent', '')).join(', ')}`);

    return steps.map(({ name, sys, hum }) => ({
        name,
        role: name.replace(/_/g, ' ').replace('agent', '').trim(),
        systemPrompt: sys,
        humanPrompt: hum,
    }));
}

/**
 * Main Multi-Agent Runner
 * Executes conditional agents in parallel, builds causal graph, validates findings, and synthesizes suggestions
 *
 * @param {Object} pageData - All collected page data
 * @param {Object} tokenLimits - Token limits for the LLM
 * @param {Object} llm - LLM instance
 * @param {string} model - Model name
 * @returns {Promise<{markdown: string, structuredData: Object}>}
 */
export async function runMultiAgents(pageData, tokenLimits, llm, model) {
    console.group('Starting multi-agent flow...');
    if (!pageData || !tokenLimits || !llm) {
        console.warn('runMultiAgents: invalid arguments');
        return null;
    }

    let agentsConfig = generateConditionalAgentConfig(pageData, pageData.cms);

    // Validate token budgets (include global init)
    const baseInit = initializeSystemAgents(pageData.cms);
    const baseTokens = estimateTokenSize(baseInit, model);
    agentsConfig = agentsConfig.map((agent) => {
        const tokenLength = baseTokens + estimateTokenSize(agent.systemPrompt, model) + estimateTokenSize(agent.humanPrompt, model);
        if (!isPromptValid(tokenLength, tokenLimits)) {
            // For this conditional flow, humanPrompt is already summarized for heavy artifacts.
        }
        return agent;
    });

    const system = new MultiAgentSystem({ llm, toolsConfig: [], agentsConfig, globalSystemPrompt: initializeSystemAgents(pageData.cms) });
    const tasks = agentsConfig.map(agent => ({ agent: agent.name }));
    const responses = await system.executeParallelTasks(tasks);

    // Phase 1: Collect quality metrics from agent outputs
    // Parse agent outputs to extract structured findings (if present)
    const agentOutputs = responses.map(({ agent, output }) => {
        try {
            // Try to parse as structured JSON output
            const jsonMatch = output.match(/\{[\s\S]*"agentName"[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return parsed;
            }
        } catch (e) {
            // Not JSON or parse failed, return placeholder
        }
        // Return minimal structure for non-JSON agents
        return {
            agentName: agent,
            findings: [],
            metadata: { executionTime: 0, dataSourcesUsed: [], coverageComplete: false }
        };
    });

    // Phase 3: Build causal graph from all findings
    const allFindings = agentOutputs.flatMap(output => {
        if (output.findings && Array.isArray(output.findings)) {
            return output.findings;
        }
        return [];
    });

    let causalGraph = null;
    let graphSummary = '';
    if (allFindings.length > 0) {
        try {
            // Extract current metric values from findings
            const metricsData = {};
            allFindings.forEach(f => {
                if (f.metric && f.estimatedImpact?.metric) {
                    metricsData[f.metric] = f.estimatedImpact.current || 0;
                }
            });

            causalGraph = buildCausalGraph(allFindings, metricsData);
            graphSummary = generateGraphSummary(causalGraph);

            // Save causal graph
            cacheResults(pageData.pageUrl, pageData.deviceType, 'causal-graph', causalGraph, '', model);
        } catch (error) {
            console.warn('Failed to build causal graph:', error.message);
        }
    }

    let result = '';
    let context = '';
    responses.forEach(({ agent, output }, index) => {
        const section = `## Phase ${index + 1} - ${agent}:\n${output}`;
        result += `\n\n${section}`;
        context += `\n${agent}: ${output}`;
    });

    // Add causal graph summary to context for final synthesis
    if (graphSummary) {
        context += `\n\nCausal Graph Analysis:\n${graphSummary}`;
    }

    // Phase 4: Validate findings
    let validatedFindings = allFindings;
    let validationSummary = '';
    let validationResults = null;  // Declare outside try-catch so it's available later
    if (allFindings.length > 0 && causalGraph) {
        try {
            validationResults = validateFindings(allFindings, causalGraph, {
                blockingMode: true,   // Block invalid findings
                adjustMode: true,     // Apply adjustments to questionable findings
                strictMode: false,    // Don't block warnings, only errors
            });

            validatedFindings = [
                ...validationResults.approvedFindings,
                ...validationResults.adjustedFindings,
            ];

            // Save validation results
            saveValidationResults(pageData.pageUrl, pageData.deviceType, validationResults, model);

            // Add validation summary to context
            validationSummary = `\n\nValidation Summary:
- Total findings: ${validationResults.summary.total}
- Approved: ${validationResults.summary.approved}
- Adjusted: ${validationResults.summary.adjusted}
- Blocked: ${validationResults.summary.blocked}
- Average confidence: ${(validationResults.summary.averageConfidence * 100).toFixed(1)}%`;

            context += validationSummary;

            // Update agent outputs to reflect validated findings
            agentOutputs.forEach(output => {
                if (output.findings && Array.isArray(output.findings)) {
                    output.findings = output.findings.filter(f =>
                        validatedFindings.some(vf => vf.id === f.id)
                    );
                }
            });
        } catch (error) {
            console.warn('Failed to validate findings:', error.message);
        }
    }

    // Phase 5: Build graph-enhanced context for synthesis
    let graphEnhancedContext = context;
    let rootCauseImpacts = null; // Declare outside if block so it's available for metadata

    if (causalGraph && causalGraph.rootCauses && causalGraph.rootCauses.length > 0) {
        // Extract root causes and calculate their total impact
        rootCauseImpacts = causalGraph.rootCauses.map(rcId => {
            const node = causalGraph.nodes[rcId];
            if (!node) return null;

            // Calculate total impact: sum of all downstream effects
            const outgoingEdges = causalGraph.edges.filter(e => e.from === rcId);
            const totalImpact = outgoingEdges.reduce((sum, edge) => {
                // Get the impact from the target node
                const targetNode = causalGraph.nodes[edge.to];
                if (targetNode?.metadata?.estimatedImpact?.reduction) {
                    return sum + targetNode.metadata.estimatedImpact.reduction;
                }
                return sum;
            }, 0);

            return {
                id: rcId,
                description: node.description,
                metric: node.metadata?.metric,
                totalImpact,
                affectedFindings: outgoingEdges.length,
                depth: node.depth,
            };
        }).filter(Boolean);

        // Sort by total impact (highest first)
        rootCauseImpacts.sort((a, b) => b.totalImpact - a.totalImpact);

        // Add root cause prioritization to context
        if (rootCauseImpacts.length > 0) {
            graphEnhancedContext += `\n\n## Root Cause Prioritization (from Causal Graph)

The causal graph has identified ${rootCauseImpacts.length} root causes. Focus your recommendations on these fundamental issues:

${rootCauseImpacts.slice(0, 10).map((rc, i) => `
${i + 1}. **${rc.description}**
   - Primary metric: ${rc.metric}
   - Total downstream impact: ${rc.totalImpact > 0 ? `~${Math.round(rc.totalImpact)}ms` : 'multiple metrics'}
   - Affects ${rc.affectedFindings} other finding(s)
   - Graph depth: ${rc.depth} (${rc.depth === 1 ? 'immediate cause' : rc.depth === 2 ? 'fundamental cause' : 'deep root cause'})
`).join('\n')}

**IMPORTANT**: Prioritize suggestions that address these root causes over symptoms. When multiple findings share the same root cause, combine them into a single holistic recommendation.`;
        }
    }

    // Step 1: Generate structured JSON suggestions using withStructuredOutput()
    const finalPrompt = actionPrompt(pageData.pageUrl, pageData.deviceType);
    const baseLLM = llm.getBaseLLM ? llm.getBaseLLM() : llm;

    // Use withStructuredOutput() for guaranteed schema compliance
    const structuredLLM = baseLLM.withStructuredOutput(suggestionSchema);
    const finalChain = RunnableSequence.from([
        ChatPromptTemplate.fromMessages([
            new SystemMessage(finalPrompt),
            new HumanMessage(`Here is the context from previous agents:\n${graphEnhancedContext}`)
        ]),
        structuredLLM
    ]);

    let structuredData;
    try {
        structuredData = await finalChain.invoke({ input: graphEnhancedContext });
        // Inject known metadata (not generated by LLM to avoid typos like "https.example.com")
        structuredData.url = pageData.pageUrl;
        structuredData.timestamp = new Date().toISOString();
        console.log(`✅ Generated ${structuredData.suggestions.length} recommendations`);
    } catch (error) {
        console.error('❌ Failed to generate structured suggestions:', error.message);
        console.warn('⚠️  Falling back to aggregated findings');

        // Fallback: use aggregated findings
        structuredData = {
            url: pageData.pageUrl,
            deviceType: pageData.deviceType,
            timestamp: new Date().toISOString(),
            suggestions: transformFindingsToSuggestions(allFindings)
        };
    }

    // Step 2: Generate markdown from JSON (formatting layer)
    const markdown = formatSuggestionsToMarkdown(structuredData, {
        url: pageData.pageUrl,
        deviceType: pageData.deviceType,
        rootCauseImpacts: rootCauseImpacts, // Pass the computed objects, not the raw ID array
        validationSummary: validationResults?.summary
    });

    console.groupEnd();

    // Return both: JSON is canonical, MD is formatted view
    return {
        markdown,
        structuredData
    };
}

// Export for testing and reuse
export { generateConditionalAgentConfig };
