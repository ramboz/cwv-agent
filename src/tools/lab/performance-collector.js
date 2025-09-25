// Performance Data Collection, Analysis, and Formatting Functions

// Performance Data Collection Functions
export async function collectPerformanceEntries(page) {
  return JSON.parse(await page.evaluate(async () => {
    console.log('Evaluating performance entries');

    const clone = (obj) => {
      return JSON.parse(JSON.stringify(obj));
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

    await appendEntries(entries, 'largest-contentful-paint', (e) => ({
      ...clone(e),
      element: e.element?.outerHTML
    }));

    await appendEntries(entries, 'layout-shift', (e) => ({
      ...clone(e),
      sources: e.sources?.map((s) => ({
        ...clone(s),
        node: s.node?.outerHTML,
      })) || []
    }));

    await appendEntries(entries, 'longtask', (e) => ({
      ...clone(e),
      scripts: e.scripts?.map((s) => ({
        ...clone(s),
      })) || []
    }));

    return JSON.stringify(entries, null, 2);
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
    output += `*   **Affected Elements:**\n`;
    entry.sources.forEach(source => {
      output += `    *   Element: ${source.node}\n`;
      output += `        *   Previous Rect: ${JSON.stringify(source.previousRect)}\n`;
      output += `        *   Current Rect: ${JSON.stringify(source.currentRect)}\n`;
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
  
  // Extract element type from the HTML
  let elementType = 'Unknown Element';
  if (entry.element) {
    const match = entry.element.match(/<(\w+)/);
    if (match && match[1]) {
      elementType = match[1].toUpperCase();
    }
  }
  
  // For LCP, there's typically only one main entry that matters,
  // so we can use a more descriptive heading
  output += `### LCP element ${entry.url || elementType}\n`;
  
  output += `*   **Start Time:** ${entry.startTime.toFixed(2)} ms\n`;
  output += `*   **Render Time:** ${entry.renderTime.toFixed(2)} ms\n`;
  output += `*   **Load Time:** ${entry.loadTime.toFixed(2)} ms\n`;
  output += `*   **Size:** ${entry.size} bytes\n`;
  output += `*   **URL:** ${entry.url || 'N/A'}\n`;
  
  output += `*   **Element Type:** ${elementType}\n`;
  
  // Only include full element HTML if it's not too large
  if (entry.element && entry.element.length < 200) {
    output += `*   **Element:** ${entry.element}\n`;
  } else if (entry.element) {
    output += `*   **Element:** ${entry.element.substring(0, 197)}...\n`;
  }
  
  output += `\n`;
  return output;
} 