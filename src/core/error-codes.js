/**
 * Standardized Error Codes for CWV Agent
 *
 * These codes provide consistent error categorization across all collectors and agents.
 * Each code indicates the type of failure and whether it's retryable.
 */

/**
 * Error codes organized by category
 */
export const ErrorCodes = {
  // Network errors (retryable)
  NETWORK_ERROR: 'NETWORK_ERROR',     // General network failure
  TIMEOUT: 'TIMEOUT',                 // Request/operation timed out
  RATE_LIMIT: 'RATE_LIMIT',          // API rate limit hit

  // Data errors (not retryable)
  INVALID_DATA: 'INVALID_DATA',       // Data doesn't match expected schema
  MISSING_FIELD: 'MISSING_FIELD',     // Required field is missing
  MISSING_DATA: 'MISSING_DATA',       // No data available (e.g., 404)
  PARSE_ERROR: 'PARSE_ERROR',         // Failed to parse data (JSON, HTML, etc.)

  // Auth/Config errors (not retryable)
  AUTH_FAILED: 'AUTH_FAILED',         // Authentication failed
  MISSING_CONFIG: 'MISSING_CONFIG',   // Required configuration missing

  // Browser errors (sometimes retryable)
  PAGE_LOAD_FAILED: 'PAGE_LOAD_FAILED',  // Page failed to load
  SCRIPT_ERROR: 'SCRIPT_ERROR',           // Browser script execution failed

  // Analysis errors (not retryable)
  ANALYSIS_FAILED: 'ANALYSIS_FAILED'  // Data analysis/processing failed
};

/**
 * Determine if an error code represents a retryable failure
 *
 * Retryable errors are typically transient issues like network timeouts,
 * rate limits, or page load failures that might succeed on retry.
 *
 * Non-retryable errors are permanent issues like missing configuration,
 * invalid data, or authentication failures.
 *
 * @param {string} code - Error code from ErrorCodes
 * @returns {boolean} True if error is retryable
 */
export function isRetryable(code) {
  const retryableCodes = new Set([
    ErrorCodes.NETWORK_ERROR,
    ErrorCodes.TIMEOUT,
    ErrorCodes.RATE_LIMIT,
    ErrorCodes.PAGE_LOAD_FAILED
  ]);

  return retryableCodes.has(code);
}

/**
 * Get human-readable error category name
 * @param {string} code - Error code from ErrorCodes
 * @returns {string} Category name
 */
export function getErrorCategory(code) {
  const categories = {
    [ErrorCodes.NETWORK_ERROR]: 'Network',
    [ErrorCodes.TIMEOUT]: 'Network',
    [ErrorCodes.RATE_LIMIT]: 'Network',
    [ErrorCodes.INVALID_DATA]: 'Data',
    [ErrorCodes.MISSING_FIELD]: 'Data',
    [ErrorCodes.PARSE_ERROR]: 'Data',
    [ErrorCodes.AUTH_FAILED]: 'Configuration',
    [ErrorCodes.MISSING_CONFIG]: 'Configuration',
    [ErrorCodes.PAGE_LOAD_FAILED]: 'Browser',
    [ErrorCodes.SCRIPT_ERROR]: 'Browser',
    [ErrorCodes.ANALYSIS_FAILED]: 'Analysis'
  };

  return categories[code] || 'Unknown';
}
