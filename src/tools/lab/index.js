/**
 * Lab Data Collection Orchestrator
 * Coordinates collection of performance data using Puppeteer
 */

import { cacheResults, getCachedResults } from '../../utils.js';
import { setupBrowser, waitForLCP } from './browser-utils.js';
import { startHARRecording, stopHARRecording } from './har-collector.js';
import { collectPerformanceEntries } from './performance-collector.js';
import {
  setupCodeCoverage,
  collectLcpCoverage,
  collectPageCoverage,
} from './coverage-collector.js';
import { collectJSApiData, setupCSPViolationTracking } from './js-api-collector.js';
import { collectFontData } from './font-analyzer.js';
import { extractCwvRelevantHtml } from './html-extractor.js';
import { analyzeThirdPartyScripts } from './third-party-attributor.js';
import { attributeCLStoCSS } from './cls-attributor.js';
import { Result } from '../../core/result.js';
import { ErrorCodes } from '../../core/error-codes.js';
import { CollectorFactory, CollectorConfig } from '../../core/factories/collector-factory.js';

/**
 * Main Lab Data Collection Function
 * Orchestrates all lab data collectors (HAR, performance entries, HTML, fonts, coverage, etc.)
 *
 * @param {String} pageUrl - URL to analyze
 * @param {String} deviceType - Device type ('mobile' or 'desktop')
 * @param {Object} options - Collection options
 * @param {Boolean} options.skipCache - Skip cached results
 * @param {Boolean} options.blockRequests - Block certain requests
 * @param {Boolean} options.collectHar - Whether to collect HAR data
 * @param {Boolean} options.collectCoverage - Whether to collect coverage data
 * @return {Promise<Result>} Collection result with all data
 */
export async function collect(pageUrl, deviceType, { skipCache, blockRequests, collectHar = true, collectCoverage = true }) {
  const startTime = Date.now();
  const dataQualityWarnings = []; // Track partial failures for data quality reporting

  // Load cached artifacts
  let harFile = getCachedResults(pageUrl, deviceType, 'har');
  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  let fontData = getCachedResults(pageUrl, deviceType, 'fonts');
  let jsApi = getCachedResults(pageUrl, deviceType, 'jsapi');
  let coverageData = getCachedResults(pageUrl, deviceType, 'coverage');
  let thirdPartyAnalysis = getCachedResults(pageUrl, deviceType, 'third-party');
  let clsAttribution = getCachedResults(pageUrl, deviceType, 'cls-attribution');

  // Determine what we need to collect in this pass
  const needPerf = !perfEntries || skipCache;
  const needHtml = !fullHtml || skipCache;
  const needFonts = !fontData || skipCache;
  const needJsApi = !jsApi || skipCache;
  const needHar = collectHar && (!harFile || skipCache);
  const needCoverage = collectCoverage && (!coverageData || skipCache);

  // If nothing is needed, return from cache only what's relevant
  if (!needPerf && !needHtml && !needFonts && !needJsApi && !needHar && !needCoverage) {
    // Extract summary from cached CLS attribution if it exists
    const clsAttributionSummary = clsAttribution?.summary || clsAttribution || null;

    // Create factory config for summarization
    const config = new CollectorConfig(deviceType);

    return Result.ok(
      {
        har: collectHar ? harFile : null,
        harSummary: collectHar && harFile
          ? CollectorFactory.createCollector('har', config).summarize(harFile, { thirdPartyAnalysis, pageUrl, coverageData })
          : null,
        perfEntries,
        perfEntriesSummary: CollectorFactory.createCollector('performance', config).summarize(perfEntries, { clsAttribution: clsAttributionSummary }),
        fullHtml,
        fontData,
        fontDataSummary: fontData
          ? CollectorFactory.createCollector('font', config).summarize(fontData)
          : null,
        jsApi,
        coverageData: collectCoverage ? coverageData : null,
        coverageDataSummary: collectCoverage && coverageData
          ? CollectorFactory.createCollector('coverage', config).summarize(coverageData)
          : null,
        thirdPartyAnalysis,
        clsAttribution: clsAttributionSummary,
        fromCache: true,
      },
      { source: 'cache' }
    );
  }

  // Setup browser
  const { browser, page } = await setupBrowser(deviceType, blockRequests);

  // Setup code coverage tracking only if requested
  if (needCoverage) {
    await setupCodeCoverage(page);
  }

  // Setup CSP violation tracking
  await setupCSPViolationTracking(page);

  // Start HAR recording only if requested
  let har = null;
  if (needHar) {
    har = await startHARRecording(page);
  }

  // Navigate to page
  try {
    await page.goto(pageUrl, {
      timeout: 120_000,
      waitUntil: 'domcontentloaded',
    });
  } catch (err) {
    console.error('Page did not idle after 120s. Force continuing.', err.message);
  }

  // Collect coverage data at LCP
  try {
    await waitForLCP(page);
  } catch (err) {
    console.error('LCP not found after 30s. Force continuing.', err.message);
  }

  let lcpCoverageData = null;
  if (needCoverage) {
    try {
      lcpCoverageData = await collectLcpCoverage(page, pageUrl, deviceType);
    } catch (err) {
      console.warn(`⚠️  LCP coverage collection failed: ${err.message}`);
      dataQualityWarnings.push({
        source: 'lcp-coverage',
        error: err.message,
        impact: 'LCP-specific coverage data unavailable',
      });
      lcpCoverageData = null;
    }
  }

  // Waiting for page to finish loading
  try {
    await page.waitForNetworkIdle({ concurrency: 0, idleTime: 1_000 });
  } catch (err) {
    // Do nothing
  }

  // Collect performance data
  if (needPerf) {
    perfEntries = await collectPerformanceEntries(page);
    cacheResults(pageUrl, deviceType, 'perf', perfEntries);
  }

  // Collect HAR data
  if (needHar) {
    harFile = await stopHARRecording(har);
  }

  // Enhanced attribution: Third-party scripts (Priority 1)
  thirdPartyAnalysis = null;
  if (needHar && harFile && perfEntries) {
    try {
      thirdPartyAnalysis = analyzeThirdPartyScripts(harFile.log.entries, perfEntries, pageUrl);
      cacheResults(pageUrl, deviceType, 'third-party', thirdPartyAnalysis);
    } catch (err) {
      console.warn(`⚠️  Third-party analysis failed: ${err.message}`);
      dataQualityWarnings.push({
        source: 'third-party-analysis',
        error: err.message,
        impact: 'Third-party script recommendations may be incomplete',
      });
      thirdPartyAnalysis = null;
    }
  }

  // Enhanced attribution: CLS-to-CSS mapping (Priority 2)
  clsAttribution = null;
  if (needPerf && perfEntries && perfEntries.layoutShifts && perfEntries.layoutShifts.length > 0) {
    try {
      clsAttribution = await attributeCLStoCSS(perfEntries.layoutShifts, page);
      const config = new CollectorConfig(deviceType);
      const clsSummary = CollectorFactory.createCollector('cls', config).summarize(clsAttribution);
      cacheResults(pageUrl, deviceType, 'cls-attribution', { detailed: clsAttribution, summary: clsSummary });
    } catch (err) {
      console.warn(`⚠️  CLS attribution failed: ${err.message}`);
      dataQualityWarnings.push({
        source: 'cls-attribution',
        error: err.message,
        impact: 'CLS cause identification unavailable',
      });
      clsAttribution = null;
    }
  }

  // Collect HTML content (CWV-relevant sections only)
  if (needHtml) {
    fullHtml = await extractCwvRelevantHtml(page);
    cacheResults(pageUrl, deviceType, 'html', fullHtml);
  }

  // Collect font data (consolidated analysis using document.fonts API)
  if (needFonts) {
    try {
      fontData = await collectFontData(page);
      cacheResults(pageUrl, deviceType, 'fonts', fontData);
    } catch (err) {
      console.warn(`⚠️  Font analysis failed: ${err.message}`);
      dataQualityWarnings.push({
        source: 'font-analysis',
        error: err.message,
        impact: 'Font optimization recommendations may be incomplete',
      });
      fontData = null;
    }
  }

  // Collect JavaScript API data (CSP violations, etc.)
  if (needJsApi) {
    jsApi = await collectJSApiData(page);
    cacheResults(pageUrl, deviceType, 'jsapi', jsApi);
  }

  // Collect code coverage data
  if (needCoverage) {
    try {
      coverageData = await collectPageCoverage(page, pageUrl, deviceType, lcpCoverageData);
    } catch (err) {
      console.error('Error collecting page coverage data:', err.message);
      coverageData = {};
    }
  }

  // Close browser and save results
  await browser.close();

  // Create factory config for summarization
  const config = new CollectorConfig(deviceType);

  // Generate performance summary (with Priority 2 CLS attribution)
  let perfEntriesSummary = CollectorFactory.createCollector('performance', config).summarize(perfEntries, { clsAttribution });
  cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);

  // Generate HAR summary (with Priority 1 third-party analysis, pageUrl, and coverage data)
  const harSummary = collectHar && harFile
    ? CollectorFactory.createCollector('har', config).summarize(harFile, { thirdPartyAnalysis, pageUrl, coverageData })
    : null;
  if (collectHar && harFile) {
    cacheResults(pageUrl, deviceType, 'har', harFile);
    cacheResults(pageUrl, deviceType, 'har', harSummary);
  }

  // Generate font analysis summary
  const fontDataSummary = fontData
    ? CollectorFactory.createCollector('font', config).summarize(fontData)
    : null;
  if (fontData) {
    cacheResults(pageUrl, deviceType, 'fonts', fontDataSummary);
  }

  // Generate coverage usage summary
  const coverageDataSummary = collectCoverage && coverageData
    ? CollectorFactory.createCollector('coverage', config).summarize(coverageData)
    : null;
  if (collectCoverage && coverageData) {
    cacheResults(pageUrl, deviceType, 'coverage', coverageData);
    cacheResults(pageUrl, deviceType, 'coverage', coverageDataSummary);
  }

  // Return collected data
  return Result.ok(
    {
      har: collectHar ? harFile : null,
      harSummary,
      perfEntries,
      perfEntriesSummary,
      fullHtml,
      fontData,
      fontDataSummary,
      jsApi,
      coverageData: collectCoverage ? coverageData : null,
      coverageDataSummary,
      thirdPartyAnalysis,
      clsAttribution,
    },
    {
      source: 'fresh',
      duration: Date.now() - startTime,
      dataQuality: dataQualityWarnings.length === 0 ? 'complete' : 'partial',
      warnings: dataQualityWarnings,
    }
  );
}
