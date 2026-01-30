// Code Coverage Analysis Functions
import puppeteerToIstanbul from 'puppeteer-to-istanbul';
import PTI from 'puppeteer-to-istanbul/lib/puppeteer-to-istanbul.js';
import { getFilePrefix } from '../../utils.js';
import { LabDataCollector } from './base-collector.js';
import { COVERAGE_THRESHOLDS } from '../../config/thresholds.js';
import { cleanCssComments, extractCssRules } from '../../config/regex-patterns.js';

// CoverageCollector Class
export class CoverageCollector extends LabDataCollector {
  async setup(page) {
    return Promise.all([
      page.coverage.startJSCoverage({
        includeRawScriptCoverage: true,
        useBlockCoverage: false,
      }),
      page.coverage.startCSSCoverage(),
    ]);
  }

  async collect(page, setupResult) {
    const [jsCoverage, cssCoverage] = await Promise.all([
      page.coverage.stopJSCoverage(),
      page.coverage.stopCSSCoverage(),
    ]);
    return [...jsCoverage, ...cssCoverage];
  }

  summarize(coverageUsageAnalysis, options = {}) {
    const error = this.validateOrDefault(
      coverageUsageAnalysis,
      'coverage usage analysis',
      'No coverage data available for analysis.'
    );
    if (error) return error;

    if (Object.keys(coverageUsageAnalysis).length === 0) {
      return 'No coverage data available for analysis.';
    }

    // Calculate overall statistics
    const stats = this.calculateCoverageStats(coverageUsageAnalysis);

    // Group files by type (JS vs CSS)
    const { jsFiles, cssFiles } = this.categorizeFilesByType(coverageUsageAnalysis);

    // Add optimization recommendations
    let markdownOutput = this.generateOptimizationRecommendations(stats, jsFiles, cssFiles);

    // Add JavaScript files section
    if (jsFiles.length > 0) {
      const problematicJsFiles = jsFiles.map(fileData => this.formatFileUsage(fileData, 'JavaScript')).filter(output => output);
      if (problematicJsFiles.length > 0) {
        markdownOutput += `### JavaScript Optimization Opportunities:\n\n${problematicJsFiles.join('')}\n`;
      }
    }

    // Add CSS files section
    if (cssFiles.length > 0) {
      const problematicCssFiles = cssFiles.map(fileData => this.formatFileUsage(fileData, 'CSS')).filter(output => output);
      if (problematicCssFiles.length > 0) {
        markdownOutput += `### CSS Optimization Opportunities:\n\n${problematicCssFiles.join('')}\n`;
      }
    }

    return markdownOutput;
  }

  // Coverage-specific helper methods
  calculateCoverageStats(coverageUsageAnalysis) {
    let totalSegments = 0;
    let preLcp = 0;
    let postLcp = 0;
    let unused = 0;

    // Critical Gap Fix: Track byte-level stats across all files
    let totalBytes = 0;
    let usedBytes = 0;
    let preLcpBytes = 0;
    let postLcpBytes = 0;

    Object.values(coverageUsageAnalysis).forEach(fileData => {
      // Add file-level byte stats if available
      if (fileData._bytes) {
        totalBytes += fileData._bytes.total;
        usedBytes += fileData._bytes.used;
        preLcpBytes += fileData._bytes.preLcp;
        postLcpBytes += fileData._bytes.postLcp;
      }

      Object.entries(fileData).forEach(([key, value]) => {
        // Skip metadata fields
        if (key.startsWith('_')) return;

        totalSegments++;

        // Handle both old format (string) and new format (object)
        const usage = typeof value === 'string' ? value : value.usage;

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

    const preLcpPercent = this.percentage(preLcp, totalSegments);
    const postLcpPercent = this.percentage(postLcp, totalSegments);
    const unusedPercent = this.percentage(unused, totalSegments);

    return {
      totalFiles: Object.keys(coverageUsageAnalysis).length,
      totalSegments,
      preLcp,
      postLcp,
      unused,
      preLcpPercent,
      postLcpPercent,
      unusedPercent,
      // Critical Gap Fix: Add byte-level totals
      bytes: totalBytes > 0 ? {
        total: totalBytes,
        used: usedBytes,
        unused: totalBytes - usedBytes,
        preLcp: preLcpBytes,
        postLcp: postLcpBytes,
        unusedPercent: this.percentage(totalBytes - usedBytes, totalBytes),
        preLcpPercent: this.percentage(preLcpBytes, totalBytes),
        postLcpPercent: this.percentage(postLcpBytes, totalBytes)
      } : null
    };
  }

  categorizeFilesByType(coverageUsageAnalysis) {
    const jsFiles = [];
    const cssFiles = [];

    Object.entries(coverageUsageAnalysis).forEach(([filePath, fileData]) => {
      const fileStats = this.calculateFileStats(fileData);
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

  calculateFileStats(fileData) {
    // Extract byte stats if available (added in critical gap fix)
    const byteStats = fileData._bytes || null;

    // Filter out metadata fields (start with _)
    const segments = Object.entries(fileData)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, value]) => {
        // Handle both old format (string) and new format (object)
        if (typeof value === 'string') {
          return { usage: value, executionCount: 0 };
        }
        return value;
      });

    const preLcp = segments.filter(seg => seg.usage === 'pre-lcp').length;
    const postLcp = segments.filter(seg => seg.usage === 'post-lcp').length;
    const unused = segments.filter(seg => seg.usage === 'not-used').length;
    const total = segments.length;

    // Find hot paths (frequently executed functions)
    const hotPaths = segments
      .filter(seg => seg.executionCount > 10)  // Executed more than 10 times
      .sort((a, b) => b.executionCount - a.executionCount)
      .slice(0, 5);  // Top 5

    return {
      total,
      preLcp,
      preLcpPercent: this.percentage(preLcp, total),
      postLcp,
      postLcpPercent: this.percentage(postLcp, total),
      unused,
      unusedPercent: this.percentage(unused, total),
      // Critical Gap Fix: Add byte-level stats
      bytes: byteStats,
      hotPaths: hotPaths.length > 0 ? hotPaths : null
    };
  }

  formatFileUsage(fileInfo, fileType) {
    const { path, data, stats } = fileInfo;

    // REMOVED: No longer exclude minified files - they're production code and need analysis
    // Old code: if (path.includes('.min.')) { return ''; }

    // Skip files with good efficiency (< ACCEPTABLE_UNUSED and good LCP balance)
    if (stats.unusedPercent < COVERAGE_THRESHOLDS.ACCEPTABLE_UNUSED && (stats.preLcp >= stats.postLcp || !fileInfo._isLoadedPreLcp)) {
      return '';
    }

    let output;
    try {
      const pathname = new URL(path).pathname;
      const isMinified = path.includes('.min.');

      // Critical Gap Fix: Show file size in KB and byte-level breakdown
      let sizeInfo = '';
      if (stats.bytes) {
        const totalKB = this.formatBytes(stats.bytes.total, 0).replace(' ', '');
        const unusedKB = this.formatBytes(stats.bytes.unused, 0).replace(' ', '');
        const preLcpKB = this.formatBytes(stats.bytes.preLcp, 0).replace(' ', '');
        const postLcpKB = this.formatBytes(stats.bytes.postLcp, 0).replace(' ', '');
        sizeInfo = ` (${totalKB}): ${stats.bytes.unusedPercent}% unused (${unusedKB}), ${stats.bytes.preLcpPercent}% pre-LCP (${preLcpKB}), ${stats.bytes.postLcpPercent}% post-LCP (${postLcpKB})`;
      } else {
        // Fallback to old format if byte stats not available
        sizeInfo = `: ${stats.postLcpPercent}% post LCP / ${stats.unusedPercent}% unused`;
      }

      output = `- \`${pathname}\`${isMinified ? ' (minified)' : ''}${sizeInfo}`;
    } catch (err) {
      return '';
    }

    if (stats.postLcp > stats.preLcp) {
      output += ` (consider code splitting to defer post-LCP code)`;
    }

    // Show top 10 post-LCP segments (increased from 5 to avoid data loss)
    // Handle both old format (string) and new format (object with {usage, executionCount})
    const postLcpSegments = Object.entries(data)
      .filter(([key, value]) => {
        if (key.startsWith('_')) return false;  // Skip metadata
        const usage = typeof value === 'string' ? value : value.usage;
        return usage === 'post-lcp';
      })
      .slice(0, 10);

    if (postLcpSegments.length > 0) {
      const segments = postLcpSegments.map(([segment]) => segment.split(':')[0]).join(', ').replaceAll('\n', '');
      output += `\n    - Defer: ${segments}`;
      if (stats.postLcp > 10) {
        output += ` +${stats.postLcp - 10} more`;
      }
    }

    // Show top 10 unused segments (increased from 5 to avoid data loss)
    const unusedSegments = Object.entries(data)
      .filter(([key, value]) => {
        if (key.startsWith('_')) return false;  // Skip metadata
        const usage = typeof value === 'string' ? value : value.usage;
        return usage === 'not-used';
      })
      .slice(0, 10);

    if (unusedSegments.length > 0) {
      const segments = unusedSegments.map(([segment]) => segment.split(':')[0]).join(', ').replaceAll('\n', '');
      output += `\n    - Remove: ${segments}`;
      if (stats.unused > 10) {
        output += ` +${stats.unused - 10} more`;
      }
    }

    // Critical Gap Fix: Show hot paths if available (frequently executed functions)
    if (stats.hotPaths && stats.hotPaths.length > 0 && fileType === 'JavaScript') {
      output += `\n    - Hot paths (high execution): `;
      const hotPathList = stats.hotPaths
        .map(hp => {
          const funcName = Object.keys(data).find(key => {
            const value = data[key];
            return (typeof value === 'object' && value.executionCount === hp.executionCount);
          });
          return funcName ? `${funcName.split(':')[0]} (${hp.executionCount}x)` : null;
        })
        .filter(Boolean)
        .join(', ');
      output += hotPathList;
    }

    output += `\n`;
    return output;
  }

  generateOptimizationRecommendations(stats, jsFiles, cssFiles) {
    const recommendations = [];

    // Critical Gap Fix: Add byte-level summary if available
    let bytesSummary = '';
    if (stats.bytes) {
      const totalKB = this.formatBytes(stats.bytes.total, 0).replace(' ', '');
      const unusedKB = this.formatBytes(stats.bytes.unused, 0).replace(' ', '');
      const preLcpKB = this.formatBytes(stats.bytes.preLcp, 0).replace(' ', '');
      const postLcpKB = this.formatBytes(stats.bytes.postLcp, 0).replace(' ', '');
      bytesSummary = `\n**Total Code Size**: ${totalKB} (${unusedKB} unused, ${preLcpKB} pre-LCP, ${postLcpKB} post-LCP)\n`;
    }

    // Critical unused code
    if (stats.unusedPercent > 30) {
      const wasteKB = stats.bytes ? `(${this.formatBytes(stats.bytes.unused, 0).replace(' ', '')} wasted)` : '';
      recommendations.push(`**Critical**: ${stats.unusedPercent}% unused code ${wasteKB} - implement tree-shaking and code splitting`);
    } else if (stats.unusedPercent > COVERAGE_THRESHOLDS.WARNING_UNUSED) {
      const wasteKB = stats.bytes ? `(${this.formatBytes(stats.bytes.unused, 0).replace(' ', '')} wasted)` : '';
      recommendations.push(`**Optimize**: ${stats.unusedPercent}% unused code ${wasteKB} - review and remove dead code`);
    }

    // LCP optimization
    if (stats.preLcpPercent < 40) {
      recommendations.push(`**LCP**: Only ${stats.preLcpPercent}% pre-LCP code - defer non-critical resources`);
    }

    // File-specific actions
    const heavilyUnusedFiles = [...jsFiles, ...cssFiles].filter(file => file.stats.unusedPercent > COVERAGE_THRESHOLDS.ACCEPTABLE_UNUSED);
    if (heavilyUnusedFiles.length > 0) {
      const fileNames = heavilyUnusedFiles.slice(0, 3).map(file => file.path.split('/').pop()).join(', ');
      recommendations.push(`**Files**: ${fileNames} have >${COVERAGE_THRESHOLDS.ACCEPTABLE_UNUSED}% unused code - consider removal`);
    }

    if (recommendations.length === 0) {
      return bytesSummary + '**Good**: Code coverage is well optimized\n';
    }

    return bytesSummary + recommendations.map(rec => `${rec}\n`).join('');
  }
}

// Code Coverage Collection Functions (backward compatible exports)
export async function setupCodeCoverage(page) {
  const collector = new CoverageCollector();
  return collector.setup(page);
}

export async function collectCodeCoverage(page) {
  const collector = new CoverageCollector();
  return collector.collect(page, null);
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
  const collector = new CoverageCollector(deviceType);
  return collector.summarize(coverageUsageAnalysis);
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

// Helper functions for coverage analysis (keep for analyzeJSCoverage and analyzeCSSCoverage)

function analyzeJSCoverage(lcpEntry, pageEntry, fileResult) {
  const lcpFunctions = new Map();
  const pageFunctions = new Map();

  // Get the source text for line number conversion
  const sourceText = pageEntry.text || '';

  // Critical Gap Fix: Calculate file size from ranges
  let totalBytes = 0;
  let usedBytes = 0;
  let preLcpBytes = 0;
  let postLcpBytes = 0;

  if (pageEntry?.rawScriptCoverage?.functions) {
    pageEntry.rawScriptCoverage.functions.forEach(func => {
      if (func.ranges) {
        func.ranges.forEach(range => {
          const rangeSize = (range.endOffset || 0) - (range.startOffset || 0);
          totalBytes += rangeSize;
          if (range.count > 0) {
            usedBytes += rangeSize;
          }
        });
      }
    });
  }

  // Process LCP functions if available
  if (lcpEntry?.rawScriptCoverage?.functions) {
    lcpEntry.rawScriptCoverage.functions.forEach(func => {
      if (!func.functionName) return;
      const startOffset = func.ranges[0]?.startOffset || 0;
      const lineNumber = getLineNumberFromOffset(sourceText, startOffset);
      const key = `${func.functionName}:L${lineNumber}`;
      const isUsed = func.ranges.some(range => range.count > 0);
      lcpFunctions.set(key, isUsed);

      // Calculate bytes used in LCP
      if (isUsed && func.ranges) {
        func.ranges.forEach(range => {
          if (range.count > 0) {
            const rangeSize = (range.endOffset || 0) - (range.startOffset || 0);
            preLcpBytes += rangeSize;
          }
        });
      }
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

      // Critical Gap Fix: Track execution count
      const executionCount = func.ranges.reduce((max, range) => Math.max(max, range.count || 0), 0);

      pageFunctions.set(key, isUsed);

      // Determine usage category
      let usageCategory;
      const usedInLCP = lcpFunctions.get(key) || false;

      if (usedInLCP) {
        usageCategory = 'pre-lcp';
      } else if (isUsed) {
        usageCategory = 'post-lcp';
        // Calculate post-LCP bytes
        if (func.ranges) {
          func.ranges.forEach(range => {
            if (range.count > 0) {
              const rangeSize = (range.endOffset || 0) - (range.startOffset || 0);
              postLcpBytes += rangeSize;
            }
          });
        }
      } else {
        usageCategory = 'not-used';
      }

      // Store usage category with execution count
      fileResult[key] = { usage: usageCategory, executionCount };
    });
  }

  // Store file-level byte stats
  const collector = new CoverageCollector();
  fileResult._bytes = {
    total: totalBytes,
    used: usedBytes,
    unused: totalBytes - usedBytes,
    preLcp: preLcpBytes,
    postLcp: postLcpBytes,
    unusedPercent: collector.percentage(totalBytes - usedBytes, totalBytes),
    preLcpPercent: collector.percentage(preLcpBytes, totalBytes),
    postLcpPercent: collector.percentage(postLcpBytes, totalBytes)
  };
}

function analyzeCSSCoverage(lcpEntry, pageEntry, fileResult) {
  // For CSS, we need to parse the text and map ranges to selectors
  // This is a simplified approach - in practice, you might want to use a CSS parser

  const lcpRanges = lcpEntry?.ranges || [];
  const pageRanges = pageEntry?.ranges || [];
  const cssText = pageEntry.text || '';

  if (!cssText) return;

  // Critical Gap Fix: Calculate file size from ranges
  let totalBytes = cssText.length;
  let usedBytes = 0;
  let preLcpBytes = 0;
  let postLcpBytes = 0;

  // Calculate used bytes from page ranges
  pageRanges.forEach(range => {
    if (range.count > 0) {
      const rangeSize = (range.endOffset || 0) - (range.startOffset || 0);
      usedBytes += rangeSize;
    }
  });

  // Calculate pre-LCP bytes
  lcpRanges.forEach(range => {
    if (range.count > 0) {
      const rangeSize = (range.endOffset || 0) - (range.startOffset || 0);
      preLcpBytes += rangeSize;
    }
  });

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
      // Calculate post-LCP bytes
      const ruleSize = rule.end - rule.start;
      postLcpBytes += ruleSize;
    } else {
      usageCategory = 'not-used';
    }

    const lineNumber = getLineNumberFromOffset(cssText, rule.start);
    // CSS doesn't have execution counts, store usage only
    fileResult[`${rule.selector}:L${lineNumber}`] = { usage: usageCategory, executionCount: 0 };
  });

  // Store file-level byte stats
  const collector = new CoverageCollector();
  fileResult._bytes = {
    total: totalBytes,
    used: usedBytes,
    unused: totalBytes - usedBytes,
    preLcp: preLcpBytes,
    postLcp: postLcpBytes,
    unusedPercent: collector.percentage(totalBytes - usedBytes, totalBytes),
    preLcpPercent: collector.percentage(preLcpBytes, totalBytes),
    postLcpPercent: collector.percentage(postLcpBytes, totalBytes)
  };
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

  // Use centralized CSS parsing helper
  const cleanCss = cleanCssComments(cssText).trim();
  const parsedRules = extractCssRules(cssText);

  // Convert to old format with position tracking for compatibility
  parsedRules.forEach((rule, index) => {
    // Find position in cleaned CSS (approximate since we don't track positions in helper)
    const selector = rule.selector;
    const start = cleanCss.indexOf(selector);
    const end = start + selector.length;

    // Filter out invalid selectors and at-rules
    if (isValidCSSSelector(selector)) {
      rules.push({
        selector: selector,
        start: start,
        end: end
      });
    }
  });

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