import PuppeteerHar from 'puppeteer-har';
import { LabDataCollector } from './base-collector.js';
import { RESOURCE_THRESHOLDS, DATA_LIMITS } from '../../config/thresholds.js';

/**
 * HAR (HTTP Archive) Data Collector
 * Extends LabDataCollector to collect and analyze HTTP traffic
 */
export class HARCollector extends LabDataCollector {
  async setup(page) {
    const har = new PuppeteerHar(page);
    await har.start();
    return har;
  }

  async collect(page, har) {
    const harData = await har.stop();
    return this.cleanupHarData(harData);
  }

  cleanupHarData(har) {
    // Remove preflight requests (OPTIONS) from HAR data
    if (har?.log?.entries) {
      har.log.entries = har.log.entries.filter(entry =>
        !(entry.request && entry.request.method === 'OPTIONS')
      );
    }
    return har;
  }

  summarize(harData, { thirdPartyAnalysis = null } = {}) {
    // Validate data
    const error = this.validateOrDefault(
      harData?.log?.entries,
      'HTTP Archive data',
      'No valid HTTP Archive data available.'
    );
    if (error) return error;

    const entries = harData.log.entries;
    let report = '**Additional Bottlenecks from HAR Data:**\n\n';

    // Analyze bottlenecks
    const bottleneckReports = this.analyzeBottlenecks(entries);
    report += bottleneckReports.length > 0
      ? bottleneckReports.join('\n')
      : '* No significant bottlenecks found based on provided HAR data.\n';

    // Add third-party analysis if available
    if (thirdPartyAnalysis?.summary) {
      report += this.formatThirdPartyAnalysis(thirdPartyAnalysis);
    }

    return report;
  }

  analyzeBottlenecks(entries) {
    const reports = [];

    // Run all bottleneck analyses
    const analyses = [
      () => this.findLargeTransfers(entries),
      () => this.findLongBlockingTimes(entries),
      () => this.findLongTTFB(entries),
      () => this.findDeprioritizedCriticalResources(entries),
      () => this.analyzeTimingBreakdown(entries),
      () => this.findHTTP1Resources(entries),
      () => this.findRedirects(entries),
      () => this.analyzeServerHeaders(entries),
      () => this.generatePerDomainSummary(entries)
    ];

    analyses.forEach(analyze => {
      const result = analyze();
      if (result) reports.push(result);
    });

    return reports;
  }

  findLargeTransfers(entries) {
    const largeFiles = this.filterByThreshold(
      entries.filter(e => e.response?._transferSize),
      e => e.response._transferSize,
      RESOURCE_THRESHOLDS.LARGE_FILE
    ).slice(0, DATA_LIMITS.MAX_LARGE_FILES);

    if (largeFiles.length === 0) return null;

    let report = '* **Large File Transfers:**\n';
    largeFiles.forEach(entry => {
      const sizeKB = Math.round(entry.response._transferSize / 1024);
      const contentType = entry.response.content?.mimeType || 'unknown';
      const priority = entry.request?._priority || entry.request?.priority || 'unknown';
      const priorityStr = priority !== 'unknown' ? `, priority: ${priority}` : '';

      report += `    * ${this.truncate(entry.request.url)} (${sizeKB} KB, ${contentType}${priorityStr})\n`;
    });
    return report;
  }

  findDeprioritizedCriticalResources(entries) {
    const criticalTypes = ['image', 'font', 'script', 'stylesheet'];
    const deprioritized = entries
      .filter(entry => {
        const contentType = entry.response?.content?.mimeType || '';
        const isCriticalType = criticalTypes.some(type => contentType.includes(type));
        const priority = entry.request?._priority || entry.request?.priority;
        return isCriticalType && priority && (priority === 'Low' || priority === 'Medium');
      })
      .slice(0, 10);

    if (deprioritized.length === 0) return null;

    let report = '* **Deprioritized Critical Resources (should be priority: High):**\n';
    deprioritized.forEach(entry => {
      const contentType = entry.response?.content?.mimeType || 'unknown';
      const priority = entry.request?._priority || entry.request?.priority;
      const sizeKB = this.formatBytes(entry.response?._transferSize || 0);
      report += `    * ${this.truncate(entry.request.url)} (${contentType}, priority: ${priority}, ${sizeKB})\n`;
    });
    report += `    * Consider: Add fetchpriority="high" to critical images/fonts, or use <link rel="preload">\n`;
    return report;
  }

  findLongBlockingTimes(entries) {
    const longBlocking = this.filterByThreshold(
      entries.filter(e => e.timings?.blocked),
      e => e.timings.blocked,
      10
    );

    if (longBlocking.length === 0) return null;

    let report = '* **Significant Blocking Times (DNS, Connect, SSL):**\n';
    longBlocking.forEach(entry => {
      const timings = entry.timings;
      report += `    * ${this.truncate(entry.request.url)}:  Blocked: ${Math.round(timings.blocked)}ms`;
      if (timings.dns > 0) report += `, DNS: ${Math.round(timings.dns)}ms`;
      if (timings.connect > 0) report += `, Connect: ${Math.round(timings.connect)}ms`;
      if (timings.ssl > 0) report += `, SSL: ${Math.round(timings.ssl)}ms`;
      report += '\n';
    });
    return report;
  }

  findLongTTFB(entries) {
    const ttfbThreshold = RESOURCE_THRESHOLDS.SLOW_RESOURCE;
    const longTTFB = this.filterByThreshold(
      entries.filter(e => e.timings?.wait),
      e => e.timings.wait,
      ttfbThreshold
    );

    if (longTTFB.length === 0) return null;

    let report = '* **High Time to First Byte (TTFB) - Server Response Times:**\n';
    longTTFB.forEach(entry => {
      report += `    * ${this.truncate(entry.request.url)}: ${Math.round(entry.timings.wait)}ms\n`;
    });
    return report;
  }

  analyzeTimingBreakdown(entries) {
    const criticalResources = entries
      .filter(entry => {
        if (!entry.timings) return false;
        const totalTime = (entry.timings.dns || 0) + (entry.timings.connect || 0) +
                         (entry.timings.ssl || 0) + (entry.timings.wait || 0) +
                         (entry.timings.receive || 0);
        return totalTime > 200;
      })
      .sort((a, b) => this.getTotalTime(b) - this.getTotalTime(a))
      .slice(0, 10);

    if (criticalResources.length === 0) return null;

    let report = '* **Timing Breakdown for Critical Resources (DNS→TCP→SSL→TTFB→Download):**\n';
    criticalResources.forEach(entry => {
      const timings = entry.timings;
      const dns = Math.round(timings.dns || 0);
      const tcp = Math.round(timings.connect || 0);
      const ssl = Math.round(timings.ssl || 0);
      const wait = Math.round(timings.wait || 0);
      const download = Math.round(timings.receive || 0);
      const total = dns + tcp + ssl + wait + download;

      const bottleneck = this.findBottleneckPhase({ DNS: dns, TCP: tcp, SSL: ssl, TTFB: wait, Download: download });

      report += `    * ${this.truncate(entry.request.url)}\n`;
      report += `      Total: ${total}ms | DNS: ${dns}ms, TCP: ${tcp}ms, SSL: ${ssl}ms, TTFB: ${wait}ms, Download: ${download}ms\n`;
      report += `      Bottleneck: ${bottleneck.name} (${bottleneck.value}ms, ${this.percentage(bottleneck.value, total)}%)\n`;
    });
    return report;
  }

  findHTTP1Resources(entries) {
    const http1Resources = entries.filter(entry =>
      entry.response?.httpVersion?.toLowerCase().startsWith('http/1.1')
    );

    if (http1Resources.length === 0) return null;

    let report = '* **Resources using HTTP/1.1 (not HTTP/2 or HTTP/3):**\n';
    http1Resources.forEach(entry => {
      report += `   * ${this.truncate(entry.request.url)}\n`;
    });
    return report;
  }

  findRedirects(entries) {
    const redirectStatusCodes = [301, 302, 307, 308];
    const redirects = entries.filter(entry =>
      entry.response && redirectStatusCodes.includes(entry.response.status)
    );

    if (redirects.length === 0) return null;

    let report = `* **Redirects:**\n`;
    redirects.forEach(entry => {
      report += `    * ${this.truncate(entry.request.url)} -> ${this.truncate(entry.response.redirectURL)} (Status: ${entry.response.status})\n`;
    });
    return report;
  }

  analyzeServerHeaders(entries) {
    const mainDocument = entries.find(entry =>
      entry.response?.content?.mimeType?.includes('text/html')
    );

    if (!mainDocument?.response?.headers) return null;

    const headers = mainDocument.response.headers;
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

    const insights = [
      { key: 'Cache-Control', value: getHeader('cache-control') },
      { key: 'Server-Timing', value: getHeader('server-timing') },
      { key: 'CDN Cache Status', value: getHeader('x-cache') || getHeader('cf-cache-status') || getHeader('x-fastly-cache') },
      { key: 'Server', value: getHeader('server') },
      { key: 'Age', value: getHeader('age') ? `${getHeader('age')}s (cached response)` : null }
    ].filter(insight => insight.value);

    if (insights.length === 0) return null;

    let report = '* **Server Headers (Main Document):**\n';
    insights.forEach(insight => {
      report += `    * ${insight.key}: ${insight.value}\n`;
    });
    return report;
  }

  generatePerDomainSummary(entries) {
    const domainStats = this.groupBy(entries, entry => {
      try {
        return new URL(entry.request.url).hostname;
      } catch (e) {
        return 'invalid';
      }
    });

    // Calculate stats for each domain
    const sortedDomains = Array.from(domainStats.entries())
      .map(([domain, items]) => ({
        domain,
        requests: items.length,
        totalBytes: this.aggregate(items, { getValue: e => e.response?._transferSize || 0, type: 'sum' }),
        totalTime: this.aggregate(items, { getValue: e => e.time || 0, type: 'sum' }),
        avgTimePerRequest: this.aggregate(items, { getValue: e => e.time || 0, type: 'avg' }),
        timingStats: this.calculateDomainTimingStats(items)
      }))
      .filter(d => d.domain !== 'invalid' && (d.totalBytes > 50 * 1024 || d.requests > 5))
      .sort((a, b) => b.totalBytes - a.totalBytes);

    if (sortedDomains.length === 0) return null;

    let report = '* **Per-Domain Breakdown:**\n';
    const topDomains = sortedDomains.slice(0, 15);

    topDomains.forEach(stats => {
      const isFirstParty = stats.domain.includes(new URL(entries[0]?.request.url).hostname);
      const domainType = isFirstParty ? '(1st party)' : '(3rd party)';

      report += `    * **${stats.domain}** ${domainType}: ${stats.requests} requests, ${this.formatBytes(stats.totalBytes)}`;

      if (stats.totalTime > RESOURCE_THRESHOLDS.SLOW_BOTTLENECK) {
        report += `, ${this.formatDuration(stats.totalTime)} total (${Math.round(stats.avgTimePerRequest)}ms avg)`;

        if (stats.avgTimePerRequest > RESOURCE_THRESHOLDS.SLOW_AVG_REQUEST) {
          const breakdown = this.formatTimingBreakdown(stats.timingStats);
          if (breakdown) report += `\n        * Timing: ${breakdown}`;
        }
      }
      report += '\n';
    });

    if (sortedDomains.length > 15) {
      const remaining = sortedDomains.slice(15);
      const remainingBytes = this.aggregate(remaining, { getValue: d => d.totalBytes, type: 'sum' });
      const remainingRequests = this.aggregate(remaining, { getValue: d => d.requests, type: 'sum' });
      report += `    * ... +${remaining.length} more domains (${remainingRequests} requests, ${this.formatBytes(remainingBytes)})\n`;
    }

    return report;
  }

  formatThirdPartyAnalysis(thirdPartyAnalysis) {
    let report = '\n\n**Third-Party Script Analysis (Priority 1 Data):**\n\n';
    const summary = thirdPartyAnalysis.summary;

    report += `* **Total Scripts**: ${summary.totalScripts}\n`;
    report += `* **Total Transfer Size**: ${this.formatBytes(summary.totalTransferSize)}\n`;
    report += `* **Total Network Time**: ${summary.totalNetworkTime}ms\n`;
    report += `* **Total Execution Time**: ${summary.totalExecutionTime}ms\n`;
    report += `* **Total Blocking Time**: ${summary.totalBlockingTime}ms\n`;
    report += `* **Render-Blocking Scripts**: ${summary.renderBlockingCount}\n`;

    if (thirdPartyAnalysis.categoryImpact?.length > 0) {
      report += '\n**By Category (sorted by execution time):**\n';
      thirdPartyAnalysis.categoryImpact.slice(0, 8).forEach((cat, idx) => {
        report += `  ${idx + 1}. **${cat.category}**: ${cat.scripts} script${cat.scripts > 1 ? 's' : ''}, ` +
                  `${this.formatBytes(cat.transferSize)}, ` +
                  `${cat.executionTime}ms execution, ` +
                  `${cat.networkTime}ms network\n`;
      });
    }

    if (thirdPartyAnalysis.scripts?.length > 0) {
      const topScripts = [...thirdPartyAnalysis.scripts]
        .sort((a, b) => (b.execution?.totalTime || 0) - (a.execution?.totalTime || 0))
        .slice(0, 5);

      if (topScripts.some(s => s.execution?.totalTime > 0)) {
        report += '\n**Top Scripts by Execution Time:**\n';
        topScripts.forEach((script, idx) => {
          if (script.execution?.totalTime > 0) {
            report += `  ${idx + 1}. **${script.domain}** (${script.category})\n`;
            report += `     - URL: ${this.truncate(script.url)}\n`;
            report += `     - Execution: ${script.execution.totalTime}ms`;
            if (script.isRenderBlocking) report += ' [RENDER-BLOCKING]';
            report += '\n';
            if (script.longTaskAttribution?.length > 0) {
              const totalLongTask = this.aggregate(script.longTaskAttribution, { getValue: lt => lt.duration, type: 'sum' });
              report += `     - Long Tasks: ${script.longTaskAttribution.length} (${totalLongTask}ms total)\n`;
            }
          }
        });
      }
    }

    return report;
  }

  // Helper methods
  getTotalTime(entry) {
    const t = entry.timings;
    return (t.dns || 0) + (t.connect || 0) + (t.ssl || 0) + (t.wait || 0) + (t.receive || 0);
  }

  findBottleneckPhase(phases) {
    return Object.entries(phases).reduce((max, [name, value]) =>
      value > max.value ? { name, value } : max,
      { name: '', value: 0 }
    );
  }

  calculateDomainTimingStats(items) {
    return {
      dnsTime: this.aggregate(items.filter(e => e.timings?.dns > 0), { getValue: e => e.timings.dns, type: 'sum' }),
      connectTime: this.aggregate(items.filter(e => e.timings?.connect > 0), { getValue: e => e.timings.connect, type: 'sum' }),
      sslTime: this.aggregate(items.filter(e => e.timings?.ssl > 0), { getValue: e => e.timings.ssl, type: 'sum' }),
      ttfb: this.aggregate(items.filter(e => e.timings?.wait > 0), { getValue: e => e.timings.wait, type: 'sum' }),
      downloadTime: this.aggregate(items.filter(e => e.timings?.receive > 0), { getValue: e => e.timings.receive, type: 'sum' })
    };
  }

  formatTimingBreakdown(stats) {
    const breakdown = [];
    if (stats.dnsTime > 10) breakdown.push(`DNS: ${Math.round(stats.dnsTime)}ms`);
    if (stats.connectTime > 10) breakdown.push(`Connect: ${Math.round(stats.connectTime)}ms`);
    if (stats.sslTime > 10) breakdown.push(`SSL: ${Math.round(stats.sslTime)}ms`);
    if (stats.ttfb > 50) breakdown.push(`TTFB: ${Math.round(stats.ttfb)}ms`);
    if (stats.downloadTime > 50) breakdown.push(`Download: ${Math.round(stats.downloadTime)}ms`);
    return breakdown.length > 0 ? breakdown.join(', ') : null;
  }
}

// Backward-compatible exports
export async function startHARRecording(page) {
  const collector = new HARCollector();
  return await collector.setup(page);
}

export async function stopHARRecording(har) {
  const collector = new HARCollector();
  const harData = await har.stop();
  return collector.cleanupHarData(harData);
}

export function cleanupHarData(har) {
  const collector = new HARCollector();
  return collector.cleanupHarData(har);
}

export function summarizeHAR(harData, deviceType, thirdPartyAnalysis = null) {
  const collector = new HARCollector(deviceType);
  return collector.summarize(harData, { thirdPartyAnalysis });
}
