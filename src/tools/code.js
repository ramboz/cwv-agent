import { cacheResults, getCachedResults, AGENT_HTTP_HEADERS } from '../utils.js';
import { Agent } from 'undici';
import * as sourceMap from 'source-map';

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
    requestUrl.pathname.endsWith('.js') ||
    requestUrl.pathname.endsWith('.css')
  );
}

/**
 * Checks if content appears to be minified
 * @param {string} content - The file content to check
 * @param {string} fileType - The type of file (js, css)
 * @returns {boolean} - Whether the content appears to be minified
 */
function isMinified(content, fileType) {
  // Skip check for very small files
  if (content.length < 1000) return false;
  // Check for common minification patterns
  const lines = content.split('\n');
  const avgLineLength = content.length / lines.length;
  // Minified files typically have very long lines
  if (avgLineLength > 500) return true;
  // For JS files, check for specific patterns
  if (fileType === 'js') {
    // Look for typical minification patterns like reduced whitespace and single-letter variables
    return /[a-z]\.[a-z]\(/.test(content)
      && (/function\([a-z],[a-z],[a-z]\)/.test(content)
        || /\){return/.test(content)
        || /\},function\(/.test(content));
  }
  // For CSS files
  if (fileType === 'css') {
    // Minified CSS often has few newlines and many semicolons
    return (lines.length < 5 && content.includes('{') && content.includes('}')) ||
           content.includes('}.') || content.includes('};');
  }
  return false;
}

/**
 * Extracts source map URL from content
 * @param {string} content - The file content
 * @returns {string|null} - Source map URL if found, null otherwise
 */
function extractSourceMapUrl(content) {
  // Look for sourceMappingURL comment in JS or CSS files
  const sourceMappingMatch = content.match(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/)
    || content.match(/\/\*[#@]\s*sourceMappingURL=([^\s]+)\s*\*\//);
  if (sourceMappingMatch && sourceMappingMatch[1]) {
    return sourceMappingMatch[1];
  }
  return null;
}

/**
 * Resolves a source map URL to a fully qualified URL
 * @param {string} sourceMapUrl - The source map URL from the file
 * @param {string} fileUrl - The URL of the original file
 * @returns {string} - Fully resolved source map URL
 */
function resolveSourceMapUrl(sourceMapUrl, fileUrl) {
  if (sourceMapUrl.startsWith('http://') || sourceMapUrl.startsWith('https://')) {
    return sourceMapUrl;
  }
  // Handle data: URIs
  if (sourceMapUrl.startsWith('data:')) {
    return sourceMapUrl;
  }
  // Handle relative paths
  const fileUrlObj = new URL(fileUrl);
  const pathParts = fileUrlObj.pathname.split('/');
  pathParts.pop(); // Remove the filename
  if (sourceMapUrl.startsWith('/')) {
    // Absolute path from domain root
    return `${fileUrlObj.origin}${sourceMapUrl}`;
  } else {
    // Relative path
    return `${fileUrlObj.origin}${pathParts.join('/')}/${sourceMapUrl}`;
  }
}

/**
 * Extracts source content from data URI
 * @param {string} dataUri - Data URI containing the source map
 * @returns {string|null} - Extracted content or null if invalid
 */
function extractFromDataUri(dataUri) {
  try {
    const match = dataUri.match(/^data:[^;]+;base64,(.*)$/);
    if (match && match[1]) {
      const base64Content = match[1];
      return Buffer.from(base64Content, 'base64').toString('utf-8');
    }
  } catch (error) {
    console.error('Failed to extract source map:', error);
  }
  return null;
}

/**
 * Attempts to fetch and process a non-minified version of a URL
 * @param {string} url - Original (potentially minified) URL
 * @param {Object} fetchOptions - Fetch options to use
 * @returns {Promise<{body: string|null, ok: boolean}>} - The response body and status
 */
async function tryNonMinifiedVersion(url, fetchOptions) {
  try {
    // Convert .min.js to .js or .min.css to .css
    const nonMinUrl = url.replace(/\.min\.(js|css)/, '.$1');
    // If URL is already non-minified, don't try again
    if (nonMinUrl === url) {
      return { body: null, ok: false };
    }

    const response = await fetch(nonMinUrl, fetchOptions);

    if (!response.ok) {
      return { body: null, ok: false };
    }

    const body = await response.text();
    return { body, ok: true };
  } catch (error) {
    return { body: null, ok: false };
  }
}

/**
 * Processes a source map to extract original source content
 * @param {string} mapContent - Source map content (JSON)
 * @param {string} fileUrl - URL of the original file for resolving paths
 * @returns {Promise<string|null>} - Unminified source content or null if failed
 */
async function processSourceMap(mapContent, fileUrl) {
  try {
    const consumer = await new sourceMap.SourceMapConsumer(mapContent);
    // Get the original sources
    const sources = consumer.sources;
    let reconstructedSource = '';
    for (const source of sources) {
      const content = consumer.sourceContentFor(source, true);
      if (content) {
        // Add a comment to indicate the source file
        reconstructedSource += `\n// Source: ${source}\n${content}\n`;
      }
    }
    consumer.destroy();
    if (reconstructedSource) {
      return reconstructedSource;
    }
    return null;
  } catch (error) {
    console.error('Error processing source map:', error);
    return null;
  }
}

/**
 * Fetches and processes a source map from a URL
 * @param {string} sourceMapUrl - URL of the source map
 * @param {string} fileUrl - URL of the original file
 * @param {Object} fetchOptions - Fetch options to use
 * @returns {Promise<string|null>} - Unminified content or null if failed
 */
async function fetchAndProcessSourceMap(sourceMapUrl, fileUrl, fetchOptions) {
  try {
    let mapContent;
    // Handle data: URIs
    if (sourceMapUrl.startsWith('data:')) {
      mapContent = extractFromDataUri(sourceMapUrl);
      if (!mapContent) {
        return null;
      }
    } else {
      // Resolve relative URLs
      const fullSourceMapUrl = resolveSourceMapUrl(sourceMapUrl, fileUrl);
      const response = await fetch(fullSourceMapUrl, fetchOptions);
      if (!response.ok) {
        console.warn(`Failed to fetch source map: ${fullSourceMapUrl}. Error: ${response.status} - ${response.statusText}`);
        return null;
      }
      mapContent = await response.text();
    }
    // Process the source map to get original source
    return await processSourceMap(mapContent, fileUrl);
  } catch (error) {
    console.error(`Failed to process source map: ${error.message}`);
    return null;
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
  let totalResources = 0;
  let cachedResources = 0;
  let failedResources = 0;
  let skippedMinifiedResources = 0;
  let unminifiedResources = 0;

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

      // Determine file type
      const fileType = url.endsWith('.js')
        ? 'js'
        : url.endsWith('.css') ? 'css' : 'html';

      let body = null;
      // Try non-minified version first if applicable
      if (url.includes('.min.')) {
        const nonMinResult = await tryNonMinifiedVersion(url, fetchOptions);
        if (nonMinResult.ok) {
          body = nonMinResult.body;
        }
      }
      // If we don't have content yet, fetch the original URL
      if (!body) {
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          console.warn(`Failed to fetch resource: ${url}. Error: ${response.status} - ${response.statusText}`);
          failedResources++;
          continue;
        }
        body = await response.text();
        // Check for access denied patterns
        if (body.includes('Access Denied') || body.includes('403 Forbidden')) {
          console.warn(`Access denied for resource: ${url}`);
          failedResources++;
          continue;
        }
        // Only check for minification if it's JS or CSS
        if (!['js', 'css'].includes(fileType) || !isMinified(body, fileType)) {
          // Not minified or not a type we check for minification
          codeFiles[url] = body;
          cacheResults(url, deviceType, 'code', body);
          continue;
        }
        // Extract source map URL if available
        const sourceMapUrl = extractSourceMapUrl(body);
        if (!sourceMapUrl) {
          console.warn(`Skipping minified file with no source map: ${url}`);
          skippedMinifiedResources++;
          continue;
        }
        // Try to fetch and process the source map
        const unminifiedContent = await fetchAndProcessSourceMap(sourceMapUrl, url, fetchOptions);
        if (!unminifiedContent) {
          console.warn(`Skipping minified file with invalid source map: ${url}`);
          skippedMinifiedResources++;
          continue;
        }
        // Successfully unminified
        body = unminifiedContent;
        unminifiedResources++;
      }
      // Store the content and cache it
      codeFiles[url] = body;
      cacheResults(url, deviceType, 'code', body);
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
      skippedMinified: skippedMinifiedResources,
      unminified: unminifiedResources,
      successful: totalResources - failedResources - skippedMinifiedResources
    }
  };
}