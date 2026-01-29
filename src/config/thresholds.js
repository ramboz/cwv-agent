/**
 * Centralized threshold definitions for CWV Agent
 *
 * All performance thresholds, limits, and magic numbers should be defined here
 * to maintain consistency across the codebase and enable easy tuning.
 *
 * Threshold values are based on:
 * - Core Web Vitals official thresholds (web.dev/vitals)
 * - Empirical analysis of production sites
 * - Token/memory limits for LLM processing
 */

/**
 * Core Web Vitals Metric Thresholds
 * Based on official Core Web Vitals percentile boundaries
 * @see https://web.dev/vitals/
 */
export const CWV_METRICS = {
  LCP: {
    good: 2500,              // <= 2.5s is good
    needsImprovement: 4000,  // > 2.5s and <= 4.0s needs improvement
    // > 4.0s is poor
  },
  FCP: {
    good: 1800,              // <= 1.8s is good
    needsImprovement: 3000,  // > 1.8s and <= 3.0s needs improvement
  },
  TBT: {
    good: 200,               // <= 200ms is good
    needsImprovement: 600,   // > 200ms and <= 600ms needs improvement
  },
  CLS: {
    good: 0.1,               // <= 0.1 is good
    needsImprovement: 0.25,  // > 0.1 and <= 0.25 needs improvement
  },
  INP: {
    good: 200,               // <= 200ms is good
    needsImprovement: 500,   // > 200ms and <= 500ms needs improvement
  },
  TTFB: {
    good: 800,               // <= 800ms is good
    needsImprovement: 1800,  // > 800ms and <= 1.8s needs improvement
  },
  SPEED_INDEX: {
    good: 3400,              // <= 3.4s is good
    needsImprovement: 5800,  // > 3.4s and <= 5.8s needs improvement
  },
};

/**
 * Device-specific thresholds for analysis gating
 * Determines when expensive operations (HAR, Coverage, Code) should run
 */
export const DEVICE_THRESHOLDS = {
  mobile: {
    // Performance metrics (milliseconds)
    LCP_MS: 3000,            // Mobile LCP threshold for gating
    TBT_MS: 250,             // Mobile TBT threshold

    // Network metrics
    REQUESTS: 150,           // Max requests before triggering analysis
    TRANSFER_BYTES: 3_000_000, // 3MB transfer threshold

    // Code efficiency
    UNUSED_BYTES: 300_000,   // 300KB unused code threshold
    UNUSED_RATIO: 0.30,      // 30% unused code ratio
    FIRST_PARTY_BYTES: 500_000, // 500KB first-party threshold
    BUNDLE_COUNT: 3,         // 3+ bundles triggers analysis

    // Layout stability
    CLS: 0.1,                // CLS threshold

    // Third-party impact
    THIRD_PARTY_COUNT: 5,    // Number of third-party origins
    THIRD_PARTY_TIME: 500,   // 500ms third-party blocking time
  },
  desktop: {
    // Performance metrics (milliseconds)
    LCP_MS: 2800,            // Desktop LCP threshold (slightly lower)
    TBT_MS: 300,             // Desktop TBT threshold

    // Network metrics
    REQUESTS: 180,           // Higher request count for desktop
    TRANSFER_BYTES: 3_500_000, // 3.5MB transfer threshold

    // Code efficiency
    UNUSED_BYTES: 400_000,   // 400KB unused code threshold
    UNUSED_RATIO: 0.30,      // 30% unused code ratio
    FIRST_PARTY_BYTES: 700_000, // 700KB first-party threshold
    BUNDLE_COUNT: 3,         // 3+ bundles triggers analysis

    // Layout stability
    CLS: 0.1,                // CLS threshold (same as mobile)

    // Third-party impact
    THIRD_PARTY_COUNT: 5,    // Number of third-party origins
    THIRD_PARTY_TIME: 500,   // 500ms third-party blocking time
  },
};

/**
 * Resource size thresholds for analysis
 */
export const RESOURCE_THRESHOLDS = {
  // File size thresholds (bytes)
  LARGE_FILE: 100 * 1024,        // 100KB - files larger than this are flagged
  VERY_LARGE_FILE: 1_000_000,    // 1MB - files larger than this are critical
  SMALL_FILE: 50 * 1024,         // 50KB - files smaller than this may be bundleable

  // Performance thresholds (milliseconds)
  SLOW_RESOURCE: 1000,           // 1s - resources slower than this are flagged
  VERY_SLOW_RESOURCE: 3000,      // 3s - resources slower than this are critical

  // Network timing thresholds (milliseconds)
  SLOW_BOTTLENECK: 100,          // 100ms - timing bottleneck threshold
  SLOW_AVG_REQUEST: 100,         // 100ms - average request time threshold
};

/**
 * Code coverage analysis thresholds
 */
export const COVERAGE_THRESHOLDS = {
  // Execution count thresholds
  HOT_PATH_EXECUTIONS: 10,       // Functions executed more than this are "hot"

  // Unused code thresholds (percentages)
  CRITICAL_UNUSED: 30,           // > 30% unused is critical
  WARNING_UNUSED: 15,            // > 15% unused warrants warning
  ACCEPTABLE_UNUSED: 50,         // < 50% unused is acceptable

  // LCP balance thresholds (percentages)
  MIN_PRE_LCP: 40,               // Minimum pre-LCP code percentage

  // Segment display limits
  MAX_POST_LCP_DISPLAY: 10,      // Show top 10 post-LCP segments
  MAX_UNUSED_DISPLAY: 10,        // Show top 10 unused segments
};

/**
 * Layout shift detection thresholds
 */
export const LAYOUT_SHIFT_THRESHOLDS = {
  // Pixel shift thresholds
  SIGNIFICANT_SHIFT: 0.1,        // CLS value threshold for significance
  MIN_HEIGHT_SHIFT: 5,           // 5px minimum height change
  MIN_WIDTH_SHIFT: 2,            // 2px minimum width change
  MIN_POSITION_SHIFT: 10,        // 10px minimum position change
  MIN_TOP_SHIFT: 10,             // 10px minimum top shift
  MIN_LEFT_SHIFT: 5,             // 5px minimum left shift
};

/**
 * Data limiting thresholds for LLM processing
 * These prevent token overflow and memory issues
 */
export const DATA_LIMITS = {
  // Entry count limits
  MAX_HAR_ENTRIES: 10_000,       // Maximum HAR entries to process
  MAX_PERF_ENTRIES: 10_000,      // Maximum performance entries
  MAX_COVERAGE_ENTRIES: 10_000,  // Maximum coverage entries

  // Display limits (for markdown output)
  MAX_LARGE_FILES: 15,           // Show top 15 large files
  MAX_DOMAINS: 15,               // Show top 15 domains
  MAX_CATEGORIES: 8,             // Show top 8 third-party categories
  MAX_TIMING_BREAKDOWN: 10,      // Show top 10 timing breakdowns
  MAX_CRITICAL_RESOURCES: 10,    // Show top 10 critical resources
  MAX_HOT_PATHS: 5,              // Show top 5 hot execution paths

  // String truncation limits
  MAX_HTML_LENGTH: 10_000,       // Maximum HTML string length before truncation
  MAX_LOG_STRING: 5_000,         // Maximum log string length
};

/**
 * HAR analysis thresholds
 */
export const HAR_THRESHOLDS = {
  // Domain filtering
  MIN_DOMAIN_BYTES: 50 * 1024,   // 50KB - minimum bytes per domain to report
  MIN_DOMAIN_REQUESTS: 5,        // 5 - minimum requests per domain to report

  // Resource filtering
  BLOCKING_RESOURCE: 'blocking',  // renderBlockingStatus value
};

/**
 * Helper function to get threshold based on metric and status
 * @param {string} metric - Metric name (LCP, FCP, TBT, etc.)
 * @param {string} status - Status level (good, needsImprovement)
 * @returns {number} Threshold value
 */
export function getCWVThreshold(metric, status = 'good') {
  const metricKey = metric.toUpperCase().replace(/[^A-Z]/g, '');
  return CWV_METRICS[metricKey]?.[status] ?? null;
}

/**
 * Helper function to get device-specific threshold
 * @param {string} deviceType - Device type (mobile, desktop)
 * @param {string} key - Threshold key
 * @returns {number} Threshold value
 */
export function getDeviceThreshold(deviceType, key) {
  return DEVICE_THRESHOLDS[deviceType]?.[key] ?? DEVICE_THRESHOLDS.mobile[key];
}

/**
 * Helper function to determine metric status
 * @param {string} metric - Metric name
 * @param {number} value - Metric value
 * @returns {string} Status: 'good', 'needs-improvement', or 'poor'
 */
export function getMetricStatus(metric, value) {
  const metricKey = metric.toUpperCase().replace(/[^A-Z]/g, '');
  const thresholds = CWV_METRICS[metricKey];

  if (!thresholds) return 'unknown';

  if (value <= thresholds.good) return 'good';
  if (value <= thresholds.needsImprovement) return 'needs-improvement';
  return 'poor';
}

// Export all for convenience
export default {
  CWV_METRICS,
  DEVICE_THRESHOLDS,
  RESOURCE_THRESHOLDS,
  COVERAGE_THRESHOLDS,
  LAYOUT_SHIFT_THRESHOLDS,
  DATA_LIMITS,
  HAR_THRESHOLDS,
  getCWVThreshold,
  getDeviceThreshold,
  getMetricStatus,
};
