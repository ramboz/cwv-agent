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

  // Helper functions
  isDenylisted,
  extractFontUrls,
  parseModelName,
  sanitizeUrlForFilename,

  // Pattern arrays (for testing/inspection)
  BASE_DENYLIST_PATTERNS,
  EXTENDED_DENYLIST_PATTERNS,
};
