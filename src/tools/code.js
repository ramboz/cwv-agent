import { cacheResults, getCachedResults, getRequestHeaders } from '../utils.js';
import { Agent } from 'undici';

// Filter resources that match our criteria
const DENYLIST_REGEX = /(granite|foundation|cq|core\.|wcm|jquery|lodash|moment|minified|bootstrap|react\.|angular|vue\.|rxjs|three\.|videojs|chart|codemirror|ace|monaco|gtag|googletag|optimizely|segment|tealium|adobe-dtm|launch-)/i;

/**
 * Centralized resource inclusion policy
 * @param {URL} requestUrl
 * @param {URL} baseUrl
 * @return {boolean}
 */
function shouldIncludeResource(requestUrl, baseUrl) {
  // Reject any 3rd party resources
  if (requestUrl.hostname !== baseUrl.hostname) {
    return false;
  }

  const pathname = requestUrl.pathname || '';
  const isJs = pathname.endsWith('.js');
  const isCss = pathname.endsWith('.css');

  // Reject any resources that match our denylist
  if (DENYLIST_REGEX.test(pathname)) return false;

  // Reject the RUM library itself
  if (isJs && pathname.includes('.rum/@adobe/helix-rum-js')) return false;

  // Additional heuristics for JS/CSS
  if (isJs) {
    return pathname.startsWith('/etc.clientlibs/') || !pathname.endsWith('.min.js');
  }
  if (isCss) {
    return pathname.includes('/etc.clientlibs/') || !pathname.endsWith('.min.css');
  }
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