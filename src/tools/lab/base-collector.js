/**
 * Base Collector Class
 *
 * Provides common functionality for all lab data collectors (HAR, Coverage, Performance)
 * to eliminate 60-70% duplication across collector implementations.
 *
 * Common patterns extracted:
 * 1. Data validation and null checks
 * 2. Markdown summary generation
 * 3. Statistics calculation
 * 4. Entry formatting helpers
 * 5. Threshold-based filtering
 */

export class BaseCollector {
  constructor(deviceType = 'mobile') {
    this.deviceType = deviceType;
  }

  /**
   * Validate data before processing
   * @param {*} data - Data to validate
   * @param {string} dataType - Type of data (for error message)
   * @returns {{valid: boolean, message?: string}}
   */
  validateData(data, dataType = 'data') {
    if (!data) {
      return { valid: false, message: `No ${dataType} available.` };
    }
    return { valid: true };
  }

  /**
   * Validate and return default message if invalid
   * @param {*} data - Data to validate
   * @param {string} dataType - Type of data
   * @param {string} defaultMessage - Message to return if invalid
   * @returns {string|null} - Error message or null if valid
   */
  validateOrDefault(data, dataType, defaultMessage) {
    const validation = this.validateData(data, dataType);
    if (!validation.valid) {
      return defaultMessage || validation.message;
    }
    return null;
  }

  /**
   * Build markdown section with title and content
   * @param {string} title - Section title
   * @param {string} content - Section content
   * @param {number} level - Heading level (1-6)
   * @returns {string} Formatted markdown section
   */
  buildSection(title, content, level = 2) {
    const heading = '#'.repeat(level);
    return `${heading} ${title}\n\n${content}\n\n`;
  }

  /**
   * Build markdown list from array
   * @param {Array<string>} items - List items
   * @param {boolean} ordered - Use ordered list (numbered)
   * @returns {string} Formatted markdown list
   */
  buildList(items, ordered = false) {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }
    return items
      .map((item, index) => {
        const prefix = ordered ? `${index + 1}.` : '*';
        return `${prefix} ${item}`;
      })
      .join('\n') + '\n';
  }

  /**
   * Build markdown table from data
   * @param {Array<Object>} rows - Table rows
   * @param {Array<string>} columns - Column names
   * @returns {string} Formatted markdown table
   */
  buildTable(rows, columns) {
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns) || columns.length === 0) {
      return '';
    }

    const header = `| ${columns.join(' | ')} |`;
    const separator = `| ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map(row => {
      const cells = columns.map(col => row[col] || '');
      return `| ${cells.join(' | ')} |`;
    }).join('\n');

    return `${header}\n${separator}\n${body}\n\n`;
  }

  /**
   * Format a single entry as a markdown subsection
   * @param {string} title - Entry title
   * @param {Object} data - Entry data (key-value pairs)
   * @param {number} level - Heading level
   * @returns {string} Formatted markdown entry
   */
  formatEntry(title, data, level = 3) {
    if (!data || typeof data !== 'object') {
      return '';
    }

    const heading = '#'.repeat(level);
    let output = `${heading} ${title}\n\n`;

    Object.entries(data).forEach(([key, value]) => {
      // Skip private/internal fields
      if (key.startsWith('_')) return;

      const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
      output += `*   **${label}:** ${value}\n`;
    });

    output += '\n';
    return output;
  }

  /**
   * Filter items by threshold
   * @param {Array} items - Items to filter
   * @param {Function} getValue - Function to extract value from item
   * @param {number} threshold - Minimum value threshold
   * @param {boolean} descending - Sort descending (default true)
   * @returns {Array} Filtered and sorted items
   */
  filterByThreshold(items, getValue, threshold, descending = true) {
    if (!Array.isArray(items)) return [];

    const filtered = items.filter(item => getValue(item) > threshold);
    return filtered.sort((a, b) => {
      const diff = getValue(b) - getValue(a);
      return descending ? diff : -diff;
    });
  }

  /**
   * Calculate percentage
   * @param {number} part - Part value
   * @param {number} total - Total value
   * @param {number} decimals - Number of decimal places
   * @returns {number} Percentage value
   */
  percentage(part, total, decimals = 0) {
    if (total === 0) return 0;
    return Math.round((part / total) * 100 * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }

  /**
   * Format bytes to human-readable size
   * @param {number} bytes - Bytes value
   * @param {number} decimals - Number of decimal places
   * @returns {string} Formatted size string
   */
  formatBytes(bytes, decimals = 0) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(parseFloat((bytes / Math.pow(k, i)).toFixed(dm))) + ' ' + sizes[i];
  }

  /**
   * Format milliseconds to human-readable duration
   * @param {number} ms - Milliseconds
   * @param {number} decimals - Number of decimal places
   * @returns {string} Formatted duration
   */
  formatDuration(ms, decimals = 0) {
    if (ms < 1000) {
      return `${Math.round(ms * Math.pow(10, decimals)) / Math.pow(10, decimals)}ms`;
    }
    const seconds = ms / 1000;
    return `${Math.round(seconds * Math.pow(10, decimals)) / Math.pow(10, decimals)}s`;
  }

  /**
   * Truncate string with ellipsis
   * @param {string} str - String to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string} Truncated string
   */
  truncate(str, maxLength = 80) {
    if (!str || str.length <= maxLength) return str || '';
    return str.substring(0, maxLength) + '...';
  }

  /**
   * Group items by key
   * @param {Array} items - Items to group
   * @param {Function} getKey - Function to extract grouping key
   * @returns {Map} Map of key -> items array
   */
  groupBy(items, getKey) {
    if (!Array.isArray(items)) return new Map();

    const groups = new Map();
    items.forEach(item => {
      const key = getKey(item);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    });
    return groups;
  }

  /**
   * Aggregate statistics from items
   * @param {Array} items - Items to aggregate
   * @param {Object} config - Aggregation configuration
   *   - {Function} getValue - Extract value from item
   *   - {string} type - Aggregation type: 'sum', 'avg', 'min', 'max', 'count'
   * @returns {number} Aggregated value
   */
  aggregate(items, { getValue, type = 'sum' }) {
    if (!Array.isArray(items) || items.length === 0) return 0;

    const values = items.map(getValue).filter(v => typeof v === 'number' && !isNaN(v));
    if (values.length === 0) return 0;

    switch (type) {
      case 'sum':
        return values.reduce((sum, val) => sum + val, 0);
      case 'avg':
        return values.reduce((sum, val) => sum + val, 0) / values.length;
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'count':
        return values.length;
      default:
        return 0;
    }
  }

  /**
   * Build recommendations list from issues
   * @param {Array<{condition: boolean, message: string, priority?: string}>} issues - Issues to check
   * @returns {string} Formatted recommendations markdown
   */
  buildRecommendations(issues) {
    if (!Array.isArray(issues)) return '';

    const validIssues = issues.filter(issue => issue.condition);
    if (validIssues.length === 0) {
      return '**Good**: No optimization issues detected\n';
    }

    const recommendations = validIssues.map(issue => {
      const prefix = issue.priority ? `**${issue.priority}**:` : '**Optimize**:';
      return `${prefix} ${issue.message}`;
    });

    return this.buildList(recommendations) + '\n';
  }

  /**
   * Get device-specific threshold
   * @param {Object} thresholds - Threshold object with mobile/desktop keys
   * @returns {number} Threshold value for current device type
   */
  getThreshold(thresholds) {
    return thresholds[this.deviceType] || thresholds.mobile || thresholds.default || 0;
  }
}

/**
 * Lab Data Collector Base Class
 *
 * Extends BaseCollector with lab-specific patterns:
 * - Setup/teardown lifecycle
 * - Page interaction
 * - Data collection and summarization
 */
export class LabDataCollector extends BaseCollector {
  constructor(deviceType = 'mobile') {
    super(deviceType);
    this.collectedData = null;
  }

  /**
   * Setup collector before page load
   * @param {Page} page - Puppeteer page instance
   * @returns {Promise<*>} Setup result (e.g., HAR instance, coverage handles)
   */
  async setup(page) {
    throw new Error('setup() must be implemented by subclass');
  }

  /**
   * Collect data after page interaction
   * @param {Page} page - Puppeteer page instance
   * @param {*} setupResult - Result from setup() call
   * @returns {Promise<*>} Collected raw data
   */
  async collect(page, setupResult) {
    throw new Error('collect() must be implemented by subclass');
  }

  /**
   * Summarize collected data into markdown
   * @param {*} data - Raw collected data
   * @param {Object} options - Summarization options (e.g., thirdPartyAnalysis, clsAttribution)
   * @returns {string} Markdown summary
   */
  summarize(data, options = {}) {
    throw new Error('summarize() must be implemented by subclass');
  }

  /**
   * Full workflow: setup -> collect -> summarize
   * @param {Page} page - Puppeteer page instance
   * @param {Object} options - Options for summarization
   * @returns {Promise<{data: *, summary: string}>} Collected data and summary
   */
  async run(page, options = {}) {
    const setupResult = await this.setup(page);
    const data = await this.collect(page, setupResult);
    this.collectedData = data;
    const summary = this.summarize(data, options);
    return { data, summary };
  }
}
