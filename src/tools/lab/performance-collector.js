// Performance Data Collection, Analysis, and Formatting Functions
import { LabDataCollector } from './base-collector.js';
import { RESOURCE_THRESHOLDS, DISPLAY_LIMITS } from '../../config/thresholds.js';

// PerformanceCollector Class
export class PerformanceCollector extends LabDataCollector {
  async setup(page) {
    // No special setup needed for performance entries
    return null;
  }

  async collect(page, setupResult) {
    return this.collectPerformanceEntries(page);
  }

  summarize(performanceEntries, options = {}) {
    const { maxTokens = null, clsAttribution = null } = options;
    const error = this.validateOrDefault(
      performanceEntries,
      'performance entries',
      'No performance data available for analysis.'
    );
    if (error) return error;

    return this.summarizePerformanceEntries(performanceEntries, this.deviceType, maxTokens, clsAttribution);
  }

  // Performance-specific methods
  async collectPerformanceEntries(page) {
    return JSON.parse(await page.evaluate(async (maxClassNames, maxClsSources) => {
      console.log('Evaluating performance entries');

      const clone = (obj) => {
        return JSON.parse(JSON.stringify(obj));
      };

      // Helper: Generate minimal CSS selector for CWV analysis
      const getSelector = (element) => {
        if (!element) return null;
        let selector = element.tagName.toLowerCase();
        if (element.id) {
          selector += `#${element.id}`;
        } else if (element.className && typeof element.className === 'string') {
          const classes = element.className.trim().split(/\s+/).slice(0, maxClassNames);
          selector += classes.map(c => `.${c}`).join('');
        }
        return selector;
      };

      // Helper: Detect CLS-causing CSS issues
      const detectCssIssues = (element, computedStyle) => {
        if (!element || !computedStyle) return [];
        const issues = [];

        // Check for missing dimensions
        if (element.tagName === 'IMG') {
          if (!element.hasAttribute('width') || !element.hasAttribute('height')) {
            issues.push('missing-dimensions');
          }
        }

        // Check for missing aspect-ratio or min-height
        if (computedStyle.aspectRatio === 'auto' && computedStyle.minHeight === '0px') {
          issues.push('no-reserved-space');
        }

        // Check font loading
        if (computedStyle.fontFamily && !computedStyle.fontDisplay) {
          issues.push('font-loading-unoptimized');
        }

        return issues;
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

      // Phase A Optimization: LCP - Send only CWV-relevant data, not full HTML
      await appendEntries(entries, 'largest-contentful-paint', (e) => {
        const elem = e.element;
        return {
          name: e.name,
          entryType: e.entryType,
          startTime: e.startTime,
          duration: e.duration,
          renderTime: e.renderTime,
          loadTime: e.loadTime,
          size: e.size,
          id: e.id,
          url: e.url,
          // Minimal element info (no full HTML)
          element: elem ? {
            tag: elem.tagName?.toLowerCase(),
            selector: getSelector(elem),
            width: elem.width || elem.clientWidth,
            height: elem.height || elem.clientHeight,
            src: elem.src || elem.currentSrc,
            loading: elem.loading,
            fetchpriority: elem.fetchPriority
          } : null
        };
      });

      // Phase A Optimization: CLS - Send only top 5 sources with minimal data
      await appendEntries(entries, 'layout-shift', (e) => ({
        name: e.name,
        entryType: e.entryType,
        startTime: e.startTime,
        duration: e.duration,
        value: e.value,
        hadRecentInput: e.hadRecentInput,
        // Limit to top sources by impact
        sources: e.sources?.slice(0, maxClsSources).map((s) => {
          const computedStyle = s.node ? window.getComputedStyle(s.node) : null;
          const parent = s.node?.parentElement;
          const parentStyle = parent ? window.getComputedStyle(parent) : null;

          return {
            // Layout shift metrics (no full HTML)
            previousRect: clone(s.previousRect),
            currentRect: clone(s.currentRect),
            // Minimal element info
            node: s.node ? {
              tag: s.node.tagName?.toLowerCase(),
              selector: getSelector(s.node)
            } : null,
            // CLS-relevant CSS issues only
            cssIssues: detectCssIssues(s.node, computedStyle),
            // Minimal parent layout context
            parentLayout: parentStyle ? `${parentStyle.display}${parentStyle.flexDirection ? ' ' + parentStyle.flexDirection : ''}` : null
          };
        }) || []
      }));

      await appendEntries(entries, 'longtask', (e) => ({
        ...clone(e),
        scripts: e.scripts?.map((s) => ({
          ...clone(s),
        })) || []
      }));

      // Issue #2 Fix: Collect EventTiming entries for INP analysis
      // EventTiming API provides interaction latency data (processingStart, processingEnd, duration)
      // This is critical for diagnosing INP (Interaction to Next Paint) issues
      await appendEntries(entries, 'event', (e) => ({
        name: e.name,
        entryType: e.entryType,
        startTime: e.startTime,
        duration: e.duration,
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
        interactionId: e.interactionId,
        // Element that received the event
        target: e.target ? {
          tag: e.target.tagName?.toLowerCase(),
          selector: getSelector(e.target)
        } : null
      }));

      // Issue #2 Fix: Collect first-input entries (fallback for older browsers)
      // first-input provides FID (First Input Delay) which is a precursor to INP
      await appendEntries(entries, 'first-input', (e) => ({
        name: e.name,
        entryType: e.entryType,
        startTime: e.startTime,
        duration: e.duration,
        processingStart: e.processingStart,
        processingEnd: e.processingEnd,
        // Element that received the first input
        target: e.target ? {
          tag: e.target.tagName?.toLowerCase(),
          selector: getSelector(e.target)
        } : null
      }));

      // Phase A+ Optimization: Filter to only CWV-critical entries
      // Resource timing is redundant (already in HAR), only keep VERY problematic ones
      const cwvCriticalEntries = entries.filter(entry => {
        // Always keep: navigation, LCP, CLS, long tasks, long animation frames
        if (['navigation', 'largest-contentful-paint', 'layout-shift', 'longtask', 'long-animation-frame'].includes(entry.entryType)) {
          return true;
        }

        // Issue #2 Fix: Keep event entries for INP analysis
        // EventTiming provides critical interaction latency data
        if (entry.entryType === 'event') {
          return true;
        }

        // For resource timing: VERY selective - only truly problematic resources
        // (All resource data is in HAR anyway, this is just for quick reference)
        // Issue #6 Fix: Lower thresholds to catch moderate issues (1000ms, 50KB)
        if (entry.entryType === 'resource') {
          return entry.renderBlockingStatus === 'blocking' ||
                 entry.fetchPriority === 'high' ||
                 (entry.duration > 1000 && entry.decodedBodySize > 50000) ||  // Moderate issues
                 (entry.duration > 2000) ||  // Slow resources
                 (entry.decodedBodySize > 200000);  // Large resources
        }

        // Keep FCP, FID, other paint/mark entries
        if (['paint', 'mark', 'measure', 'first-input'].includes(entry.entryType)) {
          return true;
        }

        // Filter out everything else (visibility-state, etc.)
        return false;
      });

      console.log(`Filtered performance entries: ${entries.length} → ${cwvCriticalEntries.length} (${Math.round((1 - cwvCriticalEntries.length/entries.length) * 100)}% reduction)`);

      return JSON.stringify(cwvCriticalEntries, null, 2);
    }, DISPLAY_LIMITS.LAB.MAX_CLASS_NAMES, DISPLAY_LIMITS.LAB.MAX_CLS_SOURCES, { timeout: 30_000 }));
  }

  summarizePerformanceEntries(performanceEntries, deviceType, maxTokens = null, clsAttribution = null) {
    let markdownOutput = `# Performance Analysis (Focused)\n\n`;

    // Group entries by type
    const entriesByType = this.groupBy(performanceEntries, entry => entry.entryType);
    const entriesObj = {};
    entriesByType.forEach((entries, type) => {
      entriesObj[type] = entries;
    });

    // Process navigation timing (if available)
    if (entriesObj.navigation && entriesObj.navigation.length > 0) {
      markdownOutput += `## Navigation Timing (Highlights)\n\n`;
      markdownOutput += `### Page Navigation Metrics\n`;
      markdownOutput += this.formatNavigationEntry(entriesObj.navigation[0]);
    }

    // Process LCP (if available)
    if (entriesObj['largest-contentful-paint']) {
      markdownOutput += `## Largest Contentful Paint (LCP)\n\n`;
      entriesObj['largest-contentful-paint'].forEach(entry => {
        markdownOutput += this.formatLCPEntry(entry);
      });
    }

    // Process long tasks (if available)
    const significantLongTasks = this.filterByThreshold(
      entriesObj.longtask || [],
      entry => entry.duration,
      RESOURCE_THRESHOLDS.SLOW_BOTTLENECK
    );
    if (significantLongTasks.length > 0) {
      markdownOutput += `## Long Tasks (Highlights)\n\n`;
      significantLongTasks.forEach(entry => {
        markdownOutput += this.formatLongTaskEntry(entry);
      });
    }

    // Process long animation frames (if available)
    const significantAnimationFrames = this.filterByThreshold(
      entriesObj['long-animation-frame'] || [],
      entry => entry.blockingDuration,
      0,
      true
    );
    if (significantAnimationFrames.length > 0) {
      markdownOutput += `## Long Animation Frames (Highlights)\n\n`;
      significantAnimationFrames.forEach(entry => {
        markdownOutput += this.formatLongAnimationFrameEntry(entry);
      });
    }

    // Process layout shifts (if available)
    const significantLayoutShifts = this.filterByThreshold(
      entriesObj['layout-shift'] || [],
      entry => entry.value,
      0.1
    );
    if (significantLayoutShifts.length > 0 || clsAttribution?.summary) {
      markdownOutput += `## Significant Layout Shifts\n\n`;

      // Priority 2: Include CSS attribution if available
      if (clsAttribution?.summary) {
        markdownOutput += `**Total CLS**: ${clsAttribution.summary.totalCLS.toFixed(3)} (${clsAttribution.summary.totalShifts} shifts)\n\n`;

        if (clsAttribution.summary.byType && Object.keys(clsAttribution.summary.byType).length > 0) {
          markdownOutput += '**CLS by Type (Priority 2 Data):**\n';
          Object.entries(clsAttribution.summary.byType)
            .sort((a, b) => b[1].totalCLS - a[1].totalCLS)
            .forEach(([type, data]) => {
              markdownOutput += `* **${type}**: ${data.count} shift${data.count > 1 ? 's' : ''}, CLS ${data.totalCLS.toFixed(3)}\n`;
            });
          markdownOutput += '\n';
        }

        if (clsAttribution.summary.topIssues?.length > 0) {
          markdownOutput += '**Top CLS Issues (with CSS Attribution):**\n\n';
          clsAttribution.summary.topIssues.slice(0, DISPLAY_LIMITS.LAB.MAX_CLS_ISSUES).forEach((issue, i) => {
            markdownOutput += `${i + 1}. **Element**: \`${issue.element}\`\n`;
            markdownOutput += `   - **CLS Value**: ${issue.value.toFixed(3)}\n`;
            markdownOutput += `   - **Shift Type**: ${issue.cause.type}\n`;
            markdownOutput += `   - **Cause**: ${issue.cause.description}\n`;

            if (issue.stylesheet?.property && issue.stylesheet?.value) {
              markdownOutput += `   - **CSS Property**: \`${issue.stylesheet.property}: ${issue.stylesheet.value}\`\n`;
            }

            if (issue.stylesheet?.href) {
              markdownOutput += `   - **Stylesheet**: ${issue.stylesheet.href}\n`;
            } else {
              markdownOutput += `   - **Stylesheet**: inline or computed\n`;
            }

            if (issue.stylesheet?.selector) {
              markdownOutput += `   - **CSS Selector**: \`${issue.stylesheet.selector}\`\n`;
            }

            markdownOutput += `   - **Recommendation**: ${issue.cause.recommendation}\n`;
            markdownOutput += `   - **Priority**: ${issue.cause.priority}\n\n`;
          });
        }
      } else {
        // Fallback to old format without CSS attribution
        significantLayoutShifts.forEach(entry => {
          markdownOutput += this.formatLayoutShiftEntry(entry);
        });
      }
    }

    // Process resource timing (if available)
    if (entriesObj.resource) {
      const resourceDurationThreshold = 1000; // 1 second
      const decodedBodySizeThreshold = 1000000; // 1MB

      // Find problematic resources
      const problematicResources = entriesObj.resource.filter(entry => {
        return entry.renderBlockingStatus === 'blocking' ||
               entry.duration > resourceDurationThreshold ||
               entry.decodedBodySize > decodedBodySizeThreshold ||
               (entry.serverTiming && entry.serverTiming.some(timing =>
                 timing.name === 'cdn-cache' && timing.description === 'MISS'));
      });

      if (problematicResources.length > 0) {
        markdownOutput += `## Resource Timing Issues\n\n`;
        // Sort by duration (most impactful first)
        problematicResources
          .sort((a, b) => b.duration - a.duration)
          .forEach(entry => {
            markdownOutput += this.formatResourceIssueEntry(entry);
          });
      }
    }

    return markdownOutput;
  }

  // Formatting methods
  formatNavigationEntry(entry) {
    let output = '';
    output += `*   **Duration:** ${entry.duration.toFixed(2)} ms\n`;
    output += `*   **DOM Interactive:** ${entry.domInteractive} ms\n`;
    output += `*   **DOM Content Loaded End:** ${entry.domContentLoadedEventEnd} ms\n`;
    output += `*   **DOM Complete:** ${entry.domComplete} ms\n`;
    output += `*   **Load Event End:** ${entry.loadEventEnd} ms\n`;

    if (entry.serverTiming && entry.serverTiming.length > 0) {
      output += `*   **Server Timing (Navigation):**\n`;
      entry.serverTiming.forEach(timing => {
        output += `    *   ${timing.name}: ${timing.description} (${timing.duration}ms)\n`;
      });
    }

    output += `\n`;
    return output;
  }

  formatLongAnimationFrameEntry(entry) {
    let output = `### Frame at ${entry.startTime.toFixed(2)} ms\n`;
    output += `*   **Duration:** ${entry.duration} ms\n`;
    output += `*   **Blocking Duration:** ${entry.blockingDuration} ms\n`;

    if (entry.scripts && entry.scripts.length > 0) {
      output += `*   **Suspect Scripts:**\n`;
      entry.scripts.forEach(script => {
        output += `    *   Script: ${script.name} (Duration: ${script.duration} ms)\n`;
        output += `        *   Invoker: ${script.invoker}\n`;
      });
    }

    output += `\n`;
    return output;
  }

  formatResourceIssueEntry(entry) {
    const resourceDurationThreshold = 1000; // 1 second threshold for "slow" resources
    const decodedBodySizeThreshold = 1000000; // 1MB threshold for large decoded body size

    let output = `### Resource: ${entry.name.split('/').pop() || entry.name}\n`;
    output += `*   **URL:** ${entry.name}\n`;
    output += `*   **Initiator Type:** ${entry.initiatorType}\n`;
    output += `*   **Duration:** ${entry.duration.toFixed(2)} ms`;

    if (entry.duration > resourceDurationThreshold) {
      output += ` **(Long Load Time)**`;
    }

    output += `\n`;
    output += `*   **Render Blocking Status:** ${entry.renderBlockingStatus}`;

    if (entry.renderBlockingStatus === 'blocking') {
      output += ` **(Render Blocking)**`;
    }

    output += `\n`;
    output += `*   **Transfer Size:** ${this.formatBytes(entry.transferSize)}\n`;
    output += `*   **Decoded Body Size:** ${this.formatBytes(entry.decodedBodySize)}`;

    if (entry.decodedBodySize > decodedBodySizeThreshold) {
      output += ` **(Large Decoded Size: ${this.formatBytes(entry.decodedBodySize)})**`;
    }

    output += `\n`;

    if (entry.serverTiming && entry.serverTiming.length > 0) {
      output += `*   **Server Timing:**\n`;
      entry.serverTiming.forEach(timing => {
        output += `    *   ${timing.name}: ${timing.description} (${timing.duration}ms)`;
        if (timing.name === 'cdn-cache' && timing.description === 'MISS') {
          output += ` **(CDN Cache Miss)**`;
        }
        output += `\n`;
      });
    }

    output += `\n`;
    return output;
  }

  formatLayoutShiftEntry(entry) {
    let output = `### Shift at ${entry.startTime.toFixed(2)} ms\n`;
    output += `*   **Value:** ${entry.value.toFixed(4)} (Significant Shift)\n`;
    output += `*   **Had Recent Input:** ${entry.hadRecentInput}\n`;

    if (entry.sources && entry.sources.length > 0) {
      output += `*   **Affected Elements (top ${entry.sources.length}):**\n`;
      entry.sources.forEach((source, idx) => {
        // Phase A: Use minimal node info instead of full HTML
        const node = source.node;
        const tagName = node?.tag || 'Unknown';
        output += `    ${idx + 1}. **<${tagName}>** (${node?.selector || 'no selector'}):\n`;

        // Show rect changes
        const prevRect = source.previousRect;
        const currRect = source.currentRect;
        if (prevRect && currRect) {
          const yShift = Math.abs(currRect.top - prevRect.top);
          const xShift = Math.abs(currRect.left - prevRect.left);
          const heightChange = Math.abs(currRect.height - prevRect.height);
          const widthChange = Math.abs(currRect.width - prevRect.width);

          output += `       *   Position shift: Y: ${yShift.toFixed(1)}px, X: ${xShift.toFixed(1)}px\n`;
          if (heightChange > 0 || widthChange > 0) {
            output += `       *   Size change: Height: ${heightChange.toFixed(1)}px, Width: ${widthChange.toFixed(1)}px\n`;
          }
        }

        // Show CSS issues (Phase A: pre-detected issues instead of all properties)
        if (source.cssIssues && source.cssIssues.length > 0) {
          output += `       *   **CSS Issues:**\n`;
          source.cssIssues.forEach(issue => {
            const issueMap = {
              'missing-dimensions': 'Image missing width/height attributes',
              'no-reserved-space': 'No aspect-ratio or min-height set (element can shift)',
              'font-loading-unoptimized': 'Font loading not optimized (can cause FOUT)'
            };
            output += `           * ⚠️ ${issueMap[issue] || issue}\n`;
          });
        }

        // Show parent layout context (Phase A: simplified string instead of object)
        if (source.parentLayout) {
          output += `       *   **Parent Layout:** ${source.parentLayout}\n`;
        }

        output += `\n`;
      });
    }

    output += `\n`;
    return output;
  }

  formatLongTaskEntry(entry) {
    let output = `### Task at ${entry.startTime.toFixed(2)} ms\n`;
    output += `*   **Duration:** ${entry.duration} ms\n`;
    if (entry.name) {
      output += `*   **Name:** ${entry.name}\n`;
    }
    if (entry.attribution && entry.attribution.length > 0) {
      output += `*   **Attribution:**\n`;
      entry.attribution.forEach(attr => {
        output += `    *   ${attr.name || 'Unknown'} (${attr.containerType || 'Unknown'})\n`;
      });
    }
    output += `\n`;
    return output;
  }

  formatLCPEntry(entry) {
    let output = '';
    // Phase A: entry.element is now an object, not HTML string
    const elem = entry.element;
    const tag = elem?.tag || 'unknown';
    output += `### LCP element: <${tag}>\n`;

    output += `*   **Start Time:** ${entry.startTime.toFixed(2)} ms\n`;
    output += `*   **Render Time:** ${entry.renderTime ? entry.renderTime.toFixed(2) : 'N/A'} ms\n`;
    output += `*   **Load Time:** ${entry.loadTime ? entry.loadTime.toFixed(2) : 'N/A'} ms\n`;
    output += `*   **Size:** ${entry.size} pixels\n`;
    output += `*   **URL:** ${entry.url || elem?.src || 'N/A'}\n`;

    // Phase A: Show minimal element info
    if (elem) {
      output += `*   **Element:** <${elem.tag}${elem.selector ? ' ' + elem.selector : ''}>\n`;
      output += `*   **Dimensions:** ${elem.width}×${elem.height}px\n`;
      if (elem.loading) {
        output += `*   **Loading:** ${elem.loading}\n`;
      }
      if (elem.fetchpriority) {
        output += `*   **Fetch Priority:** ${elem.fetchpriority}\n`;
      }
    }

    output += `\n`;
    return output;
  }
}

// Backward-compatible exports
export async function collectPerformanceEntries(page) {
  const collector = new PerformanceCollector();
  return collector.collectPerformanceEntries(page);
}
export function summarizePerformanceEntries(performanceEntries, deviceType, maxTokens = null, clsAttribution = null) {
  const collector = new PerformanceCollector(deviceType);
  return collector.summarizePerformanceEntries(performanceEntries, deviceType, maxTokens, clsAttribution);
} 
