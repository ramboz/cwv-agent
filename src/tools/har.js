import puppeteer from 'puppeteer';
import { PredefinedNetworkConditions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { cacheResults, getCachedResults } from '../utils.js';

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
    userAgent: 'Spacecat/1.0'
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
    userAgent: 'Spacecat/1.0'
  }
};

function cleanup(har) {
  // Remove preflight requests (OPTIONS) from HAR data
  if (har && har.log && har.log.entries) {
    har.log.entries = har.log.entries.filter(entry => {
      return !(entry.request && entry.request.method === 'OPTIONS');
    });
  }
  return har;
}

export function summarizePerformanceEntries(performanceEntries, deviceType) {
  let markdownOutput = `# Performance Analysis (Focused)\n\n`;

  performanceEntries.forEach((entry) => {
    const entryType = entry.entryType;

    switch (entryType) {
      case 'navigation':
        markdownOutput += `## Navigation Timing (Highlights)\n\n`;
        markdownOutput += `*   **Duration:** ${entry.duration.toFixed(2)} ms\n`;
        markdownOutput += `*   **DOM Interactive:** ${entry.domInteractive} ms\n`;
        markdownOutput += `*   **DOM Content Loaded End:** ${entry.domContentLoadedEventEnd} ms\n`;
        markdownOutput += `*   **DOM Complete:** ${entry.domComplete} ms\n`;
        markdownOutput += `*   **Load Event End:** ${entry.loadEventEnd} ms\n`;
        if (entry.serverTiming && entry.serverTiming.length > 0) {
          markdownOutput += `*   **Server Timing (Navigation):**\n`;
          entry.serverTiming.forEach(timing => {
            markdownOutput += `    *   ${timing.name}: ${timing.description} (${timing.duration}ms)\n`;
          });
        }
        markdownOutput += `\n`;
        break;

      case 'long-animation-frame':
        if (entry.blockingDuration > 0) {
          markdownOutput += `## Long Animation Frames (Highlights)\n\n`;
          markdownOutput += `### Long Animation Frame at ${entry.startTime.toFixed(2)} ms (Duration: ${entry.duration} ms, Blocking: ${entry.blockingDuration} ms)\n`;
          markdownOutput += `*   Blocking Duration: **${entry.blockingDuration} ms**\n`; // Highlight blocking duration
          if (entry.scripts && entry.scripts.length > 0) {
            markdownOutput += `*   **Suspect Scripts:**\n`;
            entry.scripts.forEach(script => {
              markdownOutput += `    *   Script: ${script.name} (Duration: ${script.duration} ms)\n`;
              markdownOutput += `        *   Invoker: ${script.invoker}\n`;
            });
          }
          markdownOutput += `\n`;
        }
        break;

      case 'resource':
        const resourceDurationThreshold = 1000; // 1 second threshold for "slow" resources
        const decodedBodySizeThreshold = 1000000; // 1MB threshold for large decoded body size

        let isPerformanceIssue = false;
        if (entry.renderBlockingStatus === 'blocking') {
          isPerformanceIssue = true;
        }
        if (entry.duration > resourceDurationThreshold) {
          isPerformanceIssue = true;
        }
        if (entry.decodedBodySize > decodedBodySizeThreshold) {
          isPerformanceIssue = true;
        }
        if (entry.serverTiming && entry.serverTiming.some(timing => timing.name === 'cdn-cache' && timing.description === 'MISS')) {
          isPerformanceIssue = true; // CDN Cache MISS is a potential issue
        }

        if (isPerformanceIssue) {
          markdownOutput += `## Resource Timing Issues\n\n`;
          markdownOutput += `### Potentially Problematic Resource: ${entry.name}\n`;
          markdownOutput += `*   **Initiator Type:** ${entry.initiatorType}\n`;
          markdownOutput += `*   **Duration:** ${entry.duration.toFixed(2)} ms **(Long Load Time)**\n`; // Highlight long duration
          markdownOutput += `*   **Render Blocking Status:** ${entry.renderBlockingStatus} **(Render Blocking)**\n`; // Highlight if blocking
          markdownOutput += `*   **Transfer Size:** ${entry.transferSize} bytes\n`;
          markdownOutput += `*   **Decoded Body Size:** ${entry.decodedBodySize} bytes`;
          if (entry.decodedBodySize > decodedBodySizeThreshold) {
            markdownOutput += ` **(Large Decoded Size: ${(entry.decodedBodySize / 1024 / 1024).toFixed(2)} MB)**`; // Highlight large decoded size
          }
          markdownOutput += `\n`;

          if (entry.serverTiming && entry.serverTiming.length > 0) {
            markdownOutput += `*   **Server Timing:**\n`;
            entry.serverTiming.forEach(timing => {
              markdownOutput += `    *   ${timing.name}: ${timing.description} (${timing.duration}ms)`;
              if (timing.name === 'cdn-cache' && timing.description === 'MISS') {
                markdownOutput += ` **(CDN Cache Miss)**`; // Highlight cache miss
              }
              markdownOutput += `\n`;
            });
          }
          markdownOutput += `\n`;
        }
        break;


      case 'layout-shift':
        if (entry.value > 0.1) { //Layout shifts with value > 0.1 are considered significant
          markdownOutput += `## Significant Layout Shifts\n\n`;
          markdownOutput += `### Layout Shift at ${entry.startTime.toFixed(2)} ms (Value: ${entry.value.toFixed(4)})\n`;
          markdownOutput += `*   Value: **${entry.value.toFixed(4)}** (Significant Shift)\n`; // Highlight value
          markdownOutput += `*   Had Recent Input: ${entry.hadRecentInput}\n`;
          if (entry.sources && entry.sources.length > 0) {
            markdownOutput += `*   Sources:\n`;
            entry.sources.forEach(source => {
              markdownOutput += `    *   Node: ${source.node}\n`;
              markdownOutput += `        *   Previous Rect: ${JSON.stringify(source.previousRect)}\n`;
              markdownOutput += `        *   Current Rect: ${JSON.stringify(source.currentRect)}\n`;
            });
          }
          markdownOutput += `\n`;
        }
        break;

      case 'longtask':
        if (entry.duration > 100) { // Longtasks > 100ms are considered significant
          markdownOutput += `## Long Tasks (Highlights)\n\n`;
          markdownOutput += `### Long Task at ${entry.startTime.toFixed(2)} ms (Duration: **${entry.duration} ms**)\n`; //Highlight long duration
          markdownOutput += `\n`;
        }
        break;

      case 'largest-contentful-paint':
        markdownOutput += `## Largest Contentful Paint (LCP)\n\n`; // Keep LCP as it's a key metric
        markdownOutput += `*   **Start Time:** ${entry.startTime.toFixed(2)} ms\n`;
        markdownOutput += `*   **Render Time:** ${entry.renderTime.toFixed(2)} ms\n`;
        markdownOutput += `*   **Load Time:** ${entry.loadTime.toFixed(2)} ms\n`;
        markdownOutput += `*   **Size:** ${entry.size} bytes\n`;
        markdownOutput += `*   **URL:** ${entry.url}\n`;
        markdownOutput += `*   **Element:** ${entry.element}\n`;
        markdownOutput += `\n`;
        break;

      default:
          // Optionally handle other entry types or ignore them
          break;
    }
  });

  return markdownOutput;
}

export function summarizeHAR(harData, deviceType) {
  if (!harData?.log?.entries) {
    return 'No valid HTTP Archive data available.';
  }

  const entries = harData.log.entries;
  let report = '**Additional Bottlenecks from HAR Data:**\n\n';
  let hasBottlenecks = false;

  // 1. Large Transfer Sizes (Top 5, > 100KB)
  const largeFiles = entries
    .filter(entry => entry.response && entry.response._transferSize > 100 * 1024) // > 100KB
    .sort((a, b) => b.response._transferSize - a.response._transferSize)
    .slice(0, 5); // Limit to top 5

  if (largeFiles.length > 0) {
    hasBottlenecks = true;
    report += '* **Large File Transfers:**\n';
    largeFiles.forEach(entry => {
      report += `    * ${entry.request.url} (${Math.round(entry.response._transferSize / 1024)} KB)\n`;
    });
  }

  // 2. Long Blocking Times (> 10ms)
  const longBlocking = entries
    .filter(entry => entry.timings && entry.timings.blocked > 10)
    .sort((a, b) => b.timings.blocked - a.timings.blocked);

  if (longBlocking.length > 0) {
    hasBottlenecks = true;
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
  }

   // 3. Long Wait Times (> 500ms desktop / >1s mobile) - TTFB.  Separate this from blocking.
  const longTTFB = entries
    .filter(entry => entry.timings && entry.timings.wait > (deviceType === 'desktop' ? 500 : 1000))
    .sort((a, b) => b.timings.wait - a.timings.wait);

  if (longTTFB.length > 0) {
    hasBottlenecks = true;
    report += '* **High Time to First Byte (TTFB) - Server Response Times:**\n';
    longTTFB.forEach(entry => {
      report += `    * ${entry.request.url}: ${Math.round(entry.timings.wait)}ms\n`;
    });
  }

    // 4. HTTP/1.1 Connections (Identify resources *not* using HTTP/2 or HTTP/3)
  const http1Resources = entries.filter(entry => entry.response && entry.response.httpVersion.toLowerCase().startsWith('http/1.1'));

   if (http1Resources.length > 0) {
     hasBottlenecks = true;
     report += '* **Resources using HTTP/1.1 (not HTTP/2 or HTTP/3):**\n';
     http1Resources.forEach(entry => {
       report += `   * ${entry.request.url}\n`;
     });
   }


  // 5. Redirects
  const redirects = entries.filter(entry => entry.response && (entry.response.status === 301 || entry.response.status === 302 || entry.response.status === 307 || entry.response.status === 308));
  if(redirects.length > 0) {
    hasBottlenecks = true;
    report += `* **Redirects:**\n`;
    redirects.forEach(entry => {
      report += `    * ${entry.request.url} -> ${entry.response.redirectURL} (Status: ${entry.response.status})\n`;
    });

  }

  //No significant bottlenecks found
  if (!hasBottlenecks) {
    report += '* No significant bottlenecks found based on provided HAR data.\n';
  }

  return report;
}

export async function collect(pageUrl, deviceType, { skipCache, skipTlsCheck, blockRequests }) {

  let harFile = getCachedResults(pageUrl, deviceType, 'har');
  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  let jsApi = getCachedResults(pageUrl, deviceType, 'jsapi');
  if (harFile && perfEntries && fullHtml && jsApi && !skipCache) {
    return {
      har: harFile,
      harSummary: summarizeHAR(harFile),
      perfEntries,
      perfEntriesSummary: summarizePerformanceEntries(perfEntries),
      fullHtml,
      jsApi,
      fromCache: true
    };
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport(simulationConfig[deviceType].viewport);
  await page.emulateCPUThrottling(simulationConfig[deviceType].cpuThrottling);
  await page.emulateNetworkConditions(simulationConfig[deviceType].networkThrottling);
  await page.setUserAgent(simulationConfig[deviceType].userAgent);
  const har = new PuppeteerHar(page);

  if (blockRequests) {
    const blockedUrls = blockRequests.split(',');
    // // block certain requests
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      // check if the url is in the blockedUrls array
      const filtered = blockedUrls.some(b => url.includes(b.trim()));
      // if (url.includes('/assets/') || url.includes('/s.go-mpulse.net/') || url.includes('KGO4l5Qk3zIB7zm9p50Y99tr') || url.includes('tags.tiqcdn.com')) {
      if (filtered) {
        console.log('Blocking', url);
        request.abort();
      } else {
        request.continue();
      }
    });
  }
  
  // Enable DevTools protocol
  const client = await page.target().createCDPSession();
  await client.send('Performance.enable');

  if (!harFile || skipCache) {
    await har.start();
  }

  try {
    await page.goto(pageUrl, {
      timeout: 120_000,
      waitUntil: 'networkidle2',
    });
  } catch (err) {
    console.error('Page did not idle after 120s. Force continuing.', err.message);
  }
  await new Promise(resolve => setTimeout(resolve, 30_000));

  if (!perfEntries || skipCache) {
    perfEntries = JSON.parse(await page.evaluate(async () => {
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
    }));
    cacheResults(pageUrl, deviceType, 'perf', perfEntries);
  }
  let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType);
  cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);

  if (!harFile || skipCache) {
    harFile = cleanup(await har.stop());
  }

  if (!fullHtml || skipCache) {
    fullHtml = await page.evaluate(() => {
      return document.documentElement.outerHTML;
    });
  }
  cacheResults(pageUrl, deviceType, 'html', fullHtml);

  if (!jsApi || skipCache) {
    jsApi = await page.evaluate(async () => {
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
          .reduce((set, val) => { set[val[0]] = []; val.splice(1).forEach((v) => set[val[0]].push(v)); return set; }, {})
      };
    });
  }
  cacheResults(pageUrl, deviceType, 'jsapi', jsApi);

  await browser.close();
  cacheResults(pageUrl, deviceType, 'har', harFile);
  const harSummary = summarizeHAR(harFile, deviceType);
  cacheResults(pageUrl, deviceType, 'har', harSummary);

  return { har: harFile, harSummary, perfEntries, perfEntriesSummary, fullHtml, jsApi };
};
