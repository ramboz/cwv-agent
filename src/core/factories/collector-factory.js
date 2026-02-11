/**
 * Collector Factory
 *
 * Provides dependency injection and unified interface for all lab data collectors.
 * Handles both LabDataCollector subclasses (HAR, Coverage, Performance) and
 * standalone functions (Font, HTML, JSApi, ThirdParty, CLS).
 *
 * Benefits:
 * - Decoupled architecture (orchestrator doesn't import specific collectors)
 * - Testability (mock CollectorFactory in tests)
 * - Unified interface (adapters wrap standalone functions)
 * - Dependency injection (collectors receive dependencies via factory)
 */

import { HARCollector } from '../../tools/lab/har-collector.js';
import { CoverageCollector } from '../../tools/lab/coverage-collector.js';
import { PerformanceCollector } from '../../tools/lab/performance-collector.js';
import { collectFontData, summarizeFontAnalysis } from '../../tools/lab/font-analyzer.js';
import { extractCwvRelevantHtml } from '../../tools/lab/html-extractor.js';
import { collectJSApiData } from '../../tools/lab/js-api-collector.js';
import { analyzeThirdPartyScripts } from '../../tools/lab/third-party-attributor.js';
import { attributeCLStoCSS, summarizeCLSAttribution } from '../../tools/lab/cls-attributor.js';

/**
 * Configuration for collector creation
 */
export class CollectorConfig {
  /**
   * @param {string} deviceType - Device type ('mobile' or 'desktop')
   * @param {object} options - Additional options
   * @param {object} options.thresholds - Device-specific thresholds (optional)
   * @param {boolean} options.skipCache - Skip cache (optional)
   * @param {boolean} options.blockRequests - Block requests (optional)
   */
  constructor(deviceType, options = {}) {
    this.deviceType = deviceType || 'mobile';
    this.options = options;
    this.thresholds = options.thresholds || null;
  }
}

/**
 * Wrapper for standalone functions to match LabDataCollector interface
 *
 * Adapts standalone collector functions (Font, HTML, etc.) to the
 * LabDataCollector interface (setup → collect → summarize).
 */
export class StandaloneCollectorAdapter {
  /**
   * @param {Function} collectFn - Collection function (receives page and dependencies)
   * @param {Function|null} summarizeFn - Summarization function (receives data and options)
   * @param {string} name - Collector name for debugging
   */
  constructor(collectFn, summarizeFn, name) {
    this.collectFn = collectFn;
    this.summarizeFn = summarizeFn;
    this.name = name;
  }

  /**
   * Setup phase (no-op for standalone collectors)
   * @param {object} page - Puppeteer page instance
   * @returns {Promise<null>}
   */
  async setup(page) {
    // Standalone collectors don't need setup
    return null;
  }

  /**
   * Collection phase - call the wrapped standalone function
   * @param {object} page - Puppeteer page instance
   * @param {*} setupResult - Result from setup (unused for standalone collectors)
   * @param {object} dependencies - Dependencies from other collectors (optional)
   * @returns {Promise<*>} Collected data
   */
  async collect(page, setupResult, dependencies = {}) {
    // Call standalone function with dependencies
    return this.collectFn(page, dependencies);
  }

  /**
   * Summarization phase - call the wrapped summarization function
   * @param {*} data - Collected data
   * @param {object} options - Summarization options
   * @returns {*} Summary (markdown or structured data)
   */
  summarize(data, options) {
    // If no summarization function, return data as-is
    return this.summarizeFn ? this.summarizeFn(data, options) : data;
  }

  /**
   * Full run (setup → collect → summarize)
   * Mirrors LabDataCollector.run() interface
   * @param {object} page - Puppeteer page instance
   * @param {object} options - Options including dependencies
   * @returns {Promise<*>} Summary result
   */
  async run(page, options = {}) {
    const setupResult = await this.setup(page);
    const data = await this.collect(page, setupResult, options.dependencies || {});
    return this.summarize(data, options);
  }

  /**
   * Safe run with Result pattern
   * Mirrors LabDataCollector.runSafe() interface
   * @param {object} page - Puppeteer page instance
   * @param {object} options - Options including dependencies
   * @returns {Promise<Result>} Result object with ok/err status
   */
  async runSafe(page, options = {}) {
    try {
      const result = await this.run(page, options);
      return { ok: true, data: result, source: 'fresh' };
    } catch (err) {
      return {
        ok: false,
        code: 'COLLECTION_FAILED',
        message: `${this.name} collection failed: ${err.message}`,
        context: { collectorName: this.name, error: err },
      };
    }
  }
}

/**
 * Factory for creating collectors
 *
 * Central registry for all collector types. Supports both LabDataCollector
 * subclasses and standalone functions wrapped in adapters.
 */
export class CollectorFactory {
  /**
   * Registry of collector factory functions
   * Each factory receives CollectorConfig and optional dependencies
   */
  static collectorRegistry = {
    // === LabDataCollector subclasses ===

    har: (config) => new HARCollector(config.deviceType),

    coverage: (config) => new CoverageCollector(config.deviceType),

    performance: (config) => new PerformanceCollector(config.deviceType),

    // === Standalone collectors wrapped as adapters ===

    /**
     * HTML Extractor - Extracts CWV-relevant HTML sections
     * No dependencies, returns JSON string
     */
    html: (config) =>
      new StandaloneCollectorAdapter(
        (page) => extractCwvRelevantHtml(page),
        null, // No summarization needed
        'HTMLExtractor',
      ),

    /**
     * Font Analyzer - Collects font data using document.fonts API
     * Has optional summarization function
     */
    font: (config) =>
      new StandaloneCollectorAdapter(
        (page) => collectFontData(page),
        (data, opts) => summarizeFontAnalysis(data, opts),
        'FontAnalyzer',
      ),

    /**
     * JS API Collector - Collects CSP violations and browser API data
     * No dependencies, returns object
     */
    jsApi: (config) =>
      new StandaloneCollectorAdapter((page) => collectJSApiData(page), null, 'JSApiCollector'),

    // === Dependency-based collectors ===

    /**
     * Third-Party Analyzer - Analyzes third-party scripts
     * Depends on: HAR entries, Performance entries
     */
    thirdParty: (config, dependencies = {}) =>
      new StandaloneCollectorAdapter(
        async (page, deps) => {
          // Extract dependencies (from pipeline execution context)
          const harEntries = deps.har?.log?.entries || [];
          const performanceEntries = deps.performance?.performanceEntries || [];

          // Note: analyzeThirdPartyScripts signature is:
          // (harEntries, perfEntries, pageUrl, deviceType)
          // We don't have pageUrl here, so pass empty string (will be provided by caller)
          return analyzeThirdPartyScripts(harEntries, performanceEntries, '', config.deviceType);
        },
        null,
        'ThirdPartyAnalyzer',
      ),

    /**
     * CLS Attributor - Maps layout shifts to CSS rules
     * Depends on: Performance entries (layout shift entries)
     */
    cls: (config, dependencies = {}) =>
      new StandaloneCollectorAdapter(
        async (page, deps) => {
          const perfEntries = deps.performance?.performanceEntries || [];
          return attributeCLStoCSS(page, perfEntries);
        },
        (data, opts) => summarizeCLSAttribution(data, opts),
        'CLSAttributor',
      ),
  };

  /**
   * Create a collector instance by type
   *
   * @param {string} type - Collector type (har, coverage, performance, html, font, jsApi, thirdParty, cls)
   * @param {CollectorConfig} config - Collector configuration
   * @param {object} dependencies - Optional dependencies for dependency-based collectors
   * @returns {LabDataCollector|StandaloneCollectorAdapter} Collector instance
   * @throws {Error} If collector type is unknown
   */
  static createCollector(type, config, dependencies = {}) {
    const factory = this.collectorRegistry[type];
    if (!factory) {
      throw new Error(`Unknown collector type: ${type}`);
    }
    return factory(config, dependencies);
  }

  /**
   * Get list of all registered collector types
   * @returns {string[]} Array of collector type names
   */
  static getAvailableTypes() {
    return Object.keys(this.collectorRegistry);
  }

  /**
   * Check if collector type exists
   * @param {string} type - Collector type to check
   * @returns {boolean} True if collector type is registered
   */
  static hasCollector(type) {
    return type in this.collectorRegistry;
  }
}
