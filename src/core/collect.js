import { collect as collectCrux } from '../tools/crux.js';
import { collect as collectHar } from '../tools/har.js';
import { collect as collectPsi } from '../tools/psi.js';
import { estimateTokenSize } from '../utils.js';

export default async function collectArtifacts(pageUrl, deviceType, skipCache) {
  const { full: crux, summary: cruxSummary } = await collectCrux(pageUrl, deviceType, skipCache);
  console.log('✅ Processed CrUX data. Estimated token size: ~', estimateTokenSize(crux));
  const { full: psi, summary: psiSummary } = await collectPsi(pageUrl, deviceType, skipCache);
  console.log('✅ Processed PSI data. Estimated token size: ~', estimateTokenSize(psi));
  const { resources, har, harSummary, perfEntries, perfEntriesSummary, mainHeaders } = await collectHar(pageUrl, deviceType, skipCache);
  console.log('✅ Processed HAR data. Estimated token size: ~', estimateTokenSize(har));
  console.log('✅ Processed project code. Estimated token size: ~', estimateTokenSize(resources));
  
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
    mainHeaders,
  };
}
