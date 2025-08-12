import { cacheResults, getCachedResults } from '../../utils.js';
import { setupBrowser, waitForLCP } from './browser-utils.js';
import { summarizeHAR, startHARRecording, stopHARRecording } from './har-collector.js';
import { summarizePerformanceEntries, collectPerformanceEntries } from './performance-collector.js';
import { 
  summarizeCoverageData,
  setupCodeCoverage,
  collectLcpCoverage,
  collectPageCoverage,
} from './coverage-collector.js';
import { collectJSApiData, setupCSPViolationTracking } from './js-api-collector.js';

// Main Data Collection Function
export async function collect(pageUrl, deviceType, { skipCache, blockRequests, collectHar = true, collectCoverage = true }) {
  // Load cached artifacts
  let harFile = getCachedResults(pageUrl, deviceType, 'har');
  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  let jsApi = getCachedResults(pageUrl, deviceType, 'jsapi');
  let coverageData = getCachedResults(pageUrl, deviceType, 'coverage');

  // Determine what we need to collect in this pass
  const needPerf = !perfEntries || skipCache;
  const needHtml = !fullHtml || skipCache;
  const needJsApi = !jsApi || skipCache;
  const needHar = collectHar && (!harFile || skipCache);
  const needCoverage = collectCoverage && (!coverageData || skipCache);

  // If nothing is needed, return from cache only what's relevant
  if (!needPerf && !needHtml && !needJsApi && !needHar && !needCoverage) {
    return {
      har: collectHar ? harFile : null,
      harSummary: collectHar && harFile ? summarizeHAR(harFile, deviceType) : null,
      perfEntries,
      perfEntriesSummary: summarizePerformanceEntries(perfEntries, deviceType),
      fullHtml,
      jsApi,
      coverageData: collectCoverage ? coverageData : null,
      coverageDataSummary: collectCoverage && coverageData ? summarizeCoverageData(coverageData, deviceType) : null,
      fromCache: true,
    };
  }

  // Setup browser
  const { browser, page } = await setupBrowser(deviceType, blockRequests);

  // Setup code coverage tracking only if requested
  if (needCoverage) {
    await setupCodeCoverage(page);
  }

  // Setup CSP violation tracking
  await setupCSPViolationTracking(page);

  // Start HAR recording only if requested
  let har = null;
  if (needHar) {
    har = await startHARRecording(page);
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
  try {
    await waitForLCP(page);
  } catch (err) {
    console.error('LCP not found after 30s. Force continuing.', err.message);
  }

  let lcpCoverageData = null;
  if (needCoverage) {
    try {
      lcpCoverageData = await collectLcpCoverage(page, pageUrl, deviceType);
    } catch (err) {
      console.error('Error collecting LCP coverage data:', err.message);
      lcpCoverageData = {}
    }
  }

  // Waiting for page to finish loading
  try {
    await page.waitForNetworkIdle({ concurrency: 0, idleTime: 1_000 });
  } catch (err) {
    // Do nothing
  }

  // Collect performance data
  if (needPerf) {
    perfEntries = await collectPerformanceEntries(page);
    cacheResults(pageUrl, deviceType, 'perf', perfEntries);
  }

  // Collect HAR data
  if (needHar) {
    harFile = await stopHARRecording(har);
    const count = Array.isArray(harFile?.log?.entries) ? harFile.log.entries.length : 0;
  }

  // Collect HTML content
  if (needHtml) {
    fullHtml = await page.evaluate(() => document.documentElement.outerHTML);
  }
  cacheResults(pageUrl, deviceType, 'html', fullHtml);

  // Collect JavaScript API data
  if (needJsApi) {
    jsApi = await collectJSApiData(page);
  }
  cacheResults(pageUrl, deviceType, 'jsapi', jsApi);

  if (needCoverage) {
    try {
      coverageData = await collectPageCoverage(page, pageUrl, deviceType, lcpCoverageData);
    } catch (err) {
      console.error('Error collecting page coverage data:', err.message);
      coverageData = {}
    }
  }

  // Close browser and save results
  await browser.close();

  // Generate performance summary
  let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType);
  cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);
  
  // Generate HAR summary (only if we recorded or had it available)
  const harSummary = (collectHar && harFile) ? summarizeHAR(harFile, deviceType) : null;
  if (collectHar && harFile) {
    cacheResults(pageUrl, deviceType, 'har', harFile);
    cacheResults(pageUrl, deviceType, 'har', harSummary);
  }

  // Generate coverage usage summary
  const coverageDataSummary = (collectCoverage && coverageData) ? summarizeCoverageData(coverageData, deviceType) : null;
  if (collectCoverage && coverageData) {
    cacheResults(pageUrl, deviceType, 'coverage', coverageData);
    cacheResults(pageUrl, deviceType, 'coverage', coverageDataSummary);
  }

  // Return collected data
  return { 
    har: collectHar ? harFile : null, 
    harSummary, 
    perfEntries, 
    perfEntriesSummary, 
    fullHtml, 
    jsApi,
    coverageData: collectCoverage ? coverageData : null,
    coverageDataSummary
  };
}
