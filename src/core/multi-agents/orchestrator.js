/**
 * Agent Flow Orchestrator
 * Extracted from multi-agents.js for better maintainability
 *
 * Handles:
 * - Main runAgentFlow coordination
 * - Data collection phases (CrUX, PSI, RUM, Lab data, Code)
 * - Gating logic and conditional collection
 * - Result persistence
 */

import { cacheResults, estimateTokenSize } from '../../utils.js';
import { getCrux, getPsi, getRUM, getLabData, getCode } from '../collect.js';
import { detectAEMVersion } from '../../tools/aem.js';
import { detectFramework } from '../../tools/code.js';
import merge from '../../tools/merge.js';
import { applyRules } from '../../tools/rules.js';
import { LLMFactory } from '../../models/llm-factory.js';
import { getTokenLimits, DEFAULT_MODEL } from '../../models/config.js';
import { DEVICE_THRESHOLDS } from '../../config/thresholds.js';
import { RESOURCE_DENYLIST_REGEX } from '../../config/regex-patterns.js';

// Import runMultiAgents from suggestions-engine
import { runMultiAgents } from './suggestions-engine.js';
// Import extractMarkdownSuggestions from parent module (still there for now)
import { extractMarkdownSuggestions } from '../multi-agents.js';

// Re-export DEVICE_THRESHOLDS as DEFAULT_THRESHOLDS for backward compatibility
export const DEFAULT_THRESHOLDS = DEVICE_THRESHOLDS;

/**
 * Get PSI audit by ID safely
 */
function getPsiAudit(psi, auditId) {
    try {
        return psi?.data?.lighthouseResult?.audits?.[auditId] || null;
    } catch (e) {
        return null;
    }
}

/**
 * Extract key PSI signals for gating decisions
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
 */
function selectCodeResources(pageUrl, resources) {
    if (!resources || typeof resources !== 'object') return resources || {};
    const html = resources[pageUrl];
    const subset = {};
    if (html) subset[pageUrl] = html;

    for (const [url, content] of Object.entries(resources)) {
        if (url === pageUrl) continue;
        const isJsOrCss = url.endsWith('.js') || url.endsWith('.css');
        if (!isJsOrCss) continue;
        if (RESOURCE_DENYLIST_REGEX.test(url)) continue;
        // Prefer files referenced in HTML or known critical patterns
        const referencedInHtml = !!(html && url.includes('://') && html.includes(new URL(url).pathname));
        if (!referencedInHtml) continue;
        subset[url] = content;
    }
    return subset;
}

/**
 * Main Agent Flow Orchestrator
 * Coordinates data collection and agent execution
 *
 * @param {string} pageUrl - URL to analyze
 * @param {string} deviceType - 'mobile' or 'desktop'
 * @param {Object} options - Configuration options
 * @returns {Promise<string>} Markdown report
 */
export async function runAgentFlow(pageUrl, deviceType, options = {}) {
    // Early credential validation - fail fast before expensive data collection
    const modelToUse = options.model || DEFAULT_MODEL;
    const credentialValidation = LLMFactory.validateModelCredentials(modelToUse);
    if (!credentialValidation.valid) {
        const errorMsg = `❌ Credential validation failed for model "${modelToUse}" (provider: ${credentialValidation.provider}):\n` +
            `   ${credentialValidation.error}\n\n` +
            `Please configure the required credentials before running the agent.`;
        console.error(errorMsg);
        throw new Error(credentialValidation.error);
    }
    console.log(`✓ Credentials validated for ${credentialValidation.provider} model: ${modelToUse}`);

    // Data quality tracking
    const dataQualityIssues = [];

    // Phase 1: Collect CrUX, PSI, and RUM (parallel), derive gates from PSI
    const [{ full: crux, summary: cruxSummary }, { full: psi, summary: psiSummary }, { data: rum, summary: rumSummary }] = await Promise.all([
        getCrux(pageUrl, deviceType, options),
        getPsi(pageUrl, deviceType, options),
        getRUM(pageUrl, deviceType, options),
    ]);

    // Track data quality issues
    if (!crux) {
        dataQualityIssues.push({ source: 'CrUX', impact: 'Field data unavailable', severity: 'info' });
    }
    if (!psi) {
        dataQualityIssues.push({ source: 'PSI', impact: 'Lab audit data unavailable', severity: 'error' });
    }
    if (!rum) {
        dataQualityIssues.push({ source: 'RUM', impact: 'Real User Monitoring data unavailable', severity: 'info' });
    }

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

    // Code collection gating (same logic as in generateConditionalAgentConfig)
    const shouldRunCode = (signals.reduceUnusedJS === true && (signals.tbt ?? 0) > TH.TBT_MS) || shouldRunCoverage;

    // Phase 2: Single lab run, always collecting HAR, conditionally collecting Coverage
    const { har: harHeavy, harSummary, perfEntries, perfEntriesSummary, fullHtml, fontData, fontDataSummary, jsApi, coverageData, coverageDataSummary, thirdPartyAnalysis, clsAttribution } = await getLabData(pageUrl, deviceType, {
        ...options,
        collectHar: true,  // Always collect HAR
        collectCoverage: shouldRunCoverage,
    });

    // Phase 3: Conditionally collect code after coverage/har gates
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
        const { codeFiles } = await getCode(pageUrl, deviceType, codeRequests, options);
        resources = codeFiles;
    }

    // Apply rules (cached when available)
    const report = merge(pageUrl, deviceType);
    const { summary: rulesSummary, fromCache } = await applyRules(
        pageUrl,
        deviceType,
        options,
        { crux, psi, har: (harHeavy && harHeavy.log ? harHeavy : { log: { entries: [] } }), perfEntries, resources, fullHtml, fontData, jsApi, report }
    );
    if (fromCache) {
        console.log('✓ Loaded rules from cache. Estimated token size: ~', estimateTokenSize(rulesSummary, options.model));
    } else {
        console.log('✅ Processed rules. Estimated token size: ~', estimateTokenSize(rulesSummary, options.model));
    }

    const cms = detectAEMVersion(harHeavy?.log?.entries?.[0]?.headers, fullHtml || resources[pageUrl]);
    console.log('AEM Version:', cms);

    // Detect frameworks from HTML content and script URLs
    const scriptUrls = harHeavy?.log?.entries
        ?.filter(e => e.request?.url?.endsWith('.js'))
        ?.map(e => e.request.url) || [];
    const frameworks = detectFramework(fullHtml || '', scriptUrls);
    console.log(`🔍 Detected frameworks: ${frameworks.join(', ')}`);

    // Create LLM instance and compute token limits
    const llm = LLMFactory.createLLM(options.model, options.llmOptions || {});
    const tokenLimits = getTokenLimits(options.model);

    // Create data quality summary
    const dataQuality = {
        complete: dataQualityIssues.length === 0,
        issues: dataQualityIssues,
        summary: dataQualityIssues.length === 0
            ? 'All data sources available'
            : `${dataQualityIssues.length} data source(s) unavailable: ${dataQualityIssues.map(i => i.source).join(', ')}`
    };

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
        fontData,
        fontDataSummary,
        thirdPartyAnalysis,
        clsAttribution,
        dataQuality,
        frameworks,
    };

    // Execute agent flow (force conditional multi-agent mode)
    const { markdown, structuredData } = await runMultiAgents(pageData, tokenLimits, llm, options.model);

    // Persist markdown report
    cacheResults(pageUrl, deviceType, 'report', markdown, '', options.model);

    const markdownData = extractMarkdownSuggestions(markdown);
    const path = cacheResults(pageUrl, deviceType, 'report', markdownData, '', options.model);
    console.log('✅ CWV report generated at:', path);

    // Save structured JSON directly (no need to extract from markdown!)
    if (structuredData && structuredData.suggestions && structuredData.suggestions.length > 0) {
        const suggestionPath = cacheResults(pageUrl, deviceType, 'suggestions', structuredData, '', options.model);
        console.log(`✅ Structured suggestions saved at: ${suggestionPath}`);
    } else {
        console.warn('⚠️ No structured suggestions generated');
    }

    return markdown;
}

// Export helper functions for testing/reuse
export { extractPsiSignals, computeHarStats, computePerfSignals, selectCodeResources, getPsiAudit };
