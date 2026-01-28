import { fetch } from 'undici';
import { cacheResults, getCachedResults } from '../utils.js';

/**
 * Collects Real User Monitoring (RUM) data from Helix RUM Bundler
 * This provides actual INP measurements from real users, which lab tests cannot capture
 *
 * @param {string} url - The page URL to analyze
 * @param {string} deviceType - Device type (mobile/desktop)
 * @param {Object} options - Collection options
 * @param {string} options.rumDomainKey - Optional RUM domain key for authentication
 * @returns {Object} RUM data with INP metrics
 */
export async function collectRUMData(url, deviceType, options = {}) {
  const { skipCache = false, rumDomainKey = null, daysBack = 7 } = options;

  // Check for RUM domain key (per-domain, not per-URL)
  // Priority: 1. Passed in options, 2. Environment variable
  const domainKey = rumDomainKey || process.env.RUM_DOMAIN_KEY;

  if (!domainKey) {
    // Gracefully skip RUM data collection - no warning, just debug info
    return { data: null, error: 'No RUM domain key configured', fromCache: false };
  }

  if (!skipCache) {
    const cached = getCachedResults(url, deviceType, 'rum');
    if (cached) {
      return { data: cached, fromCache: true };
    }
  }

  try {
    const domain = new URL(url).hostname;

    // Fetch last 7 days of RUM data (bundles are indexed by date)
    const dates = getLast7Days(daysBack);
    const allRumData = [];

    console.log(`Fetching RUM data for ${domain} from last ${daysBack} days...`);

    for (const date of dates) {
      const rumApiUrl = `https://bundles.aem.page/bundles/${domain}/${date}?domainkey=${domainKey}`;

      try {
        const response = await fetch(rumApiUrl, {
          headers: {
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(10000) // 10 second timeout per request
        });

        if (response.ok) {
          const dayData = await response.json();
          if (dayData?.rumBundles && Array.isArray(dayData.rumBundles)) {
            allRumData.push(...dayData.rumBundles);
            console.log(`  ✓ ${date}: ${dayData.rumBundles.length} bundles`);
          }
        } else if (response.status === 404) {
          // No data for this day - expected for recent dates
          console.log(`  - ${date}: No data available`);
        } else {
          console.warn(`  ⚠ ${date}: HTTP ${response.status}`);
        }
      } catch (error) {
        console.warn(`  ⚠ ${date}: ${error.message}`);
        // Continue with other dates even if one fails
      }
    }

    if (allRumData.length === 0) {
      console.warn('No RUM data found across all dates');
      return { data: null, error: 'No RUM data available', fromCache: false };
    }

    console.log(`Total bundles collected: ${allRumData.length}`);

    // Extract all CWV metrics from bundles
    const cwvMetrics = extractCWVMetrics(allRumData);

    if (Object.keys(cwvMetrics).length === 0) {
      console.warn('No CWV data found in RUM bundles');
      return { data: null, error: 'No CWV data available', fromCache: false };
    }

    // Calculate p75 for each metric (CWV standard)
    const summary = {
      daysAnalyzed: dates.length,
      bundleCount: allRumData.length,
      metrics: {}
    };

    // Process INP metrics
    if (cwvMetrics.inp && cwvMetrics.inp.length > 0) {
      const inpValues = cwvMetrics.inp.map(m => m.value).sort((a, b) => a - b);
      const p75INP = calculateP75(inpValues);
      const byInteractionType = groupBy(cwvMetrics.inp, 'interactionType');

      summary.metrics.inp = {
        p75: p75INP,
        sampleSize: cwvMetrics.inp.length,
        status: p75INP <= 200 ? 'good' : p75INP <= 500 ? 'needs-improvement' : 'poor',
        topSlow: cwvMetrics.inp
          .sort((a, b) => b.value - a.value)
          .slice(0, 10),
        byInteractionType: Object.entries(byInteractionType).map(([type, events]) => ({
          type,
          count: events.length,
          p75: calculateP75(events.map(e => e.value))
        }))
      };
    }

    // Process LCP metrics
    if (cwvMetrics.lcp && cwvMetrics.lcp.length > 0) {
      const lcpValues = cwvMetrics.lcp.map(m => m.value).sort((a, b) => a - b);
      const p75LCP = calculateP75(lcpValues);

      summary.metrics.lcp = {
        p75: p75LCP,
        sampleSize: cwvMetrics.lcp.length,
        status: p75LCP <= 2500 ? 'good' : p75LCP <= 4000 ? 'needs-improvement' : 'poor',
        topSlow: cwvMetrics.lcp
          .sort((a, b) => b.value - a.value)
          .slice(0, 10)
      };
    }

    // Process CLS metrics
    if (cwvMetrics.cls && cwvMetrics.cls.length > 0) {
      const clsValues = cwvMetrics.cls.map(m => m.value).sort((a, b) => a - b);
      const p75CLS = calculateP75(clsValues);

      summary.metrics.cls = {
        p75: p75CLS,
        sampleSize: cwvMetrics.cls.length,
        status: p75CLS <= 0.1 ? 'good' : p75CLS <= 0.25 ? 'needs-improvement' : 'poor',
        topWorst: cwvMetrics.cls
          .sort((a, b) => b.value - a.value)
          .slice(0, 10)
      };
    }

    // Process TTFB metrics
    if (cwvMetrics.ttfb && cwvMetrics.ttfb.length > 0) {
      const ttfbValues = cwvMetrics.ttfb.map(m => m.value).sort((a, b) => a - b);
      const p75TTFB = calculateP75(ttfbValues);

      summary.metrics.ttfb = {
        p75: p75TTFB,
        sampleSize: cwvMetrics.ttfb.length,
        status: p75TTFB <= 800 ? 'good' : p75TTFB <= 1800 ? 'needs-improvement' : 'poor',
        topSlow: cwvMetrics.ttfb
          .sort((a, b) => b.value - a.value)
          .slice(0, 10)
      };
    }

    // Group by URL for all metrics
    summary.byUrl = analyzeByUrl(allRumData, cwvMetrics);

    const result = {
      raw: { rumBundles: allRumData }, // Keep same structure for compatibility
      summary
    };
    cacheResults(url, deviceType, 'rum', result);

    return { data: result, fromCache: false };

  } catch (error) {
    console.warn('Failed to fetch RUM data:', error.message);
    return { data: null, error: error.message, fromCache: false };
  }
}

/**
 * Generates array of date strings for the last N days in YYYY/MM/DD format
 * @param {number} daysBack - Number of days to go back
 * @returns {Array<string>} Array of date strings
 */
function getLast7Days(daysBack = 7) {
  const dates = [];
  const today = new Date();

  for (let i = 0; i < daysBack; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    dates.push(`${year}/${month}/${day}`);
  }

  return dates;
}

/**
 * Extracts all CWV metrics from RUM bundles
 * @param {Array} rumBundles - Array of RUM bundle objects
 * @returns {Object} Object with arrays of metrics: { inp: [], lcp: [], cls: [], ttfb: [] }
 */
function extractCWVMetrics(rumBundles) {
  if (!Array.isArray(rumBundles) || rumBundles.length === 0) {
    return {};
  }

  const metrics = {
    inp: [],
    lcp: [],
    cls: [],
    ttfb: []
  };

  for (const bundle of rumBundles) {
    if (!bundle?.events || !Array.isArray(bundle.events)) {
      continue;
    }

    const baseInfo = {
      timestamp: bundle.time,
      url: bundle.url,
      userAgent: bundle.userAgent,
      weight: bundle.weight
    };

    // Extract INP (Interaction to Next Paint)
    const inpEvents = bundle.events.filter(e => e.checkpoint === 'cwv-inp');
    for (const event of inpEvents) {
      // Find associated interaction for context
      const interactionEvent = bundle.events.find(e =>
        (e.checkpoint === 'click' || e.checkpoint === 'keydown' || e.checkpoint === 'pointerdown') &&
        Math.abs(e.timeDelta - event.timeDelta) < 100
      );

      if (event.value > 0) {
        metrics.inp.push({
          ...baseInfo,
          value: event.value,
          target: interactionEvent?.target || event.target || 'unknown',
          interactionType: interactionEvent?.checkpoint || event.source || 'unknown'
        });
      }
    }

    // Extract LCP (Largest Contentful Paint)
    const lcpEvents = bundle.events.filter(e => e.checkpoint === 'cwv-lcp');
    for (const event of lcpEvents) {
      if (event.value > 0) {
        metrics.lcp.push({
          ...baseInfo,
          value: event.value,
          target: event.target || event.source || 'unknown'
        });
      }
    }

    // Extract CLS (Cumulative Layout Shift)
    const clsEvents = bundle.events.filter(e => e.checkpoint === 'cwv-cls');
    for (const event of clsEvents) {
      if (event.value !== undefined) {
        metrics.cls.push({
          ...baseInfo,
          value: event.value,
          target: event.target || event.source || 'unknown'
        });
      }
    }

    // Extract TTFB (Time to First Byte)
    const ttfbEvents = bundle.events.filter(e => e.checkpoint === 'cwv-ttfb');
    for (const event of ttfbEvents) {
      if (event.value > 0) {
        metrics.ttfb.push({
          ...baseInfo,
          value: event.value
        });
      }
    }
  }

  return metrics;
}

/**
 * Analyzes CWV metrics grouped by URL
 * @param {Array} rumBundles - Array of RUM bundle objects
 * @param {Object} cwvMetrics - Extracted CWV metrics
 * @returns {Array} Array of URL analysis objects
 */
function analyzeByUrl(rumBundles, cwvMetrics) {
  const urlMap = new Map();

  // Aggregate all metrics by URL
  for (const bundle of rumBundles) {
    const url = bundle.url;
    if (!urlMap.has(url)) {
      urlMap.set(url, {
        url,
        bundleCount: 0,
        metrics: { inp: [], lcp: [], cls: [], ttfb: [] }
      });
    }

    const urlData = urlMap.get(url);
    urlData.bundleCount++;

    // Find metrics for this URL
    if (cwvMetrics.inp) {
      urlData.metrics.inp.push(...cwvMetrics.inp.filter(m => m.url === url).map(m => m.value));
    }
    if (cwvMetrics.lcp) {
      urlData.metrics.lcp.push(...cwvMetrics.lcp.filter(m => m.url === url).map(m => m.value));
    }
    if (cwvMetrics.cls) {
      urlData.metrics.cls.push(...cwvMetrics.cls.filter(m => m.url === url).map(m => m.value));
    }
    if (cwvMetrics.ttfb) {
      urlData.metrics.ttfb.push(...cwvMetrics.ttfb.filter(m => m.url === url).map(m => m.value));
    }
  }

  // Calculate p75 for each metric per URL
  const urlAnalysis = Array.from(urlMap.values()).map(urlData => ({
    url: urlData.url,
    bundleCount: urlData.bundleCount,
    inp: urlData.metrics.inp.length > 0 ? calculateP75(urlData.metrics.inp) : null,
    lcp: urlData.metrics.lcp.length > 0 ? calculateP75(urlData.metrics.lcp) : null,
    cls: urlData.metrics.cls.length > 0 ? calculateP75(urlData.metrics.cls) : null,
    ttfb: urlData.metrics.ttfb.length > 0 ? calculateP75(urlData.metrics.ttfb) : null
  }));

  // Sort by worst overall performance (sum of normalized scores)
  return urlAnalysis
    .map(u => ({
      ...u,
      score: (
        (u.inp ? u.inp / 200 : 0) +
        (u.lcp ? u.lcp / 2500 : 0) +
        (u.cls ? u.cls / 0.1 : 0) +
        (u.ttfb ? u.ttfb / 800 : 0)
      )
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // Top 10 worst performing URLs
}

/**
 * Groups array of objects by a key
 * @param {Array} array - Array to group
 * @param {string} key - Key to group by
 * @returns {Object} Grouped object
 */
function groupBy(array, key) {
  return array.reduce((result, item) => {
    const groupKey = item[key] || 'unknown';
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    result[groupKey].push(item);
    return result;
  }, {});
}

/**
 * Calculates the 75th percentile of an array
 * @param {Array} values - Array of numbers
 * @returns {number} p75 value
 */
function calculateP75(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.75);
  return sorted[index] || 0;
}

/**
 * Summarizes RUM data for agent consumption
 * @param {Object} rumData - RUM data object with summary
 * @returns {string} Markdown formatted summary
 */
export function summarizeRUM(rumData) {
  if (!rumData?.summary) {
    return '**RUM Data:** Not available (site may not use Helix RUM, or no recent data)';
  }

  const { daysAnalyzed, bundleCount, metrics, byUrl } = rumData.summary;

  let report = `**RUM Data Summary (Real User Monitoring - Last ${daysAnalyzed} Days):**\n\n`;
  report += `* **Data Collection:** ${bundleCount} bundles from last ${daysAnalyzed} days\n`;
  report += `* **Advantage:** More recent than CrUX (28-day rolling average)\n\n`;

  // Core Web Vitals Summary
  report += `**Core Web Vitals (p75):**\n\n`;

  // INP
  if (metrics.inp) {
    const statusIcon = metrics.inp.status === 'good' ? '✅' : metrics.inp.status === 'needs-improvement' ? '⚠️' : '❌';
    report += `* **INP (Interaction to Next Paint):** ${metrics.inp.p75}ms ${statusIcon} ${metrics.inp.status.toUpperCase()}\n`;
    report += `  * Sample size: ${metrics.inp.sampleSize} interactions\n`;
    report += `  * Threshold: ≤200ms (Good), ≤500ms (Needs Improvement), >500ms (Poor)\n`;

    // Top slow interactions
    if (metrics.inp.topSlow && metrics.inp.topSlow.length > 0) {
      report += `  * **Top 5 Slow Interactions:**\n`;
      metrics.inp.topSlow.slice(0, 5).forEach((interaction, idx) => {
        const urlPath = interaction.url ? new URL(interaction.url).pathname : 'unknown';
        report += `    ${idx + 1}. ${interaction.interactionType} on \`${interaction.target}\` (${interaction.value}ms) - ${urlPath}\n`;
      });
    }

    // By interaction type
    if (metrics.inp.byInteractionType && metrics.inp.byInteractionType.length > 0) {
      report += `  * **By Interaction Type:**\n`;
      metrics.inp.byInteractionType.forEach(({ type, count, p75 }) => {
        report += `    * ${type}: ${count} samples, p75=${p75}ms\n`;
      });
    }
    report += `\n`;
  }

  // LCP
  if (metrics.lcp) {
    const statusIcon = metrics.lcp.status === 'good' ? '✅' : metrics.lcp.status === 'needs-improvement' ? '⚠️' : '❌';
    report += `* **LCP (Largest Contentful Paint):** ${metrics.lcp.p75}ms ${statusIcon} ${metrics.lcp.status.toUpperCase()}\n`;
    report += `  * Sample size: ${metrics.lcp.sampleSize} measurements\n`;
    report += `  * Threshold: ≤2500ms (Good), ≤4000ms (Needs Improvement), >4000ms (Poor)\n`;

    if (metrics.lcp.topSlow && metrics.lcp.topSlow.length > 0) {
      report += `  * **Top 3 Slowest:**\n`;
      metrics.lcp.topSlow.slice(0, 3).forEach((m, idx) => {
        const urlPath = m.url ? new URL(m.url).pathname : 'unknown';
        report += `    ${idx + 1}. ${m.value}ms on ${m.target} - ${urlPath}\n`;
      });
    }
    report += `\n`;
  }

  // CLS
  if (metrics.cls) {
    const statusIcon = metrics.cls.status === 'good' ? '✅' : metrics.cls.status === 'needs-improvement' ? '⚠️' : '❌';
    report += `* **CLS (Cumulative Layout Shift):** ${metrics.cls.p75.toFixed(3)} ${statusIcon} ${metrics.cls.status.toUpperCase()}\n`;
    report += `  * Sample size: ${metrics.cls.sampleSize} measurements\n`;
    report += `  * Threshold: ≤0.1 (Good), ≤0.25 (Needs Improvement), >0.25 (Poor)\n`;

    if (metrics.cls.topWorst && metrics.cls.topWorst.length > 0) {
      report += `  * **Top 3 Worst:**\n`;
      metrics.cls.topWorst.slice(0, 3).forEach((m, idx) => {
        const urlPath = m.url ? new URL(m.url).pathname : 'unknown';
        report += `    ${idx + 1}. ${m.value.toFixed(3)} - ${urlPath}\n`;
      });
    }
    report += `\n`;
  }

  // TTFB
  if (metrics.ttfb) {
    const statusIcon = metrics.ttfb.status === 'good' ? '✅' : metrics.ttfb.status === 'needs-improvement' ? '⚠️' : '❌';
    report += `* **TTFB (Time to First Byte):** ${metrics.ttfb.p75}ms ${statusIcon} ${metrics.ttfb.status.toUpperCase()}\n`;
    report += `  * Sample size: ${metrics.ttfb.sampleSize} measurements\n`;
    report += `  * Threshold: ≤800ms (Good), ≤1800ms (Needs Improvement), >1800ms (Poor)\n`;

    if (metrics.ttfb.topSlow && metrics.ttfb.topSlow.length > 0) {
      report += `  * **Top 3 Slowest:**\n`;
      metrics.ttfb.topSlow.slice(0, 3).forEach((m, idx) => {
        const urlPath = m.url ? new URL(m.url).pathname : 'unknown';
        report += `    ${idx + 1}. ${m.value}ms - ${urlPath}\n`;
      });
    }
    report += `\n`;
  }

  // Worst performing pages (by combined score)
  if (byUrl && byUrl.length > 0) {
    report += `**Worst Performing Pages (Combined CWV Score):**\n\n`;
    byUrl.slice(0, 5).forEach(({ url, bundleCount, inp, lcp, cls, ttfb, score }, idx) => {
      const urlPath = new URL(url).pathname;
      report += `${idx + 1}. \`${urlPath}\` (${bundleCount} bundles, score: ${score.toFixed(2)})\n`;
      if (inp !== null) report += `   * INP: ${inp}ms\n`;
      if (lcp !== null) report += `   * LCP: ${lcp}ms\n`;
      if (cls !== null) report += `   * CLS: ${cls.toFixed(3)}\n`;
      if (ttfb !== null) report += `   * TTFB: ${ttfb}ms\n`;
    });
  }

  return report;
}

/**
 * Fallback to CrUX INP if RUM is not available
 * @param {Object} cruxData - CrUX data object
 * @returns {string} Markdown formatted INP from CrUX
 */
export function extractCrUXINP(cruxData) {
  if (!cruxData?.record?.metrics?.interaction_to_next_paint) {
    return '**INP Data:** Not available from CrUX';
  }

  const inp = cruxData.record.metrics.interaction_to_next_paint;
  const p75Value = inp.percentiles?.p75 || 0;

  let inpStatus = '✅ GOOD';
  if (p75Value > 500) {
    inpStatus = '❌ POOR';
  } else if (p75Value > 200) {
    inpStatus = '⚠️ NEEDS IMPROVEMENT';
  }

  let report = `**INP Data (from CrUX - Field Data):**\n\n`;
  report += `* **p75 INP:** ${p75Value}ms ${inpStatus}\n`;
  report += `  * Threshold: ≤200ms (Good), ≤500ms (Needs Improvement), >500ms (Poor)\n`;

  // Distribution if available
  if (inp.histogram) {
    const good = inp.histogram.find(h => h.start === 0)?.density || 0;
    const needsImprovement = inp.histogram.find(h => h.start === 200)?.density || 0;
    const poor = inp.histogram.find(h => h.start === 500)?.density || 0;

    report += `* **Distribution:** ${Math.round(good * 100)}% good, ${Math.round(needsImprovement * 100)}% needs improvement, ${Math.round(poor * 100)}% poor\n`;
  }

  report += `\n**Note:** CrUX provides aggregate data. For more detailed INP analysis, consider enabling Helix RUM.\n`;

  return report;
}
