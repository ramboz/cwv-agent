import { getHar } from './collect.js';
import merge from '../tools/merge.js';
import { readCache } from '../utils.js';
import { applyRules } from '../tools/rules.js';

export default async function rulesAction(pageUrl, deviceType, options) {
  let har, perfEntries, fullHtml, jsApi;
  let report = await readCache(pageUrl, deviceType, 'merge');
  if (!report || options.skipCache) {
    ({ har, perfEntries, fullHtml, jsApi } = await getHar(pageUrl, deviceType, { skipCache: true }));
    merge(pageUrl, deviceType);
    report = await readCache(pageUrl, deviceType, 'merge');
  } else {
    ({ har, perfEntries, fullHtml, jsApi } = await getHar(pageUrl, deviceType, { skipCache: false }));
  }

  const result = await applyRules(pageUrl, deviceType, options, { har, perfEntries, fullHtml, jsApi, report });
  console.group('Failed rules:');
  console.log(result.summary);
  console.groupEnd();
  console.group('Rules saved to:');
  console.log(result.path);
  console.log(result.summaryPath);
  console.groupEnd();
  return result;
}
