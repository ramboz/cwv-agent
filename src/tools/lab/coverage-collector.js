// Code Coverage Analysis Functions
import puppeteerToIstanbul from 'puppeteer-to-istanbul';
import PTI from 'puppeteer-to-istanbul/lib/puppeteer-to-istanbul.js';
import { getFilePrefix } from '../../utils.js';

// Code Coverage Collection Functions
export async function setupCodeCoverage(page) {
  return Promise.all([
    page.coverage.startJSCoverage({
      includeRawScriptCoverage: true,
      useBlockCoverage: false,
    }),
    page.coverage.startCSSCoverage(),
  ]);
}

export async function collectCodeCoverage(page) {
  const [jsCoverage, cssCoverage] = await Promise.all([
    page.coverage.stopJSCoverage(),
    page.coverage.stopCSSCoverage(),
  ]);
  return [...jsCoverage, ...cssCoverage];
}

export async function collectLcpCoverage(page, pageUrl, deviceType) {
  const lcpCoverageData = await collectCodeCoverage(page);
  await setupCodeCoverage(page);

  // Convert to Istanbul format and write report
  convertToIstanbul(lcpCoverageData, getFilePrefix(pageUrl, deviceType, 'nyc-lcp'));
  // Clear the istanbul report cache so LCP data doesn't leak into the page coverage data
  resetIstanbulCache();

  return lcpCoverageData;
}

export async function collectPageCoverage(page, pageUrl, deviceType, lcpCoverageData) {
  let pageCoverageData = await collectCodeCoverage(page);
  pageCoverageData = mergeCoverage(lcpCoverageData, pageCoverageData);

  const coverageData = analyzeCoverageUsage(lcpCoverageData, pageCoverageData);

  // Convert to Istanbul format and write report
  convertToIstanbul(pageCoverageData, getFilePrefix(pageUrl, deviceType, 'nyc-page'));

  return coverageData;
}

/**
 * Summarizes code coverage usage analysis in markdown format
 * @param {Object} coverageUsageAnalysis - Analysis results from analyzeCoverageUsage
 * @param {string} deviceType - Device type (desktop/mobile)
 * @returns {string} Markdown formatted coverage summary
 */
export function summarizeCoverageData(coverageUsageAnalysis, deviceType) {
  if (!coverageUsageAnalysis || Object.keys(coverageUsageAnalysis).length === 0) {
    return 'No coverage data available for analysis.';
  }

  // Calculate overall statistics
  const stats = calculateCoverageStats(coverageUsageAnalysis);

  // Group files by type (JS vs CSS)
  const { jsFiles, cssFiles } = categorizeFilesByType(coverageUsageAnalysis);

  // Add optimization recommendations
  let markdownOutput = generateOptimizationRecommendations(stats, jsFiles, cssFiles);

  // Add JavaScript files section
  if (jsFiles.length > 0) {
    const problematicJsFiles = jsFiles.map(fileData => formatFileUsage(fileData, 'JavaScript')).filter(output => output);
    if (problematicJsFiles.length > 0) {
      markdownOutput += `### JavaScript Optimization Opportunities:\n\n${problematicJsFiles.join('')}\n`;
    }
  }

  // Add CSS files section
  if (cssFiles.length > 0) {
    const problematicCssFiles = cssFiles.map(fileData => formatFileUsage(fileData, 'CSS')).filter(output => output);
    if (problematicCssFiles.length > 0) {
      markdownOutput += `### CSS Optimization Opportunities:\n\n${problematicCssFiles.join('')}\n`;
    }
  }

  return markdownOutput;
}

/**
 * Analyzes code coverage data to categorize usage as pre LCP, post LCP, or unused.
 *
 * @param {Array} lcpCoverageData - Coverage data collected at LCP (Largest Contentful Paint)
 * @param {Array} pageCoverageData - Coverage data collected at end of page load
 * @returns {Object} Analysis results in JSON format with file paths as keys and usage categorization
 *
 * Output format:
 * {
 *   "file_path_or_url": {
 *     "function_name:offset" | "css_selector": "pre-lcp" | "post-lcp" | "not-used"
 *   }
 * }
 *
 * For JavaScript: Functions executed during LCP are "pre-lcp",
 * functions executed only after LCP are "post-lcp", unused functions are "not-used"
 *
 * For CSS: Selectors used during LCP are "pre-lcp",
 * selectors used only after LCP are "post-lcp", unused selectors are "not-used"
 */
export function analyzeCoverageUsage(lcpCoverageData, pageCoverageData) {
  const result = {};

  // Create maps for easier lookup
  const lcpCoverageMap = new Map();
  const pageCoverageMap = new Map();

  // Process LCP coverage data
  lcpCoverageData.forEach(entry => {
    const key = entry.url || 'inline';
    lcpCoverageMap.set(key, entry);
  });

  // Process page coverage data
  pageCoverageData.forEach(entry => {
    const key = entry.url || 'inline';
    pageCoverageMap.set(key, entry);
  });

  // Get all unique files from both datasets
  const allFiles = new Set([...lcpCoverageMap.keys(), ...pageCoverageMap.keys()]);

  allFiles.forEach(filePath => {
    const lcpEntry = lcpCoverageMap.get(filePath);
    const pageEntry = pageCoverageMap.get(filePath);

    // Skip if no page entry (shouldn't happen due to merging)
    if (!pageEntry) return;

    result[filePath] = {};

    result[filePath]._isLoadedPreLcp = !!lcpEntry;

    // Analyze JavaScript coverage
    if (pageEntry.rawScriptCoverage) {
      analyzeJSCoverage(lcpEntry, pageEntry, result[filePath], !!lcpEntry);
    }

    // Analyze CSS coverage
    if (pageEntry.ranges && !pageEntry.rawScriptCoverage) {
      analyzeCSSCoverage(lcpEntry, pageEntry, result[filePath], !!lcpEntry);
    }
  });

  return result;
}

export function mergeCoverage(report1Entries, report2Entries) {
  const mergedCoverageMap = new Map();

  // Process first report
  for (const entry of report1Entries) {
      const ranges = entry.ranges.map(r => ({ ...r })); // Deep copy ranges
      const key = entry.url || entry.text;
      const mergedEntry = { // Use text as key for inline styles/scripts
          url: entry.url,
          text: entry.text,
          ranges: ranges
      };

      // Copy rawScriptCoverage if it exists (for JavaScript files)
      if (entry.rawScriptCoverage) {
          mergedEntry.rawScriptCoverage = {
              ...entry.rawScriptCoverage,
              functions: entry.rawScriptCoverage.functions?.map(func => ({
                  ...func,
                  ranges: func.ranges.map(r => ({ ...r }))
              })) || []
          };
      }

      mergedCoverageMap.set(key, mergedEntry);
  }

  // Merge second report
  for (const entry of report2Entries) {
      const key = entry.url || entry.text;
      if (mergedCoverageMap.has(key)) {
          const existingEntry = mergedCoverageMap.get(key);

          // Merge ranges
          const combinedRanges = [...existingEntry.ranges, ...entry.ranges.map(r => ({ ...r }))];
          combinedRanges.sort((a, b) => a.start - b.start);

          const mergedRanges = [];
          if (combinedRanges.length > 0) {
              let currentRange = { ...combinedRanges[0] };
              for (let i = 1; i < combinedRanges.length; i++) {
                  const nextRange = combinedRanges[i];
                  if (nextRange.start < currentRange.end) { // Overlap or adjacent
                      currentRange.end = Math.max(currentRange.end, nextRange.end);
                  } else {
                      mergedRanges.push(currentRange);
                      currentRange = { ...nextRange };
                  }
              }
              mergedRanges.push(currentRange);
          }
          existingEntry.ranges = mergedRanges;

          // Merge rawScriptCoverage if both entries have it
          if (entry.rawScriptCoverage && existingEntry.rawScriptCoverage) {
              existingEntry.rawScriptCoverage = mergeRawScriptCoverage(
                  existingEntry.rawScriptCoverage,
                  entry.rawScriptCoverage,
                  existingEntry.text || ''
              );
          } else if (entry.rawScriptCoverage && !existingEntry.rawScriptCoverage) {
              // Add rawScriptCoverage if only the new entry has it
              existingEntry.rawScriptCoverage = {
                  ...entry.rawScriptCoverage,
                  functions: entry.rawScriptCoverage.functions?.map(func => ({
                      ...func,
                      ranges: func.ranges.map(r => ({ ...r }))
                  })) || []
              };
          }
      } else {
          // New entry from the second report
          const newEntry = {
              url: entry.url,
              text: entry.text,
              ranges: entry.ranges.map(r => ({ ...r })),
          };

          // Copy rawScriptCoverage if it exists
          if (entry.rawScriptCoverage) {
              newEntry.rawScriptCoverage = {
                  ...entry.rawScriptCoverage,
                  functions: entry.rawScriptCoverage.functions?.map(func => ({
                      ...func,
                      ranges: func.ranges.map(r => ({ ...r }))
                  })) || []
              };
          }

          mergedCoverageMap.set(key, newEntry);
      }
  }
  return Array.from(mergedCoverageMap.values());
}

// Helper functions for coverage analysis
function calculateCoverageStats(coverageUsageAnalysis) {
  let totalSegments = 0;
  let preLcp = 0;
  let postLcp = 0;
  let unused = 0;

  Object.values(coverageUsageAnalysis).forEach(fileData => {
    Object.values(fileData).forEach(usage => {
      totalSegments++;
      switch (usage) {
        case 'pre-lcp':
          preLcp++;
          break;
        case 'post-lcp':
          postLcp++;
          break;
        case 'not-used':
          unused++;
          break;
      }
    });
  });

  const preLcpPercent = totalSegments > 0 ? Math.round((preLcp / totalSegments) * 100) : 0;
  const postLcpPercent = totalSegments > 0 ? Math.round((postLcp / totalSegments) * 100) : 0;
  const unusedPercent = totalSegments > 0 ? Math.round((unused / totalSegments) * 100) : 0;

  return {
    totalFiles: Object.keys(coverageUsageAnalysis).length,
    totalSegments,
    preLcp,
    postLcp,
    unused,
    preLcpPercent,
    postLcpPercent,
    unusedPercent
  };
}

function categorizeFilesByType(coverageUsageAnalysis) {
  const jsFiles = [];
  const cssFiles = [];

  Object.entries(coverageUsageAnalysis).forEach(([filePath, fileData]) => {
    const fileStats = calculateFileStats(fileData);
    const fileInfo = {
      path: filePath,
      data: fileData,
      stats: fileStats
    };

    // Determine file type based on extension or content
    if (filePath.includes('.css')) {
      cssFiles.push(fileInfo);
    } else {
      jsFiles.push(fileInfo);
    }
  });

  return { jsFiles, cssFiles };
}

function calculateFileStats(fileData) {
  const segments = Object.values(fileData);
  const preLcp = segments.filter(usage => usage === 'pre-lcp').length;
  const postLcp = segments.filter(usage => usage === 'post-lcp').length;
  const unused = segments.filter(usage => usage === 'not-used').length;
  const total = segments.length;

  return {
    total,
    preLcp,
    preLcpPercent: total > 0 ? Math.round((preLcp / total) * 100) : 0,
    postLcp,
    postLcpPercent: total > 0 ? Math.round((postLcp / total) * 100) : 0,
    unused,
    unusedPercent: total > 0 ? Math.round((unused / total) * 100) : 0
  };
}

function formatFileUsage(fileInfo, fileType) {
  const { path, data, stats } = fileInfo;

  if (path.includes('.min.')) {
    return '';
  }

  // Skip files with good efficiency (< 50% unused and good LCP balance)
  if (stats.unusedPercent < 50 && (stats.preLcp >= stats.postLcp || !fileInfo._isLoadedPreLcp)) {
    return '';
  }

  let output;
  try {
    output = `- \`${new URL(path).pathname}\`: ${stats.postLcpPercent}% post LCP / ${stats.unusedPercent}% unused`;
  } catch (err) {
    return '';
  }

  if (stats.postLcp > stats.preLcp) {
    output += ` (consider code splitting to defer post-LCP code)`;
  }

  // Show top 5 post-LCP segments that can be deferred
  const postLcpSegments = Object.entries(data)
    .filter(([, usage]) => usage === 'post-lcp')
    .slice(0, 5);

  if (postLcpSegments.length > 0) {
    const segments = postLcpSegments.map(([segment]) => segment.split(':')[0]).join(', ').replaceAll('\n', '');
    output += `\n    - Defer: ${segments}`;
    if (stats.postLcp > 5) {
      output += ` +${stats.postLcp - 5} more`;
    }
  }

  // Show top 5 problematic segments only
  const unusedSegments = Object.entries(data)
    .filter(([, usage]) => usage === 'not-used')
    .slice(0, 5);

  if (unusedSegments.length > 0) {
    const segments = unusedSegments.map(([segment]) => segment.split(':')[0]).join(', ').replaceAll('\n', '');
    output += `\n    - Remove: ${segments}`;
    if (stats.unused > 5) {
      output += ` +${stats.unused - 5} more`;
    }
  }

  output += `\n`;
  return output;
}

function generateOptimizationRecommendations(stats, jsFiles, cssFiles) {
  const recommendations = [];

  // Critical unused code
  if (stats.unusedPercent > 30) {
    recommendations.push(`**Critical**: ${stats.unusedPercent}% unused code - implement tree-shaking and code splitting`);
  } else if (stats.unusedPercent > 15) {
    recommendations.push(`**Optimize**: ${stats.unusedPercent}% unused code - review and remove dead code`);
  }

  // LCP optimization
  if (stats.preLcpPercent < 40) {
    recommendations.push(`**LCP**: Only ${stats.preLcpPercent}% pre-LCP code - defer non-critical resources`);
  }

  // File-specific actions
  const heavilyUnusedFiles = [...jsFiles, ...cssFiles].filter(file => file.stats.unusedPercent > 50);
  if (heavilyUnusedFiles.length > 0) {
    const fileNames = heavilyUnusedFiles.slice(0, 3).map(file => file.path.split('/').pop()).join(', ');
    recommendations.push(`**Files**: ${fileNames} have >50% unused code - consider removal`);
  }

  if (recommendations.length === 0) {
    return '**Good**: Code coverage is well optimized\n';
  }

  return recommendations.map(rec => `${rec}\n`).join('');
}

function analyzeJSCoverage(lcpEntry, pageEntry, fileResult) {
  const lcpFunctions = new Map();
  const pageFunctions = new Map();

  // Get the source text for line number conversion
  const sourceText = pageEntry.text || '';

  // Process LCP functions if available
  if (lcpEntry?.rawScriptCoverage?.functions) {
    lcpEntry.rawScriptCoverage.functions.forEach(func => {
      if (!func.functionName) return;
      const startOffset = func.ranges[0]?.startOffset || 0;
      const lineNumber = getLineNumberFromOffset(sourceText, startOffset);
      const key = `${func.functionName}:L${lineNumber}`;
      const isUsed = func.ranges.some(range => range.count > 0);
      lcpFunctions.set(key, isUsed);
    });
  }

  // Process page functions
  if (pageEntry?.rawScriptCoverage?.functions) {
    pageEntry.rawScriptCoverage.functions.forEach(func => {
      if (!func.functionName) return;
      const startOffset = func.ranges[0]?.startOffset || 0;
      const lineNumber = getLineNumberFromOffset(sourceText, startOffset);
      const key = `${func.functionName}:L${lineNumber}`;
      const isUsed = func.ranges.some(range => range.count > 0);
      pageFunctions.set(key, isUsed);

      // Determine usage category
      let usageCategory;
      const usedInLCP = lcpFunctions.get(key) || false;

      if (usedInLCP) {
        usageCategory = 'pre-lcp';
      } else if (isUsed) {
        usageCategory = 'post-lcp';
      } else {
        usageCategory = 'not-used';
      }

      fileResult[key] = usageCategory;
    });
  }
}

function analyzeCSSCoverage(lcpEntry, pageEntry, fileResult) {
  // For CSS, we need to parse the text and map ranges to selectors
  // This is a simplified approach - in practice, you might want to use a CSS parser

  const lcpRanges = lcpEntry?.ranges || [];
  const pageRanges = pageEntry?.ranges || [];
  const cssText = pageEntry.text || '';

  if (!cssText) return;

  // Create coverage maps
  const lcpCoverageMap = createCoverageMap(lcpRanges);
  const pageCoverageMap = createCoverageMap(pageRanges);

  // Extract CSS rules and their positions
  const cssRules = extractCSSRules(cssText);

  cssRules.forEach(rule => {
    const isUsedInLCP = isRangeCovered(rule.start, rule.end, lcpCoverageMap);
    const isUsedInPage = isRangeCovered(rule.start, rule.end, pageCoverageMap);

    let usageCategory;
    if (isUsedInLCP) {
      usageCategory = 'pre-lcp';
    } else if (isUsedInPage) {
      usageCategory = 'post-lcp';
    } else {
      usageCategory = 'not-used';
    }

    const lineNumber = getLineNumberFromOffset(cssText, rule.start);
    fileResult[`${rule.selector}:L${lineNumber}`] = usageCategory;
  });
}

function mergeRawScriptCoverage(coverage1, coverage2, sourceText) {
    const merged = { ...coverage1 };

    if (!coverage1.functions || !coverage2.functions) {
        return merged;
    }

    // Create a map of functions by their identifier (functionName + line number)
    const functionMap = new Map();

    // Add functions from first coverage
    coverage1.functions.forEach(func => {
        if (!func.functionName) return;
        const startOffset = func.ranges[0]?.startOffset || 0;
        const lineNumber = getLineNumberFromOffset(sourceText, startOffset);
        const key = `${func.functionName}:L${lineNumber}`;
        functionMap.set(key, {
            ...func,
            ranges: func.ranges.map(r => ({ ...r }))
        });
    });

    // Merge functions from second coverage
    coverage2.functions.forEach(func => {
        if (!func.functionName) return;
        const startOffset = func.ranges[0]?.startOffset || 0;
        const lineNumber = getLineNumberFromOffset(sourceText, startOffset);
        const key = `${func.functionName}:L${lineNumber}`;

        if (functionMap.has(key)) {
            const existingFunc = functionMap.get(key);
            // Merge the ranges and execution counts
            existingFunc.ranges = existingFunc.ranges.map((range, index) => {
                const newRange = func.ranges[index];
                return {
                    ...range,
                    count: range.count + (newRange?.count || 0)
                };
            });
        } else {
            functionMap.set(key, {
                ...func,
                ranges: func.ranges.map(r => ({ ...r }))
            });
        }
    });

    merged.functions = Array.from(functionMap.values());
    return merged;
}

function createCoverageMap(ranges) {
  const coverageMap = new Array();
  ranges.forEach(range => {
    for (let i = range.start; i < range.end; i++) {
      coverageMap[i] = true;
    }
  });
  return coverageMap;
}

function isRangeCovered(start, end, coverageMap) {
  // Check if any part of the range is covered
  for (let i = start; i < end; i++) {
    if (coverageMap[i]) {
      return true;
    }
  }
  return false;
}

function extractCSSRules(cssText) {
  const rules = [];

  // Clean up the CSS text first - remove comments and normalize whitespace
  const cleanCss = cssText
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove CSS comments
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  // More robust regex that handles nested structures better
  const ruleRegex = /([^{}]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let match;

  while ((match = ruleRegex.exec(cleanCss)) !== null) {
    const selector = match[1].trim();
    const start = match.index;
    const end = match.index + match[0].length;

    // Filter out invalid selectors and at-rules
    if (isValidCSSSelector(selector)) {
      rules.push({
        selector: selector,
        start: start,
        end: end
      });
    }
  }

  return rules;
}

function isValidCSSSelector(selector) {
  // Skip empty selectors
  if (!selector || selector.length === 0) {
    return false;
  }

  // Skip standalone braces or invalid characters
  if (selector === '}' || selector === '{' || selector.includes('}')) {
    return false;
  }

  // Skip @-rules (media queries, keyframes, etc.)
  if (selector.startsWith('@')) {
    return false;
  }

  // Skip CSS property declarations (shouldn't happen with proper regex, but just in case)
  if (selector.includes(':') && !selector.includes('::') && !selector.includes(':hover') && !selector.includes(':focus') && !selector.includes(':not(')) {
    return false;
  }

  // Skip selectors that look like property values
  if (/^\s*[a-zA-Z-]+\s*:\s*/.test(selector)) {
    return false;
  }

  return true;
}

function getLineNumberFromOffset(text, offset) {
  if (!text || offset < 0) return 1;

  let lineNumber = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      lineNumber++;
    }
  }
  return lineNumber;
}

// Istanbul Coverage Conversion Functions
export function convertToIstanbul(coverageData, storagePath) {
  puppeteerToIstanbul.write(coverageData, { storagePath });
}

export function resetIstanbulCache() {
  PTI.resetJSONPart();
} 