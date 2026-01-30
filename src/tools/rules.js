import { prettify } from 'htmlfy'
import { cacheResults, getCachedResults, getCachePath } from '../utils.js';
import rules from '../rules/index.js';
import { DATA_LIMITS } from '../config/thresholds.js';

function prettifyWithOffset(str, offset = 4, code) {
  // Use the provided offset to dynamically indent each line of the prettified HTML
  let prefix = '';
  let suffix = '';
  if (code) {
    prefix = `${' '.repeat(offset)}\`\`\`html\n`;
    suffix = `\n${' '.repeat(offset)}\`\`\``;
  }
  
  // Skip prettification for very large strings to prevent hanging
  if (str.length > DATA_LIMITS.MAX_HTML_LENGTH) {
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

/**
 * Phase A Optimization: Extract minimal info from HTML elements instead of prettifying full HTML
 */
function extractElementInfo(htmlString) {
  // Handle non-string inputs gracefully
  if (typeof htmlString !== 'string') {
    return `[${typeof htmlString}: ${String(htmlString).substring(0, 50)}]`;
  }

  // Extract tag name
  const tagMatch = htmlString.match(/<(\w+)/);
  const tag = tagMatch ? tagMatch[1] : 'element';

  // Extract key attributes (id, class, href, src) - not all attributes
  const idMatch = htmlString.match(/\sid=["']([^"']+)["']/);
  const classMatch = htmlString.match(/\sclass=["']([^"']+)["']/);
  const hrefMatch = htmlString.match(/\shref=["']([^"']+)["']/);
  const srcMatch = htmlString.match(/\ssrc=["']([^"']+)["']/);

  let selector = `<${tag}`;
  if (idMatch) selector += ` id="${idMatch[1]}"`;
  else if (classMatch) {
    const classes = classMatch[1].split(/\s+/).slice(0, 2).join(' ');
    selector += ` class="${classes}"`;
  }
  if (hrefMatch) selector += ` href="${hrefMatch[1].substring(0, 60)}..."`;
  else if (srcMatch) selector += ` src="${srcMatch[1].substring(0, 60)}..."`;
  selector += '>';

  return selector;
}

function details(rule) {
  if (rule.url) {
    return `Url: ${rule.url}`;
  } else if (rule.urls) {
    // Phase A: Show count + sample instead of all URLs
    const count = rule.urls.length;
    if (count > 3) {
      return `Urls (${count} total): ${rule.urls.slice(0, 3).join(', ')} ... +${count - 3} more`;
    }
    return `Urls: ${rule.urls.join(', ')}`;
  } else if (rule.element) {
    try {
      // Phase A: Use compact selector instead of prettified HTML
      return `Element: ${extractElementInfo(rule.element)}`;
    } catch (error) {
      console.error('Error processing element:', error);
      return `Element: [Error processing element]`;
    }
  } else if (rule.elements) {
    try {
      // Phase A: Show count + sample top 3 instead of all elements
      const count = rule.elements.length;
      const samples = rule.elements.slice(0, 3).map(el => extractElementInfo(el));
      if (count > 3) {
        return `Elements (${count} total):\n    - ${samples.join('\n    - ')}\n    - ... +${count - 3} more`;
      }
      return `Elements:\n    - ${samples.join('\n    - ')}`;
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
  const maxEntries = DATA_LIMITS.MAX_PERF_ENTRIES;
  if (report.data.length > maxEntries) {
    report.data = report.data.slice(0, maxEntries);
  }
  
  // Sort report.data by start time
  report.data.sort((a, b) => a.start - b.start);
  
  // Clone report.data and sort by end time
  report.dataSortedByEnd = report.data.slice().sort((a, b) => a.end - b.end);

  // Limit other data sizes if necessary
  if (har?.log?.entries?.length > DATA_LIMITS.MAX_HAR_ENTRIES) {
    har.log.entries = har.log.entries.slice(0, DATA_LIMITS.MAX_HAR_ENTRIES);
  }
  if (perfEntries?.length > DATA_LIMITS.MAX_PERF_ENTRIES) {
    perfEntries = perfEntries.slice(0, DATA_LIMITS.MAX_PERF_ENTRIES);
  }
  if (report.data.length > DATA_LIMITS.MAX_PERF_ENTRIES) {
    report.data = report.data.slice(0, DATA_LIMITS.MAX_PERF_ENTRIES);
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
