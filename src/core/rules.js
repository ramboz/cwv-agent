import { getLabData } from './collect.js';
import merge from '../tools/merge.js';
import { readCache, estimateTokenSize } from '../utils.js';
import { applyRules } from '../tools/rules.js';

export default async function rulesAction(pageUrl, deviceType, options) {
  let har, perfEntries, fullHtml, jsApi;
  let report = await readCache(pageUrl, deviceType, 'merge');
  if (!report || options.skipCache) {
    ({ har, perfEntries, fullHtml, jsApi } = await getLabData(pageUrl, deviceType, { ...options, skipCache: true }));
    merge(pageUrl, deviceType);
    report = await readCache(pageUrl, deviceType, 'merge');
  } else {
    ({ har, perfEntries, fullHtml, jsApi } = await getLabData(pageUrl, deviceType, { ...options, skipCache: false }));
  }

  const result = await applyRules(pageUrl, deviceType, options, { har, perfEntries, fullHtml, jsApi, report });
  if (result.fromCache) {
    console.log('✓ Loaded rules from cache. Estimated token size: ~', estimateTokenSize(result.summary, options.model));
  } else {
    console.log('✅ Processed rules. Estimated token size: ~', estimateTokenSize(result.summary, options.model));
  }
  return result;
}
