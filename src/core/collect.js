import { collect as collectCrux } from '../tools/crux.js';
import { collect as collectHar } from '../tools/har.js';
import { collect as collectPsi } from '../tools/psi.js';
import { collect as collectCode } from '../tools/code.js';
import { estimateTokenSize } from '../utils.js';

export async function getCrux(pageUrl, deviceType, options) {
  const { full, summary } = await collectCrux(pageUrl, deviceType, options);
  if (full.error && full.error.code === 404) {
    console.warn('ℹ️  No CrUX data for that page.');
  } else if (full.error) {
    console.error('❌ Failed to collect CrUX data.', full.error.message);
  } else {
    console.log('✅ Processed CrUX data. Estimated token size: ~', estimateTokenSize(full));
  }
  return { full, summary };
}

export async function getPsi(pageUrl, deviceType, options) {
  const { full, summary, fromCache } = await collectPsi(pageUrl, deviceType, options);
  if (fromCache) {
    console.log('✓ Loaded PSI data from cache. Estimated token size: ~', estimateTokenSize(full));
  } else {
    console.log('✅ Processed PSI data. Estimated token size: ~', estimateTokenSize(full));
  }
  return { full, summary };
}

export async function getHar(pageUrl, deviceType, options) {
  const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml, fromCache } = await collectHar(pageUrl, deviceType, options);
  if (fromCache) {
    console.log('✓ Loaded HAR data from cache. Estimated token size: ~', estimateTokenSize(har));
    console.log('✓ Loaded Performance Entries data from cache. Estimated token size: ~', estimateTokenSize(perfEntries));
    console.log('✓ Loaded full rendered HTML markup from cache. Estimated token size: ~', estimateTokenSize(fullHtml));
  } else {
    console.log('✅ Processed HAR data. Estimated token size: ~', estimateTokenSize(har));
    console.log('✅ Processed Performance Entries data. Estimated token size: ~', estimateTokenSize(perfEntries));
    console.log('✅ Processed full rendered HTML markup. Estimated token size: ~', estimateTokenSize(fullHtml));
  }
  return { har, harSummary, perfEntries, perfEntriesSummary, fullHtml };
}

export async function getCode(pageUrl, deviceType, requests, options) {
  const { codeFiles, stats } = await collectCode(pageUrl, deviceType, requests, options);
  if (stats.fromCache === stats.total) {
    console.log('✓ Loaded code from cache. Estimated token size: ~', estimateTokenSize(codeFiles));
  } else if (stats.fromCache > 0) {
    console.log(`✓ Partially loaded code from cache (${stats.fromCache}/${stats.total}). Estimated token size: ~`, estimateTokenSize(codeFiles));
  } else if (stats.failed > 0) {
    console.error('❌ Failed to collect all project code');
  } else {
    console.log('✅ Processed project code. Estimated token size: ~', estimateTokenSize(codeFiles));
  }
  return codeFiles;
}

export default async function collectArtifacts(pageUrl, deviceType, options) {
  const { full: crux, summary: cruxSummary } = await getCrux(pageUrl, deviceType, options);
  const { full: psi, summary: psiSummary } = await getPsi(pageUrl, deviceType, options);
  const { har, harSummary, perfEntries, perfEntriesSummary, fullHtml } = await getHar(pageUrl, deviceType, options);
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
  };
}
