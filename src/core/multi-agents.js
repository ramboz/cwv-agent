import {ChatPromptTemplate} from "@langchain/core/prompts";
import {DynamicTool} from "@langchain/core/tools";
import {RunnableSequence} from "@langchain/core/runnables";
import {StringOutputParser} from "@langchain/core/output_parsers";
import {cacheResults, estimateTokenSize} from '../utils.js';
import {
    actionPrompt, codeStep, coverageStep, coverageSummaryStep,
    cruxStep, cruxSummaryStep, harStep, harSummaryStep,
    htmlStep, perfStep, perfSummaryStep, psiStep,
    psiSummaryStep, rulesStep
} from "../prompts/index.js";
import rules from "../rules/index.js";
import {HumanMessage, SystemMessage} from "@langchain/core/messages";
import {
    codeReviewAgentPrompt, coverageAgentPrompt,
    cruxAgentPrompt, harAgentPrompt, htmlAgentPrompt,
    perfObserverAgentPrompt, psiAgentPrompt, rulesAgentPrompt,
    initializeSystemAgents,
} from "../prompts/index.js";
import { getCrux, getPsi, getLabData, getCode } from './collect.js';
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
        this.chain = RunnableSequence.from([prompt, this.llm, new StringOutputParser()]); // ← Fixed: use this.llm
    }

    async invoke(input) {
        let processedInput = input;

        const toolDecision = await this.shouldUseTool(input);
        if (toolDecision?.use && toolDecision?.toolObj) {
            const toolResult = await toolDecision.toolObj.instance.func(toolDecision.query);
            processedInput += `\n\nTool Result: ${toolResult}`;
        }

        const result = await this.chain.invoke({ input: processedInput });
        return result;
    }

    async shouldUseTool(input) {
        if (!this.tools.length) return {use: false};

        const toolNames = this.tools.map(t => t.name).join(", ");
        const toolPrompt = `
Given this input: "${input}"
Available tools: ${toolNames}
Should I use a tool? Respond as:
{"use": true/false, "tool": "tool_name", "query": "search_query"}
`;

        try {
            const response = await this.llm.invoke([
                new SystemMessage('You are a tool selector. Return a compact JSON with keys: use, tool, query.'),
                { role: "user", content: toolPrompt }
            ]);
            const raw = response.content.replace(/```json|```/gi, "").trim();
            const parsed = JSON.parse(raw);
            const selectedTool = this.tools.find(t => t.name === parsed.tool);
            return {...parsed, toolObj: selectedTool};
        } catch (error) {
            console.warn("Tool decision parsing failed:", error.message);
            return {use: false};
        }
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

    async executeSequentialTasks(tasks) {
        const results = [];
        let context = "";

        for (let i = 0; i < tasks.length; i++) {
            const {agent: agentName, description = ""} = tasks[i];
            const agent = this.agents.get(agentName);
            if (!agent) throw new Error(`Agent ${agentName} not found`);

            const input = `${description}${context ? `\n\nPrevious Context:\n${context}` : ""}`;
            const output = await agent.invoke(input);
            results.push({phase: i + 1, agent: agentName, output});
            context += `\n${agentName}: ${output}`;
        }
        return results;
    }

    async executeParallelTasks(tasks) {
        const total = tasks.length;
        let completed = 0;
        const results = await Promise.all(tasks.map(async ({agent: agentName, description}) => {
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
                completed++;
                console.log(`❌ ${agentName} (${Math.round(completed/total*100)}%, ${Number(dt)}s):`, err.message);
                return {agent: agentName, output: `Error: ${err.message}`};
            }
        }));
        return results;
    }
}

/** Utility Functions */

const isPromptValid = (length, limits) =>
    length <= (limits.input - limits.output) * 0.9;

const generateAgentConfig = (isSummary, pageData, cms) => {
    const steps = {
        "Crux Agent": [cruxAgentPrompt(cms), isSummary ? cruxSummaryStep(pageData.cruxSummary) : cruxStep(pageData.crux)],
        "Psi Agent": [psiAgentPrompt(cms), isSummary ? psiSummaryStep(pageData.psiSummary) : psiStep(pageData.psi)],
        "Perf Observer Agent": [perfObserverAgentPrompt(cms), isSummary ? perfSummaryStep(pageData.perfEntriesSummary) : perfStep(pageData.perfEntries)],
        "Har Agent": [harAgentPrompt(cms), isSummary ? harSummaryStep(pageData.harSummary) : harStep(pageData.har)],
        "Html Agent": [htmlAgentPrompt(cms), htmlStep(pageData.pageUrl, pageData.resources)],
        "Rules Agent": [rulesAgentPrompt(cms), isSummary ? rulesStep(pageData.rulesSummary) : rulesStep(rules)],
        "Coverage Agent": [coverageAgentPrompt(cms), isSummary ? coverageSummaryStep(pageData.coverageDataSummary) : coverageStep(pageData.coverageData)],
        "Code Review Agent": [codeReviewAgentPrompt(cms), codeStep(pageData.pageUrl, pageData.resources, 10_000)]
    };

    return Object.entries(steps).map(([name, [sys, hum]]) => ({
        name,
        role: name.replace(/_/g, " ").replace("agent", "").trim(),
        systemPrompt: sys,
        humanPrompt: hum
    }));
};

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

        return {
            ...parsed1,
            url: parsed1.url || pageUrl,
            deviceType: parsed1.deviceType || deviceType,
            timestamp: parsed1.timestamp || new Date().toISOString(),
            suggestions: Array.isArray(suggestions) ? suggestions : [],
        };
    } catch (e) {
        console.warn('Multi-agent: failed to parse structured JSON:', e.message);
        return {};
    }
}

/** Main Runner */
export async function runMultiAgents(pageData, tokenLimits, llm, model) {
    let agentsConfig = generateAgentConfig(false, pageData, pageData.cms);
    const summaryConfig = generateAgentConfig(true, pageData, pageData.cms);

    // Check if the system prompt is valid (including global initialization)
    const baseInit = initializeSystemAgents(pageData.cms);
    const baseTokens = estimateTokenSize(baseInit, model);
    agentsConfig = agentsConfig.map((agent, i) => {
        const tokenLength = baseTokens + estimateTokenSize(agent.systemPrompt, model) + estimateTokenSize(agent.humanPrompt, model);
        if (!isPromptValid(tokenLength, tokenLimits)) {
            console.log(`- ${agent.name} prompt too long, using summary`);
            return {...agent, humanPrompt: summaryConfig[i].humanPrompt};
        }
        return agent;
    });

    cacheResults(pageData.pageUrl, pageData.deviceType, 'prompt', agentsConfig.map(a => a.systemPrompt).join('\n') + '\n' + agentsConfig.map(a => a.humanPrompt).join('\n' + '-'.repeat(64) + '\n'));

    const system = new MultiAgentSystem({
        llm,
        toolsConfig: [],
        agentsConfig,
        globalSystemPrompt: initializeSystemAgents(pageData.cms)
    });

    const tasks = agentsConfig.map(agent => ({agent: agent.name}));
    const responses = await system.executeParallelTasks(tasks);

    console.log("\nParallel Results:");

    let result = "";
    let context = "";
    responses.forEach(({agent, output}, index) => {
        const section = `## Phase ${index + 1} - ${agent}:\n${output}`;
        result += `\n\n${section}`;
        context += `\n${agent}: ${output}`;
    });

    /** Structured Reducer */
    const aggregate = await reduceAgentOutputs(responses, pageData, llm);
    if (aggregate) {
        cacheResults(pageData.pageUrl, pageData.deviceType, 'suggestions', aggregate, 'agent_aggregate');
        context += `\nAggregated Structured Insights: ${JSON.stringify(aggregate)}`;
    }

    /** Final Action Prompt */
    const finalPrompt = actionPrompt(pageData.pageUrl, pageData.deviceType);

    const finalChain = RunnableSequence.from([
        ChatPromptTemplate.fromMessages([
            new SystemMessage(initializeSystemAgents(pageData.cms)),
            new SystemMessage(finalPrompt),
            new HumanMessage(`Here is the context from previous agents:\n${context}`)
        ]),
        llm,
        new StringOutputParser()
    ]);

    console.log('- running final analysis...');
    const finalOutput = await finalChain.invoke({input: context});

    // Return both the outputs and suggestions
    return result + "\n\n## Final Suggestions:\n" + finalOutput;
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
    const coverageSignals = [
        signals.reduceUnusedJS === true,
        (signals.tbt ?? 0) > TH.TBT_MS,
        (signals.lcp ?? 0) > TH.LCP_MS,
        perfSig.hasLongTasksPreLcp === true,
    ];
    const shouldRunCoverage = perfSig.lcpTimeMs != null
        ? coverageSignals.filter(Boolean).length >= 2
        : coverageSignals.some(Boolean);

    const harSignals = [
        harStats.entriesCount > TH.REQUESTS,
        harStats.transferBytes > TH.TRANSFER_BYTES,
        signals.redirects,
        signals.serverResponseSlow,
        signals.renderBlocking,
    ];
    const shouldRunHar = harSignals.filter(Boolean).length >= 2; // require 2+ signals

    // Code review requires multi-signal when perf windows are available
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
        const filteredResources = selectCodeResources(pageUrl, resources);
        steps.push({ name: 'Code Review Agent', sys: codeReviewAgentPrompt(cms), hum: codeStep(pageUrl, filteredResources, 10_000) });
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

/** Conditional Runner */
/**
 * Conditional, signal-driven multi-agent runner
 * Starts cheap and conditionally adds heavy agents
 * @param {Object} pageData
 * @param {Object} tokenLimits
 * @param {Object} llm
 * @return {Promise<String|null>}
 */
export async function runMultiAgentsConditional(pageData, tokenLimits, llm, model) {
    console.group('Starting multi-agent flow...');
    if (!pageData || !tokenLimits || !llm) {
        console.warn('runMultiAgentsConditional: invalid arguments');
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

    cacheResults(pageData.pageUrl, pageData.deviceType, 'prompt_conditional', agentsConfig.map(a => a.systemPrompt).join('\n') + '\n' + agentsConfig.map(a => a.humanPrompt).join('\n' + '-'.repeat(64) + '\n'));

    const system = new MultiAgentSystem({ llm, toolsConfig: [], agentsConfig, globalSystemPrompt: initializeSystemAgents(pageData.cms) });
    const tasks = agentsConfig.map(agent => ({ agent: agent.name }));
    const responses = await system.executeParallelTasks(tasks);

    let result = '';
    let context = '';
    responses.forEach(({ agent, output }, index) => {
        const section = `## Phase ${index + 1} - ${agent}:\n${output}`;
        result += `\n\n${section}`;
        context += `\n${agent}: ${output}`;
    });

    const finalPrompt = actionPrompt(pageData.pageUrl, pageData.deviceType);
    const finalChain = RunnableSequence.from([
        ChatPromptTemplate.fromMessages([
            new SystemMessage(finalPrompt),
            new HumanMessage(`Here is the context from previous agents:\n${context}`)
        ]),
        llm,
        new StringOutputParser()
    ]);

    console.log('- running final analysis...');
    const finalOutput = await finalChain.invoke({ input: context });

    
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
        const chain = RunnableSequence.from([prompt, llm, new StringOutputParser()]);
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
    // Phase 1: collect CRUX and PSI (parallel), derive gates from PSI
    const [{ full: crux, summary: cruxSummary }, { full: psi, summary: psiSummary }] = await Promise.all([
        getCrux(pageUrl, deviceType, options),
        getPsi(pageUrl, deviceType, options),
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
    const shouldRunHar = [signals.redirects, signals.serverResponseSlow, signals.renderBlocking].filter(Boolean).length >= 2;

    // Phase 2: single lab run, conditionally collecting HAR/Coverage as needed
    const { har: harHeavy, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi, coverageData, coverageDataSummary } = await getLabData(pageUrl, deviceType, {
        ...options,
        collectHar: shouldRunHar,
        collectCoverage: shouldRunCoverage,
    });

    // Phase 3: conditionally collect code after coverage/har gates
    let resources = undefined;
    const shouldRunCode = (signals.reduceUnusedJS === true && (signals.tbt ?? 0) > TH.TBT_MS) || shouldRunCoverage;
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
        perfEntries,
        har: (harHeavy && harHeavy.log ? harHeavy : { log: { entries: [] } }),
        coverageData,
        cruxSummary,
        psiSummary,
        perfEntriesSummary,
        harSummary,
        coverageDataSummary,
        fullHtml,
    };

    // Execute flow (force conditional multi-agent mode)
    const result = await runMultiAgentsConditional(pageData, tokenLimits, llm, options.model);

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
