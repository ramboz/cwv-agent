import { cacheResults, getCachedResults, getRequestHeaders } from '../utils.js';
import { Agent } from 'undici';

// Filter resources that match our criteria
// Denylist for JS/CSS from common libraries, frameworks, and third-party tools
// (Images, fonts, etc. are already filtered out by the JS/CSS check)
const DENYLIST_REGEX = /(granite|foundation|cq|core\.|wcm|jquery|lodash|moment|bootstrap|react\.|angular|vue\.|rxjs|three\.|videojs|chart|codemirror|ace|monaco|tinymce|ckeditor|gtag|googletag|google-analytics|analytics\.js|optimizely|segment|tealium|adobe-dtm|launch-|amplitude|mixpanel|heap|hotjar|leaflet|mapbox|googlemaps|facebook|twitter|linkedin|instagram|pinterest|stripe|paypal|braintree|polyfill|shim|brightcove|youtube|vimeo)/i;

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
  if (DENYLIST_REGEX.test(pathname)) {
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
 * @returns {Promise<Object>} - Object containing fetched resources and cache statistics
 */
export async function collect(pageUrl, deviceType, resources, { skipCache, skipTlsCheck }) {
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

      return {
      codeFiles,
      stats: {
        total: totalResources,
        fromCache: cachedResources,
        failed: failedResources,
        successful: totalResources - failedResources
      }
    };
  };

  // Race between the collection and the timeout
  return Promise.race([collectWithTimeout(), overallTimeout]);
}