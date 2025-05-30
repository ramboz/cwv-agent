import puppeteer from 'puppeteer';
import { PredefinedNetworkConditions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { cacheResults, getCachedResults, getFilePrefix, USER_AGENTS } from '../utils.js';
import puppeteerToIstanbul from 'puppeteer-to-istanbul';
import PTI from 'puppeteer-to-istanbul/lib/puppeteer-to-istanbul.js';

// Device configuration profiles
const simulationConfig = {
  desktop: {
    cpuThrottling: 1,
    networkThrottling: {
      download: 10240 * 1024,
      upload: 10240 * 1024,
      latency: 40,
    },
    viewport: {
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      isMobile: false,
      isLandscape: true,
    },
    psiUserAgent: USER_AGENTS.psi.desktop
  },
  mobile: {
    cpuThrottling: 4,
    networkThrottling: PredefinedNetworkConditions['Slow 4G'],
    viewport: {
      width: 412,
      height: 823,
      deviceScaleFactor: 1.75,
      isMobile: true,
      isLandscape: false,
    },
    psiUserAgent: USER_AGENTS.psi.mobile
  }
};

// HAR Processing Functions
function cleanupHarData(har) {
  // Remove preflight requests (OPTIONS) from HAR data
  if (har?.log?.entries) {
    har.log.entries = har.log.entries.filter(entry => 
      !(entry.request && entry.request.method === 'OPTIONS')
    );
  }
  return har;
}

// HAR Analysis Functions
export function summarizeHAR(harData, deviceType) {
  if (!harData?.log?.entries) {
    return 'No valid HTTP Archive data available.';
  }

  const entries = harData.log.entries;
  let report = '**Additional Bottlenecks from HAR Data:**\n\n';
  let hasBottlenecks = false;

  // Check for different types of bottlenecks
  hasBottlenecks = analyzeBottlenecks(entries, report, deviceType);

  //No significant bottlenecks found
  if (!hasBottlenecks) {
    report += '* No significant bottlenecks found based on provided HAR data.\n';
  }

  return report;
}

function analyzeBottlenecks(entries, report, deviceType) {
  let hasBottlenecks = false;
  
  // Add bottleneck analyses
  hasBottlenecks = findLargeTransfers(entries, report) || hasBottlenecks;
  hasBottlenecks = findLongBlockingTimes(entries, report) || hasBottlenecks;
  hasBottlenecks = findLongTTFB(entries, report, deviceType) || hasBottlenecks;
  hasBottlenecks = findHTTP1Resources(entries, report) || hasBottlenecks;
  hasBottlenecks = findRedirects(entries, report) || hasBottlenecks;
  
  return hasBottlenecks;
}

function findLargeTransfers(entries, report) {
  // 1. Large Transfer Sizes (Top 5, > 100KB)
  const largeFiles = entries
    .filter(entry => entry.response && entry.response._transferSize > 100 * 1024) // > 100KB
    .sort((a, b) => b.response._transferSize - a.response._transferSize)
    .slice(0, 5); // Limit to top 5

  if (largeFiles.length > 0) {
    report += '* **Large File Transfers:**\n';
    largeFiles.forEach(entry => {
      report += `    * ${entry.request.url} (${Math.round(entry.response._transferSize / 1024)} KB)\n`;
    });
    return true;
  }
  return false;
}

function findLongBlockingTimes(entries, report) {
  // 2. Long Blocking Times (> 10ms)
  const longBlocking = entries
    .filter(entry => entry.timings && entry.timings.blocked > 10)
    .sort((a, b) => b.timings.blocked - a.timings.blocked);

  if (longBlocking.length > 0) {
    report += '* **Significant Blocking Times (DNS, Connect, SSL):**\n';
    longBlocking.forEach(entry => {
      report += `    * ${entry.request.url}:  Blocked: ${Math.round(entry.timings.blocked)}ms`;
      if (entry.timings.dns > 0) {
        report += `, DNS: ${Math.round(entry.timings.dns)}ms`;
      }
      if (entry.timings.connect > 0) {
        report += `, Connect: ${Math.round(entry.timings.connect)}ms`;
      }
      if (entry.timings.ssl > 0) {
        report += `, SSL: ${Math.round(entry.timings.ssl)}ms`;
      }
      report += '\n';
    });
    return true;
  }
  return false;
}

function findLongTTFB(entries, report, deviceType) {
  // 3. Long Wait Times (> 500ms desktop / >1s mobile) - TTFB
  const ttfbThreshold = deviceType === 'desktop' ? 500 : 1000;
  const longTTFB = entries
    .filter(entry => entry.timings && entry.timings.wait > ttfbThreshold)
    .sort((a, b) => b.timings.wait - a.timings.wait);

  if (longTTFB.length > 0) {
    report += '* **High Time to First Byte (TTFB) - Server Response Times:**\n';
    longTTFB.forEach(entry => {
      report += `    * ${entry.request.url}: ${Math.round(entry.timings.wait)}ms\n`;
    });
    return true;
  }
  return false;
}

function findHTTP1Resources(entries, report) {
  // 4. HTTP/1.1 Connections
  const http1Resources = entries.filter(entry => 
    entry.response && entry.response.httpVersion.toLowerCase().startsWith('http/1.1')
  );

  if (http1Resources.length > 0) {
    report += '* **Resources using HTTP/1.1 (not HTTP/2 or HTTP/3):**\n';
    http1Resources.forEach(entry => {
      report += `   * ${entry.request.url}\n`;
    });
    return true;
  }
  return false;
}

function findRedirects(entries, report) {
  // 5. Redirects
  const redirectStatusCodes = [301, 302, 307, 308];
  const redirects = entries.filter(entry => 
    entry.response && redirectStatusCodes.includes(entry.response.status)
  );
  
  if(redirects.length > 0) {
    report += `* **Redirects:**\n`;
    redirects.forEach(entry => {
      report += `    * ${entry.request.url} -> ${entry.response.redirectURL} (Status: ${entry.response.status})\n`;
    });
    return true;
  }
  return false;
}

// Performance Entry Analysis Functions
export function summarizePerformanceEntries(performanceEntries, deviceType) {
  let markdownOutput = `# Performance Analysis (Focused)\n\n`;

  // Group entries by type
  const entriesByType = performanceEntries.reduce((groups, entry) => {
    const type = entry.entryType;
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(entry);
    return groups;
  }, {});

  // Process navigation timing (if available)
  if (entriesByType.navigation && entriesByType.navigation.length > 0) {
    markdownOutput += `## Navigation Timing (Highlights)\n\n`;
    markdownOutput += `### Page Navigation Metrics\n`;
    markdownOutput += formatNavigationEntry(entriesByType.navigation[0]);
  }

  // Process LCP (if available)
  if (entriesByType['largest-contentful-paint']) {
    markdownOutput += `## Largest Contentful Paint (LCP)\n\n`;
    entriesByType['largest-contentful-paint'].forEach(entry => {
      markdownOutput += formatLCPEntry(entry);
    });
  }

  // Process long tasks (if available)
  const significantLongTasks = entriesByType.longtask?.filter(entry => entry.duration > 100) || [];
  if (significantLongTasks.length > 0) {
    markdownOutput += `## Long Tasks (Highlights)\n\n`;
    significantLongTasks
      .sort((a, b) => b.duration - a.duration)
      .forEach(entry => {
        markdownOutput += formatLongTaskEntry(entry);
      });
  }

  // Process long animation frames (if available)
  const significantAnimationFrames = entriesByType['long-animation-frame']?.filter(entry => entry.blockingDuration > 0) || [];
  if (significantAnimationFrames.length > 0) {
    markdownOutput += `## Long Animation Frames (Highlights)\n\n`;
    significantAnimationFrames
      .sort((a, b) => b.blockingDuration - a.blockingDuration)
      .forEach(entry => {
        markdownOutput += formatLongAnimationFrameEntry(entry);
      });
  }

  // Process layout shifts (if available)
  const significantLayoutShifts = entriesByType['layout-shift']?.filter(entry => entry.value > 0.1) || [];
  if (significantLayoutShifts.length > 0) {
    markdownOutput += `## Significant Layout Shifts\n\n`;
    significantLayoutShifts
      .sort((a, b) => b.value - a.value)
      .forEach(entry => {
        markdownOutput += formatLayoutShiftEntry(entry);
      });
  }

  // Process resource timing (if available)
  if (entriesByType.resource) {
    const resourceDurationThreshold = 1000; // 1 second
    const decodedBodySizeThreshold = 1000000; // 1MB
    
    // Find problematic resources
    const problematicResources = entriesByType.resource.filter(entry => {
      return entry.renderBlockingStatus === 'blocking' ||
             entry.duration > resourceDurationThreshold ||
             entry.decodedBodySize > decodedBodySizeThreshold ||
             (entry.serverTiming && entry.serverTiming.some(timing => 
               timing.name === 'cdn-cache' && timing.description === 'MISS'));
    });
    
    if (problematicResources.length > 0) {
      markdownOutput += `## Resource Timing Issues\n\n`;
      // Sort by duration (most impactful first)
      problematicResources
        .sort((a, b) => b.duration - a.duration)
        .forEach(entry => {
          markdownOutput += formatResourceIssueEntry(entry);
        });
    }
  }

  return markdownOutput;
}

// Individual entry formatters - no section headings, just entry details
function formatNavigationEntry(entry) {
  let output = '';
  output += `*   **Duration:** ${entry.duration.toFixed(2)} ms\n`;
  output += `*   **DOM Interactive:** ${entry.domInteractive} ms\n`;
  output += `*   **DOM Content Loaded End:** ${entry.domContentLoadedEventEnd} ms\n`;
  output += `*   **DOM Complete:** ${entry.domComplete} ms\n`;
  output += `*   **Load Event End:** ${entry.loadEventEnd} ms\n`;
  
  if (entry.serverTiming && entry.serverTiming.length > 0) {
    output += `*   **Server Timing (Navigation):**\n`;
    entry.serverTiming.forEach(timing => {
      output += `    *   ${timing.name}: ${timing.description} (${timing.duration}ms)\n`;
    });
  }
  
  output += `\n`;
  return output;
}

function formatLongAnimationFrameEntry(entry) {
  let output = `### Frame at ${entry.startTime.toFixed(2)} ms\n`;
  output += `*   **Duration:** ${entry.duration} ms\n`; 
  output += `*   **Blocking Duration:** ${entry.blockingDuration} ms\n`; 
  
  if (entry.scripts && entry.scripts.length > 0) {
    output += `*   **Suspect Scripts:**\n`;
    entry.scripts.forEach(script => {
      output += `    *   Script: ${script.name} (Duration: ${script.duration} ms)\n`;
      output += `        *   Invoker: ${script.invoker}\n`;
    });
  }
  
  output += `\n`;
  return output;
}

function formatResourceIssueEntry(entry) {
  const resourceDurationThreshold = 1000; // 1 second threshold for "slow" resources
  const decodedBodySizeThreshold = 1000000; // 1MB threshold for large decoded body size

  let output = `### Resource: ${entry.name.split('/').pop() || entry.name}\n`;
  output += `*   **URL:** ${entry.name}\n`;
  output += `*   **Initiator Type:** ${entry.initiatorType}\n`;
  output += `*   **Duration:** ${entry.duration.toFixed(2)} ms`;
  
  if (entry.duration > resourceDurationThreshold) {
    output += ` **(Long Load Time)**`;
  }
  
  output += `\n`;
  output += `*   **Render Blocking Status:** ${entry.renderBlockingStatus}`;
  
  if (entry.renderBlockingStatus === 'blocking') {
    output += ` **(Render Blocking)**`;
  }
  
  output += `\n`;
  output += `*   **Transfer Size:** ${entry.transferSize} bytes\n`;
  output += `*   **Decoded Body Size:** ${entry.decodedBodySize} bytes`;
  
  if (entry.decodedBodySize > decodedBodySizeThreshold) {
    output += ` **(Large Decoded Size: ${(entry.decodedBodySize / 1024 / 1024).toFixed(2)} MB)**`;
  }
  
  output += `\n`;

  if (entry.serverTiming && entry.serverTiming.length > 0) {
    output += `*   **Server Timing:**\n`;
    entry.serverTiming.forEach(timing => {
      output += `    *   ${timing.name}: ${timing.description} (${timing.duration}ms)`;
      if (timing.name === 'cdn-cache' && timing.description === 'MISS') {
        output += ` **(CDN Cache Miss)**`;
      }
      output += `\n`;
    });
  }
  
  output += `\n`;
  return output;
}

function formatLayoutShiftEntry(entry) {
  let output = `### Shift at ${entry.startTime.toFixed(2)} ms\n`;
  output += `*   **Value:** ${entry.value.toFixed(4)} (Significant Shift)\n`;
  output += `*   **Had Recent Input:** ${entry.hadRecentInput}\n`;
  
  if (entry.sources && entry.sources.length > 0) {
    output += `*   **Affected Elements:**\n`;
    entry.sources.forEach(source => {
      output += `    *   Element: ${source.node}\n`;
      output += `        *   Previous Rect: ${JSON.stringify(source.previousRect)}\n`;
      output += `        *   Current Rect: ${JSON.stringify(source.currentRect)}\n`;
    });
  }
  
  output += `\n`;
  return output;
}

function formatLongTaskEntry(entry) {
  let output = `### Task at ${entry.startTime.toFixed(2)} ms\n`;
  output += `*   **Duration:** ${entry.duration} ms\n`;
  if (entry.name) {
    output += `*   **Name:** ${entry.name}\n`;
  }
  if (entry.attribution && entry.attribution.length > 0) {
    output += `*   **Attribution:**\n`;
    entry.attribution.forEach(attr => {
      output += `    *   ${attr.name || 'Unknown'} (${attr.containerType || 'Unknown'})\n`;
    });
  }
  output += `\n`;
  return output;
}

function formatLCPEntry(entry) {
  let output = '';
  
  // Extract element type from the HTML
  let elementType = 'Unknown Element';
  if (entry.element) {
    const match = entry.element.match(/<(\w+)/);
    if (match && match[1]) {
      elementType = match[1].toUpperCase();
    }
  }
  
  // For LCP, there's typically only one main entry that matters,
  // so we can use a more descriptive heading
  output += `### LCP element ${entry.url || elementType}\n`;
  
  output += `*   **Start Time:** ${entry.startTime.toFixed(2)} ms\n`;
  output += `*   **Render Time:** ${entry.renderTime.toFixed(2)} ms\n`;
  output += `*   **Load Time:** ${entry.loadTime.toFixed(2)} ms\n`;
  output += `*   **Size:** ${entry.size} bytes\n`;
  output += `*   **URL:** ${entry.url || 'N/A'}\n`;
  
  output += `*   **Element Type:** ${elementType}\n`;
  
  // Only include full element HTML if it's not too large
  if (entry.element && entry.element.length < 200) {
    output += `*   **Element:** ${entry.element}\n`;
  } else if (entry.element) {
    output += `*   **Element:** ${entry.element.substring(0, 197)}...\n`;
  }
  
  output += `\n`;
  return output;
}

// Browser Setup and Data Collection
async function setupBrowser(deviceType) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  // Apply device configuration
  await page.setViewport(simulationConfig[deviceType].viewport);
  await page.emulateCPUThrottling(simulationConfig[deviceType].cpuThrottling);
  await page.emulateNetworkConditions(simulationConfig[deviceType].networkThrottling);
  await page.setUserAgent(simulationConfig[deviceType].psiUserAgent);
  
  return { browser, page };
}

async function setupRequestBlocking(page, blockRequests) {
  if (!blockRequests) return;
  
  const blockedUrls = blockRequests.split(',');
  await page.setRequestInterception(true);
  
  page.on('request', (request) => {
    const url = request.url();
    const filtered = blockedUrls.some(b => url.includes(b.trim()));
    
    if (filtered) {
      console.log('Blocking', url);
      request.abort();
    } else {
      request.continue();
    }
  });
}

async function setupCSPViolationTracking(page) {
  await page.evaluateOnNewDocument(() => {
    if (!window.CSP_VIOLATIONS) {
      window.CSP_VIOLATIONS = [];
      window.addEventListener('securitypolicyviolation', (e) => {
        window.CSP_VIOLATIONS.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
          lineNumber: e.lineNumber,
          columnNumber: e.columnNumber,
          sourceFile: e.sourceFile,
          statusCode: e.statusCode,
          referrer: e.referrer,
          effectiveDirective: e.effectiveDirective
        });
      });
    }
  });
}

async function collectPerformanceEntries(page) {
  return JSON.parse(await page.evaluate(async () => {
    console.log('Evaluating performance entries');

    const clone = (obj) => {
      return JSON.parse(JSON.stringify(obj));
    };
  
    const appendEntries = async (entries, type, cb) => {
      const res = await new Promise((resolve) => {
        // resolve the promise after 5 seconds (in case of no entries)
        window.setTimeout(() => {
          resolve([]);
        }, 5_000);
        return new PerformanceObserver(entryList => {
          const list = entryList.getEntries();
          resolve(list.map((e) => {
            try {
              return cb(e);
            } catch (err) {
              console.error('Failed to clone', e, err);
              return {};
            }
          }));
        }).observe({ type, buffered: true });
      });
      res.forEach(e => entries.push(e));
    };

    const entries = window.performance.getEntries();

    await appendEntries(entries, 'largest-contentful-paint', (e) => ({
      ...clone(e),
      element: e.element?.outerHTML
    }));

    await appendEntries(entries, 'layout-shift', (e) => ({
      ...clone(e),
      sources: e.sources?.map((s) => ({
        ...clone(s),
        node: s.node?.outerHTML,
      })) || []
    }));

    await appendEntries(entries, 'longtask', (e) => ({
      ...clone(e),
      scripts: e.scripts?.map((s) => ({
        ...clone(s),
      })) || []
    }));

    return JSON.stringify(entries, null, 2);
  }, { timeout: 30_000 }));
}

async function collectJSApiData(page) {
  return await page.evaluate(async () => {
    const fontsSet = await document.fonts.ready;
    return {
      fonts: [...fontsSet].map((ff) => ({
        ascentOverride: ff.ascentOverride,
        descentOverride: ff.descentOverride,
        display: ff.display,
        family: ff.family,
        featureSettings: ff.featureSettings,
        lineGapOverride: ff.lineGapOverride,
        sizeAdjust: ff.sizeAdjust,
        status: ff.status,
        stretch: ff.stretch,
        style: ff.style,
        unicodeRange: ff.unicodeRange,
        variant: ff.variant,
        weight: ff.weight,
      })),
      usedFonts: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'p', 'button']
        .map((sel) => document.querySelector(sel))
        .filter((sel) => !!sel)
        .map((el) => el && window.getComputedStyle(el).fontFamily)
        .map((ff) => ff.split(',').map((f) => f.trim().replace(/['"]/g, '')))
        .reduce((set, val) => { set[val[0]] = []; val.splice(1).forEach((v) => set[val[0]].push(v)); return set; }, {}),
      cspViolations: window.CSP_VIOLATIONS || [],
    };
  }, { timeout: 30_000 });
}

// Code Coverage Functions
async function setupCodeCoverage(page) {
  return Promise.all([
    page.coverage.startJSCoverage({
      includeRawScriptCoverage: true,
      useBlockCoverage: false,
    }),
    page.coverage.startCSSCoverage(),
  ]);
}

async function collectCodeCoverage(page) {
  const [jsCoverage, cssCoverage] = await Promise.all([
    page.coverage.stopJSCoverage(),
    page.coverage.stopCSSCoverage(),
  ]);
  return [...jsCoverage, ...cssCoverage];
}

async function waitForLCP(page) {
  return page.evaluate(() => {
    return new Promise((resolve) => {
      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        if (entries.length > 0) {
          resolve(entries[entries.length - 1]); // Get the last LCP entry
        }
      }).observe({ entryTypes: ['largest-contentful-paint'] });
    });
  }, { timeout: 30_000 });
}

function mergeCoverage(report1Entries, report2Entries) {
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
              ranges: entry.ranges.map(r => ({ ...r }))
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

// Code Coverage Analysis Functions

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

    // Analyze JavaScript coverage
    if (pageEntry.rawScriptCoverage) {
      analyzeJSCoverage(lcpEntry, pageEntry, result[filePath]);
    }

    // Analyze CSS coverage
    if (pageEntry.ranges && !pageEntry.rawScriptCoverage) {
      analyzeCSSCoverage(lcpEntry, pageEntry, result[filePath]);
    }
  });

  return result;
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
  const ruleRegex = /([^{]+)\s*\{[^}]*\}/g;
  let match;

  while ((match = ruleRegex.exec(cssText)) !== null) {
    const selector = match[1].trim();
    const start = match.index;
    const end = match.index + match[0].length;

    // Skip @-rules and focus on selectors
    if (!selector.startsWith('@') && selector) {
      rules.push({
        selector: selector,
        start: start,
        end: end
      });
    }
  }

  return rules;
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

// Main Data Collection Function
export async function collect(pageUrl, deviceType, { skipCache, skipTlsCheck, blockRequests }) {
  // Try to get cached results first
  let harFile = getCachedResults(pageUrl, deviceType, 'har');
  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  let jsApi = getCachedResults(pageUrl, deviceType, 'jsapi');
  let lcpCoverageData = getCachedResults(pageUrl, deviceType, 'coverage.lcp');
  let pageCoverageData = getCachedResults(pageUrl, deviceType, 'coverage.page');
  let coverageUsageAnalysis = getCachedResults(pageUrl, deviceType, 'coverage');
  
  if (harFile && perfEntries && fullHtml && jsApi && lcpCoverageData && coverageUsageAnalysis && !skipCache) {
    return {
      har: harFile,
      harSummary: summarizeHAR(harFile, deviceType),
      perfEntries,
      perfEntriesSummary: summarizePerformanceEntries(perfEntries, deviceType),
      fullHtml,
      jsApi,
      lcpCoverageData,
      pageCoverageData,
      coverageUsageAnalysis,
      fromCache: true
    };
  }

  // Setup browser
  const { browser, page } = await setupBrowser(deviceType);
  const har = new PuppeteerHar(page);
  
  // Setup request blocking if needed
  await setupRequestBlocking(page, blockRequests);
  
  // Setup CDP session for Performance metrics and coverage
  const client = await page.target().createCDPSession();
  await client.send('Performance.enable');

  // Setup code coverage tracking
  await setupCodeCoverage(page);

  // Setup CSP violation tracking
  await setupCSPViolationTracking(page);

  // Start HAR recording if needed
  if (!harFile || skipCache) {
    await har.start();
  }

  // Navigate to page
  try {
    await page.goto(pageUrl, {
      timeout: 120_000,
      waitUntil: 'domcontentloaded',
    });
  } catch (err) {
    console.error('Page did not idle after 120s. Force continuing.', err.message);
  }
  
  // Collect coverage data at LCP
  await waitForLCP(page);
  lcpCoverageData = await collectCodeCoverage(page);

  await setupCodeCoverage(page);

  // Convert to Istanbul format and write report
  puppeteerToIstanbul.write(lcpCoverageData, { storagePath: getFilePrefix(pageUrl, deviceType, 'nyc-lcp') });
  // Clear the istanbul report cache so LCP data doesn't leak into the page coverage data
  PTI.resetJSONPart();
  
  await page.waitForNetworkIdle({ concurrency: 0 });
  
  // Collect performance data
  if (!perfEntries || skipCache) {
    perfEntries = await collectPerformanceEntries(page);
    cacheResults(pageUrl, deviceType, 'perf', perfEntries);
  }
  
  // Generate performance summary
  let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType);
  cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);

  // Collect HAR data
  if (!harFile || skipCache) {
    harFile = cleanupHarData(await har.stop());
  }

  // Collect HTML content
  if (!fullHtml || skipCache) {
    fullHtml = await page.evaluate(() => document.documentElement.outerHTML);
  }
  cacheResults(pageUrl, deviceType, 'html', fullHtml);

  // Collect JavaScript API data
  if (!jsApi || skipCache) {
    jsApi = await collectJSApiData(page);
  }
  cacheResults(pageUrl, deviceType, 'jsapi', jsApi);

  pageCoverageData = await collectCodeCoverage(page);
  pageCoverageData = mergeCoverage(lcpCoverageData, pageCoverageData);

  // Convert to Istanbul format and write report
  puppeteerToIstanbul.write(pageCoverageData, { storagePath: getFilePrefix(pageUrl, deviceType, 'nyc-page') });

  // Close browser and save results
  await browser.close();
  cacheResults(pageUrl, deviceType, 'har', harFile);
  cacheResults(pageUrl, deviceType, 'coverage.lcp', lcpCoverageData);
  cacheResults(pageUrl, deviceType, 'coverage.page', pageCoverageData);
  
  // Generate HAR summary
  const harSummary = summarizeHAR(harFile, deviceType);
  cacheResults(pageUrl, deviceType, 'har', harSummary);

  // Analyze coverage usage
  coverageUsageAnalysis = analyzeCoverageUsage(lcpCoverageData, pageCoverageData);
  cacheResults(pageUrl, deviceType, 'coverage', coverageUsageAnalysis);

  // Return collected data
  return { 
    har: harFile, 
    harSummary, 
    perfEntries, 
    perfEntriesSummary, 
    fullHtml, 
    jsApi,
    lcpCoverageData,
    pageCoverageData,
    coverageUsageAnalysis
  };
}
