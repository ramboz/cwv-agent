import { prettify } from 'htmlfy'
import { cacheResults, getCachedResults, getCachePath } from '../utils.js';
import rules from '../rules/index.js';

function prettifyWithOffset(str, offset = 4, code) {
  // Use the provided offset to dynamically indent each line of the prettified HTML
  let prefix = '';
  let suffix = '';
  if (code) {
    prefix = `${' '.repeat(offset)}\`\`\`html\n`;
    suffix = `\n${' '.repeat(offset)}\`\`\``;
  }
  return prefix + prettify(str).split(/\n/).map((line) => `${' '.repeat(offset)}${line}`).join('\n') + suffix;
}

function details(rule) {
  if (rule.url) {
    return `Url: ${rule.url}`;
  } else if (rule.urls) {
    return `Urls: ${rule.urls.join(',')}`;
  } else if (rule.element) {
    return `Element:\n${prettifyWithOffset(rule.element, 4, 'html')}`;
  } else if (rule.elements) {
    return `Elements:\n${rule.elements.map((el) => prettifyWithOffset(el, 4, 'html')).join('\n')}`;
  } else if (rule.name) {
    return `Name: ${rule.name}`;
  }
  return '';
}

export function summarize(rulesResults) {
  const failedRules = rulesResults.filter((r) => r && !r.passing);
  failedRules.sort((a, b) => a.time - b.time);
  return failedRules
    .map((r) => `
- ${r.message}${r.time ? ` at ${r.time}ms` : ''}:
  - Recommendation: ${r.recommendation}
  ${details(r) ? `- ${details(r)}` : ''}${r.initiator ? `\n  - Initiator: ${r.initiator}` : ''}`)
    .join('\n');
}

export async function applyRules(pageUrl, deviceType, { skipCache, outputSuffix }, { crux, psi, har, perfEntries, resources, fullHtml, jsApi, report }) {
  if (!skipCache) {
    const cache = getCachedResults(pageUrl, deviceType, 'rules', outputSuffix);
    if (cache) {
      return {
        full: cache,
        summary: summarize(cache.data),
        path: getCachePath(pageUrl, deviceType, 'rules', outputSuffix),
        summaryPath: getCachePath(pageUrl, deviceType, 'rules', outputSuffix, true),
        fromCache: true,
      };
    }
  }

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

  const path = cacheResults(pageUrl, deviceType, 'rules', {
    url: pageUrl,
    type: deviceType,
    data: json,
  }, outputSuffix);
  const summary = summarize(json);
  const summaryPath = cacheResults(pageUrl, deviceType, 'rules', summary, outputSuffix);
  return { full: json, summary, path, summaryPath };
}
