/**
 * Rules Action Handler
 * 
 * CLI action for running rules-based analysis on a page.
 * This is separate from src/tools/rules.js which contains the actual rules engine.
 */

import { getLabData } from './collect.js';
import merge from '../tools/merge.js';
import { getCachedResults, estimateTokenSize } from '../utils.js';
import { applyRules } from '../tools/rules.js';

export default async function rulesAction(pageUrl, deviceType, options) {
  let har, perfEntries, fullHtml, fontData, jsApi;
  let report = getCachedResults(pageUrl, deviceType, 'merge');
  if (!report || options.skipCache) {
    ({ har, perfEntries, fullHtml, fontData, jsApi } = await getLabData(pageUrl, deviceType, { ...options, skipCache: true }));
    merge(pageUrl, deviceType);
    report = getCachedResults(pageUrl, deviceType, 'merge');
  } else {
    ({ har, perfEntries, fullHtml, fontData, jsApi } = await getLabData(pageUrl, deviceType, { ...options, skipCache: false }));
  }

  const result = await applyRules(pageUrl, deviceType, options, { har, perfEntries, fullHtml, fontData, jsApi, report });
  if (result.fromCache) {
    console.log('✓ Loaded rules from cache. Estimated token size: ~', estimateTokenSize(result.summary, options.model));
  } else {
    console.log('✅ Processed rules. Estimated token size: ~', estimateTokenSize(result.summary, options.model));
  }
  console.group('Failed rules:');
  console.log(result.summary);
  console.groupEnd();
  console.group('Rules saved to:');
  console.log(result.path);
  console.log(result.summaryPath);
  console.groupEnd();
  return result;
}
