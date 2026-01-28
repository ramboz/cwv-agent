import {ChatPromptTemplate} from '@langchain/core/prompts';
import {DynamicTool} from '@langchain/core/tools';
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

const DEFAULT_THRESHOLDS = {
    mobile: {
        LCP_MS: 3000,
        TBT_MS: 250,
        REQUESTS: 150,
        TRANSFER_BYTES: 3_000_000,
    },
    desktop: {
        LCP_MS: 2800,
        TBT_MS: 300,
        REQUESTS: 180,
        TRANSFER_BYTES: 3_500_000,
    }
};

/** Zod Schema for Structured Suggestions Output (Final synthesis) */
const suggestionSchema = z.object({
    url: z.string().url(),
    deviceType: z.enum(['mobile', 'desktop']),
    timestamp: z.string(),
    suggestions: z.array(z.object({
        title: z.string().min(1),
        description: z.string().min(1),
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

/** Tool Wrapper */
export class Tool {
    constructor({name, description, func}) {
        this.name = name;
        this.description = description;
        this.instance = new DynamicTool({name, description, func});
    }
}

/** Agent */
export class Agent {
    constructor({name, role, systemPrompt, humanPrompt = "", llm, tools = [], globalSystemPrompt = ""}) {
        if (typeof systemPrompt !== "string" || typeof humanPrompt !== "string") {
            throw new Error(`Invalid prompt for Agent "${name}"`);
        }

        const combinedSystem = [globalSystemPrompt, systemPrompt]
            .filter((s) => typeof s === 'string' && s.trim().length > 0)
            .join('\n\n');

        const prompt = ChatPromptTemplate.fromMessages([
            new SystemMessage(combinedSystem),
            new HumanMessage(humanPrompt)
        ]);

        this.name = name;
        this.role = role;
        this.tools = tools;
        // this.llm = LangchainLLMFactory.createLLM(llm);
        this.llm = llm
        // Extract the base LLM from ModelAdapter if needed for RunnableSequence
        const baseLLM = llm.getBaseLLM ? llm.getBaseLLM() : llm;
        this.chain = RunnableSequence.from([prompt, baseLLM, new StringOutputParser()]);
    }

    async invoke(input) {
        // Use native tool calling if tools are available
        if (this.tools.length > 0) {
            // Extract base LLM for tool binding
            const baseLLM = this.llm.getBaseLLM ? this.llm.getBaseLLM() : this.llm;
            // Bind tools to LLM for native tool calling
            const llmWithTools = baseLLM.bindTools(this.tools.map(t => t.instance));

            // Create message array with system and human messages
            const messages = [
                new SystemMessage(this.chain.steps[0].promptMessages[0].prompt.template),
                new HumanMessage(input)
            ];

            // Initial invocation
            let aiMessage = await llmWithTools.invoke(messages);
            messages.push(aiMessage);

            // Auto-loop on tool calls
            while (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
                for (const toolCall of aiMessage.tool_calls) {
                    const tool = this.tools.find(t => t.name === toolCall.name);
                    if (tool) {
                        const toolMessage = await tool.instance.invoke(toolCall);
                        messages.push(toolMessage);
                    }
                }
                aiMessage = await llmWithTools.invoke(messages);
                messages.push(aiMessage);
            }

            return aiMessage.content;
        }

        // Fallback to simple chain for agents without tools
        const result = await this.chain.invoke({ input });
        return result;
    }
}

/** MultiAgentSystem */
export class MultiAgentSystem {
    constructor({llm, toolsConfig, agentsConfig, globalSystemPrompt = ""}) {
        this.llm = llm;
        this.tools = new Map();
        this.agents = new Map();
        this.globalSystemPrompt = globalSystemPrompt;

        this.initTools(toolsConfig);
        this.initAgents(agentsConfig);
    }

    initTools(toolsConfig) {
        for (const toolConf of toolsConfig) {
            const tool = new Tool(toolConf);
            this.tools.set(tool.name, tool);
        }
    }

    initAgents(agentsConfig) {
        for (const config of agentsConfig) {
            const tools = config.toolNames?.map(name => this.tools.get(name)).filter(Boolean) || [];
            const agent = new Agent({...config, llm: this.llm, tools, globalSystemPrompt: this.globalSystemPrompt});
            this.agents.set(config.name, agent);
        }
    }
    async executeParallelTasks(tasks) {
        const total = tasks.length;
        let completed = 0;

        // Rate limiting configuration
        const BATCH_SIZE = parseInt(process.env.AGENT_BATCH_SIZE || '3', 10);
        const DELAY_BETWEEN_BATCHES = parseInt(process.env.AGENT_BATCH_DELAY || '2000', 10); // ms
        const MAX_RETRIES = 3;
        const INITIAL_RETRY_DELAY = 5000; // 5 seconds

        // Helper: Execute single agent with retry logic
        const executeAgentWithRetry = async ({agent: agentName, description}, retryCount = 0) => {
            const agent = this.agents.get(agentName);
            if (!agent) throw new Error(`Agent ${agentName} not found`);
            const input = description || `Please perform your assigned role as ${agent.role}`;
            const t0 = Date.now();

            try {
                const output = await agent.invoke(input);
                const dt = ((Date.now() - t0) / 1000).toFixed(1);
                completed++;
                console.log(`✅ ${agentName} (${Math.round(completed/total*100)}%, ${Number(dt)}s)`);
                return {agent: agentName, output};
            } catch (err) {
                const dt = ((Date.now() - t0) / 1000).toFixed(1);

                // Check if it's a rate limit error (429)
                const isRateLimitError = err.message?.includes('429') ||
                                        err.message?.includes('Resource exhausted') ||
                                        err.message?.includes('rateLimitExceeded');

                if (isRateLimitError && retryCount < MAX_RETRIES) {
                    const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount); // Exponential backoff
                    console.log(`⚠️  ${agentName} hit rate limit, retrying in ${retryDelay/1000}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    return executeAgentWithRetry({agent: agentName, description}, retryCount + 1);
                }

                completed++;
                console.log(`❌ ${agentName} (${Math.round(completed/total*100)}%, ${Number(dt)}s):`, err.message);
                return {agent: agentName, output: `Error: ${err.message}`};
            }
        };

        // Execute tasks in batches to avoid rate limiting
        const results = [];
        for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const batch = tasks.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(tasks.length / BATCH_SIZE);

            console.log(`🔄 Executing batch ${batchNum}/${totalBatches} (${batch.length} agents)...`);

            // Execute batch in parallel
            const batchResults = await Promise.all(batch.map(task => executeAgentWithRetry(task)));
            results.push(...batchResults);

            // Add delay between batches (except after last batch)
            if (i + BATCH_SIZE < tasks.length) {
                console.log(`⏳ Waiting ${DELAY_BETWEEN_BATCHES/1000}s before next batch...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
        }

        return results;
    }
}

/** Utility Functions */

const isPromptValid = (length, limits) => length <= (limits.input - limits.output) * 0.9;


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

function extractStructuredSuggestions(content, pageUrl, deviceType) {
    try {
        const match1 = content.match(/## STRUCTURED DATA FOR AUTOMATION[\s\S]*?```json\s*(\{[\s\S]*?\})\s*```/)
            || content.match(/```json\s*(\{[\s\S]*?\})\s*```/)
            || content.match(/(\{[\s\S]*"suggestions"[\s\S]*?\})/);
        if (!match1) return {};
        const parsed1 = JSON.parse(match1[1]);

        // Normalize suggestion list
        let suggestions = parsed1.suggestions;
        if (!Array.isArray(suggestions)) {
            if (Array.isArray(parsed1.actions)) suggestions = parsed1.actions;
            else if (Array.isArray(parsed1.recommendations)) suggestions = parsed1.recommendations;
            else if (parsed1.suggestions && typeof parsed1.suggestions === 'object') suggestions = Object.values(parsed1.suggestions);
            else if (parsed1.data && Array.isArray(parsed1.data.suggestions)) suggestions = parsed1.data.suggestions;
            else if (parsed1.data && Array.isArray(parsed1.data.actions)) suggestions = parsed1.data.actions;
        }

        // Normalize suggestions to fix common LLM output issues
        const normalizedSuggestions = Array.isArray(suggestions) ? suggestions.map(s => {
            // Fix comma-separated metrics (e.g., "LCP, INP" → ["LCP", "INP"])
            if (s.metric && typeof s.metric === 'string' && s.metric.includes(',')) {
                s.metric = s.metric.split(',').map(m => m.trim());
            }
            return s;
        }) : [];

        const normalized = {
            ...parsed1,
            url: parsed1.url || pageUrl,
            deviceType: parsed1.deviceType || deviceType,
            timestamp: parsed1.timestamp || new Date().toISOString(),
            suggestions: normalizedSuggestions,
        };

        // Validate with Zod schema (logs warnings but doesn't block)
        try {
            suggestionSchema.parse(normalized);
        } catch (zodError) {
            console.warn('Multi-agent: Suggestion schema validation failed:', zodError.errors);
            // Continue despite validation errors for now (Phase 1 will enforce strict validation)
        }

        return normalized;
    } catch (e) {
        console.warn('Multi-agent: failed to parse structured JSON:', e.message);
        return {};
    }
}

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
function getPsiAudit(psi, auditId) {
    try {
        return psi?.data?.lighthouseResult?.audits?.[auditId] || null;
    } catch (e) {
        return null;
    }
}

/**
 * Extract key PSI signals for gating
 * @param {Object} psi
 * @return {Object}
 */
function extractPsiSignals(psi) {
    const lcp = getPsiAudit(psi, 'largest-contentful-paint')?.numericValue ?? null;
    const tbt = getPsiAudit(psi, 'total-blocking-time')?.numericValue ?? null;
    const cls = getPsiAudit(psi, 'cumulative-layout-shift')?.numericValue ?? null;
    const redirects = (getPsiAudit(psi, 'redirects')?.score ?? 1) < 1;
    const unusedJsAudit = getPsiAudit(psi, 'unused-javascript');
    const reduceUnusedJS = !!(unusedJsAudit && ((unusedJsAudit.score ?? 1) < 1));
    const serverResponseSlow = (getPsiAudit(psi, 'server-response-time')?.score ?? 1) < 1;
    const renderBlocking = (getPsiAudit(psi, 'render-blocking-resources')?.score ?? 1) < 1;
    const usesRelPreconnect = (getPsiAudit(psi, 'uses-rel-preconnect')?.score ?? 1) < 1;
    return { lcp, tbt, cls, redirects, reduceUnusedJS, serverResponseSlow, renderBlocking, usesRelPreconnect };
}

/**
 * Compute HAR stats used for gating
 * @param {Object} har
 * @return {{entriesCount: Number, transferBytes: Number}}
 */
function computeHarStats(har) {
    try {
        const entries = har?.log?.entries || [];
        let transferBytes = 0;
        for (const e of entries) {
            // Prefer _transferSize, fallback to bodySize/content.size
            const t = (e.response?._transferSize ?? e.response?.bodySize ?? e.response?.content?.size ?? 0);
            transferBytes += Math.max(0, t);
        }
        return { entriesCount: entries.length, transferBytes };
    } catch (e) {
        return { entriesCount: 0, transferBytes: 0 };
    }
}

/**
 * Compute performance signals from PerformanceObserver entries
 * - Detect long tasks before LCP
 */
function computePerfSignals(perfEntries) {
    try {
        const entries = Array.isArray(perfEntries) ? perfEntries : [];
        const lcpEntries = entries.filter(e => e.entryType === 'largest-contentful-paint');
        const lcpTimeMs = lcpEntries.length > 0 ? Math.min(...lcpEntries.map(e => e.startTime || Number.MAX_VALUE)) : null;
        const longTasks = entries.filter(e => e.entryType === 'longtask');
        const longTasksPre = longTasks.filter(e => (lcpTimeMs == null) || (e.startTime <= lcpTimeMs));
        const totalLongTaskMsPreLcp = longTasksPre.reduce((acc, e) => acc + (e.duration || 0), 0);
        const hasLongTasksPreLcp = longTasksPre.some(e => (e.duration || 0) >= 200);
        return { hasLongTasksPreLcp, totalLongTaskMsPreLcp, lcpTimeMs };
    } catch (_) {
        return { hasLongTasksPreLcp: false, totalLongTaskMsPreLcp: 0, lcpTimeMs: null };
    }
}

/**
 * Filter resources for targeted code review
 * Keeps HTML at pageUrl and a subset of JS/CSS likely relevant
 * @param {String} pageUrl
 * @param {Object} resources
 * @return {Object}
 */
function selectCodeResources(pageUrl, resources) {
    if (!resources || typeof resources !== 'object') return resources || {};
    const html = resources[pageUrl];
    const DENYLIST_REGEX = /(granite|foundation|cq|core\.|wcm|jquery|lodash|moment|minified|bootstrap|react\.|angular|vue\.|rxjs|three\.|videojs|chart|codemirror|ace|monaco|gtag|googletag|optimizely|segment|tealium|adobe-dtm|launch-)/i;
    const subset = {};
    if (html) subset[pageUrl] = html;

    for (const [url, content] of Object.entries(resources)) {
        if (url === pageUrl) continue;
        const isJsOrCss = url.endsWith('.js') || url.endsWith('.css');
        if (!isJsOrCss) continue;
        if (DENYLIST_REGEX.test(url)) continue;
        // Prefer files referenced in HTML or known critical patterns
        const referencedInHtml = !!(html && url.includes('://') && html.includes(new URL(url).pathname));
        if (!referencedInHtml) continue;
        subset[url] = content;
    }
    return subset;
}

/**
 * Build conditional agent config using summaries for heavy artifacts
 * @param {Object} pageData
 * @param {String} cms
 * @return {Array}
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
 * Conditional, signal-driven multi-agent runner
 * Starts cheap and conditionally adds heavy agents
 * @param {Object} pageData
 * @param {Object} tokenLimits
 * @param {Object} llm
 * @return {Promise<String|null>}
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
    if (allFindings.length > 0 && causalGraph) {
        try {
            const validationResults = validateFindings(allFindings, causalGraph, {
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

            // Collect post-validation quality metrics for comparison
            const postValidationMetrics = collectQualityMetrics(agentOutputs, pageData.pageUrl, pageData.deviceType, model);
            console.log(`✅ Post-Validation: ${postValidationMetrics.totalFindings} findings (${validationResults.summary.blocked} blocked, ${validationResults.summary.adjusted} adjusted)`);
        } catch (error) {
            console.warn('Failed to validate findings:', error.message);
        }
    }

    // Phase 5: Build graph-enhanced context for synthesis
    let graphEnhancedContext = context;
    if (causalGraph && causalGraph.rootCauses && causalGraph.rootCauses.length > 0) {
        // Extract root causes and calculate their total impact
        const rootCauseImpacts = causalGraph.rootCauses.map(rcId => {
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

    const finalPrompt = actionPrompt(pageData.pageUrl, pageData.deviceType);
    const baseLLM = llm.getBaseLLM ? llm.getBaseLLM() : llm;
    const finalChain = RunnableSequence.from([
        ChatPromptTemplate.fromMessages([
            new SystemMessage(finalPrompt),
            new HumanMessage(`Here is the context from previous agents:\n${graphEnhancedContext}`)
        ]),
        baseLLM,
        new StringOutputParser()
    ]);

    console.log('- running final analysis...');
    const finalOutput = await finalChain.invoke({ input: graphEnhancedContext });


    console.groupEnd();

    return result + "\n\n## Final Suggestions:\n" + finalOutput;
}

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
export async function runAgentFlow(pageUrl, deviceType, options = {}) {
    // Phase 1: collect CRUX, PSI, and RUM (parallel), derive gates from PSI
    const [{ full: crux, summary: cruxSummary }, { full: psi, summary: psiSummary }, { data: rum, summary: rumSummary }] = await Promise.all([
        getCrux(pageUrl, deviceType, options),
        getPsi(pageUrl, deviceType, options),
        getRUM(pageUrl, deviceType, options),
    ]);

    // Derive gates using PSI only (single lab run later)
    const signals = extractPsiSignals(psi);
    const device = (deviceType || 'mobile').toLowerCase();
    const TH = DEFAULT_THRESHOLDS[device] || DEFAULT_THRESHOLDS.mobile;
    const coverageSignals = [
        signals.reduceUnusedJS === true,
        (signals.tbt ?? 0) > TH.TBT_MS,
        (signals.lcp ?? 0) > TH.LCP_MS,
    ];
    const shouldRunCoverage = coverageSignals.some(Boolean);

    // Phase 2: single lab run, always collecting HAR, conditionally collecting Coverage
    const { har: harHeavy, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi, coverageData, coverageDataSummary, thirdPartyAnalysis, clsAttribution } = await getLabData(pageUrl, deviceType, {
        ...options,
        collectHar: true,  // Always collect HAR
        collectCoverage: shouldRunCoverage,
    });

    // Phase 3: conditionally collect code after coverage/har gates
    let resources = undefined;
    if (shouldRunCode) {
        let codeRequests = [];
        if (Array.isArray(harHeavy?.log?.entries)) {
            codeRequests = harHeavy.log.entries.map(e => e.request?.url).filter(Boolean);
        } else if (Array.isArray(perfEntries)) {
            codeRequests = perfEntries
                .filter(e => e.entryType === 'resource' && (e.initiatorType === 'script' || e.initiatorType === 'link'))
                .map(e => e.name)
                .filter(Boolean);
        }
        console.log(`   Collecting code for ${codeRequests.length} resources...`);
        const { codeFiles } = await getCode(pageUrl, deviceType, codeRequests, options);
        resources = codeFiles;
    }

    // Apply rules (cached when available)
    const report = merge(pageUrl, deviceType);
    const { summary: rulesSummary, fromCache } = await applyRules(
        pageUrl,
        deviceType,
        options,
        { crux, psi, har: (harHeavy && harHeavy.log ? harHeavy : { log: { entries: [] } }), perfEntries, resources, fullHtml, jsApi, report }
    );
    if (fromCache) {
        console.log('✓ Loaded rules from cache. Estimated token size: ~', estimateTokenSize(rulesSummary, options.model));
    } else {
        console.log('✅ Processed rules. Estimated token size: ~', estimateTokenSize(rulesSummary, options.model));
    }

    const cms = detectAEMVersion(harHeavy?.log?.entries?.[0]?.headers, fullHtml || resources[pageUrl]);
    console.log('AEM Version:', cms);

    // Create LLM instance and compute token limits
    const llm = LLMFactory.createLLM(options.model, options.llmOptions || {});
    const tokenLimits = getTokenLimits(options.model);

    // Assemble page data for prompts/agents
    const pageData = {
        pageUrl,
        deviceType,
        cms,
        rulesSummary,
        resources,
        crux,
        psi,
        rum,
        perfEntries,
        har: (harHeavy && harHeavy.log ? harHeavy : { log: { entries: [] } }),
        coverageData,
        cruxSummary,
        psiSummary,
        rumSummary,
        perfEntriesSummary,
        harSummary,
        coverageDataSummary,
        fullHtml,
        thirdPartyAnalysis,
        clsAttribution,
    };

    // Execute flow (force conditional multi-agent mode)
    const result = await runMultiAgents(pageData, tokenLimits, llm, options.model);

    // Persist a copy labeled under agent action
    cacheResults(pageUrl, deviceType, 'report', result, '', options.model);

    const markdownData = extractMarkdownSuggestions(result);
    const path = cacheResults(pageUrl, deviceType, 'report', markdownData, '', options.model);
    console.log('✅ CWV report generated at:', path);
    
    // Extract and save structured JSON if present
    const structuredData = extractStructuredSuggestions(result, pageUrl, deviceType);
    if (structuredData) {
      const suggestionPath = cacheResults(pageUrl, deviceType, 'suggestions', structuredData, '', options.model);
      console.log('✅ Structured suggestions saved at:', suggestionPath);
    }
    return result;
}
