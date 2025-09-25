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
  
  // Skip prettification for very large strings to prevent hanging
  if (str.length > 10000) {
    return prefix + str + suffix;
  }
  
  try {
    const prettified = prettify(str);
    return prefix + prettified.split(/\n/).map((line) => `${' '.repeat(offset)}${line}`).join('\n') + suffix;
  } catch (error) {
    console.error('Error prettifying HTML:', error);
    // Return the original string if prettify fails
    return prefix + str + suffix;
  }
}

function details(rule) {
  if (rule.url) {
    return `Url: ${rule.url}`;
  } else if (rule.urls) {
    return `Urls: ${rule.urls.join(',')}`;
  } else if (rule.element) {
    try {
      return `Element:\n${prettifyWithOffset(rule.element, 4, 'html')}`;
    } catch (error) {
      console.error('Error processing element:', error);
      return `Element: [Error processing element]`;
    }
  } else if (rule.elements) {
    try {
      return `Elements:\n${rule.elements.map((el) => prettifyWithOffset(el, 4, 'html')).join('\n')}`;
    } catch (error) {
      console.error('Error processing elements:', error);
      return `Elements: [Error processing elements]`;
    }
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

  // Check if report.data exists and is an array
  if (!report.data || !Array.isArray(report.data)) {
    report.data = [];
  }
  
  // Limit data size if it's too large to prevent hanging
  const maxEntries = 10000;
  if (report.data.length > maxEntries) {
    report.data = report.data.slice(0, maxEntries);
  }
  
  // Sort report.data by start time
  report.data.sort((a, b) => a.start - b.start);
  
  // Clone report.data and sort by end time
  report.dataSortedByEnd = report.data.slice().sort((a, b) => a.end - b.end);

  // Limit other data sizes if necessary
  if (har?.log?.entries?.length > 10000) {
    har.log.entries = har.log.entries.slice(0, 10000);
  }
  if (perfEntries?.length > 10000) {
    perfEntries = perfEntries.slice(0, 10000);
  }
  if (report.data.length > 10000) {
    report.data = report.data.slice(0, 10000);
  }
  
  const json = rules.map((r, index) => {
    try {
      const result = r({ summary: { url: pageUrl, type: deviceType }, crux, psi, har, perfEntries, resources, fullHtml, jsApi, report });
      return result;
    } catch (error) {
      console.error(`❌ Error applying rule ${index + 1}:`, error);
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
