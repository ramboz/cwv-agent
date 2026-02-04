/**
 * JavaScript API Data Collection
 * Collects browser API data that requires page context
 *
 * Note: Font collection has been moved to font-analyzer.js for consolidated font analysis
 */

/**
 * Setup CSP violation tracking before page navigation
 * Must be called before page.goto()
 *
 * @param {Object} page - Puppeteer page instance
 * @return {Promise<void>}
 */
export async function setupCSPViolationTracking(page) {
  await page.evaluateOnNewDocument(() => {
    if (!window.CSP_VIOLATIONS) {
      window.CSP_VIOLATIONS = [];
      window.addEventListener('securitypolicyviolation', (e) => {
        window.CSP_VIOLATIONS.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
          lineNumber: e.lineNumber,
          columnNumber: e.columnNumber,
          sourceFile: e.sourceFile,
          statusCode: e.statusCode,
          referrer: e.referrer,
          effectiveDirective: e.effectiveDirective,
        });
      });
    }
  });
}

/**
 * Collect CSP violations that occurred during page load
 *
 * @param {Object} page - Puppeteer page instance
 * @return {Promise<Array>} Array of CSP violation objects
 */
export async function collectCSPViolations(page) {
  return await page.evaluate(() => {
    return window.CSP_VIOLATIONS || [];
  });
}

/**
 * Collect general JavaScript API data from the page
 * (CSP violations, and other browser API data as needed)
 *
 * @param {Object} page - Puppeteer page instance
 * @return {Promise<Object>} Collected API data
 */
export async function collectJSApiData(page) {
  return await page.evaluate(
    async () => {
      return {
        cspViolations: window.CSP_VIOLATIONS || [],
      };
    },
    { timeout: 30_000 }
  );
}

} 