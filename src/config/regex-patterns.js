/**
 * Centralized regex pattern definitions for CWV Agent
 *
 * All regex patterns should be defined here with:
 * - Clear documentation of what they match
 * - Example test cases
 * - Proper escaping
 * - Performance considerations
 */

/**
 * Resource denylist patterns
 * Used to filter out third-party libraries and frameworks from code analysis
 *
 * Categories:
 * - CMS/Framework: granite, foundation, cq, wcm, core.*, drupal
 * - Libraries: jquery, lodash, moment, react.*, angular, vue.*, rxjs
 * - Visualization: three.*, videojs, chart.*, codemirror, ace, monaco
 * - Analytics: gtag, googletag, google-analytics, optimizely, segment, etc.
 * - Payment: stripe, paypal, braintree
 * - Social: facebook, twitter, linkedin, instagram, pinterest
 * - Maps: leaflet, mapbox, googlemaps
 * - Video: brightcove, youtube, vimeo
 * - Polyfills: polyfill, shim
 * - Editors: tinymce, ckeditor
 */

// Base patterns that should be excluded from all code analysis
const BASE_DENYLIST_PATTERNS = [
  // CMS & Frameworks
  'granite',
  'foundation',
  'cq',
  'core\\.',       // Escaped dot to match literal 'core.'
  'wcm',
  'drupal',

  // Popular libraries
  'jquery',
  'lodash',
  'moment',
  'minified',
  'bootstrap',
  'react\\.',      // Escaped dot
  'angular',
  'vue\\.',        // Escaped dot
  'rxjs',

  // Visualization & Media
  'three\\.',      // Escaped dot
  'videojs',
  'chart',
  'codemirror',
  'ace',
  'monaco',

  // Analytics & Tracking
  'gtag',
  'googletag',
  'google-analytics',
  'analytics\\.js', // Escaped dot
  'optimizely',
  'segment',
  'tealium',
  'adobe-dtm',
  'launch-',
  'amplitude',
  'mixpanel',
  'heap',
  'hotjar',
];

// Extended patterns for more comprehensive filtering
const EXTENDED_DENYLIST_PATTERNS = [
  ...BASE_DENYLIST_PATTERNS,

  // Additional libraries
  'tinymce',
  'ckeditor',

  // Maps
  'leaflet',
  'mapbox',
  'googlemaps',

  // Social
  'facebook',
  'twitter',
  'linkedin',
  'instagram',
  'pinterest',

  // Payment
  'stripe',
  'paypal',
  'braintree',

  // Polyfills
  'polyfill',
  'shim',

  // Video platforms
  'brightcove',
  'youtube',
  'vimeo',
];

/**
 * Create a denylist regex from patterns
 * @param {string[]} patterns - Array of pattern strings
 * @param {boolean} useWordBoundaries - Add word boundaries to prevent partial matches
 * @returns {RegExp} Compiled regex
 */
function createDenylistRegex(patterns, useWordBoundaries = false) {
  // Escape special regex characters except those already escaped
  const escapedPatterns = patterns.map(pattern => {
    // Don't double-escape already escaped sequences like '\.'
    return pattern.replace(/([.+?^${}()|[\]\\])/g, (match, p1) => {
      // If preceded by backslash, already escaped
      return p1;
    });
  });

  // Add word boundaries if requested
  const boundedPatterns = useWordBoundaries
    ? escapedPatterns.map(p => `\\b${p}\\b`)
    : escapedPatterns;

  // Join with alternation
  return new RegExp(`(${boundedPatterns.join('|')})`, 'i');
}

/**
 * Standard resource denylist regex
 * Used by most code analysis functions
 */
export const RESOURCE_DENYLIST_REGEX = createDenylistRegex(BASE_DENYLIST_PATTERNS);

/**
 * Extended resource denylist regex
 * Used for comprehensive filtering in code.js
 */
export const RESOURCE_DENYLIST_EXTENDED_REGEX = createDenylistRegex(EXTENDED_DENYLIST_PATTERNS);

/**
 * Font URL extraction patterns
 * Matches CSS @font-face src: url(...) declarations
 *
 * Handles:
 * - Single quotes: url('font.woff2')
 * - Double quotes: url("font.woff2")
 * - No quotes: url(font.woff2)
 * - Data URLs: url(data:font/woff2;base64,...)
 * - Multiple URLs: url('font1.woff2'), url('font2.woff2')
 *
 * Does NOT handle:
 * - Escaped quotes within URLs (edge case)
 * - Comments within url()
 */
export const FONT_URL_PATTERN = /url\(\s*['"]?([^'"()]+?)['"]?\s*\)/gi;

/**
 * Model name parsing pattern
 * Extracts model family, version, and variant
 *
 * Pattern: <family>-<major>.<minor>-<variant>
 * Examples:
 * - gemini-2.5-pro → {family: 'gemini', major: '2', minor: '5', variant: 'pro'}
 * - gpt-4 → {family: 'gpt', major: '4'}
 * - claude-3-sonnet → {family: 'claude', major: '3', variant: 'sonnet'}
 */
export const MODEL_NAME_PATTERN = /^([a-z]+)[-]?(\d+)\.?(\d+)?[-]?([a-z]+)?/i;

/**
 * CSS class name splitting pattern
 * Splits on whitespace (space, tab, newline, etc.)
 */
export const CSS_CLASS_SPLIT_PATTERN = /\s+/;

/**
 * Quote removal pattern
 * Removes single and double quotes from strings
 * Used for font-family value normalization
 */
export const QUOTE_REMOVAL_PATTERN = /['"]/g;

/**
 * URL path sanitization pattern
 * Removes non-alphanumeric characters except hyphens
 * Used for creating filesystem-safe names
 */
export const URL_SANITIZE_PATTERN = /[^A-Za-z0-9-]/g;

/**
 * Trailing dash removal pattern
 * Removes leading and trailing dashes
 */
export const TRIM_DASHES_PATTERN = /(^-+|-+$)/g;

/**
 * Alphanumeric-only pattern
 * Strips all non-alphanumeric characters
 * Fallback for aggressive sanitization
 */
export const ALPHANUMERIC_ONLY_PATTERN = /[^a-zA-Z0-9]/g;

/**
 * Helper: Check if a URL/path matches the denylist
 * @param {string} url - URL or path to check
 * @param {boolean} extended - Use extended denylist
 * @returns {boolean} True if matches denylist
 */
export function isDenylisted(url, extended = false) {
  const regex = extended ? RESOURCE_DENYLIST_EXTENDED_REGEX : RESOURCE_DENYLIST_REGEX;
  return regex.test(url);
}

/**
 * Helper: Extract all font URLs from CSS src value
 * @param {string} srcValue - CSS src property value
 * @returns {string[]} Array of font URLs
 *
 * @example
 * extractFontUrls("url('font1.woff2'), url('font2.woff2')")
 * // Returns: ['font1.woff2', 'font2.woff2']
 */
export function extractFontUrls(srcValue) {
  if (!srcValue || typeof srcValue !== 'string') return [];

  const urls = [];
  let match;

  // Reset regex lastIndex for global regex
  FONT_URL_PATTERN.lastIndex = 0;

  while ((match = FONT_URL_PATTERN.exec(srcValue)) !== null) {
    const url = match[1].trim();
    if (url) urls.push(url);
  }

  return urls;
}

/**
 * Helper: Parse model name into components
 * @param {string} modelName - Model name to parse
 * @returns {Object|null} Parsed components or null if no match
 *
 * @example
 * parseModelName('gemini-2.5-pro')
 * // Returns: {family: 'gemini', major: '2', minor: '5', variant: 'pro', full: 'gemini-2.5-pro'}
 */
export function parseModelName(modelName) {
  if (!modelName || typeof modelName !== 'string') return null;

  const match = modelName.toLowerCase().match(MODEL_NAME_PATTERN);
  if (!match) return null;

  return {
    family: match[1] || '',
    major: match[2] || '',
    minor: match[3] || '',
    variant: match[4] || '',
    full: modelName.toLowerCase(),
  };
}

/**
 * Helper: Sanitize URL for filesystem usage
 * @param {string} url - URL to sanitize
 * @returns {string} Filesystem-safe name
 *
 * @example
 * sanitizeUrlForFilename('https://example.com/path/file.js')
 * // Returns: 'example-com--path--file-js'
 */
export function sanitizeUrlForFilename(url) {
  if (!url || typeof url !== 'string') return '';

  return url
    .replace('https://', '')
    .replace('http://', '')
    .replace(URL_SANITIZE_PATTERN, '-')
    .replace(/\//g, '--')
    .replace(TRIM_DASHES_PATTERN, '');
}

/**
 * AEM Detection Patterns
 * Used to identify Adobe Experience Manager architecture type
 *
 * Categories:
 * - SPA: React/Angular/Vue single-page applications
 * - EDS: Edge Delivery Services (Franklin)
 * - CS: AEM Cloud Service
 * - AMS: AEM Managed Services
 * - HEADLESS: AEM Headless CMS
 */
export const AEM_DETECTION = {
  SPA: [
    /cq:pagemodel_root_url/i,
    /<div[^>]+id=["']spa-root["']/i,
    /<div[^>]+id=["']root["'][^>]*><\/div>/i,
    /clientlib-react/i,
    /clientlib-angular/i,
    /clientlib-vue/i,
  ],
  EDS: [
    /lib-franklin\.js/i,
    /aem\.js/i,
    /data-block-status/i,
    /scripts\.js/i,
    /<div class="[^"]*block[^"]*"[^>]*>/i,
    /data-routing="[^"]*eds=([^,"]*)/i,
    /"dataRouting":"[^"]*eds=([^,"]*)/i,
  ],
  CS: [
    /<div class="[^"]*cmp-[^"]*"[^>]*>/i,
    /\/etc\.clientlibs\/[^"']+\.lc-[a-f0-9]+-lc\.min\.(js|css)/i,
    /\/libs\.clientlibs\//i,
    /data-cmp-/i,
    /data-sly-/i,
    /content\/experience-fragments\//i,
    /data-cq-/i,
    /data-routing="[^"]*cs=([^,"]*)/i,
    /"dataRouting":"[^"]*cs=([^,"]*)/i,
  ],
  AMS: [
    /\/etc\/clientlibs\//i,
    /\/etc\/designs\//i,
    /\/etc\.clientlibs\/[^"']+\.min\.[a-f0-9]{32}\.(js|css)/i,
    /foundation-/i,
    /cq:template/i,
    /cq-commons/i,
    /parsys/i,
    /\/CQ\//i,
    /\/apps\//i,
    /data-routing="[^"]*ams=([^,"]*)/i,
    /"dataRouting":"[^"]*ams=([^,"]*)/i,
  ],
  HEADLESS: [
    /aem-headless/i,
    /\/content\/dam\//i,
  ],
};

/**
 * CSS Parsing Patterns
 * Used for extracting and analyzing CSS rules
 */
export const CSS_PARSING = {
  /** Remove CSS comments */
  COMMENT_REMOVAL: /\/\*[\s\S]*?\*\//g,

  /** Normalize whitespace to single space */
  WHITESPACE_NORMALIZE: /\s+/g,

  /** Extract CSS rules (handles nested braces) */
  RULE_EXTRACTION: /([^{}]+)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
};

/**
 * URL Normalization Patterns
 * Used for URL comparison, file naming, and cache keys
 */
export const URL_PATTERNS = {
  /** Replace forward slashes */
  SLASH_TO_DASH: /\//g,

  /** Trim leading/trailing dashes */
  TRIM_DASHES: /(^-+|-+$)/g,

  /** Remove trailing slash */
  TRAILING_SLASH: /\/$/,

  /** Match www prefix for removal */
  WWW_REMOVAL: /(:\/\/)www\./,

  /** Extract URL from url() CSS function */
  URL_EXTRACTION: /url\(\s*['"]?([^'"()]+?)['"]?\s*\)/gi,
};

/**
 * File Patterns
 * Used for file type detection and extraction
 */
export const FILE_PATTERNS = {
  /** Extract filename with extension */
  EXTENSION_EXTRACT: /([a-zA-Z0-9_-]+\.(js|css|woff2?|jpg|png|webp|svg|gif|avif))/,

  /** List of supported file extensions */
  SUPPORTED_EXTENSIONS: ['js', 'css', 'woff', 'woff2', 'jpg', 'png', 'webp', 'svg', 'gif', 'avif'],
};

/**
 * LLM Output Patterns
 * Used for parsing LLM-generated responses
 */
export const LLM_PATTERNS = {
  /** Extract JSON blocks from markdown code fences */
  JSON_BLOCK: /```json\s*(\{[\s\S]*?\})\s*```/g,
};

/**
 * Helper: Count pattern matches in text
 * @param {string} text - Text to search
 * @param {RegExp[]} patterns - Array of regex patterns
 * @returns {number} Number of patterns that matched
 */
function countMatches(text, patterns) {
  if (!text || !patterns) return 0;
  return patterns.reduce((count, pattern) => {
    return count + (pattern.test(text) ? 1 : 0);
  }, 0);
}

/**
 * Helper: Detect AEM architecture type
 * @param {string} html - HTML source
 * @param {Object} headers - HTTP headers (optional)
 * @returns {string|null} Architecture type ('cs-spa', 'eds', 'cs', 'ams', 'aem-headless') or null
 *
 * Priority order:
 * 1. CS-SPA (if both CS and SPA patterns match)
 * 2. EDS (if EDS patterns match)
 * 3. CS (if CS patterns match)
 * 4. AMS (if AMS patterns match)
 * 5. Headless (if headless patterns match)
 */
export function detectAemArchitecture(html, headers = {}) {
  if (!html || typeof html !== 'string') return null;

  const results = {
    spa: countMatches(html, AEM_DETECTION.SPA),
    eds: countMatches(html, AEM_DETECTION.EDS),
    cs: countMatches(html, AEM_DETECTION.CS),
    ams: countMatches(html, AEM_DETECTION.AMS),
    headless: countMatches(html, AEM_DETECTION.HEADLESS),
  };

  // Priority: CS-SPA > EDS > CS > AMS > Headless
  if (results.cs > 0 && results.spa > 0) return 'cs-spa';
  if (results.eds > 1) return 'eds'; // Require 2+ EDS patterns
  if (results.cs > 1) return 'cs';   // Require 2+ CS patterns
  if (results.ams > 1) return 'ams'; // Require 2+ AMS patterns
  if (results.headless > 0) return 'aem-headless';

  return null;
}

/**
 * Helper: Normalize URL for comparison
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 *
 * @example
 * normalizeUrl('https://www.example.com/')
 * // Returns: 'https://example.com'
 */
export function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';

  let normalized = url.toString().replace(URL_PATTERNS.TRAILING_SLASH, '');
  normalized = normalized.replace(URL_PATTERNS.WWW_REMOVAL, '$1');
  return normalized;
}

/**
 * Helper: Convert URL pathname to filename
 * @param {string} pathname - URL pathname
 * @returns {string} Filesystem-safe filename
 *
 * @example
 * urlToFilename('/products/photoshop.html')
 * // Returns: 'products--photoshop-html'
 */
export function urlToFilename(pathname) {
  if (!pathname || typeof pathname !== 'string') return '';

  return pathname
    .replace(URL_PATTERNS.SLASH_TO_DASH, '--')
    .replace(/^--/, '') // Remove leading dashes
    .replace(URL_PATTERNS.TRIM_DASHES, '');
}

/**
 * Helper: Remove CSS comments and normalize whitespace
 * @param {string} cssText - CSS text
 * @returns {string} Cleaned CSS
 */
export function cleanCssComments(cssText) {
  if (!cssText || typeof cssText !== 'string') return '';

  return cssText
    .replace(CSS_PARSING.COMMENT_REMOVAL, '')
    .replace(CSS_PARSING.WHITESPACE_NORMALIZE, ' ');
}

/**
 * Helper: Extract CSS rules from text
 * @param {string} cssText - CSS text
 * @returns {Array<{selector: string, body: string}>} Parsed CSS rules
 */
export function extractCssRules(cssText) {
  if (!cssText || typeof cssText !== 'string') return [];

  const cleaned = cleanCssComments(cssText);
  const rules = [];
  let match;

  // Reset regex lastIndex for global regex
  CSS_PARSING.RULE_EXTRACTION.lastIndex = 0;

  while ((match = CSS_PARSING.RULE_EXTRACTION.exec(cleaned)) !== null) {
    rules.push({
      selector: match[1].trim(),
      body: match[2].trim()
    });
  }

  return rules;
}

/**
 * Helper: Extract filename from resource reference
 * @param {string} reference - Resource reference (URL, path, etc.)
 * @returns {string|null} Extracted filename or null
 *
 * @example
 * extractFileName('https://example.com/assets/main.js?v=123')
 * // Returns: 'main.js'
 */
export function extractFileName(reference) {
  if (!reference || typeof reference !== 'string') return null;

  const match = reference.match(FILE_PATTERNS.EXTENSION_EXTRACT);
  return match ? match[1] : null;
}

// Export all patterns and helpers
export default {
  // Regex patterns
  RESOURCE_DENYLIST_REGEX,
  RESOURCE_DENYLIST_EXTENDED_REGEX,
  FONT_URL_PATTERN,
  MODEL_NAME_PATTERN,
  CSS_CLASS_SPLIT_PATTERN,
  QUOTE_REMOVAL_PATTERN,
  URL_SANITIZE_PATTERN,
  TRIM_DASHES_PATTERN,
  ALPHANUMERIC_ONLY_PATTERN,

  // New pattern categories
  AEM_DETECTION,
  CSS_PARSING,
  URL_PATTERNS,
  FILE_PATTERNS,
  LLM_PATTERNS,

  // Helper functions
  isDenylisted,
  extractFontUrls,
  parseModelName,
  sanitizeUrlForFilename,
  detectAemArchitecture,
  normalizeUrl,
  urlToFilename,
  cleanCssComments,
  extractCssRules,
  extractFileName,

  // Pattern arrays (for testing/inspection)
  BASE_DENYLIST_PATTERNS,
  EXTENDED_DENYLIST_PATTERNS,
};
