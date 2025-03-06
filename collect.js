import collectHar from './tools/har.js';
import collectPsi from './tools/psi.js';
import { estimateTokenSize } from './utils.js';

export default async function collectArtifacts(pageUrl, deviceType) {
  // Perform data collection before running to model, so we don't waste calls if an error occurs
  const { requests, har, perfEntries } = await collectHar(pageUrl, deviceType);
  console.log('Code token size: ~', estimateTokenSize(requests));
  console.log('HAR token size: ~', estimateTokenSize(har));
  // const psi = await collectPsi(pageUrl, deviceType);
  // console.log('PSI token size: ~', estimateTokenSize(psi));

  return {
    har,
    // psi,
    requests,
    perfEntries,
  };
}
