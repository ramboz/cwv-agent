import puppeteer from 'puppeteer';
import { PredefinedNetworkConditions } from 'puppeteer';
import { USER_AGENTS } from '../../utils.js';

// Device configuration profiles
export const simulationConfig = {
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

export async function setupBrowser(deviceType, blockRequests) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Setup CDP session for Performance metrics and coverage
  const client = await page.target().createCDPSession();
  await client.send('Performance.enable');

  // Apply device configuration
  await page.setViewport(simulationConfig[deviceType].viewport);
  await page.emulateCPUThrottling(simulationConfig[deviceType].cpuThrottling);
  await page.emulateNetworkConditions(simulationConfig[deviceType].networkThrottling);
  await page.setUserAgent(simulationConfig[deviceType].psiUserAgent);
  
  // Setup request blocking if needed
  await setupRequestBlocking(page, blockRequests);

  return { browser, page };
}

export async function setupRequestBlocking(page, blockRequests) {
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

export async function waitForLCP(page) {
  return page.evaluate(() => {
    return new Promise((resolve) => {
      const lcpTimeout = window.setTimeout(() => resolve(null), 30_000);
      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        if (entries.length > 0) {
          window.clearTimeout(lcpTimeout);
          resolve(entries[entries.length - 1]); // Get the last LCP entry
        }
      }).observe({ entryTypes: ['largest-contentful-paint'] });
    });
  }, { timeout: 30_000 });
}
