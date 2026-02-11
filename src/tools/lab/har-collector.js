import PuppeteerHar from 'puppeteer-har';
import { LabDataCollector } from './base-collector.js';
import { RESOURCE_THRESHOLDS, DATA_LIMITS, DISPLAY_LIMITS } from '../../config/thresholds.js';
import { correlateChainWithRUM, formatRUMCorrelation } from '../../core/chain-rum-correlator.js';

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
    // Remove unnecessary requests from HAR data
    // Note: We filter POST-collection rather than using CDP request interception
    // because puppeteer-har requires exclusive request interception access.
    // This still provides optimal performance as filtering happens before any analysis.
    if (har?.log?.entries) {
      har.log.entries = har.log.entries.filter(entry => {
        if (!entry.request) return true;

        const method = entry.request.method;
        const url = entry.request.url || '';

        // Filter OPTIONS preflight requests (CORS)
        if (method === 'OPTIONS') return false;

        // Filter common analytics/tracking beacons that don't affect CWV
        const isAnalyticsBeacon = (
          url.includes('google-analytics.com/collect') ||
          url.includes('analytics.google.com/g/collect') ||
          url.includes('doubleclick.net/activity') ||
          url.includes('/analytics/beacon')
        );
        if (isAnalyticsBeacon && method === 'POST') return false;

        return true;
      });
    }
    return har;
  }

  summarize(harData, { thirdPartyAnalysis = null, pageUrl = null, coverageData = null, rumData = null } = {}) {
    // Store for use in analyze methods
    this.thirdPartyAnalysis = thirdPartyAnalysis;
    this.pageUrl = pageUrl;
    this.coverageData = coverageData;
    this.rumData = rumData;

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
      () => this.analyzeMainDocumentTiming(entries),  // Issue #6 fix: Separate main document analysis
      () => this.analyzeAggregateTimings(entries),    // Issue #6 fix: Aggregate timing statistics
      () => this.analyzeTimingBreakdown(entries),
      () => this.findHTTP1Resources(entries),
      () => this.findRedirects(entries),
      () => this.analyzeServerHeaders(entries),
      () => this.analyzeCacheHeaders(entries),
      () => this.analyzeRequestChains(entries),
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
      .slice(0, DISPLAY_LIMITS.LAB.MAX_ITEMS_DISPLAY);

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
      // Issue #6 fix: Show full timing breakdown for high TTFB resources
      const dns = Math.round(entry.timings.dns || 0);
      const tcp = Math.round(entry.timings.connect || 0);
      const ssl = Math.round(entry.timings.ssl || 0);
      const wait = Math.round(entry.timings.wait);
      const download = Math.round(entry.timings.receive || 0);

      report += `    * ${this.truncate(entry.request.url)}: ${wait}ms TTFB\n`;
      report += `      (Breakdown: DNS: ${dns}ms, TCP: ${tcp}ms, SSL: ${ssl}ms, Wait: ${wait}ms, Download: ${download}ms)\n`;
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
        // Issue #6 fix: Lower threshold from 200ms to 100ms to catch moderate issues
        return totalTime > 100;
      })
      .sort((a, b) => this.getTotalTime(b) - this.getTotalTime(a))
      // Issue #6 fix: Show more resources (15 instead of default 5-10)
      .slice(0, 15);

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

  /**
   * Analyze main HTML document timing separately (Issue #6 fix)
   * The main document is the most critical resource and deserves dedicated analysis
   */
  analyzeMainDocumentTiming(entries) {
    // Find main HTML document (first entry with text/html)
    const mainDoc = entries.find(entry =>
      entry.response?.content?.mimeType?.includes('text/html')
    );

    if (!mainDoc || !mainDoc.timings) return null;

    const timings = mainDoc.timings;
    const dns = Math.round(timings.dns || 0);
    const tcp = Math.round(timings.connect || 0);
    const ssl = Math.round(timings.ssl || 0);
    const wait = Math.round(timings.wait || 0);
    const download = Math.round(timings.receive || 0);
    const total = dns + tcp + ssl + wait + download;

    // Identify bottleneck phase
    const phases = { DNS: dns, TCP: tcp, SSL: ssl, TTFB: wait, Download: download };
    const bottleneck = Object.entries(phases)
      .sort((a, b) => b[1] - a[1])[0];

    let report = '* **Main HTML Document Timing Breakdown (Navigation TTFB):**\n';
    report += `    * URL: ${this.truncate(mainDoc.request.url)}\n`;
    report += `    * Total: ${total}ms | DNS: ${dns}ms, TCP: ${tcp}ms, SSL: ${ssl}ms, TTFB: ${wait}ms, Download: ${download}ms\n`;
    report += `    * Bottleneck: ${bottleneck[0]} (${bottleneck[1]}ms, ${this.percentage(bottleneck[1], total)}%)\n`;

    // Add recommendations based on bottleneck
    if (dns > 50) {
      report += `    * ⚠️ High DNS time (${dns}ms) - Consider using a faster DNS provider or preconnect\n`;
    }
    if (tcp > 50) {
      report += `    * ⚠️ High TCP time (${tcp}ms) - Consider using a CDN closer to users\n`;
    }
    if (ssl > 100) {
      report += `    * ⚠️ High SSL time (${ssl}ms) - Check TLS configuration, use TLS 1.3, or enable session resumption\n`;
    }
    if (wait > 600) {
      report += `    * ⚠️ High server processing time (${wait}ms TTFB) - Check Server-Timing header for breakdown\n`;
    }

    return report;
  }

  /**
   * Aggregate timing statistics across all resources (Issue #6 fix)
   * Helps identify systemic issues like "high DNS across all domains"
   */
  analyzeAggregateTimings(entries) {
    const withTimings = entries.filter(e => e.timings);

    if (withTimings.length === 0) return null;

    // Aggregate by phase
    const totals = {
      dns: 0,
      tcp: 0,
      ssl: 0,
      wait: 0,
      receive: 0,
      count: withTimings.length
    };

    withTimings.forEach(entry => {
      totals.dns += entry.timings.dns || 0;
      totals.tcp += entry.timings.connect || 0;
      totals.ssl += entry.timings.ssl || 0;
      totals.wait += entry.timings.wait || 0;
      totals.receive += entry.timings.receive || 0;
    });

    const avgDns = Math.round(totals.dns / totals.count);
    const avgTcp = Math.round(totals.tcp / totals.count);
    const avgSsl = Math.round(totals.ssl / totals.count);
    const avgWait = Math.round(totals.wait / totals.count);
    const avgReceive = Math.round(totals.receive / totals.count);

    let report = '* **Aggregate Timing Statistics (averages across all resources):**\n';
    report += `    * Resources analyzed: ${totals.count}\n`;
    report += `    * Avg DNS: ${avgDns}ms | Avg TCP: ${avgTcp}ms | Avg SSL: ${avgSsl}ms | Avg TTFB: ${avgWait}ms | Avg Download: ${avgReceive}ms\n`;

    // Identify systemic issues
    const issues = [];
    if (avgDns > 30) {
      issues.push(`High average DNS (${avgDns}ms) suggests missing preconnect hints`);
    }
    if (avgTcp > 30) {
      issues.push(`High average TCP (${avgTcp}ms) suggests CDN not geographically optimized`);
    }
    if (avgSsl > 50) {
      issues.push(`High average SSL (${avgSsl}ms) suggests TLS configuration issues`);
    }

    if (issues.length > 0) {
      report += `    * Systemic Issues:\n`;
      issues.forEach(issue => {
        report += `      - ${issue}\n`;
      });
    }

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

    // Parse Server-Timing header for detailed TTFB attribution
    const serverTimingParsed = this.parseServerTiming(getHeader('server-timing'));

    // Determine cache status
    const cacheStatus = this.determineCacheStatus(headers);

    const insights = [
      { key: 'Cache-Control', value: getHeader('cache-control') },
      { key: 'Cache Status', value: cacheStatus.summary },
      { key: 'Server', value: getHeader('server') },
      { key: 'Age', value: getHeader('age') ? `${getHeader('age')}s (cached response)` : null }
    ].filter(insight => insight.value);

    if (insights.length === 0 && !serverTimingParsed) return null;

    let report = '* **Server Headers (Main Document):**\n';
    insights.forEach(insight => {
      report += `    * ${insight.key}: ${insight.value}\n`;
    });

    // Add parsed Server-Timing breakdown
    if (serverTimingParsed && serverTimingParsed.length > 0) {
      report += '    * **Server-Timing Breakdown:**\n';
      serverTimingParsed.forEach(timing => {
        report += `        * ${timing.name}`;
        if (timing.desc) report += ` (${timing.desc})`;
        if (timing.dur != null) report += `: ${timing.dur}ms`;
        report += '\n';
      });
    }

    // Add cache analysis insights
    if (cacheStatus.isCacheMiss) {
      report += `    * ⚠️ **Cache Miss Detected**: Response was not served from cache\n`;
      if (cacheStatus.reason) {
        report += `        * Reason: ${cacheStatus.reason}\n`;
      }
    }

    return report;
  }

  /**
   * Parse Server-Timing header into structured data
   * @param {string} serverTimingHeader - Raw Server-Timing header value
   * @returns {Array|null} Parsed timing entries or null
   */
  parseServerTiming(serverTimingHeader) {
    if (!serverTimingHeader) return null;

    try {
      // Server-Timing format: name;desc="description";dur=123, name2;dur=456
      return serverTimingHeader.split(',').map(entry => {
        const parts = entry.trim().split(';');
        const result = { name: parts[0].trim() };

        parts.slice(1).forEach(part => {
          const [key, value] = part.split('=');
          if (key.trim() === 'desc') {
            result.desc = value?.replace(/"/g, '').trim();
          } else if (key.trim() === 'dur') {
            result.dur = parseFloat(value);
          }
        });

        return result;
      }).filter(t => t.name);
    } catch (e) {
      return null;
    }
  }

  /**
   * Determine cache status from various cache-related headers
   * @param {Array} headers - Response headers array
   * @returns {Object} Cache status analysis
   */
  determineCacheStatus(headers) {
    const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;

    const xCache = getHeader('x-cache');
    const cfCacheStatus = getHeader('cf-cache-status');
    const xFastlyCache = getHeader('x-fastly-cache');
    const xDispatcherCache = getHeader('x-dispatcher-cache');
    const xAkamaiCache = getHeader('x-akamai-cache');
    const age = getHeader('age');
    const cacheControl = getHeader('cache-control');

    let summary = '';
    let isCacheMiss = false;
    let reason = null;

    // Check various CDN cache headers
    if (cfCacheStatus) {
      summary = `Cloudflare: ${cfCacheStatus}`;
      isCacheMiss = ['MISS', 'EXPIRED', 'BYPASS', 'DYNAMIC'].includes(cfCacheStatus.toUpperCase());
      if (isCacheMiss) reason = `Cloudflare returned ${cfCacheStatus}`;
    } else if (xFastlyCache) {
      summary = `Fastly: ${xFastlyCache}`;
      isCacheMiss = xFastlyCache.toUpperCase().includes('MISS');
      if (isCacheMiss) reason = `Fastly cache miss`;
    } else if (xDispatcherCache) {
      summary = `AEM Dispatcher: ${xDispatcherCache}`;
      isCacheMiss = xDispatcherCache.toUpperCase().includes('MISS');
      if (isCacheMiss) reason = `AEM Dispatcher cache miss - check dispatcher.any rules`;
    } else if (xAkamaiCache) {
      summary = `Akamai: ${xAkamaiCache}`;
      isCacheMiss = xAkamaiCache.toUpperCase().includes('MISS');
      if (isCacheMiss) reason = `Akamai cache miss`;
    } else if (xCache) {
      summary = `X-Cache: ${xCache}`;
      isCacheMiss = xCache.toUpperCase().includes('MISS');
      if (isCacheMiss) reason = `CDN cache miss`;
    }

    // Check Age header - presence indicates cached response
    if (age && parseInt(age) > 0) {
      summary += summary ? `, Age: ${age}s` : `Age: ${age}s (cached)`;
      isCacheMiss = false; // Age > 0 means it was cached
    }

    // Check Cache-Control for no-cache/no-store
    if (cacheControl) {
      if (cacheControl.includes('no-store') || cacheControl.includes('no-cache')) {
        if (!summary) summary = 'Not cacheable';
        isCacheMiss = true;
        reason = `Cache-Control: ${cacheControl}`;
      }
    }

    return { summary: summary || null, isCacheMiss, reason };
  }

  /**
   * Analyze cache headers across all resources
   * @param {Array} entries - HAR entries
   * @returns {string|null} Cache analysis report
   */
  analyzeCacheHeaders(entries) {
    const cacheIssues = [];

    entries.forEach(entry => {
      if (!entry.response?.headers) return;

      const url = entry.request.url;
      const headers = entry.response.headers;
      const cacheStatus = this.determineCacheStatus(headers);
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
      const cacheControl = getHeader('cache-control');

      // Flag cache misses for critical resources
      const contentType = entry.response?.content?.mimeType || '';
      const isCritical = contentType.includes('html') ||
                        contentType.includes('javascript') ||
                        contentType.includes('css') ||
                        contentType.includes('font');

      if (isCritical && cacheStatus.isCacheMiss) {
        cacheIssues.push({
          url: this.truncate(url),
          type: contentType.split('/').pop(),
          reason: cacheStatus.reason || 'Cache miss',
          cacheControl
        });
      }
    });

    if (cacheIssues.length === 0) return null;

    let report = '* **Cache Issues (Critical Resources):**\n';
    cacheIssues.slice(0, DISPLAY_LIMITS.LAB.MAX_ITEMS_DISPLAY).forEach(issue => {
      report += `    * ${issue.url} (${issue.type})\n`;
      report += `        * Issue: ${issue.reason}\n`;
      if (issue.cacheControl) {
        report += `        * Cache-Control: ${issue.cacheControl}\n`;
      }
    });

    if (cacheIssues.length > 10) {
      report += `    * ... +${cacheIssues.length - 10} more cache issues\n`;
    }

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
        .slice(0, DISPLAY_LIMITS.LAB.MAX_RESOURCES);

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

  /**
   * Resolve the initiator URL for a HAR entry.
   * puppeteer-har stores initiator data in two fields:
   * - _initiator: simple URL string (may be absent)
   * - _initiator_detail: JSON-stringified object with {type, url, lineNumber}
   *   or {type, stack: {callFrames: [{url, lineNumber, ...}]}}
   * @param {Object} entry - HAR entry
   * @returns {string|null} Initiator URL or null
   */
  resolveInitiatorUrl(entry) {
    const entryUrl = entry.request?.url;

    // Try _initiator_detail first (richer data)
    const detail = entry._initiator_detail;
    if (detail) {
      try {
        const parsed = typeof detail === 'string' ? JSON.parse(detail) : detail;

        // Stack frames: use the first (most recent) frame as initiator
        if (parsed.stack?.callFrames?.length > 0) {
          const frame = parsed.stack.callFrames.find(f =>
            f.url && f.url.startsWith('http') && f.url !== entryUrl
          );
          if (frame) return frame.url;
        }

        // Direct url field (no stack, e.g., parser-initiated)
        if (parsed.url && parsed.url !== entryUrl) return parsed.url;
      } catch {
        // ignore parse errors
      }
    }
    // Fall back to _initiator (simple URL string or object with .url)
    const initiator = entry._initiator;
    if (typeof initiator === 'string' && initiator.startsWith('http')) return initiator;
    if (initiator?.url) return initiator.url;
    return null;
  }

  /**
   * Determine resource type from HAR entry
   * @param {Object} entry - HAR entry
   * @returns {string} Resource type: script, stylesheet, font, image, fetch, document, other
   */
  getResourceType(entry) {
    const mime = entry.response?.content?.mimeType?.toLowerCase() || '';
    const url = entry.request?.url || '';

    if (mime.includes('javascript') || url.endsWith('.js')) return 'script';
    if (mime.includes('css') || url.endsWith('.css')) return 'stylesheet';
    if (mime.includes('font') || /\.(woff2?|ttf|otf|eot)$/.test(url)) return 'font';
    if (mime.includes('image') || /\.(png|jpg|jpeg|gif|svg|webp|avif)$/.test(url)) return 'image';
    if (mime.includes('json') || url.includes('/api/')) return 'fetch';
    if (mime.includes('html')) return 'document';
    return 'other';
  }

  /**
   * Build request chains from HAR entries by tracing initiator relationships.
   * Returns a tree structure where each node has children that it initiated.
   * @param {Array} entries - HAR entries
   * @returns {Object} { chains: Map<url, {entry, children}>, roots: string[] }
   */
  buildRequestChains(entries) {
    // Build a map of URL -> entry (first occurrence) and URL -> node
    const urlToEntry = new Map();
    const nodes = new Map(); // url -> { url, entry, children: [], initiatorUrl, resourceType, isThirdParty }

    // Determine page origin for third-party detection
    const pageOrigin = this.pageUrl ? new URL(this.pageUrl).origin : null;

    for (const entry of entries) {
      const url = entry.request?.url;
      if (!url) continue;
      if (!urlToEntry.has(url)) {
        urlToEntry.set(url, entry);

        const resourceOrigin = new URL(url).origin;
        nodes.set(url, {
          url,
          entry,
          children: [],
          initiatorUrl: null,
          resourceType: this.getResourceType(entry),
          isThirdParty: pageOrigin ? resourceOrigin !== pageOrigin : false
        });
      }
    }

    // Build parent-child relationships
    const roots = [];
    for (const entry of entries) {
      const url = entry.request?.url;
      if (!url || !nodes.has(url)) continue;

      const node = nodes.get(url);
      const initiatorUrl = this.resolveInitiatorUrl(entry);

      if (initiatorUrl && nodes.has(initiatorUrl) && initiatorUrl !== url) {
        node.initiatorUrl = initiatorUrl;
        const parent = nodes.get(initiatorUrl);
        // Avoid duplicates
        if (!parent.children.some(c => c.url === url)) {
          parent.children.push(node);
        }
      } else if (initiatorUrl && !nodes.has(initiatorUrl)) {
        // Initiated by something outside HAR entries (e.g., the HTML document)
        roots.push(url);
      }
    }

    // Find root nodes: entries with no parent in the tree
    for (const [url, node] of nodes) {
      if (!node.initiatorUrl && !roots.includes(url)) {
        roots.push(url);
      }
    }

    return { nodes, roots };
  }

  /**
   * Walk the initiator tree and collect all sequential chain segments.
   * A segment is a parent->child link where the child started significantly
   * after the parent (indicating the parent had to execute first).
   * @param {Object} node - Tree node
   * @param {Array} ancestors - Ancestor path to this node [{url, startTime}]
   * @param {Array} segments - Accumulator for chain segments
   */
  collectChainSegments(node, ancestors = [], segments = []) {
    const startTime = node.entry?.startedDateTime
      ? new Date(node.entry.startedDateTime).getTime()
      : 0;

    const current = {
      url: node.url,
      startTime,
      fanOut: node.children.length,
      resourceType: node.resourceType,
      isThirdParty: node.isThirdParty
    };
    const path = [...ancestors, current];

    for (const child of node.children) {
      const childStart = child.entry?.startedDateTime
        ? new Date(child.entry.startedDateTime).getTime()
        : 0;

      // Special handling for stylesheet and font chains (lower threshold)
      // CSS → font chains often have small timing gaps but are sequential by definition
      const isStylesheetOrFont = node.resourceType === 'stylesheet' || node.resourceType === 'font';
      const threshold = isStylesheetOrFont ? 20 : 50;

      // Use parent completion time for more accurate sequential detection
      // A child can't be caused by a parent that hasn't finished yet
      const parentDuration = node.entry?.time || 0;
      const parentEnd = startTime + parentDuration;

      // Sequential: child started after parent completes + threshold
      if (childStart > parentEnd + threshold) {
        this.collectChainSegments(child, path, segments);
      } else {
        // Parallel child - still explore its subtree for secondary chains
        // Don't accumulate this node's delay, but check if it has sequential children
        this.collectChainSegments(child, [], segments);
      }
    }

    // If this is a leaf or all children are parallel, record the full path as a chain
    if (path.length >= 3) {
      const totalDelay = path[path.length - 1].startTime - path[0].startTime;
      if (totalDelay > 500) {
        segments.push({ path, totalDelay });
      }
    }
  }

  /**
   * Analyze request chains to find sequential loading patterns
   * that could benefit from preloading.
   *
   * Detects two types of issues:
   * 1. Deep sequential chains (A->B->C) where preloading B and C would parallelize downloads
   * 2. High-fanout bottleneck nodes: a single script that triggers many dependent scripts,
   *    all delayed because the parent had to be fetched and executed first
   *
   * @param {Array} entries - HAR entries
   * @returns {string|null} Report section or null
   */
  analyzeRequestChains(entries) {
    const { nodes, roots } = this.buildRequestChains(entries);

    // --- Part 1: Find sequential chains (depth >= 3) ---
    const chains = [];
    for (const rootUrl of roots) {
      const rootNode = nodes.get(rootUrl);
      if (!rootNode) continue;
      this.collectChainSegments(rootNode, [], chains);
    }

    // Deduplicate: many chains share the same backbone (e.g., HTML->main->get-translations)
    // but differ only in the leaf node. Keep one chain per unique backbone.
    chains.sort((a, b) => b.totalDelay - a.totalDelay || b.path.length - a.path.length);
    const seenBackbones = new Set();
    const uniqueChains = chains.filter(({ path }) => {
      // Backbone = all nodes except the leaf (which varies)
      const backbone = path.slice(0, -1).map(s => s.url).join('->');
      if (seenBackbones.has(backbone)) return false;
      seenBackbones.add(backbone);
      return true;
    });

    // --- Part 2: Find high-fanout bottleneck nodes ---
    // A node that triggers many children (>5) all delayed by >200ms
    const bottlenecks = [];
    for (const [, node] of nodes) {
      if (node.children.length < 5) continue;
      const parentStart = node.entry?.startedDateTime
        ? new Date(node.entry.startedDateTime).getTime()
        : 0;
      const delayedChildren = node.children.filter(child => {
        const childStart = child.entry?.startedDateTime
          ? new Date(child.entry.startedDateTime).getTime()
          : 0;
        return childStart > parentStart + 200;
      });
      if (delayedChildren.length >= 5) {
        const childStarts = delayedChildren.map(c =>
          new Date(c.entry.startedDateTime).getTime()
        );
        const minDelay = Math.min(...childStarts) - parentStart;
        const maxDelay = Math.max(...childStarts) - parentStart;
        bottlenecks.push({
          url: node.url,
          parentStart,
          delayedCount: delayedChildren.length,
          totalChildren: node.children.length,
          minDelay: Math.round(minDelay),
          maxDelay: Math.round(maxDelay),
          // trace the initiator path back to root
          initiatorChain: this.traceInitiatorPath(node, nodes),
        });
      }
    }
    bottlenecks.sort((a, b) => b.delayedCount - a.delayedCount);

    if (uniqueChains.length === 0 && bottlenecks.length === 0) return null;

    let report = '* **JS Request Chains (Sequential Loading Detected):**\n';

    // Build coverage map for unused code detection
    const coverageMap = this.buildCoverageMap(this.coverageData);

    // Report sequential chains
    if (uniqueChains.length > 0) {
      uniqueChains.slice(0, 3).forEach(({ path, totalDelay }) => {
        const classification = this.classifyChain(path, this.thirdPartyAnalysis);

        report += `    * Chain depth: ${path.length}, sequential delay: ~${Math.round(totalDelay)}ms`;
        report += ` [${classification}]\n`;

        const baseTime = path[0].startTime;
        path.forEach((step, i) => {
          const relativeTime = i === 0 ? '0ms' : `+${Math.round(step.startTime - baseTime)}ms`;
          const urlShort = this.truncate(step.url);
          const typeLabel = step.resourceType ? ` (${step.resourceType})` : '';
          const thirdPartyLabel = step.isThirdParty ? ' [3P]' : '';

          report += `        ${i + 1}. ${urlShort}${typeLabel}${thirdPartyLabel} (${relativeTime})`;
          if (step.fanOut > 1) {
            report += ` → fans out to ${step.fanOut} resources`;
          }
          report += '\n';
        });

        // Add RUM correlation if available
        if (this.rumData && this.pageUrl) {
          const rumInpData = this.rumData.data?.metrics?.inp;
          if (rumInpData) {
            const correlation = correlateChainWithRUM(
              { path },
              rumInpData,
              this.pageUrl
            );
            if (correlation) {
              const summary = formatRUMCorrelation(correlation);
              report += `    * ${summary}\n`;
            }
          }
        }

        // Check for unused code in chain (only for scripts and stylesheets)
        const unusedInChain = path
          .filter(step => step.resourceType === 'script' || step.resourceType === 'stylesheet')
          .map(step => {
            const coverage = coverageMap.get(step.url);
            return coverage && coverage.unusedPercent > 50 ? {
              url: step.url,
              unusedKB: Math.round(coverage.unused / 1024),
              unusedPercent: Math.round(coverage.unusedPercent)
            } : null;
          })
          .filter(Boolean);

        // Add unused code warnings if present
        if (unusedInChain.length > 0) {
          report += `    * ⚠️  **Unused Code Detected:**\n`;
          unusedInChain.forEach(({ url, unusedKB, unusedPercent }) => {
            const urlShort = this.truncate(url);
            report += `        - ${urlShort}: ${unusedKB}KB (${unusedPercent}%) unused\n`;
          });
          const totalUnusedKB = unusedInChain.reduce((sum, u) => sum + u.unusedKB, 0);
          report += `    * **Recommendation**: Remove ${totalUnusedKB}KB of unused code from this chain via code-splitting or tree-shaking before considering preload\n`;
        } else {
          // Use standard recommendation logic
          report += `    * ${this.generateChainRecommendation(path, classification)}\n`;
        }
      });
    }

    // Report high-fanout bottlenecks
    if (bottlenecks.length > 0) {
      report += `    * **High-Fanout Bottleneck Nodes:**\n`;
      bottlenecks.slice(0, 3).forEach(bn => {
        report += `        * ${this.truncate(bn.url)} triggers ${bn.delayedCount} delayed resources (${bn.minDelay}-${bn.maxDelay}ms after parent)\n`;
        if (bn.initiatorChain.length > 1) {
          report += `          Initiator path: ${bn.initiatorChain.map(u => this.truncate(u, 50)).join(' → ')}\n`;
        }
      });
      report += `    * **Recommendation**: Preload the bottleneck scripts so the browser can discover and download their dependencies earlier\n`;
    }

    return report;
  }

  /**
   * Trace the initiator path from a node back to its root.
   * @param {Object} node - Tree node
   * @param {Map} nodes - All nodes map
   * @returns {Array<string>} Path of URLs from root to this node
   */
  traceInitiatorPath(node, nodes) {
    const path = [node.url];
    let current = node;
    const visited = new Set();
    while (current.initiatorUrl && !visited.has(current.initiatorUrl)) {
      visited.add(current.initiatorUrl);
      path.unshift(current.initiatorUrl);
      current = nodes.get(current.initiatorUrl);
      if (!current) break;
    }
    return path;
  }

  /**
   * Classify a chain as critical, deferrable, or mixed
   * @param {Array} path - Chain path array [{url, startTime, resourceType, isThirdParty, ...}]
   * @param {Object} thirdPartyAnalysis - Third-party analysis data
   * @returns {string} 'critical', 'deferrable', or 'mixed'
   */
  classifyChain(path, thirdPartyAnalysis) {
    // Extract third-party categories for each node
    const categories = path.map(node => {
      if (!node.isThirdParty) return 'first-party';

      try {
        const hostname = new URL(node.url).hostname;
        const analysis = thirdPartyAnalysis?.byDomain?.[hostname];
        return analysis?.category || 'unknown';
      } catch {
        return 'unknown';
      }
    });

    // Check if entire chain is non-critical third-parties
    const allNonCritical = categories.every(cat =>
      ['analytics', 'consent', 'tag-manager', 'monitoring', 'advertising'].includes(cat)
    );

    // Check if chain contains critical-path resources
    const hasCriticalResources = path.some(node =>
      node.resourceType === 'stylesheet' ||
      node.resourceType === 'font' ||
      (node.resourceType === 'script' && !node.isThirdParty)
    );

    if (allNonCritical) return 'deferrable';
    if (hasCriticalResources) return 'critical';
    return 'mixed';
  }

  /**
   * Generate recommendation based on chain classification and resource types
   * @param {Array} path - Chain path
   * @param {string} classification - 'critical', 'deferrable', or 'mixed'
   * @returns {string} Recommendation text
   */
  generateChainRecommendation(path, classification) {
    if (classification === 'deferrable') {
      return '**Recommendation**: Defer these third-party scripts to post-LCP using `async` or `defer` attributes, or lazy load them after user interaction';
    }

    const types = [...new Set(path.map(n => n.resourceType))];
    const recommendations = [];

    if (types.includes('stylesheet')) {
      recommendations.push('`<link rel="preload" as="style" href="...">`');
    }
    if (types.includes('font')) {
      recommendations.push('`<link rel="preload" as="font" type="font/woff2" crossorigin href="...">`');
    }
    if (types.includes('script') && classification === 'critical') {
      recommendations.push('`<link rel="preload" as="script" href="...">`');
    }

    if (recommendations.length > 0) {
      return `**Recommendation**: Preload critical resources in the HTML \`<head>\` to enable parallel downloading: ${recommendations.join(', ')}`;
    }

    return '**Recommendation**: Consider removing or deferring non-critical resources in this chain';
  }

  /**
   * Build a map of URL -> coverage statistics for quick lookup
   * @param {Object} coverageData - Coverage data from coverage collector
   * @returns {Map<string, Object>} Map of URL to { total, used, unused, unusedPercent }
   */
  buildCoverageMap(coverageData) {
    const map = new Map();

    if (!coverageData) return map;

    try {
      Object.entries(coverageData).forEach(([url, fileData]) => {
        // Only include files with _bytes metadata
        if (fileData && fileData._bytes) {
          map.set(url, {
            total: fileData._bytes.total || 0,
            used: fileData._bytes.used || 0,
            unused: fileData._bytes.unused || 0,
            unusedPercent: fileData._bytes.unusedPercent || 0,
            preLcp: fileData._bytes.preLcp || 0,
            postLcp: fileData._bytes.postLcp || 0
          });
        }
      });
    } catch (error) {
      // Graceful degradation - return empty map if coverage data is malformed
      console.warn('⚠️  Failed to build coverage map:', error.message);
    }

    return map;
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

export function summarizeHAR(harData, deviceType, options = {}) {
  const collector = new HARCollector(deviceType);
  return collector.summarize(harData, options);
}
