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
export async function collect(pageUrl, deviceType, { skipCache, blockRequests }) {
  // Try to get cached results first
  let harFile = getCachedResults(pageUrl, deviceType, 'har');
  let perfEntries = getCachedResults(pageUrl, deviceType, 'perf');
  let fullHtml = getCachedResults(pageUrl, deviceType, 'html');
  let jsApi = getCachedResults(pageUrl, deviceType, 'jsapi');
  let coverageData = getCachedResults(pageUrl, deviceType, 'coverage');
  
  if (harFile && perfEntries && fullHtml && jsApi && coverageData && !skipCache) {
    return {
      har: harFile,
      harSummary: summarizeHAR(harFile, deviceType),
      perfEntries,
      perfEntriesSummary: summarizePerformanceEntries(perfEntries, deviceType),
      fullHtml,
      jsApi,
      coverageData,
      coverageDataSummary: summarizeCoverageData(coverageData, deviceType),
      fromCache: true
    };
  }

  // Setup browser
  const { browser, page } = await setupBrowser(deviceType, blockRequests);

  // Setup code coverage tracking
  if (!coverageData || skipCache) {
    await setupCodeCoverage(page);
  }

  // Setup CSP violation tracking
  await setupCSPViolationTracking(page);

  // Start HAR recording if needed
  let har = null;
  if (!harFile || skipCache) {
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
  if (!coverageData || skipCache) {
    lcpCoverageData = await collectLcpCoverage(page, pageUrl, deviceType);
  }

  // Waiting for page to finish loading
  try {
    await page.waitForNetworkIdle({ concurrency: 0, idleTime: 1_000 });
  } catch (err) {
    // Do nothing
  }

  // Collect performance data
  if (!perfEntries || skipCache) {
    perfEntries = await collectPerformanceEntries(page);
    cacheResults(pageUrl, deviceType, 'perf', perfEntries);
  }

  // Collect HAR data
  if (!harFile || skipCache) {
    harFile = await stopHARRecording(har);
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

  if (!coverageData || skipCache) {
    coverageData = await collectPageCoverage(page, pageUrl, deviceType, lcpCoverageData);
  }

  // Close browser and save results
  await browser.close();

  // Generate performance summary
  let perfEntriesSummary = summarizePerformanceEntries(perfEntries, deviceType);
  cacheResults(pageUrl, deviceType, 'perf', perfEntriesSummary);
  
  // Generate HAR summary
  const harSummary = summarizeHAR(harFile, deviceType);
  cacheResults(pageUrl, deviceType, 'har', harFile);
  cacheResults(pageUrl, deviceType, 'har', harSummary);

  // Generate coverage usage summary
  const coverageDataSummary = summarizeCoverageData(coverageData, deviceType);
  cacheResults(pageUrl, deviceType, 'coverage', coverageData);
  cacheResults(pageUrl, deviceType, 'coverage', coverageDataSummary);

  // Return collected data
  return { 
    har: harFile, 
    harSummary, 
    perfEntries, 
    perfEntriesSummary, 
    fullHtml, 
    jsApi,
    coverageData,
    coverageDataSummary
  };
}
