import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { SpaceCatClient } from './spacecat-client.js';
import { normalizePath } from '../utils.js';

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

  urlToFilePattern(url) {
    try {
      const urlObj = new URL(url);
      let hostname = urlObj.hostname.replace(/^www\./, '');
      const fileBase = hostname.replace(/\./g, '-');
      let pathPart = urlObj.pathname.replace(/^\//, '').replace(/\//g, '-');
      if (pathPart) {
        pathPart = '-' + pathPart;
      }
      return `www-${fileBase}${pathPart}`;
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
      throw new Error(`No suggestion files found for URL: ${url}`);
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
    const headerLine = lines[0] || '';

    // Extract category and status from a line like: <!-- CATEGORY: LCP (Status: pending) -->
    const headerMatch = headerLine.match(/<!-- CATEGORY: (\w+) \(Status: (\w+)\)/);
    const category = headerMatch ? headerMatch[1] : null;
    const status = headerMatch ? headerMatch[2] : null;

    // Basic parsing logic - for now, we just care about status.
    // A more robust implementation would parse the full suggestion details.
    
    const result = {};
    if (category) result.category = category;
    if (status) result.status = status;
    
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
    return { success: true, ...existing, site, opportunityId: opportunity.id };
  }

  isReadyForBatchUpload() {
    return Object.values(this.categoryApprovalStatus).some(status => status === 'approved');
  }
  
  async getUploadPayload(existingSuggestion = null) {
    const issues = Object.entries(this.mergedSuggestions)
      .filter(([category]) => this.categoryApprovalStatus[category] === 'approved')
      .flatMap(([, suggestions]) => suggestions.map((s, i) => ({
        type: s.metric.toLowerCase(),
        value: this.formatSuggestionAsMarkdown(s, i),
      })));
  
    if (issues.length === 0) {
      return null;
    }
  
    // If updating an existing suggestion, use its ID and merge issues
    if (existingSuggestion) {
      existingSuggestion.data.issues = issues; // Replace issues
      return existingSuggestion;
    }
  
    // If creating a new suggestion
    return {
      id: randomUUID(),
      type: 'CODE_CHANGE',
      status: 'NEW',
      rank: 0,
      data: {
        url: this.currentUrl,
        metrics: [
            { deviceType: 'mobile', pageviews: 0, clsCount: 0, ttfbCount: 0, lcp: 0, inpCount: 0, inp: 0, ttfb: 0, cls: 0, lcpCount: 0 },
            { deviceType: 'desktop', pageviews: 0, clsCount: 0, ttfbCount: 0, lcp: 0, inpCount: 0, inp: 0, ttfb: 0, cls: 0, lcpCount: 0 }
        ],
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
      const existingSuggestionForUrl = suggestions.find(s => s.data.url === this.currentUrl);
  
      const payload = await this.getUploadPayload(existingSuggestionForUrl);
  
      if (!payload) {
        return { success: false, error: 'No approved suggestions to build payload.' };
      }
  
      if (dryRun) {
        const action = existingSuggestionForUrl ? 'UPDATE' : 'CREATE';
        return { success: true, dryRun: true, action, message: `Dry run: Payload for ${action} is valid.`, payload };
      }
  
      let result;
      if (existingSuggestionForUrl) {
        // Update existing suggestion
        result = await this.spaceCatClient.updateSuggestion(payload);
      } else {
        // Create new suggestion
        result = await this.spaceCatClient.createSuggestion(site.id, opportunityId, payload);
      }
  
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
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
