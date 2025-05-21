import { cacheResults, getCachedResults, getRequestHeaders } from '../utils.js';
import { Agent } from 'undici';

/**
 * Determines if a URL should be processed based on filtering rules
 * @param {URL} requestUrl - URL object to check
 * @param {URL} baseUrl - Base URL object for comparison
 * @returns {boolean} - Whether the URL should be processed
 */
function shouldProcessUrl(requestUrl, baseUrl) {
  // Check if different hostname - early return
  if (requestUrl.hostname !== baseUrl.hostname) {
    return false;
  }

  const { pathname } = requestUrl;
  
  // Process if it's the same path as the base URL
  if (pathname === baseUrl.pathname) {
    return true;
  }
  
  // Process HTML files
  if (pathname.endsWith('.html')) {
    return true;
  }
  
  // Process JS files that are either from clientlibs or not minified
  if (pathname.endsWith('.js') && !pathname.includes('.rum/@adobe/helix-rum-js')) {
    return pathname.startsWith('/etc.clientlibs/') || !pathname.endsWith('.min.js');
  }
  
  // Process CSS files that are either from clientlibs or not minified
  if (pathname.endsWith('.css')) {
    return pathname.includes('/etc.clientlibs/') || !pathname.endsWith('.min.css');
  }
  
  return false;
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
  const baseUrl = new URL(pageUrl);
  const codeFiles = {};
  let cachedResources = 0;
  let failedResources = 0;

  // Filter resources that match our criteria
  const urlsToProcess = resources.filter(url => {
    try {
      const requestUrl = new URL(url);
      return shouldProcessUrl(requestUrl, baseUrl);
    } catch (error) {
      console.error(`Invalid URL: ${url}`, error);
      return false;
    }
  });

  const totalResources = urlsToProcess.length;
  const fetchOptions = createFetchOptions(deviceType, skipTlsCheck);

  // Process each resource sequentially to avoid overwhelming the server
  for (const url of urlsToProcess) {
    const result = await fetchResource(url, deviceType, fetchOptions, skipCache);
    
    if (result.fromCache) {
      cachedResources++;
    }
    
    if (result.failed) {
      failedResources++;
    } else if (result.content) {
      codeFiles[url] = result.content;
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
}