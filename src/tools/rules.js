import { prettify } from 'htmlfy'
import { cacheResults } from '../utils.js';
import rules from '../rules/index.js';

function prettifyWithOffset(str, offset = 4) {
  // Use the provided offset to dynamically indent each line of the prettified HTML
  return prettify(str).split(/\n/).map((line) => `${' '.repeat(offset)}${line}`).join('\n');
}

function details(rule) {
  if (rule.url) {
    return `Url: ${rule.url}`;
  } else if (rule.urls) {
    return `Urls: ${rule.urls.join(',')}`;
  } else if (rule.element) {
    return `Element:\n${prettifyWithOffset(rule.element)}`;
  } else if (rule.elements) {
    return `Elements:\n${rule.elements.map((el) => `${prettifyWithOffset(el)}\n`)}`;
  }
}

export function summarize(rulesResults) {
  const failedRules = rulesResults.filter((r) => r && !r.passing);
  failedRules.sort((a, b) => a.time - b.time);
  return failedRules
    .map((r) => `
- ${r.message}${r.time ? ` at ${r.time}ms` : ''}:
  - ${details(r)}
  - Recommendation: ${r.recommendation}`)
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
  }).flat().filter(r => r);

  const path = cacheResults(pageUrl, deviceType, 'rules', json, outputSuffix);
  const summary = summarize(json);
  const summaryPath = cacheResults(pageUrl, deviceType, 'rules', summary, outputSuffix);
  return { full: json, summary, path, summaryPath };
}
