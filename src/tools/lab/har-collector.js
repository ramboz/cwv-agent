import PuppeteerHar from 'puppeteer-har';

// HAR Processing Functions
export function cleanupHarData(har) {
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

  // Check for different types of bottlenecks
  const bottleneckReports = analyzeBottlenecks(entries, deviceType);
  
  if (bottleneckReports.length > 0) {
    report += bottleneckReports.join('\n');
  } else {
    report += '* No significant bottlenecks found based on provided HAR data.\n';
  }

  return report;
}

function analyzeBottlenecks(entries, deviceType) {
  const reports = [];
  
  // Add bottleneck analyses
  const largeTransfers = findLargeTransfers(entries);
  if (largeTransfers) reports.push(largeTransfers);
  
  const longBlocking = findLongBlockingTimes(entries);
  if (longBlocking) reports.push(longBlocking);
  
  const longTTFB = findLongTTFB(entries, deviceType);
  if (longTTFB) reports.push(longTTFB);
  
  const http1Resources = findHTTP1Resources(entries);
  if (http1Resources) reports.push(http1Resources);
  
  const redirects = findRedirects(entries);
  if (redirects) reports.push(redirects);
  
  return reports;
}

function findLargeTransfers(entries) {
  // 1. Large Transfer Sizes (Top 5, > 100KB)
  const largeFiles = entries
    .filter(entry => entry.response && entry.response._transferSize > 100 * 1024) // > 100KB
    .sort((a, b) => b.response._transferSize - a.response._transferSize)
    .slice(0, 5); // Limit to top 5

  if (largeFiles.length > 0) {
    let report = '* **Large File Transfers:**\n';
    largeFiles.forEach(entry => {
      report += `    * ${entry.request.url} (${Math.round(entry.response._transferSize / 1024)} KB)\n`;
    });
    return report;
  }
  return null;
}

function findLongBlockingTimes(entries) {
  // 2. Long Blocking Times (> 10ms)
  const longBlocking = entries
    .filter(entry => entry.timings && entry.timings.blocked > 10)
    .sort((a, b) => b.timings.blocked - a.timings.blocked);

  if (longBlocking.length > 0) {
    let report = '* **Significant Blocking Times (DNS, Connect, SSL):**\n';
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
    return report;
  }
  return null;
}

function findLongTTFB(entries, deviceType) {
  // 3. Long Wait Times (> 500ms desktop / >1s mobile) - TTFB
  const ttfbThreshold = deviceType === 'desktop' ? 500 : 1000;
  const longTTFB = entries
    .filter(entry => entry.timings && entry.timings.wait > ttfbThreshold)
    .sort((a, b) => b.timings.wait - a.timings.wait);

  if (longTTFB.length > 0) {
    let report = '* **High Time to First Byte (TTFB) - Server Response Times:**\n';
    longTTFB.forEach(entry => {
      report += `    * ${entry.request.url}: ${Math.round(entry.timings.wait)}ms\n`;
    });
    return report;
  }
  return null;
}

function findHTTP1Resources(entries) {
  // 4. HTTP/1.1 Connections
  const http1Resources = entries.filter(entry => 
    entry.response && entry.response.httpVersion.toLowerCase().startsWith('http/1.1')
  );

  if (http1Resources.length > 0) {
    let report = '* **Resources using HTTP/1.1 (not HTTP/2 or HTTP/3):**\n';
    http1Resources.forEach(entry => {
      report += `   * ${entry.request.url}\n`;
    });
    return report;
  }
  return null;
}

function findRedirects(entries) {
  // 5. Redirects
  const redirectStatusCodes = [301, 302, 307, 308];
  const redirects = entries.filter(entry => 
    entry.response && redirectStatusCodes.includes(entry.response.status)
  );
  
  if(redirects.length > 0) {
    let report = `* **Redirects:**\n`;
    redirects.forEach(entry => {
      report += `    * ${entry.request.url} -> ${entry.response.redirectURL} (Status: ${entry.response.status})\n`;
    });
    return report;
  }
  return null;
}

// HAR Recording Functions
export async function startHARRecording(page) {
  const har = new PuppeteerHar(page);
  await har.start();
  return har;
}

export async function stopHARRecording(har) {
  const harData = await har.stop();
  return cleanupHarData(harData);
} 