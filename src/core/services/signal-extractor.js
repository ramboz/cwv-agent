/**
 * Signal Extractor Service
 *
 * Extracts performance signals from collected data for gating and analysis decisions.
 * Consolidates signal extraction logic previously scattered across orchestrator and suggestions-engine.
 *
 * Provides:
 * - PSI signal extraction (LCP, TBT, CLS, audit failures)
 * - HAR statistics computation (request count, transfer bytes)
 * - Performance Observer signal extraction (long tasks, LCP timing)
 * - Chain signal detection from HAR summary
 * - Derived gating signals (coverage gate, code gate)
 * - Resource filtering for code analysis
 */

import { DEVICE_THRESHOLDS } from '../../config/thresholds.js';
import { RESOURCE_DENYLIST_REGEX } from '../../config/regex-patterns.js';

export class SignalExtractor {
  /**
   * @param {string} deviceType - Device type ('mobile' or 'desktop')
   * @param {object|null} thresholds - Optional device-specific thresholds (defaults to DEVICE_THRESHOLDS)
   */
  constructor(deviceType, thresholds = null) {
    this.deviceType = (deviceType || 'mobile').toLowerCase();
    this.thresholds = thresholds || DEVICE_THRESHOLDS[this.deviceType] || DEVICE_THRESHOLDS.mobile;
  }

  /**
   * Get PSI audit by ID safely
   * @private
   */
  getPsiAudit(psi, auditId) {
    try {
      return psi?.data?.lighthouseResult?.audits?.[auditId] || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Extract key PSI signals for gating decisions
   *
   * @param {object} psi - PageSpeed Insights data object
   * @returns {object} Extracted signals: { lcp, tbt, cls, redirects, reduceUnusedJS, serverResponseSlow, renderBlocking, usesRelPreconnect }
   */
  extractPsiSignals(psi) {
    const lcp = this.getPsiAudit(psi, 'largest-contentful-paint')?.numericValue ?? null;
    const tbt = this.getPsiAudit(psi, 'total-blocking-time')?.numericValue ?? null;
    const cls = this.getPsiAudit(psi, 'cumulative-layout-shift')?.numericValue ?? null;
    const redirects = (this.getPsiAudit(psi, 'redirects')?.score ?? 1) < 1;
    const unusedJsAudit = this.getPsiAudit(psi, 'unused-javascript');
    const reduceUnusedJS = !!(unusedJsAudit && ((unusedJsAudit.score ?? 1) < 1));
    const serverResponseSlow = (this.getPsiAudit(psi, 'server-response-time')?.score ?? 1) < 1;
    const renderBlocking = (this.getPsiAudit(psi, 'render-blocking-resources')?.score ?? 1) < 1;
    const usesRelPreconnect = (this.getPsiAudit(psi, 'uses-rel-preconnect')?.score ?? 1) < 1;

    return {
      lcp,
      tbt,
      cls,
      redirects,
      reduceUnusedJS,
      serverResponseSlow,
      renderBlocking,
      usesRelPreconnect,
    };
  }

  /**
   * Compute HAR statistics used for gating
   *
   * @param {object} har - HTTP Archive (HAR) data object
   * @returns {object} HAR stats: { entriesCount, transferBytes }
   */
  extractHarStats(har) {
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
   *
   * @param {array} perfEntries - Performance entries array
   * @returns {object} Performance signals: { hasLongTasksPreLcp, totalLongTaskMsPreLcp, lcpTimeMs }
   */
  extractPerfSignals(perfEntries) {
    try {
      const entries = Array.isArray(perfEntries) ? perfEntries : [];

      // Extract LCP timing
      const lcpEntries = entries.filter(e => e.entryType === 'largest-contentful-paint');
      const lcpTimeMs = lcpEntries.length > 0
        ? Math.min(...lcpEntries.map(e => e.startTime || Number.MAX_VALUE))
        : null;

      // Analyze long tasks before LCP
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
   * Extract chain signal from HAR summary text
   * More robust than inline regex matching
   *
   * @param {string} harSummary - HAR summary markdown text
   * @returns {boolean} True if sequential chains with depth >= 3 are detected
   */
  extractChainSignal(harSummary) {
    if (!harSummary || typeof harSummary !== 'string') {
      return false;
    }

    // Check for chain keywords
    const hasChainKeywords =
      harSummary.includes('Chain depth:') &&
      harSummary.includes('sequential delay:');

    if (!hasChainKeywords) {
      return false;
    }

    // Extract chain depth value
    const chainDepthMatch = /Chain depth:\s*(\d+)/.exec(harSummary);
    if (!chainDepthMatch) {
      return false;
    }

    const chainDepth = parseInt(chainDepthMatch[1], 10);
    return chainDepth >= 3;
  }

  /**
   * Derive coverage gate signal from PSI signals
   * Determines if coverage collection should run
   *
   * @param {object} psiSignals - PSI signals from extractPsiSignals()
   * @returns {boolean} True if coverage collection should run
   */
  deriveCoverageGate(psiSignals) {
    const signals = [
      psiSignals.reduceUnusedJS === true,
      (psiSignals.tbt ?? 0) > this.thresholds.TBT_MS,
      (psiSignals.lcp ?? 0) > this.thresholds.LCP_MS,
    ];
    return signals.some(Boolean);
  }

  /**
   * Derive code gate signal
   * Determines if code review collection should run
   *
   * @param {object} psiSignals - PSI signals from extractPsiSignals()
   * @param {boolean} shouldRunCoverage - Coverage gate result
   * @param {boolean} isLightMode - Whether light mode is enabled
   * @returns {boolean} True if code review should run
   */
  deriveCodeGate(psiSignals, shouldRunCoverage, isLightMode) {
    return !isLightMode && (
      (psiSignals.reduceUnusedJS === true && (psiSignals.tbt ?? 0) > this.thresholds.TBT_MS) ||
      shouldRunCoverage
    );
  }

  /**
   * Filter resources for targeted code review
   * Keeps HTML at pageUrl and a subset of JS/CSS likely relevant
   *
   * @param {string} pageUrl - Page URL being analyzed
   * @param {object} resources - All collected resources (URL -> content mapping)
   * @returns {object} Filtered subset of resources
   */
  selectCodeResources(pageUrl, resources) {
    if (!resources || typeof resources !== 'object') {
      return resources || {};
    }

    const html = resources[pageUrl];
    const subset = {};

    if (html) {
      subset[pageUrl] = html;
    }

    for (const [url, content] of Object.entries(resources)) {
      if (url === pageUrl) continue;

      // Only include JS/CSS files
      const isJsOrCss = url.endsWith('.js') || url.endsWith('.css');
      if (!isJsOrCss) continue;

      // Skip denylisted resources
      if (RESOURCE_DENYLIST_REGEX.test(url)) continue;

      // Prefer files referenced in HTML or known critical patterns
      const referencedInHtml = !!(html && url.includes('://') && html.includes(new URL(url).pathname));
      if (!referencedInHtml) continue;

      subset[url] = content;
    }

    return subset;
  }
}
