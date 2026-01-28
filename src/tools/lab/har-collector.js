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
export function summarizeHAR(harData, deviceType, thirdPartyAnalysis = null) {
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

  // Priority 1: Add third-party script attribution section
  if (thirdPartyAnalysis?.summary) {
    report += '\n\n**Third-Party Script Analysis (Priority 1 Data):**\n\n';
    report += `* **Total Scripts**: ${thirdPartyAnalysis.summary.totalScripts}\n`;
    report += `* **Total Transfer Size**: ${Math.round(thirdPartyAnalysis.summary.totalTransferSize / 1024)} KB\n`;
    report += `* **Total Network Time**: ${thirdPartyAnalysis.summary.totalNetworkTime}ms\n`;
    report += `* **Total Execution Time**: ${thirdPartyAnalysis.summary.totalExecutionTime}ms\n`;
    report += `* **Total Blocking Time**: ${thirdPartyAnalysis.summary.totalBlockingTime}ms\n`;
    report += `* **Render-Blocking Scripts**: ${thirdPartyAnalysis.summary.renderBlockingCount}\n`;

    if (thirdPartyAnalysis.categoryImpact?.length > 0) {
      report += '\n**By Category (sorted by execution time):**\n';
      thirdPartyAnalysis.categoryImpact.slice(0, 8).forEach((cat, idx) => {
        report += `  ${idx + 1}. **${cat.category}**: ${cat.scripts} script${cat.scripts > 1 ? 's' : ''}, ` +
                  `${Math.round(cat.transferSize / 1024)} KB, ` +
                  `${cat.executionTime}ms execution, ` +
                  `${cat.networkTime}ms network\n`;
      });
    }

    // Include top individual scripts for context
    if (thirdPartyAnalysis.scripts?.length > 0) {
      const topScripts = [...thirdPartyAnalysis.scripts]
        .sort((a, b) => (b.execution?.totalTime || 0) - (a.execution?.totalTime || 0))
        .slice(0, 5);

      if (topScripts.some(s => s.execution?.totalTime > 0)) {
        report += '\n**Top Scripts by Execution Time:**\n';
        topScripts.forEach((script, idx) => {
          if (script.execution?.totalTime > 0) {
            report += `  ${idx + 1}. **${script.domain}** (${script.category})\n`;
            report += `     - URL: ${script.url.substring(0, 80)}${script.url.length > 80 ? '...' : ''}\n`;
            report += `     - Execution: ${script.execution.totalTime}ms`;
            if (script.isRenderBlocking) {
              report += ' [RENDER-BLOCKING]';
            }
            report += '\n';
            if (script.longTaskAttribution?.length > 0) {
              const totalLongTask = script.longTaskAttribution.reduce((sum, lt) => sum + lt.duration, 0);
              report += `     - Long Tasks: ${script.longTaskAttribution.length} (${totalLongTask}ms total)\n`;
            }
          }
        });
      }
    }
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

  // Critical Gap Fix: Check for deprioritized critical resources
  const deprioritized = findDeprioritizedCriticalResources(entries);
  if (deprioritized) reports.push(deprioritized);

  const timingBreakdown = analyzeTimingBreakdown(entries);
  if (timingBreakdown) reports.push(timingBreakdown);

  const http1Resources = findHTTP1Resources(entries);
  if (http1Resources) reports.push(http1Resources);

  const redirects = findRedirects(entries);
  if (redirects) reports.push(redirects);

  const serverHeaders = analyzeServerHeaders(entries);
  if (serverHeaders) reports.push(serverHeaders);

  // Recommended Improvement: Per-domain summary
  const perDomainSummary = generatePerDomainSummary(entries);
  if (perDomainSummary) reports.push(perDomainSummary);

  return reports;
}

function findLargeTransfers(entries) {
  // 1. Large Transfer Sizes (threshold-based, > 100KB, show top 15)
  const largeFiles = entries
    .filter(entry => entry.response && entry.response._transferSize > 100 * 1024) // > 100KB
    .sort((a, b) => b.response._transferSize - a.response._transferSize)
    .slice(0, 15); // Show top 15 instead of top 5 to avoid data loss

  if (largeFiles.length > 0) {
    let report = '* **Large File Transfers:**\n';
    largeFiles.forEach(entry => {
      const sizeKB = Math.round(entry.response._transferSize / 1024);
      const contentType = entry.response.content?.mimeType || 'unknown';

      // Critical Gap Fix: Add request priority
      const priority = entry.request?._priority || entry.request?.priority || 'unknown';
      const priorityStr = priority !== 'unknown' ? `, priority: ${priority}` : '';

      report += `    * ${entry.request.url} (${sizeKB} KB, ${contentType}${priorityStr})\n`;
    });
    return report;
  }
  return null;
}

// Critical Gap Fix: Find critical resources (images, fonts, scripts) with low priority
function findDeprioritizedCriticalResources(entries) {
  const criticalTypes = ['image', 'font', 'script', 'stylesheet'];
  const deprioritized = entries
    .filter(entry => {
      const contentType = entry.response?.content?.mimeType || '';
      const isCriticalType = criticalTypes.some(type => contentType.includes(type));
      const priority = entry.request?._priority || entry.request?.priority;

      // Flag if it's a critical resource type with low/medium priority (should be high)
      return isCriticalType && priority && (priority === 'Low' || priority === 'Medium');
    })
    .slice(0, 10);  // Top 10

  if (deprioritized.length > 0) {
    let report = '* **Deprioritized Critical Resources (should be priority: High):**\n';
    deprioritized.forEach(entry => {
      const contentType = entry.response?.content?.mimeType || 'unknown';
      const priority = entry.request?._priority || entry.request?.priority;
      const sizeKB = Math.round((entry.response?._transferSize || 0) / 1024);
      report += `    * ${entry.request.url} (${contentType}, priority: ${priority}, ${sizeKB}KB)\n`;
    });
    report += `    * Consider: Add fetchpriority="high" to critical images/fonts, or use <link rel="preload">\n`;
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

function analyzeTimingBreakdown(entries) {
  // Analyze timing breakdown for critical resources to identify bottleneck phases
  // Focus on: DNS, TCP, SSL, Wait (TTFB), Download
  const criticalResources = entries
    .filter(entry => {
      if (!entry.timings) return false;
      // Consider resources with significant total time (>200ms)
      const totalTime = (entry.timings.dns || 0) +
                       (entry.timings.connect || 0) +
                       (entry.timings.ssl || 0) +
                       (entry.timings.wait || 0) +
                       (entry.timings.receive || 0);
      return totalTime > 200;
    })
    .sort((a, b) => {
      const totalA = (a.timings.dns || 0) + (a.timings.connect || 0) + (a.timings.ssl || 0) + (a.timings.wait || 0) + (a.timings.receive || 0);
      const totalB = (b.timings.dns || 0) + (b.timings.connect || 0) + (b.timings.ssl || 0) + (b.timings.wait || 0) + (b.timings.receive || 0);
      return totalB - totalA;
    })
    .slice(0, 10); // Top 10 slowest resources

  if (criticalResources.length > 0) {
    let report = '* **Timing Breakdown for Critical Resources (DNS→TCP→SSL→TTFB→Download):**\n';
    criticalResources.forEach(entry => {
      const timings = entry.timings;
      const dns = Math.round(timings.dns || 0);
      const tcp = Math.round(timings.connect || 0);
      const ssl = Math.round(timings.ssl || 0);
      const wait = Math.round(timings.wait || 0);
      const download = Math.round(timings.receive || 0);
      const total = dns + tcp + ssl + wait + download;

      // Identify bottleneck phase
      const phases = { DNS: dns, TCP: tcp, SSL: ssl, TTFB: wait, Download: download };
      const bottleneck = Object.entries(phases).reduce((max, [name, value]) =>
        value > max.value ? { name, value } : max,
        { name: '', value: 0 }
      );

      report += `    * ${entry.request.url}\n`;
      report += `      Total: ${total}ms | DNS: ${dns}ms, TCP: ${tcp}ms, SSL: ${ssl}ms, TTFB: ${wait}ms, Download: ${download}ms\n`;
      report += `      Bottleneck: ${bottleneck.name} (${bottleneck.value}ms, ${Math.round(bottleneck.value/total*100)}%)\n`;
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

function analyzeServerHeaders(entries) {
  // Analyze important server headers for caching and performance insights
  const mainDocument = entries.find(entry =>
    entry.response && entry.response.content?.mimeType?.includes('text/html')
  );

  if (!mainDocument || !mainDocument.response.headers) {
    return null;
  }

  const headers = mainDocument.response.headers;
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

  const cacheControl = getHeader('cache-control');
  const serverTiming = getHeader('server-timing');
  const cdnCache = getHeader('x-cache') || getHeader('cf-cache-status') || getHeader('x-fastly-cache');
  const server = getHeader('server');
  const age = getHeader('age');

  const insights = [];

  if (cacheControl) {
    insights.push(`Cache-Control: ${cacheControl}`);
  }

  if (serverTiming) {
    insights.push(`Server-Timing: ${serverTiming}`);
  }

  if (cdnCache) {
    insights.push(`CDN Cache Status: ${cdnCache}`);
  }

  if (server) {
    insights.push(`Server: ${server}`);
  }

  if (age) {
    insights.push(`Age: ${age}s (cached response)`);
  }

  if (insights.length > 0) {
    let report = '* **Server Headers (Main Document):**\n';
    insights.forEach(insight => {
      report += `    * ${insight}\n`;
    });
    return report;
  }

  return null;
}

// Recommended Improvement: Per-domain summary for third-party analysis
function generatePerDomainSummary(entries) {
  const domainStats = new Map();

  entries.forEach(entry => {
    try {
      const url = new URL(entry.request.url);
      const domain = url.hostname;

      if (!domainStats.has(domain)) {
        domainStats.set(domain, {
          requests: 0,
          totalBytes: 0,
          totalTime: 0,
          blockedTime: 0,
          dnsTime: 0,
          connectTime: 0,
          sslTime: 0,
          ttfb: 0,
          downloadTime: 0,
          resources: []
        });
      }

      const stats = domainStats.get(domain);
      stats.requests++;
      stats.totalBytes += entry.response?._transferSize || 0;

      // Aggregate timing data
      if (entry.timings) {
        stats.totalTime += entry.time || 0;
        stats.blockedTime += entry.timings.blocked > 0 ? entry.timings.blocked : 0;
        stats.dnsTime += entry.timings.dns > 0 ? entry.timings.dns : 0;
        stats.connectTime += entry.timings.connect > 0 ? entry.timings.connect : 0;
        stats.sslTime += entry.timings.ssl > 0 ? entry.timings.ssl : 0;
        stats.ttfb += entry.timings.wait > 0 ? entry.timings.wait : 0;
        stats.downloadTime += entry.timings.receive > 0 ? entry.timings.receive : 0;
      }

      // Track resource types
      const contentType = entry.response?.content?.mimeType || 'unknown';
      const resourceType = contentType.split('/')[0]; // image, script, text, etc.
      stats.resources.push(resourceType);
    } catch (e) {
      // Invalid URL, skip
    }
  });

  // Convert to sorted array (by total bytes, descending)
  const sortedDomains = Array.from(domainStats.entries())
    .map(([domain, stats]) => ({
      domain,
      ...stats,
      avgTimePerRequest: stats.requests > 0 ? Math.round(stats.totalTime / stats.requests) : 0
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);

  // Only show domains with significant impact (>50KB or >5 requests)
  const significantDomains = sortedDomains.filter(d => d.totalBytes > 50 * 1024 || d.requests > 5);

  if (significantDomains.length === 0) {
    return null;
  }

  let report = '* **Per-Domain Breakdown:**\n';

  // Show top 15 domains to avoid data loss
  const topDomains = significantDomains.slice(0, 15);

  topDomains.forEach(stats => {
    const sizeKB = Math.round(stats.totalBytes / 1024);
    const totalTimeMs = Math.round(stats.totalTime);
    const avgTimeMs = stats.avgTimePerRequest;

    // Identify domain type (first-party vs third-party)
    const isFirstParty = stats.domain.includes(new URL(entries[0]?.request.url).hostname);
    const domainType = isFirstParty ? '(1st party)' : '(3rd party)';

    report += `    * **${stats.domain}** ${domainType}: ${stats.requests} requests, ${sizeKB}KB`;

    // Add timing summary if significant
    if (totalTimeMs > 100) {
      report += `, ${totalTimeMs}ms total (${avgTimeMs}ms avg)`;

      // Show timing breakdown for slow domains
      if (avgTimeMs > 100) {
        const breakdown = [];
        if (stats.dnsTime > 10) breakdown.push(`DNS: ${Math.round(stats.dnsTime)}ms`);
        if (stats.connectTime > 10) breakdown.push(`Connect: ${Math.round(stats.connectTime)}ms`);
        if (stats.sslTime > 10) breakdown.push(`SSL: ${Math.round(stats.sslTime)}ms`);
        if (stats.ttfb > 50) breakdown.push(`TTFB: ${Math.round(stats.ttfb)}ms`);
        if (stats.downloadTime > 50) breakdown.push(`Download: ${Math.round(stats.downloadTime)}ms`);

        if (breakdown.length > 0) {
          report += `\n        * Timing: ${breakdown.join(', ')}`;
        }
      }
    }

    report += '\n';
  });

  // Add summary if there are more domains
  if (significantDomains.length > 15) {
    const remaining = significantDomains.slice(15);
    const remainingBytes = remaining.reduce((sum, d) => sum + d.totalBytes, 0);
    const remainingRequests = remaining.reduce((sum, d) => sum + d.requests, 0);
    report += `    * ... +${remaining.length} more domains (${remainingRequests} requests, ${Math.round(remainingBytes / 1024)}KB)\n`;
  }

  return report;
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