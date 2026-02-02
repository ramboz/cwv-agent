import { cacheResults, getCachedResults, getRequestHeaders } from '../utils.js';
import { Agent } from 'undici';
import { RESOURCE_DENYLIST_EXTENDED_REGEX } from '../config/regex-patterns.js';
import { Result } from '../core/result.js';
import { ErrorCodes } from '../core/error-codes.js';

/**
 * Centralized resource inclusion policy for performance analysis
 *
 * Focus: Only collect first-party JS/CSS that can be analyzed for optimization
 *
 * @param {URL} requestUrl - The resource URL to evaluate
 * @param {URL} baseUrl - The base page URL
 * @return {boolean} - True if resource should be collected for analysis
 */
function shouldIncludeResource(requestUrl, baseUrl) {
  const pathname = requestUrl.pathname || '';

  // 1. ONLY analyze code resources (JS/CSS)
  // Reject images, fonts, videos, PDFs, data files, etc.
  const isJs = pathname.endsWith('.js');
  const isCss = pathname.endsWith('.css');

  if (!isJs && !isCss) {
    return false;  // Not code - skip
  }

  // 2. Reject third-party resources
  // Third-party scripts are analyzed separately by HAR agent
  if (requestUrl.hostname !== baseUrl.hostname) {
    return false;
  }

  // 3. Reject resources matching denylist
  // Common libraries, frameworks, analytics tools that don't need analysis
  if (RESOURCE_DENYLIST_EXTENDED_REGEX.test(pathname)) {
    return false;
  }

  // 4. Reject RUM library (monitoring, not application code)
  if (isJs && pathname.includes('.rum/@adobe/helix-rum-js')) {
    return false;
  }

  // 5. AEM Clientlibs: Always include (even if minified)
  // These are project-specific bundles that should be analyzed
  const isAEMClientlib = pathname.startsWith('/etc.clientlibs/') || pathname.startsWith('/apps/');
  if (isAEMClientlib) {
    return true;
  }

  // 6. Non-AEM resources: Exclude minified files
  // Prefer source code for better analysis (variable names, comments, structure)
  if (isJs && pathname.endsWith('.min.js')) {
    return false;  // Minified JS outside AEM clientlibs
  }

  if (isCss && pathname.endsWith('.min.css')) {
    return false;  // Minified CSS outside AEM clientlibs
  }

  // 7. Include all other first-party JS/CSS
  return true;
}

/**
 * Creates fetch options with appropriate headers and TLS settings
 * @param {string} deviceType - Device type for headers
 * @param {boolean} skipTlsCheck - Whether to skip TLS certificate validation
 * @returns {Object} - Fetch options object
 */
function createFetchOptions(deviceType, skipTlsCheck) {
  return {
    headers: getRequestHeaders(deviceType),
    // Optional TLS validation bypass
    dispatcher: skipTlsCheck ? new Agent({
      connect: { rejectUnauthorized: false }
    }) : undefined
  };
}

/**
 * Fetches a single resource and handles caching
 * @param {string} url - URL to fetch
 * @param {string} deviceType - Device type for cache key
 * @param {Object} fetchOptions - Fetch options
 * @param {boolean} skipCache - Whether to skip cache lookup
 * @returns {Promise<Object>} - Object with result and stats
 */
async function fetchResource(url, deviceType, fetchOptions, skipCache) {
  // Check cache first
  const cachedContent = getCachedResults(url, deviceType, 'code');
  if (cachedContent && !skipCache) {
    return { 
      content: cachedContent, 
      fromCache: true,
      failed: false
    };
  }

  try {
    // Try non-minified version first if URL contains .min.
    let response;
    if (url.includes('.min.')) {
      const nonMinifiedUrl = url.replace('.min.', '.');
      response = await fetch(nonMinifiedUrl, fetchOptions);
    }

    // If no response or not OK, try original URL
    if (!response || !response.ok) {
      response = await fetch(url, fetchOptions);
    }

    if (!response.ok) {
      console.warn(`Failed to fetch resource: ${url}. Status: ${response.status} - ${response.statusText}`);
      return { 
        content: null, 
        fromCache: false,
        failed: true
      };
    }

    // Get the response body
    const body = await response.text();
    cacheResults(url, deviceType, 'code', body);
    
    return { 
      content: body, 
      fromCache: false,
      failed: false
    };
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error.message);
    console.error(error.stack);
    return { 
      content: null, 
      fromCache: false,
      failed: true,
      error
    };
  }
}

/**
 * Fetches and processes multiple resources from a list of URLs
 * @param {string} pageUrl - Base page URL
 * @param {string} deviceType - Device type for cache key
 * @param {string[]} resources - Array of resource URLs to fetch
 * @param {Object} options - Additional options
 * @param {boolean} options.skipCache - Whether to skip cache lookup
 * @param {boolean} options.skipTlsCheck - Whether to skip TLS certificate validation
 * @returns {Promise<Result>} - Result containing fetched resources and cache statistics
 */
export async function collect(pageUrl, deviceType, resources, { skipCache, skipTlsCheck }) {
  const startTime = Date.now();

  // Add overall timeout for the entire code collection process
  const overallTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Code collection timeout (2 minutes)')), 120000)
  );

  const collectWithTimeout = async () => {
    const baseUrl = new URL(pageUrl);
    const codeFiles = {};
    let cachedResources = 0;
    let failedResources = 0;

    // Filter resources that match our criteria
    const urlsToProcess = resources.filter(url => {
      try {
        const requestUrl = new URL(url);
        return shouldIncludeResource(requestUrl, baseUrl);
      } catch (error) {
        console.error(`Invalid URL: ${url}`, error);
        return false;
      }
    });

    const totalResources = urlsToProcess.length;
    const fetchOptions = createFetchOptions(deviceType, skipTlsCheck);

    // Process each resource sequentially to avoid overwhelming the server
    for (const url of urlsToProcess) {
      try {
        // Add timeout for each resource (30 seconds)
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Resource fetch timeout')), 30000)
        );

        const result = await Promise.race([
          fetchResource(url, deviceType, fetchOptions, skipCache),
          timeoutPromise
        ]);

        if (result.fromCache) {
          cachedResources++;
        }

        if (result.failed) {
          failedResources++;
        } else if (result.content) {
          codeFiles[url] = result.content;
        }
      } catch (error) {
        failedResources++;
      }
    }

    return Result.ok(
      {
        codeFiles,
        stats: {
          total: totalResources,
          fromCache: cachedResources,
          failed: failedResources,
          successful: totalResources - failedResources
        }
      },
      {
        source: cachedResources === totalResources ? 'cache' : cachedResources > 0 ? 'partial-cache' : 'fresh',
        duration: Date.now() - startTime
      }
    );
  };

  try {
    // Race between the collection and the timeout
    return await Promise.race([collectWithTimeout(), overallTimeout]);
  } catch (error) {
    return Result.err(
      ErrorCodes.TIMEOUT,
      `Code collection failed: ${error.message}`,
      { url: pageUrl, deviceType },
      true // Timeout is retryable
    );
  }
}

/**
 * Detects which framework(s) are being used on the page
 * @param {string} htmlContent - HTML content of the page
 * @param {string[]} scriptUrls - Array of script URLs loaded on the page
 * @returns {string[]} - Array of detected framework names
 */
export function detectFramework(htmlContent, scriptUrls = []) {
  const frameworks = {
    nextjs: /_next\/|__NEXT_DATA__/i,
    nuxt: /__NUXT__|nuxtApp/i,
    react: /react\.|React\.|_reactListening/i,
    vue: /__vue|Vue\.|vue-/i,
    angular: /ng-version=|ng-app|angular\.io/i,
    svelte: /__svelte|svelte-/i,
    astro: /astro-island|data-astro/i
  };

  const detected = [];

  // Check HTML content
  for (const [name, pattern] of Object.entries(frameworks)) {
    if (pattern.test(htmlContent)) {
      detected.push(name);
    }
  }

  // Check script URLs
  scriptUrls.forEach(script => {
    if (/react|react-dom/.test(script) && !detected.includes('react')) {
      detected.push('react');
    }
    if (/vue\./.test(script) && !detected.includes('vue')) {
      detected.push('vue');
    }
  });

  return detected.length > 0 ? detected : ['vanilla'];
}