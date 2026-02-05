import { collect as collectCrux } from '../tools/crux.js';
import { collect as collectLabData } from '../tools/lab/index.js';
import { collect as collectPsi } from '../tools/psi.js';
import { collect as collectCode, detectFramework } from '../tools/code.js';
import { collectRUMData, summarizeRUM } from '../tools/rum.js';
import { estimateTokenSize } from '../utils.js';

export async function getCrux(pageUrl, deviceType, options) {
  const result = await collectCrux(pageUrl, deviceType, options);

  // Handle Result pattern
  if (result.isErr()) {
    if (result.error.code === 'MISSING_DATA') {
      console.warn('ℹ️  No CrUX data for that page.');
    } else {
      console.error(`❌ Failed to collect CrUX data: ${result.error.message}`);
    }
    return { full: null, summary: null };
  }

  // Extract data from successful Result
  const { full, summary } = result.data;
  const { source } = result.metadata;

  if (source === 'cache') {
    console.log('✓ Loaded CrUX data from cache. Estimated token size: ~', estimateTokenSize(full, options.model));
  } else {
    console.log('✅ Processed CrUX data. Estimated token size: ~', estimateTokenSize(full, options.model));
  }

  return { full, summary };
}

export async function getRUM(pageUrl, deviceType, options) {
  // Check if RUM domain key is available
  const rumDomainKey = options.rumDomainKey || process.env.RUM_DOMAIN_KEY;

  if (!rumDomainKey) {
    console.log('ℹ️  Skipping RUM data collection (no domain key provided). Use --rum-domain-key or set RUM_DOMAIN_KEY env variable.');
    return { data: null, summary: null };
  }

  const result = await collectRUMData(pageUrl, deviceType, options);

  // Handle Result pattern
  if (result.isErr()) {
    console.warn(`⚠️  RUM data collection failed: ${result.error.message}`);
    return { data: null, summary: null };
  }

  // Extract data from successful Result
  const data = result.data;
  const { source } = result.metadata;

  // Generate markdown summary for agents
  const summary = summarizeRUM(data);

  if (source === 'cache') {
    console.log('✓ Loaded RUM data from cache. Estimated token size: ~', estimateTokenSize(summary, options.model));
  } else {
    console.log('✅ Processed RUM data. Estimated token size: ~', estimateTokenSize(summary, options.model));
  }

  return { data, summary };
}

export async function getPsi(pageUrl, deviceType, options) {
  const result = await collectPsi(pageUrl, deviceType, options);

  // Handle Result pattern
  if (result.isErr()) {
    console.error(`❌ PSI data collection failed: ${result.error.message}`);
    return { full: null, summary: null };
  }

  // Extract data from successful Result
  const { full, summary } = result.data;
  const { source } = result.metadata;

  if (source === 'cache') {
    console.log('✓ Loaded PSI data from cache. Estimated token size: ~', estimateTokenSize(full, options.model));
  } else {
    console.log('✅ Processed PSI data. Estimated token size: ~', estimateTokenSize(full, options.model));
  }

  return { full, summary };
}

export async function getLabData(pageUrl, deviceType, options) {
  // Check environment variables to skip heavy data collection
  const skipHar = process.env.SKIP_HAR_ANALYSIS === 'true';
  const skipPerfEntries = process.env.SKIP_PERFORMANCE_ENTRIES === 'true';
  const skipFullHtml = process.env.SKIP_FULL_HTML === 'true';

  // In light mode, skip expensive collectors (Coverage and Code)
  const isLightMode = options.mode === 'light';
  const skipCoverage = process.env.SKIP_COVERAGE_ANALYSIS === 'true' || isLightMode;
  const skipCode = process.env.SKIP_CODE_ANALYSIS === 'true' || isLightMode;

  if (skipHar && skipPerfEntries && skipFullHtml && skipCoverage && skipCode) {
    console.log('🚀 Skipping heavy data collection due to environment variables');
    return { 
      har: null, harSummary: null, 
      perfEntries: null, perfEntriesSummary: null, 
      fullHtml: null, fontData: null, fontDataSummary: null, jsApi: null, 
      coverageData: null, coverageDataSummary: null 
    };
  }

  const labResult = await collectLabData(pageUrl, deviceType, options);

  // Handle Result pattern - LAB collector now returns Result
  if (labResult.isErr()) {
    console.error(`❌ LAB data collection failed: ${labResult.error.message}`);
    return {
      har: null, harSummary: null,
      perfEntries: null, perfEntriesSummary: null,
      fullHtml: null, fontData: null, fontDataSummary: null, jsApi: null,
      coverageData: null, coverageDataSummary: null
    };
  }

  // Extract data and metadata from successful Result
  const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, fontData, fontDataSummary, jsApi, coverageData, coverageDataSummary, fromCache } = labResult.data;
  const { source, warnings } = labResult.metadata;

  // Log warnings if any partial failures occurred
  if (warnings && warnings.length > 0) {
    warnings.forEach(w => {
      console.warn(`⚠️  ${w.source}: ${w.error} - ${w.impact}`);
    });
  }

  if (source === 'cache' || fromCache) {
    if (!skipHar) console.log('✓ Loaded HAR data from cache. Estimated token size: ~', estimateTokenSize(har, options.model));
    if (!skipPerfEntries) console.log('✓ Loaded Performance Entries data from cache. Estimated token size: ~', estimateTokenSize(perfEntries, options.model));
    if (!skipFullHtml) console.log('✓ Loaded full rendered HTML markup from cache. Estimated token size: ~', estimateTokenSize(fullHtml, options.model));
    console.log('✓ Loaded Font data from cache. Estimated token size: ~', estimateTokenSize(fontData, options.model));
    if (!skipCode) console.log('✓ Loaded JS API data from cache. Estimated token size: ~', estimateTokenSize(jsApi, options.model));
    if (!skipCoverage) console.log('✓ Loaded coverage data from cache. Estimated token size: ~', estimateTokenSize(coverageData, options.model));
  } else {
    if (!skipHar) console.log('✅ Processed HAR data. Estimated token size: ~', estimateTokenSize(har, options.model));
    if (!skipPerfEntries) console.log('✅ Processed Performance Entries data. Estimated token size: ~', estimateTokenSize(perfEntries, options.model));
    if (!skipFullHtml) console.log('✅ Processed full rendered HTML markup. Estimated token size: ~', estimateTokenSize(fullHtml, options.model));
    console.log('✅ Processed Font data. Estimated token size: ~', estimateTokenSize(fontData, options.model));
    if (!skipCode) console.log('✅ Processed JS API data. Estimated token size: ~', estimateTokenSize(jsApi, options.model));
    if (!skipCoverage) console.log('✅ Processed coverage data. Estimated token size: ~', estimateTokenSize(coverageData, options.model));
  }
  return { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, fontData, fontDataSummary, jsApi, coverageData, coverageDataSummary };
}

export async function getCode(pageUrl, deviceType, requests, options) {
  const result = await collectCode(pageUrl, deviceType, requests, options);

  // Handle Result pattern
  if (result.isErr()) {
    console.error(`❌ Code collection failed: ${result.error.message}`);
    return { codeFiles: {}, stats: { total: 0, fromCache: 0, failed: 0, successful: 0 } };
  }

  // Extract data from successful Result
  const { codeFiles, stats } = result.data;
  const { source } = result.metadata;

  if (source === 'cache') {
    console.log('✓ Loaded code from cache. Estimated token size: ~', estimateTokenSize(codeFiles, options.model));
  } else if (source === 'partial-cache') {
    console.log(`✓ Partially loaded code from cache (${stats.fromCache}/${stats.total}). Estimated token size: ~`, estimateTokenSize(codeFiles, options.model));
  } else if (stats.failed > 0) {
    console.warn(`⚠️  Code collection had ${stats.failed} failures. Estimated token size: ~`, estimateTokenSize(codeFiles, options.model));
  } else {
    console.log('✅ Processed project code. Estimated token size: ~', estimateTokenSize(codeFiles, options.model));
  }

  return { codeFiles, stats };
}

/**
 * Collect all artifacts for a page.
 *
 * NOTE: This is a legacy wrapper used by the 'collect' action in actions.js.
 * The main agent flow (orchestrator.js) calls getCrux/getPsi/getLabData/getCode directly
 * with proper gating and light mode support.
 *
 * This function does NOT collect code files - that's handled by orchestrator.js with gating.
 *
 * @param {string} pageUrl - URL to analyze
 * @param {string} deviceType - 'mobile' or 'desktop'
 * @param {Object} options - Collection options
 * @returns {Promise<Object>} Collected artifacts
 */
export default async function collectArtifacts(pageUrl, deviceType, options) {
  const { full: crux, summary: cruxSummary } = await getCrux(pageUrl, deviceType, options);
  const { full: psi, summary: psiSummary } = await getPsi(pageUrl, deviceType, options);
  const { data: rum, summary: rumSummary } = await getRUM(pageUrl, deviceType, options);

  const {
    har,
    harSummary,
    perfEntries,
    perfEntriesSummary,
    fullHtml,
    fontData,
    fontDataSummary,
    jsApi,
    coverageData,
    coverageDataSummary
  } = await getLabData(pageUrl, deviceType, options);

  const requests = har?.log?.entries?.map((e) => e.request.url) || [];
  const frameworks = detectFramework(fullHtml || '', requests || []);
  console.log(`🔍 Detected frameworks: ${frameworks.join(', ')}`);

  return {
    har,
    harSummary,
    psi,
    psiSummary,
    resources: {}, // Note: Code collection is handled by orchestrator.js, not here
    perfEntries,
    perfEntriesSummary,
    crux,
    cruxSummary,
    rum,
    rumSummary,
    fullHtml,
    fontData,
    fontDataSummary,
    jsApi,
    coverageData,
    coverageDataSummary,
    frameworks,
  };
}
