// Performance Data Collection, Analysis, and Formatting Functions

// Performance Data Collection Functions
export async function collectPerformanceEntries(page) {
  return JSON.parse(await page.evaluate(async () => {
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
        const classes = element.className.trim().split(/\s+/).slice(0, 2);
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
      // Limit to top 5 sources by impact
      sources: e.sources?.slice(0, 5).map((s) => {
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

    // Phase A+ Optimization: Filter to only CWV-critical entries
    // Resource timing is redundant (already in HAR), only keep VERY problematic ones
    const cwvCriticalEntries = entries.filter(entry => {
      // Always keep: navigation, LCP, CLS, long tasks, long animation frames
      if (['navigation', 'largest-contentful-paint', 'layout-shift', 'longtask', 'long-animation-frame'].includes(entry.entryType)) {
        return true;
      }

      // For resource timing: VERY selective - only truly problematic resources
      // (All resource data is in HAR anyway, this is just for quick reference)
      if (entry.entryType === 'resource') {
        return entry.renderBlockingStatus === 'blocking' ||
               (entry.duration > 3000 && entry.decodedBodySize > 100000);  // Very slow AND large only
      }

      // Keep FCP, FID, other paint/mark entries
      if (['paint', 'mark', 'measure', 'first-input'].includes(entry.entryType)) {
        return true;
      }

      // Filter out everything else (visibility-state, event, etc.)
      return false;
    });

    console.log(`Filtered performance entries: ${entries.length} → ${cwvCriticalEntries.length} (${Math.round((1 - cwvCriticalEntries.length/entries.length) * 100)}% reduction)`);

    return JSON.stringify(cwvCriticalEntries, null, 2);
  }, { timeout: 30_000 }));
}

// Performance Entry Analysis Functions
export function summarizePerformanceEntries(performanceEntries, deviceType, maxTokens = null) {
  let markdownOutput = `# Performance Analysis (Focused)\n\n`;

  // Group entries by type
  const entriesByType = performanceEntries.reduce((groups, entry) => {
    const type = entry.entryType;
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(entry);
    return groups;
  }, {});

  // Process navigation timing (if available)
  if (entriesByType.navigation && entriesByType.navigation.length > 0) {
    markdownOutput += `## Navigation Timing (Highlights)\n\n`;
    markdownOutput += `### Page Navigation Metrics\n`;
    markdownOutput += formatNavigationEntry(entriesByType.navigation[0]);
  }

  // Process LCP (if available)
  if (entriesByType['largest-contentful-paint']) {
    markdownOutput += `## Largest Contentful Paint (LCP)\n\n`;
    entriesByType['largest-contentful-paint'].forEach(entry => {
      markdownOutput += formatLCPEntry(entry);
    });
  }

  // Process long tasks (if available)
  const significantLongTasks = entriesByType.longtask?.filter(entry => entry.duration > 100) || [];
  if (significantLongTasks.length > 0) {
    markdownOutput += `## Long Tasks (Highlights)\n\n`;
    significantLongTasks
      .sort((a, b) => b.duration - a.duration)
      .forEach(entry => {
        markdownOutput += formatLongTaskEntry(entry);
      });
  }

  // Process long animation frames (if available)
  const significantAnimationFrames = entriesByType['long-animation-frame']?.filter(entry => entry.blockingDuration > 0) || [];
  if (significantAnimationFrames.length > 0) {
    markdownOutput += `## Long Animation Frames (Highlights)\n\n`;
    significantAnimationFrames
      .sort((a, b) => b.blockingDuration - a.blockingDuration)
      .forEach(entry => {
        markdownOutput += formatLongAnimationFrameEntry(entry);
      });
  }

  // Process layout shifts (if available)
  const significantLayoutShifts = entriesByType['layout-shift']?.filter(entry => entry.value > 0.1) || [];
  if (significantLayoutShifts.length > 0) {
    markdownOutput += `## Significant Layout Shifts\n\n`;
    significantLayoutShifts
      .sort((a, b) => b.value - a.value)
      .forEach(entry => {
        markdownOutput += formatLayoutShiftEntry(entry);
      });
  }

  // Process resource timing (if available)
  if (entriesByType.resource) {
    const resourceDurationThreshold = 1000; // 1 second
    const decodedBodySizeThreshold = 1000000; // 1MB
    
    // Find problematic resources
    const problematicResources = entriesByType.resource.filter(entry => {
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
          markdownOutput += formatResourceIssueEntry(entry);
        });
    }
  }

  return markdownOutput;
}

// Performance Entry Formatting Functions
function formatNavigationEntry(entry) {
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

function formatLongAnimationFrameEntry(entry) {
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

function formatResourceIssueEntry(entry) {
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
  output += `*   **Transfer Size:** ${entry.transferSize} bytes\n`;
  output += `*   **Decoded Body Size:** ${entry.decodedBodySize} bytes`;
  
  if (entry.decodedBodySize > decodedBodySizeThreshold) {
    output += ` **(Large Decoded Size: ${(entry.decodedBodySize / 1024 / 1024).toFixed(2)} MB)**`;
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

function formatLayoutShiftEntry(entry) {
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

function formatLongTaskEntry(entry) {
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

function formatLCPEntry(entry) {
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