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
import { zodToJsonSchema } from 'zod-to-json-schema';
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
    cruxAgentPrompt, rumAgentPrompt, harAgentPrompt, htmlAgentPrompt,
    perfObserverAgentPrompt, psiAgentPrompt, rulesAgentPrompt,
    initializeSystemAgents,
} from '../../prompts/index.js';
import { getFrameworkContext } from '../../prompts/framework-patterns.js';
import { buildCausalGraph, generateGraphSummary, deduplicateFindings } from '../causal-graph-builder.js';
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

// Import schema from dedicated schemas module
import { suggestionSchema } from './schemas.js';

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
    const { psi, har, harSummary, perfEntries, perfEntriesSummary, pageUrl, resources, coverageData, coverageDataSummary, rulesSummary, frameworks } = pageData;
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

    // Extract chain signal from HAR summary
    // HAR summary is already generated at this point (from pageData.harSummary)
    const hasSequentialChains = harSummary &&
        harSummary.includes('Chain depth:') &&
        harSummary.includes('sequential delay:') &&
        // Ensure it's a significant chain (not just "Chain depth: 1")
        /Chain depth: [3-9]|Chain depth: \d{2,}/.test(harSummary);

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
        },
        summary: {
            hasSequentialChains
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

    // Generate framework context for all CWV metrics (agents will use what's relevant)
    const fwContextLCP = frameworks ? getFrameworkContext(frameworks, 'lcp') : '';
    const fwContextINP = frameworks ? getFrameworkContext(frameworks, 'inp') : '';
    const fwContextCLS = frameworks ? getFrameworkContext(frameworks, 'cls') : '';
    const frameworkContext = fwContextLCP + fwContextINP + fwContextCLS;

    const steps = [];

    // Always-on lightweight agents (use summaries where possible)
    steps.push({ name: 'CrUX Agent', sys: cruxAgentPrompt(cms), hum: cruxSummaryStep(pageData.cruxSummary) });

    // RUM Agent (only if RUM data is available) - uses dedicated RUM prompt
    if (pageData.rumSummary) {
        steps.push({ name: 'RUM Agent', sys: rumAgentPrompt(cms), hum: rumSummaryStep(pageData.rumSummary) });
    }

    // PSI Agent - include framework context for CWV optimization guidance
    steps.push({ name: 'PSI Agent', sys: psiAgentPrompt(cms), hum: psiSummaryStep(pageData.psiSummary) + frameworkContext });

    // Perf Observer Agent - include framework context for performance optimization
    steps.push({ name: 'Perf Observer Agent', sys: perfObserverAgentPrompt(cms), hum: perfSummaryStep(perfEntriesSummary) + frameworkContext });

    // Prefer fullHtml when available for correctness; fallback to resources[pageUrl]
    const htmlPayload = pageData.fullHtml || resources;
    steps.push({ name: 'HTML Agent', sys: htmlAgentPrompt(cms), hum: htmlStep(pageUrl, htmlPayload) + frameworkContext });
    steps.push({ name: 'Rules Agent', sys: rulesAgentPrompt(cms), hum: rulesStep(rulesSummary) });

    if (shouldRunHar) {
        steps.push({ name: 'HAR Agent', sys: harAgentPrompt(cms), hum: harSummaryStep(harSummary) });
    }

    if (shouldRunCoverage) {
        // Coverage Agent - include framework context for unused code analysis
        steps.push({ name: 'Code Coverage Agent', sys: coverageAgentPrompt(cms), hum: coverageSummaryStep(coverageDataSummary || coverageData) + frameworkContext });
    }

    if (shouldRunCode) {
        // Code Review Agent - include framework context for code-level optimizations
        steps.push({ name: 'Code Review Agent', sys: codeReviewAgentPrompt(cms), hum: codeStep(pageUrl, resources, 10_000) + frameworkContext });
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
 * Generate light mode agent configuration
 * Light mode uses only lightweight agents and focuses on 3 low-hanging fruit patterns:
 * - Hero image loading (lcp-image)
 * - Custom font optimization (font-format, font-preload)
 * - Image sizing (image-sizing)
 *
 * @param {Object} pageData - All collected page data
 * @param {string} cms - CMS type (eds, aemcs, ams)
 * @returns {Array} Array of agent configurations for light mode
 */
function generateLightModeConfig(pageData, cms) {
    const { psiSummary, perfEntriesSummary, harSummary, fullHtml, fontDataSummary, cruxSummary, pageUrl, resources } = pageData;

    const steps = [];

    // Always-on lightweight agents (no gating in light mode)
    steps.push({ name: 'CrUX Agent', sys: cruxAgentPrompt(cms), hum: cruxSummaryStep(cruxSummary) });
    steps.push({ name: 'PSI Agent', sys: psiAgentPrompt(cms), hum: psiSummaryStep(psiSummary) });

    // Core lightweight agents with light mode focus
    steps.push({
        name: 'HTML Agent',
        sys: htmlAgentPrompt(cms, { lightMode: true }),
        hum: htmlStep(pageUrl, fullHtml || resources)
    });
    steps.push({
        name: 'Performance Observer Agent',
        sys: perfObserverAgentPrompt(cms, { lightMode: true }),
        hum: perfSummaryStep(perfEntriesSummary)
    });
    steps.push({
        name: 'HAR Agent',
        sys: harAgentPrompt(cms, { lightMode: true }),
        hum: harSummaryStep(harSummary)
    });

    console.log(`- Light mode: using ${steps.length} lightweight agents`);
    console.log(`- Focused on: hero images, fonts, image sizing`);

    return steps.map(({ name, sys, hum }) => ({
        name,
        role: name.replace(/_/g, ' ').replace('agent', '').trim(),
        systemPrompt: sys,
        humanPrompt: hum,
    }));
}

/**
 * Check if all Core Web Vitals pass "good" thresholds
 * Returns early exit info if site performs well, null otherwise
 *
 * @param {Object} pageData - All collected page data
 * @returns {Object|null} Early exit result or null to continue
 */
function checkEarlyExit(pageData) {
    // Use CWV "good" thresholds
    const GOOD_THRESHOLDS = {
        LCP: 2500,  // ms
        CLS: 0.1,   // score
        INP: 200,   // ms
        TBT: 200,   // ms (lab proxy for INP)
    };

    // Extract CrUX field metrics (preferred - real user data)
    const crux = pageData.crux?.record?.metrics;
    const cruxLcp = crux?.largest_contentful_paint?.percentiles?.p75;
    const cruxCls = parseFloat(crux?.cumulative_layout_shift?.percentiles?.p75);
    const cruxInp = crux?.interaction_to_next_paint?.percentiles?.p75;

    // Extract PSI lab metrics (fallback)
    const psi = pageData.psi?.data?.lighthouseResult?.audits;
    const psiLcp = psi?.['largest-contentful-paint']?.numericValue;
    const psiCls = psi?.['cumulative-layout-shift']?.numericValue;
    const psiTbt = psi?.['total-blocking-time']?.numericValue;

    // Use field data if available, otherwise lab data
    const lcp = cruxLcp ?? psiLcp;
    const cls = !isNaN(cruxCls) ? cruxCls : psiCls;
    const inp = cruxInp ?? null;
    const tbt = psiTbt ?? null;

    // Check if we have enough data to make a decision
    if (lcp == null && cls == null) {
        return null; // Not enough data, continue with full analysis
    }

    // Check if all available metrics pass "good" thresholds
    const lcpGood = lcp == null || lcp <= GOOD_THRESHOLDS.LCP;
    const clsGood = cls == null || cls <= GOOD_THRESHOLDS.CLS;
    const inpGood = inp == null || inp <= GOOD_THRESHOLDS.INP;
    const tbtGood = tbt == null || tbt <= GOOD_THRESHOLDS.TBT;

    // All core CWV must pass (LCP + CLS + INP/TBT)
    const allMetricsPass = lcpGood && clsGood && (inpGood || tbtGood);

    if (!allMetricsPass) {
        return null; // At least one metric fails, continue with full analysis
    }

    // Site performs well - prepare early exit
    const dataSource = cruxLcp != null ? 'CrUX field data' : 'PSI lab data';
    const metricsReport = [
        lcp != null ? `LCP: ${Math.round(lcp)}ms ✅` : null,
        cls != null ? `CLS: ${cls.toFixed(3)} ✅` : null,
        inp != null ? `INP: ${Math.round(inp)}ms ✅` : (tbt != null ? `TBT: ${Math.round(tbt)}ms ✅` : null),
    ].filter(Boolean).join(', ');

    console.log(`✅ All Core Web Vitals pass "good" thresholds (${dataSource}): ${metricsReport}`);
    console.log('   Skipping deep analysis - site performs well!');

    return {
        markdown: `# Core Web Vitals Analysis Report

**URL**: ${pageData.pageUrl}
**Device**: ${pageData.deviceType}
**Date**: ${new Date().toISOString()}

---

## Summary: Site Performs Well! ✅

All Core Web Vitals meet Google's "good" thresholds based on ${dataSource}:

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
${lcp != null ? `| LCP | ${Math.round(lcp)}ms | ≤2500ms | ✅ Good |\n` : ''}${cls != null ? `| CLS | ${cls.toFixed(3)} | ≤0.1 | ✅ Good |\n` : ''}${inp != null ? `| INP | ${Math.round(inp)}ms | ≤200ms | ✅ Good |\n` : ''}${tbt != null && inp == null ? `| TBT | ${Math.round(tbt)}ms | ≤200ms | ✅ Good |\n` : ''}

**No critical optimization suggestions at this time.**

Consider monitoring these metrics over time to catch any regressions.
`,
        structuredData: {
            url: pageData.pageUrl,
            deviceType: pageData.deviceType,
            timestamp: new Date().toISOString(),
            suggestions: [],
            summary: {
                earlyExit: true,
                reason: 'All Core Web Vitals pass good thresholds',
                dataSource,
                metrics: {
                    lcp: lcp != null ? { value: Math.round(lcp), status: 'good' } : null,
                    cls: cls != null ? { value: cls, status: 'good' } : null,
                    inp: inp != null ? { value: Math.round(inp), status: 'good' } : null,
                    tbt: tbt != null ? { value: Math.round(tbt), status: 'good' } : null,
                },
            },
        },
    };
}

/**
 * Main Multi-Agent Runner
 * Executes conditional agents in parallel, builds causal graph, validates findings, and synthesizes suggestions
 *
 * @param {Object} pageData - All collected page data
 * @param {Object} tokenLimits - Token limits for the LLM
 * @param {Object} llm - LLM instance
 * @param {string} model - Model name
 * @param {Object} options - Additional options (mode: 'light' | 'full')
 * @returns {Promise<{markdown: string, structuredData: Object}>}
 */
export async function runMultiAgents(pageData, tokenLimits, llm, model, options = {}) {
    const { mode = 'full' } = options;

    console.group(`Starting multi-agent flow (mode: ${mode})...`);
    if (!pageData || !tokenLimits || !llm) {
        console.warn('runMultiAgents: invalid arguments');
        return null;
    }

    // Early exit check: Skip expensive analysis if all CWV metrics pass
    const earlyExitResult = checkEarlyExit(pageData);
    if (earlyExitResult) {
        console.groupEnd();
        return earlyExitResult;
    }

    // Choose agent configuration based on mode
    let agentsConfig = mode === 'light'
        ? generateLightModeConfig(pageData, pageData.cms)
        : generateConditionalAgentConfig(pageData, pageData.cms);

    // Validate token budgets and truncate oversized human prompts
    const baseInit = initializeSystemAgents(pageData.cms, pageData.dataQuality);
    const baseTokens = estimateTokenSize(baseInit, model);
    const CHARS_PER_TOKEN = 4; // Conservative estimate for truncation
    const MIN_HUMAN_PROMPT_TOKENS = 200; // Minimum useful human prompt size

    agentsConfig = agentsConfig.map((agent) => {
        const sysTokens = estimateTokenSize(agent.systemPrompt, model);
        const humTokens = estimateTokenSize(agent.humanPrompt, model);
        const totalTokens = baseTokens + sysTokens + humTokens;

        if (isPromptValid(totalTokens, tokenLimits)) {
            return agent; // Within budget
        }

        // Calculate available token budget for human prompt
        const maxInputTokens = Math.floor((tokenLimits.input - tokenLimits.output) * 0.9);
        const availableForHuman = maxInputTokens - baseTokens - sysTokens;

        if (availableForHuman < MIN_HUMAN_PROMPT_TOKENS) {
            // System prompt alone exceeds budget — skip this agent
            console.warn(`⚠️  ${agent.name}: System prompt (${sysTokens} tokens) + base (${baseTokens} tokens) exceeds budget (${maxInputTokens} tokens). Skipping agent.`);
            return null;
        }

        // Truncate human prompt to fit within budget
        const overageTokens = totalTokens - maxInputTokens;
        const charsToTrim = overageTokens * CHARS_PER_TOKEN;
        const truncatedPrompt = agent.humanPrompt.slice(0, agent.humanPrompt.length - charsToTrim);
        const truncatedTokens = estimateTokenSize(truncatedPrompt, model);

        console.warn(`⚠️  ${agent.name}: Prompt exceeded budget by ~${overageTokens} tokens. Truncated human prompt from ${humTokens} → ${truncatedTokens} tokens.`);

        return { ...agent, humanPrompt: truncatedPrompt };
    }).filter(Boolean); // Remove null entries (skipped agents)

    const system = new MultiAgentSystem({ llm, toolsConfig: [], agentsConfig, globalSystemPrompt: initializeSystemAgents(pageData.cms, pageData.dataQuality) });
    const tasks = agentsConfig.map(agent => ({ agent: agent.name }));
    const responses = await system.executeParallelTasks(tasks);

    // Cooldown before synthesis to avoid API burst after batched agent calls
    // Agent batching uses AGENT_BATCH_DELAY between batches (default 2000ms)
    // Last batch has NO delay, so synthesis would fire immediately after
    // This pause reuses the same delay to give Gemini API time to recover
    const SYNTHESIS_COOLDOWN = parseInt(process.env.AGENT_BATCH_DELAY || '2000', 10);
    console.log(`⏳ Waiting ${SYNTHESIS_COOLDOWN / 1000}s before synthesis to avoid API burst...`);
    await new Promise(resolve => setTimeout(resolve, SYNTHESIS_COOLDOWN));

    // Phase 1: Collect quality metrics from agent outputs
    // Parse agent outputs to extract structured findings (if present)
    // Note: responses now contain Result objects from agent system
    const agentOutputs = responses.map(({ agent, result }) => {
        // Check if agent execution failed
        if (result.isErr()) {
            console.warn(`⚠️  Agent ${agent} failed: ${result.error?.message || result.error || 'Unknown error'}`);
            return {
                agentName: agent,
                findings: [],
                metadata: {
                    executionTime: 0,
                    dataSourcesUsed: [],
                    coverageComplete: false,
                    error: result.error?.message || String(result.error) || 'Unknown error'
                }
            };
        }

        // Extract successful output from Result
        // Since Issue #1 fix, agents now use withStructuredOutput() which guarantees valid JSON
        // No need for regex parsing fallback - output is already structured
        const output = result.data;

        // withStructuredOutput() returns the parsed object directly (not a string)
        if (typeof output === 'object' && output !== null) {
            return output;
        }

        // Legacy fallback for backward compatibility (should never happen after Issue #1 fix)
        try {
            const jsonMatch = output.match(/\{[\s\S]*"agentName"[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return parsed;
            }
        } catch (e) {
            console.warn(`⚠️  Agent ${agent} returned unexpected output format:`, e.message);
        }

        // Return minimal structure as last resort
        return {
            agentName: agent,
            findings: [],
            metadata: { executionTime: 0, dataSourcesUsed: [], coverageComplete: false }
        };
    });

    // Phase 3: Build causal graph from all findings
    // Attach agentName to each finding for better tracking
    const rawFindings = agentOutputs.flatMap(output => {
        if (output.findings && Array.isArray(output.findings)) {
            const agentName = output.agentName || 'unknown';
            return output.findings.map(finding => ({
                ...finding,
                agentName: finding.agentName || agentName, // Preserve if already set
            }));
        }
        return [];
    });

    // Phase 3.5: Deterministic deduplication before synthesis
    // Groups findings by file + metric + type to eliminate cross-agent duplicates
    let allFindings = rawFindings;
    let deduplicationResult = null;
    if (rawFindings.length > 0) {
        try {
            deduplicationResult = deduplicateFindings(rawFindings);
            allFindings = deduplicationResult.findings;

            // Log merge groups for debugging (limit to 5 most significant)
            if (deduplicationResult.mergeGroups.length > 0) {
                const sortedGroups = [...deduplicationResult.mergeGroups]
                    .sort((a, b) => b.originalCount - a.originalCount)
                    .slice(0, 5);
                console.log('   Top merged groups:');
                sortedGroups.forEach(g => {
                    const uniqueSources = [...new Set(g.sources)].filter(s => s !== 'unknown');
                    const sourceStr = uniqueSources.length > 0 ? uniqueSources.join(', ') : `${g.sources.length} agents`;
                    console.log(`   - ${g.key}: ${g.originalCount} findings → 1 (from ${sourceStr})`);
                });
                if (deduplicationResult.mergeGroups.length > 5) {
                    console.log(`   ... and ${deduplicationResult.mergeGroups.length - 5} more merge groups`);
                }
            }
        } catch (error) {
            console.warn('Deduplication failed, using raw findings:', error?.message || error || 'Unknown error');
            allFindings = rawFindings;
        }
    }

    let causalGraph = null;
    let graphSummary = '';
    if (allFindings.length > 0) {
        try {
            // Extract current metric values from findings
            const metricsData = {};
            allFindings.forEach(f => {
                if (f.metric && f.estimatedImpact?.metric) {
                    // Handle metric as array (from suggestionSchema) or string (from agentFindingSchema)
                    const metricValue = Array.isArray(f.metric) ? f.metric[0] : f.metric;
                    metricsData[metricValue] = f.estimatedImpact.current || 0;
                }
            });

            causalGraph = buildCausalGraph(allFindings, metricsData);
            graphSummary = generateGraphSummary(causalGraph);

            // Save causal graph
            cacheResults(pageData.pageUrl, pageData.deviceType, 'causal-graph', causalGraph, '', model);
        } catch (error) {
            console.warn('Failed to build causal graph:', error?.message || error || 'Unknown error');
        }
    }

    // Phase 4: Validate findings BEFORE building synthesis context
    // This ensures blocked findings are excluded from what the synthesis LLM sees
    let validatedFindings = allFindings;
    let validationSummary = '';
    let validationResults = null;
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

            // Build validation summary for context
            validationSummary = `\n\nValidation Summary:
- Total findings: ${validationResults.summary.total}
- Approved: ${validationResults.summary.approved}
- Adjusted: ${validationResults.summary.adjusted}
- Blocked: ${validationResults.summary.blocked}
- Average confidence: ${(validationResults.summary.averageConfidence * 100).toFixed(1)}%`;

            // Filter agent outputs to only include validated findings
            agentOutputs.forEach(output => {
                if (output.findings && Array.isArray(output.findings)) {
                    output.findings = output.findings.filter(f =>
                        validatedFindings.some(vf => vf.id === f.id)
                    );
                }
            });
        } catch (error) {
            console.warn('Failed to validate findings:', error?.message || error || 'Unknown error');
        }
    }

    // Build synthesis context AFTER validation so blocked findings are excluded
    // Each agentOutput now contains only approved/adjusted findings
    let context = '';
    agentOutputs.forEach((output, index) => {
        const agentName = output.agentName || `agent_${index}`;
        const findingsJson = JSON.stringify(output.findings, null, 2);
        context += `\n## Phase ${index + 1} - ${agentName}:\n${findingsJson}`;
    });

    // Add causal graph summary to context for final synthesis
    if (graphSummary) {
        context += `\n\nCausal Graph Analysis:\n${graphSummary}`;
    }

    // Append validation summary so synthesis LLM knows what was filtered
    if (validationSummary) {
        context += validationSummary;
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

${rootCauseImpacts.slice(0, 10).map((rc, i) => {
    // Handle metric as array or string
    const metricValue = Array.isArray(rc.metric) ? rc.metric.join('/') : rc.metric;
    return `
${i + 1}. **${rc.description}**
   - Primary metric: ${metricValue}
   - Total downstream impact: ${rc.totalImpact > 0 ? `~${Math.round(rc.totalImpact)}ms` : 'multiple metrics'}
   - Affects ${rc.affectedFindings} other finding(s)
   - Graph depth: ${rc.depth} (${rc.depth === 1 ? 'immediate cause' : rc.depth === 2 ? 'fundamental cause' : 'deep root cause'})
`;
}).join('\n')}

**IMPORTANT**: Prioritize suggestions that address these root causes over symptoms. When multiple findings share the same root cause, combine them into a single holistic recommendation.`;
        }
    }

    // Step 1: Generate structured JSON suggestions using withStructuredOutput()
    const finalPrompt = actionPrompt(pageData.pageUrl, pageData.deviceType, pageData.cms);
    const baseLLM = llm.getBaseLLM ? llm.getBaseLLM() : llm;

    // Debug callback to log raw Gemini API responses
    const debugCallback = {
        onLLMEnd: async (output) => {
            console.log('📊 Raw Gemini synthesis response:', {
                hasContent: !!output.generations?.[0]?.[0],
                generationsCount: output.generations?.length,
                metadata: output.llmOutput,
                outputType: typeof output
            });
        },
        onLLMError: async (error) => {
            console.error('❌ Gemini synthesis API error:', {
                message: error?.message,
                response: error?.response?.data,
                status: error?.response?.status,
                errorType: error?.constructor?.name
            });
        }
    };

    // Convert Zod schema to JSON Schema with dereferenced $defs
    // This fixes Gemini protobuf compatibility (see https://github.com/langchain-ai/langchain-google/issues/659)
    const jsonSchema = zodToJsonSchema(suggestionSchema, { $refStrategy: 'none' });

    // Remove $defs and $schema (Gemini doesn't support them)
    // Error: "Invalid JSON payload received. Unknown name \"$schema\""
    delete jsonSchema.$defs;
    delete jsonSchema.$schema;

    // Use dereferenced schema for structured output
    // v1.0: method must be 'jsonSchema' (camelCase) or 'functionCalling', not 'json_schema'
    const structuredLLM = baseLLM.withStructuredOutput(jsonSchema, {
        method: 'jsonSchema',
        name: 'generate_suggestions'
    });

    const finalChain = RunnableSequence.from([
        ChatPromptTemplate.fromMessages([
            new SystemMessage(finalPrompt),
            new HumanMessage(`Here is the context from previous agents:\n${graphEnhancedContext}`)
        ]),
        structuredLLM
    ]).withConfig({ callbacks: [debugCallback] });

    let structuredData;
    const SYNTHESIS_MAX_RETRIES = 3;
    const SYNTHESIS_RETRY_DELAY = 5000; // 5 seconds
    const originalFindingsCount = allFindings.length;
    let reducedFindings = allFindings;

    for (let attempt = 0; attempt < SYNTHESIS_MAX_RETRIES; attempt++) {
        // If findings were reduced, rebuild the context
        let currentContext = graphEnhancedContext;
        if (reducedFindings.length < originalFindingsCount) {
            // Rebuild context with reduced findings
            const reducedIds = new Set(reducedFindings.map(f => f.id));
            const reducedOutputs = agentOutputs.map(output => ({
                ...output,
                findings: output.findings?.filter(f => reducedIds.has(f.id)) || []
            }));

            currentContext = '';
            reducedOutputs.forEach((output, index) => {
                const agentName = output.agentName || `agent_${index}`;
                const findingsJson = JSON.stringify(output.findings, null, 2);
                currentContext += `\n## Phase ${index + 1} - ${agentName}:\n${findingsJson}`;
            });

            if (graphSummary) {
                currentContext += `\n\nCausal Graph Analysis:\n${graphSummary}`;
            }
            if (validationSummary) {
                currentContext += validationSummary;
            }
        }

        try {
            // Log context size before synthesis attempt
            const contextSize = currentContext.length;
            console.log(`🔍 Synthesis attempt ${attempt + 1}/${SYNTHESIS_MAX_RETRIES} (context: ${contextSize} bytes, ${reducedFindings.length} findings)`);

            // Update the chain with current context
            const currentChain = RunnableSequence.from([
                ChatPromptTemplate.fromMessages([
                    new SystemMessage(finalPrompt),
                    new HumanMessage(`Here is the context from previous agents:\n${currentContext}`)
                ]),
                structuredLLM
            ]).withConfig({ callbacks: [debugCallback] });

            structuredData = await currentChain.invoke({});

            // Validate response structure BEFORE accessing properties
            if (!structuredData) {
                throw new Error('LLM returned null/undefined response');
            }
            if (!structuredData.suggestions) {
                console.error('Invalid LLM response structure:', JSON.stringify(structuredData, null, 2));
                throw new Error('LLM response missing suggestions array');
            }
            if (!Array.isArray(structuredData.suggestions)) {
                console.error('Invalid suggestions type:', typeof structuredData.suggestions);
                throw new Error(`LLM suggestions is not an array: ${typeof structuredData.suggestions}`);
            }

            // NOW safe to access properties
            // Inject known metadata (not generated by LLM to avoid typos like "https.example.com")
            structuredData.url = pageData.pageUrl;
            structuredData.timestamp = new Date().toISOString();
            console.log(`✅ Generated ${structuredData.suggestions.length} recommendations`);

            // Add note if findings were reduced due to token limits
            if (reducedFindings.length < originalFindingsCount) {
                console.log(`⚠️  Note: Synthesis used top ${reducedFindings.length}/${originalFindingsCount} findings (${Math.round((reducedFindings.length/originalFindingsCount)*100)}%) due to output complexity`);
            }

            // Filter suggestions in light mode
            if (mode === 'light') {
                const LIGHT_MODE_TYPES = ['lcp-image', 'font-format', 'font-preload', 'image-sizing'];
                const originalCount = structuredData.suggestions.length;
                structuredData.suggestions = structuredData.suggestions.filter(suggestion => {
                    return suggestion.semanticType && LIGHT_MODE_TYPES.includes(suggestion.semanticType);
                });
                console.log(`🎯 Light mode: Filtered to ${structuredData.suggestions.length}/${originalCount} suggestions (types: ${LIGHT_MODE_TYPES.join(', ')})`);
            }

            // Cache structured suggestions
            await cacheResults(pageData.pageUrl, pageData.deviceType, 'suggestions', structuredData);
            break; // Success — exit retry loop
        } catch (error) {
            const errorMessage = error?.message || String(error ?? 'Unknown error');

            // Cache error details for offline inspection
            try {
                await cacheResults(pageData.pageUrl, pageData.deviceType, 'synthesis-error', {
                    timestamp: new Date().toISOString(),
                    attempt: attempt + 1,
                    errorMessage,
                    errorType: error?.constructor?.name,
                    response: error?.response?.data,
                    stack: error?.stack,
                    findingsCount: allFindings.length,
                    contextSize: JSON.stringify(allFindings).length
                });
            } catch (cacheError) {
                // Ignore caching errors - don't let them interfere with retry logic
            }

            // LangChain/Gemini empty-generation bug: ChatVertexAI.invoke() throws when
            // result.generations[0][0] is undefined (API returned no content).
            // This is transient and worth retrying.
            const isTransient = errorMessage.includes("reading 'message'") ||
                errorMessage.includes('429') ||
                errorMessage.includes('Resource exhausted') ||
                errorMessage.includes('rateLimitExceeded');

            // JSON truncation errors indicate output token limit hit
            const isTruncated = errorMessage.includes('Unterminated string') ||
                errorMessage.includes('Unexpected end of JSON') ||
                errorMessage.includes('Unexpected token') ||
                errorMessage.includes('not valid JSON');

            // If JSON truncated and we have more attempts, reduce context by dropping low-confidence findings
            if (isTruncated && attempt < SYNTHESIS_MAX_RETRIES - 1 && originalFindingsCount > 3) {
                const reductionPercent = 0.2 * (attempt + 1); // 20% per attempt (20%, 40%, 60%)
                const targetCount = Math.max(3, Math.floor(originalFindingsCount * (1 - reductionPercent)));

                // Sort by confidence (descending) - findings without confidence get 0.5
                const sortedFindings = [...allFindings].sort((a, b) =>
                    (b.confidence || 0.5) - (a.confidence || 0.5)
                );

                // Keep top N findings
                reducedFindings = sortedFindings.slice(0, targetCount);

                console.warn(`⚠️  Synthesis failed due to output size. Reducing context: keeping top ${targetCount}/${originalFindingsCount} findings (${Math.round((1-reductionPercent)*100)}% by confidence)`);

                // Retry immediately (no delay needed for size reduction)
                continue;
            }

            if (isTransient && attempt < SYNTHESIS_MAX_RETRIES - 1) {
                const retryDelay = SYNTHESIS_RETRY_DELAY * Math.pow(2, attempt);
                console.warn(`⚠️  Synthesis attempt ${attempt + 1}/${SYNTHESIS_MAX_RETRIES} failed (${errorMessage}), retrying in ${retryDelay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }

            console.error(`❌ Failed to generate structured suggestions (after ${attempt + 1} attempt(s)):`, errorMessage);
            console.warn('⚠️  Falling back to aggregated findings');

            // Fallback: use aggregated findings
            structuredData = {
                url: pageData.pageUrl,
                deviceType: pageData.deviceType,
                timestamp: new Date().toISOString(),
                suggestions: transformFindingsToSuggestions(allFindings)
            };
            break; // Fallback set — exit retry loop
        }
    }

    // Step 2: Generate markdown from JSON (formatting layer)
    const markdown = formatSuggestionsToMarkdown(structuredData, {
        url: pageData.pageUrl,
        deviceType: pageData.deviceType,
        mode,
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
