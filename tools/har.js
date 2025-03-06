import beautify from 'js-beautify';
import { parse } from 'node-html-parser';
import puppeteer from 'puppeteer';
import { PredefinedNetworkConditions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import { cacheResults, estimateTokenSize, getSummaryLogger } from '../utils.js';


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

async function summarizeHtmlHead(pageUrl, deviceType, log) {
  log('Markup for the head section of the HTML:');
  log('');
  const resp = await fetch(pageUrl, {
    headers: {
      'User-Agent': userAgent[deviceType],
    }
  });
  const html = await resp.text();
  const root = parse(html);
  log(beautify.html(root.querySelector('head').outerHTML, { preserve_newlines: false }));
}


async function summarizeFirstSection(page, log) {
  log('Markup for the 1st section:');
  log('');
  const data = await page.evaluate(() => document.querySelector('main .section').outerHTML);
  log(beautify.html(data, { preserve_newlines: false }));
}


export default async function collectHar(pageUrl, deviceType) {
  console.debug('Collecting HAR for', pageUrl, 'on', deviceType);
  const requestMap = {};
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport(viewports[deviceType]);
  await page.emulateCPUThrottling(cpuThrottling[deviceType]);
  await page.emulateNetworkConditions(networkThrottling[deviceType]);
  await page.setRequestInterception(true);
  await page.setUserAgent(userAgent[deviceType]);
  const har = new PuppeteerHar(page);

  const domain = new URL(pageUrl).origin;
  // Intercept requests so we can gather the 
  page.on('request', async (request) => {
    const request_url = new URL(request.url());
    try {
      if (request_url.origin === domain
        && (request_url.href === pageUrl
          || request_url.pathname.endsWith('.html')
          || (request_url.pathname.endsWith('.js') && !request_url.pathname.endsWith('.min.js'))
          || (request_url.pathname.endsWith('.css') && !request_url.pathname.endsWith('.min.css')))) {
        const resp = await fetch(request.url());
        const body = await resp.text();
        requestMap[request_url] = body;
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
  await har.start();

  await page.goto(pageUrl, {
    timeout: 120_000,
    waitUntil: 'networkidle2',
  });
  await new Promise(resolve => setTimeout(resolve, 30_000));

  const rawPerfEntries = await page.evaluate(async () => {
    const entries = window.performance.getEntries();
    entries.push(...await new Promise((resolve) => {
      new PerformanceObserver(entryList => {
        resolve(entryList.getEntries());
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    }));
    entries.push(...await new Promise((resolve) => {
      new PerformanceObserver(entryList => {
        resolve(entryList.getEntries());
      }).observe({ type: 'layout-shift', buffered: true });
    }));
    entries.push(...await new Promise((resolve) => {
      new PerformanceObserver(entryList => {
        resolve(entryList.getEntries());
      }).observe({ type: 'longtask', buffered: true });
    }));
    return JSON.stringify(entries, null, 2);
  });
  cacheResults(pageUrl, deviceType, 'perf', rawPerfEntries);

  console.log('Estimating code size...');
  console.table(
    Object.entries(requestMap).map(([url, content]) => ({ url, tokens: estimateTokenSize(content) }))
  );
  Object.entries(requestMap).map(([url, content]) => {
    cacheResults(url, deviceType, 'code', content);
  });

  const harFile = await har.stop();

  // Summarize
  const logger = getSummaryLogger(pageUrl, deviceType, 'har');
  await summarizeHtmlHead(pageUrl, deviceType, (...str) => logger.write(str.join(' ') + '\n'));
  logger.write('\n');
  await summarizeFirstSection(page, (...str) => logger.write(str.join(' ') + '\n'));
  logger.end();

  await browser.close();
  cacheResults(pageUrl, deviceType, 'har', harFile);

  console.debug('Done collecting HAR file, including collecting code for', Object.keys(requestMap).length, 'resources');
  return { requests: requestMap, har: harFile };
};
