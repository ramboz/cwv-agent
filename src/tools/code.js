import { cacheResults, getCachedResults, AGENT_HTTP_HEADERS } from '../utils.js';
import { Agent } from 'undici';

/**
 * Determines if a URL should be processed based on filtering rules
 * @param {URL} requestUrl - URL object to check
 * @param {URL} baseUrl - Base URL object for comparison
 * @returns {boolean} - Whether the URL should be processed
 */
function shouldProcessUrl(requestUrl, baseUrl) {
  const { hostname, pathname } = baseUrl;

  if (requestUrl.hostname !== hostname) {
    return false;
  }

  return (
    requestUrl.pathname === pathname ||
    requestUrl.pathname.endsWith('.html') ||
    (requestUrl.pathname.endsWith('.js') &&
      (requestUrl.pathname.startsWith('/etc.clientlibs/') || !requestUrl.pathname.endsWith('.min.js'))) ||
    (requestUrl.pathname.endsWith('.css') &&
      (requestUrl.pathname.includes('/etc.clientlibs/') || !requestUrl.pathname.endsWith('.min.css')))
  );
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
  let totalResources = 0;
  let cachedResources = 0;
  let failedResources = 0;

  const fetchOptions = {
    headers: {
      ...AGENT_HTTP_HEADERS,
      'Accept': 'text/html,application/xhtml+xml,application/xml,text/css,application/javascript,text/javascript;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': '',
    },
    // Optional TLS validation bypass
    dispatcher: skipTlsCheck ? new Agent({
      connect: { rejectUnauthorized: false }
    }) : undefined
  };

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

  totalResources = urlsToProcess.length;

  // Process each resource sequentially to avoid overwhelming the server
  for (const url of urlsToProcess) {
    try {
      // Check cache first
      const cachedContent = getCachedResults(url, deviceType, 'code');
      if (cachedContent && !skipCache) {
        codeFiles[url] = cachedContent;
        cachedResources++;
        continue;
      }

      // Fetch the resource
      let response;
      if (url.includes('.min.')) {
        const nonMinifiedUrl = url.replace('.min.', '.');
        response = await fetch(nonMinifiedUrl, fetchOptions);
      }

      if (!response || !response.ok) {
        response = await fetch(url, fetchOptions);
      }

      if (!response.ok) {
        console.warn(`Failed to fetch resource: ${url}. Error: ${response.status} - ${response.statusText}`);
        failedResources++;
      }

      const body = await response.text();

      // Check for access denied patterns
      if (body.includes('Access Denied') || body.includes('403 Forbidden')) {
        console.warn(`Access denied for resource: ${url}`);
        failedResources++;
      } else {
        codeFiles[url] = body;
        cacheResults(url, deviceType, 'code', body);
      }
    } catch (error) {
      console.error(`Failed to fetch ${url}:`, error.message);
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
}