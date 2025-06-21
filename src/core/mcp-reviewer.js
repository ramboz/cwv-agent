#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

/**
 * SpaceCat API Client with Adobe IMS Authentication via mcp-remote-with-okta
 */
class SpaceCatClient {
  constructor() {
    this.baseUrl = 'https://spacecat.experiencecloud.live/api/v1';
    this.accessToken = null;
    this.tokenExpiry = null;
    this.authWrapper = null;
    this.authInProgress = false;
    this.authPromise = null;
  }

  /**
   * Initialize authentication using mcp-remote-with-okta (singleton pattern)
   */
  async initAuth() {
    if (this.authWrapper) return;
    
    try {
      // Import the CommonJS module
      const AdobeMCPWrapper = require('mcp-remote-with-okta');
      
      // Initialize with silent mode for programmatic use
      this.authWrapper = new AdobeMCPWrapper(null, { 
        silent: true, 
        isMCPMode: true 
      });
      
    } catch (error) {
      throw new Error(`Failed to initialize authentication: ${error.message}`);
    }
  }

  /**
   * Get a valid access token (with proper synchronization to avoid port conflicts)
   */
  async getAccessToken() {
    await this.initAuth();
    
    // If authentication is already in progress, wait for it
    if (this.authInProgress && this.authPromise) {
      return await this.authPromise;
    }
    
    // Check if we have a valid cached token
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }
    
    // Start authentication process
    this.authInProgress = true;
    this.authPromise = this._performAuthentication();
    
    try {
      const token = await this.authPromise;
      return token;
    } finally {
      this.authInProgress = false;
      this.authPromise = null;
    }
  }

  /**
   * Internal method to perform authentication
   */
  async _performAuthentication() {
    try {
      // Use the auth wrapper's getValidToken method
      const token = await this.authWrapper.getValidToken();
      this.accessToken = token;
      // Cache token for 50 minutes (tokens typically last 1 hour)
      this.tokenExpiry = Date.now() + (50 * 60 * 1000);
      return token;
    } catch (error) {
      // Clear any cached token on auth failure
      this.accessToken = null;
      this.tokenExpiry = null;
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Make authenticated API request to SpaceCat
   */
  async apiRequest(endpoint, options = {}) {
    const token = await this.getAccessToken();

    const url = `${this.baseUrl}${endpoint}`;
    
    const defaultOptions = {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const finalOptions = {
      ...defaultOptions,
      ...options,
      headers: { ...defaultOptions.headers, ...options.headers }
    };

    try {
      const response = await fetch(url, finalOptions);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SpaceCat API error: ${response.status} ${response.statusText} - ${errorText} [URL: ${url}]`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      } else {
        return await response.text();
      }
    } catch (error) {
      throw new Error(`SpaceCat API request failed: ${error.message} [URL: ${url}]`);
    }
  }

  /**
   * Normalize URL to SpaceCat format (remove www., trailing slash)
   */
  normalizeBaseUrl(url) {
    try {
      // Parse the URL to handle it properly
      const urlObj = new URL(url);
      
      // Remove www. from hostname
      let hostname = urlObj.hostname;
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      
      // Reconstruct URL without trailing slash
      return `${urlObj.protocol}//${hostname}`;
    } catch (error) {
      // If URL parsing fails, try basic string manipulation
      let normalized = url;
      
      // Remove trailing slash
      if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      
      // Remove www.
      normalized = normalized.replace('://www.', '://');
      
      return normalized;
    }
  }

  /**
   * Get site by base URL
   */
  async getSiteByBaseUrl(baseUrl) {
    try {
      const normalizedUrl = this.normalizeBaseUrl(baseUrl);
      
      // Use the correct SpaceCat API endpoint: /sites/by-base-url/{base64BaseUrl}
      // The base URL must be base64 encoded as per the API documentation
      const base64Url = Buffer.from(normalizedUrl).toString('base64');
      const endpoint = `/sites/by-base-url/${base64Url}`;
      
      try {
        // Ensure we're authenticated first
        await this.initAuth();
        const site = await this.apiRequest(endpoint);
        return site;
      } catch (error) {
        if (error.message.includes('404')) {
          throw new Error(`Site not found in SpaceCat for URL: ${normalizedUrl}. The site may need to be registered in SpaceCat first. [Endpoint: ${endpoint}] [Base64: ${base64Url}] [Auth: ${this.accessToken ? 'YES' : 'NO'}]`);
        }
        throw new Error(`API call failed for endpoint ${endpoint} [Auth: ${this.accessToken ? 'YES' : 'NO'}]: ${error.message}`);
      }
    } catch (error) {
      throw new Error(`Failed to get site: ${error.message}`);
    }
  }

  /**
   * Get site opportunities
   */
  async getSiteOpportunities(siteId) {
    try {
      return await this.apiRequest(`/sites/${siteId}/opportunities`);
    } catch (error) {
      throw new Error(`Failed to get opportunities: ${error.message}`);
    }
  }

  /**
   * Ensure CWV opportunity exists for the site
   */
  async ensureCWVOpportunity(siteId) {
    try {
      const opportunities = await this.getSiteOpportunities(siteId);
      
      // Look for existing CWV opportunity
      let cwvOpportunity = opportunities.find(opp => opp.type === 'cwv');
      
      if (!cwvOpportunity) {
        // Create CWV opportunity
        cwvOpportunity = await this.apiRequest(`/sites/${siteId}/opportunities`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'cwv',
            origin: 'cwv-agent',
            title: 'Core Web Vitals Optimization',
            description: 'Performance optimization suggestions for Core Web Vitals metrics'
          })
        });
      }
      
      return cwvOpportunity;
    } catch (error) {
      throw new Error(`Failed to ensure CWV opportunity: ${error.message}`);
    }
  }

  /**
   * Check existing suggestions for a site opportunity
   */
  async checkExistingSuggestions(siteId, opportunityId) {
    try {
      const suggestions = await this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions`);
      return {
        exists: suggestions.length > 0,
        count: suggestions.length,
        suggestions: suggestions
      };
    } catch (error) {
      throw new Error(`Failed to check existing suggestions: ${error.message}`);
    }
  }

  /**
   * Update existing suggestions (replace all)
   */
  async updateSuggestions(siteId, opportunityId, suggestions) {
    try {
      // Delete existing suggestions first
      const existing = await this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions`);
      
      for (const suggestion of existing) {
        await this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions/${suggestion.id}`, {
          method: 'DELETE'
        });
      }
      
      // Create new suggestions
      const results = [];
      for (const suggestion of suggestions) {
        const payload = {
          type: suggestion.metric.toLowerCase(),
          origin: 'cwv-agent',
          title: suggestion.title,
          description: suggestion.description,
          data: {
            priority: suggestion.priority,
            effort: suggestion.effort,
            impact: suggestion.impact,
            implementation: suggestion.implementation,
            codeExample: suggestion.codeExample,
            category: suggestion.category,
            devices: suggestion.devices || ['mobile'],
            mobile_only: suggestion.mobile_only || false,
            desktop_only: suggestion.desktop_only || false,
            both_devices: suggestion.both_devices || false
          }
        };

        const created = await this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        
        results.push(created);
      }
      
      return results;
    } catch (error) {
      throw new Error(`Failed to update suggestions: ${error.message}`);
    }
  }

  /**
   * Format suggestion content for SpaceCat
   */
  formatSuggestionContent(suggestion) {
    let content = `**Priority**: ${suggestion.priority}\n`;
    content += `**Effort**: ${suggestion.effort}\n`;
    content += `**Impact**: ${suggestion.impact}\n\n`;
    content += `**Description**:\n${suggestion.description}\n\n`;
    content += `**Implementation**:\n${suggestion.implementation}\n`;
    
    if (suggestion.codeExample) {
      content += `\n**Code Example**:\n\`\`\`\n${suggestion.codeExample}\n\`\`\`\n`;
    }
    
    return content;
  }

  /**
   * Create a single suggestion in SpaceCat
   */
  async createSuggestion(siteId, opportunityId, suggestion, url) {
    try {
      const payload = {
        type: suggestion.metric.toLowerCase(),
        origin: 'cwv-agent',
        title: suggestion.title,
        description: suggestion.description,
        data: {
          url: url,
          priority: suggestion.priority,
          effort: suggestion.effort,
          impact: suggestion.impact,
          implementation: suggestion.implementation,
          codeExample: suggestion.codeExample || '',
          category: suggestion.category || 'general',
          devices: suggestion.devices || ['mobile'],
          mobile_only: suggestion.mobile_only || false,
          desktop_only: suggestion.desktop_only || false,
          both_devices: suggestion.both_devices || false,
          metric: suggestion.metric,
          originalId: suggestion.id
        }
      };

      const result = await this.apiRequest(`/sites/${siteId}/opportunities/${opportunityId}/suggestions`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      return result;
    } catch (error) {
      throw new Error(`Failed to create suggestion: ${error.message}`);
    }
  }
}

/**
 * CWV Suggestion Manager - Core functionality
 */
class CWVSuggestionManager {
  constructor() {
    this.spaceCatClient = new SpaceCatClient();
    this.mergedSuggestions = {
      LCP: [],
      CLS: [],
      INP: [],
      TTFB: []
    };
    this.suggestions = []; // Legacy property for backward compatibility
    this.currentFiles = [];
    this.deviceTypes = [];
    this.currentUrl = null;
    this.categoryApprovalStatus = {
      LCP: 'pending',   // pending, approved, rejected
      CLS: 'pending',
      INP: 'pending', 
      TTFB: 'pending'
    };
    
    // Find project root more reliably - try multiple strategies
    let projectRoot;
    try {
      // Strategy 1: Use process.cwd() if it's not root
      const cwd = process.cwd();
      if (cwd !== '/' && cwd !== 'C:\\') {
        projectRoot = cwd;
      } else {
        // Strategy 2: Use __dirname and go up to find project root
        projectRoot = path.resolve(__dirname, '..', '..');
      }
    } catch (error) {
      // Strategy 3: Fallback to __dirname approach
      projectRoot = path.resolve(__dirname, '..', '..');
    }
    
    // Ensure cache directory exists first, then temp-edits
    const cacheDir = path.join(projectRoot, '.cache');
    this.tempDir = path.join(cacheDir, 'temp-edits');
    
    try {
      // Create cache directory if it doesn't exist
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      
      // Create temp-edits directory if it doesn't exist
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create temp directory:', error);
      console.error('Project root detected as:', projectRoot);
      console.error('Cache dir attempted:', cacheDir);
      
      // Fallback to a temp directory in a safe location
      this.tempDir = path.join(projectRoot, 'temp-edits');
      try {
        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }
      } catch (fallbackError) {
        console.error('Fallback temp directory creation failed:', fallbackError);
        // Last resort: use system temp directory
        this.tempDir = path.join(require('os').tmpdir(), 'cwv-temp-edits');
        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }
      }
    }
  }

  /**
   * Convert URL to cache file pattern
   */
  urlToFilePattern(url) {
    try {
      // Parse the URL
      const urlObj = new URL(url);
      
      // Convert hostname to file pattern (replace dots with dashes, remove www)
      let hostname = urlObj.hostname;
      if (hostname.startsWith('www.')) {
        hostname = hostname.substring(4);
      }
      
      // Replace dots with dashes
      const fileBase = hostname.replace(/\./g, '-');
      
      // Add path if present (convert slashes to dashes, remove leading slash)
      let pathPart = '';
      if (urlObj.pathname && urlObj.pathname !== '/') {
        pathPart = urlObj.pathname.replace(/^\//, '').replace(/\//g, '-');
        if (pathPart) {
          pathPart = '-' + pathPart;
        }
      }
      
      return `www-${fileBase}${pathPart}`;
    } catch (error) {
      throw new Error(`Invalid URL format: ${url}`);
    }
  }

  /**
   * Auto-discover and load suggestions by URL
   */
  loadSuggestionsByUrl(url, cacheDir = './.cache') {
    try {
      const filePattern = this.urlToFilePattern(url);
      
      // Resolve cache directory - try multiple possible paths
      let resolvedCacheDir;
      if (path.isAbsolute(cacheDir)) {
        resolvedCacheDir = cacheDir;
      } else {
        // Use same project root detection logic as constructor
        let projectRoot;
        try {
          const cwd = process.cwd();
          if (cwd !== '/' && cwd !== 'C:\\') {
            projectRoot = cwd;
          } else {
            projectRoot = path.resolve(__dirname, '..', '..');
          }
        } catch (error) {
          projectRoot = path.resolve(__dirname, '..', '..');
        }
        
        const possibleCachePaths = [
          path.resolve(projectRoot, cacheDir),
          path.resolve(__dirname, '..', '..', cacheDir),
          path.resolve(__dirname, cacheDir),
          path.resolve(projectRoot, '..', cacheDir)
        ];
        
        // Find the first existing cache directory
        resolvedCacheDir = possibleCachePaths.find(p => {
          try {
            return fs.existsSync(p);
          } catch {
            return false;
          }
        });
        
        if (!resolvedCacheDir) {
          throw new Error(`Cache directory not found. Tried: ${possibleCachePaths.join(', ')}`);
        }
      }
      
      // Look for mobile and desktop suggestion files
      const mobileFile = path.join(resolvedCacheDir, `${filePattern}.mobile.suggestions.gemini25pro.json`);
      const desktopFile = path.join(resolvedCacheDir, `${filePattern}.desktop.suggestions.gemini25pro.json`);
      
      // Check which files exist
      const mobileExists = fs.existsSync(mobileFile);
      const desktopExists = fs.existsSync(desktopFile);
      
      if (!mobileExists && !desktopExists) {
        // Try to find any matching files in the cache directory
        let files = [];
        try {
          files = fs.readdirSync(resolvedCacheDir);
        } catch (error) {
          throw new Error(`Cannot read cache directory: ${resolvedCacheDir} (${error.message})`);
        }
        const suggestionFiles = files.filter(f => 
          f.includes(filePattern) && 
          f.includes('.suggestions.gemini25pro.json')
        );
        
        throw new Error(
          `No suggestion files found for URL: ${url}\n` +
          `Expected pattern: ${filePattern}\n` +
          `Looked for:\n  - ${mobileFile}\n  - ${desktopFile}\n` +
          (suggestionFiles.length > 0 
            ? `Found related files: ${suggestionFiles.join(', ')}`
            : `No related suggestion files found in ${resolvedCacheDir}`)
        );
      }
      
      // Load using existing multi-device function
      let result;
      if (mobileExists) {
        // Mobile exists, load with optional desktop
        result = this.loadMultiDeviceSuggestions(mobileFile, desktopExists ? desktopFile : null);
      } else if (desktopExists) {
        // Only desktop exists, treat it as mobile for the function
        result = this.loadMultiDeviceSuggestions(desktopFile, null);
      } else {
        throw new Error('No suggestion files found');
      }
      
      if (!result.success) {
        throw new Error(result.error);
      }
      
      // Set current URL for other operations
      this.currentUrl = url;
      
      // Add discovery info to result
      result.discovery = {
        url: url,
        filePattern: filePattern,
        mobileFile: mobileExists ? `file://${mobileFile}` : null,
        desktopFile: desktopExists ? `file://${desktopFile}` : null,
        mobileFileAbsolute: mobileExists ? mobileFile : null,
        desktopFileAbsolute: desktopExists ? desktopFile : null,
        foundFiles: {
          mobile: mobileExists,
          desktop: desktopExists
        }
      };
      
      return result;
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        url: url
      };
    }
  }

  /**
   * Load suggestions from multiple device files and merge them (Enhanced with error handling)
   */
  loadMultiDeviceSuggestions(mobileFilePath, desktopFilePath = null) {
    try {
      // Input validation
      if (!mobileFilePath || typeof mobileFilePath !== 'string') {
        throw new Error('Mobile file path is required and must be a string');
      }

      if (desktopFilePath !== null && typeof desktopFilePath !== 'string') {
        throw new Error('Desktop file path must be a string or null');
      }

      const results = {
        success: true,
        loadedDevices: [],
        url: null,
        totalSuggestions: 0,
        mergedSuggestions: {
          LCP: [],
          CLS: [],
          INP: [],
          TTFB: []
        },
        summary: {},
        warnings: []
      };

      // Load mobile suggestions
      const mobileResult = this.loadSingleDeviceFile(mobileFilePath, 'mobile');
      if (!mobileResult.success) {
        throw new Error(`Failed to load mobile file: ${mobileResult.error}`);
      }
      results.loadedDevices.push('mobile');
      results.url = mobileResult.url;

      // Load desktop suggestions if provided
      let desktopResult = null;
      if (desktopFilePath) {
        desktopResult = this.loadSingleDeviceFile(desktopFilePath, 'desktop');
        if (!desktopResult.success) {
          throw new Error(`Failed to load desktop file: ${desktopResult.error}`);
        }
        results.loadedDevices.push('desktop');
        
        // Verify URLs match
        if (mobileResult.url !== desktopResult.url) {
          throw new Error(`URL mismatch: Mobile (${mobileResult.url}) vs Desktop (${desktopResult.url})`);
        }
      }

      // Merge suggestions by category
      this.mergeSuggestionsByCategory(mobileResult.suggestions, desktopResult?.suggestions);
      
      // Update instance state
      this.currentFiles = results.loadedDevices.map(device => ({
        device,
        filePath: device === 'mobile' ? mobileFilePath : desktopFilePath
      }));
      this.deviceTypes = results.loadedDevices;
      this.currentUrl = results.url;

      // Generate summary
      results.mergedSuggestions = this.mergedSuggestions;
      results.totalSuggestions = Object.values(this.mergedSuggestions).reduce((sum, arr) => sum + arr.length, 0);
      results.summary = this.generateCategorySummary();

      return results;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Load suggestions from a single device file (helper method)
   */
  loadSingleDeviceFile(filePath, expectedDevice) {
    try {
      const projectRoot = path.resolve(process.cwd());
      const possiblePaths = [];
      
      if (path.isAbsolute(filePath)) {
        possiblePaths.push(filePath);
      } else {
        possiblePaths.push(
          path.resolve(projectRoot, filePath),
          path.resolve(__dirname, filePath),
          path.resolve(projectRoot, '..', filePath),
        );
      }

      let fullPath = null;
      let content = null;

      for (const tryPath of possiblePaths) {
        try {
          if (fs.existsSync(tryPath)) {
            fullPath = tryPath;
            content = fs.readFileSync(tryPath, 'utf8');
            break;
          }
        } catch (err) {
          continue;
        }
      }

      if (!content) {
        const pathsStr = possiblePaths.map((p, i) => `  ${i + 1}. ${p} ${fs.existsSync(p) ? '✓' : '✗'}`).join('\n');
        throw new Error(`File not found. Tried:\n${pathsStr}`);
      }

      const data = JSON.parse(content);
      
      if (!data.suggestions || !Array.isArray(data.suggestions)) {
        throw new Error('Invalid suggestions file format');
      }

      return {
        success: true,
        url: data.url,
        deviceType: data.deviceType,
        suggestions: data.suggestions,
        filePath: fullPath
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Merge suggestions from mobile and desktop into categories
   */
  mergeSuggestionsByCategory(mobileSuggestions, desktopSuggestions = []) {
    // Reset merged suggestions
    this.mergedSuggestions = {
      LCP: [],
      CLS: [],
      INP: [],
      TTFB: []
    };

    // Create lookup maps for matching
    const mobileByTitle = new Map();
    const desktopByTitle = new Map();

    // Index mobile suggestions
    mobileSuggestions.forEach(suggestion => {
      const key = this.normalizeSuggestionTitle(suggestion.title);
      mobileByTitle.set(key, suggestion);
    });

    // Index desktop suggestions
    desktopSuggestions.forEach(suggestion => {
      const key = this.normalizeSuggestionTitle(suggestion.title);
      desktopByTitle.set(key, suggestion);
    });

    // Merge matching suggestions
    const processedTitles = new Set();
    
    // Process mobile suggestions first
    mobileSuggestions.forEach(mobileSuggestion => {
      const titleKey = this.normalizeSuggestionTitle(mobileSuggestion.title);
      const desktopMatch = desktopByTitle.get(titleKey);
      
      if (desktopMatch) {
        // Merge mobile and desktop suggestions
        const merged = this.mergeTwoSuggestions(mobileSuggestion, desktopMatch);
        this.addToMergedCategory(merged);
        processedTitles.add(titleKey);
      } else {
        // Mobile-only suggestion
        const mobileOnly = { ...mobileSuggestion, devices: ['mobile'], mobile_only: true, desktop_only: false, both_devices: false };
        this.addToMergedCategory(mobileOnly);
        processedTitles.add(titleKey);
      }
    });

    // Process remaining desktop-only suggestions
    desktopSuggestions.forEach(desktopSuggestion => {
      const titleKey = this.normalizeSuggestionTitle(desktopSuggestion.title);
      if (!processedTitles.has(titleKey)) {
        const desktopOnly = { ...desktopSuggestion, devices: ['desktop'], mobile_only: false, desktop_only: true, both_devices: false };
        this.addToMergedCategory(desktopOnly);
      }
    });
  }

  /**
   * Normalize suggestion title for matching
   */
  normalizeSuggestionTitle(title) {
    return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Merge two suggestions (mobile and desktop versions)
   */
  mergeTwoSuggestions(mobileSuggestion, desktopSuggestion) {
    const merged = { ...mobileSuggestion };
    
    // Use higher priority
    merged.priority = this.getHigherPriority(mobileSuggestion.priority, desktopSuggestion.priority);
    
    // Merge implementation details
    merged.implementation = this.mergeImplementationDetails(mobileSuggestion, desktopSuggestion);
    
    // Set device flags
    merged.devices = ['mobile', 'desktop'];
    merged.mobile_only = false;
    merged.desktop_only = false;
    merged.both_devices = true;
    
    return merged;
  }

  /**
   * Add suggestion to appropriate category
   */
  addToMergedCategory(suggestion) {
    const category = suggestion.metric;
    if (this.mergedSuggestions[category]) {
      this.mergedSuggestions[category].push(suggestion);
    }
  }

  /**
   * Get higher priority between two priorities
   */
  getHigherPriority(priority1, priority2) {
    const priorityOrder = { 'Low': 1, 'Medium': 2, 'High': 3 };
    const p1Value = priorityOrder[priority1] || 0;
    const p2Value = priorityOrder[priority2] || 0;
    return p1Value >= p2Value ? priority1 : priority2;
  }

  /**
   * Merge implementation details from mobile and desktop
   */
  mergeImplementationDetails(mobileSuggestion, desktopSuggestion) {
    if (mobileSuggestion.implementation === desktopSuggestion.implementation) {
      return mobileSuggestion.implementation;
    }
    
    return `**Mobile**: ${mobileSuggestion.implementation}\n\n**Desktop**: ${desktopSuggestion.implementation}`;
  }

  /**
   * Generate category summary
   */
  generateCategorySummary() {
    const summary = {};
    
    Object.keys(this.mergedSuggestions).forEach(category => {
      const suggestions = this.mergedSuggestions[category];
      const byPriority = { High: 0, Medium: 0, Low: 0 };
      const byDevice = { mobile_only: 0, desktop_only: 0, both_devices: 0 };
      
      suggestions.forEach(suggestion => {
        byPriority[suggestion.priority] = (byPriority[suggestion.priority] || 0) + 1;
        
        if (suggestion.mobile_only) byDevice.mobile_only++;
        else if (suggestion.desktop_only) byDevice.desktop_only++;
        else if (suggestion.both_devices) byDevice.both_devices++;
      });
      
      summary[category] = {
        total: suggestions.length,
        byPriority,
        byDevice
      };
    });
    
    return summary;
  }

  /**
   * Get current status
   */
  getStatus() {
    const totalSuggestions = Object.values(this.mergedSuggestions).reduce((sum, arr) => sum + arr.length, 0);
    
    return {
      success: true,
      totalSuggestions,
      editedSuggestions: 0,
      approvedSuggestions: 0,
      currentFile: null,
      tempFiles: 0,
      multiDevice: {
        enabled: this.deviceTypes.length > 0,
        loadedDevices: this.deviceTypes,
        currentFiles: this.currentFiles,
        url: this.currentUrl,
        totalMergedSuggestions: totalSuggestions,
        categoryStatus: this.getCategoryStatus(),
        approvalProgress: {
          approved: 0,
          rejected: 0,
          pending: Object.keys(this.mergedSuggestions).filter(cat => this.mergedSuggestions[cat].length > 0).length
        },
        readyForUpload: false
      }
    };
  }

  /**
   * Get category status
   */
  getCategoryStatus(category = null) {
    try {
      if (category) {
        // Return status for specific category
        if (!['LCP', 'CLS', 'INP', 'TTFB'].includes(category)) {
          throw new Error(`Invalid category: ${category}. Must be one of: LCP, CLS, INP, TTFB`);
        }
        
        const suggestions = this.mergedSuggestions[category] || [];
        return {
          success: true,
          category,
          status: this.categoryApprovalStatus[category],
          suggestionsCount: suggestions.length,
          suggestions: suggestions.map((s, index) => ({
            index: index + 1,
            title: s.title,
            priority: s.priority,
            devices: s.devices,
            mobile_only: s.mobile_only,
            desktop_only: s.desktop_only,
            both_devices: s.both_devices
          })),
          canEdit: suggestions.length > 0,
          canUpload: this.categoryApprovalStatus[category] === 'approved' && suggestions.length > 0
        };
      } else {
        // Return status for all categories
        const allCategoryStatus = {};
        Object.keys(this.mergedSuggestions).forEach(cat => {
          const suggestions = this.mergedSuggestions[cat] || [];
          allCategoryStatus[cat] = {
            status: this.categoryApprovalStatus[cat],
            suggestionsCount: suggestions.length,
            canEdit: suggestions.length > 0,
            canUpload: this.categoryApprovalStatus[cat] === 'approved' && suggestions.length > 0,
            deviceBreakdown: {
              mobile_only: suggestions.filter(s => s.mobile_only).length,
              desktop_only: suggestions.filter(s => s.desktop_only).length,
              both_devices: suggestions.filter(s => s.both_devices).length
            }
          };
        });
        
        return {
          success: true,
          categories: allCategoryStatus,
          overallStatus: {
            totalSuggestions: Object.values(this.mergedSuggestions).reduce((sum, arr) => sum + arr.length, 0),
            approvedCategories: Object.values(this.categoryApprovalStatus).filter(s => s === 'approved').length,
            rejectedCategories: Object.values(this.categoryApprovalStatus).filter(s => s === 'rejected').length,
            pendingCategories: Object.values(this.categoryApprovalStatus).filter(s => s === 'pending').length,
            readyForUpload: this.isReadyForBatchUpload(),
            loadedDevices: this.deviceTypes,
            currentUrl: this.currentUrl
          }
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create a temporary markdown file for editing an entire category of suggestions
   */
  createCategoryEditor(category) {
    try {
      if (!['LCP', 'CLS', 'INP', 'TTFB'].includes(category)) {
        throw new Error(`Invalid category: ${category}. Must be one of: LCP, CLS, INP, TTFB`);
      }
      
      const suggestions = this.mergedSuggestions[category] || [];
      if (suggestions.length === 0) {
        return {
          success: false,
          error: `No suggestions found for category: ${category}`
        };
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `category-${category.toLowerCase()}-${timestamp}.md`;
      const filePath = path.join(this.tempDir, filename);
      
      const markdown = this.generateCategoryMarkdown(category, suggestions);
      fs.writeFileSync(filePath, markdown);
      
      return {
        success: true,
        filePath,
        filename,
        category,
        suggestionsCount: suggestions.length,
        message: `Created category editor for ${category} with ${suggestions.length} suggestions. Edit the file and save when ready.`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate markdown content for editing a category of suggestions
   */
  generateCategoryMarkdown(category, suggestions) {
    const categoryNames = {
      LCP: 'Largest Contentful Paint',
      CLS: 'Cumulative Layout Shift', 
      INP: 'Interaction to Next Paint',
      TTFB: 'Time to First Byte'
    };

    let markdown = `# ${categoryNames[category]} (${category}) Suggestions

<!-- DO NOT MODIFY THIS HEADER -->
<!-- CATEGORY: ${category} -->
<!-- SUGGESTION_COUNT: ${suggestions.length} -->
<!-- TIMESTAMP: ${new Date().toISOString()} -->

## Category Overview
**Metric**: ${categoryNames[category]} (${category})  
**Total Suggestions**: ${suggestions.length}  
**Status**: pending

## Instructions
- Review all suggestions in this category
- Edit any suggestion as needed
- Approve or reject the entire category at the bottom
- Save the file when you're done

---

`;

    // Add each suggestion
    suggestions.forEach((suggestion, index) => {
      markdown += `## Suggestion ${index + 1}: ${suggestion.title}

### Device Compatibility
**Devices**: ${suggestion.devices.join(', ')}  
**Mobile Only**: ${suggestion.mobile_only ? 'Yes' : 'No'}  
**Desktop Only**: ${suggestion.desktop_only ? 'Yes' : 'No'}  
**Both Devices**: ${suggestion.both_devices ? 'Yes' : 'No'}

### Priority & Impact
**Priority**: ${suggestion.priority}`;

      if (suggestion.both_devices) {
        markdown += `  
**Mobile Priority**: ${suggestion.mobile_priority}  
**Desktop Priority**: ${suggestion.desktop_priority}  
**Mobile Impact**: ${suggestion.mobile_impact}  
**Desktop Impact**: ${suggestion.desktop_impact}`;
      } else {
        markdown += `  
**Impact**: ${suggestion.impact}`;
      }

      markdown += `  
**Effort**: ${suggestion.effort}

### Description
${suggestion.description}

### Implementation Details
${suggestion.implementation || 'No implementation details provided.'}

### Code Example
\`\`\`${suggestion.category || 'javascript'}
${suggestion.codeExample || 'No code example provided.'}
\`\`\`

### Notes
<!-- Add any additional notes or modifications for this suggestion here -->

---

`;
    });

    // Add category approval section
    markdown += `## Category Review & Approval

### Review Summary
<!-- Summarize your review of all suggestions in this category -->

### Changes Made
<!-- List any changes you made to the suggestions above -->

### Category Decision
<!-- Choose one of the following and remove the others -->
**STATUS: PENDING**
<!-- **STATUS: APPROVED** -->
<!-- **STATUS: REJECTED** -->

### Rejection Reason (if applicable)
<!-- If rejecting, provide reason here -->

### Additional Comments
<!-- Any additional comments for this category -->

---
**Category Editor Instructions:**
- Review all suggestions above
- Make any necessary edits directly in the suggestion sections
- Update the Category Decision section with your final decision
- Save the file when complete
`;

    return markdown;
  }

  /**
   * Read back the edited category from markdown file
   */
  readCategoryEdits(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const result = this.parseCategoryMarkdown(content);
      
      // Update the category approval status
      if (result.category && ['approved', 'rejected', 'pending'].includes(result.status)) {
        this.categoryApprovalStatus[result.category] = result.status;
      }
      
      return {
        success: true,
        category: result.category,
        status: result.status,
        suggestionsCount: result.suggestions.length,
        suggestions: result.suggestions,
        reviewSummary: result.reviewSummary,
        changesMade: result.changesMade,
        rejectionReason: result.rejectionReason,
        additionalComments: result.additionalComments,
        message: `Successfully parsed ${result.suggestions.length} suggestions from ${result.category} category. Status: ${result.status}`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Parse category markdown content
   */
  parseCategoryMarkdown(content) {
    // Extract metadata
    const categoryMatch = content.match(/<!-- CATEGORY: (\w+) -->/);
    const category = categoryMatch ? categoryMatch[1] : null;
    
    if (!category) {
      throw new Error('Could not find category metadata in markdown');
    }

    // Extract status
    let status = 'pending';
    if (content.includes('**STATUS: APPROVED**')) {
      status = 'approved';
    } else if (content.includes('**STATUS: REJECTED**')) {
      status = 'rejected';
    }

    // Extract review sections
    const reviewSummary = this.extractMarkdownSection(content, '### Review Summary', '### Changes Made') || '';
    const changesMade = this.extractMarkdownSection(content, '### Changes Made', '### Category Decision') || '';
    const rejectionReason = this.extractMarkdownSection(content, '### Rejection Reason (if applicable)', '### Additional Comments') || '';
    const additionalComments = this.extractMarkdownSection(content, '### Additional Comments', '---') || '';

    // Parse suggestions (simplified - would need more complex parsing for full functionality)
    const suggestions = this.mergedSuggestions[category] || [];

    return {
      category,
      status,
      suggestions,
      reviewSummary: reviewSummary.trim(),
      changesMade: changesMade.trim(),
      rejectionReason: rejectionReason.trim(),
      additionalComments: additionalComments.trim()
    };
  }

  /**
   * Extract markdown section between markers
   */
  extractMarkdownSection(content, startMarker, endMarker) {
    const startIndex = content.indexOf(startMarker);
    if (startIndex === -1) return null;
    
    const contentStart = startIndex + startMarker.length;
    const endIndex = content.indexOf(endMarker, contentStart);
    
    if (endIndex === -1) {
      return content.substring(contentStart).trim();
    }
    
    return content.substring(contentStart, endIndex).trim();
  }

  /**
   * Load CWV suggestions from a JSON file (legacy method for compatibility)
   */
  loadSuggestions(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (!data.suggestions || !Array.isArray(data.suggestions)) {
        throw new Error('Invalid file format: missing suggestions array');
      }

      this.suggestions = data.suggestions;
      this.currentFiles = [filePath];
      this.deviceTypes = ['mobile']; // Default for single file
      
      return {
        success: true,
        suggestionsCount: this.suggestions.length,
        filePath,
        message: `Loaded ${this.suggestions.length} suggestions from ${path.basename(filePath)}`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Clean up temporary markdown editing files
   */
  cleanupTempFiles(fileType = 'all') {
    try {
      if (!fs.existsSync(this.tempDir)) {
        return {
          success: true,
          deletedFiles: [],
          message: 'Temp directory does not exist - nothing to clean up'
        };
      }

      const files = fs.readdirSync(this.tempDir);
      const deletedFiles = [];

      files.forEach(file => {
        const filePath = path.join(this.tempDir, file);
        let shouldDelete = false;

        switch (fileType) {
          case 'all':
            shouldDelete = true;
            break;
          case 'category':
            shouldDelete = file.startsWith('category-') && file.endsWith('.md');
            break;
          case 'suggestion':
            shouldDelete = file.startsWith('suggestion-') && file.endsWith('.md');
            break;
          case 'markdown':
            shouldDelete = file.endsWith('.md');
            break;
        }

        if (shouldDelete) {
          try {
            fs.unlinkSync(filePath);
            deletedFiles.push(file);
          } catch (error) {
            // Continue with other files if one fails
          }
        }
      });

      return {
        success: true,
        deletedFiles,
        count: deletedFiles.length,
        message: `Cleaned up ${deletedFiles.length} temporary files`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if suggestions already exist for the current URL in SpaceCat
   */
  async checkExistingSuggestionsForUrl() {
    try {
      if (!this.currentUrl) {
        throw new Error('No URL loaded. Please load suggestions first.');
      }

      // Follow the correct API flow: URL -> Site -> Opportunity -> Suggestions
      const site = await this.spaceCatClient.getSiteByBaseUrl(this.currentUrl);
      if (!site) {
        throw new Error(`Site not found in SpaceCat for URL: ${this.currentUrl}`);
      }

      if (!site.id) {
        throw new Error(`Site found but has no ID. Site: ${JSON.stringify(site)}`);
      }

      const opportunity = await this.spaceCatClient.ensureCWVOpportunity(site.id);
      const existingCheck = await this.spaceCatClient.checkExistingSuggestions(site.id, opportunity.id);
      
      return {
        success: true,
        url: this.currentUrl,
        site: {
          id: site.id,
          baseURL: site.baseURL
        },
        opportunityId: opportunity.id,
        exists: existingCheck.exists,
        count: existingCheck.count,
        existingSuggestions: existingCheck.suggestions,
        willUpdate: existingCheck.exists,
        message: existingCheck.exists 
          ? `Found ${existingCheck.count} existing suggestions. Upload will UPDATE existing suggestions.`
          : 'No existing suggestions found. Upload will CREATE new suggestions.'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if ready for batch upload (all populated categories must be reviewed)
   */
  isReadyForBatchUpload() {
    const populatedCategories = Object.keys(this.mergedSuggestions).filter(
      category => this.mergedSuggestions[category].length > 0
    );
    
    if (populatedCategories.length === 0) {
      return false;
    }
    
    // All populated categories must be either approved or rejected (not pending)
    return populatedCategories.every(category => 
      this.categoryApprovalStatus[category] === 'approved' || 
      this.categoryApprovalStatus[category] === 'rejected'
    );
  }

  /**
   * Batch upload approved suggestions to SpaceCat
   */
  async batchUploadToSpaceCat(dryRun = false) {
    try {
      if (!this.isReadyForBatchUpload()) {
        throw new Error('Not all categories have been reviewed. Please complete category review before uploading.');
      }

      if (!this.currentUrl) {
        throw new Error('No URL found for current suggestions. Unable to identify target site.');
      }

      // Get only approved suggestions
      const approvedSuggestions = [];
      Object.keys(this.mergedSuggestions).forEach(category => {
        if (this.categoryApprovalStatus[category] === 'approved') {
          this.mergedSuggestions[category].forEach(suggestion => {
            approvedSuggestions.push({
              ...suggestion,
              url: this.currentUrl,
              category: category
            });
          });
        }
      });

      if (approvedSuggestions.length === 0) {
        return {
          success: true,
          message: 'No approved suggestions to upload. All categories were either rejected or empty.',
          approvedCount: 0,
          rejectedCount: Object.values(this.categoryApprovalStatus).filter(s => s === 'rejected').length,
          totalCategories: Object.keys(this.categoryApprovalStatus).length
        };
      }

      // Perform SpaceCat API operations
      const site = await this.spaceCatClient.getSiteByBaseUrl(this.currentUrl);
      if (!site) {
        throw new Error(`Site not found in SpaceCat for URL: ${this.currentUrl}`);
      }

      const opportunity = await this.spaceCatClient.ensureCWVOpportunity(site.id);

      // Check if suggestions already exist
      const existingCheck = await this.spaceCatClient.checkExistingSuggestions(site.id, opportunity.id);

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          site: {
            id: site.id,
            baseURL: site.baseURL
          },
          opportunityId: opportunity.id,
          approvedCount: approvedSuggestions.length,
          rejectedCount: Object.values(this.categoryApprovalStatus).filter(s => s === 'rejected').length,
          existingSuggestions: existingCheck.count,
          operation: existingCheck.exists ? 'UPDATE' : 'CREATE',
          categories: this.getBatchUploadSummary(),
          message: `[DRY RUN] Would ${existingCheck.exists ? 'update' : 'create'} ${approvedSuggestions.length} suggestions for ${site.baseURL}`
        };
      }

      // Perform actual upload/update
      let result;
      if (existingCheck.exists) {
        // Update existing suggestions
        result = await this.spaceCatClient.updateSuggestions(site.id, opportunity.id, approvedSuggestions);
      } else {
        // Create new suggestions (batch create)
        result = await this.spaceCatClient.updateSuggestions(site.id, opportunity.id, approvedSuggestions);
      }

      return {
        success: true,
        site: {
          id: site.id,
          baseURL: site.baseURL
        },
        opportunityId: opportunity.id,
        operation: existingCheck.exists ? 'UPDATE' : 'CREATE',
        approvedCount: approvedSuggestions.length,
        rejectedCount: Object.values(this.categoryApprovalStatus).filter(s => s === 'rejected').length,
        categories: this.getBatchUploadSummary(),
        spaceCatResult: result,
        message: `Successfully ${existingCheck.exists ? 'updated' : 'created'} ${approvedSuggestions.length} suggestions for ${site.baseURL}`
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get summary of batch upload by category
   */
  getBatchUploadSummary() {
    const summary = {};
    Object.keys(this.mergedSuggestions).forEach(category => {
      summary[category] = {
        status: this.categoryApprovalStatus[category],
        count: this.mergedSuggestions[category].length,
        willUpload: this.categoryApprovalStatus[category] === 'approved' && this.mergedSuggestions[category].length > 0
      };
    });
    return summary;
  }
}

/**
 * Start MCP reviewer action
 */
export async function startMCPReviewer() {
  // Note: No console output in MCP mode - it interferes with JSON-RPC protocol
  
  const server = new Server(
    {
      name: 'cwv-suggestion-reviewer',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  const manager = new CWVSuggestionManager();

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'load_cwv_suggestions',
          description: 'Load CWV suggestions from a JSON file',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Path to the suggestions JSON file'
              }
            },
            required: ['filePath']
          }
        },
        {
          name: 'load_multi_device_suggestions',
          description: 'Load and merge CWV suggestions from both mobile and desktop JSON files',
          inputSchema: {
            type: 'object',
            properties: {
              mobileFilePath: {
                type: 'string',
                description: 'Path to the mobile suggestions JSON file'
              },
              desktopFilePath: {
                type: 'string',
                description: 'Path to the desktop suggestions JSON file (optional)'
              }
            },
            required: ['mobileFilePath']
          }
        },
        {
          name: 'load_suggestions_by_url',
          description: 'Auto-discover and load CWV suggestions by URL (searches for mobile and desktop files automatically)',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'URL to load suggestions for (e.g., "https://www.qualcomm.com/")'
              },
              cacheDir: {
                type: 'string',
                description: 'Cache directory to search in (defaults to "./.cache")',
                default: './.cache'
              }
            },
            required: ['url']
          }
        },
        {
          name: 'create_category_editor',
          description: 'Create a temporary markdown file for editing an entire category of suggestions',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Category to edit (LCP, CLS, INP, or TTFB)',
                enum: ['LCP', 'CLS', 'INP', 'TTFB']
              }
            },
            required: ['category']
          }
        },
        {
          name: 'read_category_edits',
          description: 'Read back the edited category from markdown file',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Path to the edited category markdown file'
              }
            },
            required: ['filePath']
          }
        },
        {
          name: 'check_existing_suggestions',
          description: 'Check if suggestions already exist for the current URL in SpaceCat',
          inputSchema: {
            type: 'object',
            properties: {
              random_string: {
                type: 'string',
                description: 'Dummy parameter for no-parameter tools'
              }
            },
            required: ['random_string']
          }
        },
        {
          name: 'get_category_status',
          description: 'Get status information for a specific category or all categories',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Specific category to get status for (LCP, CLS, INP, TTFB). If not provided, returns all categories.',
                enum: ['LCP', 'CLS', 'INP', 'TTFB']
              }
            }
          }
        },
        {
          name: 'cleanup_temp_files',
          description: 'Remove temporary markdown editing files',
          inputSchema: {
            type: 'object',
            properties: {
              fileType: {
                type: 'string',
                description: 'Type of files to clean up: all, category, suggestion, markdown',
                enum: ['all', 'category', 'suggestion', 'markdown'],
                default: 'all'
              }
            }
          }
        },
        {
          name: 'batch_upload_to_spacecat',
          description: 'Batch upload all approved category suggestions to SpaceCat',
          inputSchema: {
            type: 'object',
            properties: {
              dryRun: {
                type: 'boolean',
                description: 'If true, simulate the upload without actually doing it',
                default: false
              }
            }
          }
        },
        {
          name: 'get_status',
          description: 'Get current status of suggestions and workflow',
          inputSchema: {
            type: 'object',
            properties: {
              random_string: {
                type: 'string',
                description: 'Dummy parameter for no-parameter tools'
              }
            },
            required: ['random_string']
          }
        }
      ]
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      let result;
      
      switch (name) {
        case 'load_cwv_suggestions':
          result = manager.loadSuggestions(args.filePath);
          break;
        case 'load_multi_device_suggestions':
          result = manager.loadMultiDeviceSuggestions(args.mobileFilePath, args.desktopFilePath);
          break;
        case 'load_suggestions_by_url':
          result = manager.loadSuggestionsByUrl(args.url, args.cacheDir || './.cache');
          break;
        case 'create_category_editor':
          result = manager.createCategoryEditor(args.category);
          break;
        case 'read_category_edits':
          result = manager.readCategoryEdits(args.filePath);
          break;
        case 'check_existing_suggestions':
          result = await manager.checkExistingSuggestionsForUrl();
          break;
        case 'get_category_status':
          result = manager.getCategoryStatus(args.category);
          break;
        case 'cleanup_temp_files':
          result = manager.cleanupTempFiles(args.fileType);
          break;
        case 'batch_upload_to_spacecat':
          result = await manager.batchUploadToSpaceCat(args.dryRun || false);
          break;
        case 'get_status':
          result = manager.getStatus();
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message
            }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Note: No console output in MCP mode - it interferes with JSON-RPC protocol
  // Explicitly keep the process alive
  process.stdin.resume();
} 