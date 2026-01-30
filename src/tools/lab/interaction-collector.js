/**
 * Interaction Collector for INP Testing
 *
 * Simulates common user interactions and measures INP-related metrics
 * using PerformanceObserver to capture real interaction timing.
 */

import { LabDataCollector } from './base-collector.js';

/**
 * Common interaction targets to test
 */
const INTERACTION_TARGETS = [
  // Navigation elements
  { selector: 'nav a', type: 'click', description: 'Navigation link' },
  { selector: 'header a', type: 'click', description: 'Header link' },
  { selector: 'button', type: 'click', description: 'Button' },

  // Form elements
  { selector: 'input[type="text"]', type: 'input', description: 'Text input' },
  { selector: 'input[type="search"]', type: 'input', description: 'Search input' },
  { selector: 'select', type: 'click', description: 'Select dropdown' },
  { selector: 'textarea', type: 'input', description: 'Textarea' },

  // Interactive elements
  { selector: '[onclick]', type: 'click', description: 'Element with onclick' },
  { selector: '[data-action]', type: 'click', description: 'Element with data-action' },
  { selector: '.accordion', type: 'click', description: 'Accordion' },
  { selector: '.tab', type: 'click', description: 'Tab' },
  { selector: '.modal-trigger', type: 'click', description: 'Modal trigger' },
  { selector: '.dropdown-toggle', type: 'click', description: 'Dropdown toggle' },

  // E-commerce elements
  { selector: '.add-to-cart', type: 'click', description: 'Add to cart button' },
  { selector: '[data-add-to-cart]', type: 'click', description: 'Add to cart (data attr)' },
  { selector: '.product-option', type: 'click', description: 'Product option' },
  { selector: '.quantity-selector', type: 'click', description: 'Quantity selector' },
];

/**
 * INP thresholds (milliseconds)
 */
const INP_THRESHOLDS = {
  good: 200,
  needsImprovement: 500,
};

/**
 * Interaction Collector Class
 */
export class InteractionCollector extends LabDataCollector {
  constructor(deviceType = 'mobile') {
    super(deviceType);
    this.interactions = [];
    this.inpMeasurements = [];
  }

  /**
   * Setup interaction observer on the page
   * @param {Object} page - Puppeteer page instance
   * @return {Promise<void>}
   */
  async setup(page) {
    // Inject INP measurement script
    await page.evaluateOnNewDocument(() => {
      window.__inpMeasurements = [];
      window.__interactionEvents = [];

      // Create PerformanceObserver for event timing
      if ('PerformanceObserver' in window) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'event') {
              const measurement = {
                name: entry.name,
                startTime: entry.startTime,
                duration: entry.duration,
                processingStart: entry.processingStart,
                processingEnd: entry.processingEnd,
                interactionId: entry.interactionId,
                target: entry.target?.tagName || 'unknown',
                targetSelector: entry.target ? getSelector(entry.target) : null,
              };
              window.__inpMeasurements.push(measurement);
            }
          }
        });

        // Helper to get selector
        function getSelector(element) {
          if (!element) return null;
          let selector = element.tagName?.toLowerCase() || '';
          if (element.id) {
            selector += `#${element.id}`;
          } else if (element.className && typeof element.className === 'string') {
            const classes = element.className.trim().split(/\\s+/).slice(0, 2);
            selector += classes.map(c => `.${c}`).join('');
          }
          return selector;
        }

        try {
          observer.observe({ type: 'event', buffered: true, durationThreshold: 0 });
        } catch (e) {
          // event timing not supported
        }
      }
    });
  }

  /**
   * Simulate interactions and collect INP measurements
   * @param {Object} page - Puppeteer page instance
   * @return {Promise<Object>} Interaction data
   */
  async collect(page) {
    const results = {
      interactions: [],
      inpMeasurements: [],
      summary: {
        totalInteractions: 0,
        successfulInteractions: 0,
        failedInteractions: 0,
        worstInp: 0,
        averageInp: 0,
        p75Inp: 0,
        slowInteractions: [],
      },
    };

    // Find and test interactive elements
    for (const target of INTERACTION_TARGETS) {
      try {
        const elements = await page.$$(target.selector);
        if (elements.length === 0) continue;

        // Test first visible element of each type
        const element = elements[0];
        const isVisible = await element.isIntersectingViewport();

        if (!isVisible) continue;

        // Clear previous measurements
        await page.evaluate(() => {
          window.__inpMeasurements = [];
        });

        // Perform interaction
        const interactionResult = await this.performInteraction(page, element, target);
        results.interactions.push(interactionResult);

        // Wait for any async handlers
        await page.waitForTimeout(100);

        // Collect INP measurements for this interaction
        const measurements = await page.evaluate(() => window.__inpMeasurements);
        if (measurements && measurements.length > 0) {
          results.inpMeasurements.push(...measurements);
        }

      } catch (error) {
        results.interactions.push({
          selector: target.selector,
          type: target.type,
          description: target.description,
          success: false,
          error: error.message,
        });
      }
    }

    // Calculate summary statistics
    results.summary = this.calculateSummary(results.interactions, results.inpMeasurements);

    return results;
  }

  /**
   * Perform a single interaction
   * @param {Object} page - Puppeteer page instance
   * @param {Object} element - Element handle
   * @param {Object} target - Target configuration
   * @return {Promise<Object>} Interaction result
   */
  async performInteraction(page, element, target) {
    const startTime = Date.now();
    let success = false;
    let error = null;

    try {
      switch (target.type) {
        case 'click':
          await element.click({ delay: 10 });
          success = true;
          break;

        case 'input':
          await element.focus();
          await element.type('test', { delay: 50 });
          success = true;
          break;

        case 'scroll':
          await element.scrollIntoView();
          success = true;
          break;

        default:
          await element.click({ delay: 10 });
          success = true;
      }
    } catch (e) {
      error = e.message;
    }

    const endTime = Date.now();

    return {
      selector: target.selector,
      type: target.type,
      description: target.description,
      success,
      error,
      duration: endTime - startTime,
    };
  }

  /**
   * Calculate summary statistics
   * @param {Array} interactions - Interaction results
   * @param {Array} measurements - INP measurements
   * @return {Object} Summary statistics
   */
  calculateSummary(interactions, measurements) {
    const successful = interactions.filter(i => i.success);
    const failed = interactions.filter(i => !i.success);

    // Extract durations from measurements
    const durations = measurements
      .map(m => m.duration)
      .filter(d => d > 0)
      .sort((a, b) => a - b);

    const worstInp = durations.length > 0 ? Math.max(...durations) : 0;
    const averageInp = durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : 0;

    // Calculate p75
    const p75Index = Math.floor(durations.length * 0.75);
    const p75Inp = durations.length > 0 ? durations[p75Index] || durations[durations.length - 1] : 0;

    // Find slow interactions (> 200ms)
    const slowInteractions = measurements
      .filter(m => m.duration > INP_THRESHOLDS.good)
      .map(m => ({
        duration: Math.round(m.duration),
        target: m.targetSelector || m.target,
        eventType: m.name,
        processingTime: Math.round(m.processingEnd - m.processingStart),
      }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    return {
      totalInteractions: interactions.length,
      successfulInteractions: successful.length,
      failedInteractions: failed.length,
      worstInp: Math.round(worstInp),
      averageInp: Math.round(averageInp),
      p75Inp: Math.round(p75Inp),
      slowInteractions,
      inpStatus: this.getInpStatus(p75Inp),
    };
  }

  /**
   * Get INP status based on p75 value
   * @param {number} p75 - P75 INP value in ms
   * @return {string} Status (good, needs-improvement, poor)
   */
  getInpStatus(p75) {
    if (p75 <= INP_THRESHOLDS.good) return 'good';
    if (p75 <= INP_THRESHOLDS.needsImprovement) return 'needs-improvement';
    return 'poor';
  }

  /**
   * Generate markdown summary of interaction data
   * @param {Object} data - Interaction data from collect()
   * @return {string} Markdown summary
   */
  summarize(data) {
    if (!data || !data.summary) {
      return 'No interaction data available.';
    }

    const { summary, interactions, inpMeasurements } = data;
    let report = '**Interaction Testing Results (INP Analysis):**\n\n';

    // Overall status
    const statusEmoji = summary.inpStatus === 'good' ? '✅' :
                       summary.inpStatus === 'needs-improvement' ? '⚠️' : '❌';
    report += `* **INP Status**: ${statusEmoji} ${summary.inpStatus.toUpperCase()}\n`;
    report += `* **P75 INP**: ${summary.p75Inp}ms\n`;
    report += `* **Worst INP**: ${summary.worstInp}ms\n`;
    report += `* **Average INP**: ${summary.averageInp}ms\n`;
    report += `* **Interactions Tested**: ${summary.successfulInteractions}/${summary.totalInteractions}\n\n`;

    // Slow interactions
    if (summary.slowInteractions && summary.slowInteractions.length > 0) {
      report += '* **Slow Interactions (>200ms):**\n';
      summary.slowInteractions.forEach((interaction, idx) => {
        report += `    ${idx + 1}. ${interaction.target} (${interaction.eventType}): ${interaction.duration}ms\n`;
        report += `       - Processing time: ${interaction.processingTime}ms\n`;
      });
      report += '\n';
    }

    // Interaction breakdown
    if (interactions && interactions.length > 0) {
      const successful = interactions.filter(i => i.success);
      if (successful.length > 0) {
        report += '* **Tested Elements:**\n';
        successful.slice(0, 10).forEach(i => {
          report += `    * ${i.description}: ${i.selector}\n`;
        });
        if (successful.length > 10) {
          report += `    * ... +${successful.length - 10} more\n`;
        }
      }
    }

    // Recommendations based on findings
    if (summary.p75Inp > INP_THRESHOLDS.good) {
      report += '\n* **Recommendations:**\n';
      if (summary.slowInteractions.some(i => i.processingTime > 100)) {
        report += '    * Break up long event handlers into smaller tasks\n';
        report += '    * Use requestIdleCallback for non-critical work\n';
      }
      if (summary.worstInp > 500) {
        report += '    * Investigate heavy JavaScript execution during interactions\n';
        report += '    * Consider debouncing/throttling event handlers\n';
      }
      report += '    * Profile interactions in Chrome DevTools Performance panel\n';
    }

    return report;
  }
}

/**
 * Collect interaction data from a page
 * @param {Object} page - Puppeteer page instance
 * @param {string} deviceType - Device type (mobile/desktop)
 * @return {Promise<Object>} Interaction data
 */
export async function collectInteractionData(page, deviceType = 'mobile') {
  const collector = new InteractionCollector(deviceType);
  await collector.setup(page);

  // Wait for page to be interactive
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
  } catch (e) {
    // Continue even if network doesn't idle
  }

  return await collector.collect(page);
}

/**
 * Summarize interaction data
 * @param {Object} data - Interaction data
 * @param {string} deviceType - Device type
 * @return {string} Markdown summary
 */
export function summarizeInteractionData(data, deviceType = 'mobile') {
  const collector = new InteractionCollector(deviceType);
  return collector.summarize(data);
}
