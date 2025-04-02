import { cacheResults, getCachedResults } from '../utils.js';
import rules from '../rules/index.js';

export function summarize(rulesResults) {
  const failedRules = rulesResults.filter((r) => r && !r.passing);
  failedRules.sort((a, b) => a.time - b.time);
  return failedRules
    .map((r) => `- Failed ${r.time ? `${r.time}ms ` : ''}${r.message}: ${r.recommendation}`)
    .join('\n');
}

export async function applyRules(pageUrl, deviceType, { outputSuffix }, { crux, psi, har, perfEntries, resources, fullHtml, jsApi, report }) {
  // Sort report.data by start time
  report.data.sort((a, b) => a.start - b.start);
  // Clone report.data and sort by end time
  report.dataSortedByEnd = report.data.slice().sort((a, b) => a.end - b.end);

  const json = rules.map((r) => {
    try {
      // TODO: r(report, rawData)
      return r({ summary: { url: pageUrl, type: deviceType }, crux, psi, har, perfEntries, resources, fullHtml, jsApi, report });
    } catch (error) {
      console.error('❌ Error applying a rule', error);
      return null;
    }
  }).flat();

  const path = cacheResults(pageUrl, deviceType, 'rules', json, outputSuffix);
  const summary = summarize(json);
  const summaryPath = cacheResults(pageUrl, deviceType, 'rules', summary, outputSuffix);
  return { full: json, summary, path, summaryPath };
}
