import { collect as collectCrux } from '../tools/crux.js';
import { collect as collectLabData } from '../tools/lab/index.js';
import { collect as collectPsi } from '../tools/psi.js';
import { collect as collectCode } from '../tools/code.js';
import { estimateTokenSize } from '../utils.js';

export async function getCrux(pageUrl, deviceType, options) {
  const { full, summary, fromCache } = await collectCrux(pageUrl, deviceType, options);
  if (full.error && full.error.code === 404) {
    console.warn('ℹ️  No CrUX data for that page.');
  } else if (full.error) {
    console.error('❌ Failed to collect CrUX data.', full.error.message);
  } else if (fromCache) {
    console.log('✓ Loaded CrUX data from cache. Estimated token size: ~', estimateTokenSize(full, options.model));
  } else {
    console.log('✅ Processed CrUX data. Estimated token size: ~', estimateTokenSize(full, options.model));
  }
  return { full, summary };
}

export async function getPsi(pageUrl, deviceType, options) {
  const { full, summary, fromCache } = await collectPsi(pageUrl, deviceType, options);
  if (fromCache) {
    console.log('✓ Loaded PSI data from cache. Estimated token size: ~', estimateTokenSize(full, options.model));
  } else {
    console.log('✅ Processed PSI data. Estimated token size: ~', estimateTokenSize(full, options.model));
  }
  return { full, summary };
}

export async function getLabData(pageUrl, deviceType, options) {
  const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi, coverageData, coverageDataSummary, fromCache } = await collectLabData(pageUrl, deviceType, options);
  if (fromCache) {
    console.log('✓ Loaded HAR data from cache. Estimated token size: ~', estimateTokenSize(har, options.model));
    console.log('✓ Loaded Performance Entries data from cache. Estimated token size: ~', estimateTokenSize(perfEntries, options.model));
    console.log('✓ Loaded full rendered HTML markup from cache. Estimated token size: ~', estimateTokenSize(fullHtml, options.model));
    console.log('✓ Loaded JS API data from cache. Estimated token size: ~', estimateTokenSize(jsApi, options.model));
    console.log('✓ Loaded coverage data from cache. Estimated token size: ~', estimateTokenSize(coverageData, options.model));
  } else {
    console.log('✅ Processed HAR data. Estimated token size: ~', estimateTokenSize(har, options.model));
    console.log('✅ Processed Performance Entries data. Estimated token size: ~', estimateTokenSize(perfEntries, options.model));
    console.log('✅ Processed full rendered HTML markup. Estimated token size: ~', estimateTokenSize(fullHtml, options.model));
    console.log('✅ Processed JS API data. Estimated token size: ~', estimateTokenSize(jsApi, options.model));
    console.log('✅ Processed coverage data. Estimated token size: ~', estimateTokenSize(coverageData, options.model));
  }
  return { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi, coverageData, coverageDataSummary };
}

export async function getCode(pageUrl, deviceType, requests, options) {
  const { codeFiles, stats } = await collectCode(pageUrl, deviceType, requests, options);
  if (stats.fromCache === stats.total) {
    console.log('✓ Loaded code from cache. Estimated token size: ~', estimateTokenSize(codeFiles, options.model));
  } else if (stats.fromCache > 0) {
    console.log(`✓ Partially loaded code from cache (${stats.fromCache}/${stats.total}). Estimated token size: ~`, estimateTokenSize(codeFiles, options.model));
  } else if (stats.failed > 0) {
    console.error('❌ Failed to collect all project code. Estimated token size: ~', estimateTokenSize(codeFiles, options.model));
  } else {
    console.log('✅ Processed project code. Estimated token size: ~', estimateTokenSize(codeFiles, options.model));
  }
  return { codeFiles, stats };
}

export default async function collectArtifacts(pageUrl, deviceType, options) {
  const { full: crux, summary: cruxSummary } = await getCrux(pageUrl, deviceType, options);
  const { full: psi, summary: psiSummary } = await getPsi(pageUrl, deviceType, options);

  // Collect lab data based on options (respect lazy heavy flags)
  const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi, coverageData, coverageDataSummary } = await getLabData(pageUrl, deviceType, options);
  const requests = har.log.entries.map((e) => e.request.url);

  const { codeFiles: resources } = await getCode(pageUrl, deviceType, requests, options);

  return {
    har,
    harSummary,
    psi,
    psiSummary,
    resources,
    perfEntries,
    perfEntriesSummary,
    crux,
    cruxSummary,
    fullHtml,
    jsApi,
    coverageData,
    coverageDataSummary,
  };
}
