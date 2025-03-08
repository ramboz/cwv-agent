import collectHar from '../tools/har.js';
import collectPsi from '../tools/psi.js';
import collectCrux from '../tools/crux.js';
import { estimateTokenSize } from '../utils.js';

export default async function collectArtifacts(pageUrl, deviceType, skipCache) {
  // Perform data collection before running to model, so we don't waste calls if an error occurs
  const { resources, har, perfEntries } = await collectHar(pageUrl, deviceType, skipCache);
  console.log('Code token size: ~', estimateTokenSize(resources));
  console.log('HAR token size: ~', estimateTokenSize(har));
  const crux = await collectCrux(pageUrl, deviceType, skipCache);
  console.log('CrUX token size: ~', estimateTokenSize(crux));
  const psi = await collectPsi(pageUrl, deviceType, skipCache);
  console.log('PSI token size: ~', estimateTokenSize(psi));
  
  return {
    har,
    psi,
    resources,
    perfEntries,
    crux,
  };
}
