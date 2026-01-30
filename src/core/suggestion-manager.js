import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { SpaceCatClient } from './spacecat-client.js';
import { normalizePath } from '../utils.js';
import { URL_PATTERNS } from '../config/regex-patterns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class CWVSuggestionManager {
  constructor(options = {}) {
    const isMCPMode = options.isMCPMode || false;
    this.spaceCatClient = new SpaceCatClient({ isMCPMode });
    this.reset();
    
    // Correctly resolve temp directory within project's .cache
    this.tempDir = normalizePath(path.join('.cache', 'temp-edits'));
    
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Cleans up resources, particularly the SpaceCat client connections.
   */
  cleanup() {
    if (this.spaceCatClient) {
      this.spaceCatClient.cleanup();
    }
  }

  reset() {
    this.suggestions = [];
    this.mergedSuggestions = { LCP: [], CLS: [], INP: [], TTFB: [] };
    this.categoryApprovalStatus = { LCP: 'pending', CLS: 'pending', INP: 'pending', TTFB: 'pending' };
    this.currentUrl = null;
    this.currentFiles = [];
    this.deviceTypes = [];
  }

  /**
   * Normalizes URLs for comparison using URL.pathname
   * Handles edge cases like: https://www.metrobyt-mobile.com/ vs https://www.metrobyt-mobile.com
   * @param {String} url - URL to normalize
   * @return {String} Normalized URL for comparison
   */
  normalizeUrlForComparison(url) {
    try {
      const urlObj = new URL(url);
      // Use pathname which normalizes root to "/" in both cases
      return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}${urlObj.hash}`;
    } catch (error) {
      console.warn('normalizeUrlForComparison: Invalid URL format, returning original', url);
      return url;
    }
  }

  urlToFilePattern(url) {
    try {
      const urlObj = new URL(url);
      const { hostname, pathname } = urlObj;
      const fileBase = hostname.replace(/\./g, '-');
      let pathPart = pathname.replace(/^\//, '').replace(URL_PATTERNS.SLASH_TO_DASH, '-');
      if (pathPart) {
        pathPart = '-' + pathPart;
      }
      return `${fileBase}${pathPart}`;
    } catch (error) {
      throw new Error(`Invalid URL format: ${url}`);
    }
  }

  loadSuggestionsByUrl(url, cacheDir = './.cache') {
    this.reset();
    const filePattern = this.urlToFilePattern(url);
    const resolvedCacheDir = normalizePath(cacheDir);

    const mobileFile = path.join(resolvedCacheDir, `${filePattern}.mobile.suggestions.gemini25pro.json`);
    const desktopFile = path.join(resolvedCacheDir, `${filePattern}.desktop.suggestions.gemini25pro.json`);
    
    const mobileExists = fs.existsSync(mobileFile);
    const desktopExists = fs.existsSync(desktopFile);

    if (!mobileExists && !desktopExists) {
      throw new Error(`No suggestion files found for URL: ${url}, checked "${mobileFile}" and "${desktopFile}"`);
    }
    
    const result = this.loadMultiDeviceSuggestions(
        mobileExists ? mobileFile : desktopFile, 
        mobileExists && desktopExists ? desktopFile : null
    );

    this.currentUrl = url;
    result.url = url; // Ensure URL is set on the final result
    return result;
  }

  loadMultiDeviceSuggestions(mobileFilePath, desktopFilePath = null) {
    const mobileResult = this.loadSingleDeviceFile(mobileFilePath, 'mobile');
    const desktopResult = desktopFilePath ? this.loadSingleDeviceFile(desktopFilePath, 'desktop') : null;

    if (desktopResult && mobileResult.url !== desktopResult.url) {
      throw new Error(`URL mismatch: Mobile (${mobileResult.url}) vs Desktop (${desktopResult.url})`);
    }

    this.mergeSuggestionsByCategory(mobileResult.suggestions, desktopResult?.suggestions);
    
    this.currentFiles = [mobileFilePath, desktopFilePath].filter(Boolean);
    this.deviceTypes = ['mobile', desktopFilePath ? 'desktop' : null].filter(Boolean);
    this.currentUrl = mobileResult.url;

    return {
      success: true,
      loadedDevices: this.deviceTypes,
      totalSuggestions: Object.values(this.mergedSuggestions).reduce((sum, arr) => sum + arr.length, 0),
      mergedSuggestions: this.mergedSuggestions,
      summary: this.generateCategorySummary(),
    };
  }
  
  loadSingleDeviceFile(filePath, expectedDevice) {
    const normalizedFilePath = normalizePath(filePath);
    if (!fs.existsSync(normalizedFilePath)) {
      throw new Error(`File not found: ${normalizedFilePath}`);
    }
    const content = fs.readFileSync(normalizedFilePath, 'utf8');
    const data = JSON.parse(content);
    if (!data.suggestions || !Array.isArray(data.suggestions)) {
      throw new Error('Invalid suggestions file format');
    }
    return {
      success: true,
      url: data.url,
      deviceType: data.deviceType,
      suggestions: data.suggestions,
    };
  }

  mergeSuggestionsByCategory(mobileSuggestions, desktopSuggestions = []) {
    this.mergedSuggestions = { LCP: [], CLS: [], INP: [], TTFB: [] };
    const processedTitles = new Set();
    const desktopByTitle = new Map(desktopSuggestions.map(s => [this.normalizeSuggestionTitle(s.title), s]));

    mobileSuggestions.forEach(mobileSuggestion => {
      const titleKey = this.normalizeSuggestionTitle(mobileSuggestion.title);
      const desktopMatch = desktopByTitle.get(titleKey);
      
      if (desktopMatch) {
        this.addToMergedCategory(this.mergeTwoSuggestions(mobileSuggestion, desktopMatch));
      } else {
        this.addToMergedCategory({ ...mobileSuggestion, devices: ['mobile'], mobile_only: true, desktop_only: false, both_devices: false });
      }
      processedTitles.add(titleKey);
    });

    desktopSuggestions.forEach(desktopSuggestion => {
      const titleKey = this.normalizeSuggestionTitle(desktopSuggestion.title);
      if (!processedTitles.has(titleKey)) {
        this.addToMergedCategory({ ...desktopSuggestion, devices: ['desktop'], mobile_only: false, desktop_only: true, both_devices: false });
      }
    });
  }

  normalizeSuggestionTitle(title) {
    return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  mergeTwoSuggestions(mobileSuggestion, desktopSuggestion) {
    return {
      ...mobileSuggestion,
      priority: this.getHigherPriority(mobileSuggestion.priority, desktopSuggestion.priority),
      implementation: this.mergeImplementationDetails(mobileSuggestion, desktopSuggestion),
      devices: ['mobile', 'desktop'],
      mobile_only: false,
      desktop_only: false,
      both_devices: true,
    };
  }

  addToMergedCategory(suggestion) {
    const category = suggestion.metric;
    if (this.mergedSuggestions[category]) {
      this.mergedSuggestions[category].push(suggestion);
    }
  }

  getHigherPriority(priority1, priority2) {
    const priorityOrder = { 'Low': 1, 'Medium': 2, 'High': 3 };
    return (priorityOrder[priority1] || 0) >= (priorityOrder[priority2] || 0) ? priority1 : priority2;
  }

  mergeImplementationDetails(mobileSuggestion, desktopSuggestion) {
    if (mobileSuggestion.implementation === desktopSuggestion.implementation) {
      return mobileSuggestion.implementation;
    }
    return `**Mobile**: ${mobileSuggestion.implementation}\n\n**Desktop**: ${desktopSuggestion.implementation}`;
  }

  generateCategorySummary() {
    const summary = {};
    Object.keys(this.mergedSuggestions).forEach(category => {
      const suggestions = this.mergedSuggestions[category];
      const byPriority = { High: 0, Medium: 0, Low: 0 };
      const byDevice = { mobile_only: 0, desktop_only: 0, both_devices: 0 };
      
      suggestions.forEach(s => {
        byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
        if (s.mobile_only) byDevice.mobile_only++;
        else if (s.desktop_only) byDevice.desktop_only++;
        else if (s.both_devices) byDevice.both_devices++;
      });
      
      summary[category] = { total: suggestions.length, byPriority, byDevice };
    });
    return summary;
  }

  getStatus() {
    return {
      success: true,
      totalSuggestions: Object.values(this.mergedSuggestions).reduce((sum, arr) => sum + arr.length, 0),
      currentUrl: this.currentUrl,
      categoryStatus: this.getCategoryStatus(),
    };
  }

  getCategoryStatus(category = null) {
    if (category) {
      if (!this.mergedSuggestions[category]) {
        throw new Error(`Invalid category: ${category}.`);
      }
      const suggestions = this.mergedSuggestions[category];
      return {
        success: true,
        category,
        status: this.categoryApprovalStatus[category],
        suggestionsCount: suggestions.length,
        suggestions: suggestions.map((s, i) => ({ index: i + 1, title: s.title, priority: s.priority, devices: s.devices })),
      };
    }
    const allCategoryStatus = {};
    Object.keys(this.mergedSuggestions).forEach(cat => {
      allCategoryStatus[cat] = {
        status: this.categoryApprovalStatus[cat],
        suggestionsCount: this.mergedSuggestions[cat].length,
      };
    });
    return { success: true, categories: allCategoryStatus };
  }

  createCategoryEditor(category) {
    if (!this.mergedSuggestions[category]) {
      throw new Error(`Invalid category: ${category}.`);
    }
    const suggestions = this.mergedSuggestions[category];
    if (suggestions.length === 0) {
      return { success: false, error: `No suggestions for category: ${category}` };
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `category-${category.toLowerCase()}-${timestamp}.md`;
    const filePath = path.join(this.tempDir, filename);
    const markdown = this.generateCategoryMarkdown(category, suggestions);
    fs.writeFileSync(filePath, markdown);
    return { success: true, filePath, filename, category, suggestionsCount: suggestions.length };
  }
  
  generateCategoryMarkdown(category, suggestions) {
    const categoryNames = { LCP: 'Largest Contentful Paint', CLS: 'Cumulative Layout Shift', INP: 'Interaction to Next Paint', TTFB: 'Time to First Byte' };
    let markdown = `# ${categoryNames[category]} (${category}) Suggestions\n\n`;
    markdown += `<!-- CATEGORY: ${category} -->\n\n`;
    suggestions.forEach((suggestion, index) => {
      markdown += this.formatSuggestionAsMarkdown(suggestion, index);
      markdown += '\n\n---\n\n';
    });
    markdown += `## Category Review & Approval\n\n**STATUS: PENDING**\n<!-- Choose one: **STATUS: APPROVED** or **STATUS: REJECTED** -->`;
    return markdown;
  }

  formatSuggestionAsMarkdown(suggestion, index) {
    let markdown = `## Suggestion ${index + 1}: ${suggestion.title}\n\n`;
    markdown += `**Priority**: ${suggestion.priority || 'Not specified'}\n`;
    markdown += `**Effort**: ${suggestion.effort || 'Not specified'}\n`;
    markdown += `**Devices**: ${suggestion.devices.join(', ')}\n\n`;
    markdown += `### Description\n${suggestion.description}\n\n`;
    markdown += `### Implementation Details\n${suggestion.implementation || 'No implementation details provided.'}\n`;
    if (suggestion.codeExample) {
        markdown += `### Code Example\n\`\`\`javascript\n${suggestion.codeExample}\n\`\`\`\n`;
    }
    return markdown;
  }

  readCategoryEdits(filePath) {
    const normalizedFilePath = normalizePath(filePath);
    if (!fs.existsSync(normalizedFilePath)) {
      throw new Error(`Edited file not found: ${normalizedFilePath}`);
    }
    const content = fs.readFileSync(normalizedFilePath, 'utf8');
    const result = this.parseCategoryMarkdown(content);

    const category = this.getCategoryFromFilename(filePath) || result.category;

    if (!category) {
      throw new Error('Could not determine category from file path or content.');
    }

    if (result.status) {
      this.categoryApprovalStatus[category] = result.status;
    }

    // Update suggestions if they were part of the markdown
    if (result.suggestions) {
      this.mergedSuggestions[category] = result.suggestions;
    }
    
    return { success: true, category, ...result };
  }

  parseCategoryMarkdown(content) {
    const lines = content.split('\n');
    
    // Extract category from comment header like: <!-- CATEGORY: LCP -->
    const categoryMatch = content.match(/<!-- CATEGORY: (\w+)/);
    const category = categoryMatch ? categoryMatch[1] : null;
    
    // Extract status from the approval section like: **STATUS: APPROVED**
    const statusMatch = content.match(/\*\*STATUS:\s*(\w+)\*\*/);
    const status = statusMatch ? statusMatch[1].toLowerCase() : null;
    
    // Parse individual suggestions
    const suggestions = [];
    
    // Split content by suggestion headers (## Suggestion N:)
    const suggestionSections = content.split(/^## Suggestion \d+:/gm);
    
    for (let i = 1; i < suggestionSections.length; i++) {
      const section = suggestionSections[i];
      
      // Extract title (everything up to the first newline)
      const titleMatch = section.match(/^([^\n]+)/);
      const title = titleMatch ? titleMatch[1].trim() : `Suggestion ${i}`;
      
      // Extract fields using regex patterns
      const priorityMatch = section.match(/\*\*Priority\*\*:\s*([^\n]+)/);
      const effortMatch = section.match(/\*\*Effort\*\*:\s*([^\n]+)/);
      const devicesMatch = section.match(/\*\*Devices\*\*:\s*([^\n]+)/);
      
      // Extract description (content between ### Description and ### Implementation Details)
      const descriptionMatch = section.match(/### Description\s*\n([\s\S]*?)(?=### Implementation Details|### Code Example|$)/);
      const description = descriptionMatch ? descriptionMatch[1].trim() : '';
      
      // Extract implementation details
      const implementationMatch = section.match(/### Implementation Details\s*\n([\s\S]*?)(?=### Code Example|$)/);
      const implementation = implementationMatch ? implementationMatch[1].trim() : '';
      
      // Extract code example (content between ```javascript and ```)
      const codeMatch = section.match(/### Code Example\s*\n```(?:javascript)?\s*\n([\s\S]*?)\n```/);
      const codeExample = codeMatch ? codeMatch[1].trim() : null;
      
      // Parse devices
      const devices = devicesMatch ? devicesMatch[1].split(',').map(d => d.trim()) : [];
      
      // Determine metric from category
      const metric = category || 'LCP';
      
      // Create suggestion object
      const suggestion = {
        id: i,
        title,
        description,
        metric,
        priority: priorityMatch ? priorityMatch[1].trim() : 'Not specified',
        effort: effortMatch ? effortMatch[1].trim() : 'Not specified',
        implementation,
        codeExample,
        devices,
        category: metric.toLowerCase(),
        mobile_only: devices.length === 1 && devices[0] === 'mobile',
        desktop_only: devices.length === 1 && devices[0] === 'desktop',
        both_devices: devices.includes('mobile') && devices.includes('desktop')
      };
      
      suggestions.push(suggestion);
    }
    
    const result = {};
    if (category) result.category = category;
    if (status) result.status = status;
    if (suggestions.length > 0) result.suggestions = suggestions;
    
    return result;
  }
  
  getCategoryFromFilename(filePath) {
    const filename = path.basename(filePath);
    // e.g. category-lcp-2024-07-25T18-30-00Z.md
    const categoryMatch = filename.match(/category-([a-z]+)-/);
    if (categoryMatch && categoryMatch[1]) {
      return categoryMatch[1].toUpperCase();
    }
    return null;
  }

  cleanupTempFiles(fileType = 'all') {
    if (!fs.existsSync(this.tempDir)) {
      return { success: true, message: 'Temp directory does not exist, nothing to clean.' };
    }
    const files = fs.readdirSync(this.tempDir);
    const deletedFiles = [];
    files.forEach(file => {
      if (fileType === 'all' || (file.startsWith('category-') && file.endsWith('.md'))) {
        fs.unlinkSync(path.join(this.tempDir, file));
        deletedFiles.push(file);
      }
    });
    return { success: true, deletedFiles };
  }

  async checkExistingSuggestionsForUrl() {
    if (!this.currentUrl) throw new Error('No URL loaded.');
    const site = await this.spaceCatClient.getSiteByBaseUrl(this.currentUrl);
    if (!site) return { success: true, exists: false, message: 'Site not found.' };
    const opportunity = await this.spaceCatClient.ensureCWVOpportunity(site.id);
    const existing = await this.spaceCatClient.checkExistingSuggestions(site.id, opportunity.id);
    return { success: true, site, opportunityId: opportunity.id, ...existing };
  }

  isReadyForBatchUpload() {
    return Object.values(this.categoryApprovalStatus).some(status => status === 'approved');
  }
  
  async getUploadPayload(existingSuggestion = null, existingMetrics = null) {
    // Group approved suggestions by metric type
    const groupedByMetric = {};
    
    Object.entries(this.mergedSuggestions)
      .filter(([category]) => this.categoryApprovalStatus[category] === 'approved')
      .forEach(([, suggestions]) => {
        suggestions.forEach((s, i) => {
          const metricType = s.metric.toLowerCase();
          if (!groupedByMetric[metricType]) {
            groupedByMetric[metricType] = [];
          }
          groupedByMetric[metricType].push(this.formatSuggestionAsMarkdown(s, i));
        });
      });
    
    // Create one issue per metric type with concatenated content
    const issues = Object.entries(groupedByMetric).map(([metricType, markdownArray]) => ({
      type: metricType,
      value: markdownArray.join('\n\n---\n\n'), // Clean separator between suggestions
    }));

    if (issues.length === 0) {
      return null;
    }

    // If updating an existing suggestion, completely replace the data with new issues
    if (existingSuggestion) {
      existingSuggestion.data.issues = issues; // Replace issues
      existingSuggestion.updatedAt = new Date().toISOString();
      return existingSuggestion;
    }

    // Determine metrics to use - prefer existing metrics, fallback to zeros
    const defaultMetrics = [
      { deviceType: 'mobile', pageviews: 0, clsCount: 0, ttfbCount: 0, lcp: 0, inpCount: 0, inp: 0, ttfb: 0, cls: 0, lcpCount: 0 },
      { deviceType: 'desktop', pageviews: 0, clsCount: 0, ttfbCount: 0, lcp: 0, inpCount: 0, inp: 0, ttfb: 0, cls: 0, lcpCount: 0 }
    ];
    
    const metricsToUse = existingMetrics || defaultMetrics;

    // If creating a new suggestion
    return {
      id: randomUUID(),
      type: 'CODE_CHANGE',
      status: 'NEW',
      rank: 0,
      data: {
        url: this.currentUrl,
        metrics: metricsToUse,
        type: 'url',
        issues,
      },
    };
  }

  async batchUploadToSpaceCat(dryRun = false) {
    try {
      if (!this.isReadyForBatchUpload()) {
        return { success: false, error: 'No approved suggestions to upload.' };
      }
  
      const existing = await this.checkExistingSuggestionsForUrl();
      if (!existing.success) {
        return existing; // Propagate error
      }
  
      const { site, opportunityId, suggestions = [] } = existing;
      
      // Extract existing metrics from suggestions for the current URL (normalized comparison)
      const normalizedCurrentUrl = this.normalizeUrlForComparison(this.currentUrl);
      const existingSuggestionsForUrl = suggestions.filter(s => 
        this.normalizeUrlForComparison(s.data.url) === normalizedCurrentUrl
      );
      const existingMetrics = existingSuggestionsForUrl.length > 0 
        ? existingSuggestionsForUrl[0].data.metrics  // Use metrics from the first matching suggestion
        : null;

      if (existingMetrics) {
        console.log(`  📊 Preserving existing metrics from ${existingSuggestionsForUrl.length} suggestion(s)`);
      } else {
        console.log(`  📊 No existing metrics found, using default zeros`);
      }

      // Create the new suggestion payload (always treat as new for bulk replacement)
      const newSuggestionPayload = await this.getUploadPayload(null, existingMetrics);
      
      if (!newSuggestionPayload) {
        return { success: false, error: 'No approved suggestions to build payload.' };
      }
  
      if (dryRun) {
        const action = existingSuggestionsForUrl.length > 0 ? 'DELETE_AND_CREATE' : 'CREATE';
        return { 
          success: true, 
          dryRun: true, 
          action, 
          message: `Dry run: Will ${action} suggestions for URL ${this.currentUrl}`,
          existingCount: existingForUrl.length,
          willDelete: existingForUrl.length,
          willCreate: 1,
          payload: newSuggestionPayload 
        };
      }
  
      // TRUE REPLACEMENT APPROACH:
      
      console.log(`True replacement for ${this.currentUrl}:`);
      console.log(`  Deleting ${existingSuggestionsForUrl.length} existing suggestions for this URL`);
      
      // Delete each existing suggestion for this URL
      const deletePromises = existingSuggestionsForUrl.map(s => 
        this.spaceCatClient.deleteSuggestion(site.id, opportunityId, s.id)
      );
      
      if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
        console.log(`  ✅ Deleted ${deletePromises.length} existing suggestions`);
      }
      
      // 2. Add our new suggestion
      console.log(`  Adding 1 new suggestion for this URL`);
      const result = await this.spaceCatClient.updateSuggestions(site.id, opportunityId, [newSuggestionPayload]);
      
      return { 
        success: true, 
        action: 'DELETE_AND_CREATE',
        deletedSuggestions: existingSuggestionsForUrl.length,
        createdSuggestions: 1,
        ...result 
      };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getSuggestionsByUrlAndType(url, opportunityType = 'cwv') {
    const site = await this.spaceCatClient.getSiteByBaseUrl(url);
    if (!site) return { success: false, error: 'Site not found.' };

    const opportunity = await this.spaceCatClient.getOpportunity(site.id, opportunityType);
    if (!opportunity) return { success: false, error: `Could not find or create opportunity of type '${opportunityType}'.` };

    const existing = await this.spaceCatClient.checkExistingSuggestions(site.id, opportunity.id);
    const normalizedUrl = this.normalizeUrlForComparison(url);
    const filteredSuggestions = existing.filter(s => 
      this.normalizeUrlForComparison(s.data.url) === normalizedUrl
    );
    return { success: true, site, opportunity, suggestions: filteredSuggestions };
  }

  /**
   * Approves all suggestions in a category
   * @param {String} category - The category to approve (LCP, CLS, INP, or TTFB)
   * @return {Object} Result of the approval operation
   */
  approveCategory(category) {
    if (!this.mergedSuggestions[category]) {
      return { success: false, error: `Invalid category: ${category}` };
    }
    
    if (this.mergedSuggestions[category].length === 0) {
      return { success: false, error: `No suggestions found for category: ${category}` };
    }

    this.categoryApprovalStatus[category] = 'approved';
    
    return {
      success: true,
      category,
      status: 'approved',
      suggestionsCount: this.mergedSuggestions[category].length
    };
  }
}
