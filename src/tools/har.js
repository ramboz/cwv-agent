import puppeteer from 'puppeteer';
import { PredefinedNetworkConditions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { Agent } from 'undici';
import { cacheResults, estimateTokenSize, getCachedResults } from '../utils.js';


const cpuThrottling = {
  desktop: 1,
  mobile: 4
};
const networkThrottling = {
  desktop: null,
  mobile: PredefinedNetworkConditions['Slow 4G'],
};
const viewports = {
  desktop: {
    connectionType: 'ethernet',
    width: 1350,
    height: 940,
    deviceScaleFactor: 1,
  },
  mobile: {
    connectionType: 'cellular4g',
    width: 412,
    height: 823,
    deviceScaleFactor: 1.75,
  }
};
const userAgent = {
  desktop: 'Spacecat/1.0',
  mobile: 'Spacecat/1.0',
}

export function summarizePerformanceEntries(performanceEntries) {
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

export function summarizeHAR(harData) {
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

   // 3. Long Wait Times (> 500ms) - TTFB.  Separate this from blocking.
  const longTTFB = entries
    .filter(entry => entry.timings && entry.timings.wait > 500)
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

export async function collect(pageUrl, deviceType, { skipCache, skipTlsCheck }) {
  const requestMap = {};
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport(viewports[deviceType]);
  await page.emulateCPUThrottling(cpuThrottling[deviceType]);
  await page.emulateNetworkConditions(networkThrottling[deviceType]);
  await page.setRequestInterception(true);
  await page.setUserAgent(userAgent[deviceType]);
  const har = new PuppeteerHar(page);

  const { hostname, pathname } = new URL(pageUrl);
  let mainHeaders;

  // Intercept requests so we can gather the 
  page.on('request', async (request) => {
    const request_url = new URL(request.url());
    try {
      if (request_url.hostname === hostname
        && (request_url.pathname === pathname
          || request_url.pathname.endsWith('.html')
          || (request_url.pathname.endsWith('.js')
            && (request_url.pathname.startsWith('/etc.clientlibs/') || !request_url.pathname.endsWith('.min.js')))
          || (request_url.pathname.endsWith('.css')
            && (request_url.pathname.includes('/etc.clientlibs/') || !request_url.pathname.endsWith('.min.css'))))) {
        const resp = await fetch(request.url(), {
          // headers to bypass basic bot blocks
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'en-US,en;q=0.5',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'User-Agent': 'Spacecat 1/0'
          },
          dispatcher: skipTlsCheck ? new Agent({
            connect: {
              rejectUnauthorized: false,
            },
          }) : undefined,
        });
        const body = await resp.text();
        requestMap[request_url.href] = body;
        if (request_url.href === pageUrl) {
          mainHeaders = resp.headers;
        }
      }
      request.continue();
    } catch (err) {
      console.error('Failed to fetch', request_url.href, err);
      request.abort();
    }
  });
  
  // Enable DevTools protocol
  const client = await page.target().createCDPSession();
  await client.send('Performance.enable');

  let harFile = getCachedResults(pageUrl, deviceType, 'har');
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

  if (requestMap[pageUrl] && requestMap[pageUrl].includes('Access Denied')) {
    throw new Error('Access Denied: ' + pageUrl);
  }


  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let perfEntriesSummary;
  if (!perfEntries || skipCache) {
    const perfEntries = await page.evaluate(async () => {
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
    });
    cacheResults(pageUrl, deviceType, 'perf', JSON.parse(perfEntries, null, 2));
    // perfEntriesSummary = summarizePerformanceEntries(perfEntries);
    // cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);
  }

  // console.log('Estimating code size...');
  // console.table(
  //   Object.entries(requestMap).map(([url, content]) => ({ url, tokens: estimateTokenSize(content) }))
  // );
  Object.entries(requestMap).map(([url, content]) => {
    cacheResults(url, deviceType, 'code', content);
  });

  if (!harFile || skipCache) {
    harFile = await har.stop();
  }

  await browser.close();
  cacheResults(pageUrl, deviceType, 'har', harFile);
  const harSummary = summarizeHAR(harFile);
  cacheResults(pageUrl, deviceType, 'har', harSummary);

  return { resources: requestMap, har: harFile, harSummary, perfEntries, perfEntriesSummary, mainHeaders };
};
