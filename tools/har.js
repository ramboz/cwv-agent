import puppeteer from 'puppeteer';
import { PredefinedNetworkConditions } from 'puppeteer';
import PuppeteerHar from 'puppeteer-har';
import request_client from 'request-promise-native';
import { cacheResults, estimateTokenSize } from '../utils.js';

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

export default async function collectHar(pageUrl, deviceType) {
  console.debug('Collecting HAR for', pageUrl, 'on', deviceType);
  const requestMap = {};
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport(viewports[deviceType]);
  await page.emulateCPUThrottling(cpuThrottling[deviceType]);
  await page.emulateNetworkConditions(networkThrottling[deviceType]);
  await page.setRequestInterception(true);
  const har = new PuppeteerHar(page);

  const domain = new URL(pageUrl).origin;
  // Intercept requests so we can gather the 
  page.on('request', (request) => {
    request_client({
      uri: request.url(),
      resolveWithFullResponse: true,
    }).then((response) => {
      const request_url = new URL(request.url());
      const response_body = response.body;
      if (request_url.origin === domain
        && (request_url.href === pageUrl
          || request_url.href.endsWith('.html')
          || (request_url.href.endsWith('.js') && !request_url.href.endsWith('.min.js'))
          || (request_url.href.endsWith('.css') && !request_url.href.endsWith('.min.css')))) {
        requestMap[request_url] = response_body;
      }
      request.continue();
    }).catch(() => {
      request.abort();
    });
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

  console.log('Estimating code size...');
  console.table(
    Object.entries(requestMap).map(([url, content]) => ({ url, tokens: estimateTokenSize(content) }))
  );
  Object.entries(requestMap).map(([url, content]) => {
    cacheResults(url, 'code', content);
  });

  const harFile = await har.stop();
  await browser.close();
  cacheResults(pageUrl, 'har', harFile);
  console.debug('Done collecting HAR file, including collecting code for', Object.keys(requestMap).length, 'resources');
  return { requests: requestMap, har: harFile };
};
