/**
 * Correlates request chains with RUM INP data to validate real-world impact
 *
 * This module helps prioritize chain optimizations by showing which chains
 * affect actual user interactions in the field.
 */

/**
 * Calculate p75 (75th percentile) from an array of values
 * @param {Array<number>} values - Array of numeric values
 * @returns {number} The 75th percentile value
 */
function calculateP75(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * 0.75) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Correlate a request chain with RUM INP data
 *
 * Note: This is a simplified correlation approach. Full correlation would require
 * runtime instrumentation to know which scripts attach handlers to which elements.
 * Instead, we use general statistics: if RUM shows poor INP and the chain contains
 * scripts, there's likely a correlation.
 *
 * @param {Object} chain - Chain object with path array
 * @param {Object} rumInpData - RUM INP metrics with topSlow interactions
 * @param {string} pageUrl - URL of the page being analyzed
 * @returns {Object|null} Correlation statistics or null if no correlation
 */
export function correlateChainWithRUM(chain, rumInpData, pageUrl) {
  if (!rumInpData || !rumInpData.topSlow || rumInpData.topSlow.length === 0) {
    return null;
  }

  // Filter INP events for the current page
  const pageInteractions = rumInpData.topSlow.filter(inp => inp.url === pageUrl);

  if (pageInteractions.length === 0) {
    return null;
  }

  // Check if chain contains scripts (potential handlers)
  const hasScripts = chain.path.some(node =>
    node.resourceType === 'script' && !node.isThirdParty
  );

  if (!hasScripts) {
    // No first-party scripts in chain, unlikely to affect INP
    return null;
  }

  // Calculate statistics
  const inpValues = pageInteractions.map(i => i.value);
  const p75INP = calculateP75(inpValues);

  // If INP is good (<200ms), no need to optimize
  if (p75INP < 200) {
    return null;
  }

  // Calculate confidence based on sample size
  // More samples = higher confidence that this is a real issue
  const confidence = Math.min(pageInteractions.length / 100, 1.0);

  return {
    affectedSamples: pageInteractions.length,
    totalSamples: rumInpData.topSlow.length,
    impactPercentage: (pageInteractions.length / rumInpData.topSlow.length) * 100,
    p75INP,
    confidence,
    threshold: 200, // INP "good" threshold
    status: p75INP <= 200 ? 'good' : p75INP <= 500 ? 'needs-improvement' : 'poor'
  };
}

/**
 * Generate a summary string for RUM correlation
 * @param {Object} correlation - Correlation object from correlateChainWithRUM
 * @returns {string} Human-readable summary
 */
export function formatRUMCorrelation(correlation) {
  if (!correlation) {
    return '';
  }

  const statusIcon = correlation.status === 'good' ? '✅' :
                     correlation.status === 'needs-improvement' ? '⚠️' : '❌';

  return `⚠️  **Real-World Impact**: This page has ${correlation.affectedSamples} INP interactions with p75 ${correlation.p75INP}ms ${statusIcon} (${correlation.status.toUpperCase()}). Optimizing scripts in this chain may improve field INP.`;
}
